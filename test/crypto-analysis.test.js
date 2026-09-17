import test from 'node:test';
import assert from 'node:assert/strict';

import { DeepMarketAnalyzer, isTopRunnerChartReady, topRunnerVisualState, validateTimedDerivativeSeries } from '../src/crypto/market/deep-analyzer.js';
import { dueOutcomeHorizons, measureOutcome } from '../src/crypto/learning/outcome-tracker.js';
import { updateLearningProfile } from '../src/crypto/learning/learning-profile.js';

function candles(base = 100, step = 0.05) {
  return Array.from({ length: 121 }, (_, index) => ({
    openTime: index * 60_000,
    open: base + index * step,
    high: base + index * step + 0.2,
    low: base + index * step - 0.2,
    close: base + index * step + 0.1,
    quoteVolume: 1_000_000 + index * 20_000,
  }));
}

function sharpFinalImpulseCandles() {
  const rows = candles(100, 0.01);
  const finalWindowStart = rows.length - 16;
  for (let index = 0; index < 16; index += 1) {
    const close = index < 10 ? 101 + index * 0.03 : 101.3 + (index - 9) * 0.5;
    rows[finalWindowStart + index] = {
      ...rows[finalWindowStart + index],
      open: close - 0.18,
      high: close + 0.12,
      low: close - 0.24,
      close,
    };
  }
  return rows;
}

function freshImpulseWithOneRedClosingCandle() {
  const rows = candles(100, 0.01);
  const finalWindowStart = rows.length - 16;
  for (let index = 0; index < 16; index += 1) {
    const close = index <= 10 ? 100 + index * 0.19 : 101.9 + (index - 10) * 0.3;
    rows[finalWindowStart + index] = {
      ...rows[finalWindowStart + index],
      open: close - 0.12,
      high: close + 0.16,
      low: close - 0.2,
      close,
    };
  }
  rows.at(-1).open = 103.35;
  rows.at(-1).high = 103.4;
  rows.at(-1).low = 102.8;
  rows.at(-1).close = 103;
  return rows;
}

function staleDailyRunnerCandles() {
  const rows = candles(100, 0.02);
  for (let index = 48; index < 70; index += 1) {
    const close = 100 + ((index - 47) * 2);
    rows[index] = { ...rows[index], open: close - 0.3, high: close + 0.25, low: close - 0.4, close };
  }
  const finalWindowStart = rows.length - 16;
  for (let index = 0; index < 16; index += 1) {
    const close = 104 + (index * 0.16);
    rows[finalWindowStart + index] = { ...rows[finalWindowStart + index], open: close - 0.12, high: close + 0.08, low: close - 0.2, close };
  }
  return rows;
}

function runnerPullbackCandles() {
  const rows = candles(100, 0.01);
  const start = rows.length - 36;
  for (let index = 0; index < 30; index += 1) {
    const close = 101 + index * 0.22;
    rows[start + index] = { ...rows[start + index], open: close - 0.12, high: close + 0.14, low: close - 0.2, close };
  }
  for (let index = 30; index < 36; index += 1) {
    const close = 107.1 - (index - 30) * 0.14;
    rows[start + index] = { ...rows[start + index], open: close + 0.11, high: close + 0.18, low: close - 0.2, close };
  }
  return rows;
}

test('derivatives evidence rejects stale, duplicate, discontinuous, and malformed timestamp series', () => {
  const now = 10_000_000;
  const options = { valueKey: 'value', periodMs: 300_000, minPoints: 2, now };
  assert.equal(validateTimedDerivativeSeries([
    { timestamp: now - 1_500_000, value: '1' }, { timestamp: now - 1_200_000, value: '2' },
  ], options).reason, 'STALE_DERIVATIVES_EVIDENCE');
  assert.equal(validateTimedDerivativeSeries([
    { timestamp: now - 600_000, value: '1' }, { timestamp: now - 600_000, value: '2' },
  ], options).reason, 'DUPLICATE_DERIVATIVES_TIMESTAMP');
  assert.equal(validateTimedDerivativeSeries([
    { timestamp: now - 900_000, value: '1' }, { timestamp: now - 300_000, value: '2' },
  ], options).reason, 'DISCONTINUOUS_DERIVATIVES_EVIDENCE');
  assert.equal(validateTimedDerivativeSeries([
    { timestamp: 'not-a-time', value: '1' }, { timestamp: now - 300_000, value: '2' },
  ], options).reason, 'MALFORMED_DERIVATIVES_EVIDENCE');
});

