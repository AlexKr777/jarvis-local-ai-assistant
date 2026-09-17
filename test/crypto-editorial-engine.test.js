import test from 'node:test';
import assert from 'node:assert/strict';
import * as editorialEngine from '../src/crypto/content/editorial-engine.js';

import {
  buildEditorialFingerprint,
  classifyMarketStory,
  evaluateDiversity,
  evaluateEditorialPreGate,
  evaluateCriticGate,
  evaluateAngleBoard,
  selectBestDraft,
  selectStoryChartIntent,
  validateStoryChart,
} from '../src/crypto/content/editorial-engine.js';
import { CryptoCodexBridge } from '../src/crypto/content/codex-bridge.js';
import { mandatoryResearchDecision } from '../src/crypto/content/research-policy.js';
import { OfficialContextResearch } from '../src/crypto/content/official-context-research.js';

function candidate(overrides = {}) {
  return {
    symbol: 'BTCUSDT', cashtag: '$BTC', occurredAt: 1_724_155_200_000,
    marketRelationship: 'price_down_oi_up',
    metrics: { return15mPct: -0.4, return1hPct: 3.2, return2hPct: 5.1, return4hPct: 6.2, return24hPct: 7.1, candles: [{ closeTime: 1_724_155_200_000 }] },
    openInterestChangePct: 8, takerBuySellRatio: 0.9,
    claimsAllowed: [
      { key: 'return24h', display: '+7.10%', timeframe: '24h' },
      { key: 'return15m', display: '-0.40%', timeframe: '15m' },
      { key: 'openInterestChange', display: '+8.00%', timeframe: '4h' },
      { key: 'volumeRatio', display: '6.0x', timeframe: '5m' },
    ],
    ...overrides,
  };
}

function criticResponse(decision, overrides = {}) {
  const base = {
    decision,
    scores: { scrollStop: 8, humanVoice: 8, eventSpecificity: 8, evidenceEconomy: 8, pointOfView: 8, cashtagCuriosity: 8, noAiSlop: 8, payoff: 8, feedNovelty: 8, readerReward: 8, insightNovelty: 8 },
    risks: { analystTone: false, nonConclusionAnalystPattern: false, templateSimilarity: false, feedRepetition: false, bothSidesWithoutView: false, metricDump: false, weakHook: false, weakPayoff: false, genericEnding: false, forcedAb: false, eventInterchangeability: false, underdevelopedStory: false },
    failures: [],
    rewriteInstructions: [],
  };
  return { ...base, ...overrides, scores: { ...base.scores, ...(overrides.scores || {}) }, risks: { ...base.risks, ...(overrides.risks || {}) } };
}

function angleBoard(storyFamily = 'major_runner') {
  return { angles: [
    { angleId: 'dilemma', storyFamily, humanPremise: 'The obvious reaction is that the move is late, but the scale deserves a second look.', whyReaderStops: 'It challenges the late-arrival assumption.', readerInitialAssumption: 'too late', surprisingThing: 'the daily move is already unusually large', tension: 'the scale complicates a casual dismissal', reveal: 'the hero move alone changes the first read', readerPayoff: 'start with the scale before inventing a second theory', reasonToOpenCashtag: 'inspect the full move', humanObservation: 'The obvious reaction is that the move is late, but the scale deserves a second look.', surprise: 'large move', readerAssumption: 'too late', payoff: 'focus on the scale', heroFact: 'hero', supportingEvidence: [], supportingFacts: [], readerExperienceFamily: 'HUMAN_DILEMMA', openingFamily: 'human_dilemma', openingMechanic: 'human dilemma', endingJob: 'challenge the obvious read', whyWorthReading: 'different market read', feedDifference: 'human dilemma', confidence: 'calibrated' },
    { angleId: 'timeline', storyFamily: 'runner_pullback', humanPremise: 'The first spike was only the start of the event.', whyReaderStops: 'It turns a completed move into a follow-through question.', readerInitialAssumption: 'one-off spike', surprisingThing: 'the daily move is still the event worth examining', tension: 'a single number can hide the larger sequence', reveal: 'the hero move is larger than the first impression', readerPayoff: 'separate the first rush from the whole event', reasonToOpenCashtag: 'inspect the full session', humanObservation: 'The first spike was only the start of the event.', surprise: 'follow-through', readerAssumption: 'one-off spike', payoff: 'watch the full session', heroFact: 'hero', supportingEvidence: [], supportingFacts: [], readerExperienceFamily: 'FOLLOW_THROUGH', openingFamily: 'timeline', openingMechanic: 'timeline', endingJob: 'watchpoint', whyWorthReading: 'different narrative entry', feedDifference: 'timeline', confidence: 'calibrated' },
  ] };
}

function writerCandidates({ cashtag = '$ENA', claim = { key: 'return24h', display: '+7.10%' }, visualIntent = { preset: 'receipt', revealOnOpen: false, relationship: 'none' } } = {}) {
  return { decision: 'publish', reason: '', candidates: [
    { candidateId: 'first', angleId: 'dilemma', storyFamily: 'major_runner', postText: `${cashtag} is up ${claim.display} over 24 hours.\n\nThe easy reaction is that the move is already late, but the follow-through changes that first read.\n\nThat makes the obvious dismissal incomplete.`, wordCount: 27, heroFact: claim.display, claimsUsed: [claim], visualIntent },
    { candidateId: 'second', angleId: 'timeline', storyFamily: 'runner_pullback', postText: `A ${claim.display} day can look finished before anyone opens ${cashtag}.\n\nThe obvious read is that the event is over, but the sequence makes that assumption incomplete. That is why the full move deserves a closer look.`, wordCount: 34, heroFact: claim.display, claimsUsed: [claim], visualIntent },
  ] };
}

function candidateSelection() {
  const scores = { surprise: 8, scrollStop: 8, readThrough: 8, humanVoice: 8, eventSpecificity: 8, pointOfView: 8, payoff: 8, cashtagCuriosity: 8, compression: 8, feedNovelty: 8, noAiSlop: 8, readerReward: 8, insightNovelty: 8 };
  return { winner: 'first', whyWinner: 'stronger payoff', loserWeakness: 'less developed ending', candidates: [{ candidateId: 'first', scores, readerReward: 'The ending changes the obvious read.', insightNovelty: 'The evidence reframes the move.', underdevelopedStory: false, strongestLine: 'The follow-through is the part worth opening.', weakestLine: '', reason: 'stronger payoff' }, { candidateId: 'second', scores: { ...scores, surprise: 7 }, readerReward: 'A useful alternate lens.', insightNovelty: 'The sequence matters.', underdevelopedStory: false, strongestLine: 'The first move was not the whole story.', weakestLine: '', reason: 'good alternate' }] };
}

