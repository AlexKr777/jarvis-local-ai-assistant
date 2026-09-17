export function publicStreamUrls() {
  return Object.freeze({
    bookTicker: 'wss://fstream.binance.com/public/ws/!bookTicker',
    tickers: 'wss://fstream.binance.com/market/ws/!ticker@arr',
    liquidations: 'wss://fstream.binance.com/market/ws/!forceOrder@arr',
  });
}

function parseMessage(value) {
  if (value && typeof value === 'object') return value.data === undefined ? value : parseMessage(value.data);
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

export class BinanceStreamMonitor {
  constructor({ onMarketUpdate = () => {}, onStatus = () => {}, webSocketFactory = (url) => new WebSocket(url), reconnectBaseMs = 1_000,
    random = Math.random, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    this.onMarketUpdate = onMarketUpdate;
    this.onStatus = onStatus;
    this.webSocketFactory = webSocketFactory;
    this.reconnectBaseMs = reconnectBaseMs;
    this.random = random;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.sockets = new Map();
    this.retryCounts = new Map();
    this.stopped = true;
    this.reconnectTimers = new Set();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    for (const [kind, url] of Object.entries(publicStreamUrls())) this.#connect(kind, url);
  }

  stop() {
    this.stopped = true;
    for (const timer of this.reconnectTimers) this.clearTimeoutImpl(timer);
    this.reconnectTimers.clear();
    for (const socket of this.sockets.values()) socket?.close?.();
    this.sockets.clear();
  }

  ingestBookTicker(message) {
    const data = message?.data || message;
    const bid = Number(data?.b);
    const ask = Number(data?.a);
    if (data?.e !== 'bookTicker' || !data.s || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return;
    const midpoint = (bid + ask) / 2;
    this.onMarketUpdate({ type: 'book', symbol: data.s, bid, ask, spreadPct: ((ask - bid) / midpoint) * 100, occurredAt: Number(data.E || Date.now()) });
  }

  ingestTicker(message) {
    const data = message?.data || message;
    const entries = Array.isArray(data) ? data : [];
    for (const entry of entries) {
      const close = Number(entry?.c);
      const quoteVolumeUsd = Number(entry?.q);
      const priceChange24hPct = Number(entry?.P);
      if (entry?.e !== '24hrTicker' || Number(entry?.st) !== 1 || !entry.s || !Number.isFinite(close) || close <= 0 || !Number.isFinite(quoteVolumeUsd) || quoteVolumeUsd < 0) continue;
      this.onMarketUpdate({ type: 'ticker', symbol: entry.s, close, quoteVolumeUsd,
        ...(Number.isFinite(priceChange24hPct) ? { priceChange24hPct } : {}), occurredAt: Number(entry.E || Date.now()) });
    }
  }

  ingestLiquidation(message) {
    const data = message?.data || message;
    if (data?.e !== 'forceOrder' || Number(data.st) !== 1) return;
    const order = data.o;
    const price = Number(order?.ap || order?.p);
    const quantity = Number(order?.q);
    if (!order?.s || !Number.isFinite(price) || !Number.isFinite(quantity)) return;
    this.onMarketUpdate({ type: 'liquidation', symbol: order.s, side: order.S, notionalUsd: price * quantity, occurredAt: Number(order.T || data.E || Date.now()) });
  }

  #connect(kind, url) {
    if (this.stopped) return;
    let socket;
    try {
      socket = this.webSocketFactory(url);
    } catch {
      this.#scheduleReconnect(kind, url);
      return;
    }
    this.sockets.set(kind, socket);
    const listen = (name, callback) => {
      if (typeof socket.addEventListener === 'function') socket.addEventListener(name, callback);
      else if (typeof socket.on === 'function') socket.on(name, callback);
      else socket[`on${name}`] = callback;
    };
    listen('open', () => {
      this.retryCounts.set(kind, 0);
      this.onStatus({ kind, state: 'connected' });
    });
    listen('message', (event) => {
      const message = parseMessage(event);
      if (kind === 'bookTicker') this.ingestBookTicker(message);
      else if (kind === 'tickers') this.ingestTicker(message);
      else this.ingestLiquidation(message);
    });
    listen('close', () => {
      this.sockets.delete(kind);
      this.onStatus({ kind, state: 'disconnected' });
      this.#scheduleReconnect(kind, url);
    });
    listen('error', () => socket?.close?.());
  }

  #scheduleReconnect(kind, url) {
    if (this.stopped) return;
    const attempt = (this.retryCounts.get(kind) || 0) + 1;
    this.retryCounts.set(kind, attempt);
    const baseDelay = Math.min(30_000, this.reconnectBaseMs * (2 ** Math.min(attempt - 1, 5)));
    const delay = Math.max(250, Math.round(baseDelay * (0.8 + (this.random() * 0.4))));
    this.onStatus({ kind, state: 'reconnecting', attempt, retryInMs: delay });
    const timer = this.setTimeoutImpl(() => {
      this.reconnectTimers.delete(timer);
      this.#connect(kind, url);
    }, delay);
    timer.unref?.();
    this.reconnectTimers.add(timer);
  }
}
