import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeReviewPackage } from '../src/crypto/content/review-package.js';

test('review package preserves the full v4 editorial decision without credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-review-'));
  const result = await writeReviewPackage({
    directory,
    candidate: { id: 'abc-1', symbol: 'ABCUSDT', cashtag: '$ABC' },
    factPack: { identity: { cashtag: '$ABC' }, research: { sources: [] } },
    editorial: { audit: { planner: { thesis: 'test' }, storyBrief: { valid: true }, writerCandidates: [{ id: 'one', text: 'draft' }], selected: { validation: { formatting: { paragraphCount: 3, usedInvisibleSeparator: false } } }, critic: { verdict: 'PASS' }, writerFailure: { code: 'ANYMODEL_TIMEOUT' } } },
    validation: { ok: true }, chart: { path: 'chart.png', sha256: 'hash' }, publication: { status: 'preview', published: false },
  });
  const stored = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(stored.candidate.symbol, 'ABCUSDT');
  assert.equal(stored.editorial.critic.verdict, 'PASS');
  assert.equal(stored.schemaVersion, 3);
  assert.equal(stored.formatting.paragraphCount, 3);
  assert.equal(stored.writerFailure.code, 'ANYMODEL_TIMEOUT');
  assert.equal(stored.publication.status, 'preview');
  assert.equal(JSON.stringify(stored).includes('Authorization'), false);
});

test('a skipped package still records its deterministic Story Brief', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-review-'));
  const factPack = {
    identity: { cashtag: '$ABC' },
    ranking: { change24h: '+12.00%' },
    technicalEvidence: { structure: {} },
    traderEvidenceMap: {
      valid: true,
      heroEvent: { id: 'event:daily_runner', kind: 'daily_runner' },
      firstReactionZone: { levelId: 'reaction', midpoint: 8.8 },
      structuralInvalidation: { levelId: 'invalidation', midpoint: 8.2 },
      nextWatch: { levelId: 'watch', midpoint: 10 },
      relevantEvents: [], marketStructure: {}, selectedEvidenceIds: [], omittedEvidenceIds: [],
    },
  };
  const result = await writeReviewPackage({
    directory,
    candidate: { id: 'skip-1', symbol: 'ABCUSDT', cashtag: '$ABC' },
    factPack,
    editorial: { audit: { writerCandidates: [] } },
    validation: { ok: false, errors: ['FEED_REPETITION'] },
    chart: null,
    publication: { status: 'content_skipped', published: false },
  });
  const stored = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(stored.storyBrief.valid, true);
  assert.equal(stored.storyBrief.firstReactionZone.levelId, 'reaction');
});