test('V2.1.4 story spines preserve a human thought and selected evidence before public drafting', () => {
  const claims = [
    { key: 'return24h', display: '+46.88%', timeframe: '24h' },
    { key: 'return4h', display: '+6.61%', timeframe: '4h' },
    { key: 'openInterestChange', display: '+12.47%', timeframe: '4h' },
  ];
  const spines = editorialEngine.buildStorySpines?.({
    angles: angleBoard().angles,
    selectedClaims: claims,
  });

  assert.ok(Array.isArray(spines), 'V2.1.4 must build story spines before Writer');
  assert.equal(spines.length, 2);
  assert.deepEqual(Object.keys(spines[0]).sort(), [
    'angleId', 'endingJob', 'evidenceNeeded', 'evidenceToOmit', 'humanThesis',
    'payoff', 'readerExperience', 'readerLikelyAssumption', 'tension', 'turn',
    'whyThisIsInteresting',
  ].sort());
  assert.equal(editorialEngine.evaluateStorySpines?.(spines, { allowedEvidence: claims }).pass, true);

  const metricOnly = [{
    ...spines[0],
    humanThesis: 'Price rose while open interest rose faster.',
    tension: 'One metric is larger than another metric.',
    turn: 'Open interest increased faster than price.',
    payoff: 'The metrics are aligned.',
  }, spines[1]];
  assert.deepEqual(editorialEngine.evaluateStorySpines?.(metricOnly, { allowedEvidence: claims }), {
    pass: false,
    reason: 'METRIC_CENTRIC_STORY_SPINE',
    angleId: metricOnly[0].angleId,
  });
});

test('V2.1.4 candidate diversity rejects paraphrases and accepts different story strategies', () => {
  const spines = [
    { angleId: 'dilemma', humanThesis: 'The obvious late-arrival read misses that the move kept developing.', readerLikelyAssumption: 'too late', tension: 'a stretched chart still attracted open positioning', turn: 'the later window remained positive', payoff: 'the first glance is incomplete', whyThisIsInteresting: 'the move looked finished before it was', evidenceNeeded: ['return24h', 'return4h'], evidenceToOmit: [], endingJob: 'change the late-arrival read', readerExperience: 'human_dilemma' },
    { angleId: 'mystery', humanThesis: 'An extraordinary move had no clean official explanation at the timestamp.', readerLikelyAssumption: 'a visible headline caused it', tension: 'large move without a verified public driver', turn: 'timestamp-safe research found no clean catalyst', payoff: 'separate an unexplained move from an invented cause', whyThisIsInteresting: 'the missing explanation is itself unusual', evidenceNeeded: ['return24h'], evidenceToOmit: ['openInterestChange'], endingJob: 'preserve the honest mystery', readerExperience: 'mystery' },
  ];
  const paraphrases = [
    { candidateId: 'a', angleId: 'dilemma', postText: '$ENA is up almost 47% in a day.\n\nThe move looks late, but it was still developing.\n\nThat makes the first read incomplete.', claimsUsed: [{ key: 'return24h', display: '+46.88%' }] },
    { candidateId: 'b', angleId: 'mystery', postText: '$ENA gained almost 47% in a day.\n\nThe rally looks late, but it kept developing.\n\nThat makes the obvious read incomplete.', claimsUsed: [{ key: 'return24h', display: '+46.88%' }] },
  ];
  assert.deepEqual(editorialEngine.evaluateCandidateDiversity?.(paraphrases, { storySpines: spines }), {
    pass: false,
    reason: 'CANDIDATE_DIVERSITY_FAIL',
  });

  const distinct = [
    paraphrases[0],
    { candidateId: 'b', angleId: 'mystery', postText: 'A near-47% day usually comes with an obvious headline. $ENA did not have one in the timestamp-safe search.\n\nThe honest takeaway is not a guessed cause. It is that the chart became extraordinary before a clean public explanation appeared.', claimsUsed: [{ key: 'return24h', display: '+46.88%' }] },
  ];
  assert.equal(editorialEngine.evaluateCandidateDiversity?.(distinct, { storySpines: spines }).pass, true);
});

test('V2.1.4 bridge gives structured story spines to Writer and preserves them in trace', async () => {
  const calls = [];
  const plan = { publishWorthiness: 'strong', heroFact: '+7.10% over 24h', heroFactType: 'return24h', whyHumanCares: 'runner', readerLikelyAssumption: 'late', hiddenAngle: 'follow-through', centralQuestion: 'continue?', storyFamily: 'major_runner', hookFamily: 'hero_number', format: 'short', pointOfView: 'observant', confidence: 'calibrated', primaryEvidence: ['return24h'], secondaryEvidence: [], omitFromPublicPost: [], researchNeeded: false, researchQuestion: '', abConflict: { use: false, a: '', b: '', discriminator: '' }, reasonToOpenCashtag: 'inspect', skipReason: '' };
  const responses = [plan, angleBoard(), writerCandidates({ cashtag: '$BTC' }), candidateSelection(), criticResponse('PASS')];
  const bridge = new CryptoCodexBridge({
    jarvis: { runAutomationTurn: async (request) => { calls.push(request); return JSON.stringify(responses.shift()); } },
    playbookLoader: async () => 'test playbook',
  });

  const result = await bridge.generateEditorial({ threadId: 'thread', candidate: candidate(), editorialHistory: [] });

  assert.ok(calls[2].additionalContext['crypto.editorial-brief']);
  assert.match(calls[2].additionalContext['crypto.editorial-brief'].value, /"storySpines"/);
  assert.match(calls[2].additionalContext['crypto.editorial-brief'].value, /45–85 words/);
  assert.match(calls[2].additionalContext['crypto.editorial-brief'].value, /why it is weird/i);
  assert.match(calls[2].additionalContext['crypto.editorial-brief'].value, /social-feed post/i);
  assert.equal(result.storySpines.length, 2);
  assert.equal(result.storySpineValidation.pass, true);
  assert.equal(result.candidateDiversity.pass, true);
});

test('V2.1.4 preserves both bounded Writer attempts when candidate diversity still fails', async () => {
  const plan = { publishWorthiness: 'strong', heroFact: '+7.10% over 24h', heroFactType: 'return24h', whyHumanCares: 'runner', readerLikelyAssumption: 'late', hiddenAngle: 'follow-through', centralQuestion: 'continue?', storyFamily: 'major_runner', hookFamily: 'hero_number', format: 'short', pointOfView: 'observant', confidence: 'calibrated', primaryEvidence: ['return24h'], secondaryEvidence: [], omitFromPublicPost: [], researchNeeded: false, researchQuestion: '', abConflict: { use: false, a: '', b: '', discriminator: '' }, reasonToOpenCashtag: 'inspect', skipReason: '' };
  const paraphrases = (prefix) => ({ decision: 'publish', reason: '', candidates: [
    { candidateId: `${prefix}-a`, angleId: 'dilemma', storyFamily: 'major_runner', postText: '$BTC is up +7.10% over 24 hours.\n\nThe move looks late, but it kept developing.\n\nThat makes the first read incomplete.', wordCount: 23, heroFact: '+7.10%', claimsUsed: [{ key: 'return24h', display: '+7.10%' }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } },
    { candidateId: `${prefix}-b`, angleId: 'timeline', storyFamily: 'runner_pullback', postText: '$BTC gained +7.10% over 24 hours.\n\nThe rally looks late, but it kept developing.\n\nThat makes the obvious read incomplete.', wordCount: 23, heroFact: '+7.10%', claimsUsed: [{ key: 'return24h', display: '+7.10%' }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } },
  ] });
  const responses = [plan, angleBoard(), paraphrases('initial'), paraphrases('repair')];
  const bridge = new CryptoCodexBridge({ jarvis: { runAutomationTurn: async () => JSON.stringify(responses.shift()) }, playbookLoader: async () => 'test playbook' });

  const result = await bridge.generateEditorial({ threadId: 'thread', candidate: candidate() });
  assert.equal(result.reason, 'CANDIDATE_DIVERSITY_FAIL');
  assert.equal(result.diversityRepairCount, 1);
  assert.equal(result.writerAttempts.length, 2);
  assert.equal(result.writerAttempts[0].candidates[0].candidateId, 'initial-a');
  assert.equal(result.writerAttempts[1].candidates[0].candidateId, 'repair-a');
});