test('deep analyzer derives score, conflicts and claim allow-list entirely from fetched facts', async () => {
  const client = {
    getKlines: async (symbol) => candles(symbol === 'ETHUSDT' ? 50 : 100, symbol === 'ETHUSDT' ? 0.01 : 0.05),
    getOpenInterestHistory: async () => [
      { timestamp: 6_900_000, sumOpenInterestValue: '100000000' },
      { timestamp: 7_200_000, sumOpenInterestValue: '104000000' },
    ],
    getTakerLongShortRatio: async () => [{ timestamp: 6_900_000, buySellRatio: '1.7' }, { timestamp: 7_200_000, buySellRatio: '1.8' }],
    getPremiumIndex: async () => ({ lastFundingRate: '0.0002', markPrice: '106.1' }),
  };
  const analyzer = new DeepMarketAnalyzer({ client });
  const result = await analyzer.analyze({
    symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', cashtag: '$BTC', quoteVolumeUsd: 80_000_000,
    metrics: { return5mPct: 2.1, return15mPct: 3.8, volume5mUsd: 10_000_000, volume15mUsd: 25_000_000 },
    market: { spreadPct: 0.06, liquidationUsd: 2_000_000 },
  }, { ratios: { priceSurprise5m: 5.2, priceSurprise15m: 4.1, volume5mRatio: 5.5, volume15mRatio: 3.2, liquidationRatio: 4.2 } }, 7_200_000);
  assert.equal(result.symbol, 'BTCUSDT');
  assert.equal(result.token, 'BTC');
  assert.equal(result.baseAsset, 'BTC');
  assert.equal(result.quoteAsset, 'USDT');
  assert.equal(result.cashtag, '$BTC');
  assert.equal(result.openInterestChangePct, 4);
  assert.equal(result.takerBuySellRatio, 1.8);
  assert.equal(result.fundingRatePct, 0.02);
  assert.ok(result.score >= 80 && result.score <= 100);
  assert.equal(result.scoreSource, 'deterministic-code');
  assert.ok(result.claimsAllowed.some((claim) => claim.key === 'openInterestChange' && claim.display === '+4.00%'));
  assert.ok(result.claimsAllowed.some((claim) => claim.key === 'fundingRate' && claim.display === '+0.0200%'));
  assert.ok(['none', 'calibrated', 'hard'].includes(result.conflict.verdictStyle));
  assert.ok(result.metrics.candles.length >= 121);
  assert.deepEqual(Object.keys(result.metrics.chartCandles).sort(), ['15m', '1h', '4h', '5m']);
  assert.ok(result.technicalContext);
  assert.equal(result.technicalContext.market.range24h.currentPrice, 106.1);
});

test('deep analyzer flags only a fresh concentrated upside impulse for equal-score priority', async () => {
  const client = {
    getKlines: async (symbol) => symbol === 'BTRUSDT' ? sharpFinalImpulseCandles() : candles(100, 0.01),
    getOpenInterestHistory: async () => [
      { timestamp: 0, sumOpenInterestValue: '100000000' },
      { timestamp: 60_000, sumOpenInterestValue: '104000000' },
    ],
    getTakerLongShortRatio: async () => [{ timestamp: 0, buySellRatio: '1.8' }],
    getPremiumIndex: async () => ({ lastFundingRate: '0.0002' }),
  };
  const analyzer = new DeepMarketAnalyzer({ client });
  const baseItem = {
    baseAsset: 'BTR', quoteAsset: 'USDT', cashtag: '$BTR', quoteVolumeUsd: 80_000_000,
    market: { spreadPct: 0.06, liquidationUsd: 2_000_000 },
  };
  const preliminary = { ratios: { priceSurprise5m: 5.2, priceSurprise15m: 4.1, volume5mRatio: 5.5, volume15mRatio: 3.2, liquidationRatio: 4.2 } };

  const sharp = await analyzer.analyze({ ...baseItem, symbol: 'BTRUSDT' }, preliminary, 7_200_000);
  const smooth = await analyzer.analyze({ ...baseItem, symbol: 'MAGMAUSDT', baseAsset: 'MAGMA', cashtag: '$MAGMA' }, preliminary, 7_260_000);

  assert.equal(sharp.visualImpulsePriority, 1);
  assert.equal(sharp.freshRunnerEligible, true);
  assert.equal(smooth.visualImpulsePriority, 0);
});

