import test from 'node:test';
import assert from 'node:assert/strict';

import { CryptoRuntime } from '../src/crypto/runtime.js';

class MemoryStateStore {
  constructor(state = {}) {
    this.state = {
      version: 1, mode: 'DRY_RUN', cryptoThreadId: null, pendingPublish: null, posts: [],
      dryRunVerifiedAt: null, autoReady: false, autoArmed: false, manualAutoOverride: false, fingerprints: [], tokenLastAnalyzedAt: {},
      learning: { samples: 0, adjustments: {} }, ...state,
    };
  }
  async load() { return structuredClone(this.state); }
  async update(updater) { this.state = await updater(structuredClone(this.state)); return structuredClone(this.state); }
}

function validCandidate(overrides = {}) {
  return {
    id: 'candidate-1',
    occurredAt: 1_724_155_200_000,
    symbol: 'BTCUSDT', token: 'BTC', cashtag: '$BTC', score: 91, confidence: 0.9,
    quoteVolumeUsd: 50_000_000, spreadPct: 0.05, direction: 'up', livePublicData: true, autoEligible: true, freshRunnerEligible: true,
    conflict: { allowed: false, confidence: 0.8, verdictStyle: 'none', options: [] },
    claimsAllowed: [{ key: 'return5m', value: 2.14, display: '+2.14%' }, { key: 'volumeRatio', value: 5.2, display: '5.2x' }],
    metrics: { close: 100, return5mPct: 2.14, volume5mUsd: 10_000_000, candles: [{ open: 99, high: 101, low: 98, close: 100, quoteVolume: 1 }, { open: 100, high: 103, low: 100, close: 102, quoteVolume: 2 }] },
    ...overrides,
  };
}

const content = {
  decision: 'publish', reason: 'distinctive', cashtag: '$BTC',
  postText: '$BTC moved +2.14% in the last 5 minutes.\n\nVolume reached 5.2x its rolling baseline.\n\nPrice and participation expanded together.\n\nThe next useful evidence is whether activity persists after the first impulse, because fading participation would weaken the move without changing the verified facts.',
  claimsUsed: [{ key: 'return5m', display: '+2.14%' }, { key: 'volumeRatio', display: '5.2x' }],
  visualIntent: { preset: 'volume_shock', relationship: 'none', revealOnOpen: false },
};

function readyEditorial(post = content) {
  return {
    status: 'ready', provider: 'openrouter', model: 'minimax/minimax-m3:free', content: post,
    plan: { storyFamily: 'volume_shock', heroFactType: 'volumeRatio', allowedChartEvidence: ['return5m', 'volumeRatio'] },
    finalStory: {
      storyFamily: 'volume_shock', heroFactType: 'volumeRatio', allowedChartEvidence: ['return5m', 'volumeRatio'],
      heroMetric: { key: 'volumeRatio', display: '5.2x' },
    },
    fingerprint: { storyFamily: 'volume_shock', hookFamily: 'direct_statement' }, marketStoryCluster: 'volume_shock', diversity: { pass: true },
  };
}

function makeRuntime(options = {}) {
  const calls = { writer: 0, writerRequests: [], charts: 0, publishes: 0, recoveries: 0, reviews: [], events: [], starts: 0, stops: 0 };
  const stateStore = options.stateStore || new MemoryStateStore(options.state);
  const jarvis = options.jarvis || {
    executionContext: async () => ({ healthy: true, authMode: 'chatgpt', planType: 'plus', model: 'gpt-5.5', fingerprint: 'current-context' }),
    createThread: async () => ({ id: 'crypto-thread' }),
    renameThread: async () => ({}),
    readThread: async (id) => ({ id }),
  };
  const publisher = options.publisher || {
    recoverPending: async () => { calls.recoveries += 1; return { status: 'clean' }; },
    credentialStatus: async () => ({ configured: true, source: 'environment' }),
    publishPackage: async ({ mode, content: post, chartPath }) => {
      calls.publishes += 1;
      return mode === 'DRY_RUN'
        ? { status: 'preview', published: false, preview: { postText: post.postText, chartPath } }
        : { status: 'published', published: true, id: 'post-1', shareLink: 'link' };
    },
  };
  const runtime = new CryptoRuntime({
    config: { mode: 'DRY_RUN', scannerEnabled: true, competitionWindowMs: 600_000, dataDirectory: 'data/crypto', ...options.config },
    stateStore,
    eventStore: options.eventStore || {
      append: async (event) => { calls.events.push(event); },
      listRecent: async () => [],
    },
    jarvis,
    writer: options.writer || {
      status: () => ({ provider: 'openrouter', model: 'minimax/minimax-m3:free', configured: true, state: 'ready' }),
      generate: async (request) => { calls.writer += 1; calls.writerRequests.push(request); return options.writerResult || readyEditorial(options.writerContent || content); },
    },
    chartRenderer: options.chartRenderer || (async ({ outputPath, candidate }) => { calls.charts += 1; return { path: outputPath, sha256: 'chart-hash', width: 1200, height: 900, labels: [candidate.cashtag, '+2.14%', '5.2x'] }; }),
    publisher,
    scannerController: {
      start: async () => { calls.starts += 1; },
      stop: async () => { calls.stops += 1; },
    },
    reviewPackageWriter: options.reviewPackageWriter || (async (input) => {
      calls.reviews.push(input);
      return { id: 'review-1', path: 'review.json' };
    }),
    liveDryRunRunner: options.liveDryRunRunner || null,
    clock: () => 1_724_155_200_000,
  });
  return { runtime, calls, stateStore, jarvis, publisher };
}

