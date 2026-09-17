import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AttachmentStore } from '../src/attachment-store.js';

const THREAD_ID = '0191f47a-0e6c-7d6a-b5cb-953c58db5f68';
const OTHER_THREAD_ID = '0191f47a-0e6c-7d6a-b5cb-953c58db5f69';
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0];
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const GIF_BYTES = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jarvis-attachments-'));
  try {
    await run(new AttachmentStore({ root }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function imageBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

test('stores a validated PNG beneath the owning thread', async () => {
  await withStore(async (store, root) => {
    const item = await store.save({
      threadId: THREAD_ID,
      name: 'screen.png',
      mime: 'image/png',
      base64: imageBase64(PNG_BYTES),
    });

    assert.equal(path.dirname(item.path), path.join(root, THREAD_ID));
    assert.match(path.basename(item.path), /^[0-9a-f-]+\.png$/i);
    assert.deepEqual(await readdir(path.join(root, THREAD_ID)), [path.basename(item.path)]);
    assert.deepEqual(await store.resolveForTurn(THREAD_ID, [item.id]), [{
      id: item.id,
      path: item.path,
      name: 'screen.png',
      mime: 'image/png',
      size: PNG_BYTES.length,
    }]);
  });
});

test('chooses extensions from detected image magic bytes', async () => {
  await withStore(async (store) => {
    const cases = [
      ['image/jpeg', JPEG_BYTES, '.jpg'],
      ['image/webp', WEBP_BYTES, '.webp'],
      ['image/gif', GIF_BYTES, '.gif'],
    ];

    for (const [mime, bytes, extension] of cases) {
      const item = await store.save({ threadId: THREAD_ID, name: `upload${extension}`, mime, base64: imageBase64(bytes) });
      assert.equal(path.extname(item.path), extension);
      assert.equal(item.mime, mime);
      assert.equal(item.size, bytes.length);
    }
  });
});

test('rejects spoofed MIME, malformed base64, oversized images, and unsupported formats before writing', async () => {
  await withStore(async (store, root) => {
    await assert.rejects(
      store.save({ threadId: THREAD_ID, name: 'spoof.png', mime: 'image/png', base64: imageBase64(JPEG_BYTES) }),
      /mime|format|magic/i,
    );
    await assert.rejects(
      store.save({ threadId: THREAD_ID, name: 'bad.png', mime: 'image/png', base64: 'not base64!' }),
      /base64/i,
    );
    await assert.rejects(
      store.save({ threadId: THREAD_ID, name: 'too-big.png', mime: 'image/png', base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }),
      /size|8 MiB/i,
    );
    await assert.rejects(
      store.save({ threadId: THREAD_ID, name: 'text.txt', mime: 'text/plain', base64: imageBase64(PNG_BYTES) }),
      /mime/i,
    );

    assert.deepEqual(await readdir(root), []);
  });
});

test('rejects caller-controlled paths and non-UUID thread or attachment ids', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      store.save({ threadId: '../escape', name: 'screen.png', mime: 'image/png', base64: imageBase64(PNG_BYTES) }),
      /uuid/i,
    );
    await assert.rejects(
      store.save({ threadId: path.resolve(os.tmpdir(), 'escape'), name: 'screen.png', mime: 'image/png', base64: imageBase64(PNG_BYTES) }),
      /uuid/i,
    );
    await assert.rejects(store.resolveForTurn(THREAD_ID, ['../escape']), /uuid/i);
    await assert.rejects(store.remove(THREAD_ID, path.resolve(os.tmpdir(), 'escape')), /uuid/i);
  });
});

