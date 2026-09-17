import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_SERVER_APPROVAL_POLICY,
  APP_SERVER_THREAD_SANDBOX,
  APP_SERVER_TURN_SANDBOX_POLICY,
  AppServerClient,
  appServerCommand,
  appServerInitializeParams,
  appServerLaunch,
  appServerRequestError,
  extractAssistantText,
} from '../src/app-server-client.js';

function recordingClient() {
  const client = new AppServerClient({ cwd: 'C:\\work', logger: () => {} });
  client.executionContextCache = {
    healthy: true,
    authMode: 'chatgpt',
    planType: 'plus',
    model: 'gpt-5.5',
    fingerprint: 'safe-test-fingerprint',
  };
  client.selectedModel = 'gpt-5.5';
  const calls = [];
  client.connect = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
  };
  return { client, calls };
}

test('uses the Windows cmd launcher when running on Windows', () => {
  assert.equal(appServerCommand('win32'), 'codex.cmd');
  assert.equal(appServerCommand('linux'), 'codex');
});

test('wraps the Windows cmd shim so Node does not try to spawn a .cmd file directly', () => {
  assert.deepEqual(appServerLaunch('win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'codex.cmd app-server'],
  });
  assert.deepEqual(appServerLaunch('linux'), { command: 'codex', args: ['app-server'] });
});

test('uses the approval-policy spelling accepted by the installed App Server', () => {
  assert.equal(APP_SERVER_APPROVAL_POLICY, 'on-request');
});

test('uses the correct sandbox spelling for each App Server request shape', () => {
  assert.equal(APP_SERVER_THREAD_SANDBOX, 'danger-full-access');
  assert.equal(APP_SERVER_TURN_SANDBOX_POLICY, 'dangerFullAccess');
});

test('negotiates the installed App Server experimental capability required by typed application context', () => {
  assert.deepEqual(appServerInitializeParams(), {
    clientInfo: { name: 'jarvis-local', title: 'JARVIS Local', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
});

test('extracts final assistant text from an App Server agent message', () => {
  const item = {
    type: 'agentMessage',
    text: 'Готово, папка создана.',
  };

  assert.equal(extractAssistantText(item), 'Готово, папка создана.');
});

test('returns an empty string for an App Server item without assistant text', () => {
  assert.equal(extractAssistantText({ type: 'commandExecution' }), '');
});

test('retains a structured App Server error code without changing its diagnostic message', () => {
  const error = appServerRequestError({
    code: 'NOT_FOUND',
    message: 'Thread was not found at C:\\private\\rollout.jsonl',
  });

  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.message, 'Thread was not found at C:\\private\\rollout.jsonl');
});

test('discovers the current account and model without exposing account identity and pins the model', async () => {
  const client = new AppServerClient({ cwd: 'C:\\work', logger: () => {}, configuredModel: 'gpt-5.5' });
  const calls = [];
  client.connect = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'private@example.com', planType: 'plus' } };
    if (method === 'model/list') return { data: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }] };
    if (method === 'thread/start') return { thread: { id: 'thread-current' } };
    return {};
  };

  const context = await client.executionContext();
  await client.startThread();
  await client.resumeThread('thread-current');
  await client.startTurn('thread-current', [{ type: 'text', text: 'safe smoke' }]);

  assert.deepEqual(calls.slice(0, 2), [
    { method: 'account/read', params: { refreshToken: false } },
    { method: 'model/list', params: { limit: 100, includeHidden: true } },
  ]);
  assert.equal(context.healthy, true);
  assert.equal(context.model, 'gpt-5.5');
  assert.equal(typeof context.fingerprint, 'string');
  assert.equal(JSON.stringify(context).includes('private@example.com'), false);
  assert.equal(calls.find((call) => call.method === 'thread/start').params.model, 'gpt-5.5');
  assert.equal(calls.find((call) => call.method === 'thread/resume').params.model, 'gpt-5.5');
  assert.equal(calls.find((call) => call.method === 'turn/start').params.model, 'gpt-5.5');
});

