import test from 'node:test';
import assert from 'node:assert/strict';

import { runLivePublicDryRun } from '../src/crypto/live-dry-run.js';

const TEST_NOW = 1_724_155_200_000;

function candles(count = 180) {
  const baseTime = TEST_NOW - count * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const base = 60_000 + index * 4;
    const oldJump = index >= 90 && index < 96 ? (index - 89) * 400 : 0;
    const recentJump = index >= 165 && index < 171 ? (index - 164) * 120 : 0;
    const jump = oldJump + recentJump;
    const close = base + jump;
    return {
      openTime: baseTime + index * 60_000,
      open: base,
      high: close + 20,
      low: base - 20,
      close,
      closeTime: baseTime + index * 60_000 + 59_999,
      quoteVolume: (oldJump || recentJump) ? 8_000_000 : 500_000,
    };
  });
}

function client() {
  return {
    getExchangeInfo: async () => ({ symbols: [
      { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'USDT' },
      { symbol: 'ETHUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'ETH', quoteAsset: 'USDT' },
    ] }),
    get24hTickers: async () => [
      { symbol: 'BTCUSDT', quoteVolume: '45000000000' },
      { symbol: 'ETHUSDT', quoteVolume: '19000000000' },
    ],
    getKlines: async (symbol) => candles(symbol === 'BTCUSDT' ? 180 : 181),
  };
}

test('live DRY_RUN uses current public Binance facts and completes a non-publishing full pipeline', async () => {
  let selected;
  const result = await runLivePublicDryRun({
    client: client(),
    clock: () => TEST_NOW,
    executeCandidate: async (candidate) => {
      selected = candidate;
      return { status: 'preview', published: false, candidateId: candidate.id, preview: { postText: 'validated', chartPath: 'private-path.png' } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.checks.fullPipeline, true);
  assert.equal(result.checks.noPublishing, true);
  assert.equal(result.pipeline.status, 'preview');
  assert.doesNotMatch(JSON.stringify(result), /private-path|chartPath/);
  assert.equal(selected.livePublicData, true);
  assert.equal(selected.readinessOnly, true);
  assert.equal(selected.validationForcedCandidate, true);
  assert.equal(selected.productionEligible, false);
  assert.equal(selected.cashtag, '$BTC');
  assert.equal(selected.scoreSource, 'deterministic-code');
  assert.ok(selected.score >= 0 && selected.score <= 100);
  assert.ok(selected.score < 96);
  assert.ok(selected.scoreComponents && typeof selected.scoreComponents === 'object');
  assert.ok(TEST_NOW - selected.occurredAt <= 45 * 60_000);
  assert.ok(selected.metrics.candles.length >= 61);
  assert.ok(selected.claimsAllowed.every((claim) => Number.isFinite(claim.value)));
});

test('live DRY_RUN uses the deep-analyzer candidate when the runtime provides one', async () => {
  let deepCalls = 0;
  let selected;
  await runLivePublicDryRun({
    client: client(),
    clock: () => TEST_NOW,
    deepAnalyzer: { analyze: async (item, preliminary) => {
      deepCalls += 1;
      assert.equal(item.symbol, 'BTCUSDT');
      assert.equal(item.baseAsset, 'BTC');
      assert.equal(item.quoteAsset, 'USDT');
      assert.equal(preliminary.reasons[0], 'live_readiness');
      return {
        id: 'deep-candidate', symbol: item.symbol, token: 'BTC', score: 91, confidence: 0.9,
        direction: 'up', quoteVolumeUsd: item.quoteVolumeUsd, spreadPct: 0.05, conflict: { allowed: false, verdictStyle: 'none', options: [] },
        claimsAllowed: [{ key: 'return5m', value: 1, display: '+1.00%', timeframe: '5m' }], metrics: { candles: candles(121), close: 1, return5mPct: 1 },
      };
    } },
    executeCandidate: async (candidate) => { selected = candidate; return { status: 'preview', published: false }; },
  });
  assert.equal(deepCalls, 1);
  assert.equal(selected.id, 'deep-candidate');
  assert.equal(selected.readinessOnly, true);
  assert.equal(selected.livePublicData, true);
  assert.equal(selected.validationForcedCandidate, true);
  assert.equal(selected.productionEligible, false);
  assert.equal(selected.baseAsset, 'BTC');
  assert.equal(selected.quoteAsset, 'USDT');
  assert.equal(selected.cashtag, '$BTC');
});

test('live DRY_RUN can execute several distinct daily top-ten candidates without publishing', async () => {
  const selected = [];
  const result = await runLivePublicDryRun({
    client: client(),
    clock: () => TEST_NOW,
    maxCandidates: 2,
    deepAnalyzer: { analyze: async (item) => ({
      id: `deep-${item.symbol}`, symbol: item.symbol, token: item.baseAsset, score: 80, confidence: 1, direction: 'up',
      claimsAllowed: [{ key: 'return5m', value: 1, display: '+1.00%', timeframe: '5m' }], metrics: { candles: candles(121), close: 1 },
    }) },
    executeCandidate: async (candidate) => { selected.push(candidate.symbol); return { status: 'preview', published: false, candidateId: candidate.id }; },
  });
  assert.equal(result.checks.completedCandidates, 2);
  assert.deepEqual(selected, ['BTCUSDT', 'ETHUSDT']);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((item) => item.pipeline.published === false));
});

test('live DRY_RUN records one writer transport failure and continues with later top-ten candidates', async () => {
  const selected = [];
  const result = await runLivePublicDryRun({
    client: client(),
    clock: () => TEST_NOW,
    maxCandidates: 2,
    executeCandidate: async (candidate) => {
      selected.push(candidate.symbol);
      if (candidate.symbol === 'BTCUSDT') {
        const error = new Error('provider unavailable');
        error.code = 'ANYMODEL_UNAVAILABLE';
        throw error;
      }
      return { status: 'preview', published: false, candidateId: candidate.id };
    },
  });

  assert.deepEqual(selected, ['BTCUSDT', 'ETHUSDT']);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].result, 'WRITER_UNAVAILABLE');
  assert.equal(result.candidates[1].result, 'PUBLISHABLE_PREVIEW');
  assert.equal(result.result, 'PUBLISHABLE_PREVIEW');
  assert.equal(result.checks.completedCandidates, 2);
  assert.equal(result.checks.fullPipeline, false);
  assert.equal(result.ok, false);
  assert.equal(result.candidates[0].pipeline.published, false);
});

test('live DRY_RUN stops after a permanent writer quota block without attempting later top-ten candidates', async () => {
  const selected = [];
  const result = await runLivePublicDryRun({
    client: client(),
    clock: () => TEST_NOW,
    maxCandidates: 2,
    executeCandidate: async (candidate) => {
      selected.push(candidate.symbol);
      const error = new Error('provider quota exhausted');
      error.code = 'ANYMODEL_QUOTA_EXHAUSTED';
      throw error;
    },
  });

  assert.deepEqual(selected, ['BTCUSDT']);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.result, 'WRITER_UNAVAILABLE');
  assert.equal(result.checks.writerBlocked, true);
  assert.deepEqual(result.checks.writerBlock, { code: 'ANYMODEL_QUOTA_EXHAUSTED' });
  assert.equal(result.checks.fullPipeline, false);
  assert.equal(result.ok, false);
  assert.equal(result.candidates[0].pipeline.published, false);
});

