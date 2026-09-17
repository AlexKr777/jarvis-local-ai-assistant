import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

import {
  clearThreadState,
  createState,
  getDraft,
  reduce,
  setDraft,
} from '../public/state.js';
import { createApi } from '../public/api.js';
import {
  ATTACHMENT_ONLY_INSTRUCTION,
  ATTACHMENT_ONLY_LABEL,
  createAttachmentController,
  createVoiceController,
  insertAtSelection,
} from '../public/chat-view.js';
import { createJarvisHttpServer } from '../src/server.js';
import '../public/app.js';

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.failWrites = false;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    if (this.failWrites) throw new Error('quota exceeded');
    this.values.set(key, String(value));
  }
}

function withStorage(storage, run) {
  const previous = globalThis.localStorage;
  globalThis.localStorage = storage;
  const restore = () => {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  };
  try {
    const result = run();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test('stable render reconciliation keeps unchanged DOM nodes attached', () => {
  const { reconcileChildOrder } = globalThis.JarvisApp;
  assert.equal(typeof reconcileChildOrder, 'function');

  const operations = [];
  const parent = {
    children: [],
    insertBefore(node, reference) {
      const previousIndex = this.children.indexOf(node);
      if (previousIndex >= 0) this.children.splice(previousIndex, 1);
      const referenceIndex = reference ? this.children.indexOf(reference) : this.children.length;
      this.children.splice(referenceIndex < 0 ? this.children.length : referenceIndex, 0, node);
      operations.push(['insert', node.id]);
    },
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      operations.push(['remove', node.id]);
    },
  };
  const first = { id: 'first' };
  const second = { id: 'second' };

  reconcileChildOrder(parent, [first, second]);
  operations.length = 0;
  reconcileChildOrder(parent, [first, second]);

  assert.deepEqual(parent.children, [first, second]);
  assert.deepEqual(operations, []);
});

test('render gate skips an unchanged region and reopens only when its data changes', () => {
  const { createRenderGate } = globalThis.JarvisApp;
  assert.equal(typeof createRenderGate, 'function');
  const shouldRender = createRenderGate();

  assert.equal(shouldRender('history', 'thread-1'), true);
  assert.equal(shouldRender('history', 'thread-1'), false);
  assert.equal(shouldRender('history', 'thread-2'), true);
  assert.equal(shouldRender('queue', 'thread-2'), true);
});

test('isolates detail, drafts, queue, streams, activity, and status by thread', () => {
  let state = createState();
  state = reduce(state, { type: 'thread-selected', threadId: 't2' });
  state = reduce(state, { type: 'thread-detail', threadId: 't1', detail: { id: 't1', messages: [{ role: 'user', text: 'one' }] } });
  state = reduce(state, { type: 'draft-changed', threadId: 't1', value: 'draft one' });
  state = reduce(state, { type: 'queue', threadId: 't2', items: [{ id: 'q1', message: 'two' }] });
  state = reduce(state, { type: 'assistant-delta', threadId: 't1', text: 'x' });
  state = reduce(state, { type: 'activity', threadId: 't1', activity: { id: 'a1', title: 'Search' } });
  state = reduce(state, { type: 'status', threadId: 't2', state: 'working', detail: 'Busy' });

  assert.equal(state.activeThreadId, 't2');
  assert.equal(state.details.t1.messages[0].text, 'one');
  assert.equal(state.drafts.t1, 'draft one');
  assert.equal(state.queues.t2[0].id, 'q1');
  assert.equal(state.streams.t1, 'x');
  assert.equal(state.activities.t1[0].id, 'a1');
  assert.equal(state.statuses.t2.state, 'working');
  assert.equal(state.streams.t2, undefined);
});

test('queues multiple approvals per thread and resolves only the matching request id', () => {
  let state = createState({ activeThreadId: 't1' });
  state = reduce(state, { type: 'approval', threadId: 't1', approval: { id: 17, reason: 'first' } });
  state = reduce(state, { type: 'approval', threadId: 't1', approval: { id: 18, reason: 'second' } });
  state = reduce(state, { type: 'approval', threadId: 't1', approval: { id: 19, reason: 'third' } });
  assert.equal(state.approvals.t1.id, 17);
  assert.deepEqual(state.approvalQueues.t1.map(({ id }) => id), [17, 18, 19]);

  state = reduce(state, { type: 'approval-resolved', threadId: 't1', id: 18 });
  assert.equal(state.approvals.t1.id, 17);
  state = reduce(state, { type: 'approval-resolved', threadId: 't1', id: 17 });
  assert.equal(state.approvals.t1.id, 19);
  state = reduce(state, { type: 'approval-resolved', threadId: 't1', id: 19 });
  assert.equal(state.approvals.t1, undefined);
  assert.equal(state.approvalQueues.t1, undefined);
});

test('reducer remains serializable and does not mutate its input', () => {
  const original = createState({ queues: { t1: [{ id: 'q1' }] } });
  const next = reduce(original, { type: 'queue', threadId: 't1', items: [{ id: 'q2' }] });

  assert.equal(original.queues.t1[0].id, 'q1');
  assert.equal(next.queues.t1[0].id, 'q2');
  assert.doesNotThrow(() => JSON.stringify(next));
});

test('draft persistence truncates to 8000 characters and isolates thread ids', () => {
  withStorage(new MemoryStorage(), () => {
    assert.equal(setDraft('t1', 'x'.repeat(8001)), true);
    assert.equal(setDraft('t2', 'two'), true);
    assert.equal(getDraft('t1').length, 8000);
    assert.equal(getDraft('t2'), 'two');

    clearThreadState('t1');
    assert.equal(getDraft('t1'), '');
    assert.equal(getDraft('t2'), 'two');
  });
});

test('draft persistence survives malformed JSON and storage quota failures', () => {
  const storage = new MemoryStorage({ 'jarvis.drafts.v1': '{bad json' });
  withStorage(storage, () => {
    assert.equal(getDraft('t1'), '');
    storage.failWrites = true;
    assert.equal(setDraft('t1', 'safe text'), false);
    assert.doesNotThrow(() => clearThreadState('t1'));
  });
});

test('draft storage contains only plain truncated strings', () => {
  const storage = new MemoryStorage();
  withStorage(storage, () => {
    setDraft('t1', 'hello');
    const persisted = JSON.parse(storage.getItem('jarvis.drafts.v1'));
    assert.deepEqual(persisted, { t1: 'hello' });
    assert.equal(JSON.stringify(persisted).includes('approval'), false);
    assert.equal(JSON.stringify(persisted).includes('base64'), false);
    assert.equal(JSON.stringify(persisted).includes('audio'), false);
  });
});

function jsonResponse(payload, status = 200) {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('API helpers use the Task 7 REST route shapes', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, ...options });
    return jsonResponse({ ok: true });
  };
  const client = createApi({ fetchImpl });

  await client.listThreads('два слова');
  await client.createThread();
  await client.readThread('t/1');
  await client.renameThread('t1', 'Name');
  await client.deleteThread('t1');
  await client.deleteAllThreads();
  await client.send('t1', 'Hello', ['a1']);
  await client.removeQueued('t1', 'q1');
  await client.uploadAttachment({ threadId: 't1', name: 'a.png', mime: 'image/png', base64: 'AAAA' });
  await client.deleteAttachment('t1', 'a1');
  await client.transcribe({ mime: 'audio/webm', base64: 'AAAA' });

  assert.deepEqual(calls.map(({ url, method = 'GET' }) => [method, url]), [
    ['GET', '/api/threads?search=%D0%B4%D0%B2%D0%B0+%D1%81%D0%BB%D0%BE%D0%B2%D0%B0'],
    ['POST', '/api/threads'],
    ['GET', '/api/threads/t%2F1'],
    ['PATCH', '/api/threads/t1'],
    ['DELETE', '/api/threads/t1'],
    ['DELETE', '/api/threads'],
    ['POST', '/api/chat'],
    ['DELETE', '/api/threads/t1/queue/q1'],
    ['POST', '/api/attachments'],
    ['DELETE', '/api/attachments/a1?threadId=t1'],
    ['POST', '/api/transcriptions'],
  ]);
  assert.deepEqual(JSON.parse(calls[6].body), { threadId: 't1', message: 'Hello', attachmentIds: ['a1'] });
  assert.deepEqual(JSON.parse(calls[3].body), { name: 'Name' });
});

