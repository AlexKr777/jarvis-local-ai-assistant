import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AnyModelCryptoWriter, V5_STAGE_TOKEN_BUDGETS, extractAnyModelCompletion, parseAnyModelTransport } from '../src/crypto/content/anymodel-writer.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function textResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

const factPack = Object.freeze({
  identity: { symbol: 'ALPHAUSDT', cashtag: '$ALPHA' },
  ranking: { top10Rank: 1, change24h: '+18.20%' },
  market: { currentPrice: 10, range24h: { high: 10, low: 7, position: 1 }, drawdownFromHighPct: 0 },
  levels: {
    supports: [{ id: 'level:support:1', midpoint: 8.8, evidence: [{ timeframe: '1h' }] }],
    resistances: [{ id: 'level:resistance:1', midpoint: 10, evidence: [{ timeframe: '1h' }] }],
  },
  factsById: { 'claim:return24h': { display: '+18.20%' } },
  numbersAllowed: [{ key: 'return24h', display: '+18.20%', timeframe: '24h' }],
  research: { status: 'none_found', sources: [], claims: [] },
  chartInputs: { candles: {}, volumes: {}, eventMarkers: [] },
});

const thought = `INITIAL: My first read was that the daily gain could still carry price higher.
CHANGE: The first useful fact is whether 8.80 survives a pullback.
LEVEL_REASON: 8.80 matters because a defended retest separates a held move from a fleeting one.
BUYER_SELLER: If price revisits 8.80, buyers need to stop that decline quickly.
PREFERRED: I prefer 8.80 to hold before treating 10.00 as the next test.
INVALIDATION: A close below 8.80 makes me abandon this continuation view.
NEXT: I expect a retest of 8.80 before another attempt at 10.00.
MISSED: The daily percentage is obvious but the retest response is the harder detail.
CAUTION: I stay cautious until 8.80 proves it can absorb the first reaction.`;

const candidateA = `$ALPHA is not interesting to me just because it added +18.20% in 24 hours. My first read changes only if 8.80 can take the first pullback without immediately handing back the ground it gained; that response tells me more than another green candle.

If 8.80 holds, 10.00 becomes the next level I want to see tested. Below 8.80, I stop treating continuation as the live path.`;
const candidateB = `The number I keep returning to on $ALPHA is 8.80, not the +18.20% in 24 hours. A fast move can look convincing right up until its first retest, so I need to see how price behaves there before I give 10.00 much weight.

My preferred outcome is a clean defence at 8.80 followed by another look at 10.00. A close underneath it would make me drop that idea.`;

test('AnyModel completion parser accepts only explicit text response shapes and never promotes reasoning to public content', () => {
  const textParts = extractAnyModelCompletion({ choices: [{ message: { content: [{ type: 'text', text: 'first' }, { type: 'text', text: ' second' }] } }] });
  assert.equal(textParts.content, 'first second');
  assert.equal(textParts.source, 'choices[0].message.content.text_parts');
  assert.equal(textParts.shape.content.kind, 'array');
  const legacy = extractAnyModelCompletion({ choices: [{ text: 'legacy completion' }] });
  assert.equal(legacy.content, 'legacy completion');
  assert.equal(legacy.source, 'choices[0].text');
  assert.equal(legacy.shape.alternativeText.present, true);

  const rejected = extractAnyModelCompletion({
    choices: [{ message: { content: null, reasoning_content: 'private chain of thought', alternative: 'unsafe arbitrary field' } }],
  });
  assert.equal(rejected.content, null);
  assert.equal(rejected.source, null);
  assert.equal(rejected.shape.reasoningContent.present, true);
  assert.equal(rejected.shape.reasoningContent.kind, 'string');
  assert.equal(rejected.shape.content.kind, 'null');
  assert.equal(rejected.shape.alternativeText.present, false);
});