test('initialize creates exactly one persistent Crypto thread and recovers pending state', async () => {
  const renames = [];
  const { runtime, stateStore, calls } = makeRuntime({ jarvis: {
    createThread: async () => ({ id: 'crypto-thread' }),
    renameThread: async (threadId, name) => { renames.push({ threadId, name }); },
  } });
  const status = await runtime.initialize();
  assert.equal(stateStore.state.cryptoThreadId, 'crypto-thread');
  assert.deepEqual(renames, [{ threadId: 'crypto-thread', name: 'Crypto' }]);
  assert.equal(calls.recoveries, 1);
  assert.equal(calls.starts, 1);
  assert.equal(status.threadId, 'crypto-thread');
  await runtime.stop();
  assert.equal(calls.stops, 1);
});

test('restart reuses the persisted Crypto thread instead of creating another', async () => {
  let creates = 0;
  const reads = [];
  const { runtime } = makeRuntime({ state: { cryptoThreadId: 'saved-thread' }, jarvis: {
    createThread: async () => { creates += 1; return { id: 'new-thread' }; },
    renameThread: async () => {},
    readThread: async (id) => { reads.push(id); return { id }; },
  } });
  await runtime.initialize({ startScanner: false });
  assert.equal(creates, 0);
  assert.deepEqual(reads, ['saved-thread']);
  assert.equal((await runtime.status()).threadId, 'saved-thread');
});

test('manual post-limit reset preserves publication history and starts a new 0/10 capacity window', async () => {
  const now = 1_724_155_200_000;
  const posts = Array.from({ length: 10 }, (_, index) => ({
    token: `T${index}`,
    publishedAt: now - (index + 1) * 3_600_000,
  }));
  const { runtime, stateStore, calls } = makeRuntime({ state: { cryptoThreadId: 'crypto-thread', posts } });

  const status = await runtime.resetPostLimit();

  assert.equal(stateStore.state.posts.length, 10);
  assert.equal(stateStore.state.postLimitResetAt, now);
  assert.equal(status.posts24h, 0);
  assert.equal(status.slotsRemaining, 10);
  assert.equal(calls.events.at(-1).type, 'post_limit_reset');
});

test('OFF observations never call the writer, but a top runner is not blocked by a low legacy score', async () => {
  const off = makeRuntime({ state: { mode: 'OFF', cryptoThreadId: 'crypto-thread' } });
  assert.equal((await off.runtime.processCandidate(validCandidate())).status, 'off');
  assert.equal(off.calls.writer, 0);
  const low = makeRuntime({
    state: { mode: 'DRY_RUN', cryptoThreadId: 'crypto-thread' },
    config: { topRunnerMode: true },
  });
  assert.equal((await low.runtime.processCandidate(validCandidate({ score: 1, autoEligible: false }))).status, 'preview');
  assert.equal(low.calls.writer, 1);
  assert.equal(low.calls.charts, 1);
});

test('a verified same-token continuation reaches the Writer after two hours instead of waiting six', async () => {
  const now = 1_724_155_200_000;
  const { runtime, calls } = makeRuntime({ state: {
    cryptoThreadId: 'crypto-thread',
    posts: [{ token: 'BTC', symbol: 'BTCUSDT', publishedAt: now - 121 * 60_000, entryPrice: 90 }],
    tokenLastAnalyzedAt: { BTC: now - 2 * 60 * 60_000 },
    editorialHistory: [{ symbol: 'BTCUSDT', marketStoryCluster: '478932:flat:up:none', text: '$BTC moved first.' }],
  } });

  const result = await runtime.processCandidate(validCandidate({ id: 'continuation-1', fingerprint: 'continuation-fp' }));

  assert.equal(result.status, 'preview');
  assert.equal(calls.writer, 1);
  assert.equal(calls.writerRequests[0].candidate.publicationSequence, 2);
  assert.equal(calls.writerRequests[0].candidate.verifiedContinuation, true);
});