test('API errors expose the stable public envelope without inventing internal details', async () => {
  const client = createApi({
    fetchImpl: async () => jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'Проверьте данные запроса.' } }, 422),
  });

  await assert.rejects(client.createThread(), (error) => {
    assert.equal(error.message, 'Проверьте данные запроса.');
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.status, 422);
    return true;
  });
});

test('EventSource delegates reconnect backoff to the browser and reconciles only after a disconnect', () => {
  class FakeEventSource {
    static instances = [];
    constructor(url) {
      this.url = url;
      FakeEventSource.instances.push(this);
    }
    close() { this.closed = true; }
  }
  const received = [];
  let reconnects = 0;
  const client = createApi({ fetchImpl: async () => jsonResponse({}), EventSourceImpl: FakeEventSource });
  const connection = client.connectEvents((event) => received.push(event), () => { reconnects += 1; });
  const source = FakeEventSource.instances[0];

  assert.equal(source.url, '/api/events');
  source.onopen();
  assert.equal(reconnects, 0);
  source.onmessage({ data: JSON.stringify({ type: 'status', threadId: 't1' }) });
  source.onmessage({ data: '{not json' });
  source.onerror();
  source.onopen();

  assert.deepEqual(received, [{ type: 'status', threadId: 't1' }]);
  assert.equal(reconnects, 1);
  assert.equal(FakeEventSource.instances.length, 1);
  connection.close();
  assert.equal(source.closed, true);
});

function fakeControllerApi({ threads = [], details = {} } = {}) {
  const calls = [];
  let eventHandler;
  let reconnectHandler;
  let created = 0;
  const client = {
    calls,
    async listThreads(search = '') {
      calls.push(['listThreads', search]);
      return { data: threads.filter((thread) => !search || thread.title?.includes(search)) };
    },
    async createThread() {
      created += 1;
      const thread = { id: `created-${created}`, title: '' };
      calls.push(['createThread']);
      details[thread.id] = { ...thread, messages: [], queue: [], status: { state: 'ready' } };
      return thread;
    },
    async readThread(threadId) {
      calls.push(['readThread', threadId]);
      return structuredClone(details[threadId] || { id: threadId, messages: [] });
    },
    async renameThread(threadId, name) {
      calls.push(['renameThread', threadId, name]);
      return { threadId, name };
    },
    async deleteThread(threadId) {
      calls.push(['deleteThread', threadId]);
      return { deleted: true, threadId };
    },
    async deleteAllThreads() {
      calls.push(['deleteAllThreads']);
      const deletedThreadIds = threads.map(({ id }) => id);
      threads.splice(0, threads.length, { id: 'created-after-delete', title: '' });
      details['created-after-delete'] = { id: 'created-after-delete', messages: [], queue: [], status: { state: 'ready' } };
      return {
        deleted: true,
        deletedCount: deletedThreadIds.length,
        deletedThreadIds,
        preservedThreadIds: [],
        voiceThreadId: 'voice-after-delete',
        thread: { id: 'created-after-delete', messages: [], queue: [] },
      };
    },
    async send(threadId, message, attachmentIds) {
      calls.push(['send', threadId, message, attachmentIds]);
      return { disposition: 'started', threadId, queue: [] };
    },
    async removeQueued(threadId, queueId) {
      calls.push(['removeQueued', threadId, queueId]);
      return { removed: true, threadId, queue: [] };
    },
    async respondApproval(id, decision) {
      calls.push(['respondApproval', id, decision]);
      return { id, decision };
    },
    connectEvents(onEvent, onReconnect) {
      calls.push(['connectEvents']);
      eventHandler = onEvent;
      reconnectHandler = onReconnect;
      return { close() { calls.push(['closeEvents']); } };
    },
    emit(event) { eventHandler(event); },
    reconnect() { return reconnectHandler(); },
  };
  return client;
}

