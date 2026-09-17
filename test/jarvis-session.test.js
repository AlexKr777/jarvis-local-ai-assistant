import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';

import { JarvisSession } from '../src/jarvis-session.js';

const setImmediatePromise = () => new Promise((resolve) => setImmediate(resolve));

function jarvisThread(id, overrides = {}) {
  return {
    id,
    cwd: process.cwd(),
    threadSource: 'jarvis-local',
    preview: `Preview ${id}`,
    turns: [],
    ...overrides,
  };
}

class FakeAppServerClient extends EventEmitter {
  stopped = false;
  startedTurns = [];
  listCalls = [];
  readCalls = [];
  resumeCalls = [];
  nameCalls = [];
  deleteCalls = [];
  interruptCalls = [];
  responses = [];
  invalidatedExecutionContexts = 0;

  async executionContext() {
    return { healthy: true, authMode: 'chatgpt', planType: 'plus', model: 'gpt-5.5', fingerprint: 'current-context' };
  }

  invalidateExecutionContext() {
    this.invalidatedExecutionContexts += 1;
  }

  async startThread() {
    return { thread: jarvisThread('t2', { preview: '' }) };
  }

  async listThreads(options) {
    this.listCalls.push(options);
    return { data: [], nextCursor: null };
  }

  async readThread(threadId) {
    this.readCalls.push(threadId);
    return { thread: jarvisThread(threadId) };
  }

  async resumeThread(threadId) {
    this.resumeCalls.push(threadId);
    return { thread: jarvisThread(threadId) };
  }

  async setThreadName(threadId, name) {
    this.nameCalls.push({ threadId, name });
    return {};
  }

  async deleteThread(threadId) {
    this.deleteCalls.push(threadId);
    return {};
  }

  async startTurn(threadId, input) {
    this.startedTurns.push({ threadId, input });
    return {};
  }

  async interruptTurn(threadId, turnId) {
    this.interruptCalls.push({ threadId, turnId });
    this.emit('notification', {
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'interrupted' } },
    });
    return {};
  }

  respondToServerRequest(id, result) {
    this.responses.push({ id, result });
  }

  async stop() {
    this.stopped = true;
  }
}

test('exposes only a sanitized Codex execution context and invalidates it on account update', async () => {
  const { session, client, events } = makeSession();
  const context = await session.executionContext();
  client.emit('notification', { method: 'account/updated', params: { account: { email: 'private@example.com' } } });

  assert.deepEqual(context, { healthy: true, authMode: 'chatgpt', planType: 'plus', model: 'gpt-5.5', fingerprint: 'current-context' });
  assert.equal(JSON.stringify(context).includes('@'), false);
  assert.equal(client.invalidatedExecutionContexts, 1);
  assert.equal(events.some((event) => event.type === 'codex-execution-context-changed'), true);
});

test('classifies revoked and unauthorized Codex sessions without leaking the raw credential error', async () => {
  for (const rawMessage of ['401 Unauthorized: token_revoked secret-token', 'account authentication required']) {
    const client = new FakeAppServerClient();
    client.executionContext = async () => { throw new Error(rawMessage); };
    const { session } = makeSession({ client });
    await assert.rejects(session.executionContext(), (error) => {
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.equal(error.message.includes('secret-token'), false);
      return true;
    });
  }
});

test('never writes an auth token diagnostic to the local Jarvis log', async () => {
  const client = new FakeAppServerClient();
  client.executionContext = async () => { throw new Error('401 token_revoked bearer super-private-token'); };
  const logDirectory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-auth-redaction-'));
  const session = new JarvisSession({ projectRoot: process.cwd(), clientFactory: () => client, logDirectory, turnWatchdogMs: 0 });

  await assert.rejects(session.executionContext(), (error) => error.code === 'AUTH_REQUIRED');
  const log = await readFile(path.join(logDirectory, 'jarvis.log'), 'utf8');
  assert.equal(log.includes('super-private-token'), false);
  assert.match(log, /AUTH_REQUIRED/);
});