test('AnyModel transport accepts one complete OpenAI completion inside a terminated SSE envelope', () => {
  const payload = { choices: [{ finish_reason: 'stop', message: { content: 'complete public completion', reasoning_content: 'private' } }], usage: { total_tokens: 7 } };
  const result = parseAnyModelTransport(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n`, 'text/event-stream');
  assert.equal(result.protocol, 'sse_complete_completion');
  assert.equal(result.responseParseError, null);
  assert.equal(extractAnyModelCompletion(result.payload).content, 'complete public completion');
});

test('AnyModel Writer fails closed without a key and never attempts a network request', async () => {
  let calls = 0;
  const writer = new AnyModelCryptoWriter({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('must not be called without a configured key');
    },
  });

  assert.equal(await writer.initialize(), false);
  assert.equal(writer.status().provider, 'anymodel');
  assert.equal(writer.status().state, 'missing_key');
  assert.equal(writer.status().lastErrorCode, 'ANYMODEL_API_KEY_MISSING');
  assert.equal(calls, 0);
});

test('AnyModel Writer gives a long Kimi editorial stage enough bounded time to finish', () => {
  const writer = new AnyModelCryptoWriter({ apiKey: 'test-key' });
  assert.equal(writer.timeoutMs, 150_000);
});

test('AnyModel Writer applies bounded V5 budgets and an isolated no-retry diagnostic override', async () => {
  const calls = [];
  const v5Post = `$ALPHA has already made its point with +18.20% in 24 hours, so I am more interested in what happens when price has to defend the move.

8.80 is the first reaction, not the whole thesis. A controlled retest there would tell me buyers are still willing to absorb pressure; 10.00 only becomes relevant after that answer appears.

A break below 8.20 would damage the broader continuation read, not just make the next few candles untidy. Steady volume makes the response at the first level more useful than another green candle, so the practical read remains conditional.`;
  const v5FactPack = {
    ...factPack,
    levels: {
      supports: [...factPack.levels.supports, { id: 'level:invalidation', midpoint: 8.2, evidence: [{ timeframe: '4h' }] }],
      resistances: factPack.levels.resistances,
    },
    technicalEvidence: { structure: { '1h': { direction: 'up' } }, volume: { trend: 'contracting' } },
    derivatives: { openInterest: { accepted: false }, takerRatio: { accepted: false }, funding: { accepted: false } },
    traderEvidenceMap: {
      valid: true,
      firstReactionZone: { levelId: 'level:support:1', midpoint: 8.8, why: 'Immediate retest.' },
      structuralInvalidation: { levelId: 'level:invalidation', midpoint: 8.2, why: 'Loss ends the read.' },
      nextWatch: { levelId: 'level:resistance:1', midpoint: 10, why: 'Next boundary.' },
    },
  };
  const replies = [JSON.stringify({
    mainThesis: 'Continuation depends on the first reaction holding.',
    stance: 'constructive', certainty: 'measured', selectedEvidence: ['price_structure', 'volume'], counterEvidence: [],
    levelFocus: { immediate: 'local_reaction', structural: 'structural_invalidation', next: 'next_watch' }, previousThesisRelation: 'none',
  }), v5Post, v5Post.replace('has already made its point', 'is worth reading beyond the headline'), 'PASS'];
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: replies.shift() } }],
        usage: { prompt_tokens: 10, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 7 }, total_tokens: 22 },
      });
    },
  });

  const result = await writer.generateV5({
    factPack: v5FactPack,
    candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed, metrics: {} },
    diagnostic: { timeoutMs: 90_000, maxAttempts: 1 },
  });

  assert.equal(result.status, 'ready', JSON.stringify(result.audit.writerCandidates));
  assert.deepEqual(calls.map((call) => call.max_tokens), [900, 1_200, 1_200, 320]);
  assert.ok(writer.callAudit.every((call) => call.timeoutMs === 90_000 && call.maxAttempts === 1));
  assert.ok(writer.callAudit.every((call) => call.finishReason === 'stop'));
  assert.ok(writer.callAudit.every((call) => call.usage.reasoningTokens === 7 && call.usage.visibleOutputTokens === 5));
  assert.match(calls[0].messages[0].content, /not writing the post/i);
  assert.deepEqual(V5_STAGE_TOKEN_BUDGETS, { analyst_brain: 900, writer_reflection: 1200, writer_tension: 1200, critic: 320, repair: 1000 });
});

test('AnyModel Writer exposes a one-call diagnostic completion without invoking an editorial pipeline', async () => {
  let requests = 0;
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async () => {
      requests += 1;
      return jsonResponse({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    },
  });

  const result = await writer.generateDiagnosticCompletion({ prompt: 'Return exactly OK.', maxTokens: 16 });

  assert.equal(requests, 1);
  assert.equal(result.content, 'OK');
  assert.equal(result.audit.stage, 'diagnostic');
  assert.equal(result.audit.status, 'ok');
  assert.equal(result.audit.attempts, 1);
  assert.equal(result.audit.timeoutMs, 150_000);
  assert.ok(Number.isFinite(result.audit.headersLatencyMs));
  assert.ok(Number.isFinite(result.audit.totalDurationMs));
});

test('AnyModel Writer aborts a hanging SSE body instead of waiting forever after headers', async () => {
  let cancellations = 0;
  const hangingSseResponse = () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: {
      getReader() {
        return {
          read: async () => new Promise(() => {}),
          cancel: async () => { cancellations += 1; },
          releaseLock() {},
        };
      },
    },
  });
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    timeoutMs: 5,
    sleep: async () => {},
    fetchImpl: async () => hangingSseResponse(),
  });

  const outcome = await Promise.race([
    writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } })
      .then(() => ({ state: 'resolved' }), (error) => ({ state: 'rejected', code: error.code })),
    new Promise((resolve) => setTimeout(() => resolve({ state: 'still_pending' }), 250)),
  ]);

  assert.deepEqual(outcome, { state: 'rejected', code: 'ANYMODEL_TIMEOUT' });
  assert.equal(cancellations, 3);
});

test('AnyModel Writer uses the configured OpenAI-compatible endpoint and creates both candidates in one Writer request', async () => {
  const calls = [];
  const replies = [
    'THESIS: facts only\nWATCH: 10.00\nINVALIDATION: 8.80',
    thought,
    JSON.stringify({
      candidateA: { text: candidateA, thesis: 'The retest decides the story.', preferredScenario: '8.80 holds before 10.00.', invalidationClaimId: 'level:support:1', usedClaimIds: ['return24h'], usedLevelIds: ['level:support:1', 'level:resistance:1'] },
      candidateB: { text: candidateB, thesis: 'The first retest matters more than the percentage.', preferredScenario: '8.80 holds before 10.00.', invalidationClaimId: 'level:support:1', usedClaimIds: ['return24h'], usedLevelIds: ['level:support:1', 'level:resistance:1'] },
    }),
    'PASS',
  ];
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ choices: [{ message: { content: replies.shift() } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    },
  });

  const result = await writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });

  assert.equal(result.status, 'ready');
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.url === 'https://anymodel.org/v1/chat/completions'));
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer test-key'));
  assert.ok(calls.every((call) => JSON.parse(call.options.body).model === 'kmc/k3'));
  assert.match(JSON.parse(calls[2].options.body).messages[1].content, /candidateA/);
  assert.ok(calls.every((call) => JSON.parse(call.options.body).max_tokens >= 4_800), 'Kimi needs room for hidden reasoning before every editorial stage, not only the two-candidate draft');
  assert.equal(result.audit.provider.provider, 'anymodel');
  assert.equal(result.audit.provider.calls.filter((call) => call.stage === 'writer_candidates').length, 1);
  assert.deepEqual(result.audit.writerCandidateMetadata.candidateA.usedLevelIds, ['level:support:1', 'level:resistance:1']);
  assert.doesNotMatch(JSON.stringify(result.audit), /test-key/);
});

test('AnyModel Writer retries one 429 using Retry-After, then completes the same DRY_RUN package', async () => {
  const calls = [];
  const sleeps = [];
  const replies = [
    'THESIS: facts only\nWATCH: 10.00\nINVALIDATION: 8.80', thought,
    JSON.stringify({
      candidateA: { text: candidateA, thesis: 'Retest matters.', preferredScenario: '8.80 holds.', invalidationClaimId: 'level:support:1', usedClaimIds: ['return24h'], usedLevelIds: ['level:support:1', 'level:resistance:1'] },
      candidateB: { text: candidateB, thesis: 'Retest matters.', preferredScenario: '8.80 holds.', invalidationClaimId: 'level:support:1', usedClaimIds: ['return24h'], usedLevelIds: ['level:support:1', 'level:resistance:1'] },
    }), 'PASS',
  ];
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key', sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async () => {
      calls.push('request');
      if (calls.length === 1) return jsonResponse({ error: { message: 'slow down' } }, { status: 429, headers: { 'retry-after': '2' } });
      return jsonResponse({ choices: [{ message: { content: replies.shift() } }] });
    },
  });

  const result = await writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });

  assert.equal(result.status, 'ready');
  assert.equal(calls.length, 5);
  assert.deepEqual(sleeps, [2_000]);
});

test('AnyModel Writer makes one additional bounded retry when the Kimi upstream terminates a connection', async () => {
  const sleeps = [];
  let calls = 0;
  const replies = [
    'THESIS: facts only\nWATCH: 10.00\nINVALIDATION: 8.80', thought,
    JSON.stringify({
      candidateA: { text: candidateA, thesis: 'Retest matters.', preferredScenario: '8.80 holds.', invalidationClaimId: 'level:support:1', usedClaimIds: ['return24h'], usedLevelIds: ['level:support:1', 'level:resistance:1'] },
      candidateB: { text: candidateB, thesis: 'Retest matters.', preferredScenario: '8.80 holds.', invalidationClaimId: 'level:support:1', usedClaimIds: ['return24h'], usedLevelIds: ['level:support:1', 'level:resistance:1'] },
    }), 'PASS',
  ];
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      if (calls <= 2) throw new TypeError('terminated');
      return jsonResponse({ choices: [{ message: { content: replies.shift() } }] });
    },
  });

  const result = await writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });

  assert.equal(result.status, 'ready');
  assert.equal(calls, 6);
  assert.deepEqual(sleeps, [300, 600]);
});

test('AnyModel Writer does not retry an authentication failure and preserves the safe error code', async () => {
  let calls = 0;
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: { message: 'invalid key' } }, { status: 401 });
    },
  });

  await assert.rejects(
    () => writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } }),
    (error) => error.code === 'ANYMODEL_AUTH_FAILED' && error.retryable === false,
  );
  assert.equal(calls, 1);
  assert.equal(writer.status().lastErrorCode, 'ANYMODEL_AUTH_FAILED');
});

test('AnyModel Writer fails fast with a quota code when the provider returns HTTP 402', async () => {
  let calls = 0;
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: { type: 'billing_error', code: 'payment_required', message: 'quota exhausted' } }, { status: 402 });
    },
  });

  await assert.rejects(
    () => writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } }),
    (error) => error.code === 'ANYMODEL_QUOTA_EXHAUSTED' && error.retryable === false,
  );
  assert.equal(calls, 1);
  assert.equal(writer.status().lastErrorCode, 'ANYMODEL_QUOTA_EXHAUSTED');
});

test('AnyModel Writer rejects a malformed completion payload without retrying or treating it as editorial content', async () => {
  let calls = 0;
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'private' } }], usage: { prompt_tokens: 4, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 8 } } });
    },
  });

  await assert.rejects(
    () => writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } }),
    (error) => error.code === 'ANYMODEL_INVALID_RESPONSE' && error.retryable === false,
  );
  assert.equal(calls, 1);
  assert.equal(writer.callAudit[0].finishReason, 'length');
  assert.equal(writer.callAudit[0].usage.reasoningTokens, 8);
  assert.equal(writer.callAudit[0].usage.visibleOutputTokens, 1);
  assert.equal(writer.callAudit[0].contentPresent, false);
});

test('AnyModel Writer saves a complete sanitized diagnostic response when its whitelisted completion shapes do not match', async () => {
  const diagnosticDirectory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-anymodel-response-'));
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    diagnosticDirectory,
    fetchImpl: async () => jsonResponse({
      id: 'chatcmpl-test',
      choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'private model reasoning' } }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
    }, { headers: { 'x-request-id': 'request-test', 'set-cookie': 'session=private' } }),
  });

  await assert.rejects(
    () => writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } }),
    (error) => error.code === 'ANYMODEL_INVALID_RESPONSE',
  );

  const files = await readdir(diagnosticDirectory);
  assert.equal(files.length, 1);
  const artifact = JSON.parse(await readFile(path.join(diagnosticDirectory, files[0]), 'utf8'));
  assert.equal(artifact.http.status, 200);
  assert.equal(artifact.http.headers['set-cookie'], '[REDACTED]');
  assert.equal(artifact.response.choices[0].finish_reason, 'length');
  assert.equal(artifact.response.choices[0].message.reasoning_content, 'private model reasoning');
  assert.equal(artifact.completionShape.reasoningContent.present, true);
  assert.doesNotMatch(JSON.stringify(artifact), /test-key/);
});

test('AnyModel Writer records a sanitized transport failure when no HTTP response exists', async () => {
  const diagnosticDirectory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-anymodel-transport-failure-'));
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    diagnosticDirectory,
    captureResponseDiagnostics: false,
    sleep: async () => {},
    fetchImpl: async () => {
      const error = new TypeError('socket disconnected while sending Bearer test-key');
      error.code = 'ECONNRESET';
      throw error;
    },
  });

  await assert.rejects(
    () => writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } }),
    (error) => error.code === 'ANYMODEL_UNAVAILABLE' && Boolean(error.diagnosticPath),
  );

  const files = await readdir(diagnosticDirectory);
  assert.equal(files.length, 3);
  const artifact = JSON.parse(await readFile(path.join(diagnosticDirectory, files[0]), 'utf8'));
  assert.equal(artifact.kind, 'anymodel_transport_failure');
  assert.equal(artifact.http.status, null);
  assert.equal(artifact.error.code, 'ECONNRESET');
  assert.match(artifact.error.message, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(artifact), /test-key/);
});

test('AnyModel Writer preserves a non-JSON response body for transport diagnosis instead of discarding it', async () => {
  const diagnosticDirectory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-anymodel-stream-'));
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    diagnosticDirectory,
    fetchImpl: async () => textResponse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n'),
  });

  await assert.rejects(
    () => writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } }),
    (error) => error.code === 'ANYMODEL_INVALID_RESPONSE',
  );

  const files = await readdir(diagnosticDirectory);
  const artifact = JSON.parse(await readFile(path.join(diagnosticDirectory, files[0]), 'utf8'));
  assert.equal(artifact.response, null);
  assert.equal(artifact.responseParseError, 'UNSUPPORTED_SSE_SHAPE');
  assert.match(artifact.rawBody, /^data: /);
  assert.equal(artifact.transportShape.streamingEnvelope, true);
});

test('AnyModel Writer uses exactly one bounded format repair for malformed candidate JSON', async () => {
  const stages = [];
  const replies = [
    'THESIS: facts only\nWATCH: 10.00\nINVALIDATION: 8.80', thought, 'not json',
    JSON.stringify({
      candidateA: { text: candidateA, thesis: 'Retest matters.', preferredScenario: '8.80 holds.', invalidationClaimId: 'level:support:1', usedClaimIds: ['return24h'], usedLevelIds: ['level:support:1', 'level:resistance:1'] },
      candidateB: { text: candidateB, thesis: 'Retest matters.', preferredScenario: '8.80 holds.', invalidationClaimId: 'level:support:1', usedClaimIds: ['return24h'], usedLevelIds: ['level:support:1', 'level:resistance:1'] },
    }), 'PASS',
  ];
  const writer = new AnyModelCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      stages.push(body.messages[0].content);
      return jsonResponse({ choices: [{ message: { content: replies.shift() } }] });
    },
  });

  const result = await writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });

  assert.equal(result.status, 'ready');
  assert.equal(result.audit.provider.calls.filter((call) => call.stage === 'writer_candidates_format_repair').length, 1);
  assert.equal(stages.filter((system) => /Return valid JSON only/.test(system)).length, 1);
});