test('controller boots list/create before SSE and restores the persisted draft', async () => {
  const { createController } = globalThis.JarvisApp;
  const storage = new MemoryStorage({ 'jarvis.drafts.v1': JSON.stringify({ 'created-1': 'remember me' }) });
  await withStorage(storage, async () => {
    const client = fakeControllerApi();
    const snapshots = [];
    const controller = createController({
      api: client,
      stateTools: { createState, reduce, setDraft, clearThreadState },
      onChange: (state) => snapshots.push(state),
    });

    await controller.boot();

    assert.deepEqual(client.calls.slice(0, 3), [
      ['listThreads', ''],
      ['createThread'],
      ['connectEvents'],
    ]);
    assert.equal(controller.getState().activeThreadId, 'created-1');
    assert.equal(controller.getState().drafts['created-1'], 'remember me');
    assert.ok(snapshots.length > 0);
  });
});

test('controller deletes all returned chat identities and lands in the new empty chat without reload', async () => {
  const { createController } = globalThis.JarvisApp;
  const storage = new MemoryStorage({ 'jarvis.drafts.v1': JSON.stringify({ t1: 'one', t2: 'two' }) });
  await withStorage(storage, async () => {
    const client = fakeControllerApi({
      threads: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }],
      details: { t1: { id: 't1', messages: [] }, t2: { id: 't2', messages: [] } },
    });
    const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
    await controller.boot();

    const result = await controller.deleteAllThreads();

    assert.equal(result.deletedCount, 2);
    assert.equal(controller.getState().activeThreadId, 'created-after-delete');
    assert.deepEqual(controller.getState().details['created-after-delete'].messages, []);
    assert.equal(controller.getState().details.t1, undefined);
    assert.equal(controller.getState().details.t2, undefined);
    assert.equal(getDraft('t1'), '');
    assert.equal(getDraft('t2'), '');
    assert.deepEqual(client.calls.filter(([name]) => name === 'deleteAllThreads'), [['deleteAllThreads']]);
  });
});

test('controller excludes the pinned Crypto identity from ordinary startup selection', async () => {
  const { createController } = globalThis.JarvisApp;
  const cryptoThreadId = '11111111-1111-4111-8111-111111111111';
  const ordinaryThreadId = '22222222-2222-4222-8222-222222222222';
  const client = fakeControllerApi({
    threads: [{ id: cryptoThreadId, title: 'Crypto' }, { id: ordinaryThreadId, title: 'Ordinary' }],
    details: {
      [cryptoThreadId]: { id: cryptoThreadId, messages: [] },
      [ordinaryThreadId]: { id: ordinaryThreadId, messages: [] },
    },
  });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });

  await controller.boot({ excludedThreadIds: [cryptoThreadId] });

  assert.equal(controller.getState().activeThreadId, ordinaryThreadId);
  assert.deepEqual(client.calls.filter(([name]) => name === 'readThread'), [['readThread', ordinaryThreadId]]);
});

test('controller can authoritatively reload an open Crypto thread after a typed event', async () => {
  const { createController } = globalThis.JarvisApp;
  const threadId = '11111111-1111-4111-8111-111111111111';
  const client = fakeControllerApi({
    threads: [{ id: threadId, title: 'Crypto' }],
    details: { [threadId]: { id: threadId, messages: [{ role: 'assistant', text: 'Old' }] } },
  });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  client.readThread = async () => ({ id: threadId, messages: [{ role: 'assistant', text: 'New automation result' }] });

  controller.handleEvent({ type: 'crypto-activity', threadId, eventType: 'codex_completed', payload: {} });
  await controller.reloadThread(threadId);

  assert.equal(controller.getState().details[threadId].messages.at(-1).text, 'New automation result');
});

test('controller keeps a brand-new unmaterialized thread usable until its first message', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi();
  client.readThread = async (threadId) => {
    client.calls.push(['readThread', threadId]);
    throw new Error(`thread ${threadId} is not materialized yet`);
  };
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });

  await assert.doesNotReject(controller.boot());

  assert.equal(controller.getState().activeThreadId, 'created-1');
  assert.deepEqual(controller.getState().details['created-1']?.messages, []);
  assert.equal(client.calls.some(([name]) => name === 'readThread'), false);

  client.calls.length = 0;
  await assert.doesNotReject(client.reconnect());
  assert.deepEqual(client.calls, [['listThreads', '']]);
});

test('controller keeps background threads working and reconciles active detail after reconnect', async () => {
  const { createController } = globalThis.JarvisApp;
  const details = {
    t1: { id: 't1', title: 'One', messages: [{ role: 'user', text: 'authoritative one' }], status: { state: 'working' } },
    t2: { id: 't2', title: 'Two', messages: [{ role: 'user', text: 'authoritative two' }], status: { state: 'ready' } },
  };
  const client = fakeControllerApi({ threads: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }], details });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  client.emit({ type: 'assistant-delta', threadId: 't1', text: 'background' });
  await controller.selectThread('t2');
  await controller.newThread();

  assert.equal(controller.getState().streams.t1, 'background');
  assert.equal(controller.getState().activeThreadId, 'created-1');
  assert.equal(client.calls.filter(([name]) => name === 'createThread').length, 1);

  client.calls.length = 0;
  await client.reconnect();
  assert.deepEqual(client.calls, [['listThreads', '']]);
});