function makeSession(options = {}) {
  const client = options.client || new FakeAppServerClient();
  const session = new JarvisSession({
    projectRoot: process.cwd(),
    clientFactory: () => client,
    logDirectory: path.join(os.tmpdir(), 'jarvis-v4-session-test-logs'),
    onDeleteThread: options.onDeleteThread,
    approvalTtlMs: options.approvalTtlMs,
    turnWatchdogMs: options.turnWatchdogMs ?? 0,
    setTimeoutImpl: options.setTimeoutImpl,
    clearTimeoutImpl: options.clearTimeoutImpl,
    now: options.now,
    threadReadRetryDelays: options.threadReadRetryDelays,
    sleepImpl: options.sleepImpl,
  });
  const events = [];
  session.subscribe((event) => events.push(event));
  return { session, client, events };
}

test('lists only verified JARVIS threads and never projects foreign results', async () => {
  const { session, client } = makeSession();
  client.listThreads = async (options) => {
    client.listCalls.push(options);
    return {
      data: [
        jarvisThread('safe'),
        jarvisThread('wrong-cwd', { cwd: path.dirname(process.cwd()) }),
        jarvisThread('foreign', { threadSource: 'vscode' }),
      ],
      nextCursor: 'next',
    };
  };

  const result = await session.listThreads({ searchTerm: 'Preview' });

  assert.deepEqual(result.data.map((thread) => thread.id), ['safe']);
  assert.equal(JSON.stringify(result).includes('wrong-cwd'), false);
  assert.equal(JSON.stringify(result).includes('foreign'), false);
  assert.deepEqual(client.listCalls, [{ searchTerm: 'Preview', sourceKinds: ['appServer'] }]);
});

test('falls back once with sourceKinds null only when the primary list has no verified threads', async () => {
  const { session, client } = makeSession();
  client.listThreads = async (options) => {
    client.listCalls.push(options);
    if (client.listCalls.length === 1) return { data: [jarvisThread('foreign', { threadSource: 'cli' })] };
    return { data: [jarvisThread('fallback'), jarvisThread('leak', { cwd: os.tmpdir() })], nextCursor: 'done' };
  };

  const result = await session.listThreads({ limit: 7 });

  assert.deepEqual(result.data.map((thread) => thread.id), ['fallback']);
  assert.deepEqual(client.listCalls, [
    { limit: 7, sourceKinds: ['appServer'] },
    { limit: 7, sourceKinds: null },
  ]);
});

test('does not fall back when a verified empty thread is merely omitted from summaries', async () => {
  const { session, client } = makeSession();
  client.listThreads = async (options) => {
    client.listCalls.push(options);
    return { data: [jarvisThread('empty', { preview: '', name: '' })], nextCursor: 'primary-next' };
  };

  const result = await session.listThreads();

  assert.deepEqual(result, { data: [], nextCursor: 'primary-next' });
  assert.deepEqual(client.listCalls, [{ sourceKinds: ['appServer'] }]);
});

test('reads a verified thread without resuming it', async () => {
  const { session, client } = makeSession();

  const detail = await session.readThread('t1');

  assert.equal(detail.id, 't1');
  assert.deepEqual(client.readCalls, ['t1']);
  assert.deepEqual(client.resumeCalls, []);
});

test('retries only the bounded empty-rollout race before reading a new thread', async () => {
  const waits = [];
  const { session, client } = makeSession({
    threadReadRetryDelays: [10, 20],
    sleepImpl: async (milliseconds) => { waits.push(milliseconds); },
  });
  let attempts = 0;
  client.readThread = async (threadId) => {
    attempts += 1;
    if (attempts < 3) throw new Error('failed to read thread: rollout is empty');
    return { thread: jarvisThread(threadId) };
  };

  const detail = await session.readThread('fresh');

  assert.equal(detail.id, 'fresh');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
});

