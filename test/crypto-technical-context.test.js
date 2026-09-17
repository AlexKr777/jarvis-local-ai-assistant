import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeTechnicalContext } from '../src/crypto/market/technical-context.js';

function candle(index, close, high = close + 0.5, low = close - 0.5) {
  return { openTime: index * 3_600_000, closeTime: (index + 1) * 3_600_000 - 1, open: close - 0.1, high, low, close, volume: 1_000, quoteVolume: 100_000 };
}

test('technical context derives 24h range position, drawdown, and a repeated 1h resistance zone', () => {
  const oneHour = [
    candle(0, 95), candle(1, 97), candle(2, 99, 100.2), candle(3, 97), candle(4, 96),
    candle(5, 97), candle(6, 99, 100.1), candle(7, 98), candle(8, 97), candle(9, 99),
  ];
  const result = analyzeTechnicalContext({
    symbol: 'TESTUSDT',
    candlesByTimeframe: { '5m': oneHour, '15m': oneHour, '1h': oneHour, '4h': oneHour },
    ticker: { lastPrice: 95, highPrice: 100, lowPrice: 80 },
    now: 10 * 3_600_000,
  });

  assert.equal(result.market.range24h.position, 0.75);
  assert.equal(result.market.drawdownFromHighPct, -5);
  assert.ok(result.levels.resistances.every((level) => level.side === 'resistance'));
  assert.ok(result.levels.resistances.some((level) => level.evidence.length >= 2));
});

test('technical context keeps public supports below spot and provides the 24h high as a truthful watch resistance', () => {
  const series = [
    candle(0, 8.9), candle(1, 9.1, 9.2, 8.8), candle(2, 8.7, 9, 8.5),
    candle(3, 9.3, 9.4, 8.9), candle(4, 8.8, 9.0, 8.6), candle(5, 9.5, 9.6, 9.0),
  ];
  const result = analyzeTechnicalContext({
    symbol: 'TESTUSDT',
    candlesByTimeframe: { '5m': series, '15m': series, '1h': series, '4h': series },
    ticker: { lastPrice: 9.7, highPrice: 10, lowPrice: 8 },
  });

  assert.ok(result.levels.supports.every((level) => level.midpoint < 9.7));
  assert.ok(result.levels.resistances.every((level) => level.midpoint >= 9.7));
  assert.equal(result.levels.resistances[0].midpoint, 10);
  assert.ok(result.technicalEvents.some((event) => event.kind === 'near_24h_high'));
});

test('technical context assigns distinct deterministic roles and records the observed response', () => {
  const series = [
    candle(0, 8.7, 8.8, 8.5), candle(1, 8.9, 9.0, 8.6), candle(2, 8.6, 8.9, 8.4),
    candle(3, 9.1, 9.2, 8.7), candle(4, 8.8, 9.0, 8.6), candle(5, 9.3, 9.4, 8.9),
    candle(6, 9.0, 9.35, 8.8), candle(7, 9.55, 9.6, 9.0), candle(8, 9.7, 9.8, 9.45),
  ];
  const result = analyzeTechnicalContext({
    symbol: 'TESTUSDT',
    candlesByTimeframe: { '5m': series, '15m': series, '1h': series, '4h': series },
    ticker: { lastPrice: 9.7, highPrice: 10, lowPrice: 8, priceChangePercent: 12 },
  });

  const roles = result.evidence.roles;
  assert.equal(roles.firstReactionZone.role, 'first_reaction_zone');
  assert.equal(roles.structuralInvalidation.role, 'structural_invalidation');
  assert.equal(roles.nextWatch.role, 'next_watch');
  assert.notEqual(roles.firstReactionZone.levelId, roles.structuralInvalidation.levelId);
  assert.notEqual(roles.firstReactionZone.levelId, roles.nextWatch.levelId);
  assert.ok(roles.firstReactionZone.why.length > 20);
  assert.ok(result.evidence.structure['1h'].direction);
  assert.ok(result.technicalEvents.some((event) => ['support_retest', 'resistance_rejection', 'breakout', 'acceptance'].includes(event.kind)));
});

