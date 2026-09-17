function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRows(rows, side) {
  return (Array.isArray(rows) ? rows : [])
    .map(([price, quantity]) => ({ price: finite(price), quantity: finite(quantity), side }))
    .filter((row) => row.price !== null && row.quantity !== null && row.quantity > 0);
}

function bucketKey(price, currentPrice) {
  // A relative bucket keeps a $0.01 asset and a $100 asset comparable without
  // treating a single raw depth snapshot as a chart level.
  const step = Math.max(Math.abs(currentPrice) * 0.0025, 1e-8);
  return Math.round(price / step) * step;
}

export class OrderBookEvidenceSampler {
  constructor({ maxSnapshots = 8, minimumObservations = 3 } = {}) {
    this.maxSnapshots = maxSnapshots;
    this.minimumObservations = minimumObservations;
    this.bySymbol = new Map();
  }

  record({ symbol, snapshot, currentPrice, observedAt = Date.now() } = {}) {
    if (typeof symbol !== 'string' || !symbol || !snapshot || !Number.isFinite(Number(currentPrice))) return this.stableClusters(symbol);
    const sample = Object.freeze({
      observedAt,
      rows: Object.freeze([
        ...normalizeRows(snapshot.bids, 'bid'),
        ...normalizeRows(snapshot.asks, 'ask'),
      ]),
    });
    const history = this.bySymbol.get(symbol) || [];
    history.push(sample);
    this.bySymbol.set(symbol, history.slice(-this.maxSnapshots));
    return this.stableClusters(symbol, currentPrice);
  }

  stableClusters(symbol, currentPrice = null) {
    const history = this.bySymbol.get(symbol) || [];
    if (history.length < this.minimumObservations) return Object.freeze([]);
    const reference = Number.isFinite(Number(currentPrice)) ? Number(currentPrice)
      : history.at(-1)?.rows?.[0]?.price;
    if (!Number.isFinite(reference)) return Object.freeze([]);
    const buckets = new Map();
    for (const sample of history) {
      const seenInSample = new Set();
      for (const row of sample.rows) {
        const price = bucketKey(row.price, reference);
        const key = `${row.side}:${price}`;
        const bucket = buckets.get(key) || { side: row.side, price, observations: 0, quantities: [], lastObservedAt: sample.observedAt };
        if (!seenInSample.has(key)) {
          bucket.observations += 1;
          seenInSample.add(key);
        }
        bucket.quantities.push(row.quantity);
        bucket.lastObservedAt = sample.observedAt;
        buckets.set(key, bucket);
      }
    }
    return Object.freeze([...buckets.values()]
      .filter((bucket) => bucket.observations >= this.minimumObservations)
      .map((bucket) => Object.freeze({
        id: `depth:${bucket.side}:${bucket.price.toPrecision(10)}`,
        side: bucket.side,
        price: bucket.price,
        observations: bucket.observations,
        persistence: bucket.observations / history.length,
        medianQuantity: bucket.quantities.sort((a, b) => a - b)[Math.floor(bucket.quantities.length / 2)],
        lastObservedAt: bucket.lastObservedAt,
      }))
      .sort((left, right) => right.persistence - left.persistence || right.medianQuantity - left.medianQuantity));
  }
}