test('preserves confirmed missing-thread signals while redacting App Server diagnostics', async () => {
  const notFound = Object.assign(new Error('Thread missing at C:\\private\\rollout.jsonl'), { code: 'NOT_FOUND' });
  const { session, client } = makeSession();
  client.readThread = async () => { throw notFound; };

  let publicError;
  try {
    await session.readThread('missing-thread');
  } catch (error) {
    publicError = error;
  }

  assert.equal(publicError.code, 'NOT_FOUND');
  assert.match(publicError.message, /JARVIS/);
  assert.equal(publicError.message.includes('private'), false);

  client.readThread = async () => { throw new Error('thread not loaded: stale-rollout-id'); };
  await assert.rejects(
    session.readThread('stale-thread'),
    (error) => error.code === 'NOT_FOUND' && !error.message.includes('stale-rollout-id'),
  );

  const internal = Object.assign(new Error('Internal validation failed at C:\\private'), { code: 'VALIDATION_ERROR' });
  client.readThread = async () => { throw internal; };
  await assert.rejects(
    session.readThread('broken-thread'),
    (error) => error.code === undefined && !error.message.includes('private'),
  );
});

test('fails closed when start, read, or resume returns an unverified thread', async () => {
  const cases = [
    ['createThread', [], 'startThread', { thread: jarvisThread('bad', { cwd: os.tmpdir() }) }],
    ['readThread', ['bad'], 'readThread', { thread: jarvisThread('bad', { threadSource: 'cli' }) }],
    ['resumeThread', ['bad'], 'resumeThread', { thread: jarvisThread('bad', { cwd: os.tmpdir() }) }],
  ];

  for (const [method, args, clientMethod, raw] of cases) {
    const { session, client } = makeSession();
    client[clientMethod] = async () => raw;
    await assert.rejects(session[method](...args), /JARVIS/);
  }
});

test('creates an empty safe active thread without stopping background work', async () => {
  const { session, client } = makeSession();
  await session.send({ threadId: 't1', message: 'long work', attachments: [] });

  const created = await session.createThread();

  assert.equal(created.id, 't2');
  assert.deepEqual(created.messages, []);
  assert.deepEqual(created.queue, []);
  assert.equal(client.stopped, false);
});

test('keeps a thread owned when App Server omits its source after JARVIS created it', async () => {
  const { session, client } = makeSession();
  const created = await session.createThread();
  client.readThread = async () => ({
    thread: jarvisThread(created.id, { threadSource: null, preview: 'Готово' }),
  });

  const detail = await session.readThread(created.id);

  assert.equal(detail.id, created.id);
  assert.equal(detail.preview, 'Готово');
});

test('hydrates source-less thread-list entries through thread/read without admitting foreign threads', async () => {
  const { session, client } = makeSession();
  client.listThreads = async (options) => {
    client.listCalls.push(options);
    if (client.listCalls.length === 1) return { data: [] };
    return {
      data: [
        jarvisThread('safe', { threadSource: null, preview: 'JARVIS history' }),
        jarvisThread('foreign', { threadSource: null, preview: 'Foreign history' }),
      ],
      nextCursor: 'next',
    };
  };
  client.readThread = async (id) => ({
    thread: jarvisThread(id, { threadSource: id === 'safe' ? 'jarvis-local' : null }),
  });

  const result = await session.listThreads();

  assert.deepEqual(result.data.map((thread) => thread.id), ['safe']);
  assert.equal(JSON.stringify(result).includes('Foreign history'), false);
  assert.equal(result.nextCursor, 'next');
});