test('market-story clustering groups correlated same-shape siblings but preserves a distinct story', () => {
  const btc = candidate();
  const eth = candidate({ symbol: 'ETHUSDT', cashtag: '$ETH', metrics: { ...candidate().metrics, return1hPct: 3.7 } });
  const ena = candidate({ symbol: 'ENAUSDT', cashtag: '$ENA', metrics: { ...candidate().metrics, return15mPct: 2.0, return1hPct: 0.7, return24hPct: 46.8 }, marketRelationship: 'price_up_oi_up' });
  assert.equal(classifyMarketStory(btc), classifyMarketStory(eth));
  assert.notEqual(classifyMarketStory(btc), classifyMarketStory(ena));
});

test('diversity gate catches near-duplicate public copy but accepts a different story', () => {
  const first = '$BTC kept its broader advance while short-term momentum turned softer. Open interest rose while price pulled back.';
  const duplicate = '$ETH kept its broader advance while short-term momentum turned softer. Open interest rose while price pulled back.';
  const different = '$ENA is up +46.88% over 24 hours. The question is whether open interest still building changes the read.';
  const firstFingerprint = buildEditorialFingerprint({ text: first, plan: { storyFamily: 'runner_pullback', hookFamily: 'contradiction', format: 'short' }, chartPreset: 'price_oi_divergence', marketStoryCluster: 'cluster-a' });
  assert.equal(evaluateDiversity({ text: duplicate, fingerprint: firstFingerprint, recent: [{ text: first, fingerprint: firstFingerprint }] }).pass, false);
  assert.equal(evaluateDiversity({ text: different, fingerprint: buildEditorialFingerprint({ text: different, plan: { storyFamily: 'major_runner', hookFamily: 'hero_number', format: 'short' }, chartPreset: 'receipt', marketStoryCluster: 'cluster-b' }), recent: [{ text: first, fingerprint: firstFingerprint }] }).pass, true);
});

test('diversity gate rejects a repeated narrative skeleton even when the words and token differ', () => {
  const earlier = '$SOL is up 18% today.\n\nThe obvious read is fresh buying.\n\nExcept open interest fell 11% into the move.\n\nSame green candle. Different story.';
  const later = '$AVAX is up 14% today.\n\nThe obvious read is fresh demand.\n\nExcept open interest dropped 9% during the rally.\n\nSame price action. Different explanation.';
  const earlierFingerprint = buildEditorialFingerprint({ text: earlier, plan: { storyFamily: 'position_build', hookFamily: 'hero_number', format: 'short' }, chartPreset: 'price_oi_divergence', marketStoryCluster: 'sol-story' });
  const laterFingerprint = buildEditorialFingerprint({ text: later, plan: { storyFamily: 'position_build', hookFamily: 'hero_number', format: 'short' }, chartPreset: 'price_oi_divergence', marketStoryCluster: 'avax-story' });
  const result = evaluateDiversity({ text: later, fingerprint: laterFingerprint, recent: [{ text: earlier, fingerprint: earlierFingerprint }] });
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'FEED_REPETITION');
});

test('angle board rejects synonym-only angles but keeps materially different reader experiences', () => {
  const synonymOnly = [
    { angleId: 'a', storyFamily: 'major_runner', humanObservation: 'ENA rose 47% while OI climbed.', openingMechanic: 'big number', endingJob: 'positioning note', supportingFacts: ['return24h', 'openInterestChange'] },
    { angleId: 'b', storyFamily: 'major_runner', humanObservation: 'ENA gained almost 47% with rising OI.', openingMechanic: 'big number', endingJob: 'positioning note', supportingFacts: ['return24h', 'openInterestChange'] },
  ];
  assert.equal(evaluateAngleBoard(synonymOnly).pass, false);
  const distinct = [
    { ...angleBoard().angles[0], angleId: 'a', supportingEvidence: ['return24h', 'openInterestChange'] },
    { ...angleBoard().angles[1], angleId: 'b', storyFamily: 'runner_pullback', supportingEvidence: ['return4h', 'return24h'] },
    { angleId: 'c', storyFamily: 'other', humanPremise: 'An extreme move arrived without a clean official explanation.', whyReaderStops: 'The missing explanation is unusual at this scale.', readerInitialAssumption: 'a visible catalyst caused the move', surprisingThing: 'timestamp-safe research found no clean official headline', tension: 'large move without a verified public driver', reveal: 'the absence is verified, but causality is not invented', readerPayoff: 'separate an unexplained move from a made-up narrative', reasonToOpenCashtag: 'inspect whether the move persists', heroFact: 'return24h', supportingEvidence: ['return24h'], readerExperienceFamily: 'MYSTERY', openingFamily: 'mystery', endingJob: 'preserve research honesty', feedDifference: 'no-headline mystery', confidence: 'calibrated' },
  ];
  assert.equal(evaluateAngleBoard(distinct).pass, true);
});

test('angle board rejects metric relationships that have no human proposition after the metric names are removed', () => {
  const result = evaluateAngleBoard([
    { angleId: 'alignment', storyFamily: 'major_runner', humanPremise: 'Price rose while open interest rose faster.', whyReaderStops: 'Two metrics moved.', readerInitialAssumption: 'the metrics should tell the story', surprisingThing: 'one metric rose faster', tension: 'the numbers differ', reveal: 'open interest rose faster than price', readerPayoff: 'the relationship is visible', reasonToOpenCashtag: 'inspect the metrics', heroFact: 'return24h', supportingEvidence: ['return24h', 'openInterestChange'], readerExperienceFamily: 'CONTRADICTION', openingFamily: 'metric_relation', endingJob: 'describe alignment', feedDifference: 'metrics', confidence: 'calibrated' },
    angleBoard().angles[1],
  ]);
  assert.deepEqual(result, { pass: false, reason: 'METRIC_CENTRIC_ANGLE', angleId: 'alignment' });
});

test('hero-only human angles may intentionally carry no supporting evidence', () => {
  const angles = angleBoard().angles.map((angle, index) => ({
    ...angle,
    angleId: `hero-only-${index + 1}`,
    humanPremise: index === 0
      ? 'A near fifty-percent one-day move is extraordinary before any secondary read is needed.'
      : 'The scale of a near fifty-percent day makes the usual quick glance insufficient.',
    whyReaderStops: 'The size of the move changes what deserves a closer look.',
    readerInitialAssumption: 'one large number tells the whole story',
    surprisingThing: 'The day itself was unusually large.',
    tension: 'the move is already large enough to challenge a casual read',
    reveal: 'The hero move alone is the event worth understanding.',
    readerPayoff: 'Readers get a clean scale check before adding a second theory.',
    reasonToOpenCashtag: 'inspect the unusually large daily move',
    heroFact: '+46.88% over 24 hours',
    supportingEvidence: [],
  }));
  assert.deepEqual(evaluateAngleBoard(angles), { pass: true, reason: null });
});