test('a ranked positive daily runner reaches Writer without the retired fresh-impulse gate', async () => {
  const { runtime, calls } = makeRuntime({
    state: { cryptoThreadId: 'crypto-thread' },
    config: { topRunnerMode: true },
  });

  const result = await runtime.processCandidate(validCandidate({
    freshRunnerEligible: false, autoEligible: false, score: 1, priceChange24hPct: 87.26,
  }));

  assert.equal(result.status, 'preview');
  assert.equal(calls.writer, 1);
  assert.equal(calls.charts, 1);
  assert.equal(calls.publishes, 1);
});

test('a fresh live top-ten runner can reach Writer without the anomaly-score threshold when the switch is off', async () => {
  const { runtime, calls } = makeRuntime({
    state: { cryptoThreadId: 'crypto-thread' },
    config: { requireScoreForLiveRunner: false },
  });

  const result = await runtime.processCandidate(validCandidate({ score: 56, priceChange24hPct: 18.4 }));

  assert.equal(result.status, 'preview');
  assert.equal(calls.writer, 1);
  assert.equal(calls.charts, 1);
  assert.equal(calls.publishes, 1);
});

test('a 75-score liquid candidate reaches the existing editorial and factual gates', async () => {
  const { runtime, calls } = makeRuntime({ state: { cryptoThreadId: 'crypto-thread' } });
  const result = await runtime.processCandidate(validCandidate({ score: 75 }));
  assert.equal(result.status, 'preview');
  assert.equal(calls.writer, 1);
  assert.equal(calls.publishes, 1);
});

test('legacy unarmed AUTO is reconciled to DRY_RUN before a candidate can reach a publisher', async () => {
  const { runtime, calls } = makeRuntime({ state: {
    mode: 'AUTO',
    cryptoThreadId: 'crypto-thread',
    autoReady: true,
    dryRunVerifiedAt: 1_724_155_100_000,
  } });

  await runtime.initialize({ startScanner: false });

  const status = await runtime.status();
  assert.equal(status.mode, 'DRY_RUN');
  assert.equal(status.autoArmed, false);
  assert.equal(status.autoArm?.reason, 'missing_or_stale_validation');
  assert.equal((await runtime.processCandidate(validCandidate())).status, 'preview');
  assert.equal(calls.publishes, 1);
});

test('a missing OpenRouter key skips candidates clearly without queueing or a Codex fallback', async () => {
  const { runtime, calls, stateStore } = makeRuntime({
    state: { cryptoThreadId: 'crypto-thread' },
    writer: {
      status: () => ({ provider: 'openrouter', model: 'minimax/minimax-m3:free', configured: false, state: 'missing_key' }),
      generate: async () => { calls.writer += 1; throw Object.assign(new Error('OpenRouter недоступен: OPENROUTER_API_KEY не настроен.'), { code: 'OPENROUTER_NOT_CONFIGURED' }); },
    },
  });
  const first = await runtime.processCandidate(validCandidate());
  const second = await runtime.processCandidate(validCandidate({ id: 'candidate-2', token: 'ETH', cashtag: '$ETH' }));
  assert.equal(first.status, 'content_skipped');
  assert.equal(second.status, 'content_skipped');
  assert.equal(calls.writer, 2);
  assert.equal(calls.publishes, 0);
  assert.equal(stateStore.state.pendingCandidates?.length || 0, 0);
});

test('a stale Codex health flag does not block the independent writer path', async () => {
  const { runtime, stateStore, calls } = makeRuntime({
    state: { cryptoThreadId: 'crypto-thread', codexHealth: { status: 'auth_required', checkedAt: 1, reason: 'old_account' } },
  });
  const result = await runtime.processCandidate(validCandidate());
  assert.equal(result.status, 'preview');
  assert.equal(calls.writer, 1);
  assert.equal(stateStore.state.codexHealth.status, 'auth_required');
});

test('missing old-account thread recovery is single-flight and preserves local Crypto history', async () => {
  let creates = 0;
  const missing = new Error('old account thread not found');
  missing.code = 'NOT_FOUND';
  const { runtime, stateStore, calls } = makeRuntime({
    state: {
      cryptoThreadId: 'old-account-thread',
      posts: [{ id: 'local-post', publishedAt: 1 }],
      editorialHistory: [{ symbol: 'BTC', text: 'local history' }],
      autoReady: true,
      autoArmed: true,
      autoArm: { pipelineFingerprint: 'runtime-unfingerprinted', codexExecutionFingerprint: 'old-context', result: 'live_dry_run_passed' },
    },
    jarvis: {
      executionContext: async () => ({ healthy: true, authMode: 'chatgpt', planType: 'plus', model: 'gpt-5.5', fingerprint: 'current-context' }),
      readThread: async () => { throw missing; },
      createThread: async () => { creates += 1; await Promise.resolve(); return { id: 'current-account-thread' }; },
      renameThread: async () => {},
    },
  });

  const ids = await Promise.all([runtime.ensureCryptoThread(), runtime.ensureCryptoThread(), runtime.ensureCryptoThread()]);
  assert.deepEqual(ids, ['current-account-thread', 'current-account-thread', 'current-account-thread']);
  assert.equal(creates, 1);
  assert.equal(stateStore.state.posts[0].id, 'local-post');
  assert.equal(stateStore.state.editorialHistory[0].text, 'local history');
  assert.equal(stateStore.state.autoReady, true);
  assert.equal(stateStore.state.autoArmed, true);
  assert.equal(calls.publishes, 0);
});

