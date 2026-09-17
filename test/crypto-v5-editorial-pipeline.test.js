import test from 'node:test';
import assert from 'node:assert/strict';

import { V5EditorialPipeline, buildAnalystBrain, narrativeSignature, parseAnalystBrainOutput, summarizeRecentFeed, validateV5Draft } from '../src/crypto/content/v5-editorial-pipeline.js';

const factPack = Object.freeze({
  identity: { symbol: 'ALPHAUSDT', cashtag: '$ALPHA' },
  ranking: { change24h: '+18.20%' },
  market: { range24h: { position: 0.9 } },
  levels: {
    supports: [{ id: 'level:reaction', midpoint: 8.8, evidence: [{ timeframe: '1h' }] }, { id: 'level:invalidation', midpoint: 8.2, evidence: [{ timeframe: '4h' }] }],
    resistances: [{ id: 'level:watch', midpoint: 10, evidence: [{ timeframe: '1h' }] }],
  },
  traderEvidenceMap: {
    valid: true,
    firstReactionZone: { role: 'first_reaction_zone', levelId: 'level:reaction', midpoint: 8.8, why: 'Immediate retest.' },
    structuralInvalidation: { role: 'structural_invalidation', levelId: 'level:invalidation', midpoint: 8.2, why: 'Loss ends the continuation.' },
    nextWatch: { role: 'next_watch', levelId: 'level:watch', midpoint: 10, why: 'Next boundary.' },
    marketStructure: { '1h': { direction: 'up', phase: 'trend' } },
    marketBehaviour: { volume: { trend: 'contracting' }, momentum: { state: 'steady' }, takerFlow: {} },
    relevantEvents: [], selectedEvidenceIds: [], omittedEvidenceIds: [],
  },
  technicalEvidence: { structure: { '1h': { direction: 'up' } }, volume: { trend: 'contracting' } },
  derivatives: { openInterest: { accepted: false, claim: null }, takerRatio: { accepted: false, claim: null }, funding: { accepted: true, snapshot: true, claim: { key: 'fundingRate', display: '+0.0100%' } } },
  numbersAllowed: [{ key: 'return24h', display: '+18.20%', timeframe: '24h' }],
});

const validPost = `$ALPHA has already made its point with +18.20% in 24 hours, so I am more interested in what happens when price has to defend the move.

8.80 is the first reaction, not the whole thesis. A controlled retest there would tell me buyers are still willing to absorb pressure; 10.00 only becomes relevant after that answer appears.

A break below 8.20 would damage the broader continuation read, not just make the next few candles untidy. Funding is positive right now, while volume still needs to support any fresh defence.`;

const authorialV5Post = `$ALPHA has already made its point with +18.20% in 24 hours. The useful question is not whether the move was large, but whether it can survive its first real test without handing back the ground it earned.

8.80 is the local reaction. A defended retest keeps the higher-high, higher-low read intact, while steady volume makes that response more meaningful than another green candle. That distinction carries more weight than a fresh percentage headline. 10.00 matters only after that condition holds.

8.20 is different: losing it breaks the structural continuation case rather than merely spoiling a local bounce.`;

test('V5 analyst brain preserves level hierarchy and only reads actual prior public theses', () => {
  const brain = buildAnalystBrain(factPack, [{ symbol: 'OTHERUSDT', publishedThesis: { centralThesis: 'not ours' } }]);
  assert.equal(brain.immediateLevel.role, 'local_reaction');
  assert.equal(brain.structuralLevel.role, 'structural_invalidation');
  assert.equal(brain.previousPublicThesis, null);
  assert.ok(brain.evidence.includes('funding_snapshot'));
});

function analystJson(overrides = {}) {
  return JSON.stringify({
    mainThesis: 'Continuation depends on the first reaction holding.',
    stance: 'constructive_with_positioning_caution',
    certainty: 'medium',
    selectedEvidence: ['price_structure', 'volume'],
    counterEvidence: ['funding_snapshot'],
    levelFocus: { immediate: 'local_reaction', structural: 'structural_invalidation', next: 'next_watch' },
    previousThesisRelation: 'none',
    ...overrides,
  });
}

test('V5 Analyst Brain accepts compact JSON that only selects deterministic evidence and roles', () => {
  const brain = buildAnalystBrain(factPack);
  const parsed = parseAnalystBrainOutput(analystJson(), brain);
  assert.equal(parsed.mainThesis, 'Continuation depends on the first reaction holding.');
  assert.deepEqual(parsed.selectedEvidence, ['price_structure', 'volume']);
});

test('V5 Analyst Brain classifies non-JSON, fenced JSON, and wrapped JSON precisely', () => {
  const brain = buildAnalystBrain(factPack);
  for (const raw of [
    'UB is looking constructive. Watch the pullback.',
    `\`\`\`json\n${analystJson()}\n\`\`\``,
    `Here is the state:\n${analystJson()}`,
  ]) {
    assert.throws(() => parseAnalystBrainOutput(raw, brain), (error) => error.code === 'ANALYST_BRAIN_NON_STRUCTURED_OUTPUT');
  }
});

