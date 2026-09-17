import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ParserRuntime } from '../src/parser/runtime.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { writes: [], write: (value) => {
      this.stdin.writes.push(value);
      const message = JSON.parse(value);
      if (message.method === 'shutdown') queueMicrotask(() => {
        this.stdout.emit('data', `${JSON.stringify({ id: message.id, ok: true, result: { stopped: true } })}\n`);
        this.emit('exit', 0, null);
      });
      return true;
    } };
    this.killed = false;
  }
  kill() { this.killed = true; }
}

test('Parser runtime starts one worker, correlates commands, and forwards typed events', async () => {
  const child = new FakeChild();
  const runtime = new ParserRuntime({ spawnWorker: () => child, requestTimeoutMs: 100 });
  const events = [];
  runtime.subscribe((event) => events.push(event));

  const initializing = runtime.initialize();
  const first = JSON.parse(child.stdin.writes[0]);
  assert.equal(first.method, 'status');
  child.stdout.emit('data', `${JSON.stringify({ id: first.id, ok: true, result: { state: 'STOPPED' } })}\n`);
  assert.deepEqual(await initializing, { state: 'STOPPED' });

  child.stdout.emit('data', `${JSON.stringify({ type: 'event', event: { type: 'parser_state', state: 'RUNNING' } })}\n`);
  assert.equal(events.at(-1).state, 'RUNNING');
  assert.equal(runtime.workerStarts, 1);
  await runtime.stop();
});

test('Parser runtime degrades on crash and uses a bounded restart policy', async () => {
  const children = [];
  const timers = [];
  const runtime = new ParserRuntime({
    spawnWorker: () => { const child = new FakeChild(); children.push(child); return child; },
    restartDelaysMs: [10, 20],
    setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutImpl: () => {},
    requestTimeoutMs: 100,
  });
  const states = [];
  runtime.subscribe((event) => states.push(event));
  const pending = runtime.initialize();
  const command = JSON.parse(children[0].stdin.writes[0]);
  children[0].stdout.emit('data', `${JSON.stringify({ id: command.id, ok: true, result: { state: 'STOPPED' } })}\n`);
  await pending;

  children[0].emit('exit', 1, null);
  assert.equal(states.at(-1).state, 'DEGRADED');
  assert.equal(timers.at(-1).delay, 10);
  timers.at(-1).callback();
  assert.equal(children.length, 2);
  children[1].emit('exit', 1, null);
  assert.equal(timers.at(-1).delay, 20);
  timers.at(-1).callback();
  assert.equal(children.length, 3);
  children[2].emit('exit', 1, null);
  assert.deepEqual(timers.filter(({ delay }) => delay < 100).map(({ delay }) => delay), [10, 20]);
  await runtime.stop();
});

test('Parser runtime never includes secret command parameters in public errors', async () => {
  const child = new FakeChild();
  const runtime = new ParserRuntime({ spawnWorker: () => child, requestTimeoutMs: 100 });
  const initializing = runtime.initialize();
  const status = JSON.parse(child.stdin.writes[0]);
  child.stdout.emit('data', `${JSON.stringify({ id: status.id, ok: true, result: { state: 'STOPPED' } })}\n`);
  await initializing;

  const request = runtime.call('save_settings', { botToken: 'secret-token' });
  const command = JSON.parse(child.stdin.writes.at(-1));
  child.stdout.emit('data', `${JSON.stringify({ id: command.id, ok: false, error: { code: 'INVALID', message: 'Settings rejected' } })}\n`);
  await assert.rejects(request, (error) => {
    assert.equal(error.message, 'Settings rejected');
    assert.doesNotMatch(String(error.stack), /secret-token/);
    return true;
  });
  await runtime.stop();
});

test('Parser runtime never forwards worker stderr content into application logs', async () => {
  const child = new FakeChild();
  const lines = [];
  const runtime = new ParserRuntime({ spawnWorker: () => child, logger: { error: (line) => lines.push(line) } });
  const initializing = runtime.initialize();
  const status = JSON.parse(child.stdin.writes[0]);
  child.stdout.emit('data', `${JSON.stringify({ id: status.id, ok: true, result: { state: 'STOPPED' } })}\n`);
  await initializing;

  child.stderr.emit('data', 'bot_token=extremely-secret-value\n');
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /extremely-secret-value|bot_token/);
  await runtime.stop();
});
