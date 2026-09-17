import test from 'node:test';
import assert from 'node:assert/strict';

import { VoiceRuntime } from '../src/voice-runtime.js';

const THREAD_ID = '0191f47a-0e6c-7d6a-b5cb-953c58db5f68';
const COMMAND_ID = '650e8400-e29b-41d4-a716-446655440000';

class MemoryStateStore {
  constructor(threadId = null) {
    this.threadId = threadId;
    this.saved = [];
  }
  async load() { return this.threadId ? { threadId: this.threadId } : {}; }
  async save(value) { this.threadId = value.threadId; this.saved.push(value); }
}

class FakeJarvis {
  constructor() {
    this.listeners = new Set();
    this.calls = [];
    this.readFailure = null;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async readThread(threadId, options) {
    this.calls.push(['readThread', threadId, options]);
    if (this.readFailure) throw this.readFailure;
    return { id: threadId };
  }
  async createThread(options) {
    this.calls.push(['createThread', options]);
    return { id: THREAD_ID };
  }
  async renameThread(threadId, name) {
    this.calls.push(['renameThread', threadId, name]);
    return { threadId, name };
  }
  async send(input) {
    this.calls.push(['send', input]);
    return { accepted: true, disposition: 'started', threadId: input.threadId, itemId: COMMAND_ID, queue: [] };
  }
  async respondToApproval(id, decision) {
    this.calls.push(['respondToApproval', id, decision]);
    return { id, decision, threadId: THREAD_ID };
  }
}

function makeRuntime(options = {}) {
  const jarvis = options.jarvis || new FakeJarvis();
  const store = options.store || new MemoryStateStore(options.threadId);
  const timers = [];
  const runtime = new VoiceRuntime({
    jarvis,
    stateStore: store,
    approvalTtlMs: 60_000,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { timer.cleared = true; },
  });
  return { runtime, jarvis, store, timers };
}

test('creates and persists one non-activating Voice Commands thread, then reuses it', async () => {
  const { runtime, jarvis, store } = makeRuntime();

  const first = await runtime.submitTranscript('Покажи файлы на рабочем столе');
  const second = await runtime.submitTranscript('Открой Downloads');

  assert.equal(first.threadId, THREAD_ID);
  assert.equal(second.threadId, THREAD_ID);
  assert.ok(Number.isFinite(first.timings.routedAtUnixMs));
  assert.ok(Number.isFinite(first.timings.acceptedAtUnixMs));
  assert.ok(first.timings.acceptedAtUnixMs >= first.timings.routedAtUnixMs);
  assert.deepEqual(store.saved, [{ threadId: THREAD_ID }]);
  assert.deepEqual(jarvis.calls.filter(([name]) => name === 'createThread'), [['createThread', { activate: false }]]);
  assert.deepEqual(jarvis.calls.filter(([name]) => name === 'renameThread'), [['renameThread', THREAD_ID, 'Voice Commands']]);
  assert.equal(jarvis.calls.filter(([name]) => name === 'send').length, 2);
  assert.equal(jarvis.calls.find(([name]) => name === 'send')[1].source, 'voice');
});

test('recreates exactly one empty Voice Commands conversation after history deletion', async () => {
  const { runtime, jarvis, store } = makeRuntime({ threadId: THREAD_ID });
  await runtime.initialize?.();
  await runtime.submitTranscript('Проверить связь');
  jarvis.calls.length = 0;
  jarvis.readThread = async () => { throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' }); };

  const result = await runtime.resetConversation();

  assert.equal(result.threadId, THREAD_ID);
  assert.deepEqual(jarvis.calls.filter(([name]) => name === 'createThread'), [['createThread', { activate: false }]]);
  assert.deepEqual(jarvis.calls.filter(([name]) => name === 'renameThread'), [['renameThread', THREAD_ID, 'Voice Commands']]);
  assert.equal(store.saved.at(-1).threadId, THREAD_ID);
});

test('reuses a valid persisted thread without activating it and recovers a missing one', async () => {
  const valid = makeRuntime({ threadId: THREAD_ID });
  await valid.runtime.submitTranscript('Первый запрос');
  assert.deepEqual(valid.jarvis.calls[0], ['readThread', THREAD_ID, { activate: false }]);
  assert.equal(valid.jarvis.calls.some(([name]) => name === 'createThread'), false);

  const missingJarvis = new FakeJarvis();
  missingJarvis.readFailure = Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
  const recovered = makeRuntime({ jarvis: missingJarvis, threadId: '0191f47a-0e6c-7d6a-b5cb-953c58db5f69' });
  await recovered.runtime.submitTranscript('Новый запрос');
  assert.equal(missingJarvis.calls.some(([name]) => name === 'createThread'), true);
});

test('blocks destructive voice intent before Codex and preserves the exact transcript for safe sends', async () => {
  const { runtime, jarvis } = makeRuntime();

  const blocked = await runtime.submitTranscript('Отформатируй диск C:');
  const accepted = await runtime.submitTranscript('  Создай папку Голос  ');

  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.overrideAllowed, false);
  const sends = jarvis.calls.filter(([name]) => name === 'send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1].message, 'Создай папку Голос');
  assert.equal(accepted.commandId, COMMAND_ID);
});

test('tracks queue, execution, completion, auth errors, and stable command status by item id', async () => {
  const { runtime, jarvis } = makeRuntime();
  await runtime.submitTranscript('Проверить статус');

  jarvis.emit({ type: 'turn-started', threadId: THREAD_ID, itemId: COMMAND_ID, source: 'voice' });
  assert.equal(runtime.status(COMMAND_ID).state, 'executing');
  jarvis.emit({ type: 'turn-completed', threadId: THREAD_ID, itemId: COMMAND_ID, source: 'voice', status: 'completed' });
  assert.equal(runtime.status(COMMAND_ID).state, 'success');

  jarvis.emit({ type: 'error', threadId: THREAD_ID, itemId: COMMAND_ID, source: 'voice', authRequired: true, message: 'Login required.' });
  assert.equal(runtime.status(COMMAND_ID).state, 'auth-required');
  assert.equal(JSON.stringify(runtime.status(COMMAND_ID)).includes('token'), false);
});

test('exposes a compact display payload from the real final voice answer while history remains canonical', async () => {
  const { runtime, jarvis } = makeRuntime();
  await runtime.submitTranscript('Какая сейчас погода?');

  jarvis.emit({
    type: 'activity',
    threadId: THREAD_ID,
    commandId: COMMAND_ID,
    source: 'voice',
    activity: { id: 'web-1', category: 'web', state: 'complete' },
  });
  const fullAnswer = `Сейчас около +18 °C, облачно. ${'К вечеру возможен короткий дождь. '.repeat(20)}`;
  jarvis.emit({
    type: 'assistant-message',
    threadId: THREAD_ID,
    commandId: COMMAND_ID,
    source: 'voice',
    text: fullAnswer,
  });
  jarvis.emit({ type: 'turn-completed', threadId: THREAD_ID, itemId: COMMAND_ID, source: 'voice', status: 'completed' });

  const status = runtime.status(COMMAND_ID);
  assert.equal(status.state, 'success');
  assert.equal(status.display.type, 'answer');
  assert.equal(status.display.requestId, COMMAND_ID);
  assert.equal(status.display.truncated, true);
  assert.ok(status.display.text.length <= 320);
  assert.equal(JSON.stringify(status).includes(fullAnswer), false);
});

test('voice confirmation answers the original approval without creating a turn and waits for server resolution', async () => {
  const { runtime, jarvis, timers } = makeRuntime();
  await runtime.submitTranscript('Удалить test-workspace\\old.txt');
  jarvis.emit({
    type: 'approval',
    threadId: THREAD_ID,
    source: 'voice',
    commandId: COMMAND_ID,
    approval: { id: 17, target: 'C:\\work\\test-workspace\\old.txt', safetyLevel: 'approval' },
  });

  const sendCount = jarvis.calls.filter(([name]) => name === 'send').length;
  const resolved = await runtime.submitTranscript('да подтверждаю');
  assert.equal(resolved.kind, 'approval');
  assert.deepEqual(jarvis.calls.find((call) => call[0] === 'respondToApproval'), ['respondToApproval', 17, 'accept']);
  assert.equal(jarvis.calls.filter(([name]) => name === 'send').length, sendCount);
  assert.equal(runtime.snapshot().pendingApproval.id, 17);
  assert.equal(runtime.snapshot().pendingApproval.answering, true);
  assert.equal(timers.length, 0);

  jarvis.emit({ type: 'approval-resolved', threadId: THREAD_ID, source: 'voice', commandId: COMMAND_ID, id: 17, decision: 'accept' });
  assert.equal(runtime.snapshot().pendingApproval, null);
});

test('ambiguous short approval speech keeps the prompt pending and does not start another turn', async () => {
  const { runtime, jarvis } = makeRuntime();
  await runtime.submitTranscript('Удалить test-workspace\\old.txt');
  jarvis.emit({
    type: 'approval',
    threadId: THREAD_ID,
    source: 'voice',
    commandId: COMMAND_ID,
    approval: { id: 18, target: 'C:\\work\\test-workspace\\old.txt', safetyLevel: 'approval' },
  });
  const sendCount = jarvis.calls.filter(([name]) => name === 'send').length;

  const result = await runtime.submitTranscript('может быть');

  assert.equal(result.kind, 'approval-pending');
  assert.equal(runtime.snapshot().pendingApproval.id, 18);
  assert.equal(jarvis.calls.filter(([name]) => name === 'send').length, sendCount);
  assert.equal(jarvis.calls.some(([name]) => name === 'respondToApproval'), false);
});

test('failed approval response remains pending and can be retried safely', async () => {
  const jarvis = new FakeJarvis();
  jarvis.respondToApproval = async () => { throw new Error('transport unavailable'); };
  const { runtime } = makeRuntime({ jarvis });
  await runtime.submitTranscript('Удалить test-workspace\\old.txt');
  jarvis.emit({
    type: 'approval',
    threadId: THREAD_ID,
    source: 'voice',
    commandId: COMMAND_ID,
    approval: { id: 20, target: 'C:\\work\\test-workspace\\old.txt', safetyLevel: 'approval' },
  });

  await assert.rejects(runtime.submitTranscript('разрешаю'), /transport unavailable/);
  assert.equal(runtime.snapshot().pendingApproval.id, 20);
  assert.equal(runtime.snapshot().pendingApproval.answering, false);
});

test('multiple pending approvals are never guessed from one voice confirmation', async () => {
  const { runtime, jarvis } = makeRuntime();
  await runtime.submitTranscript('Удалить test-workspace\\old.txt');
  for (const id of [21, 22]) {
    jarvis.emit({
      type: 'approval',
      threadId: THREAD_ID,
      source: 'voice',
      commandId: COMMAND_ID,
      approval: { id, target: `C:\\work\\test-workspace\\${id}.txt`, safetyLevel: 'approval' },
    });
  }

  const result = await runtime.submitTranscript('да');

  assert.equal(result.kind, 'approval-conflict');
  assert.equal(result.pendingCount, 2);
  assert.equal(jarvis.calls.some(([name]) => name === 'respondToApproval'), false);
});

test('voice runtime mirrors upstream expiry and never owns a second decline timer', async () => {
  const { runtime, jarvis, timers, store } = makeRuntime();
  await runtime.submitTranscript('Удалить test-workspace\\old.txt');
  jarvis.emit({
    type: 'approval',
    threadId: THREAD_ID,
    source: 'voice',
    commandId: COMMAND_ID,
    approval: { id: 19, target: 'C:\\work\\test-workspace\\old.txt', safetyLevel: 'approval' },
  });

  assert.equal(timers.length, 0);
  jarvis.emit({ type: 'approval-resolved', threadId: THREAD_ID, source: 'voice', commandId: COMMAND_ID, id: 19, decision: 'decline', expired: true });
  assert.deepEqual(store.saved, [{ threadId: THREAD_ID }]);
  assert.equal(runtime.snapshot().pendingApproval, null);
});
