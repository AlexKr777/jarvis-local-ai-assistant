import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CRYPTO_MODES, loadCryptoConfig } from '../src/crypto/config.js';
import { createPipelineFingerprint, PIPELINE_FILES } from '../src/crypto/pipeline-fingerprint.js';
import { CRYPTO_EVENT_TYPES, createCryptoEvent } from '../src/crypto/event-types.js';
import { RollingBaseline } from '../src/crypto/market/rolling-baseline.js';
import { buildUniverse } from '../src/crypto/market/universe.js';
import { evaluatePreliminaryTrigger } from '../src/crypto/market/triggers.js';
import { scoreCandidate, scoreThresholdForSlots } from '../src/crypto/scoring/anomaly-score.js';
import { detectConflict } from '../src/crypto/scoring/conflict-detector.js';
import { CandidatePool, evaluatePublicationEligibility } from '../src/crypto/scoring/candidate-pool.js';
import { CryptoStateStore } from '../src/crypto/storage/state-store.js';
import { CryptoEventStore } from '../src/crypto/storage/event-store.js';

const HOUR = 60 * 60 * 1_000;
const MINUTE = 60 * 1_000;

test('crypto config is fail-safe and never accepts unknown modes', () => {
  assert.deepEqual(CRYPTO_MODES, ['OFF', 'DRY_RUN', 'AUTO']);
  assert.equal(loadCryptoConfig({}).mode, 'DRY_RUN');
  assert.equal(loadCryptoConfig({ JARVIS_CRYPTO_MODE: 'off' }).mode, 'OFF');
  assert.equal(loadCryptoConfig({ JARVIS_CRYPTO_MODE: 'ship-it' }).mode, 'DRY_RUN');
  assert.equal(loadCryptoConfig({}).maxPosts24h, 10);
  assert.equal(loadCryptoConfig({}).writerProvider, 'ollama');
  assert.equal(loadCryptoConfig({}).ollamaCryptoModel, 'gemma4:12b-it-q4_K_M');
  assert.equal(loadCryptoConfig({}).ollamaBaseUrl, 'http://127.0.0.1:11434');
  const anymodel = loadCryptoConfig({
    JARVIS_CRYPTO_WRITER_PROVIDER: 'anymodel',
    ANYMODEL_API_KEY: 'test-key',
  });
  assert.equal(anymodel.writerProvider, 'anymodel');
  assert.equal(anymodel.anymodelModel, 'kmc/k3');
  assert.equal(anymodel.anymodelBaseUrl, 'https://anymodel.org/v1');
  assert.equal(anymodel.anymodelApiKey, 'test-key');
  assert.equal(loadCryptoConfig({ JARVIS_CRYPTO_CAPTURE_ANYMODEL_RESPONSE: '1' }).anymodelCaptureResponseDiagnostics, true);
  assert.equal(loadCryptoConfig({}).anymodelCaptureResponseDiagnostics, false);
  assert.equal(loadCryptoConfig({ JARVIS_CRYPTO_MAX_POSTS_24H: '99' }).maxPosts24h, 10);
  assert.equal(loadCryptoConfig({ JARVIS_CRYPTO_DEEP_ANALYSIS_CONCURRENCY: '1' }).deepAnalysisConcurrency, 1);
  assert.equal(loadCryptoConfig({}).topRunnerMode, true);
  assert.equal(loadCryptoConfig({}).requireScoreForLiveRunner, false);
  assert.equal(loadCryptoConfig({ JARVIS_CRYPTO_REQUIRE_SCORE_FOR_LIVE_RUNNER: 'false' }).requireScoreForLiveRunner, false);
});

test('pipeline fingerprint changes when a publication-relevant config value changes', () => {
  const root = process.cwd();
  const base = loadCryptoConfig({ JARVIS_CRYPTO_MAX_POSTS_24H: '3' }, root);
  const changed = loadCryptoConfig({ JARVIS_CRYPTO_MAX_POSTS_24H: '4' }, root);
  assert.notEqual(createPipelineFingerprint({ projectRoot: root, config: base }), createPipelineFingerprint({ projectRoot: root, config: changed }));
  const runnerModeChanged = loadCryptoConfig({ JARVIS_CRYPTO_MAX_POSTS_24H: '3', JARVIS_CRYPTO_TOP_RUNNER_MODE: 'false' }, root);
  assert.notEqual(createPipelineFingerprint({ projectRoot: root, config: base }), createPipelineFingerprint({ projectRoot: root, config: runnerModeChanged }));
});