test('captured approval owner resolves the originating thread after a thread switch', async () => {
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /function showApproval\(approval, threadId\) \{[\s\S]*?approvalThreadId = threadId;/);
  assert.match(appSource, /const threadId = el\.dialog\.dataset\.approvalThreadId;[\s\S]*?returnValue === 'allow' \? 'accept' : 'decline';[\s\S]*?controller\.resolveApproval\(threadId, id, decision\);/);
  assert.match(appSource, /event\.type === 'approval-resolved'[\s\S]*?el\.dialog\.close\(\)/);

  for (const decision of ['decline', 'accept']) {
    const { createController } = globalThis.JarvisApp;
    const client = fakeControllerApi({
      threads: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }],
      details: { t1: { id: 't1', messages: [] }, t2: { id: 't2', messages: [] } },
    });
    const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
    await controller.boot();

    controller.handleEvent({ type: 'approval', threadId: 't1', approval: { id: 17 } });
    controller.handleEvent({ type: 'approval', threadId: 't2', approval: { id: 29 } });
    const dialogCapture = { id: 17, ownerThreadId: 't1' };
    await controller.selectThread('t2');

    await controller.resolveApproval(dialogCapture.ownerThreadId, dialogCapture.id, decision);

    assert.deepEqual(client.calls.at(-1), ['respondApproval', 17, decision]);
    assert.deepEqual(controller.getState().approvals.t1, { id: 17 });
    assert.deepEqual(controller.getState().approvals.t2, { id: 29 });
    controller.handleEvent({ type: 'approval-resolved', threadId: 't1', id: 17, decision });
    assert.equal(controller.getState().approvals.t1, undefined);
  }
});

test('approval UI disables accept when App Server cannot guarantee a one-shot decision', async () => {
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /approvalAllow:\s*document\.querySelector\('#approval-allow'\)/);
  assert.match(appSource, /el\.approvalAllow\.disabled = approval\.canAcceptOnce === false/);
  assert.doesNotMatch(appSource, /acceptForSession/);
});

test('late thread detail does not erase a live delta received while selection is in flight', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'One' }],
    details: { t1: { id: 't1', messages: [{ role: 'user', text: 'Question' }] } },
  });
  const visibleStreams = [];
  const controller = createController({
    api: client,
    stateTools: { createState, reduce, setDraft, clearThreadState },
    onChange: (state) => visibleStreams.push(state.activeThreadId ? state.streams[state.activeThreadId] : undefined),
  });
  await controller.boot();

  let resolveDetail;
  client.readThread = () => new Promise((resolve) => { resolveDetail = resolve; });
  const selection = controller.selectThread('t1');
  client.emit({ type: 'assistant-delta', threadId: 't1', text: 'Partial answer' });
  resolveDetail({ id: 't1', messages: [{ role: 'user', text: 'Question' }] });
  await selection;

  assert.equal(controller.getState().activeThreadId, 't1');
  assert.equal(controller.getState().streams.t1, 'Partial answer');
  assert.equal(visibleStreams.at(-1), 'Partial answer');
});

test('final assistant event does not duplicate authoritative detail and clears its live stream', () => {
  let state = createState({
    activeThreadId: 't1',
    details: {
      t1: {
        id: 't1',
        messages: [
          { role: 'user', text: 'Question' },
          { role: 'assistant', text: 'Complete answer' },
        ],
      },
    },
    streams: { t1: 'Complete ans' },
  });

  state = reduce(state, { type: 'assistant-message', threadId: 't1', text: 'Complete answer' });

  assert.deepEqual(state.details.t1.messages, [
    { role: 'user', text: 'Question' },
    { role: 'assistant', text: 'Complete answer' },
  ]);
  assert.equal(state.streams.t1, '');
});

test('pre-final detail response cannot erase a final SSE message that arrived while selection was in flight', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'One' }],
    details: { t1: { id: 't1', messages: [{ role: 'user', text: 'Question' }] } },
  });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();

  let resolveDetail;
  client.readThread = () => new Promise((resolve) => { resolveDetail = resolve; });
  const selection = controller.selectThread('t1');
  client.emit({ type: 'assistant-delta', threadId: 't1', text: 'Complete ans' });
  client.emit({ type: 'assistant-message', threadId: 't1', text: 'Complete answer' });
  assert.equal(controller.getState().streams.t1, '');
  assert.equal(controller.getState().details.t1.messages.filter((message) => message.role === 'assistant').length, 1);

  resolveDetail({ id: 't1', messages: [{ role: 'user', text: 'Question' }] });
  await selection;

  assert.deepEqual(controller.getState().details.t1.messages, [
    { role: 'user', text: 'Question' },
    { role: 'assistant', text: 'Complete answer' },
  ]);
  assert.equal(controller.getState().streams.t1, '');
});

test('detail without a newer SSE event still replaces history authoritatively', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'One' }],
    details: { t1: { id: 't1', messages: [{ role: 'user', text: 'Old history' }] } },
  });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  client.readThread = async () => ({ id: 't1', messages: [{ role: 'user', text: 'Authoritative history' }] });

  await controller.selectThread('t1');

  assert.deepEqual(controller.getState().details.t1.messages, [{ role: 'user', text: 'Authoritative history' }]);
});

test('editing a draft during a detail read preserves the draft and applies authoritative history', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'One' }],
    details: { t1: { id: 't1', messages: [{ role: 'user', text: 'Old history' }] } },
  });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  let resolveDetail;
  client.readThread = () => new Promise((resolve) => { resolveDetail = resolve; });

  const selection = controller.selectThread('t1');
  controller.changeDraft('Keep this draft');
  resolveDetail({ id: 't1', messages: [{ role: 'user', text: 'Authoritative history' }] });
  await selection;

  assert.equal(controller.getState().drafts.t1, 'Keep this draft');
  assert.deepEqual(controller.getState().details.t1.messages, [{ role: 'user', text: 'Authoritative history' }]);
});

