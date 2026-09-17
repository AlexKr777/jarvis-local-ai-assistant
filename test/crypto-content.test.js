import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { AppServerClient } from '../src/app-server-client.js';
import { JarvisSession } from '../src/jarvis-session.js';
import { CRYPTO_CONTENT_SCHEMA, CryptoCodexBridge } from '../src/crypto/content/codex-bridge.js';
import { classifyHookFamily, validateContentPackage } from '../src/crypto/content/content-validator.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeClient extends EventEmitter {
  turns = [];
  names = [];

  async resumeThread(threadId) {
    return { thread: { id: threadId, cwd: process.cwd(), threadSource: 'jarvis-local', turns: [] } };
  }

  async startTurn(threadId, input, options) {
    this.turns.push({ threadId, input, options });
    return {};
  }

  async setThreadName(threadId, name) {
    this.names.push({ threadId, name });
  }
}

function makeSession() {
  const client = new FakeClient();
  const session = new JarvisSession({
    projectRoot: process.cwd(),
    clientFactory: () => client,
    logDirectory: path.join(os.tmpdir(), 'jarvis-crypto-content-logs'),
  });
  const events = [];
  session.subscribe((event) => events.push(event));
  return { session, client, events };
}

const candidate = {
  id: 'candidate-1',
  symbol: 'BTCUSDT',
  cashtag: '$BTC',
  direction: 'up',
  score: 91,
  conflict: { allowed: false, confidence: 0.8, verdictStyle: 'none', options: [] },
  claimsAllowed: [
    { key: 'return5m', value: 2.14, display: '+2.14%' },
    { key: 'volumeRatio', value: 5.2, display: '5.2x' },
  ],
};

test('Codex output schema is strict-compatible at every object level', () => {
  function assertStrictObject(schema) {
    if (schema?.type === 'object' && schema.properties) {
      assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
      for (const property of Object.values(schema.properties)) assertStrictObject(property);
    }
    if (schema?.type === 'array') assertStrictObject(schema.items);
  }

  assertStrictObject(CRYPTO_CONTENT_SCHEMA);
  assert.ok(CRYPTO_CONTENT_SCHEMA.properties.visualIntent.properties.relationship.enum.includes('none'));
});

test('App Server keeps normal turns unchanged and applies a locked automation profile explicitly', async () => {
  const calls = [];
  const client = new AppServerClient({ cwd: process.cwd() });
  client.executionContextCache = { healthy: true, authMode: 'chatgpt', planType: 'plus', model: 'gpt-5.5', fingerprint: 'test-context' };
  client.selectedModel = 'gpt-5.5';
  client.connect = async () => {};
  client.request = async (method, params) => { calls.push({ method, params }); return {}; };
  await client.startTurn('human', [{ type: 'text', text: 'hello' }]);
  await client.startTurn('crypto', [], {
    automation: true,
    additionalContext: { 'crypto.event': { kind: 'application', value: 'typed event' } },
    outputSchema: { type: 'object' },
  });
  assert.equal(calls[0].params.approvalPolicy, 'on-request');
  assert.deepEqual(calls[0].params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(calls[0].params.model, 'gpt-5.5');
  assert.equal(calls[1].params.approvalPolicy, 'never');
  assert.deepEqual(calls[1].params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(calls[1].params.model, 'gpt-5.5');
  assert.deepEqual(calls[1].params.input, []);
  assert.deepEqual(calls[1].params.additionalContext, { 'crypto.event': { kind: 'application', value: 'typed event' } });
  assert.deepEqual(calls[1].params.outputSchema, { type: 'object' });
});

test('Jarvis automation turn is typed, invisible to the user queue, and resolves authoritative output', async () => {
  const { session, client, events } = makeSession();
  const completion = session.runAutomationTurn({
    threadId: 'crypto-thread',
    additionalContext: { 'crypto.event': { kind: 'application', value: 'event envelope' } },
    outputSchema: CRYPTO_CONTENT_SCHEMA,
  });
  await tick();
  assert.equal(client.turns.length, 1);
  assert.deepEqual(client.turns[0].input, []);
  assert.equal(events.some((event) => event.type === 'turn-started'), false);
  assert.equal(events.find((event) => event.type === 'automation-started').threadId, 'crypto-thread');
  client.emit('notification', { method: 'item/completed', params: { threadId: 'crypto-thread', item: { type: 'agentMessage', text: '{"decision":"skip","reason":"quiet"}' } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'crypto-thread', turn: { status: 'completed' } } });
  assert.equal(await completion, '{"decision":"skip","reason":"quiet"}');
  assert.equal(events.some((event) => event.type === 'assistant-message'), false);
});

test('automation respects FIFO with a human turn and never appears in public queue snapshots', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 'thread-1', message: 'human', attachments: [] });
  const automation = session.runAutomationTurn({
    threadId: 'thread-1', additionalContext: { 'crypto.event': { kind: 'application', value: 'event' } }, outputSchema: CRYPTO_CONTENT_SCHEMA,
  });
  await tick();
  assert.equal(client.turns.length, 1);
  assert.deepEqual(events.filter((event) => event.type === 'queue').at(-1).items, []);
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
  await tick();
  assert.equal(client.turns.length, 2);
  client.emit('notification', { method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: '{"decision":"skip"}' } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
  assert.equal(await automation, '{"decision":"skip"}');
});