test('live DRY_RUN preserves completed previews and reports a later Binance REST block without publishing', async () => {
  const selected = [];
  let deepCalls = 0;
  const result = await runLivePublicDryRun({
    client: client(),
    clock: () => TEST_NOW,
    maxCandidates: 2,
    deepAnalyzer: { analyze: async (item) => {
      deepCalls += 1;
      if (deepCalls === 2) {
        const error = new Error('Binance REST is globally blocked.');
        error.code = 'BINANCE_REST_BLOCKED';
        error.state = 'COOLDOWN';
        error.blockedUntil = TEST_NOW + 60_000;
        throw error;
      }
      return {
        id: `deep-${item.symbol}`, symbol: item.symbol, token: item.baseAsset, score: 80, confidence: 1, direction: 'up',
        claimsAllowed: [{ key: 'return5m', value: 1, display: '+1.00%', timeframe: '5m' }], metrics: { candles: candles(121), close: 1 },
      };
    } },
    executeCandidate: async (candidate) => {
      selected.push(candidate.symbol);
      return { status: 'preview', published: false, candidateId: candidate.id };
    },
  });

  assert.deepEqual(selected, ['BTCUSDT']);
  assert.equal(result.result, 'PUBLISHABLE_PREVIEW');
  assert.equal(result.checks.completedCandidates, 1);
  assert.equal(result.checks.restBlocked, true);
  assert.equal(result.checks.fullPipeline, false);
  assert.equal(result.ok, false);
  assert.equal(result.candidates[0].pipeline.published, false);
});

