function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function deriveMarketRelationship(candidate = {}) {
  const price = finite(candidate.metrics?.return15mPct ?? candidate.metrics?.return5mPct);
  const openInterest = finite(candidate.openInterestChangePct);
  if (price === null || openInterest === null || price === 0 || openInterest === 0) return null;
  if (price < 0 && openInterest > 0) return 'price_down_oi_up';
  if (price > 0 && openInterest < 0) return 'price_up_oi_down';
  if (price > 0 && openInterest > 0) return 'price_up_oi_up';
  return 'price_down_oi_down';
}
