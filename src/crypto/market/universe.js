const STABLE_BASES = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD']);
const AMBIGUOUS_SUFFIXES = ['UP', 'DOWN', 'BULL', 'BEAR'];

function cleanBaseAsset(baseAsset) {
  return /^[A-Z][A-Z0-9]{1,11}$/.test(baseAsset || '')
    && !STABLE_BASES.has(baseAsset)
    && !AMBIGUOUS_SUFFIXES.some((suffix) => baseAsset.endsWith(suffix));
}

function priceTickSize(symbol = {}) {
  const filter = (symbol.filters || []).find((item) => item?.filterType === 'PRICE_FILTER');
  const tick = Number(filter?.tickSize);
  return Number.isFinite(tick) && tick > 0 ? tick : null;
}

export function buildUniverse(exchangeInfo, tickers = [], options = {}) {
  const now = options.now ?? Date.now();
  const baselineHours = options.baselineHoursBySymbol || {};
  const tickerFacts = new Map(tickers.map((ticker) => [ticker.symbol, {
    quoteVolumeUsd: Number(ticker.quoteVolume || 0),
    priceChange24hPct: Number(ticker.priceChangePercent),
    lastPrice: Number(ticker.lastPrice),
    highPrice: Number(ticker.highPrice),
    lowPrice: Number(ticker.lowPrice),
  }]));
  return (exchangeInfo?.symbols || [])
    .filter((symbol) => symbol.status === 'TRADING')
    .filter((symbol) => symbol.contractType === 'PERPETUAL')
    .filter((symbol) => ['USDT', 'USDC'].includes(symbol.quoteAsset))
    .filter((symbol) => cleanBaseAsset(symbol.baseAsset))
    .map((symbol) => {
      const ticker = tickerFacts.get(symbol.symbol) || {};
      const tickSize = priceTickSize(symbol);
      const quoteVolumeUsd = ticker.quoteVolumeUsd || 0;
      const observedHours = Number(baselineHours[symbol.symbol] || 0);
      let reason = null;
      if (observedHours < 6 || now - Number(symbol.onboardDate || 0) < 6 * 3_600_000) reason = 'baseline_under_6h';
      else if (quoteVolumeUsd < 10_000_000) reason = 'quote_volume_under_10m';
      return {
        symbol: symbol.symbol,
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        ...(tickSize !== null ? { tickSize } : {}),
        cashtag: `$${symbol.baseAsset}`,
        onboardDate: Number(symbol.onboardDate || 0),
        quoteVolumeUsd,
        ...(Number.isFinite(ticker.priceChange24hPct) ? { priceChange24hPct: ticker.priceChange24hPct } : {}),
        ...(Number.isFinite(ticker.lastPrice) ? { lastPrice: ticker.lastPrice } : {}),
        ...(Number.isFinite(ticker.highPrice) ? { highPrice: ticker.highPrice } : {}),
        ...(Number.isFinite(ticker.lowPrice) ? { lowPrice: ticker.lowPrice } : {}),
        baselineHours: observedHours,
        autoEligible: reason === null,
        reason,
      };
    });
}