test('resumes a persisted thread once before its first turn and builds text plus localImage input', async () => {
  const { session, client } = makeSession();
  const attachments = [
    { id: 'a1', path: 'C:\\safe\\one.png', name: 'one.png', mime: 'image/png', size: 12 },
    { id: 'a2', path: 'C:\\safe\\two.webp', name: 'two.webp', mime: 'image/webp', size: 34 },
  ];

  await session.send({ threadId: 't1', message: 'describe images', attachments });
  client.emit('notification', { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
  await setImmediatePromise();
  await session.send({ threadId: 't1', message: 'again', attachments: [] });

  assert.deepEqual(client.resumeCalls, ['t1']);
  assert.deepEqual(client.startedTurns[0], {
    threadId: 't1',
    input: [
      { type: 'text', text: 'describe images' },
      { type: 'localImage', path: 'C:\\safe\\one.png' },
      { type: 'localImage', path: 'C:\\safe\\two.webp' },
    ],
  });
});

test('queues simultaneous follow-ups FIFO per thread and starts one after each completion', async () => {
  const { session, client, events } = makeSession();
  const [started, queuedTwo, queuedThree] = await Promise.all([
    session.send({ threadId: 't1', message: 'one', attachments: [] }),
    session.send({ threadId: 't1', message: 'two', attachments: [] }),
    session.send({ threadId: 't1', message: 'three', attachments: [] }),
  ]);

  assert.equal(started.disposition, 'started');
  assert.equal(queuedTwo.disposition, 'queued');
  assert.equal(queuedThree.disposition, 'queued');
  assert.equal(client.startedTurns.length, 1);

  client.emit('notification', { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
  await setImmediatePromise();
  client.emit('notification', { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
  await setImmediatePromise();

  assert.deepEqual(client.startedTurns.map((turn) => turn.input[0].text), ['one', 'two', 'three']);
  assert.equal(events.every((event) => event.threadId === 't1'), true);
  assert.equal(events.filter((event) => event.type === 'turn-started').length, 3);
});

test('isolates active turns, queues, and authoritative assistant text by thread', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 't1', message: 'one', attachments: [] });
  await session.send({ threadId: 't2', message: 'two', attachments: [] });
  await session.send({ threadId: 't1', message: 'queued', attachments: [] });
  events.length = 0;

  client.emit('notification', {
    method: 'item/completed',
    params: { threadId: 't2', item: { id: 'a2', type: 'agentMessage', text: 'answer two' } },
  });
  client.emit('notification', {
    method: 'item/completed',
    params: { threadId: 't1', item: { id: 'a1', type: 'agentMessage', text: 'answer one' } },
  });
  client.emit('notification', { method: 'turn/completed', params: { threadId: 't2', turn: { status: 'completed' } } });
  await setImmediatePromise();

  assert.deepEqual(events.filter((event) => event.type === 'assistant-message'), [
    {
      type: 'assistant-message',
      threadId: 't2',
      text: 'answer two',
      source: 'ui',
      commandId: events.find((event) => event.type === 'assistant-message').commandId,
    },
  ]);
  assert.deepEqual(client.startedTurns.filter((turn) => turn.threadId === 't1').map((turn) => turn.input[0].text), ['one']);

  client.emit('notification', { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
  await setImmediatePromise();
  assert.deepEqual(client.startedTurns.filter((turn) => turn.threadId === 't1').map((turn) => turn.input[0].text), ['one', 'queued']);
});

test('removes only queued items before they start and never exposes attachment paths in queue snapshots', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 't1', message: 'active', attachments: [] });
  const queued = await session.send({
    threadId: 't1',
    message: 'later',
    attachments: [{ id: 'a1', path: 'C:\\private\\secret.png', name: 'secret.png', mime: 'image/png', size: 10 }],
  });

  assert.equal(JSON.stringify(queued.queue).includes('C:\\private'), false);
  assert.deepEqual(await session.removeQueued('t1', queued.queue[0].id), { removed: true, threadId: 't1', queue: [] });
  assert.equal((await session.removeQueued('t1', queued.queue[0].id)).removed, false);
  assert.equal(JSON.stringify(events.filter((event) => event.type === 'queue')).includes('C:\\private'), false);
  assert.equal(client.startedTurns.length, 1);
});

test('renames threads, titles the first meaningful send, and ignores cosmetic title failure', async () => {
  const { session, client } = makeSession();
  await session.renameThread('t1', '  My useful chat  ');
  client.setThreadName = async (threadId, name) => {
    client.nameCalls.push({ threadId, name });
    throw new Error('cosmetic failure');
  };

  const result = await session.send({
    threadId: 't2',
    message: 'Please inspect all of these project files tomorrow',
    attachments: [],
  });
  await setImmediatePromise();

  assert.equal(result.accepted, true);
  assert.deepEqual(client.nameCalls, [
    { threadId: 't1', name: 'My useful chat' },
    { threadId: 't2', name: 'Please inspect all of these project' },
  ]);
});

test('deletes App Server thread before cleanup and clears its runtime', async () => {
  const order = [];
  const client = new FakeAppServerClient();
  client.startTurn = async () => ({ turn: { id: 'turn-delete-cleanup' } });
  client.interruptTurn = async (threadId, turnId) => {
    order.push(`interrupt:${threadId}:${turnId}`);
    client.emit('notification', {
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'interrupted' } },
    });
  };
  client.deleteThread = async (threadId) => {
    order.push(`delete:${threadId}`);
  };
  const { session } = makeSession({
    client,
    onDeleteThread: async (threadId) => order.push(`cleanup:${threadId}`),
  });
  await session.send({ threadId: 't1', message: 'active', attachments: [] });
  await session.send({ threadId: 't1', message: 'queued', attachments: [] });

  const result = await session.deleteThread('t1');

  assert.deepEqual(order, ['interrupt:t1:turn-delete-cleanup', 'delete:t1', 'cleanup:t1']);
  assert.deepEqual(result, { deleted: true, threadId: 't1' });
  assert.equal((await session.removeQueued('t1', 'anything')).removed, false);
});