test('live DRY_RUN records one transient Binance analysis failure and continues with later top-ten candidates', async () => {
  const selected = [];
  let deepCalls = 0;
  const result = await runLivePublicDryRun({
    client: client(),
    clock: () => TEST_NOW,
    maxCandidates: 2,
    deepAnalyzer: { analyze: async (item) => {
      deepCalls += 1;
      if (deepCalls === 1) {
        const error = new Error('Binance public request timed out.');
        error.code = 'BINANCE_TIMEOUT';
        throw error;
      }
      return {
        id: `deep-${item.symbol}`, symbol: item.symbol, token: item.baseAsset, score: 80, confidence: 1, direction: 'up',
        claimsAllowed: [{ key: 'return5m', value: 1, display: '+1.00%', timeframe: '5m' }], metrics: { candles: candles(121), close: 1 },
      };
    } },
    executeCandidate: async (candidate) => {
      selected.push(candidate.symbol);
      return { status: 'preview', published: false, candidateId: candidate.id };
    },
  });

  assert.deepEqual(selected, ['ETHUSDT']);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].result, 'MARKET_DATA_UNAVAILABLE');
  assert.equal(result.candidates[1].result, 'PUBLISHABLE_PREVIEW');
  assert.equal(result.result, 'PUBLISHABLE_PREVIEW');
  assert.equal(result.checks.completedCandidates, 2);
  assert.equal(result.checks.marketDataFailures, 1);
  assert.equal(result.checks.fullPipeline, false);
  assert.equal(result.ok, false);
  assert.ok(result.candidates.every((item) => item.pipeline.published === false));
});

test('live DRY_RUN returns a successful editorial skip instead of throwing a technical failure', async () => {
  const result = await runLivePublicDryRun({
    client: client(),
    clock: () => TEST_NOW,
    executeCandidate: async () => ({ status: 'content_skipped', reason: 'NO_CANDIDATE_WITH_EDITORIAL_MERIT', published: false, candidateId: 'candidate-editorial-skip' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.result, 'EDITORIAL_SKIP');
  assert.equal(result.reason, 'NO_CANDIDATE_WITH_EDITORIAL_MERIT');
  assert.equal(result.wouldPublish, false);
  assert.equal(result.pipeline.status, 'content_skipped');
});

test('live DRY_RUN still fails closed for invalid publishing outcomes', async () => {
  await assert.rejects(
    () => runLivePublicDryRun({ client: client(), clock: () => TEST_NOW, executeCandidate: async () => ({ status: 'published', published: true }) }),
    /full pipeline/i,
  );
});

test('live DRY_RUN rejects incomplete or non-finite public market data before Codex', async () => {
  let calls = 0;
  await assert.rejects(() => runLivePublicDryRun({
    client: { ...client(), getExchangeInfo: async () => ({ symbols: [] }) },
    executeCandidate: async () => { calls += 1; },
  }), /universe verification/i);
  assert.equal(calls, 0);
});
