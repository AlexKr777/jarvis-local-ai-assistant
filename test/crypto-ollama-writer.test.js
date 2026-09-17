import test from 'node:test';
import assert from 'node:assert/strict';

import { OllamaCryptoWriter, validateGemmaPostContract } from '../src/crypto/content/ollama-writer.js';

const candidate = {
  id: 'ena-runner', symbol: 'ENAUSDT', token: 'ENA', cashtag: '$ENA', occurredAt: 1_724_155_200_000,
  claimsAllowed: [
    { key: 'return24h', display: '+46.88%', timeframe: '24h' },
    { key: 'return15m', display: '+2.03%', timeframe: '15m' },
    { key: 'return1h', display: '+0.72%', timeframe: '1h' },
  ],
  metrics: { return24hPct: 46.88, return15mPct: 2.03, return1hPct: 0.72 },
};

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('Ollama Writer calls only the local chat endpoint with Gemma settings and no authorization header', async () => {
  const calls = [];
  const writer = new OllamaCryptoWriter({
    model: 'gemma4:12b-it-q4_K_M',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'gemma4:12b-it-q4_K_M' }] });
      if (url.endsWith('/api/chat')) return jsonResponse({ message: { content: '$ENA is up +46.88% today — and the latest 15 minutes beat the full hour.\n\nENA added +2.03% in 15 minutes while the full 1-hour result was +0.72%.\n\nA huge daily move just accelerated again.\n\nDid you catch this move, or are you watching from the sidelines?' }, done: true });
      return jsonResponse({ message: { content: '$ENA is up 46.88% today — and the latest 15 minutes outpaced the entire hour.\n\nENA added +2.03% in 15 minutes while the full hour is only +0.72%.\n\nA 47% day just found another gear.' }, done: true });
    },
  });

  const result = await writer.generate({ candidate });

  assert.equal(result.status, 'ready');
  assert.equal(result.provider, 'ollama');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/tags');
  assert.equal(calls[1].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[1].options.headers.Authorization, undefined);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.model, 'gemma4:12b-it-q4_K_M');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.options, { num_ctx: 4096, temperature: 1.0, top_p: 0.95, top_k: 64, num_predict: 220 });
});

test('Ollama Writer activates the v4 planner, two writer strategies and critic through local Gemma', async () => {
  const replies = [
    'THESIS: Hold 8.80.\nWATCH: 10.00\nINVALIDATION: 8.80',
    'INITIAL: I expected the daily gain to carry straight through resistance.\nCHANGE: The retest at 8.80 matters more than another green candle.\nLEVEL_REASON: 8.80 matters because buyers must defend it after price returns there.\nBUYER_SELLER: Sellers should fail to push price below 8.80 on the retest.\nPREFERRED: I prefer a defended retest before treating 10.00 as live.\nINVALIDATION: A close below 8.80 makes me drop the continuation case.\nNEXT: I expect buyers to test 10.00 after 8.80 is defended.\nMISSED: The first retest says more than the daily percentage.\nCAUTION: I remain cautious until buyers answer that retest.',
    '$ALPHA is up +18.20% over 24 hours, but that number is not why I am taking the move seriously. I need 8.80 to hold when price comes back; otherwise the day-high print means very little to me.\n\nIf that retest is absorbed, 10.00 is the next level I would watch. Below 8.80, I would stop treating it as continuation.',
    'With $ALPHA up +18.20% in 24 hours, I am more interested in the first pullback than the headline itself. A defence of 8.80 would tell me buyers are still present when the easy part of the move is gone.\n\nOnly then does 10.00 become my next reference. A break under 8.80 ends the continuation case for me.',
    'PASS',
  ];
  const requests = [];
  const writer = new OllamaCryptoWriter({ fetchImpl: async (url, options) => {
    if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'gemma4:12b-it-q4_K_M' }] });
    requests.push(JSON.parse(options.body));
    return jsonResponse({ message: { content: replies.shift() } });
  } });
  const factPack = {
    identity: { symbol: 'ALPHAUSDT', cashtag: '$ALPHA' }, ranking: { top10Rank: 1, change24h: '+18.20%' },
    market: { currentPrice: 10, range24h: {} }, levels: { supports: [{ id: 'level:support:1', midpoint: 8.8, evidence: [{}] }], resistances: [{ id: 'level:resistance:1', midpoint: 10, evidence: [{}] }] },
    numbersAllowed: [{ key: 'return24h', display: '+18.20%', timeframe: '24h' }], research: { status: 'none_found', sources: [], claims: [] }, chartInputs: { candles: {}, volumes: {}, eventMarkers: [] },
  };
  const result = await writer.generateV4({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });
  assert.equal(result.status, 'ready');
  assert.equal(result.audit.critic.verdict, 'PASS');
  const writerRequests = requests.filter((request) => /social writer/.test(request.messages[0].content));
  const thoughtRequest = requests.find((request) => /private trader-reasoning engine/.test(request.messages[0].content));
  assert.equal(writerRequests.length, 2);
  assert.ok(writerRequests.every((request) => /two to five deliberately uneven human paragraphs/.test(request.messages[0].content)));
  assert.ok(writerRequests.every((request) => request.options.num_predict === 360));
  assert.equal(thoughtRequest.options.temperature, 0.25);
  assert.equal(thoughtRequest.options.num_predict, 520);
  assert.match(thoughtRequest.messages[0].content, /each 8 to 22 words/);
  assert.ok(writerRequests.every((request) => /PRIVATE STORY BRIEF/.test(request.messages[1].content)));
  assert.ok(writerRequests.every((request) => !/BUYER_SELLER:/.test(request.messages[1].content)));
});

