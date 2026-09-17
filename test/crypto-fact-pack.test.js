import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFactPack } from '../src/crypto/content/fact-pack.js';

const candidate = {
  id: 'candidate-1', symbol: 'ABCUSDT', token: 'ABC', cashtag: '$ABC', priceChange24hPct: 22.5,
  claimsAllowed: [{ key: 'return24h', display: '+22.50%', value: 22.5, timeframe: '24h' }],
  metrics: { close: 1.25, candles: [{ openTime: 1, close: 1.25 }] },
};
const research = { status: 'none_found', sources: [], claims: [], cleanCatalystFound: false };

test('Fact Pack rejects a public resistance without deterministic evidence', () => {
  const result = buildFactPack({ candidate, technicalContext: {
    market: { range24h: { id: 'market:24h-range', low: 1, high: 2, currentPrice: 1.25 } },
    levels: { supports: [], resistances: [{ id: 'level:resistance:1', side: 'resistance', midpoint: 1.5, evidence: [] }] },
    technicalEvents: [], publicLevelIds: ['level:resistance:1'],
  }, research, priorTokenState: null });
  assert.deepEqual(result, { ok: false, reason: 'FACT_PACK_INVALID_LEVEL_EVIDENCE' });
});

test('Fact Pack makes only evidence-backed levels and canonical claim displays public', () => {
  const result = buildFactPack({ candidate, technicalContext: {
    market: { range24h: { id: 'market:24h-range', low: 1, high: 2, currentPrice: 1.25 } },
    levels: { supports: [], resistances: [{ id: 'level:resistance:1', side: 'resistance', midpoint: 1.5, evidence: [{ candleOpenTime: 1, kind: 'swing_high', timeframe: '1h' }] }] },
    technicalEvents: [], publicLevelIds: ['level:resistance:1'],
  }, research, priorTokenState: null });
  assert.equal(result.ok, true);
  assert.equal(result.factPack.factsById['claim:return24h'].display, '+22.50%');
  assert.equal(result.factPack.factsById['level:resistance:1'].midpoint, 1.5);
  assert.equal(Object.isFrozen(result.factPack), true);
});

test('Fact Pack carries a deterministic TraderEvidenceMap with non-interchangeable level roles', () => {
  const support = { id: 'level:support:reaction', side: 'support', midpoint: 1.2, priceLow: 1.19, priceHigh: 1.21, evidence: [{ kind: 'swing_low', timeframe: '1h' }] };
  const invalidation = { id: 'level:support:invalidation', side: 'support', midpoint: 1.1, priceLow: 1.09, priceHigh: 1.11, evidence: [{ kind: 'swing_low', timeframe: '4h' }] };
  const watch = { id: 'level:resistance:watch', side: 'resistance', midpoint: 1.5, priceLow: 1.49, priceHigh: 1.51, evidence: [{ kind: '24h_high', timeframe: '24h' }] };
  const result = buildFactPack({ candidate, technicalContext: {
    market: { range24h: { id: 'market:24h-range', low: 1, high: 1.5, currentPrice: 1.25 } },
    levels: { supports: [support, invalidation], resistances: [watch] },
    evidence: {
      structure: { '1h': { timeframe: '1h', direction: 'up', returnPct: 4 } },
      roles: {
        firstReactionZone: { role: 'first_reaction_zone', levelId: support.id, why: 'Nearest support is the immediate retest.' },
        structuralInvalidation: { role: 'structural_invalidation', levelId: invalidation.id, why: 'The next lower support ends this structure.' },
        nextWatch: { role: 'next_watch', levelId: watch.id, why: 'The 24h high is the next watch boundary.' },
      },
    },
    technicalEvents: [{ id: 'event:daily_runner', kind: 'daily_runner', timeframe: '24h', evidence: [{ kind: 'ticker_change_24h' }] }],
    publicLevelIds: [support.id, invalidation.id, watch.id],
  }, research, priorTokenState: null });

  assert.equal(result.ok, true);
  assert.equal(result.factPack.traderEvidenceMap.firstReactionZone.levelId, support.id);
  assert.equal(result.factPack.traderEvidenceMap.structuralInvalidation.levelId, invalidation.id);
  assert.equal(result.factPack.traderEvidenceMap.nextWatch.levelId, watch.id);
  assert.notEqual(result.factPack.traderEvidenceMap.firstReactionZone.levelId, result.factPack.traderEvidenceMap.structuralInvalidation.levelId);
});

test('Fact Pack preserves rich deterministic market evidence without promoting it to an ungrounded public claim', () => {
  const level = { id: 'level:support:rich', side: 'support', midpoint: 1.2, priceLow: 1.19, priceHigh: 1.21, evidence: [{ kind: 'swing_low', timeframe: '1h' }], zoneLow: 1.19, zoneHigh: 1.21, strengthScore: 31, confidence: 'high' };
  const result = buildFactPack({ candidate: { ...candidate, orderBookEvidence: [{ id: 'depth:bid:1.2', observations: 3, price: 1.2 }] }, technicalContext: {
    market: { range24h: { id: 'market:24h-range', low: 1, high: 2, currentPrice: 1.25 }, volatility: { atr14: 0.04, atr14Pct: 3.2 }, distanceFrom24hLowPct: 25 },
    levels: { supports: [level], resistances: [] },
    evidence: { structure: { '1h': { direction: 'up', phase: 'impulse' } }, roles: {}, momentum: { state: 'accelerating' }, volume: { trend: 'expanding' }, takerFlow: { bias: 'buy_dominant' } },
    technicalEvents: [], publicLevelIds: [level.id],
  }, research, priorTokenState: null });

  assert.equal(result.ok, true);
  assert.equal(result.factPack.market.volatility.atr14, 0.04);
  assert.equal(result.factPack.technicalEvidence.momentum.state, 'accelerating');
  assert.equal(result.factPack.technicalEvidence.volume.trend, 'expanding');
  assert.equal(result.factPack.technicalEvidence.takerFlow.bias, 'buy_dominant');
  assert.equal(result.factPack.levels.supports[0].strengthScore, 31);
  assert.equal(result.factPack.numbersAllowed.some((item) => item.key === 'atr14'), false);
  assert.equal(result.factPack.marketEvidence.stableOrderBookClusters[0].observations, 3);
  assert.equal(Object.hasOwn(result.factPack.factsById, 'depth:bid:1.2'), false);
});
