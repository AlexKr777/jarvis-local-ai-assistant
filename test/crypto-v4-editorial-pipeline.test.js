import test from 'node:test';
import assert from 'node:assert/strict';

import { V4EditorialPipeline, validateV4Draft } from '../src/crypto/content/v4-editorial-pipeline.js';

const factPack = Object.freeze({
  identity: { symbol: 'ALPHAUSDT', cashtag: '$ALPHA' },
  ranking: { top10Rank: 2, change24h: '+18.20%' },
  market: { currentPrice: 10, range24h: { high: 10, low: 7, position: 1, drawdownFromHighPct: 0 } },
  levels: { supports: [{ id: 'level:support:1', midpoint: 8.8, evidence: [{ timeframe: '1h' }] }], resistances: [{ id: 'level:resistance:1', midpoint: 10, evidence: [{ timeframe: '1h' }] }] },
  factsById: { 'claim:return24h': { display: '+18.20%' } },
  numbersAllowed: [{ key: 'return24h', display: '+18.20%', timeframe: '24h' }],
  research: { status: 'none_found', sources: [], claims: [] },
  chartInputs: { candles: {}, volumes: {}, eventMarkers: [] },
});

const traderThought = `INITIAL: I expected the daily gain to carry straight through resistance.
CHANGE: The retest at 8.80 matters more than another green candle.
LEVEL_REASON: 8.80 matters because buyers must defend it after price returns there.
BUYER_SELLER: Sellers should fail to push price below 8.80 on the retest.
PREFERRED: I prefer a defended retest before treating 10.00 as live.
INVALIDATION: A close below 8.80 makes me drop the continuation case.
NEXT: I expect buyers to test 10.00 after 8.80 is defended.
MISSED: The first retest says more than the daily percentage.
CAUTION: I remain cautious until buyers answer that retest.`;

test('v4 editorial pipeline uses a Gemma planner, materially different writers and a critic pass', async () => {
  const calls = [];
  const pipeline = new V4EditorialPipeline({ invoke: async ({ stage }) => {
    calls.push(stage);
    if (stage === 'planner') return 'THESIS: The breakout is interesting only while 8.80 holds.\nWATCH: 10.00\nINVALIDATION: 8.80';
    if (stage === 'trader_thought') return traderThought;
    if (stage === 'writer_reflection') return '$ALPHA changed my view because +18.20% over the last 24 hours has carried it to the day high, yet 8.80 is still the nearby line that matters.\n\nI want to see that floor hold on the next pullback. If it does, 10.00 is the next price I am watching.\n\nBelow 8.80, my bullish idea is gone.';
    if (stage === 'writer_tension') return '$ALPHA at +18.20% over 24 hours is forcing me to separate the headline from the proof I actually need.\n\nI would trust the continuation only if 8.80 holds, with 10.00 as the next level I want to watch.\n\nA break beneath 8.80 would end that thesis.';
    if (stage === 'critic') return 'PASS';
    throw new Error(`unexpected ${stage}`);
  } });

  const result = await pipeline.generate({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, editorialHistory: [] });
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, ['planner', 'trader_thought', 'writer_reflection', 'writer_tension', 'critic']);
  assert.equal(result.audit.traderThought.valid, true);
  assert.equal(result.audit.critic.verdict, 'PASS');
  assert.equal(result.audit.writerCandidates.length, 2);
  assert.notEqual(result.audit.writerCandidates[0].text, result.audit.writerCandidates[1].text);
  assert.match(result.content.postText, /8\.80/);
  assert.deepEqual(result.content.claimsUsed, [{ key: 'return24h', display: '+18.20%' }]);
});

