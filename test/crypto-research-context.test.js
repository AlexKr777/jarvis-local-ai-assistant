import test from 'node:test';
import assert from 'node:assert/strict';

import { ResearchContextCollector } from '../src/crypto/content/research-context.js';

test('research deduplicates sources and never grants causal language to post-move coverage', async () => {
  const collector = new ResearchContextCollector({ providers: [{
    name: 'fixture',
    search: async () => [
      { url: 'https://example.test/a?utm_source=x', title: 'Alpha announces update', publishedAt: 2_000, evidenceText: 'Alpha announced update.' },
      { url: 'https://example.test/a', title: 'Alpha announces update', publishedAt: 2_000, evidenceText: 'Alpha announced update.' },
    ],
  }] });
  const result = await collector.collect({ identity: { symbol: 'ABCUSDT', baseAsset: 'ABC', projectName: 'Alpha' }, occurredAt: 1_000 });
  assert.equal(result.sources.length, 1);
  assert.equal(result.claims[0].relationToMove, 'background');
  assert.equal(result.claims[0].causalLanguageAllowed, false);
});

test('no research is an allowed empty context', async () => {
  const result = await new ResearchContextCollector({ providers: [] }).collect({ identity: { symbol: 'ABCUSDT', baseAsset: 'ABC' }, occurredAt: 1_000 });
  assert.deepEqual(result, { status: 'none_found', sources: [], claims: [], cleanCatalystFound: false });
});

test('research uses a bounded per-token cache instead of repeatedly calling the same adapter', async () => {
  let calls = 0;
  const collector = new ResearchContextCollector({ now: () => 1_000, providers: [{ name: 'fixture', search: async () => {
    calls += 1;
    return [{ url: 'https://example.test/a', title: 'Alpha', publishedAt: 900 }];
  } }] });
  await collector.collect({ identity: { symbol: 'ABCUSDT', baseAsset: 'ABC', projectName: 'Alpha' }, occurredAt: 800 });
  await collector.collect({ identity: { symbol: 'ABCUSDT', baseAsset: 'ABC', projectName: 'Alpha' }, occurredAt: 800 });
  assert.equal(calls, 1);
});