test('an auth failure while checking an old thread fails closed without replacement or readiness', async () => {
  let creates = 0;
  const authError = new Error('401 Unauthorized: token_revoked');
  authError.code = 'AUTH_REQUIRED';
  const { runtime, stateStore, calls } = makeRuntime({
    state: { cryptoThreadId: 'old-thread', autoReady: true, autoArmed: true, autoArm: { pipelineFingerprint: 'runtime-unfingerprinted', codexExecutionFingerprint: 'old-context', result: 'live_dry_run_passed' } },
    jarvis: {
      executionContext: async () => ({ healthy: true, authMode: 'chatgpt', planType: 'plus', model: 'gpt-5.5', fingerprint: 'old-context' }),
      readThread: async () => { throw authError; },
      createThread: async () => { creates += 1; return { id: 'unsafe-replacement' }; },
      renameThread: async () => {},
    },
  });

  await assert.rejects(runtime.ensureCryptoThread(), (error) => error.code === 'AUTH_REQUIRED');
  assert.equal(creates, 0);
  assert.equal(stateStore.state.autoReady, true);
  assert.equal(stateStore.state.autoArmed, true);
  assert.equal(calls.publishes, 0);
});

test('does not depend on a changing Codex execution context while the writer is running', async () => {
  let fingerprint = 'context-before';
  const { runtime, stateStore, calls } = makeRuntime({
    state: { cryptoThreadId: 'crypto-thread', autoReady: true },
    jarvis: {
      executionContext: async () => ({ healthy: true, authMode: 'chatgpt', planType: 'plus', model: 'gpt-5.5', fingerprint }),
      readThread: async (id) => ({ id }),
      createThread: async () => ({ id: 'replacement' }),
      renameThread: async () => {},
    },
    writer: {
      status: () => ({ provider: 'openrouter', model: 'minimax/minimax-m3:free', configured: true, state: 'ready' }),
      generate: async () => { calls.writer += 1; fingerprint = 'context-after'; return readyEditorial(); },
    },
  });

  const result = await runtime.processCandidate(validCandidate());
  assert.equal(result.status, 'preview');
  assert.equal(calls.writer, 1);
  assert.equal(calls.charts, 1);
  assert.equal(calls.publishes, 1);
  assert.equal(stateStore.state.autoReady, true);
});

test('an unavailable OpenRouter writer stops before chart and publisher', async () => {
  const unavailable = Object.assign(new Error('OpenRouter writer unavailable.'), { code: 'OPENROUTER_PROVIDER_UNAVAILABLE' });
  const { runtime, stateStore, calls } = makeRuntime({
    state: { cryptoThreadId: 'crypto-thread', autoReady: true },
    writer: {
      status: () => ({ provider: 'openrouter', model: 'minimax/minimax-m3:free', configured: true, state: 'ready' }),
      generate: async () => { throw unavailable; },
    },
  });

  const result = await runtime.processCandidate(validCandidate());
  assert.equal(result.status, 'content_skipped');
  assert.equal(calls.writer, 0);
  assert.equal(calls.charts, 0);
  assert.equal(calls.publishes, 0);
  assert.equal(stateStore.state.autoReady, false);
});