test('Ollama Writer gives a verified second post its own continuation brief without inventing a personal trade', async () => {
  const calls = [];
  const writer = new OllamaCryptoWriter({
    fetchImpl: async (url, options) => {
      if (options) calls.push({ url, options });
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'gemma4:12b-it-q4_K_M' }] });
      return jsonResponse({ message: { content: '$ENA is still climbing after +46.88% today.\n\nThe latest 15 minutes added +2.03%, above the +0.72% from the full hour.\n\nThe first jump did not fade.\n\nDid you catch the follow-up, or are you still watching this run?' } });
    },
  });

  const result = await writer.generate({ candidate: { ...candidate, publicationSequence: 2, verifiedContinuation: true } });
  const body = JSON.parse(calls.at(-1).options.body);
  const eventPackage = JSON.parse(body.messages[1].content.replace(/^VERIFIED EVENT PACKAGE\s*/, '').replace(/\n\nWrite the one final post\.$/, ''));
  const thirdResult = await writer.generate({ candidate: { ...candidate, publicationSequence: 3, verifiedContinuation: true } });
  const thirdBody = JSON.parse(calls.at(-1).options.body);
  const thirdEventPackage = JSON.parse(thirdBody.messages[1].content.replace(/^VERIFIED EVENT PACKAGE\s*/, '').replace(/\n\nWrite the one final post\.$/, ''));

  assert.equal(result.status, 'ready');
  assert.equal(thirdResult.status, 'ready');
  assert.deepEqual(eventPackage.publicationSeries, { postNumber: 2, verifiedContinuation: true });
  assert.deepEqual(thirdEventPackage.publicationSeries, { postNumber: 3, verifiedContinuation: true });
  assert.match(eventPackage.writingBrief, /considering an entry/i);
  assert.match(thirdEventPackage.writingBrief, /watchlist/i);
  assert.match(eventPackage.writingBrief, /unfolding move/i);
  assert.match(eventPackage.writingBrief, /paragraph 3 must use a first-person watchlist voice/i);
  assert.match(eventPackage.writingBrief, /paragraph 3 must start with "i'm" or "i am"/i);
  assert.match(body.messages[0].content, /watchlist point of view/i);
  assert.match(body.messages[0].content, /question of timing/i);
  assert.match(body.messages[0].content, /paragraph 3 must use a first-person watchlist voice/i);
  assert.match(body.messages[0].content, /paragraph 4 must contain only the reader question/i);
  assert.match(body.messages[0].content, /never imply the author bought, sold, held, or profited/i);
});

test('Ollama Writer marks the local service offline after one failed health check and one bounded recovery attempt', async () => {
  let spawns = 0;
  const writer = new OllamaCryptoWriter({
    fetchImpl: async () => { throw new Error('connection refused'); },
    spawnImpl: () => { spawns += 1; return { unref() {} }; },
    sleep: async () => {},
  });

  assert.equal(await writer.initialize(), false);
  assert.equal(writer.status().state, 'offline');
  assert.equal(spawns, 1);
  assert.equal(await writer.initialize(), false);
  assert.equal(spawns, 1);
});