test('rapid thread switches keep delayed detail and live stream isolated by thread', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }],
    details: {
      t1: { id: 't1', messages: [{ role: 'user', text: 'One old' }] },
      t2: { id: 't2', messages: [{ role: 'user', text: 'Two old' }] },
    },
  });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  const resolvers = new Map();
  client.readThread = (threadId) => new Promise((resolve) => resolvers.set(threadId, resolve));

  const first = controller.selectThread('t1');
  const second = controller.selectThread('t2');
  client.emit({ type: 'assistant-delta', threadId: 't1', text: 'One live' });
  resolvers.get('t2')({ id: 't2', messages: [{ role: 'user', text: 'Two authoritative' }] });
  resolvers.get('t1')({ id: 't1', messages: [{ role: 'user', text: 'One stale' }] });
  await Promise.all([first, second]);

  assert.equal(controller.getState().activeThreadId, 't2');
  assert.equal(controller.getState().streams.t1, 'One live');
  assert.equal(controller.getState().streams.t2, undefined);
  assert.deepEqual(controller.getState().details.t2.messages, [{ role: 'user', text: 'Two authoritative' }]);
});

test('pre-send detail response cannot erase an accepted local message or queue snapshot', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'One' }],
    details: { t1: { id: 't1', messages: [{ role: 'user', text: 'Earlier' }], queue: [] } },
  });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  let resolveDetail;
  client.readThread = () => new Promise((resolve) => { resolveDetail = resolve; });
  client.send = async (threadId, message) => ({
    accepted: true,
    disposition: 'queued',
    threadId,
    queue: [{ id: 'q1', message }],
  });

  const selection = controller.selectThread('t1');
  controller.changeDraft('Accepted follow-up');
  await controller.send();
  resolveDetail({ id: 't1', messages: [{ role: 'user', text: 'Earlier' }], queue: [] });
  await selection;

  assert.deepEqual(controller.getState().details.t1.messages, [
    { role: 'user', text: 'Earlier' },
    { role: 'user', text: 'Accepted follow-up' },
  ]);
  assert.deepEqual(controller.getState().queues.t1, [{ id: 'q1', message: 'Accepted follow-up' }]);
});

test('late detail cannot undo an accepted local rename', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'Old name' }],
    details: { t1: { id: 't1', title: 'Old name', messages: [] } },
  });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  let resolveDetail;
  client.readThread = () => new Promise((resolve) => { resolveDetail = resolve; });

  const selection = controller.selectThread('t1');
  await controller.renameThread('t1', 'New name');
  resolveDetail({ id: 't1', title: 'Old name', messages: [] });
  await selection;

  assert.equal(controller.getState().details.t1.title, 'New name');
});

test('late detail cannot recreate locally deleted thread state', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'One' }],
    details: { t1: { id: 't1', messages: [] } },
  });
  const controller = createController({
    api: client,
    stateTools: { createState, reduce, setDraft, clearThreadState },
    confirmDelete: () => true,
  });
  await controller.boot();
  let resolveDeletedDetail;
  client.readThread = (threadId) => threadId === 't1'
    ? new Promise((resolve) => { resolveDeletedDetail = resolve; })
    : Promise.resolve({ id: threadId, messages: [] });

  const staleSelection = controller.selectThread('t1');
  await controller.deleteThread('t1');
  resolveDeletedDetail({ id: 't1', messages: [{ role: 'user', text: 'Stale' }] });
  await staleSelection;

  assert.equal(controller.getState().details.t1, undefined);
  assert.equal(controller.getState().activeThreadId, 'created-1');
});

test('late detail cannot restore a queue item removed locally', async () => {
  const { createController } = globalThis.JarvisApp;
  const queued = [{ id: 'q1', message: 'Remove me' }];
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'One' }],
    details: { t1: { id: 't1', messages: [], queue: queued } },
  });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  let resolveDetail;
  client.readThread = () => new Promise((resolve) => { resolveDetail = resolve; });

  const selection = controller.selectThread('t1');
  await controller.removeQueued('t1', 'q1');
  resolveDetail({ id: 't1', messages: [], queue: queued });
  await selection;

  assert.deepEqual(controller.getState().queues.t1, []);
});

test('removeQueued publishes the authoritative queue snapshot returned by the server', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'One' }],
    details: {
      t1: {
        id: 't1',
        messages: [],
        queue: [{ id: 'q1', message: 'Remove me' }, { id: 'q2', message: 'Old copy' }],
      },
    },
  });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  const authoritativeQueue = [
    { id: 'q2', message: 'Server copy' },
    { id: 'q3', message: 'Added elsewhere' },
  ];
  client.removeQueued = async () => ({ removed: true, threadId: 't1', queue: authoritativeQueue });

  const result = await controller.removeQueued('t1', 'q1');

  assert.deepEqual(result, { removed: true, threadId: 't1', queue: authoritativeQueue });
  assert.deepEqual(controller.getState().queues.t1, authoritativeQueue);
});

test('removeQueued rejects malformed queue results without publishing fabricated state', async () => {
  const malformedResults = [
    { removed: true, threadId: 't1' },
    { removed: true, threadId: 't1', queue: { id: 'q2' } },
  ];

  for (const malformedResult of malformedResults) {
    const { createController } = globalThis.JarvisApp;
    const initialQueue = [{ id: 'q1', message: 'Remove me' }, { id: 'q2', message: 'Keep me' }];
    const client = fakeControllerApi({
      threads: [{ id: 't1', title: 'One' }],
      details: { t1: { id: 't1', messages: [], queue: initialQueue } },
    });
    const published = [];
    const controller = createController({
      api: client,
      stateTools: { createState, reduce, setDraft, clearThreadState },
      onChange: (_state, event) => published.push(event),
    });
    await controller.boot();
    published.length = 0;
    client.removeQueued = async () => malformedResult;

    await assert.rejects(controller.removeQueued('t1', 'q1'), (error) => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.equal(error.message, 'JARVIS вернул некорректный снимок очереди.');
      return true;
    });
    assert.deepEqual(controller.getState().queues.t1, initialQueue);
    assert.equal(published.some((event) => event.type === 'queue'), false);
  }
});