test('monitor-only contracts never reach the writer even with a high anomaly score', async () => {
  const { runtime, calls } = makeRuntime({ state: { mode: 'DRY_RUN', cryptoThreadId: 'crypto-thread' } });
  const result = await runtime.processCandidate(validCandidate({ autoEligible: false, score: 97 }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'monitor_only');
  assert.equal(calls.writer, 0);
});

test('successful production-eligible DRY_RUN completes writer, validation, chart and exact preview', async () => {
  const { runtime, calls, stateStore } = makeRuntime({ state: { cryptoThreadId: 'crypto-thread' } });
  const result = await runtime.processCandidate(validCandidate());
  assert.equal(result.status, 'preview');
  assert.equal(calls.writer, 1);
  assert.equal(calls.charts, 1);
  assert.equal(calls.publishes, 1);
  assert.equal(result.preview.postText, '$BTC moved +2.14% in the last 5 minutes.\n\nVolume reached 5.2x its rolling baseline.\n\nPrice and participation expanded together.\n\nThe next useful evidence is whether activity persists after the first impulse, because fading participation would weaken the move without changing the verified facts.\n\n#Crypto #ChartAnalysis');
  assert.equal(result.preview.postText.startsWith('$BTC '), true);
  assert.deepEqual(result.preview.postText.match(/#[A-Za-z][A-Za-z0-9_]*\b/g), ['#Crypto', '#ChartAnalysis']);
  assert.match(result.preview.chartPath, /candidate-1\.png$/);
  assert.equal(stateStore.state.autoReady, true);
  assert.equal(stateStore.state.dryRunVerifiedAt, 1_724_155_200_000);
  assert.equal(stateStore.state.lastPreview.postText, result.preview.postText);
    const status = await runtime.status();
  assert.equal(status.lastPreview.chartUrl, '/api/crypto/chart/candidate-1.png');
  assert.equal('chartPath' in status.lastPreview, false);
    assert.doesNotMatch(JSON.stringify(status), /data[\\/]crypto/);
  assert.match(runtime.resolveChart('candidate-1.png'), /candidate-1\.png$/);
  assert.throws(() => runtime.resolveChart('../state.json'), /Invalid Crypto chart/);
});

test('runtime supplies bounded recent hook history and persists new editorial metadata', async () => {
  const { runtime, calls, stateStore } = makeRuntime({ state: {
    cryptoThreadId: 'crypto-thread',
    posts: [
      { token: 'ETH', publishedAt: 1_724_148_000_000, hookFamily: 'question', openingFingerprint: 'old-open' },
    ],
    lastPreview: {
      postText: '$SOL moved first.\n\nThen volume followed.',
      hookFamily: 'timeline_mystery',
      openingFingerprint: 'preview-open',
    },
  } });

  const result = await runtime.processCandidate(validCandidate());

  assert.equal(result.status, 'preview');
  assert.deepEqual(calls.writerRequests[0].editorialHistory.map((entry) => entry.hookFamily), [
    'question',
    'timeline_mystery',
  ]);
  assert.equal(typeof stateStore.state.lastPreview.hookFamily, 'string');
  assert.match(stateStore.state.lastPreview.openingFingerprint, /^[a-f0-9]{64}$/);
});

test('status reports recovery and fail-closed publish availability without exposing a credential', async () => {
  const { runtime } = makeRuntime({
    state: { cryptoThreadId: 'thread', recovery: { status: 'ready', reason: null, migratedFrom: null } },
    publisher: {
      recoverPending: async () => ({ status: 'clean' }),
      credentialStatus: async () => ({ configured: false, source: null }),
    },
  });
  const status = await runtime.status();
  assert.equal(status.recovery.status, 'ready');
  assert.equal(status.publishAvailability, 'PUBLISH_DISABLED: missing_square_credential');
  assert.equal(JSON.stringify(status).includes('BINANCE_SQUARE_OPENAPI_KEY'), false);
});

test('readiness pipeline can exercise a low historical sample in forced DRY_RUN without changing OFF mode', async () => {
  const { runtime, calls, stateStore } = makeRuntime({
    state: { mode: 'OFF', cryptoThreadId: 'thread' },
    writerResult: readyEditorial(content),
  });
  const result = await runtime.processCandidate(validCandidate({
    score: 42,
    expired: true,
    readinessOnly: true,
    validationForcedCandidate: true,
    productionEligible: false,
  }), { modeOverride: 'DRY_RUN', bypassEligibility: true, readinessOnly: true });
  assert.equal(result.status, 'preview');
  assert.equal(calls.writer, 1);
  assert.equal(calls.charts, 1);
  assert.equal(calls.publishes, 1);
  assert.equal(stateStore.state.mode, 'OFF');
  assert.equal(stateStore.state.autoReady, false);
  assert.equal(stateStore.state.lastPreview.validationForcedCandidate, true);
  assert.equal(stateStore.state.lastPreview.productionEligible, false);
});

test('writer SKIP and validator failure stop before chart and publisher', async () => {
  const skipped = makeRuntime({ state: { cryptoThreadId: 'thread' }, writerResult: { status: 'skip', reason: 'SKIP_CONTENT', provider: 'openrouter' } });
  assert.equal((await skipped.runtime.processCandidate(validCandidate())).status, 'content_skipped');
  assert.equal(skipped.calls.charts, 0);
  assert.equal(skipped.calls.publishes, 0);
  const invalid = makeRuntime({ state: { cryptoThreadId: 'thread' }, writerResult: readyEditorial({ ...content, postText: '$BTC вырос +2.14% и не должен пройти.' }) });
  assert.equal((await invalid.runtime.processCandidate(validCandidate())).status, 'content_rejected');
  assert.equal(invalid.calls.charts, 0);
  assert.equal(invalid.calls.publishes, 0);
});

test('a rejected story chart persists the editorial review without publishing', async () => {
  const { runtime, calls } = makeRuntime({
    state: { cryptoThreadId: 'thread' },
    writerResult: { ...readyEditorial(), audit: { selected: { id: 'reflection' } } },
    chartRenderer: async () => ({ width: 100, height: 900, labels: ['$BTC'], path: 'chart.png', sha256: 'bad-chart' }),
  });

  const result = await runtime.processCandidate(validCandidate());

  assert.equal(result.status, 'content_rejected');
  assert.deepEqual(result.errors, ['VISUAL_DIMENSIONS_INVALID']);
  assert.equal(calls.publishes, 0);
  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.reviews[0].validation.errors[0], 'VISUAL_DIMENSIONS_INVALID');
  assert.equal(calls.reviews[0].chart.sha256, 'bad-chart');
  assert.equal(calls.reviews[0].publication.status, 'content_rejected');
});

test('writer skips leave a terminal writer and rejection record instead of an orphaned start', async () => {
  const { runtime, calls } = makeRuntime({
    state: { cryptoThreadId: 'thread' },
    writer: {
      status: () => ({ provider: 'openrouter', model: 'minimax/minimax-m3:free', configured: true, state: 'ready' }),
      generate: async () => ({ status: 'skip', reason: 'WEAK_EDITORIAL_ANGLE', provider: 'openrouter' }),
    },
  });

  const result = await runtime.processCandidate(validCandidate());

  assert.equal(result.status, 'content_skipped');
  assert.deepEqual(calls.events.filter((event) => event.payload?.candidateId === 'candidate-1').map((event) => event.type), [
    'anomaly_detected', 'candidate_selected', 'fact_pack_built', 'writer_started', 'writer_completed', 'content_rejected',
  ]);
  assert.deepEqual(calls.events.find((event) => event.type === 'writer_completed').payload, {
    candidateId: 'candidate-1', decision: 'skip', reason: 'WEAK_EDITORIAL_ANGLE', provider: 'openrouter',
  });
  assert.equal(calls.charts, 0);
  assert.equal(calls.publishes, 0);
});

test('a transient OpenRouter failure persists an eligible candidate for bounded retry', async () => {
  const unavailable = Object.assign(new Error('OpenRouter temporarily unavailable.'), { code: 'OPENROUTER_UNREACHABLE', retryable: true });
  const { runtime, stateStore, calls } = makeRuntime({
    state: { cryptoThreadId: 'thread' },
    writer: {
      status: () => ({ provider: 'openrouter', model: 'minimax/minimax-m3:free', configured: true, state: 'ready' }),
      generate: async () => { throw unavailable; },
    },
  });

  const result = await runtime.processCandidate(validCandidate());

  assert.equal(result.status, 'queued');
  assert.equal(result.reason, 'openrouter_unreachable');
  assert.equal(stateStore.state.pendingCandidates.length, 1);
  assert.equal(stateStore.state.pendingCandidates[0].candidate.id, 'candidate-1');
  assert.equal(calls.events.find((event) => event.type === 'writer_unavailable').payload.code, 'OPENROUTER_UNREACHABLE');
  assert.equal(calls.events.find((event) => event.type === 'candidate_queued').payload.reason, 'openrouter_unreachable');
  assert.equal(calls.charts, 0);
  assert.equal(calls.publishes, 0);
  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.reviews[0].validation.errors[0], 'openrouter_unreachable');
  assert.equal(calls.events.some((event) => event.type === 'review_package_written'), true);
});

test('a non-retryable writer response failure does not disarm an explicit AUTO override', async () => {
  const unavailable = Object.assign(new Error('AnyModel returned no usable completion.'), {
    code: 'ANYMODEL_INVALID_RESPONSE',
    retryable: false,
  });
  const { runtime, stateStore } = makeRuntime({
    state: {
      mode: 'AUTO',
      cryptoThreadId: 'thread',
      autoArmed: true,
      manualAutoOverride: true,
      autoArm: { result: 'manual_override' },
    },
    config: { topRunnerMode: true },
    writer: {
      status: () => ({ provider: 'anymodel', model: 'kmc/k3', configured: true, state: 'offline' }),
      generate: async () => { throw unavailable; },
    },
  });

  const result = await runtime.processCandidate(validCandidate({ score: 36 }));

  assert.equal(result.status, 'content_skipped');
  assert.equal(stateStore.state.mode, 'AUTO');
  assert.equal(stateStore.state.autoArmed, true);
  assert.equal(stateStore.state.manualAutoOverride, true);
  assert.equal(stateStore.state.autoArm.reason, 'anymodel_invalid_response');
});

test('same-token fresh-analysis cooldown blocks a second writer call for six hours', async () => {
  const { runtime, calls } = makeRuntime({ state: { cryptoThreadId: 'thread', tokenLastAnalyzedAt: { BTC: 1_724_155_200_000 - 60_000 } } });
  const result = await runtime.processCandidate(validCandidate());
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'same_token_analysis_cooldown');
  assert.equal(calls.writer, 0);
});