test('does not call deletion cleanup when App Server deletion fails', async () => {
  let cleaned = false;
  const client = new FakeAppServerClient();
  client.deleteThread = async () => {
    throw new Error('delete failed');
  };
  const { session } = makeSession({ client, onDeleteThread: async () => { cleaned = true; } });

  await assert.rejects(session.deleteThread('t1'), /JARVIS/);
  assert.equal(cleaned, false);
});

test('interrupts an active turn before deleting its thread and runtime', async () => {
  const client = new FakeAppServerClient();
  client.startTurn = async (threadId, input) => {
    client.startedTurns.push({ threadId, input });
    return { turn: { id: 'turn-delete', status: 'inProgress' } };
  };
  const { session } = makeSession({ client });
  await session.send({ threadId: 't1', message: 'Долгая задача', attachments: [] });

  const result = await session.deleteThread('t1');

  assert.deepEqual(client.interruptCalls, [{ threadId: 't1', turnId: 'turn-delete' }]);
  assert.deepEqual(client.deleteCalls, ['t1']);
  assert.deepEqual(result, { deleted: true, threadId: 't1' });
});

test('answers the original approval request and clears it only after serverRequest/resolved', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 't1', message: 'work', attachments: [] });
  events.length = 0;
  client.emit('serverRequest', {
    id: 17,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 't1',
      turnId: 'turn-17',
      itemId: 'item-17',
      command: 'Remove-Item -LiteralPath ".\\test-workspace\\old.txt"',
      cwd: process.cwd(),
      availableDecisions: ['accept', 'decline'],
    },
  });

  const requested = events.find((event) => event.type === 'approval');
  assert.equal(requested.approval.turnId, 'turn-17');
  assert.equal(requested.approval.itemId, 'item-17');
  assert.deepEqual(requested.approval.availableDecisions, ['accept', 'decline']);

  const answering = await session.respondToApproval(17, 'decline');

  assert.deepEqual(client.responses, [{ id: 17, result: { decision: 'decline' } }]);
  assert.equal(answering.pending, true);
  assert.equal(events.every((event) => event.threadId === 't1'), true);
  assert.equal(events.some((event) => event.type === 'activity' && event.activity.category === 'approval'), false);
  assert.equal(events.some((event) => event.type === 'approval-resolved'), false);
  await assert.rejects(session.respondToApproval(17, 'accept'), /already|ожида|ответ/i);

  client.emit('notification', {
    method: 'serverRequest/resolved',
    params: { threadId: 't1', requestId: 17 },
  });
  assert.equal(events.some((event) => event.type === 'approval-resolved' && event.decision === 'decline'), true);
  await assert.rejects(session.respondToApproval(17, 'accept'), /pending|ожида/i);
  await assert.rejects(session.respondToApproval(999, 'accept'), /pending|ожида/i);
  await assert.rejects(session.respondToApproval(1, 'maybe'), /accept|decline/);
});

