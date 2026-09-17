import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SquarePublisher } from '../src/crypto/publish/square-publisher.js';
import { CryptoEventStore } from '../src/crypto/storage/event-store.js';

class MemoryStateStore {
  constructor(state = {}) {
    this.state = { mode: 'DRY_RUN', autoReady: false, autoArmed: false, pendingPublish: null, posts: [], fingerprints: [], ...state };
    this.snapshots = [];
  }
  async load() { return structuredClone(this.state); }
  async update(update) {
    this.state = await update(structuredClone(this.state));
    this.snapshots.push(structuredClone(this.state));
    return structuredClone(this.state);
  }
}

const content = {
  decision: 'publish',
  postText: '$BTC moved +2.14% while volume reached 5.2x baseline.\n\nThat is the verified move.\n\nIt deserves a closer look.\n\nDid you catch it, or are you watching from the sidelines?',
  cashtag: '$BTC',
  claimsUsed: [{ key: 'return5m', display: '+2.14%' }],
  visualIntent: { preset: 'volume_shock', revealOnOpen: false },
};
const candidate = { id: 'candidate-1', token: 'BTC', symbol: 'BTCUSDT', score: 91, fingerprint: 'fp-1', publicationSequence: 2, metrics: { close: 101.25 } };
const validation = {
  ok: true,
  fingerprint: 'fp-1',
  hookFamily: 'surprising_number',
  openingFingerprint: 'opening-fp-1',
};

test('OFF and DRY_RUN never call the Square adapter', async () => {
  const calls = [];
  const stateStore = new MemoryStateStore();
  const publisher = new SquarePublisher({ stateStore, adapter: {
    resolveApiKey: () => { calls.push('key'); return 'secret'; },
    uploadImage: async () => { calls.push('upload'); },
    publish: async () => { calls.push('publish'); },
  } });
  assert.deepEqual(await publisher.publishPackage({ mode: 'OFF', content, candidate, validation, chartPath: 'chart.png' }), { status: 'off', published: false });
  const dry = await publisher.publishPackage({ mode: 'DRY_RUN', content, candidate, validation, chartPath: 'chart.png' });
  assert.equal(dry.status, 'preview');
  assert.equal(dry.published, false);
  assert.deepEqual(dry.preview, { postText: content.postText, chartPath: 'chart.png' });
  assert.deepEqual(calls, []);
  assert.equal(stateStore.state.pendingPublish, null);
});

test('AUTO is unavailable until a successful DRY_RUN marks the runtime ready', async () => {
  const publisher = new SquarePublisher({ stateStore: new MemoryStateStore({ autoReady: false }), adapter: { resolveApiKey: () => 'secret' } });
  await assert.rejects(() => publisher.publishPackage({ mode: 'AUTO', content, candidate, validation, chartPath: 'chart.png' }), /AUTO is not armed/);
  await assert.rejects(() => publisher.publishPackage({ mode: 'AUTO', content, candidate, validation: { ok: false }, chartPath: 'chart.png' }), /validated content/);
});

test('manual AUTO override bypasses only readiness, not the armed or validated-content requirements', async () => {
  const stateStore = new MemoryStateStore({ autoReady: false, autoArmed: true, manualAutoOverride: true });
  const publisher = new SquarePublisher({ stateStore, adapter: {
    resolveApiKey: () => 'secret', uploadImage: async () => 'image', publish: async () => ({ id: 'manual-1', shareLink: 'https://example.test/manual-1' }),
  } });
  const result = await publisher.publishPackage({ mode: 'AUTO', content, candidate, validation, chartPath: 'chart.png' });
  assert.equal(result.status, 'PUBLISHED');

  const unarmed = new SquarePublisher({
    stateStore: new MemoryStateStore({ autoReady: false, autoArmed: false, manualAutoOverride: true }),
    adapter: { resolveApiKey: () => 'secret' },
  });
  await assert.rejects(() => unarmed.publishPackage({ mode: 'AUTO', content, candidate, validation, chartPath: 'chart.png' }), /AUTO is not armed/);
  await assert.rejects(() => publisher.publishPackage({ mode: 'AUTO', content, candidate, validation: { ok: false }, chartPath: 'chart.png' }), /validated content/);
});

test('AUTO persists intent before official upload and publish, then records success without secrets', async () => {
  const order = [];
  const stateStore = new MemoryStateStore({ autoReady: true, autoArmed: true });
  const publisher = new SquarePublisher({
    stateStore,
    now: () => 1_724_155_200_000,
    adapter: {
      resolveApiKey: () => 'square-super-secret',
      uploadImage: async (key, chartPath) => { order.push({ step: 'upload', key, chartPath, pending: stateStore.state.pendingPublish?.status }); return 'https://cdn.example/chart.png'; },
      publish: async (key, body) => { order.push({ step: 'publish', key, body }); return { id: 'post-1', shareLink: 'https://www.binance.com/square/post/1' }; },
    },
  });
  const result = await publisher.publishPackage({ mode: 'AUTO', content, candidate, validation, chartPath: 'chart.png' });
  assert.equal(order[0].pending, 'PUBLISHING');
  assert.deepEqual(order[1].body, {
    contentType: 1,
    bodyTextOnly: '$BTC moved +2.14% while volume reached 5.2x baseline.\n\u200B\nThat is the verified move.\n\u200B\nIt deserves a closer look.\n\u200B\nDid you catch it, or are you watching from the sidelines?',
    imageList: ['https://cdn.example/chart.png'],
  });
  assert.deepEqual(result, { status: 'PUBLISHED', published: true, id: 'post-1', shareLink: 'https://www.binance.com/square/post/1' });
  assert.equal(stateStore.state.pendingPublish, null);
  assert.equal(stateStore.state.posts.length, 1);
  assert.equal(stateStore.state.posts[0].hookFamily, 'surprising_number');
  assert.equal(stateStore.state.posts[0].openingFingerprint, 'opening-fp-1');
  assert.equal(stateStore.state.posts[0].entryPrice, 101.25);
  assert.equal(stateStore.state.posts[0].publicationSequence, 2);
  assert.equal(JSON.stringify(stateStore.snapshots).includes('square-super-secret'), false);
});

