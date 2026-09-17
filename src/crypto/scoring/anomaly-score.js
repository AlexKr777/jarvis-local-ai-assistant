function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

export const BASE_PUBLICATION_SCORE = 75;

function stepped(value, steps) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (value >= steps[index][0]) return steps[index][1];
  }
  return 0;
}

export function scoreThresholdForSlots(slotsUsed, { maxPosts24h = 10 } = {}) {
  if (slotsUsed >= maxPosts24h) return Infinity;
  return BASE_PUBLICATION_SCORE;
}

export function scoreTier(score, thresholds = { S: 92, A: 82, B: 72 }) {
  const value = Number(score || 0);
  if (value >= Number(thresholds.S || 92)) return 'S';
  if (value >= Number(thresholds.A || 82)) return 'A';
  if (value >= Number(thresholds.B || 72)) return 'B';
  return 'WATCH';
}

export function scoreCandidate(candidate) {
  const price = stepped(candidate.priceSurprise, [[2, 5], [3, 12], [5, 20], [8, 25]]);
  const volume = stepped(candidate.volumeSurprise, [[2, 4], [3, 8], [5, 15], [8, 20]]);
  const derivatives = Math.round(clamp(candidate.derivativesStrength, 0, 1) * 20);
  const crossMarket = Math.round(clamp(candidate.crossMarketStrength, 0, 1) * 10);
  const quoteVolume = Number(candidate.quoteVolumeUsd || 0);
  const spread = Number(candidate.spreadPct ?? Infinity);
  let tradability = 0;
  if (quoteVolume >= 50_000_000 && spread <= 0.1) tradability = 10;
  else if (quoteVolume >= 20_000_000 && spread <= 0.25) tradability = 8;
  else if (quoteVolume >= 10_000_000 && spread <= 0.6) tradability = 6;
  const ageMinutes = Math.max(0, Number(candidate.ageMinutes || 0));
  const freshness = ageMinutes <= 45 ? 8 : 0;
  const story = Math.round(clamp(candidate.storyStrength, 0, 1) * 7);
  const breadth = clamp(candidate.broadMarketShare, 0, 1);
  const broadMarketPenalty = breadth <= 0.4 ? 0 : Math.round(((breadth - 0.4) / 0.6) * 10);
  const agePenalty = ageMinutes <= 15 ? 0 : Math.min(6, Math.floor((ageMinutes - 15) / 5));
  const totalPenalty = broadMarketPenalty + agePenalty + (candidate.repeatedHook ? 5 : 0);
  const penalties = totalPenalty === 0 ? 0 : -totalPenalty;
  const components = { price, volume, derivatives, crossMarket, tradability, freshness, story, penalties };
  const score = Math.round(clamp(Object.values(components).reduce((sum, value) => sum + value, 0), 0, 100));
  return { score, tier: scoreTier(score, candidate.tierThresholds), components, expired: ageMinutes > 45 };
}