test('an automation turn with no terminal App Server event fails closed after watchdog reconciliation is exhausted', async () => {
  const timers = [];
  const client = new FakeClient();
  client.readThread = async () => ({ id: 'crypto-thread', cwd: process.cwd(), threadSource: 'jarvis-local', turns: [{ id: 'stalled-turn', status: 'inProgress', items: [] }] });
  client.interruptTurn = async () => {};
  client.startTurn = async (...args) => {
    client.turns.push({ threadId: args[0], input: args[1], options: args[2] });
    return { turn: { id: 'stalled-turn' } };
  };
  const session = new JarvisSession({
    projectRoot: process.cwd(),
    clientFactory: () => client,
    logDirectory: path.join(os.tmpdir(), 'jarvis-crypto-content-logs'),
    turnWatchdogMs: 1,
    turnWatchdogMaxChecks: 1,
    setTimeoutImpl: (callback) => { timers.push(callback); return { unref() {} }; },
    clearTimeoutImpl: () => {},
  });
  let rejected = false;
  void session.runAutomationTurn({
    threadId: 'crypto-thread',
    additionalContext: { 'crypto.event': { kind: 'application', value: 'event' } },
    outputSchema: CRYPTO_CONTENT_SCHEMA,
  }).catch(() => { rejected = true; });
  await tick();
  timers.shift()();
  await tick();

  assert.equal(rejected, true);
});

test('Codex bridge sends playbook, editorial history, verified context and typed event as application context', async () => {
  const calls = [];
  const bridge = new CryptoCodexBridge({
    jarvis: { runAutomationTurn: async (request) => { calls.push(request); return '{"decision":"skip","reason":"not_distinctive"}'; } },
    playbookLoader: async () => 'PLAYBOOK CORE',
  });
  const result = await bridge.generate({
    threadId: 'crypto-thread',
    event: { type: 'candidate_selected', payload: candidate },
    learning: { samples: 8 },
    editorialHistory: [{ hookFamily: 'question', openingFingerprint: 'abc' }],
    verifiedExternalContext: [{ source: 'official_project', fact: 'No catalyst was announced.' }],
  });
  assert.deepEqual(result, { decision: 'skip', reason: 'not_distinctive' });
  assert.equal(calls[0].threadId, 'crypto-thread');
  assert.deepEqual(Object.keys(calls[0].additionalContext), [
    'crypto.playbook',
    'crypto.learning',
    'crypto.editorial-history',
    'crypto.verified-context',
    'crypto.event',
  ]);
  assert.ok(Object.values(calls[0].additionalContext).every((entry) => entry.kind === 'application'));
  assert.match(calls[0].additionalContext['crypto.playbook'].value, /PLAYBOOK CORE/);
  assert.match(calls[0].additionalContext['crypto.editorial-history'].value, /question/);
  assert.match(calls[0].additionalContext['crypto.verified-context'].value, /official_project/);
  assert.match(calls[0].additionalContext['crypto.event'].value, /candidate_selected/);
  assert.equal(calls[0].input, undefined);
});

test('manual Crypto turns receive the playbook and bounded operator policy without changing normal safety', async () => {
  const bridge = new CryptoCodexBridge({ jarvis: {}, playbookLoader: async () => 'PLAYBOOK CORE' });
  const context = await bridge.manualContext({ mode: 'DRY_RUN', scanner: 'running', posts24h: 2 });
  assert.deepEqual(Object.keys(context), ['crypto.playbook', 'crypto.runtime', 'crypto.operator-policy']);
  assert.ok(Object.values(context).every((entry) => entry.kind === 'application'));
  assert.match(context['crypto.playbook'].value, /PLAYBOOK CORE/);
  assert.match(context['crypto.runtime'].value, /DRY_RUN/);
  assert.match(context['crypto.operator-policy'].value, /temporary|permanent/i);
  assert.doesNotMatch(JSON.stringify(context), /OPENAI_API_KEY|api\.openai\.com/i);
});

