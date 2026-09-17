import { formatPublicPrice } from '../market/price-precision.js';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

function quotePrice(value, tickSize = null) {
  const rendered = formatPublicPrice(value, tickSize);
  return rendered === '--' ? null : rendered;
}

function legacyMap(factPack) {
  const supports = factPack?.levels?.supports || [];
  const resistances = factPack?.levels?.resistances || [];
  const reaction = supports[0] || null;
  const invalidation = supports[1] || reaction;
  const watch = resistances[0] || null;
  return {
    valid: Boolean(reaction && invalidation && watch),
    compatibilityOnly: true,
    heroEvent: (factPack?.technicalEvents || [])[0] || null,
    firstReactionZone: reaction && { role: 'first_reaction_zone', levelId: reaction.id, midpoint: reaction.midpoint, why: 'Deterministic nearest support from the legacy Fact Pack.' },
    structuralInvalidation: invalidation && { role: 'structural_invalidation', levelId: invalidation.id, midpoint: invalidation.midpoint, why: 'Deterministic lower support from the legacy Fact Pack.' },
    nextWatch: watch && { role: 'next_watch', levelId: watch.id, midpoint: watch.midpoint, why: 'Deterministic resistance from the legacy Fact Pack.' },
    relevantEvents: factPack?.technicalEvents || [],
    marketStructure: factPack?.technicalEvidence?.structure || {},
  };
}

function storyFamily(map, market) {
  if (map.heroEvent?.kind === 'resistance_rejection') return 'rejection_at_level';
  if (map.heroEvent?.kind === 'breakout' || map.heroEvent?.kind === 'acceptance') return 'breakout_retest';
  if (Number(market?.range24h?.position) >= 0.8) return 'pressure_near_high';
  return 'retest_continuation';
}

function technicalReasoning(map, reaction, invalidation, watch) {
  const primary = map.marketStructure?.['1h'] || map.marketStructure?.['15m'] || {};
  const behaviour = map.marketBehaviour || {};
  const structure = primary.direction === 'up' ? 'higher-high / higher-low behaviour'
    : primary.direction === 'down' ? 'lower-high / lower-low behaviour'
      : primary.phase === 'consolidation' ? 'a compressed local range' : 'mixed local structure';
  const response = reaction?.side === 'support'
    ? 'buyers need to absorb a retest and close back above the reaction area'
    : 'sellers need to reject an attempted reclaim and close back below the reaction area';
  const nextCondition = watch?.side === 'resistance'
    ? 'only an accepted approach into the upper boundary keeps that boundary relevant'
    : 'only a held response above the lower boundary keeps that boundary relevant';
  return freeze({
    observedStructure: structure,
    primaryTimeframe: primary.timeframe || null,
    primaryPhase: primary.phase || 'insufficient_data',
    momentumState: behaviour.momentum?.state || 'insufficient_data',
    volumeState: behaviour.volume?.trend || 'insufficient_data',
    takerFlowBias: behaviour.takerFlow?.bias || 'unavailable',
    firstReactionMeaning: reaction ? `${reaction.why} The required observable response is that ${response}.` : null,
    invalidationMeaning: invalidation ? `${invalidation.why} It is not the first reaction: it is the structural line that ends this scenario.` : null,
    nextWatchMeaning: watch ? `${watch.why} ${nextCondition}.` : null,
  });
}

export function buildStoryBrief(factPack = {}) {
  const map = factPack.traderEvidenceMap || legacyMap(factPack);
  const reaction = map.firstReactionZone || null;
  const invalidation = map.structuralInvalidation || null;
  const watch = map.nextWatch || null;
  const reactionPrice = quotePrice(reaction?.midpoint, reaction?.tickSize);
  const invalidationPrice = quotePrice(invalidation?.midpoint, invalidation?.tickSize);
  const watchPrice = quotePrice(watch?.midpoint, watch?.tickSize);
  const validRoles = Boolean(reaction && invalidation && watch
    && reaction.levelId !== invalidation.levelId
    && reaction.levelId !== watch.levelId
    && invalidation.levelId !== watch.levelId);
  const family = storyFamily(map, factPack.market);
  const reasoning = technicalReasoning(map, reaction, invalidation, watch);
  const technicalThesis = reactionPrice && watchPrice
    ? `${reasoning.observedStructure} only remains constructive if ${reactionPrice} changes from a first reaction into a defended response; ${watchPrice} matters only after that condition is met.`
    : 'The available deterministic evidence does not support a complete technical thesis.';
  const preferredScenario = reactionPrice && watchPrice
    ? `Prefer a retest that holds at ${reactionPrice}; only then does an attempt toward ${watchPrice} fit the supplied structure.`
    : null;
  const expectedNextMove = reactionPrice && watchPrice
    ? `Expect either a first reaction around ${reactionPrice}, or an attempted move into ${watchPrice} only after that zone is defended.`
    : null;
  const alternativeScenario = invalidationPrice
    ? `A sustained loss below ${invalidationPrice} removes the present continuation structure rather than merely failing the first reaction.`
    : null;
  return freeze({
    valid: map.valid === true && validRoles,
    reason: map.valid !== true ? (map.reason || 'INVALID_TRADER_EVIDENCE_MAP') : !validRoles ? 'LEVEL_ROLE_MISMATCH' : null,
    storyFamily: family,
    heroEvent: map.heroEvent || null,
    technicalThesis,
    preferredScenario,
    expectedNextMove,
    alternativeScenario,
    firstReactionZone: reaction,
    structuralInvalidation: invalidation,
    nextWatch: watch,
    marketStructure: map.marketStructure || {},
    relevantEvents: map.relevantEvents || [],
    technicalReasoning: reasoning,
    selectedEvidenceIds: [...new Set([
      ...(map.selectedEvidenceIds || []),
      reaction?.levelId,
      invalidation?.levelId,
      watch?.levelId,
    ].filter(Boolean))],
    omittedEvidenceIds: map.omittedEvidenceIds || [],
  });
}