test('AUTO mode switch requires both verified DRY_RUN and Square credential', async () => {
  const locked = makeRuntime({ state: { cryptoThreadId: 'thread', autoReady: false } });
  await assert.rejects(() => locked.runtime.setMode('AUTO'), /successful live DRY_RUN/);
  const noKey = makeRuntime({
    state: { cryptoThreadId: 'thread', autoReady: true, autoArmed: true, autoArm: { pipelineFingerprint: 'runtime-unfingerprinted', writerFingerprint: 'openrouter:minimax/minimax-m3:free', result: 'manual_confirmation_after_live_dry_run' } },
    publisher: { recoverPending: async () => ({}), credentialStatus: async () => ({ configured: false, source: null }) },
  });
  await assert.rejects(() => noKey.runtime.setMode('AUTO'), /Square credential/);
  const ready = makeRuntime({ state: { cryptoThreadId: 'thread', autoReady: true, autoArmed: true, autoArm: { pipelineFingerprint: 'runtime-unfingerprinted', writerFingerprint: 'openrouter:minimax/minimax-m3:free', result: 'manual_confirmation_after_live_dry_run' } } });
  assert.equal((await ready.runtime.setMode('AUTO')).mode, 'AUTO');
  assert.equal(ready.stateStore.state.mode, 'AUTO');
});