test('keeps an approval pending for a mismatched resolution and clears it when its turn ends', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 't1', message: 'work', attachments: [], source: 'voice' });
  client.emit('serverRequest', {
    id: 71,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't1', command: 'Remove-Item -LiteralPath ".\\test-workspace\\old.txt"', cwd: process.cwd() },
  });

  client.emit('notification', {
    method: 'serverRequest/resolved',
    params: { threadId: 'wrong-thread', requestId: 71 },
  });
  await session.respondToApproval(71, 'decline');
  assert.deepEqual(client.responses, [{ id: 71, result: { decision: 'decline' } }]);

  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 't1', turn: { status: 'completed' } },
  });
  assert.equal(events.some((event) => event.type === 'approval-resolved' && event.id === 71), true);
  await assert.rejects(session.respondToApproval(71, 'accept'), /pending|ожида/i);
});

test('clears unanswered approvals when App Server reports a turn error', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 't1', message: 'work', attachments: [], source: 'voice' });
  client.emit('serverRequest', {
    id: 72,
    method: 'item/fileChange/requestApproval',
    params: { threadId: 't1', grantRoot: process.cwd() },
  });

  client.emit('notification', {
    method: 'error',
    params: { threadId: 't1', error: { message: 'turn failed' } },
  });

  assert.equal(events.some((event) => event.type === 'approval-resolved' && event.id === 72), true);
  await assert.rejects(session.respondToApproval(72, 'decline'), /pending|ожида/i);
});

test('preserves queue item identity and voice source across start and completion events', async () => {
  const { session, client, events } = makeSession();
  const accepted = await session.send({ threadId: 't1', message: 'voice work', attachments: [], source: 'voice' });

  assert.equal(typeof accepted.itemId, 'string');
  assert.equal(events.find((event) => event.type === 'turn-started').itemId, accepted.itemId);
  assert.equal(events.find((event) => event.type === 'turn-started').source, 'voice');

  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 't1', turn: { status: 'completed' } },
  });
  await setImmediatePromise();

  const completed = events.find((event) => event.type === 'turn-completed');
  assert.equal(completed.itemId, accepted.itemId);
  assert.equal(completed.source, 'voice');
  assert.equal(completed.status, 'completed');
});

test('hard-blocks core Windows destruction at the concrete approval boundary', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 't1', message: 'unsafe', attachments: [], source: 'voice' });
  events.length = 0;

  client.emit('serverRequest', {
    id: 81,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't1', command: ['powershell', '-Command', 'Remove-Item -Recurse -Force C:\\Windows\\System32'], cwd: 'C:\\Users\\user' },
  });
  await setImmediatePromise();

  assert.deepEqual(client.responses, [{ id: 81, result: { decision: 'decline' } }]);
  assert.equal(events.some((event) => event.type === 'safety-blocked' && event.overrideAllowed === false), true);
  assert.equal(events.some((event) => event.type === 'approval'), false);
  await assert.rejects(session.respondToApproval(81, 'accept'), /pending|ожида/i);
});

test('auto-allows a safe approval exactly once without UI or approval Activity noise', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 't1', message: 'Запусти тесты', attachments: [], source: 'voice' });
  events.length = 0;
  const request = {
    id: 91,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 't1',
      turnId: 'turn-91',
      itemId: 'item-91',
      command: 'npm.cmd test',
      cwd: process.cwd(),
      availableDecisions: ['accept', 'decline'],
    },
  };

  client.emit('serverRequest', request);
  client.emit('serverRequest', request);
  await setImmediatePromise();

  assert.deepEqual(client.responses, [{ id: 91, result: { decision: 'accept' } }]);
  assert.equal(events.some((event) => event.type === 'approval'), false);
  assert.equal(events.some((event) => event.type === 'approval-resolved'), false);
  assert.equal(events.some((event) => event.activity?.category === 'approval'), false);

  client.emit('notification', { method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 91 } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
  assert.equal(session.status('t1').state, 'idle');
});