test('fails closed when the explicitly configured Codex model is unavailable', async () => {
  const client = new AppServerClient({ cwd: 'C:\\work', logger: () => {}, configuredModel: 'production-model' });
  client.connect = async () => {};
  client.request = async (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'private@example.com' } };
    if (method === 'model/list') return { data: [{ id: 'different-model', isDefault: true }] };
    return {};
  };

  await assert.rejects(client.executionContext(), (error) => error.code === 'MODEL_UNAVAILABLE');
});

test('starts a persistent JARVIS App Server thread', async () => {
  const { client, calls } = recordingClient();
  await client.startThread();
  assert.deepEqual(calls[0], {
    method: 'thread/start',
    params: {
      cwd: 'C:\\work',
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
      personality: 'friendly',
      serviceName: 'jarvis-local',
      threadSource: 'jarvis-local',
      model: 'gpt-5.5',
    },
  });
});

test('waits for overlapping App Server initialization before starting a thread', async () => {
  const client = new AppServerClient({ cwd: 'C:\\work', logger: () => {} });
  const calls = [];
  let finishInitialize;
  client.child = { stdin: { writable: true, write: () => {} } };
  client.connecting = new Promise((resolve) => {
    finishInitialize = resolve;
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus' } };
    if (method === 'model/list') return { data: [{ id: 'gpt-5.5', isDefault: true }] };
    return {};
  };

  const started = client.startThread();
  await Promise.resolve();

  assert.equal(calls.length, 0);
  finishInitialize();
  await started;
  assert.deepEqual(calls.map((call) => call.method), ['account/read', 'model/list', 'thread/start']);
});

test('passes text and local images to an explicit thread', async () => {
  const { client, calls } = recordingClient();
  await client.startTurn('thread-1', [
    { type: 'text', text: 'Р§С‚Рѕ РЅР° РёР·РѕР±СЂР°Р¶РµРЅРёРё?' },
    { type: 'localImage', path: 'C:\\work\\data\\attachments\\thread-1\\a.png' },
  ]);
  assert.equal(calls[0].method, 'turn/start');
  assert.equal(calls[0].params.threadId, 'thread-1');
  assert.equal(calls[0].params.approvalPolicy, 'on-request');
  assert.equal(calls[0].params.sandboxPolicy.type, 'dangerFullAccess');
  assert.equal(calls[0].params.model, 'gpt-5.5');
});

test('lists persistent JARVIS App Server threads by recency', async () => {
  const { client, calls } = recordingClient();
  await client.listThreads();
  assert.deepEqual(calls[0], {
    method: 'thread/list',
    params: {
      cwd: 'C:\\work',
      sourceKinds: ['appServer'],
      sortKey: 'recency_at',
      sortDirection: 'desc',
      cursor: null,
      searchTerm: null,
      limit: 50,
    },
  });
});

test('reads thread history without resuming the thread', async () => {
  const { client, calls } = recordingClient();
  await client.readThread('thread-1');
  assert.deepEqual(calls[0], {
    method: 'thread/read',
    params: { threadId: 'thread-1', includeTurns: true },
  });
});

test('passes thread management operations to explicit thread ids', async () => {
  const { client, calls } = recordingClient();
  await client.resumeThread('thread-1');
  await client.setThreadName('thread-1', 'РќРѕРІРѕРµ РёРјСЏ');
  await client.deleteThread('thread-1');
  assert.deepEqual(calls, [
    { method: 'thread/resume', params: { threadId: 'thread-1', model: 'gpt-5.5' } },
    { method: 'thread/name/set', params: { threadId: 'thread-1', name: 'РќРѕРІРѕРµ РёРјСЏ' } },
    { method: 'thread/delete', params: { threadId: 'thread-1' } },
  ]);
});