test('newest overlapping detail request wins for the same thread', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({ threads: [{ id: 't1', title: 'One' }], details: { t1: { id: 't1', messages: [] } } });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  const resolvers = [];
  client.readThread = () => new Promise((resolve) => resolvers.push(resolve));

  const older = controller.selectThread('t1');
  const newer = controller.selectThread('t1');
  resolvers[1]({ id: 't1', messages: [{ role: 'user', text: 'Newest' }] });
  await newer;
  resolvers[0]({ id: 't1', messages: [{ role: 'user', text: 'Older' }] });
  await older;

  assert.deepEqual(controller.getState().details.t1.messages, [{ role: 'user', text: 'Newest' }]);
});

test('failed detail read does not prevent a later authoritative recovery', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({ threads: [{ id: 't1', title: 'One' }], details: { t1: { id: 't1', messages: [] } } });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  let attempt = 0;
  client.readThread = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('temporary read failure');
    return { id: 't1', messages: [{ role: 'user', text: 'Recovered' }] };
  };

  await assert.rejects(controller.selectThread('t1'), /temporary read failure/);
  await controller.selectThread('t1');

  assert.deepEqual(controller.getState().details.t1.messages, [{ role: 'user', text: 'Recovered' }]);
});

test('controller preserves a draft on send failure and clears it only after acceptance', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({ threads: [{ id: 't1', title: 'One' }], details: { t1: { id: 't1', messages: [] } } });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  controller.changeDraft('unsent');
  client.send = async () => { throw new Error('offline'); };

  await assert.rejects(controller.send(), /offline/);
  assert.equal(controller.getState().drafts.t1, 'unsent');

  client.send = async (threadId) => ({ disposition: 'queued', threadId, queue: [{ id: 'q1', message: 'unsent' }] });
  await controller.send();
  assert.equal(controller.getState().drafts.t1, '');
  assert.equal(controller.getState().queues.t1[0].id, 'q1');
});

test('controller searches server-side and requires confirmation before delete', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({ threads: [{ id: 't1', title: 'One' }], details: { t1: { id: 't1', messages: [] } } });
  let confirmed = false;
  const controller = createController({
    api: client,
    stateTools: { createState, reduce, setDraft, clearThreadState },
    confirmDelete: () => confirmed,
  });
  await controller.boot();
  await controller.search('One');
  assert.deepEqual(client.calls.at(-1), ['listThreads', 'One']);

  assert.equal(await controller.deleteThread('t1'), false);
  assert.equal(client.calls.some(([name]) => name === 'deleteThread'), false);
  confirmed = true;
  assert.equal(await controller.deleteThread('t1'), true);
  assert.equal(client.calls.some(([name]) => name === 'deleteThread'), true);
  assert.equal(controller.getState().activeThreadId, 'created-1');
});

