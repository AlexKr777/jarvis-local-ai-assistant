import { deriveWindowMetrics } from './window-metrics.js';
import { evaluatePreliminaryTrigger } from './triggers.js';

export class MarketScanner {
  constructor({ client, baseline, deepAnalyzer, marketCache = new Map(), tierThresholds = undefined }) {
    this.client = client;
    this.baseline = baseline;
    this.deepAnalyzer = deepAnalyzer;
    this.marketCache = marketCache;
    this.tierThresholds = tierThresholds;
  }

  async evaluateSnapshot(universeItem, now = Date.now()) {
    const market = universeItem.market || this.marketCache.get(universeItem.symbol) || {};
    const candles = Array.isArray(market.samples) ? market.samples : [];
    if (candles.length < 16) return null;
    const metrics = deriveWindowMetrics(candles);
    const sample = {
      occurredAt: now,
      absReturn5mPct: Math.abs(metrics.return5mPct),
      absReturn15mPct: Math.abs(metrics.return15mPct),
      absReturn1hPct: Math.abs(metrics.return1hPct),
      absReturn2hPct: Math.abs(metrics.return2hPct),
      absReturn4hPct: Math.abs(metrics.return4hPct),
      absReturn24hPct: Math.abs(metrics.return24hPct),
      volume5mUsd: metrics.volume5mUsd,
      volume15mUsd: metrics.volume15mUsd,
      volume1hUsd: metrics.volume1hUsd,
      liquidationUsd: Number(market.liquidationUsd || 0),
      spreadPct: Number(market.spreadPct ?? universeItem.spreadPct ?? 0),
    };
    const baseline = this.baseline.summary(universeItem.symbol, now);
    const preliminary = evaluatePreliminaryTrigger({ ...metrics, liquidationUsd: sample.liquidationUsd, spreadPct: sample.spreadPct }, baseline);
    this.baseline.add(universeItem.symbol, sample);
    if (!preliminary.triggered) return null;
    return this.deepAnalyzer.analyze({ ...universeItem, metrics, market }, preliminary, now, { tierThresholds: this.tierThresholds });
  }

  // The live runner feed is deliberately selected by the exchange's 24-hour
  // ranking.  It still obtains the full verified data package below, but must
  // not wait for a local baseline or a 5/15-minute anomaly trigger.
  async evaluateTopRunner(universeItem, now = Date.now()) {
    const market = universeItem.market || this.marketCache.get(universeItem.symbol) || {};
    return this.deepAnalyzer.analyze({ ...universeItem, market }, {
      triggered: true,
      reasons: ['top_24h_runner'],
      ratios: {},
    }, now, { tierThresholds: this.tierThresholds, topRunnerMode: true });
  }

  async evaluateSymbol(universeItem, now = Date.now()) {
    const candles = await this.client.getKlines(universeItem.symbol, '1m', 61);
    const metrics = deriveWindowMetrics(candles);
    const cached = this.marketCache.get(universeItem.symbol) || {};
    const sample = {
      occurredAt: now,
      absReturn5mPct: Math.abs(metrics.return5mPct),
      absReturn15mPct: Math.abs(metrics.return15mPct),
      volume5mUsd: metrics.volume5mUsd,
      volume15mUsd: metrics.volume15mUsd,
      liquidationUsd: Number(cached.liquidationUsd || 0),
      spreadPct: Number(cached.spreadPct ?? universeItem.spreadPct ?? 0),
    };
    const baseline = this.baseline.summary(universeItem.symbol, now);
    const preliminary = evaluatePreliminaryTrigger({
      ...metrics,
      liquidationUsd: sample.liquidationUsd,
      spreadPct: sample.spreadPct,
    }, baseline);
    this.baseline.add(universeItem.symbol, sample);
    if (!preliminary.triggered) return null;
    return this.deepAnalyzer.analyze({ ...universeItem, metrics, market: cached }, preliminary, now);
  }
}
