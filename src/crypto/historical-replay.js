import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deriveWindowMetrics } from './market/window-metrics.js';
import { scoreCandidate } from './scoring/anomaly-score.js';
import { detectConflict } from './scoring/conflict-detector.js';
import { validateContentPackage } from './content/content-validator.js';
import { formatSquareEditorialPost } from './content/public-text-format.js';
import { deriveMarketRelationship } from './content/market-relationship.js';
import { classifyMarketStory, selectStoryChartIntent, validateStoryChart } from './content/editorial-engine.js';

const DAY = 24 * 60 * 60_000;
const DISCOVERY_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT', 'ENAUSDT', 'ONDOUSDT']);
export const HISTORICAL_REPLAY_V2_REGRESSION_EVENTS = Object.freeze([
  ['BTCUSDT', 1787155199999], ['ETHUSDT', 1787155199999], ['XRPUSDT', 1787155199999], ['SOLUSDT', 1787155199999],
  ['ADAUSDT', 1786031999999], ['LINKUSDT', 1786766399999], ['ENAUSDT', 1787327999999], ['AVAXUSDT', 1787155199999],
].map(([symbol, occurredAt]) => Object.freeze({ symbol, occurredAt, strength: null })));

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function percent(first, last) {
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return null;
  return ((last - first) / first) * 100;
}

