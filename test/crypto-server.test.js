import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createJarvisHttpServer } from '../src/server.js';

const jarvis = {
  activeThreadId: null,
  status: () => ({ state: 'idle', detail: 'ready' }),
  subscribe: () => () => {},
};

const CRYPTO_THREAD_ID = '11111111-1111-4111-8111-111111111111';

class FakeCryptoRuntime {
  constructor({ dryRunResult, dryRunError } = {}) { this.listener = null; this.calls = []; this.dryRunResult = dryRunResult; this.dryRunError = dryRunError; }
  subscribe(listener) { this.listener = listener; return () => { this.listener = null; }; }
  async status() { return { mode: 'DRY_RUN', scanner: 'running', autoReady: false, squareCredentialConfigured: false, threadId: CRYPTO_THREAD_ID }; }
  async isThread(threadId) { return threadId === CRYPTO_THREAD_ID; }
  async manualTurnContext() {
    return { 'crypto.playbook': { kind: 'application', value: 'PLAYBOOK CORE' } };
  }
  async setMode(mode) {
    this.calls.push(['setMode', mode]);
    if (mode === 'AUTO') throw new Error('AUTO requires a successful live DRY_RUN.');
    return { ...(await this.status()), mode };
  }
  async runLiveDryRun() {
    this.calls.push(['runLiveDryRun']);
    if (this.dryRunError) throw this.dryRunError;
    return this.dryRunResult || { ok: true, liveSymbols: ['BTCUSDT', 'ETHUSDT'], autoReady: true, autoArmed: false, publishBlocked: 'manual_confirmation_required' };
  }
  async runHistoricalReplay(options) { this.calls.push(['runHistoricalReplay', options]); return { mode: 'historical_replay', publication: { attempted: false, published: 0 } }; }
  async resetPostLimit() { this.calls.push(['resetPostLimit']); return { ...(await this.status()), posts24h: 0, maxPosts24h: 10, slotsRemaining: 10 }; }
  async confirmAutoArm() { this.calls.push(['confirmAutoArm']); return { ...(await this.status()), autoArmed: true }; }
  resolveChart(filename) {
    if (filename !== 'candidate-1.png') throw new Error('Invalid chart');
    return new URL('../public/favicon.svg', import.meta.url);
  }
}

async function withServer(run, overrides = {}) {
  const cryptoRuntime = overrides.cryptoRuntime || new FakeCryptoRuntime();
  const server = createJarvisHttpServer({
    jarvis: overrides.jarvis || jarvis,
    cryptoRuntime,
    attachmentStore: overrides.attachmentStore || {},
    transcriptionService: {},
    publicDirectory: new URL('../public/', import.meta.url),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, cryptoRuntime); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('crypto status and safe mode controls are native local routes', async () => {
  await withServer(async (baseUrl, crypto) => {
    const status = await fetch(`${baseUrl}/api/crypto/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).mode, 'DRY_RUN');
    const mode = await fetch(`${baseUrl}/api/crypto/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'OFF' }) });
    assert.equal(mode.status, 200);
    assert.equal((await mode.json()).mode, 'OFF');
    assert.deepEqual(crypto.calls, [['setMode', 'OFF']]);
  });
});

test('AUTO readiness failures are explicit conflicts, not generic 500s', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/crypto/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'AUTO' }) });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error.code, 'CRYPTO_MODE_CONFLICT');
    assert.doesNotMatch(JSON.stringify(body), /key|token|secret/i);
  });
});

test('live DRY_RUN has an explicit non-publishing route', async () => {
  await withServer(async (baseUrl, crypto) => {
    const response = await fetch(`${baseUrl}/api/crypto/dry-run`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, liveSymbols: ['BTCUSDT', 'ETHUSDT'], autoReady: true, autoArmed: false, publishBlocked: 'manual_confirmation_required' });
    assert.deepEqual(crypto.calls, [['runLiveDryRun']]);
  });
});

test('live DRY_RUN exposes editorial skips as successful structured results', async () => {
  const cryptoRuntime = new FakeCryptoRuntime({
    dryRunResult: { success: true, result: 'EDITORIAL_SKIP', symbol: 'DOGEUSDT', reason: 'NO_CANDIDATE_WITH_EDITORIAL_MERIT', wouldPublish: false },
  });
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/crypto/dry-run`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, result: 'EDITORIAL_SKIP', symbol: 'DOGEUSDT', reason: 'NO_CANDIDATE_WITH_EDITORIAL_MERIT', wouldPublish: false });
  }, { cryptoRuntime });
});

test('live DRY_RUN keeps technical failures as 503', async () => {
  const cryptoRuntime = new FakeCryptoRuntime({ dryRunError: new Error('Codex App Server stopped.') });
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/crypto/dry-run`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'CRYPTO_DRY_RUN_FAILED');
  }, { cryptoRuntime });
});

