import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStoryBrief } from '../src/crypto/content/story-brief.js';

test('Story Brief keeps first reaction, structural invalidation, and next watch as separate evidence roles', () => {
  const factPack = {
    ranking: { change24h: '+22.00%' },
    market: { currentPrice: 1.25, range24h: { position: 0.83, drawdownFromHighPct: -4 } },
    traderEvidenceMap: {
      valid: true,
      heroEvent: { id: 'event:daily_runner', kind: 'daily_runner' },
      firstReactionZone: { role: 'first_reaction_zone', levelId: 'reaction', midpoint: 1.2, why: 'Nearest support is the immediate retest.' },
      structuralInvalidation: { role: 'structural_invalidation', levelId: 'invalidation', midpoint: 1.1, why: 'The lower support removes the structure.' },
      nextWatch: { role: 'next_watch', levelId: 'watch', midpoint: 1.5, why: 'The 24h high is the next boundary.' },
      relevantEvents: [{ id: 'event:daily_runner', kind: 'daily_runner' }],
      marketStructure: { '1h': { direction: 'up' } },
    },
  };

  const brief = buildStoryBrief(factPack);

  assert.equal(brief.valid, true);
  assert.equal(brief.firstReactionZone.levelId, 'reaction');
  assert.equal(brief.structuralInvalidation.levelId, 'invalidation');
  assert.equal(brief.nextWatch.levelId, 'watch');
  assert.match(brief.technicalThesis, /1\.20/);
  assert.match(brief.expectedNextMove, /1\.20|1\.50/);
  assert.ok(brief.selectedEvidenceIds.includes('invalidation'));
});

test('Story Brief carries deterministic technical reasoning for the writer without collapsing level roles', () => {
  const brief = buildStoryBrief({
    market: { range24h: { position: 0.8 } },
    traderEvidenceMap: {
      valid: true,
      firstReactionZone: { role: 'first_reaction_zone', levelId: 'reaction', side: 'support', midpoint: 1.2, why: 'Nearest support is the immediate retest.' },
      structuralInvalidation: { role: 'structural_invalidation', levelId: 'invalidation', side: 'support', midpoint: 1.1, why: 'The lower support removes the structure.' },
      nextWatch: { role: 'next_watch', levelId: 'watch', side: 'resistance', midpoint: 1.5, why: 'The upper boundary is the next test.' },
      marketStructure: { '1h': { timeframe: '1h', direction: 'up', phase: 'impulse' } },
      marketBehaviour: { momentum: { state: 'accelerating' }, volume: { trend: 'expanding' }, takerFlow: { bias: 'buy_dominant' } },
    },
  });

  assert.match(brief.technicalReasoning.observedStructure, /higher-high/i);
  assert.match(brief.technicalReasoning.firstReactionMeaning, /absorb/i);
  assert.match(brief.technicalReasoning.invalidationMeaning, /not the first reaction/i);
  assert.equal(brief.technicalReasoning.volumeState, 'expanding');
});