test('angle board rejects a secondary open-interest claim without verified supporting evidence', () => {
  const angles = angleBoard().angles.map((angle, index) => ({
    ...angle,
    angleId: `needs-oi-${index + 1}`,
    heroFact: '+46.88% over 24 hours',
    supportingEvidence: [],
    humanPremise: 'The move became more interesting because open interest kept expanding afterward.',
    surprisingThing: 'Open interest kept expanding after the move.',
    tension: 'the rally and exposure were both growing',
    reveal: 'The extra exposure changes the read of the rally.',
    readerPayoff: 'Readers can inspect whether that participation remains in the market.',
  }));
  const result = evaluateAngleBoard(angles, {
    allowedEvidence: [{ key: 'return24h', display: '+46.88%', timeframe: '24h' }, { key: 'openInterestChange', display: '+12.47%', timeframe: '4h' }],
  });
  assert.deepEqual(result, { pass: false, reason: 'UNSUPPORTED_ANGLE_CLAIM', angleId: 'needs-oi-1', evidenceKey: 'openInterestChange' });
});

test('angle board accepts a secondary claim when it references verified supporting evidence', () => {
  const angles = angleBoard().angles.map((angle, index) => ({
    ...angle,
    angleId: `supported-oi-${index + 1}`,
    heroFact: '+46.88% over 24 hours',
    supportingEvidence: ['openInterestChange'],
    humanPremise: 'The move became more interesting because open interest kept expanding afterward.',
    surprisingThing: 'Open interest kept expanding after the move.',
    tension: 'the rally and exposure were both growing',
    reveal: 'The extra exposure changes the read of the rally.',
    readerPayoff: 'Readers can inspect whether that participation remains in the market.',
  }));
  assert.deepEqual(evaluateAngleBoard(angles, {
    allowedEvidence: [{ key: 'return24h', display: '+46.88%', timeframe: '24h' }, { key: 'openInterestChange', display: '+12.47%', timeframe: '4h' }],
  }), { pass: true, reason: null });
});

test('optional supporting evidence does not permit an incomplete or metric-only human angle', () => {
  const incomplete = angleBoard().angles.map((angle, index) => ({ ...angle, angleId: `incomplete-${index + 1}`, supportingEvidence: [], humanPremise: '' }));
  assert.deepEqual(evaluateAngleBoard(incomplete), { pass: false, reason: 'INCOMPLETE_HUMAN_ANGLE', angleId: 'incomplete-1' });
  const metricOnly = [{
    ...angleBoard().angles[0],
    angleId: 'metric-only-empty-support',
    supportingEvidence: [],
    humanPremise: 'Price rose while open interest rose faster.',
    whyReaderStops: 'Two metrics moved.',
    readerInitialAssumption: 'the metrics should tell the story',
    surprisingThing: 'one metric rose faster',
    tension: 'the numbers differ',
    reveal: 'open interest rose faster than price',
    readerPayoff: 'the relationship is visible',
    reasonToOpenCashtag: 'inspect the metrics',
  }, angleBoard().angles[1]];
  assert.deepEqual(evaluateAngleBoard(metricOnly), { pass: false, reason: 'METRIC_CENTRIC_ANGLE', angleId: 'metric-only-empty-support' });
});


test('draft selection favors a complete human story over a high-surprise but weak-payoff alternative', () => {
  const selection = selectBestDraft([
    { candidateId: 'flashy', postText: '$ENA is up 47%.', scores: { surprise: 9, scrollStop: 9, readThrough: 4, humanVoice: 5, eventSpecificity: 8, pointOfView: 3, payoff: 3, cashtagCuriosity: 8, feedNovelty: 8, noAiSlop: 5, compression: 9 } },
    { candidateId: 'story', postText: '$ENA is up almost 47% in a day.\n\nThe follow-through is the part worth opening.', scores: { surprise: 8, scrollStop: 8, readThrough: 8, humanVoice: 8, eventSpecificity: 8, pointOfView: 8, payoff: 8, cashtagCuriosity: 8, feedNovelty: 8, noAiSlop: 8, compression: 8 } },
  ]);
  assert.equal(selection.pass, true);
  assert.equal(selection.winner.candidateId, 'story');
});

test('editorial pre-gate rejects analyst classifications as a public ending', () => {
  const result = evaluateEditorialPreGate({ text: '$BTC saw 13.6x volume while price slipped only -0.18%. That is weird because the market got loud without moving far. Massive trading spike. Almost no price damage. For now this is an active pause, not a confirmed reversal.' });
  assert.equal(result.pass, false);
  assert.equal(result.risks.analystTone, true);
});

test('selector calibration rejects factually clean near-miss copy and honors an independent winner', () => {
  const nearMissScores = { surprise: 6, scrollStop: 6, readThrough: 6, humanVoice: 6, eventSpecificity: 7, pointOfView: 5, payoff: 5, cashtagCuriosity: 6, compression: 7, feedNovelty: 6, noAiSlop: 6, readerReward: 5, insightNovelty: 5 };
  const strongScores = { surprise: 8, scrollStop: 8, readThrough: 8, humanVoice: 8, eventSpecificity: 8, pointOfView: 7, payoff: 8, cashtagCuriosity: 8, compression: 8, feedNovelty: 8, noAiSlop: 8, readerReward: 8, insightNovelty: 8 };
  const selection = selectBestDraft([
    { candidateId: 'near-miss', scores: nearMissScores, underdevelopedStory: true },
    { candidateId: 'strong', scores: strongScores, underdevelopedStory: false },
  ], { winner: 'strong' });
  assert.equal(selection.pass, true);
  assert.equal(selection.winner.candidateId, 'strong');
  assert.equal(selectBestDraft([{ candidateId: 'near-miss', scores: nearMissScores, underdevelopedStory: true }]).reason, 'NO_CANDIDATE_WITH_EDITORIAL_MERIT');
});

test('pre-gate recognizes an underdeveloped metric caption without rejecting a compact complete story', () => {
  const thin = '$ADA saw 8.0x volume over 5 minutes during a +8.63% advance over 4 hours.\n\nOpen interest rose +14.84% over 4 hours. This was an actively traded rally, not a quiet price drift.';
  const complete = '$ENA is almost +47% in a day.\n\nThe easy reaction is that the move is already gone.\n\nExcept it added another 6.6% over four hours while open interest climbed about 12.5%.\n\nThat is not proof of where it goes next. It is the part that makes the obvious “too late” read incomplete.';
  assert.equal(evaluateEditorialPreGate({ text: thin }).risks.underdevelopedStory, true);
  assert.equal(evaluateEditorialPreGate({ text: complete }).risks.underdevelopedStory, false);
});

test('social pre-gate accepts a short hook that explains why a verified runner is weird', () => {
  const text = '$ENA is up almost 47% today — and it is still accelerating.\n\nMost moves this stretched start cooling off. ENA did not.\n\nThe latest 15 minutes added another 2%, even though the full latest hour was only +0.7%.\n\nThe biggest move on the board just found another gear.';
  const result = evaluateEditorialPreGate({ text, recent: [] });

  assert.equal(result.pass, true);
  assert.ok(result.editorialMerit >= 7);
  assert.equal(result.risks.underdevelopedStory, false);
  assert.equal(result.risks.templateSimilarity, false);
});

