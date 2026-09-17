function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

function validLevel(level) {
  return typeof level?.id === 'string'
    && ['support', 'resistance'].includes(level.side)
    && Number.isFinite(Number(level.midpoint))
    && Array.isArray(level.evidence)
    && level.evidence.length > 0;
}

export function buildFactPack({ candidate = {}, technicalContext = {}, research = {}, priorTokenState = null } = {}) {
  const publicLevels = [...(technicalContext?.levels?.supports || []), ...(technicalContext?.levels?.resistances || [])]
    .filter((level) => (technicalContext.publicLevelIds || []).includes(level.id));
  if (publicLevels.some((level) => !validLevel(level))) return { ok: false, reason: 'FACT_PACK_INVALID_LEVEL_EVIDENCE' };
  const claims = Array.isArray(candidate.claimsAllowed) ? candidate.claimsAllowed : [];
  if (!candidate.symbol || !candidate.cashtag || claims.some((claim) => !claim?.key || !claim?.display)) {
    return { ok: false, reason: 'FACT_PACK_INVALID_MARKET_FACTS' };
  }
  const factsById = Object.fromEntries([
    ...claims.map((claim) => [`claim:${claim.key}`, freeze({ ...claim, id: `claim:${claim.key}`, kind: 'market_claim' })]),
    ...publicLevels.map((level) => [level.id, freeze({ ...level, kind: 'technical_level' })]),
    ...(technicalContext?.market?.range24h ? [[technicalContext.market.range24h.id, freeze({ ...technicalContext.market.range24h, kind: 'market_range' })]] : []),
  ]);
  const dayClaim = claims.find((claim) => claim.key === 'return24h');
  const derivativeClaims = Object.fromEntries(claims
    .filter((claim) => ['openInterestChange', 'takerBuySellRatio', 'fundingRate'].includes(claim.key))
    .map((claim) => [claim.key, freeze({ ...claim })]));
  // A derivative value may exist on the candidate while its time series was
  // rejected upstream. Preserve that distinction at the editorial boundary.
  const derivativeEvidence = candidate.derivativesEvidence || {};
  const derivatives = freeze({
    openInterest: freeze({ accepted: derivativeEvidence?.openInterest?.ok === true, claim: derivativeEvidence?.openInterest?.ok === true ? derivativeClaims.openInterestChange || null : null }),
    takerRatio: freeze({ accepted: derivativeEvidence?.takerRatio?.ok === true, claim: derivativeEvidence?.takerRatio?.ok === true ? derivativeClaims.takerBuySellRatio || null : null }),
    // Funding is deliberately a snapshot: no history is represented here.
    funding: freeze({ accepted: Boolean(derivativeClaims.fundingRate), claim: derivativeClaims.fundingRate || null, snapshot: true }),
  });
  const range = technicalContext?.market?.range24h || null;
  const traderEvidenceMap = buildTraderEvidenceMap({
    technicalContext,
    publicLevels,
    ranking: { change24h: dayClaim?.display || candidate.priceChange24hPct || null },
  });
  const factPack = freeze({
    eventId: candidate.id || null,
    generatedAt: Date.now(),
    identity: { symbol: candidate.symbol, cashtag: candidate.cashtag, market: 'Binance USD-M perpetual' },
    ranking: { top10Rank: Number.isInteger(candidate.top10Rank) ? candidate.top10Rank : null, change24h: dayClaim?.display || candidate.priceChange24hPct || null },
    market: {
      currentPrice: Number(candidate.metrics?.close ?? range?.currentPrice),
      range24h: range,
      drawdownFromHighPct: technicalContext?.market?.drawdownFromHighPct ?? null,
      distanceFrom24hLowPct: technicalContext?.market?.distanceFrom24hLowPct ?? null,
      volatility: technicalContext?.market?.volatility || {},
    },
    levels: { supports: publicLevels.filter((level) => level.side === 'support'), resistances: publicLevels.filter((level) => level.side === 'resistance') },
    technicalEvidence: {
      structure: technicalContext?.evidence?.structure || {},
      roles: technicalContext?.evidence?.roles || {},
      zones: publicLevels,
      momentum: technicalContext?.evidence?.momentum || {},
      volume: technicalContext?.evidence?.volume || {},
      takerFlow: technicalContext?.evidence?.takerFlow || {},
    },
    traderEvidenceMap,
    technicalEvents: technicalContext?.technicalEvents || [],
    derivatives,
    // Persisted only for audit/review. Stable depth clusters are not levels,
    // not allowed numbers, and therefore cannot be invented into copy.
    marketEvidence: { stableOrderBookClusters: candidate.orderBookEvidence || [] },
    research: { status: research.status || 'none_found', sources: research.sources || [], claims: research.claims || [], cleanCatalystFound: research.cleanCatalystFound === true },
    priorTokenState,
    factsById,
    numbersAllowed: claims.map((claim) => freeze({ ...claim })),
    publicBoundaries: { canSayPriorExpectation: Boolean(priorTokenState?.expectedScenario), canUseCausalLanguage: false, canSayTarget: false },
    chartInputs: { candles: candidate.metrics?.chartCandles || {}, volumes: candidate.metrics?.candles || [], eventMarkers: [] },
  });
  return { ok: true, factPack };
}

export function getAllowedFact(factPack, id) {
  return factPack?.factsById?.[id] || null;
}
import { buildTraderEvidenceMap } from './trader-evidence-map.js';
