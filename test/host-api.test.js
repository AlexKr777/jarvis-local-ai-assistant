import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createJarvisHttpServer } from '../src/server.js';

const TOKEN = 'a'.repeat(64);
const COMMAND_ID = '650e8400-e29b-41d4-a716-446655440000';

class FakeJarvis {
  status() { return { state: 'idle', detail: 'ready' }; }
  subscribe() { return () => {}; }
}

class FakeAttachments {}

class FakeTranscription {
  constructor() { this.calls = []; }
  async transcribe(input) { this.calls.push(input); return { text: 'Открой Downloads', durationMs: 900, language: 'ru' }; }
}

class FakeVoiceRuntime {
  constructor() { this.calls = []; }
  snapshot() { return { state: 'idle', paused: false, pendingApproval: null }; }
  status(commandId) { this.calls.push(['status', commandId]); return { commandId, state: 'success' }; }
  async submitTranscript(transcript) {
    this.calls.push(['submitTranscript', transcript]);
    return { kind: 'command', commandId: COMMAND_ID, state: 'executing' };
  }
  setPaused(paused) { this.calls.push(['setPaused', paused]); return this.snapshot(); }
}

async function withHostServer(run, options = {}) {
  const transcriptionService = new FakeTranscription();
  const voiceRuntime = new FakeVoiceRuntime();
  let shutdowns = 0;
  const server = createJarvisHttpServer({
    jarvis: new FakeJarvis(),
    attachmentStore: new FakeAttachments(),
    transcriptionService,
    voiceRuntime,
    hostToken: options.hostToken === undefined ? TOKEN : options.hostToken,
    onHostShutdown: () => { shutdowns += 1; },
    publicDirectory: new URL('../public/', import.meta.url),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl, { voiceRuntime, transcriptionService, getShutdowns: () => shutdowns });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(baseUrl, pathname, { method = 'GET', body, token = TOKEN } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test('host API is unavailable without a configured session secret and rejects missing/wrong bearer auth', async () => {
  await withHostServer(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/host/status`);
    assert.equal(missing.status, 401);
    const wrong = await request(baseUrl, '/api/host/status', { token: 'b'.repeat(64) });
    assert.equal(wrong.response.status, 401);
  });

  await withHostServer(async (baseUrl) => {
    const unavailable = await request(baseUrl, '/api/host/status');
    assert.equal(unavailable.response.status, 503);
  }, { hostToken: '' });
});

test('authenticated host API exposes narrow status, transcription, command, pause, and completion routes', async () => {
  await withHostServer(async (baseUrl, context) => {
    const status = await request(baseUrl, '/api/host/status');
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.managed, true);

    const transcription = await request(baseUrl, '/api/host/transcriptions', {
      method: 'POST',
      body: { mime: 'audio/wav', base64: 'UklGRg==' },
    });
    assert.equal(transcription.payload.text, 'Открой Downloads');

    const command = await request(baseUrl, '/api/host/commands', {
      method: 'POST',
      body: { transcript: '  Открой Downloads  ' },
    });
    assert.equal(command.response.status, 202);
    assert.deepEqual(context.voiceRuntime.calls.find(([name]) => name === 'submitTranscript'), ['submitTranscript', 'Открой Downloads']);

    const completion = await request(baseUrl, `/api/host/commands/${COMMAND_ID}`);
    assert.equal(completion.payload.state, 'success');

    const pause = await request(baseUrl, '/api/host/pause', { method: 'POST', body: { paused: true } });
    assert.equal(pause.response.status, 200);
    assert.deepEqual(context.voiceRuntime.calls.find(([name]) => name === 'setPaused'), ['setPaused', true]);
  });
});
test('host API validates exact schemas and request sizes without leaking the secret', async () => {
  await withHostServer(async (baseUrl) => {
    for (const body of [{}, { transcript: '' }, { transcript: 'x', extra: true }, { transcript: 'x'.repeat(4001) }]) {
      const result = await request(baseUrl, '/api/host/commands', { method: 'POST', body });
      assert.equal(result.response.status, 422);
      assert.equal(JSON.stringify(result.payload).includes(TOKEN), false);
    }
  });
});

test('authenticated shutdown acknowledges first and invokes only the injected owned-backend callback', async () => {
  await withHostServer(async (baseUrl, context) => {
    const result = await request(baseUrl, '/api/host/shutdown', { method: 'POST', body: {} });
    assert.equal(result.response.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.getShutdowns(), 1);
  });
});
