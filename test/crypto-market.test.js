import test from 'node:test';
import assert from 'node:assert/strict';

import { BinancePublicClient, normalizeKline } from '../src/crypto/market/binance-public-client.js';
import { deriveWindowMetrics } from '../src/crypto/market/window-metrics.js';
import { BinanceStreamMonitor, publicStreamUrls } from '../src/crypto/market/stream-monitor.js';
import { MarketScanner } from '../src/crypto/market/market-scanner.js';
import { RollingBaseline } from '../src/crypto/market/rolling-baseline.js';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function candle(openTime, open, close, quoteVolume = 1_000) {
  return [openTime, String(open), String(Math.max(open, close)), String(Math.min(open, close)), String(close), '1', openTime + 59_999, String(quoteVolume), 5, '0.5', String(quoteVolume / 2), '0'];
}

test('Binance public client uses only documented public USD-M endpoints and no credentials', async () => {
  const calls = [];
  const client = new BinancePublicClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return response([]);
  } });
  await client.getKlines('BTCUSDT', '1m', 120);
  await client.getOpenInterestHistory('BTCUSDT', '5m', 24);
  await client.getTakerLongShortRatio('BTCUSDT', '5m', 3);
  await client.getPremiumIndex('BTCUSDT');
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/fapi/v1/klines',
    '/futures/data/openInterestHist',
    '/futures/data/takerlongshortRatio',
    '/fapi/v1/premiumIndex',
  ]);
  assert.ok(calls.every((call) => !/key|signature|openai/i.test(call.url + JSON.stringify(call.options))));
  assert.equal(new URL(calls[0].url).searchParams.get('limit'), '120');
});

test('Binance public client bounds request parameters and fails closed', async () => {
  const client = new BinancePublicClient({ fetchImpl: async () => response({ msg: 'rate limited' }, 429) });
  await assert.rejects(() => client.getKlines('not-a-symbol', '1m', 9999), /Invalid Binance symbol/);
  await assert.rejects(() => client.getKlines('BTCUSDT', '1m', 9999), /between 1 and 1500/);
  await assert.rejects(() => client.getKlines('BTCUSDT', '1m', 10), /Binance public request failed \(429\)/);
});

test('kline normalization and rolling window metrics preserve exchange facts', () => {
  const rows = Array.from({ length: 61 }, (_, index) => candle(index * 60_000, 100 + index, 101 + index, 10_000 + index));
  const normalized = rows.map(normalizeKline);
  const metrics = deriveWindowMetrics(normalized);
  assert.equal(metrics.close, 161);
  assert.ok(Math.abs(metrics.return5mPct - 3.2051282051282053) < 1e-12);
  assert.ok(Math.abs(metrics.return15mPct - 10.273972602739725) < 1e-12);
  assert.ok(Math.abs(metrics.return60mPct - 59.4059405940594) < 1e-12);
  assert.equal(metrics.volume5mUsd, 50_290);
  assert.equal(metrics.return2hPct, null);
  assert.equal(metrics.return4hPct, null);
  assert.equal(metrics.return24hPct, null);
  assert.equal(metrics.volume24hUsd, null);
  assert.equal(metrics.direction, 'up');
  assert.equal(metrics.candles.length, 61);
});

test('window metrics expose 15m, 1h, 2h, 4h and 24h horizons without inventing data', () => {
  const rows = Array.from({ length: 1_441 }, (_, index) => candle(index * 60_000, 100 + index, 101 + index, 1_000));
  const metrics = deriveWindowMetrics(rows.map(normalizeKline));
  assert.ok(Number.isFinite(metrics.return15mPct));
  assert.ok(Number.isFinite(metrics.return1hPct));
  assert.ok(Number.isFinite(metrics.return2hPct));
  assert.ok(Number.isFinite(metrics.return4hPct));
  assert.ok(Number.isFinite(metrics.return24hPct));
  assert.ok(metrics.volume24hUsd > metrics.volume4hUsd);
});

