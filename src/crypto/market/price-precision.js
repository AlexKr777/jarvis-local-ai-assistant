function legacyDecimals(value) {
  const absolute = Math.abs(Number(value));
  if (absolute >= 1_000) return 0;
  if (absolute >= 1) return 2;
  if (absolute >= 0.01) return 4;
  return 6;
}

export function tickSizeDecimals(tickSize) {
  const tick = Number(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return null;
  for (let decimals = 0; decimals <= 12; decimals += 1) {
    const scaled = tick * (10 ** decimals);
    if (Math.abs(scaled - Math.round(scaled)) <= 1e-9) return decimals;
  }
  return null;
}

// Public prices are rendered from the already tick-normalized final level.
// The fallback is retained only for legacy inputs that lack exchange metadata.
export function formatPublicPrice(value, tickSize = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return number.toFixed(tickSizeDecimals(tickSize) ?? legacyDecimals(number));
}