test('historical replay is explicitly non-publishing and bounded', async () => {
  await withServer(async (baseUrl, crypto) => {
    const response = await fetch(`${baseUrl}/api/crypto/replay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 8, lookbackDays: 21 }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).publication.published, 0);
    assert.deepEqual(crypto.calls, [['runHistoricalReplay', { count: 8, lookbackDays: 21, regressionSet: false }]]);
    const invalid = await fetch(`${baseUrl}/api/crypto/replay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 13 }) });
    assert.equal(invalid.status, 422);
  });
});

test('AUTO arming has a separate explicit confirmation route', async () => {
  await withServer(async (baseUrl, crypto) => {
    const response = await fetch(`${baseUrl}/api/crypto/confirm-auto`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).autoArmed, true);
    assert.deepEqual(crypto.calls, [['confirmAutoArm']]);
  });
});

test('manual post-limit reset is an explicit local Crypto route', async () => {
  await withServer(async (baseUrl, crypto) => {
    const response = await fetch(`${baseUrl}/api/crypto/reset-post-limit`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { mode: 'DRY_RUN', scanner: 'running', autoReady: false, squareCredentialConfigured: false, threadId: CRYPTO_THREAD_ID, posts24h: 0, maxPosts24h: 10, slotsRemaining: 10 });
    assert.deepEqual(crypto.calls, [['resetPostLimit']]);
  });
});

test('AUTO manual override route accepts only an explicit force flag', async () => {
  class ForceRuntime extends FakeCryptoRuntime {
    async confirmAutoArm(options) { this.calls.push(['confirmAutoArm', options]); return { ...(await this.status()), mode: 'AUTO', autoArmed: true, manualAutoOverride: true }; }
  }
  await withServer(async (baseUrl, crypto) => {
    const plain = await fetch(`${baseUrl}/api/crypto/confirm-auto`, { method: 'POST' });
    assert.equal(plain.status, 200);
    const forced = await fetch(`${baseUrl}/api/crypto/confirm-auto`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) });
    assert.equal(forced.status, 200);
    assert.equal((await forced.json()).manualAutoOverride, true);
    assert.deepEqual(crypto.calls, [['confirmAutoArm', undefined], ['confirmAutoArm', { force: true }]]);
  }, { cryptoRuntime: new ForceRuntime() });
});

test('shared SSE emits typed crypto activity without impersonating a chat message', async () => {
  await withServer(async (baseUrl, crypto) => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    crypto.listener({ eventId: 'e1', type: 'anomaly_detected', threadId: CRYPTO_THREAD_ID, occurredAt: '2026-08-20T12:00:00.000Z', schemaVersion: 1, source: 'test', payload: { symbol: 'BTCUSDT' } });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    assert.match(chunk, /"type":"crypto-activity"/);
    assert.match(chunk, /"eventType":"anomaly_detected"/);
    assert.match(chunk, new RegExp(`"threadId":"${CRYPTO_THREAD_ID}"`));
    assert.doesNotMatch(chunk, /user-message|assistant-message/);
  });
});

test('persistent Crypto thread cannot be renamed or deleted through ordinary thread routes', async () => {
  const calls = [];
  const localJarvis = {
    ...jarvis,
    async renameThread(threadId) { calls.push(['rename', threadId]); return {}; },
    async deleteThread(threadId) { calls.push(['delete', threadId]); return {}; },
  };
  await withServer(async (baseUrl) => {
    const renamed = await fetch(`${baseUrl}/api/threads/${CRYPTO_THREAD_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Other' }),
    });
    const deleted = await fetch(`${baseUrl}/api/threads/${CRYPTO_THREAD_ID}`, { method: 'DELETE' });
    assert.equal(renamed.status, 409);
    assert.equal(deleted.status, 409);
    assert.deepEqual(calls, []);
  }, { jarvis: localJarvis, attachmentStore: { removeThread: async () => { throw new Error('must not clean'); } } });
});

test('manual messages in Crypto use the same thread with application context and no synthetic user event', async () => {
  const sends = [];
  const localJarvis = {
    ...jarvis,
    async send(request) { sends.push(request); return { accepted: true, disposition: 'started', threadId: request.threadId, queue: [] }; },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/threads/${CRYPTO_THREAD_ID}/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Explain this setup', attachmentIds: [] }),
    });
    assert.equal(response.status, 202);
    assert.equal(sends[0].threadId, CRYPTO_THREAD_ID);
    assert.equal(sends[0].source, 'crypto');
    assert.match(sends[0].additionalContext['crypto.playbook'].value, /PLAYBOOK/);
  }, {
    jarvis: localJarvis,
    attachmentStore: { resolveForTurn: async () => [] },
  });
});

test('server exposes the local crypto UI module', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/crypto-ui.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
  });
});

test('chart previews are served through a path-safe no-store route without exposing local paths', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/crypto/chart/candidate-1.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.ok((await response.arrayBuffer()).byteLength > 0);

    const missing = await fetch(`${baseUrl}/api/crypto/chart/not-present.png`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /Users|data[\\/]crypto|favicon/i);
  });
});