test('technical context enriches deterministic zones with volatility, reaction and market-behaviour evidence', () => {
  const series = Array.from({ length: 28 }, (_, index) => {
    const close = index < 18 ? 100 + (index % 3) * 0.25 : 104 + (index - 18) * 0.8;
    const row = candle(index, close, close + 0.7, close - 0.6);
    return {
      ...row,
      quoteVolume: index === 27 ? 900_000 : 100_000,
      takerBuyQuoteVolume: index >= 22 ? 72_000 : 48_000,
    };
  });
  const result = analyzeTechnicalContext({
    symbol: 'RICHUSDT',
    candlesByTimeframe: { '5m': series, '15m': series, '1h': series, '4h': series },
    ticker: { lastPrice: 111.2, highPrice: 112, lowPrice: 98, priceChangePercent: 10.5 },
  });

  const zone = result.evidence.zones[0];
  assert.ok(zone);
  assert.equal(zone.zoneLow, zone.priceLow);
  assert.equal(zone.zoneHigh, zone.priceHigh);
  assert.ok(Number.isFinite(zone.distanceATR));
  assert.ok(Number.isFinite(zone.strengthScore));
  assert.ok(['accepted_above', 'accepted_below', 'mixed', 'insufficient_data'].includes(zone.closeBehavior));
  assert.ok(Array.isArray(zone.evidenceCandleIds));
  assert.ok(Number.isFinite(result.market.volatility.atr14));
  assert.ok(['accelerating', 'decelerating', 'steady', 'insufficient_data'].includes(result.evidence.momentum.state));
  assert.ok(['expanding', 'contracting', 'steady', 'insufficient_data'].includes(result.evidence.volume.trend));
  assert.ok(['buy_dominant', 'sell_dominant', 'balanced', 'unavailable'].includes(result.evidence.takerFlow.bias));
  assert.ok(['impulse', 'pullback', 'consolidation', 'range', 'insufficient_data'].includes(result.evidence.structure['5m'].phase));
});

test('a close low-volatility support can qualify structurally while the same percent distance is not a universal rule', () => {
  const series = Array.from({ length: 36 }, (_, index) => {
    const close = 100 + ((index % 2) * 0.04);
    const low = [7, 15, 23].includes(index) ? 99.5 : close - 0.05;
    return candle(index, close, close + 0.06, low);
  });
  const result = analyzeTechnicalContext({
    symbol: 'CALMUSDT',
    candlesByTimeframe: { '5m': series, '15m': series, '1h': series, '4h': series },
    ticker: { lastPrice: 100, highPrice: 101, lowPrice: 98 },
  });

  const nearby = result.evidence.candidateZones.find((level) => Math.abs(level.midpoint - 99.5) < 0.001 && level.touches > 1);
  assert.ok(nearby, 'the repeated nearby low is retained as evidence');
  assert.equal(nearby.structuralEligible, true, 'qualification follows local volatility, not a universal 2% band');
  assert.ok(nearby.distanceATR > 1);
});

test('overlapping local and 24h support evidence is merged before public roles are assigned', () => {
  const series = Array.from({ length: 40 }, (_, index) => {
    const close = 100 + ((index % 2) * 0.02);
    return candle(index, close, 100.12, [8, 16, 24].includes(index) ? 99.8 : 99.95);
  });
  const result = analyzeTechnicalContext({
    symbol: 'MERGEUSDT',
    candlesByTimeframe: { '5m': series, '15m': series, '1h': series, '4h': series },
    ticker: { lastPrice: 100, highPrice: 101, lowPrice: 99.81 },
  });

  const supports = result.levels.supports;
  assert.ok(supports.length < 2 || supports[0].priceHigh < supports[1].priceLow || supports[1].priceHigh < supports[0].priceLow,
    'public support roles must not describe the same price area twice');
  assert.notEqual(result.evidence.roles.firstReactionZone?.levelId, result.evidence.roles.structuralInvalidation?.levelId);
});

test('ordinary monotonic noise produces no public technical level without a verified range or reaction', () => {
  const series = Array.from({ length: 30 }, (_, index) => candle(index, 100 + index * 0.01, 100.03 + index * 0.01, 99.99 + index * 0.01));
  const result = analyzeTechnicalContext({
    symbol: 'NOISEUSDT',
    candlesByTimeframe: { '5m': series, '15m': series, '1h': series, '4h': series },
    ticker: { lastPrice: 100.3, highPrice: 100.3, lowPrice: 100.3 },
  });
  assert.deepEqual(result.publicLevelIds, []);
  assert.equal(result.evidence.roles.firstReactionZone, null);
});

test('public levels normalize zone prices to the supplied Binance tick size only at the public boundary', () => {
  const series = Array.from({ length: 32 }, (_, index) => {
    const close = 100 + ((index % 2) * 0.02);
    return candle(index, close, [7, 15, 23].includes(index) ? 100.11 : 100.08, [7, 15, 23].includes(index) ? 99.93 : 99.97);
  });
  const result = analyzeTechnicalContext({
    symbol: 'TICKUSDT', tickSize: '0.05',
    candlesByTimeframe: { '5m': series, '15m': series, '1h': series, '4h': series },
    ticker: { lastPrice: 100, highPrice: 100.11, lowPrice: 99.93 },
  });
  for (const level of [...result.levels.supports, ...result.levels.resistances]) {
    for (const price of [level.priceLow, level.midpoint, level.priceHigh]) {
      assert.ok(Math.abs((price / 0.05) - Math.round(price / 0.05)) < 1e-7, `${price} must be a valid 0.05 increment`);
    }
  }
});