test('selector lets a genuinely good seven-out-of-ten social post reach Critic', () => {
  const goodEnough = {
    surprise: 8, scrollStop: 8, readThrough: 7, humanVoice: 7, eventSpecificity: 8,
    pointOfView: 6, payoff: 7, cashtagCuriosity: 8, compression: 8, feedNovelty: 7,
    noAiSlop: 7, readerReward: 6, insightNovelty: 6,
  };
  const result = selectBestDraft([{
    candidateId: 'social-runner',
    postText: '$ENA is up almost 47% today — and it is still accelerating.\n\nMost moves this stretched start cooling off. ENA did not.\n\nThe latest 15 minutes added another 2%.\n\nThe biggest move on the board just found another gear.',
    scores: goodEnough,
    underdevelopedStory: false,
  }], { winner: 'social-runner' });

  assert.equal(result.pass, true);
  assert.equal(result.winner.candidateId, 'social-runner');
});

test('story-aware chart selector avoids forcing every story into price/OI divergence', () => {
  assert.equal(selectStoryChartIntent({ storyFamily: 'major_runner', heroFactType: 'return24h' }, candidate()).preset, 'receipt');
  assert.equal(selectStoryChartIntent({ storyFamily: 'volume_shock', heroFactType: 'volumeRatio' }, candidate()).preset, 'volume_shock');
  assert.equal(selectStoryChartIntent({ storyFamily: 'reversal', heroFactType: 'return15m' }, candidate()).preset, 'timeline_mystery');
});

test('visual gate rejects chart intent that disagrees with the editorial story or event facts', () => {
  const event = candidate();
  assert.equal(validateStoryChart({ candidate: event, plan: { storyFamily: 'reversal' }, visualIntent: { preset: 'timeline_mystery', relationship: 'none' }, chart: { width: 1200, height: 900, labels: ['$BTC'] } }).pass, true);
  assert.equal(validateStoryChart({ candidate: event, plan: { storyFamily: 'reversal' }, visualIntent: { preset: 'price_oi_divergence', relationship: 'price_up_oi_up' }, chart: { width: 1200, height: 900, labels: ['$BTC'] } }).pass, false);
});

test('BTC contained-damage final story rejects an unrelated OI chart and accepts its volume story chart', () => {
  const btc = candidate({
    claimsAllowed: [
      { key: 'volumeRatio', display: '13.6x', timeframe: '5m' },
      { key: 'return15m', display: '-0.18%', timeframe: '15m' },
      { key: 'return4h', display: '+6.27%', timeframe: '4h' },
      { key: 'openInterestChange', display: '+10.26%', timeframe: '4h' },
    ],
  });
  const finalStory = {
    angleId: 'angle_1',
    storyFamily: 'contained_damage',
    heroFact: 'BTC saw 13.6x volume over 5 minutes while falling only -0.18% over 15 minutes.',
    supportingEvidence: ['return4h'],
    allowedChartEvidence: ['volumeRatio', 'return15m', 'return4h'],
    selectedPreset: 'volume_shock',
  };
  const oldIntent = { preset: 'price_oi_divergence', relationship: 'price_down_oi_up', revealOnOpen: true };
  const oldChart = { width: 1200, height: 900, labels: ['$BTC', '+5.71% LAST 24H', 'OPEN INTEREST +10.26% / 4H'] };
  assert.deepEqual(validateStoryChart({ candidate: btc, plan: finalStory, finalStory, visualIntent: oldIntent, chart: oldChart }), { pass: false, reason: 'CHART_STORY_MISMATCH' });
  assert.equal(validateStoryChart({ candidate: btc, plan: finalStory, finalStory, visualIntent: { preset: 'volume_shock', relationship: 'none', revealOnOpen: false }, chart: { width: 1200, height: 900, labels: ['$BTC', '13.6X VOLUME / 5M'] } }).pass, true);
  assert.deepEqual(validateStoryChart({ candidate: btc, plan: finalStory, finalStory, visualIntent: { preset: 'volume_shock', relationship: 'none', revealOnOpen: false }, chart: { width: 1200, height: 900, labels: ['$BTC', '+5.71% LAST 24H', '13.6X VOLUME / 5M'] } }), { pass: false, reason: 'CHART_STORY_MISMATCH' });
});

test('visual gate does not confuse an omitted $0.00 claim with a more precise rendered story level', () => {
  const event = candidate({
    claimsAllowed: [
      { key: 'return24h', display: '+7.10%', timeframe: '24h' },
      { key: 'liquidations', display: '$0.00', timeframe: '5m' },
    ],
  });
  const finalStory = {
    storyFamily: 'retest_continuation',
    allowedChartEvidence: ['return24h'],
    heroMetric: { key: 'return24h', display: '+7.10%', timeframe: '24h' },
  };
  assert.deepEqual(
    validateStoryChart({
      candidate: event,
      plan: finalStory,
      finalStory,
      visualIntent: { preset: 'receipt', relationship: 'none', revealOnOpen: false },
      chart: { width: 1200, height: 900, labels: ['$BTC', '+7.10% LAST 24H', 'REACTION $0.005006'] },
    }),
    { pass: true, reason: null },
  );
});

test('editorial gates calibrate the exact BTC and ADA captions below automatic-publication merit', () => {
  const btc = '$BTC saw 13.6x volume over five minutes, yet fell just -0.18% over 15 minutes.\n\nThe activity was extreme; the damage was not. BTC was still up +6.27% over four hours, so the burst looked more like contained noise than a break in the broader move.';
  const ada = '$ADA gained +8.63% over four hours while open interest rose +14.84%.\n\nThe price move was strong, but participation grew faster. ADA was also up +10.47% over 24 hours, making that gap the real story.';
  const strong = '$ENA is almost +47% in a day.\n\nThe easy reaction is that the move is already gone, except it added another 6.6% over four hours while open interest climbed about 12.5%.\n\nThat does not predict the next candle. It makes the obvious “too late” read incomplete.';
  assert.equal(evaluateEditorialPreGate({ text: btc }).risks.underdevelopedStory, true);
  assert.equal(evaluateEditorialPreGate({ text: ada }).risks.underdevelopedStory, true);
  assert.equal(evaluateEditorialPreGate({ text: strong }).pass, true);
  const inflated = criticResponse('PASS');
  assert.equal(evaluateCriticGate(inflated, { text: btc }).pass, false);
  assert.equal(evaluateCriticGate(inflated, { text: ada }).pass, false);
  assert.equal(evaluateCriticGate(inflated, { text: strong }).pass, true);
});

test('visual gate rejects an obsolete 15-minute header or marker when 15 minutes is not the story hero', () => {
  const event = candidate({
    claimsAllowed: [
      { key: 'return24h', display: '+5.71%', timeframe: '24h' },
      { key: 'return15m', display: '-0.18%', timeframe: '15m' },
    ],
  });
  const result = validateStoryChart({
    candidate: event,
    plan: { storyFamily: 'volume_shock' },
    visualIntent: { preset: 'volume_shock', relationship: 'none' },
    chart: { width: 1200, height: 900, labels: ['$BTC', '+5.71% LAST 24H', '-0.18% LAST 15 MIN', 'LAST 15 MIN'] },
  });
  assert.deepEqual(result, { pass: false, reason: 'VISUAL_UNEXPECTED_15M' });
});