test('AUTO persists one randomized 30–35 minute delivery gap with each real publication', async () => {
  const publishedAt = 1_724_155_200_000;
  const stateStore = new MemoryStateStore({ autoReady: true, autoArmed: true });
  const publisher = new SquarePublisher({
    stateStore,
    now: () => publishedAt,
    random: () => 0.6,
    adapter: {
      resolveApiKey: () => 'secret', uploadImage: async () => 'image', publish: async () => ({ id: 'post-gap' }),
    },
  });
  await publisher.publishPackage({ mode: 'AUTO', content, candidate, validation, chartPath: 'chart.png' });
  const post = stateStore.state.posts[0];
  assert.equal(post.publicationCooldownMs, 40 * 60_000);
  assert.equal(post.nextEligibleAt, publishedAt + 40 * 60_000);
});

test('ambiguous or failed network state is never retried automatically after restart', async () => {
  let publishCalls = 0;
  const stateStore = new MemoryStateStore({ autoReady: true, autoArmed: true });
  const publisher = new SquarePublisher({ stateStore, adapter: {
    resolveApiKey: () => 'secret',
    uploadImage: async () => 'https://cdn.example/chart.png',
    publish: async () => { publishCalls += 1; throw new Error('upstream timeout containing secret'); },
  } });
  await assert.rejects(() => publisher.publishPackage({ mode: 'AUTO', content, candidate, validation, chartPath: 'chart.png' }), /manual review/);
  assert.equal(stateStore.state.pendingPublish.status, 'UNKNOWN');
  assert.equal(JSON.stringify(stateStore.state).includes('secret'), false);
  const recovery = await new SquarePublisher({ stateStore, adapter: { resolveApiKey: () => 'secret', publish: async () => { publishCalls += 1; } } }).recoverPending();
  assert.equal(recovery.status, 'UNKNOWN');
  assert.equal(publishCalls, 1);
});

test('an upload failure is safely released so it cannot keep AUTO blocked', async () => {
  const stateStore = new MemoryStateStore({ autoReady: true, autoArmed: true });
  const publisher = new SquarePublisher({ stateStore, adapter: {
    resolveApiKey: () => 'secret',
    uploadImage: async () => { throw new Error('image service unavailable'); },
    publish: async () => { throw new Error('must not publish when upload failed'); },
  } });

  await assert.rejects(() => publisher.publishPackage({ mode: 'AUTO', content, candidate, validation, chartPath: 'chart.png' }), /manual review/);
  assert.equal(stateStore.state.pendingPublish.status, 'FAILED_UPLOAD');
  assert.equal(stateStore.state.pendingPublish.stage, 'UPLOAD');

  const recovery = await publisher.recoverPending();
  assert.deepEqual(recovery, { status: 'recovered_failed_upload', intentId: stateStore.snapshots.at(-2).pendingPublish.id });
  assert.equal(stateStore.state.pendingPublish, null);
});

test('only a named legacy pre-publish failure can be manually released', async () => {
  const stateStore = new MemoryStateStore({ pendingPublish: { id: 'legacy-upload-failure', status: 'FAILED', candidateId: 'candidate-1' } });
  const publisher = new SquarePublisher({ stateStore });

  assert.deepEqual(await publisher.resolveFailedUpload({ intentId: 'legacy-upload-failure' }), {
    status: 'resolved_failed_upload', intentId: 'legacy-upload-failure',
  });
  assert.equal(stateStore.state.pendingPublish, null);

  stateStore.state.pendingPublish = { id: 'unknown-publication', status: 'UNKNOWN' };
  await assert.rejects(() => publisher.resolveFailedUpload({ intentId: 'unknown-publication' }), /only an upload failure/i);
  assert.equal(stateStore.state.pendingPublish.status, 'UNKNOWN');
});

test('official success-without-id becomes UNKNOWN, consumes a slot, and blocks duplicate retry', async () => {
  const stateStore = new MemoryStateStore({ autoReady: true, autoArmed: true });
  const publisher = new SquarePublisher({ stateStore, adapter: {
    resolveApiKey: () => 'secret', uploadImage: async () => 'image',
    publish: async () => ({ id: null, shareLink: null, publishStatus: 'success_without_post_id' }),
  } });
  const result = await publisher.publishPackage({ mode: 'AUTO', content, candidate, validation, chartPath: 'chart.png' });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.published, false);
  assert.equal(stateStore.state.posts.length, 1);
  assert.equal(stateStore.state.pendingPublish.status, 'UNKNOWN');
  await assert.rejects(
    () => publisher.publishPackage({ mode: 'AUTO', content, candidate, validation, chartPath: 'chart.png' }),
    /unresolved publish/i,
  );
});

test('event store appends typed JSONL by UTC day and never serializes credential fields', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-events-'));
  const store = new CryptoEventStore({ directory });
  await store.append({ eventId: 'e1', type: 'publish_intent', occurredAt: '2026-08-20T23:59:00.000Z', source: 'test', schemaVersion: 1, payload: { candidateId: 'c1', apiKey: 'must-not-write' } });
  const text = await readFile(path.join(directory, '2026-08-20.jsonl'), 'utf8');
  assert.match(text, /"candidateId":"c1"/);
  assert.doesNotMatch(text, /apiKey|must-not-write/);
});