test('live DRY_RUN records verification but never arms or marks AUTO ready', async () => {
  const good = makeRuntime({
    state: { cryptoThreadId: 'thread', autoReady: false },
    liveDryRunRunner: async () => ({
      ok: true,
      checks: { publicData: true, fullPipeline: true, noPublishing: true },
      pipeline: { status: 'preview', published: false, candidateId: 'dry-run-1' },
    }),
  });
  const result = await good.runtime.runLiveDryRun();
  assert.equal(result.autoReady, false);
  assert.equal(result.autoArmed, false);
  assert.equal(result.publishBlocked, 'manual_confirmation_required');
  assert.equal(good.stateStore.state.autoReady, false);
  assert.equal(good.stateStore.state.autoArmed, false);
  assert.equal(good.stateStore.state.autoArm.reason, 'manual_confirmation_required');
  await assert.rejects(() => good.runtime.setMode('AUTO'), /successful live DRY_RUN/);

  const bad = makeRuntime({
    state: { cryptoThreadId: 'thread', autoReady: false },
    liveDryRunRunner: async () => ({ ok: false, checks: { fullPipeline: false } }),
  });
  await assert.rejects(() => bad.runtime.runLiveDryRun(), /failed/i);
  assert.equal(bad.stateStore.state.autoReady, false);
});

test('OFF and DRY_RUN always disarm AUTO so persisted mode cannot contradict publisher eligibility', async () => {
  const { runtime, stateStore } = makeRuntime({ state: {
    mode: 'AUTO', autoReady: true, autoArmed: true, manualAutoOverride: true,
    autoArm: { result: 'manual_override', pipelineFingerprint: 'runtime-unfingerprinted', writerFingerprint: 'openrouter:minimax/minimax-m3:free' },
  } });
  await runtime.setMode('DRY_RUN');
  assert.equal(stateStore.state.mode, 'DRY_RUN');
  assert.equal(stateStore.state.autoArmed, false);
  assert.equal(stateStore.state.manualAutoOverride, false);
  assert.equal(stateStore.state.autoReady, false);
  await runtime.setMode('OFF');
  assert.equal(stateStore.state.mode, 'OFF');
  assert.equal(stateStore.state.autoArmed, false);
});

test('startup clears a legacy arm flag whenever the persisted requested mode is not AUTO', async () => {
  const { runtime, stateStore } = makeRuntime({ state: {
    mode: 'DRY_RUN', autoArmed: true, manualAutoOverride: true,
    autoArm: { result: 'manual_override', pipelineFingerprint: 'runtime-unfingerprinted', writerFingerprint: 'openrouter:minimax/minimax-m3:free' },
  } });
  await runtime.initialize({ startScanner: false });
  assert.equal(stateStore.state.mode, 'DRY_RUN');
  assert.equal(stateStore.state.autoArmed, false);
  assert.equal(stateStore.state.manualAutoOverride, false);
});

test('startup clears stale AUTO readiness whenever persisted mode is DRY_RUN', async () => {
  const { runtime, stateStore } = makeRuntime({ state: {
    mode: 'DRY_RUN', autoReady: true, autoArmed: false,
    autoArm: { result: 'live_dry_run_passed', pipelineFingerprint: 'runtime-unfingerprinted', writerFingerprint: 'openrouter:minimax/minimax-m3:free' },
  } });
  await runtime.initialize({ startScanner: false });
  assert.equal(stateStore.state.mode, 'DRY_RUN');
  assert.equal(stateStore.state.autoReady, false);
});

