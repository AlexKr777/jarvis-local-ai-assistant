const METRICS = Object.freeze([
  ['absReturn5mPct', 'medianAbsReturn5mPct'],
  ['absReturn15mPct', 'medianAbsReturn15mPct'],
  ['absReturn1hPct', 'medianAbsReturn1hPct'],
  ['absReturn2hPct', 'medianAbsReturn2hPct'],
  ['absReturn4hPct', 'medianAbsReturn4hPct'],
  ['absReturn24hPct', 'medianAbsReturn24hPct'],
  ['volume5mUsd', 'medianVolume5mUsd'],
  ['volume15mUsd', 'medianVolume15mUsd'],
  ['volume1hUsd', 'medianVolume1hUsd'],
  ['liquidationUsd', 'medianLiquidationUsd'],
  ['spreadPct', 'medianSpreadPct'],
]);

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export class RollingBaseline {
  constructor({ windowMs = 24 * 60 * 60_000, maxSamples = 2_000 } = {}) {
    this.windowMs = windowMs;
    this.maxSamples = maxSamples;
    this.samples = new Map();
  }

  add(symbol, sample) {
    if (!symbol || !Number.isFinite(sample?.occurredAt)) throw new TypeError('A symbol and numeric occurredAt are required.');
    const items = this.samples.get(symbol) || [];
    items.push({ ...sample });
    const cutoff = sample.occurredAt - this.windowMs;
    const retained = items.filter((item) => item.occurredAt >= cutoff).slice(-this.maxSamples);
    this.samples.set(symbol, retained);
  }

  summary(symbol, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const retained = (this.samples.get(symbol) || []).filter((item) => item.occurredAt >= cutoff);
    this.samples.set(symbol, retained);
    const result = { sampleCount: retained.length };
    for (const [source, target] of METRICS) result[target] = median(retained.map((item) => item[source]));
    if (retained.length > 1) {
      result.sampleHours = (retained.at(-1).occurredAt - retained[0].occurredAt) / 3_600_000;
    } else {
      result.sampleHours = 0;
    }
    return result;
  }

  snapshot() {
    return Object.fromEntries([...this.samples].map(([symbol, samples]) => [symbol, samples.slice(-this.maxSamples)]));
  }

  restore(snapshot = {}) {
    this.samples = new Map(Object.entries(snapshot).map(([symbol, samples]) => [symbol,
      (Array.isArray(samples) ? samples : [])
        .filter((sample) => Number.isFinite(sample?.occurredAt))
        .sort((left, right) => left.occurredAt - right.occurredAt)
        .slice(-this.maxSamples),
    ]));
  }
}