test('Ollama Writer fails closed on an unavailable local service and never uses a cloud fallback', async () => {
  const writer = new OllamaCryptoWriter({ fetchImpl: async () => { throw new Error('connection refused'); }, sleep: async () => {} });
  await assert.rejects(() => writer.generate({ candidate }), (error) => error.code === 'OLLAMA_UNAVAILABLE');
  assert.equal(writer.status().provider, 'ollama');
});

test('Ollama Writer rejects a missing cashtag or known template language before the factual pipeline', async () => {
  const replies = [
    `$ENA is up +46.88% today — and the latest 15 minutes beat the full hour.

The broader daily trend remains strong after +2.03% in 15m and +0.72% in 1h.

A big move accelerated again.

Another push, or a cooldown first?`,
    `ENA is up +46.88% today — and the latest 15 minutes beat the full hour.

ENA added +2.03% in 15m while the full 1-hour result was +0.72%.

A big move accelerated again.

Another push, or a cooldown first?`,
  ];
  const writer = new OllamaCryptoWriter({
    fetchImpl: async (url) => url.endsWith('/api/tags')
      ? jsonResponse({ models: [{ name: 'gemma4:12b-it-q4_K_M' }] })
      : jsonResponse({ message: { content: replies.shift() } }),
  });
  const template = await writer.generate({ candidate });
  const missingCashtag = await writer.generate({ candidate });
  assert.equal(template.status, 'skip');
  assert.equal(template.reason, 'WRITER_CONTRACT_BANNED_LANGUAGE');
  assert.equal(missingCashtag.status, 'skip');
  assert.equal(missingCashtag.reason, 'WRITER_CONTRACT_CASHTAG_INVALID');
});

test('strict Gemma contract accepts exactly four normalized paragraphs and rejects malformed or slop posts', () => {
  const valid = validateGemmaPostContract(`  $ENA is up +46.88% today — and the latest 15 minutes beat the full hour.


ENA added +2.03% in 15 minutes while the full 1-hour result was +0.72%.

A huge daily move just accelerated again.

Did you catch this move, or are you watching from the sidelines?  `, candidate);
  assert.equal(valid.ok, true);
  assert.equal(valid.text.split('\n\n').length, 4);

  const malformed = validateGemmaPostContract('$ENA is up +46.88% today.\n\nWatch the move.', candidate);
  assert.equal(malformed.ok, false);
  assert.ok(malformed.errors.includes('paragraph_count_invalid'));
  assert.ok(malformed.errors.includes('ending_question_invalid'));
  assert.ok(malformed.errors.includes('banned_language'));
});

test('strict Gemma contract requires the final A/B question to address the reader directly', () => {
  const detachedQuestion = validateGemmaPostContract(`$ENA is up +46.88% today — and the latest 15 minutes beat the full hour.

ENA added +2.03% in 15 minutes while the full 1-hour result was +0.72%.

A huge daily move just accelerated again.

Another push from here, or a cooldown first?`, candidate);

  assert.equal(detachedQuestion.ok, false);
  assert.ok(detachedQuestion.errors.includes('reader_question_invalid'));
});

test('runner copy is accepted without a magic bullish-scenario phrase when its payoff is factual', () => {
  const scenarioCandidate = { ...candidate, freshUpsideImpulsePriority: true };
  const generic = validateGemmaPostContract(`$ENA is up +46.88% today — and the latest 15 minutes beat the full hour.

ENA added +2.03% in 15 minutes while the full 1-hour result was +0.72%.

A huge daily move just accelerated again.

Did you catch this move, or are you watching from the sidelines?`, scenarioCandidate);
  const compliant = validateGemmaPostContract(`$ENA is up +46.88% today — and the latest 15 minutes beat the full hour.

ENA added +2.03% in 15 minutes while the full 1-hour result was +0.72%.

I'm watching this as a bullish scenario, not a certainty.

Did you catch this move, or are you watching from the sidelines?`, scenarioCandidate);

  assert.equal(generic.ok, true);
  assert.ok(!generic.errors.includes('bullish_scenario_opinion_missing'));
  assert.equal(compliant.ok, true);
});
