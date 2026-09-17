import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RollingBaseline } from '../src/crypto/market/rolling-baseline.js';
import { BaselineSnapshotStore } from '../src/crypto/storage/baseline-store.js';
import { CryptoScannerController } from '../src/crypto/market/scanner-controller.js';

function normalizedCandles(count = 376, step = 0.01) {
  return Array.from({ length: count }, (_, index) => ({
    openTime: index * 60_000,
    closeTime: index * 60_000 + 59_999,
    open: 100 + index * step,
    high: 100.2 + index * step,
    low: 99.8 + index * step,
    close: 100.05 + index * step,
    quoteVolume: 100_000 + index * 100,
  }));
}

const exchangeInfo = { symbols: [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: 0 },
  { symbol: 'NEWUSDT', baseAsset: 'NEW', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: 21_000_000 },
] };
const tickers = [
  { symbol: 'BTCUSDT', quoteVolume: '90000000' },
  { symbol: 'NEWUSDT', quoteVolume: '20000000' },
];

test('baseline snapshots survive restart independently from small runtime state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-baseline-store-'));
  const filePath = path.join(directory, 'baselines.json');
  const store = new BaselineSnapshotStore({ filePath });
  await store.save({ BTCUSDT: [{ occurredAt: 1, absReturn5mPct: 0.2 }] });
  assert.deepEqual(await new BaselineSnapshotStore({ filePath }).load(), { BTCUSDT: [{ occurredAt: 1, absReturn5mPct: 0.2 }] });
});

test('a corrupted baseline is archived and replaced with an empty snapshot instead of blocking scanner startup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-baseline-corruption-'));
  const filePath = path.join(directory, 'baselines.json');
  await writeFile(filePath, Buffer.alloc(48));

  const snapshot = await new BaselineSnapshotStore({ filePath }).load();

  assert.deepEqual(snapshot, {});
  const files = await readdir(directory);
  assert.ok(files.some((file) => /^baselines\.corrupt-\d+\.json$/.test(file)));
});

