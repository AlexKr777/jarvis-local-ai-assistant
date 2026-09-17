import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';

const SAFE_ERROR = 'Parser worker could not complete the request.';

function publicError(value) {
  const error = new Error(typeof value?.message === 'string' && value.message.length <= 240 ? value.message : SAFE_ERROR);
  error.code = typeof value?.code === 'string' ? value.code : 'PARSER_WORKER_ERROR';
  return error;
}

function defaultSpawnWorker({ projectRoot }) {
  const python = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const script = path.join(projectRoot, 'parser_worker', 'worker.py');
  return spawn(python, ['-u', script, '--data-dir', path.join(projectRoot, 'data', 'parser')], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
  });
}

export class ParserRuntime {
  constructor({
    projectRoot = process.cwd(),
    spawnWorker = defaultSpawnWorker,
    restartDelaysMs = [1_000, 5_000, 30_000],
    requestTimeoutMs = 30_000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    logger = console,
  } = {}) {
    this.projectRoot = projectRoot;
    this.spawnWorker = () => spawnWorker({ projectRoot });
    this.restartDelaysMs = [...restartDelaysMs];
    this.requestTimeoutMs = requestTimeoutMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.logger = logger;
    this.events = new EventEmitter();
    this.child = null;
    this.pending = new Map();
    this.buffer = '';
    this.nextId = 1;
    this.restartAttempt = 0;
    this.restartTimer = null;
    this.stopping = false;
    this.workerStarts = 0;
    this.lastStatus = { state: 'SETUP_REQUIRED', worker: 'STOPPED' };
  }

  subscribe(listener) {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  async initialize() {
    if (!this.child) this.#startWorker();
    const status = await this.call('status');
    this.lastStatus = status;
    this.restartAttempt = 0;
    return status;
  }

  async status() {
    if (!this.child) return { ...this.lastStatus };
    try {
      const status = await this.call('status');
      this.lastStatus = status;
      return status;
    } catch {
      return { ...this.lastStatus, state: 'DEGRADED', worker: 'UNAVAILABLE' };
    }
  }

  call(method, params = {}) {
    if (!this.child?.stdin) return Promise.reject(publicError({ code: 'WORKER_UNAVAILABLE', message: 'Parser worker is unavailable.' }));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timeout = this.setTimeoutImpl(() => {
        this.pending.delete(id);
        reject(publicError({ code: 'WORKER_TIMEOUT', message: 'Parser worker did not respond in time.' }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch {
        this.pending.delete(id);
        this.clearTimeoutImpl(timeout);
        reject(publicError({ code: 'WORKER_UNAVAILABLE', message: 'Parser worker is unavailable.' }));
      }
    });
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer !== null) this.clearTimeoutImpl(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (child) {
      try {
        await this.call('shutdown');
      } catch {}
      if (this.child === child) {
        this.child = null;
        try { child.kill(); } catch {}
      }
    }
    for (const { reject, timeout } of this.pending.values()) {
      this.clearTimeoutImpl(timeout);
      reject(publicError({ code: 'WORKER_STOPPED', message: 'Parser worker stopped.' }));
    }
    this.pending.clear();
  }

  #startWorker() {
    if (this.child || this.stopping) return;
    const child = this.spawnWorker();
    this.child = child;
    this.workerStarts += 1;
    this.buffer = '';
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => this.#consume(String(chunk)));
    child.stderr?.on('data', (chunk) => {
      const line = String(chunk).replace(/[\r\n]+/g, ' ').trim();
      if (line) this.logger?.error?.('JARVIS Parser worker reported an internal diagnostic. See data/parser/parser.log.');
    });
    child.once('error', () => this.#workerExited(null, 'spawn_error'));
    child.once('exit', (code, signal) => this.#workerExited(code, signal));
  }

  #consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.#message(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  #message(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.type === 'event' && message.event && typeof message.event === 'object') {
      const event = { ...message.event };
      if (event.type === 'parser_state' && event.state) this.lastStatus = { ...this.lastStatus, state: event.state };
      this.events.emit('event', event);
      return;
    }
    const pending = this.pending.get(String(message?.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    this.clearTimeoutImpl(pending.timeout);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(publicError(message.error));
  }

  #workerExited(code, signal) {
    const wasCurrent = Boolean(this.child);
    this.child = null;
    if (!wasCurrent) return;
    for (const { reject, timeout } of this.pending.values()) {
      this.clearTimeoutImpl(timeout);
      reject(publicError({ code: 'WORKER_EXITED', message: 'Parser worker stopped unexpectedly.' }));
    }
    this.pending.clear();
    if (this.stopping) return;
    this.lastStatus = { ...this.lastStatus, state: 'DEGRADED', worker: 'EXITED' };
    this.events.emit('event', { type: 'parser_state', state: 'DEGRADED', reason: 'worker_exit' });
    if (this.restartAttempt >= this.restartDelaysMs.length) return;
    const delay = this.restartDelaysMs[this.restartAttempt++];
    this.restartTimer = this.setTimeoutImpl(() => {
      this.restartTimer = null;
      this.#startWorker();
    }, delay);
  }
}

export function createParserRuntime(options = {}) {
  return new ParserRuntime(options);
}
