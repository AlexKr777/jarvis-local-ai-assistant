function returnPct(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function sumLast(candles, count, key) {
  if (candles.length < count) return null;
  return candles.slice(-count).reduce((sum, candle) => sum + Number(candle[key] || 0), 0);
}

function referenceClose(candles, minutes) {
  if (candles.length < minutes + 1) return null;
  return candles.at(-(minutes + 1))?.close;
}

export function deriveWindowMetrics(candles) {
  if (!Array.isArray(candles) || candles.length < 2) throw new TypeError('At least two normalized candles are required.');
  const close = candles.at(-1).close;
  const return5mPct = returnPct(close, referenceClose(candles, 5));
  const return15mPct = returnPct(close, referenceClose(candles, 15));
  const return60mPct = returnPct(close, referenceClose(candles, 60));
  const return1hPct = return60mPct;
  const return2hPct = returnPct(close, referenceClose(candles, 120));
  const return4hPct = returnPct(close, referenceClose(candles, 240));
  const return24hPct = returnPct(close, referenceClose(candles, 1_440));
  return {
    close,
    return5mPct,
    return15mPct,
    return60mPct,
    return1hPct,
    return2hPct,
    return4hPct,
    return24hPct,
    volume5mUsd: sumLast(candles, 5, 'quoteVolume'),
    volume15mUsd: sumLast(candles, 15, 'quoteVolume'),
    volume1hUsd: sumLast(candles, 60, 'quoteVolume'),
    volume2hUsd: sumLast(candles, 120, 'quoteVolume'),
    volume4hUsd: sumLast(candles, 240, 'quoteVolume'),
    volume24hUsd: sumLast(candles, 1_440, 'quoteVolume'),
    direction: return5mPct > 0 ? 'up' : return5mPct < 0 ? 'down' : 'flat',
    candles: candles.map((candle) => ({ ...candle })),
  };
}