test('controller bootstraps the liquid universe without one REST kline request per contract', async () => {
  const calls = [];
  const baseline = new RollingBaseline({ windowMs: 24 * 60 * 60_000 });
  const controller = new CryptoScannerController({
    client: {
      getExchangeInfo: async () => exchangeInfo,
      get24hTickers: async () => tickers,
      getKlines: async (symbol, interval, limit) => { calls.push({ symbol, interval, limit }); return normalizedCandles(limit); },
    },
    baseline,
    baselineStore: { load: async () => ({}), save: async () => {} },
    deepAnalyzer: { analyze: async () => null },
    streamMonitor: { start() {}, stop() {} },
    clock: () => 22_500_000,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  const status = await controller.start({ onCandidate: async () => {} });
  assert.deepEqual(calls, []);
  assert.equal(baseline.summary('BTCUSDT', 22_500_000).sampleHours, 0);
  assert.equal(status.universeCount, 2);
  assert.equal(status.autoEligibleCount, 0);
  await controller.stop();
});

test('WS cache keeps current spread and a rolling five-minute USD-M liquidation total', () => {
  const controller = new CryptoScannerController({ clock: () => 400_000 });
  controller.ingestMarketUpdate({ type: 'book', symbol: 'BTCUSDT', spreadPct: 0.08, occurredAt: 400_000 });
  controller.ingestMarketUpdate({ type: 'liquidation', symbol: 'BTCUSDT', side: 'SELL', notionalUsd: 100, occurredAt: 50_000 });
  controller.ingestMarketUpdate({ type: 'liquidation', symbol: 'BTCUSDT', side: 'BUY', notionalUsd: 250, occurredAt: 350_000 });
  assert.deepEqual(controller.marketSnapshot('BTCUSDT'), {
    spreadPct: 0.08,
    liquidationUsd: 250,
    liquidations: [{ side: 'BUY', notionalUsd: 250, occurredAt: 350_000 }],
  });
});

test('polling marks missing or wide spread candidates monitor-only before runtime', async () => {
  const candidates = [];
  const baseline = new RollingBaseline();
  const controller = new CryptoScannerController({
    baseline,
    client: { getKlines: async () => normalizedCandles(61) },
    deepAnalyzer: { analyze: async (item) => ({ id: item.symbol, score: 91, occurredAt: 1, autoEligible: item.autoEligible }) },
    streamMonitor: { start() {}, stop() {} },
    clock: () => 1_000_000,
  });
  controller.universe = [
    { symbol: 'BTCUSDT', autoEligible: true, quoteVolumeUsd: 20_000_000, priceChange24hPct: 12 },
    { symbol: 'ETHUSDT', autoEligible: true, quoteVolumeUsd: 20_000_000, priceChange24hPct: 11 },
  ];
  controller.ingestMarketUpdate({ type: 'book', symbol: 'BTCUSDT', spreadPct: 0.7, occurredAt: 1_000_000 });
  controller.onCandidate = async (candidate) => { candidates.push(candidate); };
  controller.scanner = { evaluateSymbol: async (item) => ({ id: item.symbol, score: 79, occurredAt: 1, autoEligible: item.autoEligible }) };
  await controller.pollOnce();
  assert.deepEqual(candidates.map(({ id, autoEligible }) => ({ id, autoEligible })), [
    { id: 'BTCUSDT', autoEligible: false },
    { id: 'ETHUSDT', autoEligible: false },
  ]);
});

test('top-runner mode sends the highest positive 24h gainer onward without autoEligible or score filtering', async () => {
  const candidates = [];
  const controller = new CryptoScannerController({
    baseline: new RollingBaseline(),
    client: { getKlines: async () => normalizedCandles(61) },
    deepAnalyzer: { analyze: async () => null },
    streamMonitor: { start() {}, stop() {} },
    topRunnerMode: true,
    deepAnalysisQueueLimit: 1,
    clock: () => 1_000_000,
  });
  controller.universe = [
    { symbol: 'BTCUSDT', autoEligible: false, quoteVolumeUsd: 1, priceChange24hPct: 42 },
    { symbol: 'ETHUSDT', autoEligible: true, quoteVolumeUsd: 99_000_000, priceChange24hPct: 31 },
  ];
  controller.scanner = { evaluateTopRunner: async (item) => ({ id: item.symbol, token: item.symbol.slice(0, -4), score: 1, occurredAt: 1 }) };
  controller.onCandidate = async (candidate) => { candidates.push(candidate); return { status: 'preview' }; };

  await controller.pollOnce();

  assert.deepEqual(candidates.map((candidate) => ({ id: candidate.id, livePublicData: candidate.livePublicData })), [
    { id: 'BTCUSDT', livePublicData: true },
  ]);
});

test('top-runner mode moves to the next ranked symbol after a same-token cooldown', async () => {
  let now = 1_000_000;
  const attempted = [];
  const controller = new CryptoScannerController({
    baseline: new RollingBaseline(),
    client: { getKlines: async () => normalizedCandles(61) },
    deepAnalyzer: { analyze: async () => null },
    streamMonitor: { start() {}, stop() {} },
    topRunnerMode: true,
    deepAnalysisQueueLimit: 1,
    clock: () => now,
  });
  controller.universe = [
    { symbol: 'FIRSTUSDT', quoteVolumeUsd: 1, priceChange24hPct: 50 },
    { symbol: 'SECONDUSDT', quoteVolumeUsd: 1, priceChange24hPct: 40 },
  ];
  controller.scanner = { evaluateTopRunner: async (item) => ({ id: item.symbol, symbol: item.symbol, token: item.symbol.slice(0, -4), score: 1, occurredAt: now }) };
  controller.onCandidate = async (candidate) => {
    attempted.push(candidate.symbol);
    return candidate.symbol === 'FIRSTUSDT'
      ? { status: 'rejected', reason: 'follow_up_cooldown' }
      : { status: 'preview' };
  };

  await controller.pollOnce();
  now += 60_000;
  await controller.pollOnce();

  assert.deepEqual(attempted, ['FIRSTUSDT', 'SECONDUSDT']);
});

test('a successful symbol poll clears a previous transient degraded scanner status', async () => {
  const statuses = [];
  let attempt = 0;
  let now = 1_000_000;
  const controller = new CryptoScannerController({
    baseline: new RollingBaseline(),
    client: { getKlines: async () => normalizedCandles(61) },
    deepAnalyzer: { analyze: async () => null },
    streamMonitor: { start() {}, stop() {} },
    clock: () => now,
    onStatus: (status) => statuses.push(status),
  });
  controller.universe = [{ symbol: 'BTCUSDT', autoEligible: true, quoteVolumeUsd: 20_000_000, priceChange24hPct: 12 }];
  controller.ingestMarketUpdate({ type: 'book', symbol: 'BTCUSDT', spreadPct: 0.05, occurredAt: 1_000_000 });
  controller.scanner = {
    evaluateSnapshot: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('temporary REST block');
      return null;
    },
  };

  await controller.pollOnce();
  now += 300_000;
  await controller.pollOnce();

  assert.equal(statuses.at(-2).state, 'degraded');
  assert.equal(statuses.at(-1).state, 'running');
});

test('competition window emits one winner by deterministic ranking', async () => {
  let now = 0;
  const candidates = [];
  const controller = new CryptoScannerController({
    competitionWindowMs: 600_000,
    clock: () => now,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  controller.onCandidate = async (candidate) => { candidates.push(candidate); };
  controller.submitCandidate({ id: 'a', score: 90, confidence: 0.9, quoteVolumeUsd: 10, occurredAt: 0 });
  controller.submitCandidate({ id: 'b', score: 93, confidence: 0.8, quoteVolumeUsd: 20, occurredAt: 60_000 });
  now = 599_999;
  assert.equal(await controller.flushCompetition(), null);
  now = 600_000;
  assert.equal((await controller.flushCompetition()).id, 'b');
  assert.deepEqual(candidates.map((item) => item.id), ['b']);
});

test('scanner admits only a bounded fresh deep-analysis set during a multi-symbol burst', async () => {
  let analyses = 0;
  const controller = new CryptoScannerController({
    baseline: new RollingBaseline(),
    client: { getKlines: async () => normalizedCandles(61) },
    deepAnalyzer: { analyze: async (item) => ({ id: item.symbol, score: 79, occurredAt: 1 }) },
    deepAnalysisQueueLimit: 8,
    deepAnalysisConcurrency: 2,
    deepAnalysisPerSymbolCooldownMs: 300_000,
    clock: () => 1_000_000,
  });
  controller.universe = Array.from({ length: 6_011 }, (_, index) => ({ symbol: `T${String(index).padStart(5, '0')}USDT`, quoteVolumeUsd: 6_011 - index, priceChange24hPct: 6_011 - index, autoEligible: false }));
  controller.scanner = { evaluateSnapshot: async (item) => { analyses += 1; return { id: item.symbol, score: 79, occurredAt: 1 }; } };
  await controller.pollOnce();
  assert.equal(analyses, 8);
  assert.equal(controller.status().deepAnalysis.droppedOrCoalesced, 6_003);
});

test('scanner evaluates only the top ten positive 24h gainers, even when lower-ranked contracts have more volume', async () => {
  const evaluated = [];
  const controller = new CryptoScannerController({
    baseline: new RollingBaseline(),
    client: { getKlines: async () => normalizedCandles(61) },
    deepAnalyzer: { analyze: async () => null },
    deepAnalysisQueueLimit: 10,
    deepAnalysisConcurrency: 1,
    clock: () => 1_000_000,
  });
  controller.universe = Array.from({ length: 12 }, (_, index) => ({
    symbol: `T${index}USDT`, autoEligible: false,
    priceChange24hPct: 12 - index,
    quoteVolumeUsd: index === 11 ? 1_000_000_000 : 1_000_000,
  }));
  controller.scanner = { evaluateSnapshot: async (item) => {
    evaluated.push(item.symbol);
    return { id: item.symbol, score: 79, occurredAt: 1 };
  } };

  await controller.pollOnce();

  assert.deepEqual(evaluated, Array.from({ length: 10 }, (_, index) => `T${index}USDT`));
});

test('competition falls through to the next ranked fresh runner when the first token is temporarily ineligible', async () => {
  const attempted = [];
  const controller = new CryptoScannerController({
    competitionWindowMs: 0,
    clock: () => 0,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  controller.onCandidate = async (candidate) => {
    attempted.push(candidate.id);
    return candidate.id === 'first' ? { status: 'rejected', reason: 'follow_up_cooldown' } : { status: 'preview', published: false };
  };
  controller.submitCandidate({ id: 'first', score: 90, priceChange24hPct: 40, confidence: 0.8, quoteVolumeUsd: 1, occurredAt: 0, visualImpulsePriority: 1 });
  controller.submitCandidate({ id: 'second', score: 88, priceChange24hPct: 30, confidence: 0.8, quoteVolumeUsd: 1, occurredAt: 0, visualImpulsePriority: 1 });

  assert.equal((await controller.flushCompetition()).id, 'second');
  assert.deepEqual(attempted, ['first', 'second']);
});
