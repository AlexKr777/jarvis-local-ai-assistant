import { randomUUID } from 'node:crypto';
import { deriveWindowMetrics } from './window-metrics.js';
import { scoreCandidate } from '../scoring/anomaly-score.js';
import { detectConflict } from '../scoring/conflict-detector.js';
import { canonicalMarketIdentity } from './token-identity.js';
import { analyzeTechnicalContext } from './technical-context.js';
import { OrderBookEvidenceSampler } from './orderbook-evidence.js';

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function closedCandles(candles, now) {
  const byOpenTime = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    const openTime = finite(candle?.openTime);
    const closeTime = finite(candle?.closeTime);
    const open = finite(candle?.open);
    const high = finite(candle?.high);
    const low = finite(candle?.low);
    const close = finite(candle?.close);
    if (open === null || high === null || low === null || close === null || high < low) continue;
    // Test fixtures predating exchange timestamps remain supported. Real
    // Binance klines always carry closeTime, which makes this a fail-closed
    // guard against a still-forming final candle.
    if (closeTime !== null && closeTime > now) continue;
    const key = openTime === null ? `row:${byOpenTime.size}` : String(openTime);
    byOpenTime.set(key, candle);
  }
  return [...byOpenTime.values()].sort((left, right) => Number(left.openTime || 0) - Number(right.openTime || 0));
}

export function validateTimedDerivativeSeries(entries, { valueKey, periodMs, minPoints, now } = {}) {
  const rows = Array.isArray(entries) ? entries.map((entry) => ({
    timestamp: finite(entry?.timestamp), value: finite(entry?.[valueKey]),
  })) : [];
  if (!Number.isFinite(periodMs) || periodMs <= 0 || !Number.isInteger(minPoints) || minPoints < 1) {
    throw new TypeError('Derivative series validation requires a period and minimum point count.');
  }
  if (rows.length < minPoints || rows.some((row) => row.timestamp === null || row.value === null || row.value <= 0)) {
    return { ok: false, reason: 'MALFORMED_DERIVATIVES_EVIDENCE', values: [] };
  }
  rows.sort((left, right) => left.timestamp - right.timestamp);
  if (rows.some((row, index) => index > 0 && row.timestamp === rows[index - 1].timestamp)) {
    return { ok: false, reason: 'DUPLICATE_DERIVATIVES_TIMESTAMP', values: [] };
  }
  if (rows.at(-1).timestamp > now || now - rows.at(-1).timestamp > periodMs * 2) {
    return { ok: false, reason: 'STALE_DERIVATIVES_EVIDENCE', values: [] };
  }
  if (rows.some((row, index) => index > 0 && row.timestamp - rows[index - 1].timestamp > periodMs * 1.5)) {
    return { ok: false, reason: 'DISCONTINUOUS_DERIVATIVES_EVIDENCE', values: [] };
  }
  return { ok: true, reason: null, values: rows.map((row) => row.value), timestamps: rows.map((row) => row.timestamp), latestAt: rows.at(-1).timestamp };
}

