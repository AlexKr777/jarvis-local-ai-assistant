import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const AUDIO_FORMATS = new Map([
  ['audio/webm', '.webm'],
  ['audio/ogg', '.ogg'],
  ['audio/mp4', '.m4a'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/mpeg', '.mp3'],
]);

class TranscriptionPublicError extends Error {}
class WorkerFailure extends Error {
  constructor(message, { retryable = false, setup = false, timedOut = false } = {}) {
    super(message);
    this.retryable = retryable;
    this.setup = setup;
    this.timedOut = timedOut;
  }
}

function publicError(message) {
  return new TranscriptionPublicError(message);
}

function extensionForMime(mime) {
  if (typeof mime !== 'string') throw publicError('Unsupported audio MIME type.');
  const baseMime = mime.split(';', 1)[0].trim().toLowerCase();
  const extension = AUDIO_FORMATS.get(baseMime);
  if (!extension) throw publicError('Unsupported audio MIME type.');
  return extension;
}

function decodeAudio(base64) {
  if (
    typeof base64 !== 'string'
    || base64.length === 0
    || base64.length % 4 !== 0
    || !BASE64_PATTERN.test(base64)
  ) {
    throw publicError('Audio data must be strict base64.');
  }

  const paddingBytes = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedLength = (base64.length / 4) * 3 - paddingBytes;
  if (decodedLength > MAX_AUDIO_BYTES) throw publicError('Audio size exceeds 25 MiB.');

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.toString('base64') !== base64) throw publicError('Audio data must be strict base64.');
  return buffer;
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(target, root) {
  const normalizedTarget = normalizePathForCompare(target);
  const normalizedRoot = normalizePathForCompare(root);
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function parseWorkerResponse(line) {
  let result;
  try {
    result = JSON.parse(line);
  } catch {
    throw publicError('Local speech transcription failed.');
  }

  if (
    !result
    || typeof result !== 'object'
    || typeof result.text !== 'string'
    || !Number.isFinite(result.durationMs)
    || result.durationMs < 0
    || typeof result.language !== 'string'
  ) {
    throw publicError('Local speech transcription failed.');
  }
  const response = {
    text: result.text,
    durationMs: result.durationMs,
    language: result.language,
  };
  if (result.timings && typeof result.timings === 'object') {
    response.timings = {
      modelLoadMs: Number.isFinite(result.timings.modelLoadMs) ? result.timings.modelLoadMs : 0,
      asrMs: Number.isFinite(result.timings.asrMs) ? result.timings.asrMs : 0,
      warm: result.timings.warm === true,
      asrStartedAtUnixMs: Number.isFinite(result.timings.asrStartedAtUnixMs) ? result.timings.asrStartedAtUnixMs : null,
      transcriptReadyAtUnixMs: Number.isFinite(result.timings.transcriptReadyAtUnixMs) ? result.timings.transcriptReadyAtUnixMs : null,
    };
  }
  return response;
}

export class TranscriptionService {
  constructor({ projectRoot, spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof projectRoot !== 'string' || !projectRoot) throw new Error('projectRoot is required.');
    if (typeof spawnImpl !== 'function') throw new Error('spawnImpl must be a function.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive.');

    this.projectRoot = path.resolve(projectRoot);
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.audioRoot = path.join(this.projectRoot, 'data', 'audio');
    this.modelPath = path.join(this.projectRoot, 'data', 'models');
    this.pythonPath = path.join(this.projectRoot, '.venv', 'Scripts', 'python.exe');
    this.workerPath = path.join(this.projectRoot, 'speech', 'transcribe.py');
    this.worker = null;
    this.stopping = false;
  }

  async transcribe({ mime, base64 } = {}) {
    const extension = extensionForMime(mime);
    const audio = decodeAudio(base64);
    const audioPath = path.join(this.audioRoot, `${randomUUID()}${extension}`);
    let writeAttempted = false;

    try {
      await this.#prepareAudioRoot();
      writeAttempted = true;
      await writeFile(audioPath, audio, { flag: 'wx' });
      return await this.#runWorker(audioPath);
    } catch (error) {
      if (error instanceof TranscriptionPublicError) throw error;
      throw publicError('Local speech transcription failed.');
    } finally {
      if (writeAttempted) {
        try {
          await rm(audioPath, { force: true });
        } catch {
          throw publicError('Local speech transcription failed.');
        }
      }
    }
  }

  async stop() {
    this.stopping = true;
    const worker = this.worker;
    if (!worker || worker.closed) {
      this.worker = null;
      return;
    }
    await new Promise((resolve) => {
      worker.stopWaiters.push(resolve);
      try {
        worker.child.kill('SIGTERM');
      } catch {
        this.#closeWorker(worker, new WorkerFailure('Speech worker stopped.'));
      }
    });
    this.stopping = false;
  }

  async #prepareAudioRoot() {
    const projectStats = await lstat(this.projectRoot);
    if (!projectStats.isDirectory() || projectStats.isSymbolicLink()) {
      throw publicError('Local speech transcription failed.');
    }
    const projectRealPath = await realpath(this.projectRoot);
    if (normalizePathForCompare(projectRealPath) !== normalizePathForCompare(this.projectRoot)) {
      throw publicError('Local speech transcription failed.');
    }

    const dataRoot = path.join(this.projectRoot, 'data');
    const dataRealPath = await this.#ensureRealDirectory(dataRoot, projectRealPath);
    await this.#ensureRealDirectory(this.audioRoot, dataRealPath);
  }

  async #ensureRealDirectory(directory, parentRealPath) {
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(directory);
      stats = await lstat(directory);
    }

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw publicError('Local speech transcription failed.');
    }
    const directoryRealPath = await realpath(directory);
    if (
      normalizePathForCompare(directoryRealPath) !== normalizePathForCompare(directory)
      || !isPathInside(directoryRealPath, parentRealPath)
    ) {
      throw publicError('Local speech transcription failed.');
    }
    return directoryRealPath;
  }

  async #runWorker(audioPath) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.#requestWorker(audioPath);
      } catch (error) {
        if (error instanceof TranscriptionPublicError) throw error;
        if (error instanceof WorkerFailure && error.retryable && attempt === 0 && !this.stopping) continue;
        if (error instanceof WorkerFailure && error.setup) {
          throw publicError('Local speech transcription is not set up.');
        }
        if (error instanceof WorkerFailure && error.timedOut) {
          throw publicError('Local speech transcription timed out.');
        }
        throw publicError('Local speech transcription failed.');
      }
    }
    throw publicError('Local speech transcription failed.');
  }

  #requestWorker(audioPath) {
    const worker = this.#ensureWorker();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = { id, resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        if (!worker.pending.has(id)) return;
        worker.pending.delete(id);
        reject(new WorkerFailure('Speech worker timed out.', { timedOut: true }));
        this.#terminateWorker(worker, new WorkerFailure('Speech worker timed out.', { timedOut: true }), 'SIGKILL');
      }, this.timeoutMs);
      worker.pending.set(id, pending);
      const request = JSON.stringify({
        id,
        audioPath,
        modelPath: this.modelPath,
        model: process.env.JARVIS_ASR_MODEL || 'small',
        device: process.env.JARVIS_ASR_DEVICE || 'cpu',
        computeType: process.env.JARVIS_ASR_COMPUTE_TYPE || 'int8',
      });
      try {
        worker.child.stdin.write(`${request}\n`);
      } catch (error) {
        this.#settle(worker, id, 'reject', new WorkerFailure(String(error?.message || error), { retryable: true }));
        this.#terminateWorker(worker, new WorkerFailure('Speech worker input failed.', { retryable: true }), 'SIGKILL');
      }
    });
  }

  #ensureWorker() {
    if (this.worker && !this.worker.closed) return this.worker;
    let child;
    try {
      child = this.spawnImpl(
        this.pythonPath,
        [this.workerPath],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (error) {
      throw new WorkerFailure(String(error?.message || error), { setup: error?.code === 'ENOENT' });
    }

    const worker = {
      child,
      closed: false,
      decoder: new StringDecoder('utf8'),
      stdoutBuffer: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      pending: new Map(),
      legacyLines: [],
      failure: null,
      stopWaiters: [],
    };
    this.worker = worker;
    child.stdout.on('data', (chunk) => this.#readStdout(worker, chunk));
    child.stderr.on('data', (chunk) => {
      worker.stderrBytes += chunk.length;
      if (worker.stderrBytes > MAX_OUTPUT_BYTES) {
        this.#terminateWorker(worker, new WorkerFailure('Speech worker output exceeded the limit.', { retryable: true }), 'SIGKILL');
      }
    });
    child.stdin.on('error', (error) => {
      this.#terminateWorker(worker, new WorkerFailure(String(error?.message || error), { retryable: true }), 'SIGKILL');
    });
    child.on('error', (error) => {
      this.#closeWorker(worker, new WorkerFailure(String(error?.message || error), {
        retryable: error?.code !== 'ENOENT',
        setup: error?.code === 'ENOENT',
      }));
    });
    child.on('close', (code) => {
      const failure = worker.failure || (code === 0
        ? null
        : new WorkerFailure(`Speech worker exited with code ${code}.`, { retryable: true }));
      this.#closeWorker(worker, failure);
    });
    return worker;
  }

  #readStdout(worker, chunk) {
    if (worker.closed) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    worker.stdoutBytes += buffer.length;
    if (worker.stdoutBytes > MAX_OUTPUT_BYTES) {
      this.#terminateWorker(worker, new WorkerFailure('Speech worker output exceeded the limit.', { retryable: true }), 'SIGKILL');
      return;
    }
    worker.stdoutBuffer += worker.decoder.write(buffer);
    let newline = worker.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = worker.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      worker.stdoutBuffer = worker.stdoutBuffer.slice(newline + 1);
      worker.stdoutBytes = Buffer.byteLength(worker.stdoutBuffer, 'utf8');
      if (line) this.#handleWorkerLine(worker, line);
      if (worker.closed) return;
      newline = worker.stdoutBuffer.indexOf('\n');
    }
  }

  #handleWorkerLine(worker, line) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      this.#terminateWorker(worker, new WorkerFailure('Speech worker returned invalid JSON.', { retryable: true }), 'SIGKILL');
      return;
    }
    if (raw?.id === undefined || raw?.id === null) {
      worker.legacyLines.push(line);
      if (worker.legacyLines.length > 1) {
        this.#terminateWorker(worker, new WorkerFailure('Speech worker returned multiple legacy responses.'), 'SIGKILL');
      }
      return;
    }
    const id = String(raw.id);
    if (!worker.pending.has(id)) return;
    if (typeof raw.error === 'string') {
      this.#settle(worker, id, 'reject', new WorkerFailure('Speech worker rejected the request.'));
      return;
    }
    try {
      this.#settle(worker, id, 'resolve', parseWorkerResponse(line));
    } catch (error) {
      this.#settle(worker, id, 'reject', error);
    }
  }

  #settle(worker, id, action, value) {
    const pending = worker.pending.get(id);
    if (!pending) return;
    worker.pending.delete(id);
    clearTimeout(pending.timer);
    pending[action](value);
  }

  #terminateWorker(worker, failure, signal) {
    if (worker.closed) return;
    worker.failure = failure;
    try {
      worker.child.kill(signal);
    } catch {
      this.#closeWorker(worker, failure);
    }
  }

  #closeWorker(worker, failure) {
    if (worker.closed) return;
    worker.closed = true;
    if (this.worker === worker) this.worker = null;

    if (!failure && worker.legacyLines.length === 1 && worker.pending.size === 1) {
      const id = worker.pending.keys().next().value;
      try {
        this.#settle(worker, id, 'resolve', parseWorkerResponse(worker.legacyLines[0]));
      } catch (error) {
        this.#settle(worker, id, 'reject', error);
      }
    }
    const finalFailure = failure || new WorkerFailure('Speech worker closed before responding.', { retryable: true });
    for (const id of [...worker.pending.keys()]) this.#settle(worker, id, 'reject', finalFailure);
    for (const resolve of worker.stopWaiters) resolve();
  }
}