test('server exposes browser modules as JavaScript static assets', async () => {
  const server = createJarvisHttpServer({ publicDirectory: new URL('../public/', import.meta.url) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    for (const pathname of ['/state.js', '/api.js', '/chat-view.js', '/app.js']) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      assert.equal(response.status, 200, pathname);
      assert.match(response.headers.get('content-type'), /javascript/i, pathname);
      assert.ok((await response.text()).length > 20, pathname);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('attachment controller validates max four before upload and uploads accepted images sequentially', async () => {
  const calls = [];
  let activeUploads = 0;
  let peakUploads = 0;
  const api = {
    async uploadAttachment(payload) {
      activeUploads += 1;
      peakUploads = Math.max(peakUploads, activeUploads);
      calls.push(payload.name);
      await Promise.resolve();
      activeUploads -= 1;
      return { id: `id-${payload.name}`, name: payload.name, mime: payload.mime, size: 10 };
    },
    async deleteAttachment() {},
  };
  const urls = [];
  const controller = createAttachmentController({
    api,
    getThreadId: () => 't1',
    readDataUrl: async (file) => `data:${file.type};base64,${file.name}`,
    urlApi: {
      createObjectURL(file) { const url = `blob:${file.name}`; urls.push(url); return url; },
      revokeObjectURL() {},
    },
  });
  const image = (name) => ({ name, type: 'image/png', size: 10 });

  const accepted = await controller.acceptFiles([image('1'), image('2'), image('3'), image('4')]);
  const rejected = await controller.acceptFiles([image('5')]);

  assert.deepEqual(calls, ['1', '2', '3', '4']);
  assert.equal(peakUploads, 1);
  assert.equal(accepted.accepted.length, 4);
  assert.equal(rejected.accepted.length, 0);
  assert.match(rejected.rejected[0].message, /четыр/i);
  assert.deepEqual(controller.getSnapshot().attachments.map(({ id }) => id), ['id-1', 'id-2', 'id-3', 'id-4']);
  assert.deepEqual(urls, ['blob:1', 'blob:2', 'blob:3', 'blob:4']);
});

test('attachment controller rejects MIME and 8 MiB violations locally and revokes preview URLs', async () => {
  const uploads = [];
  const deleted = [];
  const revoked = [];
  let threadId = 't1';
  const controller = createAttachmentController({
    api: {
      async uploadAttachment(payload) { uploads.push(payload); return { id: `a${uploads.length}` }; },
      async deleteAttachment(owner, id) { deleted.push([owner, id]); },
    },
    getThreadId: () => threadId,
    readDataUrl: async () => 'data:image/png;base64,AAAA',
    urlApi: { createObjectURL: () => 'blob:preview', revokeObjectURL: (url) => revoked.push(url) },
  });

  const result = await controller.acceptFiles([
    { name: 'bad.svg', type: 'image/svg+xml', size: 10 },
    { name: 'huge.png', type: 'image/png', size: (8 * 1024 * 1024) + 1 },
    { name: 'ok.png', type: 'image/png', size: 10 },
  ]);
  assert.equal(result.rejected.length, 2);
  assert.equal(uploads.length, 1);

  await controller.remove('a1');
  assert.deepEqual(revoked, ['blob:preview']);
  assert.deepEqual(deleted, [['t1', 'a1']]);

  await controller.acceptFiles([{ name: 'next.png', type: 'image/png', size: 10 }]);
  threadId = 't2';
  await controller.switchThread('t2');
  assert.deepEqual(revoked, ['blob:preview', 'blob:preview']);
  assert.deepEqual(controller.getSnapshot().attachments, []);
});

test('attachment commit revokes only submitted previews and preserves a later attachment draft', async () => {
  const revoked = [];
  let nextId = 0;
  const controller = createAttachmentController({
    api: {
      async uploadAttachment() { nextId += 1; return { id: `a${nextId}` }; },
      async deleteAttachment() {},
    },
    getThreadId: () => 't1',
    readDataUrl: async () => 'data:image/png;base64,AAAA',
    urlApi: {
      createObjectURL: (file) => `blob:${file.name}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
  });
  await controller.acceptFiles([{ name: 'sent.png', type: 'image/png', size: 10 }]);
  const submittedIds = controller.getSnapshot().attachments.map(({ id }) => id);
  await controller.acceptFiles([{ name: 'next.png', type: 'image/png', size: 10 }]);

  controller.commit(submittedIds);

  assert.deepEqual(revoked, ['blob:sent.png']);
  assert.deepEqual(controller.getSnapshot().attachments.map(({ name }) => name), ['next.png']);
});

test('late old-thread upload is deleted after switch and never appears in the new thread tray', async () => {
  let threadId = 't1';
  let resolveUpload;
  const uploadStarted = new Promise((resolve) => {
    resolveUpload = { started: resolve, finish: null };
  });
  const delayedResult = new Promise((resolve) => { resolveUpload.finish = resolve; });
  const deleted = [];
  const createdUrls = [];
  const revoked = [];
  const controller = createAttachmentController({
    api: {
      async uploadAttachment(payload) {
        resolveUpload.started(payload);
        return delayedResult;
      },
      async deleteAttachment(owner, id) { deleted.push([owner, id]); },
    },
    getThreadId: () => threadId,
    readDataUrl: async () => 'data:image/png;base64,AAAA',
    urlApi: {
      createObjectURL(file) { createdUrls.push(file.name); return `blob:${file.name}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
  });

  const accepting = controller.acceptFiles([{ name: 'old.png', type: 'image/png', size: 10 }]);
  await uploadStarted;
  threadId = 't2';
  await controller.switchThread('t2');
  resolveUpload.finish({ id: 'old-id' });
  const result = await accepting;

  assert.deepEqual(result, { accepted: [], rejected: [] });
  assert.deepEqual(deleted, [['t1', 'old-id']]);
  assert.deepEqual(createdUrls, []);
  assert.deepEqual(revoked, []);
  assert.deepEqual(controller.getSnapshot().attachments, []);
});

test('stale upload cleanup failure returns one stable path-free inline error', async () => {
  let threadId = 't1';
  let finishUpload;
  let markUploadStarted;
  const uploadStarted = new Promise((resolve) => { markUploadStarted = resolve; });
  const delayedUpload = new Promise((resolve) => { finishUpload = resolve; });
  const controller = createAttachmentController({
    api: {
      async uploadAttachment() { markUploadStarted(); return delayedUpload; },
      async deleteAttachment() { throw new Error('C:\\private\\attachments\\secret.png'); },
    },
    getThreadId: () => threadId,
    readDataUrl: async () => 'data:image/png;base64,AAAA',
    urlApi: { createObjectURL: () => 'blob:old', revokeObjectURL() {} },
  });

  const accepting = controller.acceptFiles([{ name: 'old.png', type: 'image/png', size: 10 }]);
  await uploadStarted;
  threadId = 't2';
  await controller.switchThread('t2');
  finishUpload({ id: 'old-id' });
  const result = await accepting;

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].code, 'STALE_ATTACHMENT_CLEANUP_FAILED');
  assert.equal(result.rejected[0].message, 'Не удалось удалить отменённое изображение.');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('preview URL created during a reentrant switch is revoked before stale upload cleanup', async () => {
  let threadId = 't1';
  let switchDone = Promise.resolve();
  const deleted = [];
  const revoked = [];
  let controller;
  controller = createAttachmentController({
    api: {
      async uploadAttachment() { return { id: 'old-id' }; },
      async deleteAttachment(owner, id) { deleted.push([owner, id]); },
    },
    getThreadId: () => threadId,
    readDataUrl: async () => 'data:image/png;base64,AAAA',
    urlApi: {
      createObjectURL() {
        threadId = 't2';
        switchDone = controller.switchThread('t2');
        return 'blob:old';
      },
      revokeObjectURL(url) { revoked.push(url); },
    },
  });

  const result = await controller.acceptFiles([{ name: 'old.png', type: 'image/png', size: 10 }]);
  await switchDone;

  assert.deepEqual(result, { accepted: [], rejected: [] });
  assert.deepEqual(revoked, ['blob:old']);
  assert.deepEqual(deleted, [['t1', 'old-id']]);
  assert.deepEqual(controller.getSnapshot().attachments, []);
});

test('two concurrent three-image acquisitions start at most four uploads total', async () => {
  let uploads = 0;
  let activeUploads = 0;
  let peakUploads = 0;
  const controller = createAttachmentController({
    api: {
      async uploadAttachment(payload) {
        uploads += 1;
        activeUploads += 1;
        peakUploads = Math.max(peakUploads, activeUploads);
        await Promise.resolve();
        activeUploads -= 1;
        return { id: `a${uploads}`, name: payload.name };
      },
      async deleteAttachment() {},
    },
    getThreadId: () => 't1',
    readDataUrl: async () => 'data:image/png;base64,AAAA',
    urlApi: { createObjectURL: (file) => `blob:${file.name}`, revokeObjectURL() {} },
  });
  const image = (name) => ({ name, type: 'image/png', size: 10 });

  const [first, second] = await Promise.all([
    controller.acceptFiles([image('1'), image('2'), image('3')]),
    controller.acceptFiles([image('4'), image('5'), image('6')]),
  ]);

  assert.equal(uploads, 4);
  assert.equal(peakUploads, 1);
  assert.equal(first.accepted.length + second.accepted.length, 4);
  assert.equal(first.rejected.length + second.rejected.length, 2);
  assert.equal(controller.getSnapshot().attachments.length, 4);
});

test('attachment-only submission separates the visible Russian label from the server instruction', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({ threads: [{ id: 't1', title: 'One' }], details: { t1: { id: 't1', messages: [] } } });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();

  await controller.send({ attachmentIds: ['a1'], visibleText: ATTACHMENT_ONLY_LABEL, serverMessage: ATTACHMENT_ONLY_INSTRUCTION });

  assert.deepEqual(client.calls.find(([name]) => name === 'send'), ['send', 't1', ATTACHMENT_ONLY_INSTRUCTION, ['a1']]);
  assert.equal(controller.getState().details.t1.messages.at(-1).text, ATTACHMENT_ONLY_LABEL);
});

test('queued disposition never creates pending; turn-started does so only for its thread', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({
    threads: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }],
    details: { t1: { id: 't1', messages: [] }, t2: { id: 't2', messages: [] } },
  });
  client.send = async (threadId, message) => ({ disposition: 'queued', threadId, queue: [{ id: 'q1', message, attachments: [] }] });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  controller.changeDraft('queued');
  await controller.send();
  assert.equal(controller.isPending('t1'), false);
  assert.equal(controller.getState().queues.t1[0].id, 'q1');

  controller.handleEvent({ type: 'turn-started', threadId: 't2' });
  assert.equal(controller.isPending('t1'), false);
  assert.equal(controller.isPending('t2'), true);
  controller.handleEvent({ type: 'assistant-delta', threadId: 't2', text: 'Г' });
  assert.equal(controller.isPending('t2'), false);
});

test('draft typed while a send is in flight remains the next editable draft', async () => {
  const { createController } = globalThis.JarvisApp;
  const client = fakeControllerApi({ threads: [{ id: 't1', title: 'One' }], details: { t1: { id: 't1', messages: [] } } });
  let acceptSend;
  client.send = async (threadId) => new Promise((resolve) => { acceptSend = () => resolve({ disposition: 'started', threadId, queue: [] }); });
  const controller = createController({ api: client, stateTools: { createState, reduce, setDraft, clearThreadState } });
  await controller.boot();
  controller.changeDraft('первый запрос');
  const sending = controller.send();
  controller.changeDraft('следующий черновик');
  acceptSend();
  await sending;

  assert.equal(controller.getState().drafts.t1, 'следующий черновик');
  assert.equal(controller.getState().details.t1.messages.at(-1).text, 'первый запрос');
});

test('insertAtSelection replaces only the current selection and returns the caret', () => {
  assert.deepEqual(insertAtSelection('Скажи это сейчас', 6, 9, 'точно'), {
    value: 'Скажи точно сейчас',
    selectionStart: 11,
    selectionEnd: 11,
  });
});

test('voice check records, transcribes, inserts at selection, and never submits chat', async () => {
  const transitions = [];
  const inserted = [];
  const tracks = [{ stopCalls: 0, stop() { this.stopCalls += 1; } }];
  const stream = { getTracks: () => tracks };
  let recorder;
  class FakeRecorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(_stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; recorder = this; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  let resolveTranscription;
  const transcribing = new Promise((resolve) => { resolveTranscription = resolve; });
  let chatSubmits = 0;
  const voice = createVoiceController({
    mediaDevices: { getUserMedia: async () => stream },
    MediaRecorderImpl: FakeRecorder,
    transcribe: async (audio) => { assert.equal(audio.mime, 'audio/webm;codecs=opus'); await transcribing; return { text: 'голосом' }; },
    blobToBase64: async () => 'Vk9JQ0U=',
    getSelection: () => ({ value: 'Скажи  сейчас', selectionStart: 6, selectionEnd: 6 }),
    insertTranscript: (result) => inserted.push(result),
    onStateChange: (state) => transitions.push(state.mode),
    submitChat: () => { chatSubmits += 1; },
  });

  await voice.start();
  assert.equal(recorder.mimeType, 'audio/webm;codecs=opus');
  const checking = voice.check();
  await Promise.resolve();
  assert.equal(voice.getState().mode, 'transcribing');
  resolveTranscription();
  await checking;

  assert.deepEqual(transitions, ['recording', 'transcribing', 'idle']);
  assert.equal(inserted[0].value, 'Скажи голосом сейчас');
  assert.equal(chatSubmits, 0);
  assert.equal(tracks[0].stopCalls, 1);
});

test('voice Escape cancellation returns idle, stops tracks, and discards audio', async () => {
  const track = { stopped: 0, stop() { this.stopped += 1; } };
  let transcriptions = 0;
  class FakeRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  const voice = createVoiceController({
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    MediaRecorderImpl: FakeRecorder,
    transcribe: async () => { transcriptions += 1; },
  });
  await voice.start();
  assert.equal(await voice.cancel(), true);
  assert.equal(voice.getState().mode, 'idle');
  assert.equal(track.stopped, 1);
  assert.equal(transcriptions, 0);
});
