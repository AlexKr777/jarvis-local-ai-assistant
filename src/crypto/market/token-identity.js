const ASSET_CODE = /^[A-Z][A-Z0-9]{1,11}$/;

function normalizedAsset(value) {
  const asset = String(value || '').trim().toUpperCase();
  return ASSET_CODE.test(asset) ? asset : null;
}

export function canonicalMarketIdentity({ symbol, baseAsset, quoteAsset } = {}) {
  const base = normalizedAsset(baseAsset);
  if (!base) return null;
  const quote = normalizedAsset(quoteAsset);
  return {
    symbol: String(symbol || '').trim().toUpperCase(),
    baseAsset: base,
    quoteAsset: quote,
    cashtag: `$${base}`,
  };
}

export function canonicalPublicCashtag(candidate = {}) {
  const fromExchange = canonicalMarketIdentity(candidate)?.cashtag;
  if (fromExchange) return fromExchange;
  const legacy = String(candidate.cashtag || '').trim().toUpperCase();
  return /^\$[A-Z][A-Z0-9]{1,11}$/.test(legacy) ? legacy : null;
}