function ratioChange(first, last) {
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return null;
  return ((last - first) / first) * 100;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function signed(value, digits) {
  const number = Number(value);
  return `${number >= 0 ? '+' : ''}${number.toFixed(digits)}%`;
}

function multiple(value) {
  return `${Number(value).toFixed(1)}x`;
}

function usd(value) {
  const number = Number(value || 0);
  if (Math.abs(number) >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(number) >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}M`;
  if (Math.abs(number) >= 1_000) return `$${(number / 1_000).toFixed(2)}K`;
  return `$${number.toFixed(2)}`;
}

function freshUpsideImpulsePriority(candles) {
  const recent = Array.isArray(candles) ? candles.slice(-16) : [];
  const visible = Array.isArray(candles) ? candles.slice(-300) : [];
  if (recent.length < 16 || visible.length < 16) return 0;
  const closes = recent.map((candle) => finite(candle?.close));
  if (closes.some((close) => close === null)) return 0;
  const last = recent.at(-1);
  const return15mPct = ratioChange(closes[0], closes.at(-1));
  const return5mPct = ratioChange(closes.at(-6), closes.at(-1));
  const highestRecentPrice = Math.max(...recent.map((candle) => finite(candle?.high) ?? finite(candle?.close)));
  const closesNearRecentHigh = closes.at(-1) >= highestRecentPrice * 0.995;
  const highestVisiblePrice = Math.max(...visible.map((candle) => finite(candle?.high) ?? finite(candle?.close)));
  const closesNearVisibleHigh = closes.at(-1) >= highestVisiblePrice * 0.985;
  return return5mPct >= 1 && return15mPct >= 1.5 && closesNearRecentHigh && closesNearVisibleHigh ? 1 : 0;
}

// A visual admission rule, not a price/volume threshold.  Charts may hide one
// minute of red noise, but only when the preceding green candle is the visible
// right-edge breakout.  A daily gainer already rolling over stays out.
export function topRunnerVisualState(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const last = candles.at(-1);
  const preceding = candles.at(-2);
  const displayIndex = Number(last?.close) >= Number(last?.open)
    ? candles.length - 1
    : Number(preceding?.close) >= Number(preceding?.open) ? candles.length - 2 : -1;
  if (displayIndex >= 1) {
    const display = candles[displayIndex];
    const displayHigh = finite(display?.high) ?? finite(display?.close);
    const previousHighs = candles.slice(Math.max(0, displayIndex - 300), displayIndex)
      .map((candle) => finite(candle?.high) ?? finite(candle?.close))
      .filter(Number.isFinite);
    const rightEdgeRally = Number.isFinite(displayHigh)
      && previousHighs.length > 0
      && displayHigh >= Math.max(...previousHighs)
      && Number(display.close) >= Number(display.open);
    if (rightEdgeRally) return 'rally';
  }

  // A strong leg followed by a contained pullback is still a valid top-runner
  // story, as long as price remains above where that recent leg began.  This
  // is structural chart evidence rather than a 5m/15m percentage threshold.
  const visible = candles.slice(-300);
  const recentStart = Math.max(0, visible.length - 45);
  const recent = visible.slice(recentStart);
  const peakOffset = recent.reduce((best, candle, index) => Number(candle.high) > Number(recent[best].high) ? index : best, 0);
  const peakIndex = recentStart + peakOffset;
  const baselineIndex = Math.max(recentStart, peakIndex - 30);
  const peak = visible[peakIndex];
  const baseline = visible[baselineIndex];
  const current = visible.at(-1);
  const containedPullback = peakIndex < visible.length - 2
    && Number(peak.high) > Number(baseline.close)
    && Number(current.close) < Number(peak.high)
    && Number(current.close) > Number(baseline.close);
  return containedPullback ? 'pullback' : null;
}

export function isTopRunnerChartReady(candles) {
  return topRunnerVisualState(candles) === 'rally';
}

export class DeepMarketAnalyzer {
  constructor({ client, orderBookSampler = new OrderBookEvidenceSampler() } = {}) {
    this.client = client;
    this.orderBookSampler = orderBookSampler;
  }

  async analyze(item, preliminary = {}, now = Date.now(), { tierThresholds = undefined, topRunnerMode = false } = {}) {
    const identity = canonicalMarketIdentity(item);
    if (!identity) throw new Error('Missing authoritative exchange asset identity.');
    const references = item.symbol === 'BTCUSDT' ? ['ETHUSDT'] : ['BTCUSDT', 'ETHUSDT'].filter((symbol) => symbol !== item.symbol);
    const [candles, chart5m, chart15m, chart1h, chart4h, openInterest, takerRatios, premium, referenceCandles, orderBook] = await Promise.all([
      // A 24h claim must be based on a complete 24h minute-candle window,
      // never on the oldest candle in a shorter chart sample.
      this.client.getKlines(item.symbol, '1m', 1_441),
      this.client.getKlines(item.symbol, '5m', 288),
      this.client.getKlines(item.symbol, '15m', 192),
      this.client.getKlines(item.symbol, '1h', 168),
      this.client.getKlines(item.symbol, '4h', 90),
      this.client.getOpenInterestHistory(item.symbol, '5m', 48),
      this.client.getTakerLongShortRatio(item.symbol, '5m', 3),
      this.client.getPremiumIndex(item.symbol),
      Promise.all(references.map((symbol) => this.client.getKlines(symbol, '1m', 61))),
      typeof this.client.getOrderBook === 'function' ? this.client.getOrderBook(item.symbol, 100).catch(() => null) : Promise.resolve(null),
    ]);
    const closedByTimeframe = {
      '1m': closedCandles(candles, now),
      '5m': closedCandles(chart5m, now),
      '15m': closedCandles(chart15m, now),
      '1h': closedCandles(chart1h, now),
      '4h': closedCandles(chart4h, now),
    };
    const closedReferenceCandles = referenceCandles.map((series) => closedCandles(series, now));
    const openInterestEvidence = validateTimedDerivativeSeries(openInterest, {
      valueKey: 'sumOpenInterestValue', periodMs: 5 * 60_000, minPoints: 2, now,
    });
    const takerEvidence = validateTimedDerivativeSeries(takerRatios, {
      valueKey: 'buySellRatio', periodMs: 5 * 60_000, minPoints: 2, now,
    });
    const oiSeries = openInterestEvidence.values;
    const takerBuySellRatio = takerEvidence.ok ? takerEvidence.values.at(-1) : null;
    const fundingRate = finite(premium?.lastFundingRate);
    if (fundingRate === null) throw new Error('Insufficient derivatives data for deep analysis.');
    const metrics = deriveWindowMetrics(closedByTimeframe['1m']);
    // The renderer chooses an honest complete view from these series. 5m is
    // retained for a dense 70–120 candle story when that is the clearest
    // representation; it is never a synthetic cropped impulse window.
    const chartCandles = { '5m': closedByTimeframe['5m'], '15m': closedByTimeframe['15m'], '1h': closedByTimeframe['1h'], '4h': closedByTimeframe['4h'] };
    const lastCandle = closedByTimeframe['1m'].at(-1);
    const technicalContext = analyzeTechnicalContext({
      symbol: identity.symbol,
      candlesByTimeframe: { '5m': chart5m, '15m': chart15m, '1h': chart1h, '4h': chart4h },
      tickSize: item.tickSize ?? item.filters?.find((filter) => filter?.filterType === 'PRICE_FILTER')?.tickSize ?? null,
      ticker: {
        lastPrice: item.lastPrice ?? lastCandle?.close,
        highPrice: item.highPrice ?? Math.max(...closedByTimeframe['1m'].map((candle) => Number(candle.high)).filter(Number.isFinite)),
        lowPrice: item.lowPrice ?? Math.min(...closedByTimeframe['1m'].map((candle) => Number(candle.low)).filter(Number.isFinite)),
        priceChangePercent: item.priceChange24hPct,
      },
      now,
    });
    const stableOrderBookClusters = this.orderBookSampler.record({
      symbol: identity.symbol,
      snapshot: orderBook,
      currentPrice: technicalContext.market.range24h?.currentPrice ?? item.lastPrice,
      observedAt: now,
    });
    const runnerVisualState = topRunnerMode
      ? [metrics.candles, ...Object.values(chartCandles)]
        .map((series) => topRunnerVisualState(series))
        .find(Boolean) || null
      : null;
    if (topRunnerMode && !runnerVisualState) return null;
    const openInterestChangePct = openInterestEvidence.ok ? ratioChange(oiSeries[0], oiSeries.at(-1)) : null;
    const fundingRatePct = fundingRate * 100;
    const referenceMetrics = closedReferenceCandles.map(deriveWindowMetrics);
    const activeReferenceShare = referenceMetrics.length === 0
      ? 0
      : referenceMetrics.filter((reference) => Math.abs(reference.return15mPct) >= 0.8).length / referenceMetrics.length;
    const candidateDirection = metrics.return5mPct > 0 ? 1 : metrics.return5mPct < 0 ? -1 : 0;
    const oiDirection = openInterestChangePct > 0 ? 1 : openInterestChangePct < 0 ? -1 : 0;
    const oiStrength = Number.isFinite(openInterestChangePct) ? clamp(Math.abs(openInterestChangePct) / 4) : 0;
    const takerStrength = Number.isFinite(takerBuySellRatio) ? clamp(Math.abs(takerBuySellRatio - 1) / 0.8) : 0;
    const liquidationStrength = clamp(Number(preliminary.ratios?.liquidationRatio || 0) / 4);
    const derivativesStrength = clamp(oiStrength * 0.5 + takerStrength * 0.25 + liquidationStrength * 0.25);
    const referenceDivergence = referenceMetrics.length === 0
      ? 0
      : referenceMetrics.reduce((sum, reference) => sum + Math.abs(metrics.return15mPct - reference.return15mPct), 0) / referenceMetrics.length;
    const crossMarketStrength = clamp(referenceDivergence / Math.max(1, Math.abs(metrics.return15mPct)));
    const independentSignals = [
      Math.max(preliminary.ratios?.priceSurprise5m || 0, preliminary.ratios?.priceSurprise15m || 0) >= 3,
      Math.max(preliminary.ratios?.volume5mRatio || 0, preliminary.ratios?.volume15mRatio || 0) >= 3,
      oiStrength >= 0.5,
      liquidationStrength >= 1,
    ].filter(Boolean).length;
    const storyStrength = clamp(independentSignals / 3);
    const scored = scoreCandidate({
      priceSurprise: Math.max(preliminary.ratios?.priceSurprise5m || 0, preliminary.ratios?.priceSurprise15m || 0, preliminary.ratios?.priceSurprise1h || 0, preliminary.ratios?.priceSurprise2h || 0, preliminary.ratios?.priceSurprise4h || 0),
      volumeSurprise: Math.max(preliminary.ratios?.volume5mRatio || 0, preliminary.ratios?.volume15mRatio || 0),
      derivativesStrength,
      crossMarketStrength,
      quoteVolumeUsd: item.quoteVolumeUsd,
      spreadPct: item.market?.spreadPct,
      ageMinutes: 0,
      storyStrength,
      broadMarketShare: activeReferenceShare,
      repeatedHook: false,
      tierThresholds,
    });
    const buildSupport = clamp(0.55 + (candidateDirection === oiDirection ? oiStrength * 0.35 : 0) + takerStrength * 0.08);
    const unwindSupport = clamp(0.5 + (candidateDirection !== 0 && oiDirection === -candidateDirection ? oiStrength * 0.4 : 0) + liquidationStrength * 0.08);
    const conflict = detectConflict({ hypotheses: [
      { id: 'position_build', support: buildSupport },
      { id: 'position_unwind', support: unwindSupport },
    ] });
    const volumeRatio = Math.max(preliminary.ratios?.volume5mRatio || 0, preliminary.ratios?.volume15mRatio || 0);
    const liquidationUsd = Number(item.market?.liquidationUsd || 0);
    const visualImpulsePriority = topRunnerMode
      ? 1
      : freshUpsideImpulsePriority(metrics.candles);
    return {
      id: randomUUID(),
      occurredAt: now,
      symbol: identity.symbol,
      baseAsset: identity.baseAsset,
      quoteAsset: identity.quoteAsset,
      token: identity.baseAsset,
      cashtag: identity.cashtag,
      direction: topRunnerMode ? 'up' : metrics.direction,
      score: scored.score,
      tier: scored.tier,
      scoreComponents: scored.components,
      scoreSource: 'deterministic-code',
      confidence: Math.round(Math.max(buildSupport, unwindSupport) * 100) / 100,
      conflict,
      quoteVolumeUsd: Number(item.quoteVolumeUsd || 0),
      ...(Number.isFinite(item.priceChange24hPct) ? { priceChange24hPct: item.priceChange24hPct } : {}),
      spreadPct: Number(item.market?.spreadPct || 0),
      openInterestChangePct,
      takerBuySellRatio,
      fundingRatePct,
      derivativesEvidence: Object.freeze({
        openInterest: Object.freeze({ ok: openInterestEvidence.ok, reason: openInterestEvidence.reason, latestAt: openInterestEvidence.latestAt ?? null }),
        takerRatio: Object.freeze({ ok: takerEvidence.ok, reason: takerEvidence.reason, latestAt: takerEvidence.latestAt ?? null }),
      }),
      preliminary,
      visualImpulsePriority,
      freshRunnerEligible: visualImpulsePriority === 1,
      freshUpsideImpulsePriority: visualImpulsePriority,
      ...(runnerVisualState ? { topRunnerVisualState: runnerVisualState } : {}),
      technicalContext,
      // Stable depth is audit-only input until several observations exist.
      // It is deliberately never converted into support/resistance or an
      // allowed public price by this layer.
      orderBookEvidence: stableOrderBookClusters,
      metrics: { ...metrics, candles: metrics.candles.slice(-300), chartCandles },
      openInterestSeries: oiSeries.slice(-72),
      liquidations: Array.isArray(item.market?.liquidations) ? item.market.liquidations.slice(-20) : [],
      claimsAllowed: [
        ...(Number.isFinite(item.priceChange24hPct)
          ? [{ key: 'return24h', value: item.priceChange24hPct, display: signed(item.priceChange24hPct, 2), timeframe: '24h' }]
          : []),
        { key: 'return5m', value: metrics.return5mPct, display: signed(metrics.return5mPct, 2), timeframe: '5m' },
        { key: 'return15m', value: metrics.return15mPct, display: signed(metrics.return15mPct, 2), timeframe: '15m' },
        { key: 'return1h', value: metrics.return1hPct, display: signed(metrics.return1hPct, 2), timeframe: '1h' },
        { key: 'return2h', value: metrics.return2hPct, display: signed(metrics.return2hPct, 2), timeframe: '2h' },
        { key: 'return4h', value: metrics.return4hPct, display: signed(metrics.return4hPct, 2), timeframe: '4h' },
        { key: 'volumeRatio', value: volumeRatio, display: multiple(volumeRatio), timeframe: preliminary.ratios?.volume5mRatio >= preliminary.ratios?.volume15mRatio ? '5m' : '15m' },
        ...(Number.isFinite(openInterestChangePct) ? [{ key: 'openInterestChange', value: openInterestChangePct, display: signed(openInterestChangePct, 2), timeframe: '2h' }] : []),
        ...(Number.isFinite(takerBuySellRatio) ? [{ key: 'takerBuySellRatio', value: takerBuySellRatio, display: multiple(takerBuySellRatio), timeframe: '5m' }] : []),
        { key: 'fundingRate', value: fundingRatePct, display: signed(fundingRatePct, 4) },
        { key: 'liquidations', value: liquidationUsd, display: usd(liquidationUsd), timeframe: '5m' },
      ],
    };
  }
}