test('deep analyzer keeps a fresh peak eligible when one small red candle follows it', async () => {
  const analyzer = new DeepMarketAnalyzer({ client: {
    getKlines: async (symbol) => symbol === 'BTRUSDT' ? freshImpulseWithOneRedClosingCandle() : candles(100, 0.01),
    getOpenInterestHistory: async () => [{ sumOpenInterestValue: '100000000' }, { sumOpenInterestValue: '104000000' }],
    getTakerLongShortRatio: async () => [{ buySellRatio: '1.8' }],
    getPremiumIndex: async () => ({ lastFundingRate: '0.0002' }),
  } });

  const result = await analyzer.analyze({
    symbol: 'BTRUSDT', baseAsset: 'BTR', quoteAsset: 'USDT', cashtag: '$BTR', quoteVolumeUsd: 80_000_000,
    market: { spreadPct: 0.06, liquidationUsd: 2_000_000 },
  }, { ratios: { priceSurprise5m: 5.2, priceSurprise15m: 4.1, volume5mRatio: 5.5, volume15mRatio: 3.2, liquidationRatio: 4.2 } }, 7_200_000);

  assert.equal(result.freshRunnerEligible, true);
});

test('deep analyzer rejects a daily runner whose current five-hour chart remains far below its earlier peak', async () => {
  const analyzer = new DeepMarketAnalyzer({ client: {
    getKlines: async (symbol) => symbol === 'SKRUSDT' ? staleDailyRunnerCandles() : candles(100, 0.01),
    getOpenInterestHistory: async () => [{ sumOpenInterestValue: '100000000' }, { sumOpenInterestValue: '104000000' }],
    getTakerLongShortRatio: async () => [{ buySellRatio: '1.8' }],
    getPremiumIndex: async () => ({ lastFundingRate: '0.0002' }),
  } });

  const result = await analyzer.analyze({
    symbol: 'SKRUSDT', baseAsset: 'SKR', quoteAsset: 'USDT', cashtag: '$SKR', quoteVolumeUsd: 80_000_000,
    priceChange24hPct: 87.26, market: { spreadPct: 0.06, liquidationUsd: 2_000_000 },
  }, { ratios: { priceSurprise5m: 5.2, priceSurprise15m: 4.1, volume5mRatio: 5.5, volume15mRatio: 3.2, liquidationRatio: 4.2 } }, 7_200_000);

  assert.equal(result.visualImpulsePriority, 0);
  assert.equal(result.freshRunnerEligible, false);
});

test('top-runner chart selection keeps one trailing red minute only when the preceding green candle made a local right-edge high', () => {
  assert.equal(isTopRunnerChartReady(freshImpulseWithOneRedClosingCandle()), true);
  assert.equal(isTopRunnerChartReady(staleDailyRunnerCandles()), false);
});

test('top-runner selection classifies a recent rise followed by a contained pullback as a bullish watchlist pullback', () => {
  assert.equal(topRunnerVisualState(runnerPullbackCandles()), 'pullback');
  assert.equal(topRunnerVisualState(staleDailyRunnerCandles()), null);
});

test('deep analyzer rejects non-finite derivatives instead of manufacturing confidence', async () => {
  const analyzer = new DeepMarketAnalyzer({ client: {
    getKlines: async () => candles(),
    getOpenInterestHistory: async () => [{ sumOpenInterestValue: 'not-a-number' }],
    getTakerLongShortRatio: async () => [],
    getPremiumIndex: async () => ({}),
  } });
  await assert.rejects(() => analyzer.analyze({ symbol: 'SOLUSDT', baseAsset: 'SOL', cashtag: '$SOL', quoteVolumeUsd: 20_000_000, metrics: {}, market: { spreadPct: 0.1 } }, { ratios: {} }), /insufficient derivatives data/i);
});

test('deep analyzer omits stale OI and taker claims without rejecting otherwise usable market evidence', async () => {
  const now = 10_000_000;
  const analyzer = new DeepMarketAnalyzer({ client: {
    getKlines: async () => candles(),
    getOpenInterestHistory: async () => [
      { timestamp: now - 1_500_000, sumOpenInterestValue: '100000000' },
      { timestamp: now - 1_200_000, sumOpenInterestValue: '104000000' },
    ],
    getTakerLongShortRatio: async () => [
      { timestamp: now - 1_500_000, buySellRatio: '1.2' },
      { timestamp: now - 1_200_000, buySellRatio: '1.8' },
    ],
    getPremiumIndex: async () => ({ lastFundingRate: '0.0002' }),
  } });
  const result = await analyzer.analyze({
    symbol: 'STALEUSDT', baseAsset: 'STALE', quoteAsset: 'USDT', cashtag: '$STALE', quoteVolumeUsd: 80_000_000,
    market: { spreadPct: 0.06, liquidationUsd: 0 },
  }, { ratios: { priceSurprise5m: 4, priceSurprise15m: 4, volume5mRatio: 4, volume15mRatio: 4 } }, now);

  assert.equal(result.openInterestChangePct, null);
  assert.equal(result.takerBuySellRatio, null);
  assert.equal(result.claimsAllowed.some((claim) => ['openInterestChange', 'takerBuySellRatio'].includes(claim.key)), false);
  assert.equal(result.derivativesEvidence.openInterest.reason, 'STALE_DERIVATIVES_EVIDENCE');
});