test('v4 Selector prefers the distinct viable Writer candidate before declaring feed repetition', async () => {
  const reflection = '$ALPHA changed my view because +18.20% over the last 24 hours has carried it to the day high, yet 8.80 is still the nearby line that matters.\n\nI want to see that first reaction hold. If it does, 10.00 is the next price I would reassess.\n\nBelow 8.80, I leave the continuation idea alone.';
  const tension = '8.80 is the number I keep returning to on $ALPHA, not +18.20% in 24 hours. The percentage has already made its point; this level decides whether the next pullback is absorbed or simply exposes how little is underneath it.\n\nIf price returns there and stays put, 10.00 becomes a useful question again.\n\nA clean loss of 8.80 makes that question irrelevant for me.';
  const makePipeline = () => new V4EditorialPipeline({ invoke: async ({ stage }) => {
    if (stage === 'planner') return 'THESIS: The breakout is interesting only while 8.80 holds.\nWATCH: 10.00\nINVALIDATION: 8.80';
    if (stage === 'trader_thought') return traderThought;
    if (stage === 'writer_reflection') return reflection;
    if (stage === 'writer_tension') return tension;
    if (stage === 'critic') return 'PASS';
    throw new Error(`unexpected ${stage}`);
  } });
  const candidate = { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed };
  const first = await makePipeline().generate({ factPack, candidate, editorialHistory: [] });
  assert.equal(first.status, 'ready');
  assert.equal(first.audit.selected.id, 'reflection');

  const second = await makePipeline().generate({
    factPack,
    candidate,
    editorialHistory: [{ text: first.content.postText, fingerprint: first.fingerprint }],
  });
  assert.equal(second.status, 'ready');
  assert.equal(second.audit.selected.id, 'tension');
  assert.equal(second.audit.selection.options[0].diversity.pass, false);
  assert.equal(second.audit.selection.options[1].diversity.pass, true);
  assert.equal(second.fingerprint.hookFamily, 'level_observation');
});

test('v4 draft gate rejects report prose without a real first-person view', () => {
  const result = validateV4Draft(
    '$ALPHA is up +18.20% over 24 hours. The runner is near the daily high. Holding 8.80 would leave 10.00 as the watch zone, while a move below 8.80 invalidates the thesis. The result is a technical observation with no personal thought or author position at all.',
    { factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('missing_human_view'));
});

test('v4 draft gate rejects the generic phrases that made earlier live drafts interchangeable', () => {
  const result = validateV4Draft(
    '$ALPHA has a +18.20% move over 24 hours. I am refusing to chase this daily runner until local reaction support at 8.80 holds, then 10.00 is the watch zone. A break below 8.80 invalidates this read, so the technical structure needs to survive first.',
    { factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('banned_language'));
});

test('v4 draft gate rejects the canned conditional shell from a weak live preview', () => {
  const result = validateV4Draft(
    '$ALPHA is up +18.20% over 24 hours. My view only changes if 8.80 holds, and I am starting to reconsider the move. The ideal scenario involves 10.00, but if 8.80 fails the bullish idea is over.',
    { factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('banned_language'));
});

test('v4 semantic gate keeps a first reaction separate from structural invalidation', () => {
  const mappedFactPack = {
    ...factPack,
    levels: {
      supports: [
        { id: 'reaction', midpoint: 8.8, evidence: [{ timeframe: '1h' }] },
        { id: 'invalidation', midpoint: 8.2, evidence: [{ timeframe: '4h' }] },
      ],
      resistances: [{ id: 'watch', midpoint: 10, evidence: [{ timeframe: '1h' }] }],
    },
    traderEvidenceMap: {
      valid: true,
      firstReactionZone: { role: 'first_reaction_zone', levelId: 'reaction', midpoint: 8.8, why: 'Immediate retest.' },
      structuralInvalidation: { role: 'structural_invalidation', levelId: 'invalidation', midpoint: 8.2, why: 'Loss ends structure.' },
      nextWatch: { role: 'next_watch', levelId: 'watch', midpoint: 10, why: 'Next boundary.' },
      relevantEvents: [], marketStructure: {},
    },
  };
  const result = validateV4Draft(
    '$ALPHA made me slow down after +18.20% in 24 hours. I need 8.80 to hold the first pullback before 10.00 is worth revisiting, because the daily percentage has already done its job and another green candle would not settle the only question I have.\n\nIf 8.20 breaks, I leave the continuation idea alone and wait for a chart that can earn a different opinion.',
    { factPack: mappedFactPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: mappedFactPack.numbersAllowed } },
  );
  assert.equal(result.ok, true, result.errors.join(', '));

  const mismatch = validateV4Draft(
    '$ALPHA made me slow down after +18.20% in 24 hours. A break below 8.80 ends the setup before 10.00 matters, because the daily percentage alone cannot replace a real response at the first pullback.\n\nI would only reconsider once 8.20 is back above price and the chart has found a calmer place to build from.',
    { factPack: mappedFactPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: mappedFactPack.numbersAllowed } },
  );
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.includes('level_role_mismatch'));
});

