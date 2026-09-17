import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BinancePublicClient } from '../src/crypto/market/binance-public-client.js';
import { BinanceRestGovernor } from '../src/crypto/market/binance-rest-governor.js';

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  };
}

async function fixture({ now = 1_000_000, replies = [] } = {}) {
  let clock = now;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-binance-governor-'));
  const calls = [];
  const governor = new BinanceRestGovernor({
    filePath: path.join(directory, 'binance-rest-state.json'),
    clock: () => clock,
    maxConcurrency: 1,
    minIntervalMs: 0,
    queueLimit: 8,
  });
  const client = new BinancePublicClient({
    governor,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return replies.shift() || response([]);
    },
  });
  return { governor, client, calls, advance: (ms) => { clock += ms; }, directory };
}

test('RED: a 429 from scanner blocks replay, deep analysis, and live dry run globally before transport', async () => {
  const { client, calls, governor } = await fixture({ replies: [response({ code: -1003, msg: 'slow down' }, 429, { 'Retry-After': '60', 'x-mbx-used-weight-1m': '91' })] });
  await assert.rejects(() => client.withCaller('scanner').get24hTickers(), { code: 'BINANCE_RATE_LIMITED' });
  await assert.rejects(() => client.withCaller('historical_replay').getKlines('BTCUSDT'), { code: 'BINANCE_REST_BLOCKED' });
  await assert.rejects(() => client.withCaller('deep_analysis').getPremiumIndex('BTCUSDT'), { code: 'BINANCE_REST_BLOCKED' });
  await assert.rejects(() => client.withCaller('live_dry_run').getExchangeInfo(), { code: 'BINANCE_REST_BLOCKED' });
  assert.equal(calls.length, 1);
  assert.equal((await governor.diagnostics()).state, 'COOLDOWN');
});

test('RED: a 418 persists the safest banned-until deadline and restart blocks bootstrap without transport', async () => {
  const banUntil = 1_180_000_000_000;
  const first = await fixture({ replies: [response({ code: -1003, msg: `Way too much request weight used; IP banned until ${banUntil}.` }, 418, { 'Retry-After': '60', 'x-mbx-used-weight-1m': '2' })] });
  await assert.rejects(() => first.client.withCaller('scanner').getExchangeInfo(), { code: 'BINANCE_IP_BANNED' });
  assert.equal((await first.governor.diagnostics()).blockedUntil, banUntil);

  const secondGovernor = new BinanceRestGovernor({ filePath: path.join(first.directory, 'binance-rest-state.json'), clock: () => 1_000_001, minIntervalMs: 0 });
  let restartedTransportCalls = 0;
  const secondClient = new BinancePublicClient({ governor: secondGovernor, fetchImpl: async () => { restartedTransportCalls += 1; return response([]); } });
  await assert.rejects(() => secondClient.withCaller('scanner_bootstrap').getExchangeInfo(), { code: 'BINANCE_REST_BLOCKED' });
  assert.equal(restartedTransportCalls, 0);
  assert.equal((await secondGovernor.diagnostics()).state, 'BANNED');
});

test('RED: recovery permits one cautious request, a successful response returns governor to normal', async () => {
  const { client, calls, governor, advance } = await fixture({ replies: [
    response({ code: -1003, msg: 'temporarily banned' }, 418, { 'Retry-After': '1' }),
    response([]),
  ] });
  await assert.rejects(() => client.get24hTickers(), { code: 'BINANCE_IP_BANNED' });
  advance(1_001);
  await client.get24hTickers();
  assert.equal(calls.length, 2);
  assert.equal((await governor.diagnostics()).state, 'NORMAL');
});

test('used REST weight reaches the safety ceiling before a 429 and blocks later transport', async () => {
  const { client, calls, governor } = await fixture({ replies: [
    response([], 200, { 'x-mbx-used-weight-1m': '2100' }),
  ] });

  await client.withCaller('scanner').get24hTickers();
  await assert.rejects(() => client.withCaller('live_dry_run').getExchangeInfo(), { code: 'BINANCE_REST_BLOCKED' });

  assert.equal(calls.length, 1);
  const status = await governor.diagnostics();
  assert.equal(status.state, 'COOLDOWN');
  assert.equal(status.usedWeight1m, 2100);
});

test('recovery 429 establishes a new global cooldown without a retry stampede', async () => {
  const { client, calls, governor, advance } = await fixture({ replies: [
    response({ code: -1003, msg: 'banned' }, 418, { 'Retry-After': '1' }),
    response({ code: -1003, msg: 'slow down' }, 429, { 'Retry-After': '45' }),
  ] });
  await assert.rejects(() => client.get24hTickers(), { code: 'BINANCE_IP_BANNED' });
  advance(1_001);
  await assert.rejects(() => client.get24hTickers(), { code: 'BINANCE_RATE_LIMITED' });
  await assert.rejects(() => client.withCaller('historical_replay').getKlines('BTCUSDT'), { code: 'BINANCE_REST_BLOCKED' });
  assert.equal(calls.length, 2);
  assert.equal((await governor.diagnostics()).state, 'COOLDOWN');
});

test('bounded governor queue rejects a 6,011-request burst before it can become transport traffic', async () => {
  const { client, calls, governor } = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 6_011 }, () => client.withCaller('deep_analysis').getPremiumIndex('DOGEUSDT')));
  assert.ok(calls.length <= 9);
  assert.ok(results.filter((result) => result.status === 'rejected').length >= 6_000);
  assert.ok((await governor.diagnostics()).droppedOrCoalesced >= 6_000);
});

test('RED: queued REST enrichment is dropped when it becomes stale behind another request', async () => {
  const { governor, advance } = await fixture();
  let release;
  const active = governor.execute({ caller: 'deep_analysis', endpoint: '/fapi/v1/klines' }, () => new Promise((resolve) => { release = resolve; }));
  for (let turn = 0; turn < 10 && !release; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  let staleTransportRan = false;
  const stale = governor.execute({ caller: 'deep_analysis', endpoint: '/fapi/v1/premiumIndex' }, () => { staleTransportRan = true; return []; });
  await new Promise((resolve) => setImmediate(resolve));
  advance(30_001);
  release([]);
  await active;
  await assert.rejects(() => stale, { code: 'BINANCE_REST_STALE' });
  assert.equal(staleTransportRan, false);
});