test('V5 Analyst Brain distinguishes malformed JSON, schema, fact reference, and level role failures', () => {
  const brain = buildAnalystBrain(factPack);
  assert.throws(() => parseAnalystBrainOutput('{"mainThesis":', brain), (error) => error.code === 'ANALYST_BRAIN_JSON_INVALID');
  assert.throws(() => parseAnalystBrainOutput(analystJson({ certainty: undefined }), brain), (error) => error.code === 'ANALYST_BRAIN_SCHEMA_INVALID');
  assert.throws(() => parseAnalystBrainOutput(analystJson({ selectedEvidence: ['open_interest'] }), brain), (error) => error.code === 'ANALYST_BRAIN_FACT_REFERENCE_INVALID');
  assert.throws(() => parseAnalystBrainOutput(analystJson({ mainThesis: 'Watch 9.99.' }), brain), (error) => error.code === 'ANALYST_BRAIN_FACT_REFERENCE_INVALID');
  assert.throws(() => parseAnalystBrainOutput(analystJson({ levelFocus: { immediate: 'next_watch', structural: 'structural_invalidation', next: 'local_reaction' } }), brain), (error) => error.code === 'ANALYST_BRAIN_LEVEL_ROLE_INVALID');
});

test('V5 Analyst Brain permits weak/conflicted posture without optional derivatives and respects prior-thesis presence', () => {
  const withoutDerivatives = buildAnalystBrain({ ...factPack, derivatives: { openInterest: { accepted: false }, takerRatio: { accepted: false }, funding: { accepted: false } } });
  const weak = parseAnalystBrainOutput(analystJson({ stance: 'cautious', certainty: 'measured', selectedEvidence: ['price_structure'], counterEvidence: [] }), withoutDerivatives);
  assert.equal(weak.stance, 'cautious');
  const withPrior = buildAnalystBrain(factPack, [{ symbol: 'ALPHAUSDT', publishedThesis: { centralThesis: 'Earlier thesis' } }]);
  assert.throws(() => parseAnalystBrainOutput(analystJson(), withPrior), (error) => error.code === 'ANALYST_BRAIN_SCHEMA_INVALID');
  assert.equal(parseAnalystBrainOutput(analystJson({ previousThesisRelation: 'refines' }), withPrior).previousThesisRelation, 'refines');
});