test('editorial bridge separates planning, writing, critic rewrite, and selected evidence', async () => {
  const calls = [];
  const responses = [
    { publishWorthiness: 'strong', heroFact: '+46.88% over 24 hours', heroFactType: 'return24h', whyHumanCares: 'large runner', readerLikelyAssumption: 'too late', hiddenAngle: 'OI rose', centralQuestion: 'still building?', storyFamily: 'major_runner', hookFamily: 'hero_number', format: 'short', pointOfView: 'observant', confidence: 'calibrated', primaryEvidence: ['return24h', 'openInterestChange'], secondaryEvidence: [], omitFromPublicPost: ['return15m'], researchNeeded: false, researchQuestion: '', abConflict: { use: false, a: '', b: '', discriminator: '' }, reasonToOpenCashtag: 'check continuation', skipReason: '' },
    angleBoard(),
    writerCandidates({ cashtag: '$ENA', claim: { key: 'return24h', display: '+46.88%' } }),
    candidateSelection(),
    criticResponse('REWRITE', { failures: ['weak_hook'], scores: { scrollStop: 3, humanVoice: 5, eventSpecificity: 7, evidenceEconomy: 8, pointOfView: 4, cashtagCuriosity: 6, noAiSlop: 6 }, risks: { analystTone: false, templateSimilarity: false, bothSidesWithoutView: false, metricDump: false, weakHook: true, weakEnding: false }, rewriteInstructions: ['Lead with the number.'] }),
    { decision: 'publish', reason: 'revised', postText: '$ENA is up +46.88% over 24 hours.\n\nThe easy reaction is that the move is already late, but OI is up +12.47% over 4 hours.\n\nThat makes the obvious dismissal incomplete.', cashtag: '$ENA', claimsUsed: [{ key: 'return24h', display: '+46.88%' }, { key: 'openInterestChange', display: '+12.47%' }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } },
    criticResponse('PASS', { scores: { scrollStop: 8, humanVoice: 8, eventSpecificity: 8, evidenceEconomy: 9, pointOfView: 7, cashtagCuriosity: 8, noAiSlop: 8 } }),
  ];
  const bridge = new CryptoCodexBridge({
    jarvis: { runAutomationTurn: async (request) => { calls.push(request); return JSON.stringify(responses.shift()); } },
    playbookLoader: async () => 'test playbook',
  });
  const result = await bridge.generateEditorial({ threadId: 'thread', candidate: candidate({ cashtag: '$ENA' }), editorialHistory: [] });
  assert.equal(result.status, 'ready');
  assert.equal(result.rewriteCount, 1);
  assert.equal(result.criticChecks.length, 2);
  assert.deepEqual(result.content.claimsUsed.map((item) => item.key), ['return24h', 'openInterestChange']);
  assert.equal(calls.length, 7);
  assert.match(calls[0].additionalContext['crypto.planner'].value, /historical isolation.*never grounds/i);
  assert.match(calls[0].additionalContext['crypto.planner'].value, /only exact claim keys/i);
  assert.ok(calls[1].additionalContext['crypto.angle-board']);
  assert.match(calls[1].additionalContext['crypto.angle-board'].value, /supportingEvidence is a required array field but optional evidence/i);
  assert.match(calls[1].additionalContext['crypto.angle-board'].value, /Never add a supporting metric merely to satisfy the schema/i);
  assert.match(calls[2].additionalContext['crypto.editorial-brief'].value, /return24h/);
  assert.match(calls[2].additionalContext['crypto.editorial-brief'].value, /"canonicalPublicCashtag":"\$ENA"/);
  assert.doesNotMatch(calls[2].additionalContext['crypto.editorial-brief'].value, /"key":"return15m"/);
});

test('the final chart intent follows the independently selected angle, not the first angle on the board', async () => {
  const plan = { publishWorthiness: 'strong', heroFact: '+7.10% over 24h', heroFactType: 'return24h', whyHumanCares: 'runner', readerLikelyAssumption: 'late', hiddenAngle: 'follow-through', centralQuestion: 'continue?', storyFamily: 'major_runner', hookFamily: 'hero_number', format: 'short', pointOfView: 'observant', confidence: 'calibrated', primaryEvidence: ['return24h'], secondaryEvidence: [], omitFromPublicPost: [], researchNeeded: false, researchQuestion: '', abConflict: { use: false, a: '', b: '', discriminator: '' }, reasonToOpenCashtag: 'inspect', skipReason: '' };
  const selection = candidateSelection();
  selection.winner = 'second';
  selection.whyWinner = 'The timeline story earns a different chart.';
  const responses = [plan, angleBoard(), writerCandidates({ cashtag: '$BTC' }), selection, criticResponse('PASS')];
  const bridge = new CryptoCodexBridge({ jarvis: { runAutomationTurn: async () => JSON.stringify(responses.shift()) }, playbookLoader: async () => 'test playbook' });
  const result = await bridge.generateEditorial({ threadId: 'thread', candidate: candidate(), editorialHistory: [] });
  assert.equal(result.status, 'ready');
  assert.equal(result.content.candidateId, 'second');
  assert.equal(result.content.visualIntent.preset, 'timeline_mystery');
});

test('planner skip stops before an expensive writer turn', async () => {
  const calls = [];
  const bridge = new CryptoCodexBridge({
    jarvis: { runAutomationTurn: async (request) => {
      calls.push(request);
      return JSON.stringify({ publishWorthiness: 'skip', heroFact: '', heroFactType: 'other', whyHumanCares: '', readerLikelyAssumption: '', hiddenAngle: '', centralQuestion: '', storyFamily: 'other', hookFamily: 'none', format: 'short', pointOfView: '', confidence: 'calibrated', primaryEvidence: [], secondaryEvidence: [], omitFromPublicPost: [], researchNeeded: false, researchQuestion: '', abConflict: { use: false, a: '', b: '', discriminator: '' }, reasonToOpenCashtag: '', skipReason: 'WEAK_EDITORIAL_ANGLE' });
    } },
    playbookLoader: async () => 'test playbook',
  });
  const result = await bridge.generateEditorial({ threadId: 'thread', candidate: candidate({ historicalReplay: true }) });
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'WEAK_EDITORIAL_ANGLE');
  assert.equal(calls.length, 1);
});