function signed(value, digits = 2) {
  return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(digits)}%`;
}

function multiple(value) {
  return `${Number(value).toFixed(1)}x`;
}

function quoteVolume(candles) {
  return candles.reduce((total, candle) => total + Number(candle.quoteVolume || 0), 0);
}

function baseAsset(symbol) {
  return symbol.replace(/(?:USDT|USDC)$/, '');
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function historicalBaseline(candles) {
  const volumeSamples = [];
  const returnSamples = [];
  // The final 15 minutes are the event. Every baseline sample ends before it.
  for (let end = 15; end <= candles.length - 16; end += 5) {
    const start = Math.max(0, end - 5);
    volumeSamples.push(quoteVolume(candles.slice(start, end)));
    returnSamples.push(Math.abs(percent(candles[start]?.close, candles[end]?.close)));
  }
  return {
    volume: median(volumeSamples) || 0,
    movement: Math.max(0.01, median(returnSamples) || 0.01),
  };
}

function preliminaryFrom(candles, metrics) {
  const baseline = historicalBaseline(candles);
  const volume5mRatio = baseline.volume > 0 ? metrics.volume5mUsd / baseline.volume : 0;
  const priceSurprise5m = Math.abs(metrics.return5mPct || 0) / baseline.movement;
  return {
    reasons: ['historical_replay'],
    ratios: {
      priceSurprise5m,
      priceSurprise15m: Math.abs(metrics.return15mPct || 0) / baseline.movement,
      priceSurprise1h: Math.abs(metrics.return1hPct || 0) / baseline.movement,
      priceSurprise2h: Math.abs(metrics.return2hPct || 0) / baseline.movement,
      priceSurprise4h: Math.abs(metrics.return4hPct || 0) / baseline.movement,
      volume5mRatio,
      volume15mRatio: volume5mRatio,
      liquidationRatio: 0,
    },
  };
}

function discoverWindows(symbol, candles) {
  const candidates = [];
  for (let end = 25; end < candles.length; end += 3) {
    const before = candles.slice(0, end + 1);
    const last = before.at(-1);
    const fourHour = percent(before.at(-5)?.close, last.close);
    const oneDay = percent(before.at(-25)?.close, last.close);
    const volume = quoteVolume(before.slice(-4));
    const baseline = median(Array.from({ length: 6 }, (_, index) => quoteVolume(before.slice(-4 - ((index + 1) * 4), -((index + 1) * 4)))));
    const volumeRatio = baseline > 0 ? volume / baseline : 0;
    const strength = Math.abs(fourHour || 0) * Math.max(1, volumeRatio) + Math.abs(oneDay || 0) * 0.25;
    if (Number.isFinite(strength)) candidates.push({ symbol, occurredAt: last.closeTime, strength });
  }
  return candidates;
}

/**
 * Replays closed Binance USD-M data as it existed at each event timestamp.
 * It deliberately has no publisher dependency and never touches live state.
 */
export class HistoricalReplayRunner {
  constructor({ client, writer, chartRenderer, dataDirectory, clock = () => Date.now() } = {}) {
    this.client = client;
    this.writer = writer;
    this.chartRenderer = chartRenderer;
    this.dataDirectory = dataDirectory;
    this.clock = clock;
  }

  async run({ symbols = DISCOVERY_SYMBOLS, count = 8, lookbackDays = 21, events = null } = {}) {
    if (!Number.isInteger(count) || count < 1 || count > 12) throw new RangeError('Historical replay count must be between 1 and 12.');
    const newestAllowed = this.clock() - 15 * 60_000;
    const oldestAllowed = Math.max(this.clock() - 30 * DAY, newestAllowed - Math.max(1, Math.min(21, lookbackDays)) * DAY);
    const selected = Array.isArray(events) && events.length
      ? events.slice(0, 12).map((item) => ({ symbol: item.symbol, occurredAt: Number(item.occurredAt), strength: item.strength ?? null }))
      : await this.#discover({ symbols, count, oldestAllowed, newestAllowed });
    const batchId = `replay-${new Date(this.clock()).toISOString().replace(/[:.]/g, '-')}`;
    const outputDirectory = path.join(this.dataDirectory, 'replay', batchId);
    await mkdir(outputDirectory, { recursive: true });
    const results = [];
    const fingerprints = [];
    const openings = [];
    const editorialHistory = [];
    for (const selection of selected) {
      const result = await this.#replayOne({ selection, outputDirectory, fingerprints, openings, editorialHistory });
      results.push(result);
      if (result.status === 'accepted') {
        fingerprints.push(result.validation.fingerprint);
        openings.push(result.validation.openingFingerprint);
        editorialHistory.push({ source: 'historical_replay_v2', symbol: result.symbol, text: result.content.postText, fingerprint: result.editorialFingerprint, hookFamily: result.validation.hookFamily, openingFingerprint: result.validation.openingFingerprint, marketStoryCluster: result.marketStoryCluster, createdAt: selection.occurredAt });
      }
    }
    const report = {
      mode: 'historical_replay_v2',
      batchId,
      source: 'Binance USD-M public market data',
      noLookahead: true,
      publication: { attempted: false, published: 0, squareCalled: false },
      createdAt: this.clock(),
      results,
    };
    await writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { ...report, outputDirectory };
  }

  async #discover({ symbols, count, oldestAllowed, newestAllowed }) {
    const scanned = [];
    for (const symbol of symbols.slice(0, 18)) {
      try {
        const candles = await this.client.getKlines(symbol, '1h', 550, { startTime: oldestAllowed, endTime: newestAllowed });
        scanned.push(discoverWindows(symbol, candles.filter((candle) => candle.closeTime <= newestAllowed)));
      } catch { scanned.push([]); }
      await pause(150);
    }
    const selected = [];
    const usedSymbols = new Set();
    for (const item of scanned.flat().sort((a, b) => b.strength - a.strength)) {
      if (selected.length >= count || usedSymbols.has(item.symbol)) continue;
      usedSymbols.add(item.symbol);
      selected.push(item);
    }
    return selected;
  }

  async #replayOne({ selection, outputDirectory, fingerprints, openings, editorialHistory }) {
    const endTime = selection.occurredAt;
    try {
      const [candles, oi, taker] = await Promise.all([
        this.client.getKlines(selection.symbol, '1m', 1_441, { endTime }),
        this.client.getOpenInterestHistory(selection.symbol, '5m', 48, { endTime }),
        this.client.getTakerLongShortRatio(selection.symbol, '5m', 3, { endTime }),
      ]);
      const closed = candles.filter((candle) => candle.closeTime <= endTime);
      if (closed.length < 1_441) return { ...selection, status: 'skipped', reason: 'incomplete_closed_candles' };
      const metrics = deriveWindowMetrics(closed);
      const preliminary = preliminaryFrom(closed, metrics);
      const oiSeries = (oi || []).map((entry) => Number(entry.sumOpenInterestValue)).filter(Number.isFinite);
      const takerRatio = Number(taker?.at(-1)?.buySellRatio);
      if (oiSeries.length < 2 || !Number.isFinite(takerRatio)) return { ...selection, status: 'skipped', reason: 'incomplete_derivatives_history' };
      const oiChange = percent(oiSeries[0], oiSeries.at(-1));
      const oiStrength = Math.min(1, Math.abs(oiChange || 0) / 4);
      const takerStrength = Math.min(1, Math.abs(takerRatio - 1) / 0.8);
      const scored = scoreCandidate({
        priceSurprise: Math.max(...Object.values(preliminary.ratios).filter(Number.isFinite)),
        volumeSurprise: preliminary.ratios.volume5mRatio,
        derivativesStrength: oiStrength * 0.7 + takerStrength * 0.3,
        crossMarketStrength: 0,
        quoteVolumeUsd: metrics.volume24hUsd,
        spreadPct: Number.POSITIVE_INFINITY,
        ageMinutes: 0,
        storyStrength: [preliminary.ratios.priceSurprise5m >= 3, preliminary.ratios.volume5mRatio >= 3, oiStrength >= 0.5].filter(Boolean).length / 3,
        broadMarketShare: 0,
        repeatedHook: false,
      });
      const asset = baseAsset(selection.symbol);
      const direction = metrics.return5mPct > 0 ? 1 : metrics.return5mPct < 0 ? -1 : 0;
      const oiDirection = oiChange > 0 ? 1 : oiChange < 0 ? -1 : 0;
      const candidate = {
        id: `historical-${selection.symbol}-${endTime}-${randomUUID().slice(0, 8)}`,
        occurredAt: endTime,
        symbol: selection.symbol,
        token: `${asset}_HISTORICAL_${endTime}`,
        cashtag: `$${asset}`,
        score: scored.score,
        tier: scored.tier,
        scoreComponents: scored.components,
        scoreSource: 'deterministic-code',
        historicalReplay: true,
        readinessOnly: true,
        productionEligible: false,
        autoEligible: false,
        expired: true,
        direction: metrics.direction,
        quoteVolumeUsd: metrics.volume24hUsd,
        spreadPct: null,
        openInterestChangePct: oiChange,
        takerBuySellRatio: takerRatio,
        conflict: detectConflict({ hypotheses: [
          { id: 'position_build', support: direction === oiDirection ? 0.55 + oiStrength * 0.3 : 0.5 },
          { id: 'position_unwind', support: direction && direction !== oiDirection ? 0.55 + oiStrength * 0.3 : 0.5 },
        ] }),
        preliminary,
        metrics: { ...metrics, candles: metrics.candles.slice(-300) },
        openInterestSeries: oiSeries.slice(-72),
        liquidations: [],
        claimsAllowed: [
          { key: 'return24h', value: metrics.return24hPct, display: signed(metrics.return24hPct), timeframe: '24h' },
          { key: 'return15m', value: metrics.return15mPct, display: signed(metrics.return15mPct), timeframe: '15m' },
          { key: 'return1h', value: metrics.return1hPct, display: signed(metrics.return1hPct), timeframe: '1h' },
          { key: 'return2h', value: metrics.return2hPct, display: signed(metrics.return2hPct), timeframe: '2h' },
          { key: 'return4h', value: metrics.return4hPct, display: signed(metrics.return4hPct), timeframe: '4h' },
          { key: 'volumeRatio', value: preliminary.ratios.volume5mRatio, display: multiple(preliminary.ratios.volume5mRatio), timeframe: '5m' },
          { key: 'openInterestChange', value: oiChange, display: signed(oiChange), timeframe: '4h' },
          { key: 'takerBuySellRatio', value: takerRatio, display: multiple(takerRatio), timeframe: '5m' },
        ],
      };
      candidate.marketRelationship = deriveMarketRelationship(candidate);
      const marketStoryCluster = classifyMarketStory(candidate);
      const representative = editorialHistory.find((item) => item.marketStoryCluster === marketStoryCluster);
      if (representative) return { ...selection, status: 'skipped', reason: 'MARKET_STORY_DUPLICATE', marketStoryCluster, clusterRepresentative: representative.symbol, clusterReason: 'same timestamp, shape, and price/OI story' };
      const editorial = await this.writer.generate({ candidate, editorialHistory });
      if (editorial.status !== 'ready') return { ...selection, status: 'skipped', reason: editorial.reason, marketStoryCluster, plan: editorial.plan || null, diversity: editorial.diversity || null, chartIntent: editorial.plan ? selectStoryChartIntent(editorial.plan, candidate) : null };
      const content = {
        ...editorial.content,
        postText: formatSquareEditorialPost({
          text: editorial.content.postText,
          candidate,
          storyKind: editorial?.finalStory?.spine?.storyKind || editorial?.plan?.storyKind,
        }),
      };
      const validation = validateContentPackage(content, candidate, { fingerprints, openingFingerprints: openings });
      if (!validation.ok) {
        return {
          ...selection,
          status: 'skipped',
          reason: 'validator_rejected',
          errors: validation.errors,
          marketStoryCluster,
          plan: editorial.plan,
          diversity: editorial.diversity,
          candidate: { id: candidate.id, symbol: candidate.symbol, occurredAt: candidate.occurredAt, score: candidate.score, tier: candidate.tier, claimsAllowed: candidate.claimsAllowed },
          draft: { postText: content.postText, cashtag: content.cashtag, claimsUsed: content.claimsUsed, visualIntent: content.visualIntent }, chartIntent: content.visualIntent,
        };
      }
      const chart = await this.chartRenderer({ candidate, visualIntent: content.visualIntent, finalStory: editorial.finalStory || null, outputPath: path.join(outputDirectory, `${candidate.id}.png`) });
      const visual = validateStoryChart({ candidate, plan: editorial.plan, finalStory: editorial.finalStory || null, visualIntent: content.visualIntent, chart });
      if (!visual.pass) return { ...selection, status: 'skipped', reason: visual.reason, marketStoryCluster, plan: editorial.plan, diversity: editorial.diversity, validation };
      return { ...selection, status: 'accepted', marketStoryCluster, planner: editorial.plan, finalStory: editorial.finalStory || null, diversity: editorial.diversity, editorialFingerprint: editorial.fingerprint, candidate: { id: candidate.id, symbol: candidate.symbol, occurredAt: candidate.occurredAt, score: candidate.score, tier: candidate.tier, claimsAllowed: candidate.claimsAllowed }, content, validation, visual, chart: { filename: path.basename(chart.path), width: chart.width, height: chart.height, sha256: chart.sha256 } };
    } catch (error) {
      return { ...selection, status: 'skipped', reason: 'replay_error', error: String(error?.message || error) };
    }
  }
}
