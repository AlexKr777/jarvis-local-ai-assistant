export const DEFAULT_RESEARCH_POLICY = Object.freeze({
  extreme24hPct: 20,
  extreme4hPct: 12,
  extremeHumanShock: 8,
  extremeRelativeShock: 8,
});

function absolute(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.abs(number) : 0;
}

export function mandatoryResearchDecision(candidate = {}, policy = DEFAULT_RESEARCH_POLICY) {
  const metrics = candidate.metrics || {};
  const humanShock = candidate.humanShock ?? candidate.preliminary?.ratios?.priceSurprise15m;
  const relativeShock = candidate.relativeShock ?? candidate.preliminary?.ratios?.priceSurprise1h;
  if (candidate.tier === 'S') return { required: true, reason: 'S_TIER' };
  if (absolute(humanShock) >= policy.extremeHumanShock) return { required: true, reason: 'extreme_human_shock' };
  if (absolute(relativeShock) >= policy.extremeRelativeShock) return { required: true, reason: 'extreme_relative_shock' };
  if (absolute(metrics.return24hPct) >= policy.extreme24hPct) return { required: true, reason: 'extreme_24h_move' };
  if (absolute(metrics.return4hPct) >= policy.extreme4hPct) return { required: true, reason: 'extreme_4h_move' };
  return { required: false, reason: null };
}