test('v4 semantic gate binds a price role even when the price ends a sentence', () => {
  const mappedFactPack = {
    ...factPack,
    levels: {
      supports: [
        { id: 'reaction', midpoint: 8.8, evidence: [{ timeframe: '1h' }] },
        { id: 'invalidation', midpoint: 8.2, evidence: [{ timeframe: '4h' }] },
      ],
      resistances: [{ id: 'watch', midpoint: 10, evidence: [{ timeframe: '1h' }] }],
    },
    traderEvidenceMap: {
      valid: true,
      firstReactionZone: { role: 'first_reaction_zone', levelId: 'reaction', midpoint: 8.8, why: 'Immediate retest.' },
      structuralInvalidation: { role: 'structural_invalidation', levelId: 'invalidation', midpoint: 8.2, why: 'Loss ends structure.' },
      nextWatch: { role: 'next_watch', levelId: 'watch', midpoint: 10, why: 'Next boundary.' },
      relevantEvents: [], marketStructure: {},
    },
  };
  const result = validateV4Draft(
    '$ALPHA made me slower after +18.20% in 24 hours. The first reaction at 8.80 is the only reply I need before I care about a fresh test of 10.00, because another green candle would not settle that question for me.\n\nMy line in the sand is 8.20. If price cannot reclaim 8.80 from there, I stop treating this as the constructive path and wait for a different chart to earn my attention.',
    { factPack: mappedFactPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: mappedFactPack.numbersAllowed } },
  );
  assert.equal(result.ok, true, result.errors.join(', '));
});

test('v4 keeps a vague private Thought out of the Writer even when it has all nine labels', async () => {
  const calls = [];
  const vagueThought = `INITIAL: I expected a steady path but I am now uncertain about it.
CHANGE: The daily percentage made the path forward less certain for me.
LEVEL_REASON: 8.80 matters because a retest there separates a defended move from one that only ran.
BUYER_SELLER: If sellers press lower, I need 8.80 to absorb that pressure first.
PREFERRED: I prefer to see 8.80 hold on a retest before revisiting 10.00.
INVALIDATION: A move below 8.80 makes me drop the continuation view.
NEXT: I expect either a retest at 8.80 or a failed push into 10.00 next.
MISSED: The daily percentage is visible but the retest response matters more.
CAUTION: I stay cautious until the next reaction proves the move can keep ground.`;
  const pipeline = new V4EditorialPipeline({ invoke: async ({ stage }) => {
    calls.push(stage);
    if (stage === 'planner') return 'THESIS: Facts only\nWATCH: 10.00\nINVALIDATION: 8.80';
    if (stage === 'trader_thought') return vagueThought;
    if (stage === 'trader_thought_repair') return traderThought;
    if (stage === 'writer_reflection') return '$ALPHA changed my view after +18.20% in 24 hours brought 8.80 into focus. I need the first pullback to stop there before 10.00 becomes more than a number on the chart, because another green candle would not answer the only question I care about.\n\nBelow 8.80, I leave the continuation idea alone.';
    if (stage === 'writer_tension') return 'Not a publishable post.';
    if (stage === 'critic') return 'PASS';
    throw new Error(`unexpected ${stage}`);
  } });

  const result = await pipeline.generate({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });
  assert.equal(result.status, 'ready');
  assert.equal(result.audit.traderThought.repaired, true);
  assert.deepEqual(calls, ['planner', 'trader_thought', 'trader_thought_repair', 'writer_reflection', 'writer_tension', 'critic']);
});