test('verified historical research can refine the editorial angle before writing', async () => {
  const initialPlan = { publishWorthiness: 'strong', heroFact: '+7.10% over 24h', heroFactType: 'return24h', whyHumanCares: 'runner', readerLikelyAssumption: 'late', hiddenAngle: 'price and OI', centralQuestion: 'continue?', storyFamily: 'major_runner', hookFamily: 'hero_number', format: 'short', pointOfView: 'observant', confidence: 'calibrated', primaryEvidence: ['return24h'], secondaryEvidence: [], omitFromPublicPost: [], researchNeeded: true, researchQuestion: 'What happened?', abConflict: { use: false, a: '', b: '', discriminator: '' }, reasonToOpenCashtag: 'inspect', skipReason: '' };
  const refinedPlan = { ...initialPlan, hiddenAngle: 'verified announcement explains the first candle', storyFamily: 'runner_pullback', hookFamily: 'timeline', researchNeeded: false };
  const draft = { decision: 'publish', reason: '', postText: '$BTC is up +7.10% over 24 hours.\n\nA verified announcement explains the first candle.\n\nThe follow-through is the part worth watching.', cashtag: '$BTC', claimsUsed: [{ key: 'return24h', display: '+7.10%' }], visualIntent: { preset: 'timeline_mystery', revealOnOpen: true, relationship: 'none' } };
  const calls = [];
  const responses = [initialPlan, refinedPlan, angleBoard('runner_pullback'), writerCandidates({ cashtag: '$BTC' }), candidateSelection(), criticResponse('PASS')];
  const bridge = new CryptoCodexBridge({ jarvis: { runAutomationTurn: async (request) => { calls.push(request); return JSON.stringify(responses.shift()); } }, playbookLoader: async () => 'test playbook' });
  const result = await bridge.generateEditorial({
    threadId: 'thread', candidate: candidate({ historicalReplay: true }), editorialHistory: [],
    researchProvider: async () => ({ status: 'possible_context', facts: ['announcement'], sources: [{ publishedAt: 1 }], causalityStrength: 'not_inferred', publicUseRecommendation: 'context_only' }),
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.plan.hiddenAngle, refinedPlan.hiddenAngle);
  assert.equal(calls.length, 6);
  assert.ok(calls[1].additionalContext['crypto.planner-refinement']);
});

test('critic has one bounded rewrite before the event is skipped', async () => {
  const plan = { publishWorthiness: 'strong', heroFact: '+7.10% over 24h', heroFactType: 'return24h', whyHumanCares: 'runner', readerLikelyAssumption: 'late', hiddenAngle: 'OI', centralQuestion: 'continue?', storyFamily: 'major_runner', hookFamily: 'hero_number', format: 'short', pointOfView: 'observant', confidence: 'calibrated', primaryEvidence: ['return24h'], secondaryEvidence: [], omitFromPublicPost: [], researchNeeded: false, researchQuestion: '', abConflict: { use: false, a: '', b: '', discriminator: '' }, reasonToOpenCashtag: 'inspect', skipReason: '' };
  const draft = { decision: 'publish', reason: '', postText: '$BTC is up +7.10% over 24 hours.\n\nThe easy reaction is that the move is already late, but the follow-through changes that read.\n\nThat makes the obvious dismissal incomplete.', cashtag: '$BTC', claimsUsed: [{ key: 'return24h', display: '+7.10%' }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } };
  const rewrite = criticResponse('REWRITE', { failures: ['generic'], scores: { scrollStop: 2, humanVoice: 3, eventSpecificity: 4, evidenceEconomy: 8, pointOfView: 3, cashtagCuriosity: 3, noAiSlop: 2 }, risks: { analystTone: true, templateSimilarity: true, bothSidesWithoutView: false, metricDump: false, weakHook: true, weakEnding: false }, rewriteInstructions: ['Find a specific angle.'] });
  const responses = [plan, angleBoard(), writerCandidates({ cashtag: '$BTC' }), candidateSelection(), rewrite, draft, rewrite];
  const bridge = new CryptoCodexBridge({ jarvis: { runAutomationTurn: async () => JSON.stringify(responses.shift()) }, playbookLoader: async () => 'test playbook' });
  const result = await bridge.generateEditorial({ threadId: 'thread', candidate: candidate() });
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'CRITIC_REJECTED_AFTER_REWRITE');
  assert.equal(result.rewriteCount, 1);
  assert.equal(responses.length, 0);
});

test('a pre-gate rejection after repair preserves the complete creative trace', async () => {
  const plan = { publishWorthiness: 'strong', heroFact: '+7.10% over 24h', heroFactType: 'return24h', whyHumanCares: 'runner', readerLikelyAssumption: 'late', hiddenAngle: 'follow-through', centralQuestion: 'continue?', storyFamily: 'major_runner', hookFamily: 'hero_number', format: 'short', pointOfView: 'observant', confidence: 'calibrated', primaryEvidence: ['return24h'], secondaryEvidence: [], omitFromPublicPost: [], researchNeeded: false, researchQuestion: '', abConflict: { use: false, a: '', b: '', discriminator: '' }, reasonToOpenCashtag: 'inspect', skipReason: '' };
  const thinText = '$BTC is up +7.10% over 24 hours.\n\nThe same +7.10% number is the whole story.';
  const thinAlternateText = 'A +7.10% move belongs to $BTC.\n\nOver 24 hours, that is the whole story. Is that enough?';
  const thinCandidate = (candidateId) => ({ candidateId, angleId: candidateId === 'first' ? 'dilemma' : 'timeline', storyFamily: 'major_runner', postText: candidateId === 'first' ? thinText : thinAlternateText, wordCount: 14, heroFact: '+7.10%', claimsUsed: [{ key: 'return24h', display: '+7.10%' }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } });
  const repaired = { decision: 'publish', reason: '', postText: thinText, cashtag: '$BTC', claimsUsed: [{ key: 'return24h', display: '+7.10%' }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } };
  const responses = [plan, angleBoard(), { decision: 'publish', reason: '', candidates: [thinCandidate('first'), thinCandidate('second')] }, candidateSelection(), repaired];
  const bridge = new CryptoCodexBridge({ jarvis: { runAutomationTurn: async () => JSON.stringify(responses.shift()) }, playbookLoader: async () => 'test playbook' });
  const result = await bridge.generateEditorial({ threadId: 'thread', candidate: candidate() });
  assert.equal(result.reason, 'NO_CANDIDATE_WITH_EDITORIAL_MERIT');
  assert.equal(result.angleValidation.pass, true);
  assert.equal(result.angleBoard.angles.length, 2);
  assert.equal(result.writerCandidates.length, 2);
  assert.equal(result.candidateSelection.winner, 'first');
  assert.equal(result.rewriteCount, undefined);
  assert.ok(result.candidateSelection.candidates.every((item) => Number(item.editorialMerit) <= 6));
});