test('deep analysis excludes a still-forming candle from metrics, charts, and technical levels', async () => {
  const now = 1_000_000_000;
  const closed = Array.from({ length: 121 }, (_, index) => ({
    openTime: now - (122 - index) * 60_000,
    closeTime: now - (121 - index) * 60_000 - 1,
    open: 100 + index * 0.01,
    high: 100.3 + index * 0.01,
    low: 99.8 + index * 0.01,
    close: 100.1 + index * 0.01,
    quoteVolume: 10_000,
  }));
  const forming = { ...closed.at(-1), openTime: now - 1_000, closeTime: now + 299_000, high: 500, low: 1, close: 400 };
  const analyzer = new DeepMarketAnalyzer({ client: {
    getKlines: async () => [...closed, forming],
    getOpenInterestHistory: async () => [{ sumOpenInterestValue: '100000000' }, { sumOpenInterestValue: '104000000' }],
    getTakerLongShortRatio: async () => [{ buySellRatio: '1.8' }],
    getPremiumIndex: async () => ({ lastFundingRate: '0.0002' }),
  } });

  const result = await analyzer.analyze({
    symbol: 'SAFEUSDT', baseAsset: 'SAFE', quoteAsset: 'USDT', cashtag: '$SAFE', quoteVolumeUsd: 80_000_000,
    market: { spreadPct: 0.06, liquidationUsd: 0 },
  }, { ratios: { priceSurprise5m: 4, priceSurprise15m: 4, volume5mRatio: 4, volume15mRatio: 4 } }, now);

  assert.equal(result.metrics.close, closed.at(-1).close);
  assert.ok(Object.values(result.metrics.chartCandles).every((series) => series.every((row) => row.closeTime <= now)));
  assert.ok(result.technicalContext.evidence.candidateZones.every((level) => level.midpoint < 200));
});

test('outcome tracker exposes only due 15m, 1h and 4h horizons', () => {
  const publishedAt = Date.UTC(2026, 7, 20, 12);
  assert.deepEqual(dueOutcomeHorizons({ publishedAt, outcomes: {} }, publishedAt + 14 * 60_000), []);
  assert.deepEqual(dueOutcomeHorizons({ publishedAt, outcomes: {} }, publishedAt + 61 * 60_000), ['15m', '1h']);
  assert.deepEqual(dueOutcomeHorizons({ publishedAt, outcomes: { '15m': {} } }, publishedAt + 5 * 3_600_000), ['1h', '4h']);
  assert.deepEqual(measureOutcome({ entryPrice: 100, expectedDirection: 'up' }, 104, '1h', publishedAt), {
    horizon: '1h', measuredAt: publishedAt, price: 104, returnPct: 4, directionCorrect: true,
  });
});

test('learning remains inert before eight samples and bounded at 8/15/30', () => {
  const outcomes = (count, directionCorrect = true) => Array.from({ length: count }, (_, index) => ({
    preset: index % 2 ? 'receipt' : 'volume_shock',
    hookFamily: index % 2 ? 'divergence' : 'receipt',
    directionCorrect,
    engagementRate: directionCorrect ? 0.04 : 0.002,
  }));
  assert.deepEqual(updateLearningProfile({ samples: 0, adjustments: {} }, outcomes(7)), { samples: 7, adjustments: {} });
  const eight = updateLearningProfile({ samples: 0, adjustments: {} }, outcomes(8));
  assert.equal(eight.samples, 8);
  assert.ok(Object.values(eight.adjustments.presetWeights).every((value) => Math.abs(value) <= 0.05));
  const fifteen = updateLearningProfile({ samples: 0, adjustments: {} }, outcomes(15, false));
  assert.ok(Math.abs(fifteen.adjustments.editorialThresholdDelta) <= 2);
  const thirty = updateLearningProfile({ samples: 0, adjustments: {} }, outcomes(30));
  assert.ok(Object.values(thirty.adjustments.hookWeights).every((value) => Math.abs(value) <= 0.1));
  assert.equal(Object.hasOwn(thirty.adjustments, 'scoreOverride'), false);
  assert.equal(Object.hasOwn(thirty.adjustments, 'conflictOverride'), false);
});
