import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TURN_ATTACHMENTS = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FORMATS = {
  'image/png': { extension: '.png', matches: isPng },
  'image/jpeg': { extension: '.jpg', matches: isJpeg },
  'image/webp': { extension: '.webp', matches: isWebp },
  'image/gif': { extension: '.gif', matches: isGif },
};

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
}

function decodeStrictBase64(base64) {
  if (typeof base64 !== 'string' || base64.length === 0 || !BASE64_PATTERN.test(base64)) {
    throw new Error('Attachment data must be strict base64.');
  }
  return Buffer.from(base64, 'base64');
}

function isPng(buffer) {
  return buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
}

function isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isWebp(buffer) {
  return buffer.length >= 12
    && buffer.subarray(0, 4).equals(Buffer.from('RIFF'))
    && buffer.subarray(8, 12).equals(Buffer.from('WEBP'));
}

function isGif(buffer) {
  if (buffer.length < 6) return false;
  const signature = buffer.subarray(0, 6).toString('ascii');
  return signature === 'GIF87a' || signature === 'GIF89a';
}

function detectFormat(buffer, declaredMime) {
  const format = FORMATS[declaredMime];
  if (!format) throw new Error('Unsupported attachment MIME type.');
  if (!format.matches(buffer)) {
    throw new Error('Attachment MIME does not match image magic bytes.');
  }
  return format;
}

function normalizeName(name) {
  return typeof name === 'string' && name.trim() ? name : 'attachment';
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  const withoutTrailingSeparator = resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
  return process.platform === 'win32' ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

function isSamePath(left, right) {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function isPathInsideRoot(target, root) {
  const normalizedTarget = normalizePathForCompare(target);
  const normalizedRoot = normalizePathForCompare(root);
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

export class AttachmentStore {
  constructor({ root } = {}) {
    if (typeof root !== 'string' || !root) throw new Error('Attachment root is required.');
    this.root = path.resolve(root);
    this.rootPrefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    this.attachments = new Map();
  }

  async save({ threadId, name, mime, base64 } = {}) {
    assertUuid(threadId, 'threadId');
    const buffer = decodeStrictBase64(base64);
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error('Attachment size exceeds 8 MiB.');
    }
    const format = detectFormat(buffer, mime);
    const id = randomUUID();
    const threadDirectory = this.#target(threadId);
    const filePath = this.#target(threadId, `${id}${format.extension}`);

    const rootRealPath = await this.#validatedRoot();
    await mkdir(threadDirectory, { recursive: true });
    await this.#validateExistingDirectory(threadDirectory, rootRealPath, 'Attachment thread directory');
    await writeFile(filePath, buffer, { flag: 'wx' });

    const attachment = {
      id,
      threadId,
      path: filePath,
      name: normalizeName(name),
      mime,
      size: buffer.length,
    };
    this.attachments.set(id, attachment);
    return this.#copy(attachment);
  }

  async resolveForTurn(threadId, ids) {
    assertUuid(threadId, 'threadId');
    if (!Array.isArray(ids)) throw new Error('Attachment ids must be an array.');
    if (ids.length > MAX_TURN_ATTACHMENTS) throw new Error('Cannot attach more than 4 images to a turn.');

    return ids.map((id) => {
      assertUuid(id, 'attachmentId');
      const attachment = this.attachments.get(id);
      if (!attachment || attachment.threadId !== threadId) {
        throw new Error('Attachment is unknown for this thread.');
      }
      return this.#turnCopy(attachment);
    });
  }

  async remove(threadId, attachmentId) {
    assertUuid(threadId, 'threadId');
    assertUuid(attachmentId, 'attachmentId');
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) throw new Error('Attachment is unknown.');
    if (attachment.threadId !== threadId) throw new Error('Attachment is unknown for this thread.');

    const rootRealPath = await this.#validatedRoot();
    await this.#validateExistingFile(attachment.path, rootRealPath);
    await rm(attachment.path, { force: true });
    this.attachments.delete(attachmentId);
    return { removed: true, id: attachmentId };
  }

  async removeThread(threadId) {
    assertUuid(threadId, 'threadId');
    const threadDirectory = this.#target(threadId);
    const rootRealPath = await this.#validatedRoot();
    await this.#validateOptionalDirectory(threadDirectory, rootRealPath, 'Attachment thread directory');
    for (const [id, attachment] of this.attachments) {
      if (attachment.threadId === threadId) this.attachments.delete(id);
    }
    await rm(threadDirectory, { recursive: true, force: true });
    return { removed: true, threadId };
  }

  #target(...segments) {
    const target = path.resolve(this.root, ...segments);
    this.#assertUnderRoot(target);
    return target;
  }

  #assertUnderRoot(target) {
    const resolvedTarget = path.resolve(target);
    if (!resolvedTarget.startsWith(this.rootPrefix)) {
      throw new Error('Attachment target must remain under the configured root.');
    }
  }

  async #validatedRoot() {
    await this.#validateNearestExistingAncestor(this.root);
    await mkdir(this.root, { recursive: true });
    const stats = await lstat(this.root);
    if (stats.isSymbolicLink()) {
      throw new Error('Attachment root must not be a symlink or junction.');
    }
    const rootRealPath = await realpath(this.root);
    if (!isSamePath(rootRealPath, this.root)) {
      throw new Error('Attachment root must not resolve outside its configured path.');
    }
    return rootRealPath;
  }

  async #validateNearestExistingAncestor(target) {
    let current = path.resolve(target);
    while (true) {
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) {
          throw new Error('Attachment root ancestor must not be a symlink or junction.');
        }
        const currentRealPath = await realpath(current);
        if (!isSamePath(currentRealPath, current)) {
          throw new Error('Attachment root ancestor must not resolve outside its configured path.');
        }
        return;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }

  async #validateOptionalDirectory(directory, rootRealPath, label) {
    try {
      await this.#validateExistingDirectory(directory, rootRealPath, label);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }

  async #validateExistingDirectory(directory, rootRealPath, label) {
    this.#assertUnderRoot(directory);
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink or junction.`);
    }
    const directoryRealPath = await realpath(directory);
    if (!isPathInsideRoot(directoryRealPath, rootRealPath)) {
      throw new Error(`${label} must remain under the configured root.`);
    }
    if (!isSamePath(directoryRealPath, directory)) {
      throw new Error(`${label} must not resolve outside its configured path.`);
    }
  }

  async #validateExistingFile(filePath, rootRealPath) {
    this.#assertUnderRoot(filePath);
    await this.#validateExistingDirectory(path.dirname(filePath), rootRealPath, 'Attachment thread directory');
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error('Attachment file must not be a symlink or junction.');
    }
    const fileRealPath = await realpath(filePath);
    if (!isPathInsideRoot(fileRealPath, rootRealPath)) {
      throw new Error('Attachment file must remain under the configured root.');
    }
    if (!isSamePath(fileRealPath, filePath)) {
      throw new Error('Attachment file must not resolve outside its configured path.');
    }
  }

  #copy(attachment) {
    return {
      id: attachment.id,
      path: attachment.path,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
    };
  }

  #turnCopy(attachment) {
    return this.#copy(attachment);
  }
}
