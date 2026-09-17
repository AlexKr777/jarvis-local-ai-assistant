import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NORMAL = 'NORMAL';
const COOLDOWN = 'COOLDOWN';
const BANNED = 'BANNED';
const RECOVERING = 'RECOVERING';

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function retryAfterMs(value, now) {
  const seconds = finite(String(value || '').trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(String(value || ''));
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function bannedUntilFromBody(body) {
  const match = String(body?.msg || body?.message || '').match(/banned\s+until\s+(\d{6,16})/i);
  const value = finite(match?.[1]);
  if (!Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function publicMeta(meta = {}) {
  return {
    caller: String(meta.caller || 'unknown').slice(0, 80),
    endpoint: String(meta.endpoint || 'unknown').split('?')[0].slice(0, 120),
  };
}

export class BinanceRestBlockedError extends Error {
  constructor(message, { state, blockedUntil } = {}) {
    super(message);
    this.name = 'BinanceRestBlockedError';
    this.code = 'BINANCE_REST_BLOCKED';
    this.state = state;
    this.blockedUntil = blockedUntil;
  }
}

export class BinanceRestQueueFullError extends Error {
  constructor() {
    super('Binance REST queue is full; stale enrichment was dropped.');
    this.name = 'BinanceRestQueueFullError';
    this.code = 'BINANCE_REST_QUEUE_FULL';
  }
}

export class BinanceRestStaleError extends Error {
  constructor() {
    super('Binance REST work became stale while waiting and was dropped.');
    this.name = 'BinanceRestStaleError';
    this.code = 'BINANCE_REST_STALE';
  }
}

/** One process-wide scheduler and persisted safety state for public Binance REST. */
export class BinanceRestGovernor {
  constructor({ filePath, clock = () => Date.now(), maxConcurrency = 1, minIntervalMs = 750, queueLimit = 24,
    maxQueueAgeMs = 30_000, cooldownFallbackMs = 60_000, banFallbackMs = 5 * 60_000,
    maxUsedWeight1m = 2_100, onDiagnostic = () => {} } = {}) {
    if (!filePath) throw new TypeError('Binance REST governor requires a persistence file path.');
    this.filePath = filePath;
    this.clock = clock;
    this.maxConcurrency = Math.max(1, Math.min(4, Number(maxConcurrency) || 1));
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.queueLimit = Math.max(1, Number(queueLimit) || 1);
    this.maxQueueAgeMs = Math.max(1_000, Number(maxQueueAgeMs) || 30_000);
    this.cooldownFallbackMs = Math.max(1_000, Number(cooldownFallbackMs) || 60_000);
    this.banFallbackMs = Math.max(1_000, Number(banFallbackMs) || 5 * 60_000);
    this.maxUsedWeight1m = Math.max(1, Number(maxUsedWeight1m) || 2_100);
    this.onDiagnostic = onDiagnostic;
    this.state = NORMAL;
    this.blockedUntil = null;
    this.lastHttpStatus = null;
    this.retryAfterSeconds = null;
    this.usedWeight1m = null;
    this.lastSuccessAt = null;
    this.lastErrorAt = null;
    this.lastDiagnostic = null;
    this.inFlight = 0;
    this.queue = [];
    this.droppedOrCoalesced = 0;
    this.lastStartedAt = -Infinity;
    this.drainTimer = null;
    this.initialization = null;
  }

  async initialize() {
    if (!this.initialization) this.initialization = this.#load();
    await this.initialization;
    return this.#snapshot();
  }

  async diagnostics() {
    await this.initialize();
    return this.#snapshot();
  }

  status() {
    return this.#snapshot();
  }

  #snapshot() {
    const now = this.clock();
    const activeBlock = this.#activeBlock(now);
    return {
      state: activeBlock ? this.state : (this.state === RECOVERING ? RECOVERING : NORMAL),
      blockedUntil: activeBlock ? this.blockedUntil : null,
      remainingMs: activeBlock ? Math.max(0, this.blockedUntil - now) : 0,
      lastHttpStatus: this.lastHttpStatus,
      retryAfterSeconds: this.retryAfterSeconds,
      usedWeight1m: this.usedWeight1m,
      queueDepth: this.queue.length,
      inFlight: this.inFlight,
      droppedOrCoalesced: this.droppedOrCoalesced,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastDiagnostic: this.lastDiagnostic,
    };
  }

  async execute(meta, operation) {
    if (typeof operation !== 'function') throw new TypeError('Binance REST governor requires an operation.');
    await this.initialize();
    const now = this.clock();
    if (this.#activeBlock(now)) throw new BinanceRestBlockedError('Binance REST is globally blocked.', { state: this.state, blockedUntil: this.blockedUntil });
    if (this.state === COOLDOWN || this.state === BANNED) {
      this.state = RECOVERING;
      await this.#persist();
      this.#emit('recovery_started', meta);
    }
    if (this.queue.length >= this.queueLimit) {
      this.droppedOrCoalesced += 1;
      this.#emit('queue_dropped', meta);
      throw new BinanceRestQueueFullError();
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ meta: publicMeta(meta), operation, resolve, reject, queuedAt: this.clock() });
      this.#drain();
    });
  }

  async observeResponse({ status, headers, body, meta } = {}) {
    await this.initialize();
    const now = this.clock();
    const safe = publicMeta(meta);
    const retryAfter = retryAfterMs(headers?.get?.('retry-after'), now);
    const weight = finite(headers?.get?.('x-mbx-used-weight-1m'));
    if (Number.isFinite(weight)) this.usedWeight1m = weight;
    this.lastHttpStatus = finite(status);
    if (Number.isFinite(retryAfter)) this.retryAfterSeconds = Math.ceil(retryAfter / 1_000);
    if (status === 429 || status === 418) {
      const bodyUntil = status === 418 ? bannedUntilFromBody(body) : null;
      const fallback = status === 418 ? this.banFallbackMs : this.cooldownFallbackMs;
      const suppliedDeadlines = [Number.isFinite(retryAfter) ? now + retryAfter : null, bodyUntil].filter(Number.isFinite);
      const candidates = suppliedDeadlines.length ? suppliedDeadlines : [now + fallback];
      const blockedUntil = Math.max(...candidates);
      this.state = status === 418 ? BANNED : COOLDOWN;
      this.blockedUntil = blockedUntil;
      this.lastErrorAt = now;
      this.lastDiagnostic = {
        at: now, ...safe, status, binanceCode: finite(body?.code), retryAfterSeconds: this.retryAfterSeconds,
        usedWeight1m: this.usedWeight1m, blockedUntil,
      };
      await this.#persist();
      this.#emit(status === 418 ? 'banned' : 'cooldown', safe);
      this.#rejectQueued();
      return;
    }
    if (status >= 200 && status < 300) {
      this.lastSuccessAt = now;
      // Binance includes the rolling one-minute weight on successful replies.
      // Stop before its hard ceiling instead of consuming one more request and
      // learning about the limit from a 429. The current successful response is
      // still returned; only queued and subsequent work is held back.
      if (Number.isFinite(weight) && weight >= this.maxUsedWeight1m) {
        this.state = COOLDOWN;
        this.blockedUntil = now + this.cooldownFallbackMs;
        this.lastErrorAt = now;
        this.lastDiagnostic = {
          at: now, ...safe, status, binanceCode: null, retryAfterSeconds: null,
          usedWeight1m: this.usedWeight1m, blockedUntil: this.blockedUntil,
        };
        await this.#persist();
        this.#emit('weight_budget_exhausted', safe);
        this.#rejectQueued();
        return;
      }
      if (this.state === RECOVERING) {
        this.state = NORMAL;
        this.blockedUntil = null;
        await this.#persist();
        this.#emit('recovery_succeeded', safe);
      }
      return;
    }
    this.lastErrorAt = now;
    if (this.state === RECOVERING) {
      this.state = NORMAL;
      await this.#persist();
    }
  }

  noteCoalesced(count = 1) {
    this.droppedOrCoalesced += Math.max(1, Number(count) || 1);
    this.#emit('work_coalesced', {});
  }

  #activeBlock(now) {
    return (this.state === COOLDOWN || this.state === BANNED) && Number(this.blockedUntil) > now;
  }

  #drain() {
    if (this.drainTimer || !this.queue.length || this.inFlight >= this.maxConcurrency) return;
    if (this.#activeBlock(this.clock())) return this.#rejectQueued();
    if (this.state === RECOVERING && this.inFlight > 0) return;
    while (this.queue.length && this.clock() - this.queue[0].queuedAt > this.maxQueueAgeMs) {
      const stale = this.queue.shift();
      this.droppedOrCoalesced += 1;
      stale.reject(new BinanceRestStaleError());
      this.#emit('queue_stale', stale.meta);
    }
    if (!this.queue.length) return;
    const delay = Math.max(0, this.lastStartedAt + this.minIntervalMs - this.clock());
    if (delay > 0) {
      this.drainTimer = setTimeout(() => { this.drainTimer = null; this.#drain(); }, delay);
      this.drainTimer.unref?.();
      return;
    }
    const next = this.queue.shift();
    this.inFlight += 1;
    this.lastStartedAt = this.clock();
    Promise.resolve()
      .then(next.operation)
      .then(next.resolve, next.reject)
      .finally(() => { this.inFlight -= 1; this.#drain(); });
    if (this.state !== RECOVERING) this.#drain();
  }

  #rejectQueued() {
    const error = new BinanceRestBlockedError('Binance REST is globally blocked.', { state: this.state, blockedUntil: this.blockedUntil });
    while (this.queue.length) this.queue.shift().reject(error);
  }

  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      const now = this.clock();
      if ([COOLDOWN, BANNED].includes(parsed?.state) && Number(parsed.blockedUntil) > now) {
        this.state = parsed.state;
        this.blockedUntil = Number(parsed.blockedUntil);
        this.lastHttpStatus = finite(parsed.lastHttpStatus);
        this.retryAfterSeconds = finite(parsed.retryAfterSeconds);
        this.usedWeight1m = finite(parsed.usedWeight1m);
        this.lastDiagnostic = parsed.lastDiagnostic || null;
        this.#emit('persisted_block_loaded', {});
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#emit('persistence_load_failed', {});
    }
  }

  async #persist() {
    const body = {
      state: this.state,
      blockedUntil: this.blockedUntil,
      lastHttpStatus: this.lastHttpStatus,
      retryAfterSeconds: this.retryAfterSeconds,
      usedWeight1m: this.usedWeight1m,
      lastDiagnostic: this.lastDiagnostic,
      updatedAt: this.clock(),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  #emit(type, meta) {
    try { this.onDiagnostic({ at: this.clock(), type, ...publicMeta(meta), ...this.lastDiagnostic }); } catch { /* diagnostics never affect safety */ }
  }
}
