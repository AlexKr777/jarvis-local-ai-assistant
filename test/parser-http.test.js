import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createJarvisHttpServer } from '../src/server.js';

class FakeParserRuntime {
  constructor() {
    this.calls = [];
    this.listener = null;
    this.failure = null;
  }
  async status() {
    this.calls.push(['status', {}]);
    return { state: 'STOPPED', worker: 'RUNNING', metrics: { leadsToday: 0 } };
  }
  async call(method, params = {}) {
    this.calls.push([method, params]);
    if (this.failure) throw this.failure;
    return { method, params };
  }
  subscribe(listener) {
    this.listener = listener;
    return () => { this.listener = null; };
  }
}

class FakeJarvis {
  constructor() { this.activeThreadId = null; this.listener = null; }
  status() { return { state: 'ready', detail: 'Ready' }; }
  subscribe(listener) { this.listener = listener; return () => { this.listener = null; }; }
}

async function withParserServer(run) {
  const parserRuntime = new FakeParserRuntime();
  const server = createJarvisHttpServer({
    parserRuntime,
    jarvis: new FakeJarvis(),
    attachmentStore: {},
    transcriptionService: {},
    publicDirectory: new URL('../public/', import.meta.url),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`, parserRuntime);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(baseUrl, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

test('Parser HTTP routes validate inputs and delegate to the isolated runtime', async () => {
  await withParserServer(async (baseUrl, parser) => {
    let result = await request(baseUrl, '/api/parser/status');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.state, 'STOPPED');

    result = await request(baseUrl, '/api/parser/telegram/send-code', {
      method: 'POST', body: { apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef', phone: '+37360000000' },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(parser.calls.at(-1), ['telegram_send_code', {
      apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef', phone: '+37360000000',
    }]);

    await request(baseUrl, '/api/parser/groups?minimumScore=75&minimumActivity=40&topic=founders&language=en&sort=members&direction=asc&includeIgnored=true');
    assert.deepEqual(parser.calls.at(-1), ['groups_list', {
      language: 'en', topic: 'founders', sort: 'members', direction: 'asc',
      minimumScore: 75, minimumActivity: 40, includeIgnored: true,
    }]);

    result = await request(baseUrl, '/api/parser/queue/add', {
      method: 'POST', body: { groupIds: ['group-1', 'group-2'], unexpected: true },
    });
    assert.equal(result.response.status, 422);
    assert.equal(result.payload.error.code, 'PARSER_VALIDATION_ERROR');
  });
});

test('discovery runs, selected-run groups, and completed queue cleanup have local validated routes', async () => {
  await withParserServer(async (baseUrl, parser) => {
    let result = await request(baseUrl, '/api/parser/discovery/runs?limit=25&offset=5');
    assert.equal(result.response.status, 200);
    assert.deepEqual(parser.calls.at(-1), ['discovery_runs_list', { limit: 25, offset: 5 }]);

    result = await request(baseUrl, '/api/parser/groups?runIds=run-a,run-b,run-a&status=NEW&sort=score');
    assert.equal(result.response.status, 200);
    assert.deepEqual(parser.calls.at(-1), ['groups_list', {
      sort: 'score', status: 'NEW', runIds: ['run-a', 'run-b'],
    }]);

    result = await request(baseUrl, '/api/parser/queue/clear-completed', { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.deepEqual(parser.calls.at(-1), ['queue_clear_completed', {}]);
  });
});

test('audit history and revision feedback use narrow local routes', async () => {
  await withParserServer(async (baseUrl, parser) => {
    let result = await request(baseUrl, '/api/parser/audit?since=24h&gate=NO_CONTEXT_GATE&potentialMissed=true');
    assert.equal(result.response.status, 200);
    assert.deepEqual(parser.calls.at(-1), ['audit_history_list', {
      since: '24h', gate: 'NO_CONTEXT_GATE', potentialMissed: true,
    }]);

    result = await request(baseUrl, '/api/parser/audit/revision-1/feedback', {
      method: 'POST', body: { verdict: 'not_a_lead', correctedCategory: 'BACKEND', reason: 'Not commercial' },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(parser.calls.at(-1), ['audit_feedback', {
      revisionId: 'revision-1', verdict: 'not_a_lead', correctedCategory: 'BACKEND', reason: 'Not commercial',
    }]);

    result = await request(baseUrl, '/api/parser/audit/revision-1/feedback', {
      method: 'POST', body: { verdict: 'correct_lead', unexpected: true },
    });
    assert.equal(result.response.status, 422);
  });
});

test('selected-run and lifecycle validation rejects malformed discovery filters', async () => {
  await withParserServer(async (baseUrl) => {
    const unknownStatus = await request(baseUrl, '/api/parser/groups?runIds=run-a&status=UNKNOWN');
    assert.equal(unknownStatus.response.status, 422);
    assert.equal(unknownStatus.payload.error.code, 'PARSER_VALIDATION_ERROR');

    const tooMany = Array.from({ length: 101 }, (_, index) => `run-${index}`).join(',');
    const oversizedSelection = await request(baseUrl, `/api/parser/groups?runIds=${tooMany}&status=ALL`);
    assert.equal(oversizedSelection.response.status, 422);

    const longId = 'x'.repeat(129);
    const oversizedId = await request(baseUrl, `/api/parser/groups?runIds=${longId}&status=ALL`);
    assert.equal(oversizedId.response.status, 422);

    const nonEmptyClear = await request(baseUrl, '/api/parser/queue/clear-completed', {
      method: 'POST', body: { force: true },
    });
    assert.equal(nonEmptyClear.response.status, 422);
  });
});

test('Parser HTTP errors never expose worker diagnostics or request secrets', async () => {
  await withParserServer(async (baseUrl, parser) => {
    parser.failure = Object.assign(new Error('Failed at C:\\private\\secrets.db using bot-secret'), { code: 'WORKER_EXITED' });
    const result = await request(baseUrl, '/api/parser/settings', {
      method: 'PUT', body: { settings: {}, botToken: 'bot-secret' },
    });
    assert.equal(result.response.status, 503);
    assert.equal(JSON.stringify(result.payload).includes('bot-secret'), false);
    assert.equal(JSON.stringify(result.payload).includes('private'), false);
  });
});

test('notification connection test delegates while Parser is stopped', async () => {
  await withParserServer(async (baseUrl, parser) => {
    const result = await request(baseUrl, '/api/parser/notification/test', {
      method: 'POST', body: {},
    });

    assert.equal(result.response.status, 200);
    assert.deepEqual(parser.calls.at(-1), ['notification_test', {}]);
  });
});

test('notification test exposes useful sanitized configuration, provider, and worker errors', async () => {
  await withParserServer(async (baseUrl, parser) => {
    const cases = [
      ['BOT_TOKEN_NOT_CONFIGURED', 'Bot token is not configured.', 422],
      ['DESTINATION_NOT_CONFIGURED', 'Destination ID is not configured.', 422],
      ['BOT_TOKEN_INVALID', 'Bot token is invalid.', 422],
      ['DESTINATION_NOT_FOUND', 'Destination chat was not found.', 422],
      ['NOTIFICATION_CREDENTIALS_UNREADABLE', 'Saved notification credentials could not be read.', 422],
      ['TELEGRAM_API_UNAVAILABLE', 'Telegram Bot API is temporarily unavailable.', 503],
      ['WORKER_UNAVAILABLE', 'Parser worker is unavailable.', 503],
      ['WORKER_TIMEOUT', 'Parser worker did not respond in time.', 503],
    ];

    for (const [code, message, status] of cases) {
      parser.failure = Object.assign(new Error(message), { code });
      const result = await request(baseUrl, '/api/parser/notification/test', { method: 'POST', body: {} });
      assert.equal(result.response.status, status, code);
      assert.deepEqual(result.payload, { error: { code, message } }, code);
    }
  });
});

test('AI test exposes useful sanitized configuration and OpenRouter errors', async () => {
  await withParserServer(async (baseUrl, parser) => {
    const cases = [
      ['OPENROUTER_API_KEY_NOT_CONFIGURED', 'OpenRouter API key is invalid or missing.', 422],
      ['OPENROUTER_MODEL_NOT_CONFIGURED', 'Configure an OpenRouter model first.', 422],
      ['OPENROUTER_CREDENTIALS_UNREADABLE', 'Saved OpenRouter credentials could not be read.', 422],
      ['OPENROUTER_API_KEY_INVALID', 'OpenRouter API key is invalid or missing.', 422],
      ['OPENROUTER_MODEL_NOT_FOUND', 'The configured OpenRouter model was not found.', 422],
      ['OPENROUTER_STRUCTURED_OUTPUT_UNSUPPORTED', 'The configured model does not support the required structured output.', 422],
      ['OPENROUTER_CREDITS_REQUIRED', 'OpenRouter credits are insufficient for this classifier request.', 402],
      ['OPENROUTER_INVALID_CLASSIFICATION', 'AI responded, but the classifier output did not match the required schema.', 422],
      ['OPENROUTER_RATE_LIMITED', 'OpenRouter rate limit reached. Try again shortly.', 503],
      ['OPENROUTER_PROVIDER_UNAVAILABLE', 'The OpenRouter provider is temporarily unavailable.', 503],
      ['OPENROUTER_UNREACHABLE', 'OpenRouter could not be reached.', 503],
    ];

    for (const [code, message, status] of cases) {
      parser.failure = Object.assign(new Error(message), { code });
      const result = await request(baseUrl, '/api/parser/ai/test', { method: 'POST', body: {} });
      assert.equal(result.response.status, status, code);
      assert.deepEqual(result.payload, { error: { code, message } }, code);
      assert.equal(JSON.stringify(result.payload).includes('secret'), false, code);
    }
  });
});

test('Parser activities share the existing JARVIS SSE stream', async () => {
  await withParserServer(async (baseUrl, parser) => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = decoder.decode((await reader.read()).value, { stream: true });
    parser.listener({ type: 'lead_detected', leadId: 'lead-1', score: 94, occurredAt: '2026-08-25T10:00:00Z' });
    while (!output.includes('lead_detected')) output += decoder.decode((await reader.read()).value, { stream: true });
    controller.abort();
    assert.match(output, /"type":"parser-activity"/);
    assert.match(output, /"leadId":"lead-1"/);
  });
});