test('resolveForTurn enforces ownership, known ids, and the four-image limit', async () => {
  await withStore(async (store) => {
    const owned = await store.save({ threadId: THREAD_ID, name: 'owned.png', mime: 'image/png', base64: imageBase64(PNG_BYTES) });
    const foreign = await store.save({ threadId: OTHER_THREAD_ID, name: 'foreign.png', mime: 'image/png', base64: imageBase64(PNG_BYTES) });
    const ids = [owned.id];
    for (let index = 0; index < 4; index += 1) {
      const item = await store.save({ threadId: THREAD_ID, name: `${index}.png`, mime: 'image/png', base64: imageBase64(PNG_BYTES) });
      ids.push(item.id);
    }

    await assert.rejects(store.resolveForTurn(THREAD_ID, [foreign.id]), /attachment|thread|unknown/i);
    await assert.rejects(store.resolveForTurn(THREAD_ID, ['0191f47a-0e6c-7d6a-b5cb-953c58db5f70']), /attachment|unknown/i);
    await assert.rejects(store.resolveForTurn(THREAD_ID, ids), /4|too many|limit/i);
  });
});

test('remove and removeThread delete only canonical targets under the configured root', async () => {
  await withStore(async (store, root) => {
    const item = await store.save({ threadId: THREAD_ID, name: 'screen.png', mime: 'image/png', base64: imageBase64(PNG_BYTES) });
    assert.equal((await stat(item.path)).isFile(), true);

    assert.deepEqual(await store.remove(THREAD_ID, item.id), { removed: true, id: item.id });
    await assert.rejects(stat(item.path), /ENOENT/);
    await assert.rejects(store.remove(THREAD_ID, item.id), /attachment|unknown/i);

    await store.save({ threadId: THREAD_ID, name: 'again.png', mime: 'image/png', base64: imageBase64(PNG_BYTES) });
    await mkdir(path.join(root, OTHER_THREAD_ID), { recursive: true });
    await assert.rejects(store.removeThread('../escape'), /uuid/i);
    assert.deepEqual(await store.removeThread(THREAD_ID), { removed: true, threadId: THREAD_ID });
    await assert.rejects(stat(path.join(root, THREAD_ID)), /ENOENT/);
    assert.equal((await stat(root)).isDirectory(), true);
    assert.equal((await stat(path.join(root, OTHER_THREAD_ID))).isDirectory(), true);
  });
});

test('remove throws for unknown or cross-thread attachment ids', async () => {
  await withStore(async (store) => {
    const item = await store.save({ threadId: THREAD_ID, name: 'screen.png', mime: 'image/png', base64: imageBase64(PNG_BYTES) });

    await assert.rejects(store.remove(THREAD_ID, '0191f47a-0e6c-7d6a-b5cb-953c58db5f70'), /attachment|unknown/i);
    await assert.rejects(store.remove(OTHER_THREAD_ID, item.id), /attachment|thread|unknown/i);
  });
});

test('save rejects a thread directory junction escape without writing outside root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jarvis-attachments-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'jarvis-outside-'));
  try {
    await symlink(outside, path.join(root, THREAD_ID), 'junction');
    const store = new AttachmentStore({ root });

    await assert.rejects(
      store.save({ threadId: THREAD_ID, name: 'screen.png', mime: 'image/png', base64: imageBase64(PNG_BYTES) }),
      /root|symlink|junction|reparse/i,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('remove rejects a thread directory junction escape without deleting outside files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jarvis-attachments-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'jarvis-outside-'));
  try {
    const store = new AttachmentStore({ root });
    const item = await store.save({ threadId: THREAD_ID, name: 'screen.png', mime: 'image/png', base64: imageBase64(PNG_BYTES) });
    const outsideFile = path.join(outside, path.basename(item.path));
    await writeFile(outsideFile, 'outside', 'utf8');
    await rm(path.join(root, THREAD_ID), { recursive: true, force: true });
    await symlink(outside, path.join(root, THREAD_ID), 'junction');

    await assert.rejects(store.remove(THREAD_ID, item.id), /root|symlink|junction|reparse/i);
    assert.equal(await stat(outsideFile).then((file) => file.isFile()), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