test('writer-model changes cannot turn a verified DRY_RUN into AUTO readiness', async () => {
  let model = 'minimax/minimax-m3:free';
  const { runtime, stateStore } = makeRuntime({
    state: { cryptoThreadId: 'thread', autoReady: false },
    writer: {
      status: () => ({ provider: 'openrouter', model, configured: true, state: 'ready' }),
      generate: async () => readyEditorial(),
    },
    liveDryRunRunner: async () => ({
      ok: true,
      checks: { publicData: true, fullPipeline: true, noPublishing: true },
      pipeline: { status: 'preview', published: false, candidateId: 'dry-run-account-bound' },
    }),
  });
  await runtime.runLiveDryRun();
  model = 'another-writer-model';
  await assert.rejects(runtime.confirmAutoArm(), /current successful live DRY_RUN/);
  assert.equal(stateStore.state.autoReady, false);
  assert.equal(stateStore.state.autoArmed, false);
});

test('manual AUTO force is explicit, requires a Square credential, and persists the override', async () => {
  const normal = makeRuntime({ state: { cryptoThreadId: 'thread', autoReady: false } });
  await assert.rejects(normal.runtime.confirmAutoArm(), /current successful live DRY_RUN/);
  assert.equal(normal.stateStore.state.autoArmed, false);
  assert.notEqual(normal.stateStore.state.manualAutoOverride, true);

  const noCredential = makeRuntime({
    state: { cryptoThreadId: 'thread', autoReady: false },
    publisher: { recoverPending: async () => ({}), credentialStatus: async () => ({ configured: false, source: null }) },
  });
  await assert.rejects(noCredential.runtime.confirmAutoArm({ force: true }), /Square credential/);
  assert.equal(noCredential.stateStore.state.autoArmed, false);

  const forced = makeRuntime({ state: { cryptoThreadId: 'thread', autoReady: false } });
  const status = await forced.runtime.confirmAutoArm({ force: true });
  assert.equal(status.mode, 'AUTO');
  assert.equal(status.autoArmed, true);
  assert.equal(status.manualAutoOverride, true);
  assert.equal(forced.stateStore.state.autoReady, false);
  assert.equal(forced.stateStore.state.autoArmed, true);
  assert.equal(forced.stateStore.state.manualAutoOverride, true);
  assert.equal(forced.stateStore.state.autoArm.result, 'manual_override');
});

test('runtime emits typed Activity events and no synthetic user messages', async () => {
  const { runtime, calls } = makeRuntime({ state: { cryptoThreadId: 'thread' } });
  const streamed = [];
  const unsubscribe = runtime.subscribe((event) => streamed.push(event));
  await runtime.processCandidate(validCandidate({ score: 74 }));
  unsubscribe();
  assert.ok(streamed.some((event) => event.type === 'anomaly_detected'));
  assert.ok(calls.events.every((event) => event.schemaVersion === 1));
  assert.equal(JSON.stringify(streamed).includes('user_message'), false);
});

test('runtime owns one persistent protected Crypto identity and manual context', async () => {
  const { runtime } = makeRuntime({ state: { mode: 'DRY_RUN', cryptoThreadId: 'crypto-thread' } });
  assert.equal(await runtime.isThread('crypto-thread'), true);
  assert.equal(await runtime.isThread('ordinary-thread'), false);
  const context = await runtime.manualTurnContext();
  assert.equal(context['crypto.runtime'].kind, 'application');
  assert.match(context['crypto.runtime'].value, /DRY_RUN/);
});

test('status exposes bounded persisted meaningful events with the persistent thread identity', async () => {
  const persisted = [
    { eventId: 'noise', type: 'universe_updated', occurredAt: '2026-08-20T10:00:00.000Z', payload: {} },
    { eventId: 'selected', type: 'candidate_selected', occurredAt: '2026-08-20T10:01:00.000Z', payload: { symbol: 'BTCUSDT' } },
    { eventId: 'published', type: 'publish_completed', occurredAt: '2026-08-20T10:02:00.000Z', payload: { symbol: 'BTCUSDT' } },
  ];
  const { runtime } = makeRuntime({
    state: { mode: 'DRY_RUN', cryptoThreadId: 'crypto-thread' },
    eventStore: { append: async () => {}, listRecent: async () => persisted },
  });

  const status = await runtime.status();

  assert.equal(status.threadId, 'crypto-thread');
  assert.deepEqual(status.recentEvents.map((event) => event.type), ['candidate_selected', 'publish_completed']);
});

test('operator recovery probe is explicit and does not alter AUTO state', async () => {
  const { runtime, stateStore } = makeRuntime({ state: { mode: 'AUTO', autoArmed: false, cryptoThreadId: 'crypto-thread' } });
  runtime.binanceRestProbeRunner = async () => ({ serverTime: 1 });
  runtime.binanceRestGovernor = { diagnostics: async () => ({ state: 'NORMAL', queueDepth: 0 }) };
  const result = await runtime.runBinanceRestRecoveryProbe();
  assert.equal(result.response.serverTime, 1);
  assert.equal(stateStore.state.autoArmed, false);
});