test('reconciles a lost turn completion only from authoritative thread state', async () => {
  const timers = [];
  const client = new FakeAppServerClient();
  client.startTurn = async (threadId, input) => {
    client.startedTurns.push({ threadId, input });
    return { turn: { id: 'turn-reconcile', status: 'inProgress' } };
  };
  client.readThread = async (threadId) => ({
    thread: jarvisThread(threadId, {
      turns: [{
        id: 'turn-reconcile',
        status: 'completed',
        items: [{ id: 'answer-1', type: 'agentMessage', text: 'Готово после сверки.' }],
      }],
    }),
  });
  const { session, events } = makeSession({
    client,
    turnWatchdogMs: 90_000,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { timer.cleared = true; },
  });

  await session.send({ threadId: 't1', message: 'Проверь статус', attachments: [] });
  assert.equal(timers[0].delay, 90_000);
  await timers[0].callback();

  assert.equal(events.some((event) => event.type === 'assistant-message' && event.text === 'Готово после сверки.'), true);
  assert.equal(events.some((event) => event.type === 'turn-completed' && event.status === 'completed'), true);
  assert.equal(session.status('t1').state, 'idle');
});

test('expires every App Server approval after 60 seconds but waits for authoritative resolution', async () => {
  const timers = [];
  const { session, client, events } = makeSession({
    approvalTtlMs: 60_000,
    now: () => Date.parse('2026-08-20T12:00:00.000Z'),
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { timer.cleared = true; },
  });
  await session.send({ threadId: 't1', message: 'delete', attachments: [], source: 'voice' });
  events.length = 0;
  client.emit('serverRequest', {
    id: 82,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't1', command: 'Remove-Item -LiteralPath ".\\test-workspace\\old.txt"', cwd: process.cwd() },
  });

  const requested = events.find((event) => event.type === 'approval');
  assert.equal(requested.source, 'voice');
  assert.equal(requested.approval.target, path.win32.resolve(process.cwd(), '.\\test-workspace\\old.txt'));
  assert.equal(requested.approval.expiresAt, '2026-08-20T12:01:00.000Z');
  assert.equal(timers[0].delay, 60_000);

  await timers[0].callback();
  assert.deepEqual(client.responses, [{ id: 82, result: { decision: 'decline' } }]);
  assert.equal(events.some((event) => event.type === 'approval-resolved'), false);
  client.emit('notification', { method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 82 } });
  assert.equal(events.some((event) => event.type === 'approval-resolved' && event.expired === true && event.source === 'voice'), true);
  await assert.rejects(session.respondToApproval(82, 'accept'), /pending|ожида/i);
});

test('ignores malformed notifications and safely declines approval requests without threadId', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 't1', message: 'work', attachments: [] });
  events.length = 0;

  client.emit('notification', { method: 'item/agentMessage/delta', params: { delta: 'leak' } });
  client.emit('notification', { method: 'turn/completed', params: { turn: { status: 'completed' } } });
  client.emit('serverRequest', { id: 12, method: 'item/fileChange/requestApproval', params: {} });
  await setImmediatePromise();

  assert.deepEqual(events, []);
  assert.deepEqual(client.responses, [{ id: 12, result: { decision: 'decline' } }]);
  await assert.rejects(session.respondToApproval(12, 'accept'), /pending|ожида/i);
});

test('declines approval requests for an unknown threadId without creating visible pending state', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 't1', message: 'known work', attachments: [] });
  events.length = 0;

  client.emit('serverRequest', {
    id: 13,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'unknown-thread', command: ['npm.cmd', 'test'] },
  });
  await setImmediatePromise();

  assert.deepEqual(events, []);
  await assert.rejects(session.respondToApproval(13, 'accept'), /pending|ожида/i);
  assert.deepEqual(client.responses, [{ id: 13, result: { decision: 'decline' } }]);
});

test('projects concrete item Activity with a stable id for its thread', async () => {
  const { session, client, events } = makeSession();
  await session.send({ threadId: 't1', message: 'search', attachments: [] });
  events.length = 0;
  client.emit('notification', {
    method: 'item/started',
    params: { threadId: 't1', item: { id: 'web-1', type: 'webSearch', query: 'weather' } },
  });
  client.emit('notification', {
    method: 'item/completed',
    params: { threadId: 't1', item: { id: 'web-1', type: 'webSearch', resultCount: 2 } },
  });

  assert.equal(events.length, 2);
  assert.equal(events.every((event) => event.type === 'activity' && event.threadId === 't1'), true);
  assert.equal(events[0].activity.id, events[1].activity.id);
  assert.equal(events[1].activity.state, 'complete');
});