test('writer cannot bypass the planner evidence budget with another allowed metric', async () => {
  const plan = { publishWorthiness: 'strong', heroFact: '+7.10% over 24h', heroFactType: 'return24h', whyHumanCares: 'runner', readerLikelyAssumption: 'late', hiddenAngle: 'OI', centralQuestion: 'continue?', storyFamily: 'major_runner', hookFamily: 'hero_number', format: 'short', pointOfView: 'observant', confidence: 'calibrated', primaryEvidence: ['return24h: +7.10% over 24h'], secondaryEvidence: [], omitFromPublicPost: ['volumeRatio'], researchNeeded: false, researchQuestion: '', abConflict: { use: false, a: '', b: '', discriminator: '' }, reasonToOpenCashtag: 'inspect', skipReason: '' };
  const draft = { decision: 'publish', reason: '', postText: '$BTC is up +7.10% over 24 hours. Volume reached 6.0x.', cashtag: '$BTC', claimsUsed: [{ key: 'return24h', display: '+7.10%' }, { key: 'volumeRatio', display: '6.0x' }], visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' } };
  const bridge = new CryptoCodexBridge({ jarvis: { runAutomationTurn: async () => JSON.stringify([plan, angleBoard(), { decision: 'publish', reason: '', candidates: [{ candidateId: 'first', angleId: 'dilemma', storyFamily: 'major_runner', postText: draft.postText, wordCount: 12, heroFact: '+7.10%', claimsUsed: draft.claimsUsed, visualIntent: draft.visualIntent }, { candidateId: 'second', angleId: 'timeline', storyFamily: 'runner_pullback', postText: draft.postText, wordCount: 12, heroFact: '+7.10%', claimsUsed: draft.claimsUsed, visualIntent: draft.visualIntent }] }].shift()) }, playbookLoader: async () => 'test playbook' });
  const responses = [plan, angleBoard(), { decision: 'publish', reason: '', candidates: [{ candidateId: 'first', angleId: 'dilemma', storyFamily: 'major_runner', postText: draft.postText, wordCount: 12, heroFact: '+7.10%', claimsUsed: draft.claimsUsed, visualIntent: draft.visualIntent }, { candidateId: 'second', angleId: 'timeline', storyFamily: 'runner_pullback', postText: draft.postText, wordCount: 12, heroFact: '+7.10%', claimsUsed: draft.claimsUsed, visualIntent: draft.visualIntent }] }];
  bridge.jarvis.runAutomationTurn = async () => JSON.stringify(responses.shift());
  const result = await bridge.generateEditorial({ threadId: 'thread', candidate: candidate() });
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'WRITER_UNSELECTED_EVIDENCE');
});

test('V2.1 pre-gate rejects the exact old BTC, ADA, and ENA analyst drafts', () => {
  const oldDrafts = [
    '$BTC slipped inside a broader advance as open interest continued higher.\n\nOver 15 minutes, BTC fell -0.18%, while the four-hour move reached +6.27%. Open interest rose +10.26% over 4 hours.\n\nThat structure leaves two plausible readings: positions may have been building into the advance, or exposure may have been unwinding.\n\nThe key question is whether this was a pause within the move or an early reversal with rising exposure.',
    '$ADA advanced +8.63% over 4 hours while open interest climbed +14.84%.\n\nThe move extended across the day, with a +10.47% return over 24 hours.\n\nRising price and open interest can reflect positions building into the advance, but they can also reflect exposure being unwound or reshaped.\n\nThe rally is clear; the positioning behind it still requires interpretation.',
    '$ENA surged +46.88% over 24 hours while open interest rose +12.47% over 4 hours.\n\nThe move retained momentum across the shorter horizon, adding +6.61% over 4 hours.\n\nThat combination can point to positions building into the rally, but it can also reflect exposure being unwound or reshaped after a major move.\n\nENA\u2019s performance is unmistakable; the positioning behind it remains open to interpretation.',
  ];
  for (const text of oldDrafts) {
    const result = evaluateEditorialPreGate({ text, recent: [] });
    assert.equal(result.pass, false);
    assert.equal(result.risks.analystTone, true);
  }
  const ada = evaluateEditorialPreGate({ text: oldDrafts[1], recent: [] });
  assert.equal(ada.risks.bothSidesWithoutView, true);
  const ena = evaluateEditorialPreGate({ text: oldDrafts[2], recent: [] });
  assert.equal(ena.risks.weakEnding, true);
});

test('V2.1.1 pre-gate rejects the latest ADA false PASS and semantic non-conclusion paraphrases', () => {
  const latestAda = '$ADA gained +8.63% over 4 hours while open interest rose +14.84%.\n\nThe move also reached +10.47% over 24 hours, confirming that the advance extended well beyond a single short interval.\n\nPrice and open interest rose together, so the rally was accompanied by expanding participation. The numbers do not reveal whether that participation came from new positions or unwinding exposure.\n\nThe advance is clear; the positioning behind it is not.';
  const paraphrase = '$ADA is up +10.47% over 24 hours.\n\nOpen interest climbed with price.\n\nThat may be fresh positioning, or it may be traders closing older exposure.\n\nThe available data cannot distinguish between the two.';
  for (const text of [latestAda, paraphrase]) {
    const result = evaluateEditorialPreGate({ text, recent: [] });
    assert.equal(result.pass, false);
    assert.equal(result.risks.nonConclusionAnalystPattern, true);
  }
});

test('Critic PASS is downgraded when a score threshold or hard risk fails', () => {
  const lowVoice = evaluateCriticGate({ decision: 'PASS', scores: { scrollStop: 9, humanVoice: 4, eventSpecificity: 9, evidenceEconomy: 8, pointOfView: 8, cashtagCuriosity: 8, noAiSlop: 8 }, risks: { analystTone: false, templateSimilarity: false, bothSidesWithoutView: false, metricDump: false, weakHook: false, weakEnding: false } });
  assert.equal(lowVoice.pass, false);
  const analystTone = evaluateCriticGate({ decision: 'PASS', scores: { scrollStop: 9, humanVoice: 9, eventSpecificity: 9, evidenceEconomy: 8, pointOfView: 8, cashtagCuriosity: 8, noAiSlop: 8 }, risks: { analystTone: true, templateSimilarity: false, bothSidesWithoutView: false, metricDump: false, weakHook: false, weakEnding: false } });
  assert.equal(analystTone.pass, false);
  const weakPayoff = evaluateCriticGate({ decision: 'PASS', scores: { scrollStop: 9, humanVoice: 9, eventSpecificity: 9, evidenceEconomy: 8, pointOfView: 8, cashtagCuriosity: 8, noAiSlop: 8, payoff: 4, feedNovelty: 8 }, risks: criticResponse('PASS').risks });
  assert.equal(weakPayoff.pass, false);
});

test('mandatory research is configurable and ENA-scale historical moves cannot be waived by Planner', () => {
  const policy = { extreme24hPct: 20, extreme4hPct: 12, extremeHumanShock: 8, extremeRelativeShock: 8 };
  assert.deepEqual(mandatoryResearchDecision(candidate({ tier: 'B', metrics: { ...candidate().metrics, return24hPct: 2, return4hPct: 1 } }), policy), { required: false, reason: null });
  assert.equal(mandatoryResearchDecision(candidate({ tier: 'S' }), policy).reason, 'S_TIER');
  assert.equal(mandatoryResearchDecision(candidate({ cashtag: '$ENA', metrics: { ...candidate().metrics, return24hPct: 46.88 } }), policy).reason, 'extreme_24h_move');
});

test('historical official research excludes a future announcement and never infers causality', async () => {
  const occurredAt = Date.UTC(2026, 7, 21, 15, 59, 59);
  const provider = new OfficialContextResearch({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: { catalogs: [{ articles: [
        { title: 'ENA ecosystem update', releaseDate: occurredAt - 60_000, code: 'past' },
        { title: 'ENA future update', releaseDate: occurredAt + 60_000, code: 'future' },
      ] }] } }),
    }),
  });
  const result = await provider.research({ candidate: candidate({ cashtag: '$ENA' }), occurredAt, historical: true, question: 'ENA catalyst?' });
  assert.equal(result.status, 'possible_context');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].publishedAt, occurredAt - 60_000);
  assert.equal(result.causalityStrength, 'not_inferred');
});