test('V5 stops before public Writer stages with the precise Analyst Brain contract reason', async () => {
  const calls = [];
  const pipeline = new V5EditorialPipeline({ invoke: async ({ stage }) => {
    calls.push(stage);
    return 'This is public prose, not a private artifact.';
  } });
  const result = await pipeline.generate({ factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'ANALYST_BRAIN_NON_STRUCTURED_OUTPUT');
  assert.deepEqual(calls, ['analyst_brain']);
  assert.equal(result.audit.analystBrainResponse.parse.ok, false);
});

test('V5 rejects invalid derivatives and invented funding history while allowing a funding snapshot', () => {
  const brain = buildAnalystBrain(factPack);
  const baseline = validateV5Draft(validPost, { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.deepEqual(baseline.errors, ['length']);
  assert.ok(validateV5Draft(validPost.replace('Funding is positive right now', 'Funding keeps rising'), { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain }).errors.includes('funding_snapshot_as_trend'));
  assert.ok(validateV5Draft(validPost.replace('Funding is positive right now', 'OI is expanding'), { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain }).errors.includes('derivative_evidence_not_valid'));
});

test('V5 accepts authorial analytical judgment without a first-person lexical marker', () => {
  const brain = buildAnalystBrain(factPack);
  const result = validateV5Draft(authorialV5Post, { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.equal(result.ok, true, result.errors.join(', '));
  assert.ok(!/\bI\b/i.test(authorialV5Post));
});

test('V5 rejects a factual data dump that has no analytical judgment', () => {
  const brain = buildAnalystBrain(factPack);
  const dump = '$ALPHA is up +18.20% in 24 hours. The levels are 8.80, 8.20, and 10.00. Volume is contracting. Funding is positive right now.';
  const result = validateV5Draft(dump, { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.ok(result.errors.includes('missing_authorial_judgment'));
});

test('V5 treats cosmetic trailing zeros as the same approved level but rejects a nearby invented price', () => {
  const brain = buildAnalystBrain(factPack);
  const equivalent = validateV5Draft(authorialV5Post.replaceAll('8.80', '8.800'), { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.ok(!equivalent.errors.includes('unsupported_price'), equivalent.errors.join(', '));
  const invented = validateV5Draft(authorialV5Post.replace('8.80 is', '8.81 is'), { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.ok(invented.errors.includes('unsupported_price'));
  const terminal = validateV5Draft(authorialV5Post.replace('10.00 matters only after that condition holds.', '10.00.'), { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.ok(terminal.priceDiagnostics.some((item) => item.text === '10.00' && item.accepted));
});

test('V5 rejects a repair that leaves a numeric sentence fragment behind', () => {
  const brain = buildAnalystBrain(factPack);
  const result = validateV5Draft(authorialV5Post.replace('has already made its point with +18.20% in 24 hours', 'has put in a strong day, gaining over the past 24 hours'), { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.ok(result.errors.includes('malformed_sentence'));
});

test('V5 requires selected evidence but does not require every level to be mentioned', () => {
  const brain = { ...buildAnalystBrain(factPack), evidence: ['price_structure'], strongestEvidence: ['price_structure'] };
  const oneLevel = '$ALPHA has moved +18.20% in 24 hours, but the meaningful judgment is whether 8.80 can hold a retest. That local reaction is where the higher-high, higher-low structure either earns attention or loses it.';
  const result = validateV5Draft(oneLevel, { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.ok(!result.errors.includes('selected_evidence_not_used'), result.errors.join(', '));
  assert.ok(!result.errors.includes('level_role_mismatch'), result.errors.join(', '));
  const ignored = validateV5Draft(oneLevel.replace('whether 8.80 can hold a retest. That local reaction is where the higher-high, higher-low structure either earns attention or loses it.', 'whether 8.80 can hold. The recent move has a nearby reference.'), { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.ok(ignored.errors.includes('selected_evidence_not_used'));
});

test('V5 length uses words rather than provider tokens and retains the existing 90-240 Writer boundary', () => {
  const brain = buildAnalystBrain(factPack);
  const short = Array.from({ length: 89 }, () => 'word').join(' ');
  const long = Array.from({ length: 241 }, () => 'word').join(' ');
  const shortResult = validateV5Draft(short, { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  const longResult = validateV5Draft(long, { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.equal(shortResult.wordCount, 89);
  assert.equal(longResult.wordCount, 241);
  assert.equal(shortResult.length.acceptedRange[0], 90);
  assert.equal(longResult.length.acceptedRange[1], 240);
  assert.ok(shortResult.errors.includes('length'));
  assert.ok(longResult.errors.includes('length'));
});

test('V5 preserves level roles and allows unselected OI to remain absent', () => {
  const brain = buildAnalystBrain({ ...factPack, derivatives: { ...factPack.derivatives, openInterest: { accepted: true } } });
  const safe = validateV5Draft(authorialV5Post, { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.ok(!safe.errors.includes('derivative_evidence_not_valid'));
  for (const text of [
    authorialV5Post.replace('8.80 is the local reaction', 'A break below 8.80 ends the idea'),
    authorialV5Post.replace('8.20 is different: losing it breaks', '8.20 is the local reaction and it holds'),
    authorialV5Post.replace('10.00 matters only after that condition holds', '10.00 is the target'),
  ]) {
    assert.ok(validateV5Draft(text, { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain }).errors.includes('level_role_mismatch'));
  }
  const localNotStructural = validateV5Draft(authorialV5Post.replace('8.80 is the local reaction. A defended retest', '8.80 is the local reaction. Slipping through it would not break the thesis on its own. A defended retest'), { factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, brain });
  assert.ok(!localNotStructural.errors.includes('level_role_mismatch'), localNotStructural.errors.join(', '));
});

test('V5 records feed-level signatures without using them as a mechanical rotation table', () => {
  const history = [{ text: '$AAA moved.\n\nI am watching 1.00.', narrativeSignature: { openingMode: 'ticker_number' } }];
  const summary = summarizeRecentFeed(history);
  const signature = narrativeSignature(validPost, buildAnalystBrain(factPack, history));
  assert.equal(summary.sampleSize, 1);
  assert.equal(signature.ctaPresent, false);
  assert.notEqual(signature.paragraphGeometry.length, 0);
});

test('V5 keeps factual validity ahead of feed diversity and critic repair remains surgical', async () => {
  const calls = [];
  const pipeline = new V5EditorialPipeline({ invoke: async ({ stage }) => {
    calls.push(stage);
    if (stage === 'analyst_brain') return analystJson();
    if (stage === 'writer_reflection') return validPost;
    if (stage === 'writer_tension') return validPost.replace('has already made its point', 'is worth reading beyond the headline');
    if (stage === 'critic') return 'PASS';
    throw new Error(`Unexpected stage ${stage}`);
  } });
  const result = await pipeline.generate({ factPack, candidate: { cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed, metrics: {} }, editorialHistory: [{ text: validPost, fingerprint: { storyFamily: 'constructive_with_positioning_caution' } }] });
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, ['analyst_brain', 'writer_reflection', 'writer_tension', 'critic']);
  assert.ok([validPost, validPost.replace('has already made its point', 'is worth reading beyond the headline')].includes(result.content.postText));
  assert.equal(result.narrativeSignature.ctaPresent, false);
});