test('manual Crypto context reaches App Server while retaining normal approvals and sandbox', async () => {
  const { session, client } = makeSession();
  const additionalContext = { 'crypto.playbook': { kind: 'application', value: 'PLAYBOOK CORE' } };
  await session.send({
    threadId: 'crypto-thread',
    message: 'Explain the latest signal',
    attachments: [],
    source: 'crypto',
    additionalContext,
  });

  assert.equal(client.turns[0].options.additionalContext['crypto.playbook'].value, 'PLAYBOOK CORE');
  assert.equal(client.turns[0].options.automation, undefined);
  assert.equal(client.turns[0].options.outputSchema, undefined);
});

test('an immediately rejected automation request has one observed rejection and cannot crash the server', async () => {
  const { session, client } = makeSession();
  client.startTurn = async () => { throw new Error('Invalid request shape.'); };
  await assert.rejects(() => session.runAutomationTurn({
    threadId: 'crypto-thread',
    additionalContext: { 'crypto.event': { kind: 'application', value: 'event' } },
    outputSchema: CRYPTO_CONTENT_SCHEMA,
  }), /JARVIS/);
  await tick();
});

test('content validator accepts only exact supplied claims and one cashtag', () => {
  const result = validateContentPackage({
    decision: 'publish',
    postText: '$BTC moved +2.14% in the last 5 minutes.\n\nVolume reached 5.2x its rolling baseline.\n\nPrice and participation expanded together.\n\nThe next useful evidence is whether activity persists after the first impulse, because that would separate a durable move from a brief burst.',
    cashtag: '$BTC',
    claimsUsed: [
      { key: 'return5m', display: '+2.14%' },
      { key: 'volumeRatio', display: '5.2x' },
    ],
    visualIntent: { preset: 'volume_shock', revealOnOpen: false },
  }, candidate);
  assert.equal(result.ok, true);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test('cashtag validation derives one canonical public tag from the exchange base asset', () => {
  for (const [baseAsset, quoteAsset] of [['BTC', 'USDT'], ['XRP', 'USDT'], ['DOGE', 'USDT'], ['DOGE', 'USDC']]) {
    const expected = `$${baseAsset}`;
    const event = {
      ...candidate,
      symbol: `${baseAsset}${quoteAsset}`,
      baseAsset,
      quoteAsset,
      cashtag: '$WRONG',
    };
    const content = {
      decision: 'publish',
      postText: `${expected} moved +2.14% over five minutes.\n\nVolume reached 5.2x its rolling baseline.\n\nThe move had verified participation behind it.\n\nThe next useful check is whether that activity persists beyond the first impulse.`,
      cashtag: expected,
      claimsUsed: [
        { key: 'return5m', display: '+2.14%' },
        { key: 'volumeRatio', display: '5.2x' },
      ],
      visualIntent: { preset: 'volume_shock', revealOnOpen: false },
    };
    assert.equal(validateContentPackage(content, event).errors.includes('invalid_cashtag'), false, `${baseAsset}${quoteAsset}`);
  }
});

test('cashtag validation rejects wrong, missing, malformed, and multiple public tags against canonical identity', () => {
  const event = { ...candidate, symbol: 'DOGEUSDT', baseAsset: 'DOGE', quoteAsset: 'USDT', cashtag: '$WRONG' };
  const makeContent = (postText, cashtag) => ({
    decision: 'publish',
    postText,
    cashtag,
    claimsUsed: [{ key: 'return5m', display: '+2.14%' }],
    visualIntent: { preset: 'volume_shock', revealOnOpen: false },
  });
  for (const [text, cashtag] of [
    ['$BTC moved +2.14% over five minutes. The supplied move is narrow but readable.', '$BTC'],
    ['DOGE moved +2.14% over five minutes. The supplied move is narrow but readable.', '$DOGE'],
    ['$DOGE moved +2.14% over five minutes while $BTC also appeared. The supplied move is narrow but readable.', '$DOGE'],
    ['$DOGE moved +2.14% over five minutes. The supplied move is narrow but readable.', 'DOGE'],
  ]) {
    assert.ok(validateContentPackage(makeContent(text, cashtag), event).errors.includes('invalid_cashtag'));
  }
});

test('content validator treats numeric timeframes encoded by supplied claim keys as verified facts', () => {
  const timeframeCandidate = {
    ...candidate,
    claimsAllowed: [
      ...candidate.claimsAllowed,
      { key: 'return15m', value: 3.45, display: '+3.45%' },
    ],
  };
  const result = validateContentPackage({
    decision: 'publish',
    postText: '$BTC moved +2.14% in the last 5 minutes.\n\nThe move reached +3.45% across the last 15 minutes.\n\nVolume climbed to 5.2x its rolling baseline.\n\nPrice and participation expanded together, and the next useful evidence is whether that activity persists after the initial impulse.',
    cashtag: '$BTC',
    claimsUsed: [
      { key: 'return5m', display: '+2.14%' },
      { key: 'return15m', display: '+3.45%' },
      { key: 'volumeRatio', display: '5.2x' },
    ],
    visualIntent: { preset: 'volume_shock', revealOnOpen: false },
  }, timeframeCandidate);
  assert.equal(result.ok, true);

  const inventedWindow = validateContentPackage({
    decision: 'publish',
    postText: '$BTC moved +2.14% in 30 minutes while volume reached 5.2x its rolling baseline. The supplied facts confirm a bounded price and participation anomaly, but they do not establish a cause. The observation remains factual and limited to the measured move. A different outcome would require fresh evidence instead of inference from this isolated window.',
    cashtag: '$BTC',
    claimsUsed: [
      { key: 'return5m', display: '+2.14%' },
      { key: 'volumeRatio', display: '5.2x' },
    ],
    visualIntent: { preset: 'volume_shock', revealOnOpen: false },
  }, timeframeCandidate);
  assert.ok(inventedWindow.errors.includes('unsupported_number'));
});

test('content validator accepts compact 24h notation for an exact verified claim', () => {
  const timeframeCandidate = {
    ...candidate,
    claimsAllowed: [{ key: 'return24h', value: 4.2, display: '+4.20%' }],
  };
  const result = validateContentPackage({
    decision: 'publish',
    postText: '$BTC rose +4.20% in 24h. I want the nearby level to hold before changing my view.',
    cashtag: '$BTC',
    claimsUsed: [{ key: 'return24h', display: '+4.20%' }],
    visualIntent: { preset: 'volume_shock', revealOnOpen: false },
  }, timeframeCandidate);
  assert.equal(result.ok, true);
});

test('content validator fails closed on hallucinated numbers, wrong language, duplicates and illegal A/B', () => {
  const base = {
    decision: 'publish',
    postText: '$BTC gained +9.99% on a verified move with enough surrounding English context to pass length checks while claiming an unsupported number that the market event never supplied to the content layer for publication.',
    cashtag: '$BTC',
    claimsUsed: [{ key: 'return5m', display: '+9.99%' }],
    visualIntent: { preset: 'price_oi_divergence', revealOnOpen: true },
  };
  assert.ok(validateContentPackage(base, candidate).errors.includes('unsupported_claim'));
  assert.ok(validateContentPackage({ ...base, postText: '$BTC сейчас движется +2.14%, но публичный текст не должен содержать русский язык даже при наличии корректной цифры и тега.', claimsUsed: [{ key: 'return5m', display: '+2.14%' }] }, candidate).errors.includes('public_text_not_english'));
  const legalText = '$BTC moved +2.14% while volume reached 5.2x baseline. The anomaly combines a verified price impulse with independently elevated participation, yet it does not prove a catalyst. The chart keeps the conclusion bounded to supplied facts and leaves room for the move to fade if participation fails to persist.';
  const first = validateContentPackage({ ...base, postText: legalText, claimsUsed: candidate.claimsAllowed.map(({ key, display }) => ({ key, display })) }, candidate);
  assert.ok(validateContentPackage({ ...base, postText: legalText, claimsUsed: candidate.claimsAllowed.map(({ key, display }) => ({ key, display })) }, candidate, { fingerprints: [first.fingerprint] }).errors.includes('duplicate_content'));
  assert.ok(validateContentPackage({ ...base, postText: `${legalText} A or B?`, claimsUsed: candidate.claimsAllowed.map(({ key, display }) => ({ key, display })) }, candidate).errors.includes('conflict_not_allowed'));
});

test('SKIP_CONTENT is a valid terminal decision and malformed Codex JSON fails closed', async () => {
  assert.deepEqual(validateContentPackage({ decision: 'skip', reason: 'SKIP_CONTENT' }, candidate), { ok: true, decision: 'skip', reason: 'SKIP_CONTENT' });
  const bridge = new CryptoCodexBridge({ jarvis: { runAutomationTurn: async () => 'not json' }, playbookLoader: async () => 'core' });
  await assert.rejects(() => bridge.generate({ threadId: 'thread', event: { type: 'candidate_selected', payload: candidate }, learning: {} }), /invalid structured output/);
});

test('historical readiness samples reject unsupported relative-recency language', () => {
  const result = validateContentPackage({
    decision: 'publish',
    postText: '$BTC moved +2.14% just now while volume reached 5.2x its rolling baseline. The sampled evidence confirms a price and participation anomaly but does not establish a catalyst. The observation remains bounded to the verified market window, and a durable conclusion would require fresh facts. Continuation cannot be inferred from the supplied move alone.',
    cashtag: '$BTC',
    claimsUsed: [
      { key: 'return5m', display: '+2.14%' },
      { key: 'volumeRatio', display: '5.2x' },
    ],
    visualIntent: { preset: 'volume_shock', revealOnOpen: false },
  }, { ...candidate, historicalReplay: true });
  assert.ok(result.errors.includes('historical_recency_overstated'));
});

test('historical factual validation accepts the exact BTC controlled-chart draft with degree-limiter just and natural horizons', () => {
  const historicalBtc = {
    ...candidate,
    historicalReplay: true,
    claimsAllowed: [
      { key: 'volumeRatio', value: 13.6, display: '13.6x', timeframe: '5m' },
      { key: 'return15m', value: -0.18, display: '-0.18%', timeframe: '15m' },
      { key: 'return4h', value: 6.27, display: '+6.27%', timeframe: '4h' },
    ],
  };
  const result = validateContentPackage({
    decision: 'publish',
    postText: '$BTC traded at 13.6x volume over five minutes, then slipped just -0.18% over 15 minutes.\n\nThat is the strange part: the burst looked dramatic, but the price damage was small. BTC was still up +6.27% over four hours. The activity spike made noise without erasing the move.',
    cashtag: '$BTC',
    claimsUsed: historicalBtc.claimsAllowed.map(({ key, display }) => ({ key, display })),
    visualIntent: { preset: 'volume_shock', revealOnOpen: false, relationship: 'none' },
  }, historicalBtc);
  assert.equal(result.errors.includes('historical_recency_overstated'), false);
  assert.equal(result.errors.includes('missing_timeframe_label'), false);
  assert.equal(result.ok, true);
});

test('historical recency distinguishes amount-limiter just from present-time just', () => {
  const amountCandidate = { ...candidate, historicalReplay: true, claimsAllowed: [{ key: 'return1h', value: 0.4, display: '+0.40%', timeframe: '1h' }] };
  for (const text of [
    '$BTC slipped just -0.18% over 15 minutes.',
    '$BTC moved just +0.4% over one hour.',
    '$BTC fell just 0.2%.',
    '$BTC rose just under 1%.',
  ]) {
    const result = validateContentPackage({ decision: 'publish', postText: text, cashtag: '$BTC', claimsUsed: [{ key: 'return1h', display: '+0.40%' }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } }, amountCandidate);
    assert.equal(result.errors.includes('historical_recency_overstated'), false, text);
  }
  for (const text of ['$BTC just surged +0.40% over one hour.', '$BTC just broke above a level after moving +0.40% over one hour.', '$BTC just hit a level after moving +0.40% over one hour.', 'This just happened: $BTC moved +0.40% over one hour.']) {
    const result = validateContentPackage({ decision: 'publish', postText: text, cashtag: '$BTC', claimsUsed: [{ key: 'return1h', display: '+0.40%' }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } }, amountCandidate);
    assert.equal(result.errors.includes('historical_recency_overstated'), true, text);
  }
});

test('factual validator normalizes supported natural horizon wording without accepting an unlabeled claim', () => {
  const variants = [
    ['return5m', '+0.50%', '5m', '$BTC moved +0.50% over five minutes.'],
    ['return15m', '+1.50%', '15m', '$BTC moved +1.50% over fifteen minutes.'],
    ['return1h', '+2.00%', '1h', '$BTC moved +2.00% over an hour.'],
    ['return2h', '+3.00%', '2h', '$BTC moved +3.00% over two hours.'],
    ['return4h', '+4.00%', '4h', '$BTC moved +4.00% over that same four-hour stretch.'],
    ['return24h', '+5.00%', '24h', '$BTC moved +5.00% over twenty-four hours.'],
  ];
  for (const [key, display, timeframe, postText] of variants) {
    const event = { ...candidate, claimsAllowed: [{ key, value: Number(display), display, timeframe }] };
    const result = validateContentPackage({ decision: 'publish', postText, cashtag: '$BTC', claimsUsed: [{ key, display }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } }, event);
    assert.equal(result.errors.includes('missing_timeframe_label'), false, postText);
  }
  const unlabeled = validateContentPackage({ decision: 'publish', postText: '$BTC moved +4.00%.', cashtag: '$BTC', claimsUsed: [{ key: 'return4h', display: '+4.00%' }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } }, { ...candidate, claimsAllowed: [{ key: 'return4h', value: 4, display: '+4.00%', timeframe: '4h' }] });
  assert.equal(unlabeled.errors.includes('missing_timeframe_label'), true);
});

test('content validator accepts safe rounded claim wording but rejects material numeric drift', () => {
  const roundedCandidate = {
    ...candidate,
    claimsAllowed: [
      { key: 'return24h', value: 46.884, display: '+46.88%', timeframe: '24h' },
      { key: 'openInterestChange', value: 12.467, display: '+12.47%', timeframe: '4h' },
    ],
  };
  const rounded = {
    decision: 'publish',
    postText: '$BTC gained almost 47% over 24 hours while open interest rose about 12.5% over four hours. The two measures climbed in the same sampled window, giving the move a broader participation footprint without proving why it happened.',
    cashtag: '$BTC',
    claimsUsed: [
      { key: 'return24h', display: '+46.88%' },
      { key: 'openInterestChange', display: '+12.47%' },
    ],
    visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' },
  };
  assert.equal(validateContentPackage(rounded, roundedCandidate).ok, true);
  const drifted = { ...rounded, postText: rounded.postText.replace('almost 47%', 'almost 49%') };
  assert.ok(validateContentPackage(drifted, roundedCandidate).errors.includes('unsupported_number'));
});

test('factual validator accepts natural ENA timeframe wording and does not own editorial length', () => {
  const ena = {
    ...candidate,
    cashtag: '$ENA',
    claimsAllowed: [
      { key: 'return24h', value: 46.88, display: '+46.88%', timeframe: '24h' },
      { key: 'return4h', value: 6.61, display: '+6.61%', timeframe: '4h' },
      { key: 'openInterestChange', value: 12.47, display: '+12.47%', timeframe: '4h' },
    ],
  };
  const result = validateContentPackage({
    decision: 'publish',
    postText: '$ENA is up +46.88% over 24 hours, but only +6.61% came in the last four.\n\nOpen interest climbed +12.47% over that same four-hour stretch. The rally was already large—and participation kept expanding.',
    cashtag: '$ENA',
    claimsUsed: ena.claimsAllowed.map(({ key, display }) => ({ key, display })),
    visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' },
  }, ena);
  assert.equal(result.errors.includes('missing_timeframe_label'), false);
  assert.equal(result.errors.includes('invalid_length'), false);
});

const roboConflictCandidate = {
  id: 'robo-quality-event',
  symbol: 'ROBOUSDT',
  cashtag: '$ROBO',
  direction: 'down',
  conflict: {
    allowed: true,
    confidence: 0.9,
    verdictStyle: 'calibrated',
    options: ['long_unwind', 'fresh_shorts'],
  },
  metrics: { return5mPct: -3.43, return15mPct: -3.81 },
  openInterestChangePct: 9.286618935273228,
  takerBuySellRatio: 0.6775,
  claimsAllowed: [
    { key: 'return24h', value: 14.75, display: '+14.75%', timeframe: '24h' },
    { key: 'return5m', value: -3.43, display: '-3.43%', timeframe: '5m' },
    { key: 'return15m', value: -3.81, display: '-3.81%', timeframe: '15m' },
    { key: 'openInterestChange', value: 9.286618935273228, display: '+9.29%', timeframe: '2h' },
    { key: 'takerBuySellRatio', value: 0.6775, display: '0.7x', timeframe: '5m' },
  ],
};

const roboClaims = roboConflictCandidate.claimsAllowed.map(({ key, display }) => ({ key, display }));

test('factual validator leaves dense-copy judgment to editorial gates while still rejecting banned AI disclaimer language', () => {
  const result = validateContentPackage({
    decision: 'publish',
    postText: '$ROBO moved -3.43% in 5 minutes while the setup merits attention, but the supplied metrics do not establish a cause and this observation is limited. Price movement and positioning are described in one dense analytical paragraph that offers no useful interaction before reaching its generic conclusion for readers.',
    cashtag: '$ROBO',
    claimsUsed: [{ key: 'return5m', display: '-3.43%' }],
    visualIntent: { preset: 'volume_shock', revealOnOpen: false },
  }, { ...roboConflictCandidate, conflict: { allowed: false, verdictStyle: 'none', options: [] } });
  assert.ok(!result.errors.includes('dense_public_copy'));
  assert.ok(result.errors.includes('banned_public_language'));
});

test('an incomplete one-sided A/B frame is rejected', () => {
  const malformed = validateContentPackage({
    decision: 'publish',
    postText: '$ROBO lost -3.81% in the last 15 minutes.\n\nWhat happened?\n\nA — Existing longs left the move.\n\nThe positioning data tells a different story, and readers should inspect it before deciding which explanation is stronger. Open interest expanded while the price fell, leaving the first explanation materially weaker than the alternative.',
    cashtag: '$ROBO',
    claimsUsed: [{ key: 'return15m', display: '-3.81%' }],
    visualIntent: { preset: 'price_oi_divergence', revealOnOpen: true, relationship: 'price_down_oi_up' },
  }, roboConflictCandidate);
  assert.ok(malformed.errors.includes('invalid_conflict_structure'));
});

test('every published market number carries its verified timeframe', () => {
  const result = validateContentPackage({
    decision: 'publish',
    postText: '$ROBO moved -3.81%.\n\nThe move is concrete and readable, with enough surrounding context to pass the public content length threshold without introducing another numeric claim. Price weakened while participation shifted, leaving a factual market event that still needs a clearly named measurement window.',
    cashtag: '$ROBO',
    claimsUsed: [{ key: 'return15m', display: '-3.81%' }],
    visualIntent: { preset: 'volume_shock', revealOnOpen: false },
  }, { ...roboConflictCandidate, conflict: { allowed: false, verdictStyle: 'none', options: [] } });
  assert.ok(result.errors.includes('missing_timeframe_label'));
});

test('price/OI visual intent must match the verified event relationship', () => {
  const result = validateContentPackage({
    decision: 'publish',
    postText: '$ROBO lost -3.81% in the last 15 minutes.\n\nWhat happened?\n\nA — Existing longs started leaving.\n\nB — Fresh shorts started entering.\n\nPick one before you open the rest.\n\nB is the better-supported read.\n\nIf A were driving the move, open interest should shrink. Instead, positioning expanded while price fell, which weakens a simple unwind and supports fresh bearish leverage as the stronger explanation.',
    cashtag: '$ROBO',
    claimsUsed: [{ key: 'return15m', display: '-3.81%' }],
    visualIntent: { preset: 'price_oi_divergence', revealOnOpen: true, relationship: 'price_up_oi_down' },
  }, roboConflictCandidate);
  assert.ok(result.errors.includes('visual_fact_mismatch'));
});

test('legacy ROBO quiz package is rejected as formulaic public copy', () => {
  const postText = [
    '$ROBO is still +14.75% TODAY.',
    'Then it lost -3.81% in 15 MINUTES.',
    'But here is the real puzzle:',
    'PRICE DOWN.',
    'OPEN INTEREST UP.',
    'Longs leaving — or fresh shorts entering?',
    'A — Existing longs are unwinding.',
    'B — Fresh shorts are entering.',
    'Pick one before you open the rest.',
    'B is the better-supported read.',
    'If A were driving this move, open interest should be shrinking.',
    'It rose +9.29% over the prior 2 hours.',
    'Price fell -3.43% in the last 5 minutes while the 5-minute taker buy/sell ratio dropped to 0.7x. Positions expanded as sellers stayed aggressive.',
    'That fits fresh bearish leverage entering better than a simple long unwind.',
    "Still think A? Show me the number I'm missing.",
  ].join('\n\n');
  const result = validateContentPackage({
    decision: 'publish',
    postText,
    cashtag: '$ROBO',
    claimsUsed: roboClaims,
    visualIntent: { preset: 'price_oi_divergence', revealOnOpen: true, relationship: 'price_down_oi_up' },
  }, roboConflictCandidate);
  assert.ok(result.errors.includes('banned_public_language'));
  assert.ok(result.errors.includes('formulaic_public_copy'));
  assert.equal(result.ok, false);
  assert.equal(postText.match(/\$ROBO/g)?.length, 1);
});

test('legacy forced-choice structure is rejected instead of rewarded', () => {
  const flatOpening = [
    '$ROBO is still +14.75% today.',
    'But it lost -3.81% in the last 15 minutes.',
    'Are longs leaving — or are shorts arriving?',
    'A — Existing longs are unwinding.',
    'B — Fresh shorts are entering.',
    'Pick one before you open the rest.',
    'B is the better-supported read.',
    'If A were driving this move, open interest should be shrinking.',
    'It rose +9.29% over the prior 2 hours.',
    'Price fell -3.43% in the last 5 minutes while the 5-minute taker buy/sell ratio dropped to 0.7x. Positions expanded as sellers stayed aggressive.',
    'That fits fresh bearish leverage entering better than a simple long unwind.',
    "Still think A? Show me the number I'm missing.",
  ].join('\n\n');
  const result = validateContentPackage({
    decision: 'publish',
    postText: flatOpening,
    cashtag: '$ROBO',
    claimsUsed: roboClaims,
    visualIntent: { preset: 'price_oi_divergence', revealOnOpen: true, relationship: 'price_down_oi_up' },
  }, roboConflictCandidate);
  assert.ok(result.errors.includes('formulaic_public_copy'));
});

test('premium editorial copy can take a natural position without exposing an A/B template', () => {
  const postText = [
    '$ROBO just lost -3.81% in the last 15 minutes.',
    'Profit-taking?',
    "I'm not buying it.",
    'Open interest climbed +9.29% over the prior 2 hours while price was falling.',
    'If longs were simply closing, positions should be disappearing.',
    "They're expanding.",
    'The 5-minute taker buy/sell ratio dropped to 0.7x, so sellers were still the aggressive side.',
    'Fresh shorts fit this tape much better than a simple long unwind.',
    "Still think it's just profit-taking?",
    'Show me the number that says so.',
  ].join('\n\n');
  const result = validateContentPackage({
    decision: 'publish',
    postText,
    cashtag: '$ROBO',
    claimsUsed: [
      { key: 'return15m', display: '-3.81%' },
      { key: 'openInterestChange', display: '+9.29%' },
      { key: 'takerBuySellRatio', display: '0.7x' },
    ],
    visualIntent: { preset: 'price_oi_divergence', revealOnOpen: true, relationship: 'price_down_oi_up' },
  }, roboConflictCandidate);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.hookFamily, 'question');
  assert.match(result.openingFingerprint, /^[a-f0-9]{64}$/);
});

test('natural A/B labels are optional and do not require a choose-or-reveal instruction', () => {
  const postText = [
    '$ROBO lost -3.81% in the last 15 minutes.',
    'Longs bailing — or fresh shorts stepping in?',
    'A — longs bailing.',
    'B — fresh shorts.',
    "I'm on B.",
    'If longs were only leaving, open interest should shrink with price.',
    'Instead, it climbed +9.29% over the prior 2 hours.',
    'Fresh bearish positioning is the cleaner explanation, and that makes A hard to defend.',
  ].join('\n\n');
  const result = validateContentPackage({
    decision: 'publish',
    postText,
    cashtag: '$ROBO',
    claimsUsed: [
      { key: 'return15m', display: '-3.81%' },
      { key: 'openInterestChange', display: '+9.29%' },
    ],
    visualIntent: { preset: 'price_oi_divergence', revealOnOpen: true, relationship: 'price_down_oi_up' },
  }, roboConflictCandidate);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('taking a side without disproving the losing case fails the editorial gate', () => {
  const postText = [
    '$ROBO lost -3.81% in the last 15 minutes.',
    'Profit-taking?',
    "I'm not buying it.",
    'Open interest climbed +9.29% over the prior 2 hours while price fell.',
    'The move looks important and deserves attention from anyone following positioning in this market.',
  ].join('\n\n');
  const result = validateContentPackage({
    decision: 'publish',
    postText,
    cashtag: '$ROBO',
    claimsUsed: [
      { key: 'return15m', display: '-3.81%' },
      { key: 'openInterestChange', display: '+9.29%' },
    ],
    visualIntent: { preset: 'price_oi_divergence', revealOnOpen: true, relationship: 'price_down_oi_up' },
  }, roboConflictCandidate);
  assert.ok(result.errors.includes('missing_discriminating_evidence'));
});

test('hook-family classification tracks editorial variation without forcing one format', () => {
  assert.equal(classifyHookFamily('Why did $BTC move?\n\nThe tape changed.'), 'question');
  assert.equal(classifyHookFamily("I'm not buying the easy explanation.\n\nPrice slipped anyway."), 'direct_disagreement');
  assert.equal(classifyHookFamily('$BTC gained +2.14%.\n\nVolume hit 5.2x baseline.'), 'surprising_number');
});

test('factual validator preserves a Fact Pack level at its Binance tick precision', () => {
  const content = {
    decision: 'publish',
    postText: '$BTC is testing $0.024743 after the latest reaction.',
    cashtag: '$BTC',
    claimsUsed: [],
    visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' },
  };
  const factPack = {
    levels: {
      supports: [{ midpoint: 0.024743, tickSize: 0.000001 }],
      resistances: [],
    },
  };
  assert.equal(validateContentPackage(content, { ...candidate, claimsAllowed: [] }, { factPack }).ok, true);
  assert.ok(validateContentPackage({ ...content, postText: content.postText.replace('0.024743', '0.0247') }, { ...candidate, claimsAllowed: [] }, { factPack }).errors.includes('unsupported_number'));
});
