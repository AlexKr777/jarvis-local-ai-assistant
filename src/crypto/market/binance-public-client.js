const SYMBOL_PATTERN = /^[A-Z0-9]{5,24}$/;
const ALLOWED_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']);

function requireSymbol(symbol) {
  if (!SYMBOL_PATTERN.test(symbol || '')) throw new TypeError('Invalid Binance symbol.');
  return symbol;
}

function requireLimit(limit, maximum) {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`Binance limit must be between 1 and ${maximum}.`);
  }
  return limit;
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function historicalRange({ startTime, endTime } = {}) {
  const parameters = {};
  for (const [key, value] of Object.entries({ startTime, endTime })) {
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`Binance ${key} must be a Unix timestamp in milliseconds.`);
    parameters[key] = value;
  }
  if (parameters.startTime && parameters.endTime && parameters.startTime > parameters.endTime) {
    throw new RangeError('Binance startTime must not be after endTime.');
  }
  return parameters;
}

export class BinancePublicError extends Error {
  constructor(message, { code, status, binanceCode = null } = {}) {
    super(message);
    this.name = 'BinancePublicError';
    this.code = code;
    if (Number.isFinite(status)) this.status = status;
    if (Number.isFinite(binanceCode)) this.binanceCode = binanceCode;
  }
}

export function normalizeKline(row) {
  if (!Array.isArray(row) || row.length < 8) throw new TypeError('Invalid Binance kline row.');
  return Object.freeze({
    openTime: finite(row[0]),
    open: finite(row[1]),
    high: finite(row[2]),
    low: finite(row[3]),
    close: finite(row[4]),
    volume: finite(row[5]),
    closeTime: finite(row[6]),
    quoteVolume: finite(row[7]),
    trades: finite(row[8]),
    takerBuyBaseVolume: finite(row[9]),
    takerBuyQuoteVolume: finite(row[10]),
  });
}

export class BinancePublicClient {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = 'https://fapi.binance.com', timeoutMs = 10_000, governor = null, caller = 'unknown' } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.governor = governor;
    this.caller = caller;
  }

  withCaller(caller) {
    return new BinancePublicClient({ fetchImpl: this.fetchImpl, baseUrl: this.baseUrl, timeoutMs: this.timeoutMs, governor: this.governor, caller });
  }

  async getExchangeInfo() {
    return this.#get('/fapi/v1/exchangeInfo');
  }

  async get24hTickers() {
    return this.#get('/fapi/v1/ticker/24hr');
  }

  async getServerTime() {
    return this.#get('/fapi/v1/time');
  }

  async getKlines(symbol, interval = '1m', limit = 120, range = undefined) {
    requireSymbol(symbol);
    if (!ALLOWED_INTERVALS.has(interval)) throw new TypeError('Invalid Binance kline interval.');
    requireLimit(limit, 1_500);
    const rows = await this.#get('/fapi/v1/klines', { symbol, interval, limit, ...historicalRange(range) });
    if (!Array.isArray(rows)) throw new Error('Binance public response was not an array.');
    return rows.map(normalizeKline);
  }

  async getOpenInterestHistory(symbol, period = '5m', limit = 24, range = undefined) {
    requireSymbol(symbol);
    if (!ALLOWED_INTERVALS.has(period)) throw new TypeError('Invalid Binance statistics period.');
    requireLimit(limit, 500);
    return this.#get('/futures/data/openInterestHist', { symbol, period, limit, ...historicalRange(range) });
  }

  async getTakerLongShortRatio(symbol, period = '5m', limit = 3, range = undefined) {
    requireSymbol(symbol);
    if (!ALLOWED_INTERVALS.has(period)) throw new TypeError('Invalid Binance statistics period.');
    requireLimit(limit, 500);
    return this.#get('/futures/data/takerlongshortRatio', { symbol, period, limit, ...historicalRange(range) });
  }

  async getPremiumIndex(symbol) {
    requireSymbol(symbol);
    return this.#get('/fapi/v1/premiumIndex', { symbol });
  }

  async getOrderBook(symbol, limit = 100) {
    requireSymbol(symbol);
    requireLimit(limit, 1_000);
    return this.#get('/fapi/v1/depth', { symbol, limit });
  }

  async #get(pathname, parameters = {}) {
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
    const request = async () => {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const timeout = error?.name === 'TimeoutError';
        throw new BinancePublicError(`Binance public request failed: ${timeout ? 'timeout' : 'network error'}.`, { code: timeout ? 'BINANCE_TIMEOUT' : 'BINANCE_NETWORK' });
      }
      let body;
      try { body = await response.json(); }
      catch { throw new BinancePublicError('Binance public response was not valid JSON.', { code: 'BINANCE_INVALID_JSON' }); }
      await this.governor?.observeResponse({ status: Number(response?.status), headers: response?.headers, body, meta: { caller: this.caller, endpoint: pathname } });
      if (!response?.ok) {
        const status = Number(response?.status);
        throw new BinancePublicError(`Binance public request failed (${response?.status || 'unknown'}).`, {
          code: status === 418 ? 'BINANCE_IP_BANNED' : status === 429 ? 'BINANCE_RATE_LIMITED' : 'BINANCE_HTTP_ERROR', status, binanceCode: Number(body?.code),
        });
      }
      return body;
    };
    return this.governor ? this.governor.execute({ caller: this.caller, endpoint: pathname }, request) : request();
  }
}