test('pipeline fingerprint covers both switchable editorial writers and execution safety code', () => {
  for (const required of [
    'src/crypto/content/ollama-writer.js',
    'src/crypto/content/anymodel-writer.js',
    'src/app-server-client.js',
    'src/jarvis-session.js',
  ]) assert.ok(PIPELINE_FILES.includes(required), `${required} must invalidate readiness when changed`);
});

test('the active Crypto runtime selects an explicit local or AnyModel editorial writer without Codex bridge runtime', async () => {
  const source = await readFile(new URL('../src/crypto/create-runtime.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ OllamaCryptoWriter \} from '\.\/content\/ollama-writer\.js';/);
  assert.match(source, /import \{ AnyModelCryptoWriter \} from '\.\/content\/anymodel-writer\.js';/);
  assert.match(source, /config\.writerProvider === 'anymodel'/);
  assert.match(source, /new AnyModelCryptoWriter\(/);
  assert.match(source, /new OllamaCryptoWriter\(/);
  assert.doesNotMatch(source, /OpenRouterCryptoWriter|OPENROUTER_API_KEY|Codex.*writer/i);
});

test('writer availability diagnostics use the active provider rather than labeling AnyModel as Ollama', async () => {
  const source = await readFile(new URL('../src/crypto/runtime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /#invalidateWriterReadiness\('ollama_unavailable'\)/);
  assert.match(source, /this\.writer\?\.status\?\.\(\)\.provider/);
  assert.match(source, /ANYMODEL_API_KEY_MISSING/);
});

test('scanner events use a typed stable envelope instead of fake user messages', () => {
  assert.ok(CRYPTO_EVENT_TYPES.includes('candidate_selected'));
  assert.ok(CRYPTO_EVENT_TYPES.includes('publish_failed_upload_recovered'));
  assert.ok(CRYPTO_EVENT_TYPES.includes('publish_failed_upload_resolved'));
  const event = createCryptoEvent('candidate_selected', { symbol: 'BTCUSDT' }, {
    eventId: 'evt-1', occurredAt: '2026-08-20T10:00:00.000Z', source: 'binance-usdm',
  });
  assert.deepEqual(event, {
    eventId: 'evt-1',
    type: 'candidate_selected',
    occurredAt: '2026-08-20T10:00:00.000Z',
    source: 'binance-usdm',
    schemaVersion: 1,
    payload: { symbol: 'BTCUSDT' },
  });
  assert.throws(() => createCryptoEvent('user_message', {}), /Unsupported crypto event type/);
  const threaded = createCryptoEvent('post_preview_ready', { candidateId: 'c1' }, { threadId: 'crypto-thread' });
  assert.equal(threaded.threadId, 'crypto-thread');
});

test('event store reads a bounded recent history and keeps secrets redacted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-events-'));
  const store = new CryptoEventStore({ directory });
  await store.append(createCryptoEvent('candidate_selected', { symbol: 'BTCUSDT', apiKey: 'must-not-leak' }, {
    eventId: 'one', occurredAt: '2026-08-19T10:00:00.000Z', threadId: 'crypto-thread',
  }));
  await store.append(createCryptoEvent('publish_completed', { symbol: 'BTCUSDT' }, {
    eventId: 'two', occurredAt: '2026-08-20T10:00:00.000Z', threadId: 'crypto-thread',
  }));

  const events = await store.listRecent({ limit: 1 });

  assert.deepEqual(events.map((event) => event.eventId), ['two']);
  assert.deepEqual((await store.listRecent({ limit: 1, types: ['candidate_selected'] })).map((event) => event.eventId), ['one']);
  assert.doesNotMatch(JSON.stringify(await store.listRecent({ limit: 10 })), /must-not-leak|apiKey/);
});

test('event store reports malformed JSONL lines and writes a secret-free quarantine record', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-corrupt-events-'));
  await writeFile(path.join(directory, '2026-08-20.jsonl'), '{"eventId":"valid","type":"candidate_selected","occurredAt":"2026-08-20T00:00:00.000Z"}\n\0bad secret=do-not-copy\n');
  const store = new CryptoEventStore({ directory });
  const audit = await store.auditRecent();
  assert.equal(audit.malformedLines, 1);
  assert.equal(audit.diagnostics[0].line, 2);
  const quarantine = await readFile(path.join(directory, 'quarantine', '2026-08-20.bad-lines.jsonl'), 'utf8');
  assert.match(quarantine, /malformed_event_line/);
  assert.doesNotMatch(quarantine, /do-not-copy/);
});

test('rolling baseline keeps a bounded window and calculates robust medians', () => {
  const baseline = new RollingBaseline({ windowMs: 6 * HOUR, maxSamples: 10 });
  for (let index = 0; index < 7; index += 1) {
    baseline.add('BTCUSDT', {
      occurredAt: index * HOUR,
      absReturn5mPct: index + 1,
      absReturn15mPct: (index + 1) * 2,
      volume5mUsd: (index + 1) * 100,
      volume15mUsd: (index + 1) * 300,
      liquidationUsd: (index + 1) * 10,
      spreadPct: 0.05,
    });
  }
  const summary = baseline.summary('BTCUSDT', 6 * HOUR);
  assert.equal(summary.sampleCount, 7);
  assert.equal(summary.medianAbsReturn5mPct, 4);
  assert.equal(summary.medianVolume5mUsd, 400);
  baseline.add('BTCUSDT', { occurredAt: 13 * HOUR, absReturn5mPct: 2 });
  assert.equal(baseline.summary('BTCUSDT', 13 * HOUR).sampleCount, 1);
});

test('universe only admits clean active USD-M perpetual contracts', () => {
  const exchangeInfo = {
    symbols: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: 0, filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.00000100' }] },
      { symbol: 'USDCUSDT', baseAsset: 'USDC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: 0 },
      { symbol: 'BTCUPUSDT', baseAsset: 'BTCUP', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: 0 },
      { symbol: 'ETHUSDT_260925', baseAsset: 'ETH', quoteAsset: 'USDT', contractType: 'CURRENT_QUARTER', status: 'TRADING', onboardDate: 0 },
      { symbol: 'BAD-USDT', baseAsset: 'BAD-', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: 0 },
    ],
  };
  const ticker = [{ symbol: 'BTCUSDT', quoteVolume: '25000000' }];
  const universe = buildUniverse(exchangeInfo, ticker, { now: 8 * HOUR, baselineHoursBySymbol: { BTCUSDT: 8 } });
  assert.deepEqual(universe.map((item) => item.symbol), ['BTCUSDT']);
  assert.equal(universe[0].cashtag, '$BTC');
  assert.equal(universe[0].tickSize, 0.000001);
  assert.equal(universe[0].autoEligible, true);
});

test('new listings and thin contracts are monitor-only', () => {
  const exchangeInfo = { symbols: [
    { symbol: 'NEWUSDT', baseAsset: 'NEW', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: 7 * HOUR },
    { symbol: 'THINUSDT', baseAsset: 'THIN', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: 0 },
  ] };
  const ticker = [
    { symbol: 'NEWUSDT', quoteVolume: '50000000' },
    { symbol: 'THINUSDT', quoteVolume: '9999999' },
  ];
  const universe = buildUniverse(exchangeInfo, ticker, { now: 8 * HOUR, baselineHoursBySymbol: { NEWUSDT: 1, THINUSDT: 8 } });
  assert.deepEqual(universe.map(({ symbol, autoEligible, reason }) => ({ symbol, autoEligible, reason })), [
    { symbol: 'NEWUSDT', autoEligible: false, reason: 'baseline_under_6h' },
    { symbol: 'THINUSDT', autoEligible: false, reason: 'quote_volume_under_10m' },
  ]);
});

test('preliminary trigger applies dynamic noise floors and compound anomalies', () => {
  const baseline = {
    medianAbsReturn5mPct: 0.1,
    medianAbsReturn15mPct: 0.25,
    medianVolume5mUsd: 1_000_000,
    medianVolume15mUsd: 3_000_000,
    medianLiquidationUsd: 50_000,
    medianSpreadPct: 0.05,
  };
  const quiet = evaluatePreliminaryTrigger({ return5mPct: 0.3, return15mPct: 0.6, volume5mUsd: 2_000_000, liquidationUsd: 100_000, spreadPct: 0.05 }, baseline);
  assert.equal(quiet.triggered, false);
  const price = evaluatePreliminaryTrigger({ return5mPct: 0.41, return15mPct: 0.6, volume5mUsd: 1_000_000, liquidationUsd: 50_000, spreadPct: 0.05 }, baseline);
  assert.equal(price.triggered, true);
  assert.ok(price.reasons.includes('price_5m'));
  const compound = evaluatePreliminaryTrigger({ return5mPct: 0.3, return15mPct: 0.6, volume5mUsd: 4_100_000, volume15mUsd: 9_100_000, liquidationUsd: 210_000, spreadPct: 0.05 }, baseline);
  assert.equal(compound.triggered, true);
  assert.ok(compound.reasons.includes('compound_anomaly'));
});

test('anomaly score is code-owned, bounded, and publication threshold stays at 75 until the cap', () => {
  const result = scoreCandidate({
    priceSurprise: 5,
    volumeSurprise: 5,
    derivativesStrength: 0.9,
    crossMarketStrength: 0.8,
    quoteVolumeUsd: 50_000_000,
    spreadPct: 0.08,
    ageMinutes: 2,
    storyStrength: 0.9,
    broadMarketShare: 0.1,
    repeatedHook: false,
  });
  assert.equal(result.score, 85);
  assert.deepEqual(result.components, { price: 20, volume: 15, derivatives: 18, crossMarket: 8, tradability: 10, freshness: 8, story: 6, penalties: 0 });
  assert.equal(scoreThresholdForSlots(1), 75);
  assert.equal(scoreThresholdForSlots(5, { maxPosts24h: 10 }), 75);
  assert.equal(scoreThresholdForSlots(9, { maxPosts24h: 10 }), 75);
  assert.equal(scoreThresholdForSlots(10, { maxPosts24h: 10 }), Infinity);
});

test('A/B framing is a code-derived gate at confidence 0.82 and calibrated below 0.90', () => {
  assert.deepEqual(detectConflict({ hypotheses: [{ id: 'A', support: 0.8 }, { id: 'B', support: 0.78 }] }), {
    allowed: false, confidence: 0.8, verdictStyle: 'none', options: [],
  });
  assert.deepEqual(detectConflict({ hypotheses: [{ id: 'A', support: 0.87 }, { id: 'B', support: 0.84 }] }), {
    allowed: true, confidence: 0.87, verdictStyle: 'calibrated', options: ['A', 'B'],
  });
  assert.equal(detectConflict({ hypotheses: [{ id: 'A', support: 0.94 }, { id: 'B', support: 0.9 }] }).verdictStyle, 'hard');
});

test('publication policy enforces the 10-post cap, a constant threshold, and the stored 30–35 minute gap', () => {
  const now = Date.UTC(2026, 7, 20, 12);
  const candidate = { token: 'BTC', score: 90, occurredAt: now, fingerprint: 'x' };
  assert.equal(evaluatePublicationEligibility(candidate, { posts: [] }, now).eligible, true);
  const recentSameToken = { posts: [{ token: 'BTC', publishedAt: now - HOUR, fingerprint: 'old' }] };
  assert.equal(evaluatePublicationEligibility(candidate, recentSameToken, now).reason, 'same_token_cooldown');
  const urgent = { ...candidate, score: 96, token: 'ETH' };
  const recentGlobal = { posts: [{ token: 'SOL', publishedAt: now - 20 * MINUTE, nextEligibleAt: now + 13 * MINUTE }] };
  assert.equal(evaluatePublicationEligibility(urgent, recentGlobal, now).reason, 'global_cooldown');
  assert.equal(evaluatePublicationEligibility({ ...candidate, token: 'NEW', score: 75 }, recentGlobal, now + 13 * MINUTE).eligible, true);
  assert.equal(evaluatePublicationEligibility({ ...candidate, token: 'NEW', score: 74 }, { posts: [] }, now).reason, 'score_below_threshold');
  const tenPosts = { posts: Array.from({ length: 10 }, (_, index) => ({ token: `T${index}`, publishedAt: now - (index + 1) * HOUR })) };
  const ninePosts = { posts: tenPosts.posts.slice(0, 9) };
  assert.equal(evaluatePublicationEligibility({ ...urgent, token: 'NEW' }, ninePosts, now, { maxPosts24h: 10 }).eligible, true);
  assert.equal(evaluatePublicationEligibility({ ...urgent, token: 'NEW' }, tenPosts, now, { maxPosts24h: 10 }).reason, 'rolling_24h_cap');
  const manuallyReset = { ...tenPosts, postLimitResetAt: now - MINUTE };
  assert.equal(evaluatePublicationEligibility({ ...urgent, token: 'NEW' }, manuallyReset, now, { maxPosts24h: 10 }).eligible, true);
});

test('publication policy allows only two verified continuations after two hours for one token in a day', () => {
  const now = Date.UTC(2026, 7, 20, 12);
  const continuation = {
    token: 'BTR', score: 80, occurredAt: now, fingerprint: 'next', direction: 'up',
    metrics: { close: 110, return15mPct: 1.2 },
  };
  const firstPost = { token: 'BTR', publishedAt: now - 121 * MINUTE, entryPrice: 100 };
  const secondPost = { token: 'BTR', publishedAt: now - 2 * HOUR, entryPrice: 105 };

  assert.equal(evaluatePublicationEligibility(continuation, { posts: [firstPost] }, now).postNumber, 2);
  assert.equal(evaluatePublicationEligibility(continuation, { posts: [secondPost, firstPost] }, now).postNumber, 3);
  assert.equal(evaluatePublicationEligibility(continuation, { posts: [secondPost, firstPost, { token: 'BTR', publishedAt: now - 3 * HOUR, entryPrice: 102 }] }, now).reason, 'same_token_daily_cap');
  assert.equal(evaluatePublicationEligibility(continuation, { posts: [{ ...firstPost, publishedAt: now - 119 * MINUTE }] }, now).reason, 'follow_up_cooldown');
  assert.equal(evaluatePublicationEligibility({ ...continuation, metrics: { close: 99, return15mPct: 1.2 } }, { posts: [firstPost] }, now).reason, 'follow_up_not_holding');
});

test('candidate pool waits for competition window and chooses score/confidence/liquidity/freshness', () => {
  const pool = new CandidatePool({ competitionWindowMs: 10 * MINUTE });
  const start = Date.UTC(2026, 7, 20, 12);
  pool.add({ id: 'a', score: 90, confidence: 0.9, quoteVolumeUsd: 20_000_000, occurredAt: start });
  pool.add({ id: 'b', score: 92, confidence: 0.83, quoteVolumeUsd: 40_000_000, occurredAt: start + MINUTE });
  assert.equal(pool.select(start + 9 * MINUTE), null);
  assert.equal(pool.select(start + 10 * MINUTE).id, 'b');
  assert.equal(pool.size, 0);
});

test('candidate pool gives an equally scored fresh upside impulse priority without excluding a smooth runner', () => {
  const start = Date.UTC(2026, 7, 20, 12);
  const pool = new CandidatePool({ competitionWindowMs: 0 });
  pool.add({ id: 'smooth', score: 88, confidence: 0.96, quoteVolumeUsd: 60_000_000, occurredAt: start, visualImpulsePriority: 0 });
  pool.add({ id: 'impulse', score: 88, confidence: 0.81, quoteVolumeUsd: 20_000_000, occurredAt: start + MINUTE, visualImpulsePriority: 1 });
  assert.equal(pool.select(start).id, 'impulse');

  const soloPool = new CandidatePool({ competitionWindowMs: 0 });
  soloPool.add({ id: 'smooth-alone', score: 88, confidence: 0.96, quoteVolumeUsd: 60_000_000, occurredAt: start, visualImpulsePriority: 0 });
  assert.equal(soloPool.select(start).id, 'smooth-alone');

  const higherScorePool = new CandidatePool({ competitionWindowMs: 0 });
  higherScorePool.add({ id: 'higher-score-smooth', score: 89, confidence: 0.8, quoteVolumeUsd: 20_000_000, occurredAt: start, visualImpulsePriority: 0 });
  higherScorePool.add({ id: 'lower-score-impulse', score: 88, confidence: 0.99, quoteVolumeUsd: 60_000_000, occurredAt: start + MINUTE, visualImpulsePriority: 1 });
  assert.equal(higherScorePool.select(start).id, 'higher-score-smooth');
});

test('candidate pool ranks a fresh top 24h gainer ahead of a lower-ranked score competitor', () => {
  const pool = new CandidatePool({ competitionWindowMs: 0 });
  const start = Date.UTC(2026, 7, 20, 12);
  pool.add({ id: 'lower-24h', score: 92, confidence: 0.9, quoteVolumeUsd: 80_000_000, occurredAt: start, priceChange24hPct: 18, visualImpulsePriority: 1 });
  pool.add({ id: 'top-24h', score: 88, confidence: 0.8, quoteVolumeUsd: 20_000_000, occurredAt: start, priceChange24hPct: 40, visualImpulsePriority: 1 });

  assert.deepEqual(pool.selectRanked(start).map((candidate) => candidate.id), ['top-24h', 'lower-24h']);
});

test('crypto state persists mode, thread, pending intent and restart-safe history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-state-'));
  const filePath = path.join(directory, 'state.json');
  const store = new CryptoStateStore({ filePath });
  const initial = await store.load();
  assert.equal(initial.mode, 'DRY_RUN');
  await store.update((state) => ({
    ...state,
    mode: 'OFF',
    cryptoThreadId: 'thread-1',
    pendingPublish: { id: 'intent-1' },
    posts: [{ token: 'BTC', publishedAt: 1 }],
  }));
  const restarted = new CryptoStateStore({ filePath });
  assert.deepEqual(await restarted.load(), {
    version: 3,
    mode: 'OFF',
    cryptoThreadId: 'thread-1',
    pendingPublish: { id: 'intent-1' },
    posts: [{ token: 'BTC', publishedAt: 1 }],
    dryRunVerifiedAt: null,
    autoReady: false,
    autoArmed: false,
    manualAutoOverride: false,
    autoArm: null,
    codexHealth: { status: 'unknown', checkedAt: null, reason: null },
    fingerprints: [],
    tokenLastAnalyzedAt: {},
    learning: { samples: 0, adjustments: {} },
    pendingCandidates: [],
    editorialHistory: [],
    tokenNarratives: {},
    recovery: { status: 'ready', reason: null, migratedFrom: null },
  });
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /OPENAI_API_KEY/);
});

test('corrupt or future crypto state fails closed without enabling AUTO', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-corrupt-'));
  const corruptPath = path.join(directory, 'state.json');
  await writeFile(corruptPath, '{not-json', 'utf8');
  const corrupt = await new CryptoStateStore({ filePath: corruptPath }).load();
  assert.equal(corrupt.mode, 'OFF');
  assert.equal(corrupt.autoReady, false);
  assert.deepEqual(corrupt.recovery, { status: 'blocked', reason: 'corrupt_state', migratedFrom: null });

  const futurePath = path.join(directory, 'future.json');
  await writeFile(futurePath, JSON.stringify({ version: 999, mode: 'AUTO', autoReady: true }), 'utf8');
  const future = await new CryptoStateStore({ filePath: futurePath }).load();
  assert.equal(future.mode, 'OFF');
  assert.equal(future.recovery.reason, 'unsupported_state_version');
});
