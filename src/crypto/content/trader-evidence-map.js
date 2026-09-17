function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

function roleWithLevel(role, levelsById) {
  if (!role?.role || !role?.levelId) return null;
  const level = levelsById[role.levelId];
  if (!level) return null;
  return freeze({
    role: role.role,
    levelId: level.id,
    side: level.side,
    priceLow: level.priceLow,
    priceHigh: level.priceHigh,
    midpoint: level.midpoint,
    tickSize: level.tickSize ?? null,
    why: String(role.why || '').trim(),
    evidence: level.evidence,
  });
}

function distinctRoles(roles) {
  const values = [roles.firstReactionZone, roles.structuralInvalidation, roles.nextWatch].filter(Boolean);
  return new Set(values.map((role) => role.levelId)).size === values.length;
}

export function buildTraderEvidenceMap({ technicalContext = {}, publicLevels = [], ranking = {} } = {}) {
  const levelsById = Object.fromEntries(publicLevels.map((level) => [level.id, level]));
  const sourceRoles = technicalContext?.evidence?.roles || {};
  const roles = {
    firstReactionZone: roleWithLevel(sourceRoles.firstReactionZone, levelsById),
    structuralInvalidation: roleWithLevel(sourceRoles.structuralInvalidation, levelsById),
    nextWatch: roleWithLevel(sourceRoles.nextWatch, levelsById),
  };
  const usableRoles = Object.values(roles).every(Boolean) && distinctRoles(roles);
  const events = (technicalContext.technicalEvents || []).map((event) => freeze({ ...event }));
  const structure = technicalContext?.evidence?.structure || {};
  const primaryEvent = events.find((event) => ['resistance_rejection', 'breakout', 'acceptance', 'support_retest', 'daily_runner', 'daily_drawdown'].includes(event.kind)) || null;
  return freeze({
    valid: usableRoles,
    reason: usableRoles ? null : 'INCOMPLETE_OR_COLLIDING_LEVEL_ROLES',
    heroEvent: primaryEvent,
    firstReactionZone: roles.firstReactionZone,
    structuralInvalidation: roles.structuralInvalidation,
    nextWatch: roles.nextWatch,
    marketStructure: structure,
    marketBehaviour: freeze({
      momentum: technicalContext?.evidence?.momentum || {},
      volume: technicalContext?.evidence?.volume || {},
      takerFlow: technicalContext?.evidence?.takerFlow || {},
      volatility: technicalContext?.market?.volatility || {},
    }),
    relevantEvents: events,
    selectedEvidenceIds: [
      primaryEvent?.id,
      roles.firstReactionZone?.levelId,
      roles.structuralInvalidation?.levelId,
      roles.nextWatch?.levelId,
      'market:24h-range',
      ranking.change24h ? 'claim:return24h' : null,
    ].filter(Boolean),
    omittedEvidenceIds: publicLevels
      .map((level) => level.id)
      .filter((id) => ![roles.firstReactionZone?.levelId, roles.structuralInvalidation?.levelId, roles.nextWatch?.levelId].includes(id)),
  });
}