test('public websocket URLs use current separated public and market paths', () => {
  assert.deepEqual(publicStreamUrls(), {
    bookTicker: 'wss://fstream.binance.com/public/ws/!bookTicker',
    tickers: 'wss://fstream.binance.com/market/ws/!ticker@arr',
    liquidations: 'wss://fstream.binance.com/market/ws/!forceOrder@arr',
  });
});

test('stream monitor normalizes book and USD-M liquidation updates without credentials', () => {
  const events = [];
  const monitor = new BinanceStreamMonitor({ onMarketUpdate: (event) => events.push(event), webSocketFactory: () => ({}) });
  monitor.ingestBookTicker({ e: 'bookTicker', s: 'BTCUSDT', b: '100', a: '100.2', E: 1 });
  monitor.ingestTicker([{ e: '24hrTicker', st: 1, s: 'BTCUSDT', c: '100.1', q: '1200000', P: '12.34', E: 2 }]);
  monitor.ingestLiquidation({ e: 'forceOrder', st: 2, o: { s: 'BTCUSD_PERP', ap: '100', q: '5', S: 'SELL', T: 2 } });
  monitor.ingestLiquidation({ e: 'forceOrder', st: 1, o: { s: 'BTCUSDT', ap: '100', q: '5', S: 'SELL', T: 3 } });
  assert.deepEqual({ ...events[0], spreadPct: Number(events[0].spreadPct.toFixed(12)) },
    { type: 'book', symbol: 'BTCUSDT', bid: 100, ask: 100.2, spreadPct: 0.1998001998, occurredAt: 1 });
  assert.deepEqual(events[1], { type: 'ticker', symbol: 'BTCUSDT', close: 100.1, quoteVolumeUsd: 1200000, priceChange24hPct: 12.34, occurredAt: 2 });
  assert.deepEqual(events[2], { type: 'liquidation', symbol: 'BTCUSDT', side: 'SELL', notionalUsd: 500, occurredAt: 3 });
});

test('scanner skips deep analysis for quiet snapshots', async () => {
  const baseline = new RollingBaseline();
  baseline.add('BTCUSDT', { occurredAt: 0, absReturn5mPct: 1, absReturn15mPct: 2, volume5mUsd: 1_000_000, volume15mUsd: 3_000_000, liquidationUsd: 100_000, spreadPct: 0.05 });
  let deepCalls = 0;
  const scanner = new MarketScanner({
    baseline,
    client: { getKlines: async () => Array.from({ length: 61 }, (_, index) => normalizeKline(candle(index * 60_000, 100, 100.1, 10_000))) },
    deepAnalyzer: { analyze: async () => { deepCalls += 1; } },
  });
  const result = await scanner.evaluateSymbol({ symbol: 'BTCUSDT', spreadPct: 0.05 }, 60 * 60_000);
  assert.equal(result, null);
  assert.equal(deepCalls, 0);
});

test('scanner starts deep analysis only for a dynamic preliminary trigger', async () => {
  const baseline = new RollingBaseline();
  baseline.add('BTCUSDT', { occurredAt: 0, absReturn5mPct: 0.1, absReturn15mPct: 0.2, volume5mUsd: 50_000, volume15mUsd: 150_000, liquidationUsd: 10_000, spreadPct: 0.02 });
  const klines = Array.from({ length: 61 }, (_, index) => normalizeKline(candle(index * 60_000, 100, index < 56 ? 100 : 102, 100_000)));
  const calls = [];
  const scanner = new MarketScanner({
    baseline,
    client: { getKlines: async () => klines },
    deepAnalyzer: { analyze: async (item, preliminary) => { calls.push({ item, preliminary }); return { id: 'candidate-1', score: 91 }; } },
  });
  const result = await scanner.evaluateSymbol({ symbol: 'BTCUSDT', spreadPct: 0.02 }, 60 * 60_000);
  assert.deepEqual(result, { id: 'candidate-1', score: 91 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].preliminary.reasons.length > 0);
});
