import test from 'node:test';
import assert from 'node:assert/strict';

import { OPENROUTER_CRYPTO_SYSTEM_PROMPT, OpenRouterCryptoWriter } from '../src/crypto/content/openrouter-writer.js';

const candidate = {
  id: 'ena-runner', symbol: 'ENAUSDT', token: 'ENA', cashtag: '$ENA', occurredAt: 1_724_155_200_000,
  claimsAllowed: [
    { key: 'return24h', display: '+46.88%', timeframe: '24h' },
    { key: 'return15m', display: '+2.03%', timeframe: '15m' },
    { key: 'volumeRatio', display: '4.80x', timeframe: '5m' },
  ],
  metrics: { return24hPct: 46.88, return15mPct: 2.03, volumeRatio: 4.8 },
};

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function postResponse(post) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'POST', post, reason: '' }) } }] });
}

test('OpenRouter Writer prompt requires correct nested-window interpretation and bans generic disclaimers', () => {
  assert.match(OPENROUTER_CRYPTO_SYSTEM_PROMPT, /shorter recent window has a substantially stronger return/i);
  assert.match(OPENROUTER_CRYPTO_SYSTEM_PROMPT, /recent acceleration/i);
  assert.match(OPENROUTER_CRYPTO_SYSTEM_PROMPT, /Past performance, no guarantee of tomorrow/i);
  assert.match(OPENROUTER_CRYPTO_SYSTEM_PROMPT, /Do not casually describe positive or negative returns as "flat"/i);
});

test('OpenRouter writer sends the configured MiniMax model, compact verified facts, and the key only in Authorization', async () => {
  const calls = [];
  const writer = new OpenRouterCryptoWriter({
    apiKey: 'super-secret-key',
    model: 'minimax/minimax-m3:free',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return postResponse('$ENA is up almost 47% over 24 hours — and the latest 15 minutes added another +2.03%.\n\nThat is a huge daily move getting faster, not slowly fading out.\n\n4.80x normal volume hit in 5 minutes.\n\nENA did not merely run. It found another gear.');
    },
  });

  const result = await writer.generate({ candidate, editorialHistory: [{ text: '$BTC moved.', marketStoryCluster: 'old' }] });

  assert.equal(result.status, 'ready');
  assert.equal(result.content.decision, 'publish');
  assert.equal(result.content.cashtag, '$ENA');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer super-secret-key');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'minimax/minimax-m3:free');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 220);
  assert.equal(Object.hasOwn(body, 'response_format'), false);
  assert.match(body.messages[1].content, /\+46\.88%/);
  assert.match(body.messages[1].content, /\+2\.03%/);
  assert.equal(body.messages[1].content.includes('super-secret-key'), false);
  assert.equal(JSON.stringify(writer.status()).includes('super-secret-key'), false);
});

test('OpenRouter writer accepts an explicit model SKIP without fabricating a post', async () => {
  const writer = new OpenRouterCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'SKIP', post: '', reason: 'EVENT_NOT_INTERESTING_ENOUGH' }) } }] }),
  });

  assert.deepEqual(await writer.generate({ candidate }), {
    status: 'skip', reason: 'EVENT_NOT_INTERESTING_ENOUGH', provider: 'openrouter', model: 'minimax/minimax-m3:free',
  });
});

test('OpenRouter writer accepts the provider’s plain-text POST contract', async () => {
  const writer = new OpenRouterCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '$ENA is up +46.88% over 24 hours. The latest 15 minutes added +2.03%, while 4.80x normal volume hit in 5 minutes. ENA found another gear, and the move is still accelerating.' } }] }),
  });
  assert.equal((await writer.generate({ candidate })).status, 'ready');
});

test('OpenRouter writer recognizes the free provider’s { skip: true } response as an explicit skip', async () => {
  const writer = new OpenRouterCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '{"skip":true}' } }] }),
  });
  assert.equal((await writer.generate({ candidate })).status, 'skip');
});

test('OpenRouter writer fails closed on a non-post plain-text response and never falls back to Codex', async () => {
  const writer = new OpenRouterCryptoWriter({ apiKey: 'test-key', fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'not-json' } }] }) });
  assert.deepEqual(await writer.generate({ candidate }), {
    status: 'skip', reason: 'WRITER_LENGTH_INVALID', provider: 'openrouter', model: 'minimax/minimax-m3:free',
  });
});

test('OpenRouter writer enters Retry-After cooldown on 429 without sending another request', async () => {
  let now = 1_000;
  let calls = 0;
  const writer = new OpenRouterCryptoWriter({
    apiKey: 'test-key', now: () => now,
    fetchImpl: async () => { calls += 1; return jsonResponse({ error: { message: 'slow down' } }, { status: 429, headers: { 'retry-after': '12' } }); },
  });
  await assert.rejects(() => writer.generate({ candidate }), (error) => error.code === 'OPENROUTER_RATE_LIMITED' && error.retryAfterMs === 12_000);
  assert.equal(writer.status().state, 'cooldown');
  now += 1_000;
  await assert.rejects(() => writer.generate({ candidate }), (error) => error.code === 'OPENROUTER_COOLDOWN');
  assert.equal(calls, 1);
});

test('OpenRouter writer makes at most one bounded retry for a temporary 5xx failure', async () => {
  let calls = 0;
  const writer = new OpenRouterCryptoWriter({
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: { message: 'temporary' } }, { status: 503 })
        : postResponse('$ENA is up +46.88% over 24 hours.\n\nThe latest 15 minutes added another +2.03%, so the move is still accelerating.\n\n4.80x normal volume hit in 5 minutes.\n\nENA found another gear.');
    },
  });
  assert.equal((await writer.generate({ candidate })).status, 'ready');
  assert.equal(calls, 2);
});

test('OpenRouter writer fails closed when its request times out', async () => {
  const writer = new OpenRouterCryptoWriter({
    apiKey: 'test-key', timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))),
  });
  await assert.rejects(() => writer.generate({ candidate }), (error) => error.code === 'OPENROUTER_TIMEOUT');
});