test('v4 keeps unpublished technical precision out of private Thought and public Writer prompts', async () => {
  const thoughtPrompt = [];
  const writerPrompts = [];
  const preciseFactPack = {
    ...factPack,
    market: {
      ...factPack.market,
      range24h: { ...factPack.market.range24h, position: 0.88376754 },
      drawdownFromHighPct: -3.27683616,
    },
  };
  const preciseThought = traderThought.replace(
    'MISSED: The first retest says more than the daily percentage.',
    'MISSED: The 0.88376754 range position is an internal detail, not a public fact.',
  );
  const pipeline = new V4EditorialPipeline({ invoke: async ({ stage, user }) => {
    if (stage === 'planner') return 'THESIS: Facts only\nWATCH: 10.00\nINVALIDATION: 8.80';
    if (stage === 'trader_thought') {
      thoughtPrompt.push(user);
      return preciseThought;
    }
    if (stage === 'trader_thought_repair') return preciseThought;
    if (stage === 'writer_reflection' || stage === 'writer_tension') {
      writerPrompts.push(user);
      return stage === 'writer_reflection'
        ? '$ALPHA changed my view because +18.20% over the last 24 hours has carried it to the day high, yet 8.80 is still the nearby line that matters.\n\nI want to see that floor hold on the next pullback. If it does, 10.00 is the next price I am watching.\n\nBelow 8.80, my bullish idea is gone.'
        : '$ALPHA at +18.20% over 24 hours is forcing me to separate the headline from the proof I actually need.\n\nI would trust the continuation only if 8.80 holds, with 10.00 as the next level I want to watch.\n\nA break beneath 8.80 would end that thesis.';
    }
    if (stage === 'critic') return 'PASS';
    throw new Error(`unexpected ${stage}`);
  } });

  const result = await pipeline.generate({ factPack: preciseFactPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: preciseFactPack.numbersAllowed } });

  assert.equal(result.status, 'ready');
  assert.ok(thoughtPrompt.every((prompt) => !prompt.includes('0.88376754') && !prompt.includes('-3.27683616')));
  assert.equal(result.audit.traderThoughtFallback.used, true);
  assert.ok(writerPrompts.every((prompt) => !prompt.includes('0.88376754')));
});

test('v4 draft gate allows only the selected 24h hero claim, not an opportunistic metric dump', () => {
  const result = validateV4Draft(
    '$ALPHA changed my view after +18.20% over 24 hours put 8.80 back in focus. I want that level to hold before I care about 10.00. A 1.2x taker ratio is not part of this public story, and a loss of 8.80 would end my bullish thesis.',
    { factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('unsupported_number'));
});

test('v4 retries both invalid Writer drafts once through a bounded contract repair', async () => {
  const calls = [];
  const pipeline = new V4EditorialPipeline({ invoke: async ({ stage }) => {
    calls.push(stage);
    if (stage === 'planner') return 'THESIS: Facts only\nWATCH: 10.00\nINVALIDATION: 8.80';
    if (stage === 'trader_thought') return traderThought;
    if (stage === 'writer_reflection' || stage === 'writer_tension') return '$ALPHA is up +18.20% in 24 hours. The daily runner needs local reaction support at 8.80 and 10.00 is the watch zone. A break below 8.80 invalidates this read, so the technical structure matters.';
    if (stage === 'writer_contract_repair') return '$ALPHA changed my view because +18.20% over 24 hours put 8.80 back in focus. I need that floor to hold before 10.00 matters to me, because the percentage alone is not enough for me to trust continuation.\n\nIf 8.80 breaks, I step back from that continuation and wait for a different read.';
    if (stage === 'critic') return 'PASS';
    throw new Error(`unexpected ${stage}`);
  } });

  const result = await pipeline.generate({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed }, editorialHistory: [] });
  assert.equal(result.status, 'ready');
  assert.equal(result.audit.contractRepair.validation.ok, true);
  assert.ok(calls.includes('writer_contract_repair'));
});

test('v4 rejects a deeply faded daily runner before it can be dressed up as continuation', async () => {
  const staleFactPack = {
    ...factPack,
    market: { currentPrice: 8, range24h: { high: 12, low: 7, position: 0.2, drawdownFromHighPct: -33.33 }, drawdownFromHighPct: -33.33 },
  };
  const calls = [];
  const pipeline = new V4EditorialPipeline({ invoke: async ({ stage }) => {
    calls.push(stage);
    return 'THESIS: not public copy\nWATCH: 10.00\nINVALIDATION: 8.80';
  } });

  const result = await pipeline.generate({ staleFactPack, factPack: staleFactPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: staleFactPack.numbersAllowed } });
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'STALE_DAILY_RUNNER');
  assert.deepEqual(calls, ['planner']);
});

