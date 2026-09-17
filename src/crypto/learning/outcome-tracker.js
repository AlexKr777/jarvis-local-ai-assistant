const HORIZONS = Object.freeze([
  ['15m', 15 * 60_000],
  ['1h', 60 * 60_000],
  ['4h', 4 * 60 * 60_000],
]);

export function dueOutcomeHorizons(post, now = Date.now()) {
  return HORIZONS
    .filter(([name, delay]) => now - post.publishedAt >= delay && !post.outcomes?.[name])
    .map(([name]) => name);
}

export function measureOutcome(post, price, horizon, measuredAt = Date.now()) {
  const entry = Number(post.entryPrice);
  const current = Number(price);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(current) || current <= 0) {
    throw new TypeError('Finite positive outcome prices are required.');
  }
  const returnPct = ((current - entry) / entry) * 100;
  const expectedDirection = post.expectedDirection;
  const directionCorrect = expectedDirection === 'flat'
    ? Math.abs(returnPct) < 0.25
    : expectedDirection === 'up' ? returnPct > 0 : returnPct < 0;
  return { horizon, measuredAt, price: current, returnPct, directionCorrect };
}
