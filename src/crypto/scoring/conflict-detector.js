export function detectConflict({ hypotheses = [] } = {}) {
  const ranked = hypotheses
    .filter((item) => item && typeof item.id === 'string' && Number.isFinite(item.support))
    .sort((left, right) => right.support - left.support)
    .slice(0, 2);
  const confidence = ranked.length === 0 ? 0 : Math.round(ranked[0].support * 100) / 100;
  if (ranked.length < 2 || confidence < 0.82) {
    return { allowed: false, confidence, verdictStyle: 'none', options: [] };
  }
  return {
    allowed: true,
    confidence,
    verdictStyle: confidence >= 0.9 ? 'hard' : 'calibrated',
    options: ranked.map((item) => item.id),
  };
}