test('v4 rejects private thought that stays a trade plan after its one private repair', async () => {
  const calls = [];
  const tradePlanThought = traderThought.replace(
    'PREFERRED: I prefer a defended retest before treating 10.00 as live.',
    'PREFERRED: My entry is a defended retest before treating 10.00 as live.',
  );
  const pipeline = new V4EditorialPipeline({ invoke: async ({ stage }) => {
    calls.push(stage);
    if (stage === 'planner') return 'THESIS: Facts only\nWATCH: 10.00\nINVALIDATION: 8.80';
    if (stage === 'trader_thought' || stage === 'trader_thought_repair') return tradePlanThought;
    throw new Error(`Public Writer must not run after private trade-plan language: ${stage}`);
  } });

  const result = await pipeline.generate({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'TRADER_THOUGHT_TRADE_PLAN');
  assert.deepEqual(calls, ['planner', 'trader_thought', 'trader_thought_repair']);
});

test('v4 repairs a private analyst-summary thought once before public writers see it', async () => {
  const calls = [];
  const analystSummary = `INITIAL: The asset is trading near the upper resistance boundary after a substantial price increase.\nCHANGE: High demand places the market near the upper range boundary.\nLEVEL_REASON: Heavy selling pressure is expected at 10.00 while buyers defend 8.80.\nBUYER_SELLER: Active buyers push upward while sellers may overwhelm them at resistance.\nPREFERRED: I prefer price to hold support before treating resistance as meaningful.\nINVALIDATION: A close below 8.80 removes the upward trend.\nNEXT: The asset may consolidate or correct before another attempt.\nMISSED: The daily range position shows the asset is near a local peak.\nCAUTION: Rapid price appreciation can create volatility and sudden reversals.`;
  const pipeline = new V4EditorialPipeline({ invoke: async ({ stage }) => {
    calls.push(stage);
    if (stage === 'planner') return 'THESIS: Facts only\nWATCH: 10.00\nINVALIDATION: 8.80';
    if (stage === 'trader_thought') return analystSummary;
    if (stage === 'trader_thought_repair') return traderThought;
    if (stage === 'writer_reflection') return '$ALPHA changed my view because +18.20% in 24 hours carried price to the day high, but 8.80 is the line I need to see survive before I care about another push.\n\nIf that retest holds, 10.00 is the next place I would reassess. Below 8.80, I stop expecting continuation.';
    if (stage === 'writer_tension') return 'Not a publishable post.';
    if (stage === 'writer_contract_repair') return '$ALPHA made me rethink the daily number after +18.20% in 24 hours. I do not need another green candle here; I need 8.80 to take the first pullback without immediately giving it back, because that is the only response that would make this high feel earned.\n\nIf it does, 10.00 becomes worth revisiting. If 8.80 breaks, I leave the continuation idea alone.';
    if (stage === 'critic') return 'PASS';
    throw new Error(`unexpected ${stage}`);
  } });

  const result = await pipeline.generate({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, ['planner', 'trader_thought', 'trader_thought_repair', 'writer_reflection', 'writer_tension', 'writer_contract_repair', 'critic']);
  assert.equal(result.audit.traderThought.repaired, true);
});

test('v4 skips a public repair that the Critic still judges generic', async () => {
  let criticCalls = 0;
  const validDraft = '$ALPHA changed my view after +18.20% in 24 hours brought the first pullback into focus. I need 8.80 to take that retest without immediately giving it back; otherwise another push means very little to me.\n\nIf 8.80 absorbs the pullback, 10.00 is where I would reassess next. Below 8.80, I stop expecting continuation.';
  const pipeline = new V4EditorialPipeline({ invoke: async ({ stage }) => {
    if (stage === 'planner') return 'THESIS: Facts only\nWATCH: 10.00\nINVALIDATION: 8.80';
    if (stage === 'trader_thought') return traderThought;
    if (stage === 'writer_reflection') return validDraft;
    if (stage === 'writer_tension') return 'Not a publishable post.';
    if (stage === 'repair') return validDraft;
    if (stage === 'critic') {
      criticCalls += 1;
      return 'ISSUE: analyst_voice\nINSTRUCTION: Replace the report-like phrasing with a concrete personal reaction.';
    }
    throw new Error(`unexpected ${stage}`);
  } });

  const result = await pipeline.generate({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'CRITIC_REPAIR_REJECTED');
  assert.equal(criticCalls, 2);
});

test('v4 uses an auditable Fact-Pack Thought fallback only after two generic private thoughts', async () => {
  const calls = [];
  const genericThought = `INITIAL: I expected a strong momentum move near resistance.\nCHANGE: The asset remains near the upper boundary after high demand.\nLEVEL_REASON: The floor at 8.80 needs to hold.\nBUYER_SELLER: Buyers must defend the floor against sellers.\nPREFERRED: I prefer a stable base above the support.\nINVALIDATION: A break below 8.80 ends the upward trend.\nNEXT: I expect sideways movement near resistance.\nMISSED: The daily percentage is large.\nCAUTION: Volatility makes the move uncertain.`;
  const readyDraft = '$ALPHA made me slow down after +18.20% in 24 hours. I need 8.80 to take the first pullback without immediately giving it back; that is where I learn whether late buyers are willing to stay once the easy part has gone.\n\nIf it can, 10.00 is worth another look. If 8.80 breaks, I stop treating this as the live continuation path.';
  const pipeline = new V4EditorialPipeline({ invoke: async ({ stage }) => {
    calls.push(stage);
    if (stage === 'planner') return 'THESIS: Facts only\nWATCH: 10.00\nINVALIDATION: 8.80';
    if (stage === 'trader_thought' || stage === 'trader_thought_repair') return genericThought;
    if (stage === 'writer_reflection') return readyDraft;
    if (stage === 'writer_tension') return 'Not a publishable post.';
    if (stage === 'critic') return 'PASS';
    throw new Error(`unexpected ${stage}`);
  } });

  const result = await pipeline.generate({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });
  assert.equal(result.status, 'ready');
  assert.equal(result.audit.traderThoughtFallback.used, true);
  assert.deepEqual(calls, ['planner', 'trader_thought', 'trader_thought_repair', 'writer_reflection', 'writer_tension', 'critic']);
});

test('v4 uses an honest present-tense first read when no persisted prior thesis exists', async () => {
  const writerPrompts = [];
  const genericThought = `INITIAL: The move is near resistance and momentum looks strong.
CHANGE: The asset remains near the upper boundary after high demand.
LEVEL_REASON: The floor at 8.80 needs to hold.
BUYER_SELLER: Buyers must defend the floor against sellers.
PREFERRED: I prefer a stable base above the support.
INVALIDATION: A break below 8.80 ends the upward trend.
NEXT: I expect sideways movement near resistance.
MISSED: The daily percentage is large.
CAUTION: Volatility makes the move uncertain.`;
  const readyDraft = '$ALPHA made me slow down after +18.20% in 24 hours. I need 8.80 to take the first pullback without immediately giving it back; that is where I learn whether late buyers are willing to stay once the easy part has gone.\n\nIf it can, 10.00 is worth another look. If 8.80 breaks, I stop treating this as the live continuation path.';
  const pipeline = new V4EditorialPipeline({ invoke: async ({ stage, user }) => {
    if (stage === 'planner') return 'THESIS: Facts only\nWATCH: 10.00\nINVALIDATION: 8.80';
    if (stage === 'trader_thought' || stage === 'trader_thought_repair') return genericThought;
    if (stage === 'writer_reflection' || stage === 'writer_tension') {
      writerPrompts.push(user);
      return stage === 'writer_reflection' ? readyDraft : 'Not a publishable post.';
    }
    if (stage === 'critic') return 'PASS';
    throw new Error(`unexpected ${stage}`);
  } });

  const result = await pipeline.generate({ factPack, candidate: { token: 'ALPHA', cashtag: '$ALPHA', claimsAllowed: factPack.numbersAllowed } });

  assert.equal(result.status, 'ready');
  assert.ok(writerPrompts.every((prompt) => prompt.includes('Earlier view: My first read')));
  assert.ok(writerPrompts.every((prompt) => !prompt.includes('start from a prior expectation')));
});
