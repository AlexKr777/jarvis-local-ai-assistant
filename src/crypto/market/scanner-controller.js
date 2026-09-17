import { CandidatePool } from '../scoring/candidate-pool.js';
import { buildUniverse } from './universe.js';
import { deriveWindowMetrics } from './window-metrics.js';
import { MarketScanner } from './market-scanner.js';

const FIVE_MINUTES = 5 * 60_000;
const TWO_HOURS = 2 * 60 * 60_000;
const SAMPLE_WINDOW = 25 * 60 * 60_000;
const SAMPLE_INTERVAL = 55_000;

function finite(value) { return Number.isFinite(Number(value)); }

export class CryptoScannerController {
  constructor({ client = null, baseline = null, baselineStore = null, deepAnalyzer = null, streamMonitor = null,
    competitionWindowMs = 600_000, deepAnalysisConcurrency = 2, deepAnalysisPerSymbolCooldownMs = 300_000,
    deepAnalysisQueueLimit = 8, scannerIntervalMs = 60_000, tierThresholds = undefined, requireScoreForLiveRunner = true, topRunnerMode = false, restGovernor = null,
    clock = () => Date.now(), setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
    onStatus = () => {} } = {}) {
    this.client = client;
    this.baseline = baseline;
    this.baselineStore = baselineStore;
    this.deepAnalyzer = deepAnalyzer;
    this.streamMonitor = streamMonitor;
    this.clock = clock;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.onStatus = onStatus;
    this.marketCache = new Map();
    this.universe = [];
    this.pool = new CandidatePool({ competitionWindowMs, tierThresholds });
    this.competitionWindowMs = competitionWindowMs;
    this.deepAnalysisConcurrency = deepAnalysisConcurrency;
    this.deepAnalysisPerSymbolCooldownMs = deepAnalysisPerSymbolCooldownMs;
    this.deepAnalysisQueueLimit = deepAnalysisQueueLimit;
    this.requireScoreForLiveRunner = requireScoreForLiveRunner;
    this.topRunnerMode = topRunnerMode;
    this.restGovernor = restGovernor;
    this.deepAnalysisLastAdmittedAt = new Map();
    this.topRunnerSuppressedSymbols = new Map();
    this.deepAnalysisDropped = 0;
    this.scannerIntervalMs = scannerIntervalMs;
    this.symbolFailures = new Map();
    this.lastTickerFallbackAt = 0;
    this.onCandidate = async () => {};
    this.pollTimer = null;
    this.competitionTimer = null;
    this.polling = false;
    this.running = false;
    this.scanner = client && baseline && deepAnalyzer
      ? new MarketScanner({ client, baseline, deepAnalyzer, marketCache: this.marketCache, tierThresholds }) : null;
  }

  async start({ onCandidate = async () => {} } = {}) {
    if (this.running) return this.status();
    this.onCandidate = onCandidate;
    this.running = true;
    if (this.baseline && this.baselineStore) this.baseline.restore(await this.baselineStore.load());
    if (this.streamMonitor) {
      this.streamMonitor.onMarketUpdate = (event) => this.ingestMarketUpdate(event);
      this.streamMonitor.start();
    }
    if (this.client && this.baseline) {
      try { await this.#bootstrapUniverse(); }
      catch { this.onStatus({ state: 'degraded', reason: 'bootstrap_failed' }); }
    }
    this.pollTimer = this.setIntervalImpl(() => {
      void this.pollOnce().catch(() => this.onStatus({ state: 'degraded', reason: 'poll_failed' }));
    }, this.scannerIntervalMs);
    this.pollTimer?.unref?.();
    this.onStatus({ state: 'running', ...this.status() });
    return this.status();
  }

  async stop() {
    this.running = false;
    if (this.pollTimer) this.clearIntervalImpl(this.pollTimer);
    if (this.competitionTimer) this.clearTimeoutImpl(this.competitionTimer);
    this.pollTimer = null;
    this.competitionTimer = null;
    this.streamMonitor?.stop?.();
    if (this.baseline && this.baselineStore) await this.baselineStore.save(this.baseline.snapshot());
  }

  status() {
    return { running: this.running, universeCount: this.universe.length,
      autoEligibleCount: this.universe.filter((item) => item.autoEligible).length, competitionSize: this.pool.size,
      localSamples: [...this.marketCache.values()].reduce((count, entry) => count + (entry.samples?.length || 0), 0),
      quarantinedSymbols: [...this.symbolFailures.values()].filter((entry) => entry.quarantineUntil > this.clock()).length,
      deepAnalysis: {
        state: this.restGovernor?.status?.().state || 'NORMAL',
        perSymbolCooldownMs: this.deepAnalysisPerSymbolCooldownMs,
        admissionLimit: this.deepAnalysisQueueLimit,
        droppedOrCoalesced: this.deepAnalysisDropped,
      } };
  }

  ingestMarketUpdate(event) {
    if (!event?.symbol) return;
    const current = this.marketCache.get(event.symbol) || { liquidations: [] };
    if (event.type === 'book' && finite(event.spreadPct)) current.spreadPct = Number(event.spreadPct);
    if (event.type === 'ticker' && finite(event.close) && finite(event.quoteVolumeUsd)) {
      current.close = Number(event.close);
      current.quoteVolumeUsd = Number(event.quoteVolumeUsd);
      if (finite(event.priceChange24hPct)) current.priceChange24hPct = Number(event.priceChange24hPct);
      current.lastTickerAt = Number(event.occurredAt);
      const samples = current.samples || [];
      const previous = samples.at(-1);
      if (!previous || Number(event.occurredAt) - previous.closeTime >= SAMPLE_INTERVAL) {
        const quoteVolume = previous ? Math.max(0, Number(event.quoteVolumeUsd) - Number(previous.totalQuoteVolumeUsd || 0)) : 0;
        samples.push({
          openTime: Number(event.occurredAt), closeTime: Number(event.occurredAt), open: Number(event.close), high: Number(event.close),
          low: Number(event.close), close: Number(event.close), quoteVolume, totalQuoteVolumeUsd: Number(event.quoteVolumeUsd),
        });
      }
      current.samples = samples.filter((item) => item.closeTime >= this.clock() - SAMPLE_WINDOW).slice(-1_600);
    }
    if (event.type === 'liquidation' && finite(event.notionalUsd) && finite(event.occurredAt)) {
      current.liquidations.push({ side: event.side, notionalUsd: Number(event.notionalUsd), occurredAt: Number(event.occurredAt) });
    }
    const cutoff = this.clock() - FIVE_MINUTES;
    current.liquidations = current.liquidations.filter((item) => item.occurredAt >= cutoff);
    current.liquidationUsd = current.liquidations.reduce((sum, item) => sum + item.notionalUsd, 0);
    this.marketCache.set(event.symbol, current);
    if (event.type === 'ticker' && finite(event.priceChange24hPct)) {
      this.universe = this.universe.map((item) => item.symbol === event.symbol
        ? { ...item, priceChange24hPct: Number(event.priceChange24hPct) }
        : item);
    }
  }

  marketSnapshot(symbol) {
    const current = this.marketCache.get(symbol) || { liquidations: [] };
    const cutoff = this.clock() - FIVE_MINUTES;
    const liquidations = (current.liquidations || []).filter((item) => item.occurredAt >= cutoff);
    return { ...(finite(current.spreadPct) ? { spreadPct: Number(current.spreadPct) } : {}),
      ...(finite(current.close) ? { close: Number(current.close) } : {}),
      ...(finite(current.quoteVolumeUsd) ? { quoteVolumeUsd: Number(current.quoteVolumeUsd) } : {}),
      ...((current.samples || []).length ? { samples: current.samples.map((item) => ({ ...item })) } : {}),
      liquidationUsd: liquidations.reduce((sum, item) => sum + item.notionalUsd, 0),
      liquidations: liquidations.map((item) => ({ ...item })) };
  }

  async pollOnce() {
    if (this.polling || !this.scanner) return [];
    this.polling = true;
    const results = [];
    let successfulEvaluations = 0;
    try {
      if (this.universe.length === 0) {
        try { await this.#bootstrapUniverse(); }
        catch {
          this.onStatus({ state: 'reconnecting', reason: 'bootstrap_retry_failed' });
          return results;
        }
      }
      await this.#refreshTickerFallback();
      const admitted = this.#admitDeepAnalysisWork();
      const tasks = admitted.map((universeItem) => async () => {
        const failure = this.symbolFailures.get(universeItem.symbol);
        if (failure?.quarantineUntil > this.clock()) return;
        const market = this.marketSnapshot(universeItem.symbol);
        const spreadReady = finite(market.spreadPct) && market.spreadPct <= 0.6;
        const item = { ...universeItem, autoEligible: universeItem.autoEligible === true && spreadReady, spreadPct: market.spreadPct };
        try {
          const candidate = this.topRunnerMode && typeof this.scanner.evaluateTopRunner === 'function'
            ? await this.scanner.evaluateTopRunner({ ...item, market }, this.clock())
            : typeof this.scanner.evaluateSnapshot === 'function'
            ? await this.scanner.evaluateSnapshot({ ...item, market }, this.clock())
            : await this.scanner.evaluateSymbol(item, this.clock());
          successfulEvaluations += 1;
          if (!candidate) return;
          candidate.autoEligible = this.topRunnerMode ? true : item.autoEligible;
          candidate.livePublicData = true;
          results.push(candidate);
          if (this.topRunnerMode) {
            const outcome = await this.onCandidate(candidate);
            // Runtime has already reached a terminal decision for this symbol.
            // Do not spend another deep analysis on the same leader while the
            // next top-ten contracts are waiting for their turn.
            if (candidate.symbol && outcome?.reason !== 'global_cooldown' && outcome?.reason !== 'rolling_24h_cap') {
              this.topRunnerSuppressedSymbols.set(candidate.symbol, this.clock() + TWO_HOURS);
            }
          }
          else {
            const scoreRequired = this.requireScoreForLiveRunner || candidate.freshRunnerEligible !== true;
            if (!candidate.autoEligible || (scoreRequired && candidate.score < 75)) await this.onCandidate(candidate);
            else this.submitCandidate(candidate);
          }
          this.symbolFailures.delete(item.symbol);
        } catch (error) {
          this.#recordSymbolFailure(item.symbol, error);
        }
      });
      await this.#runBounded(tasks, this.deepAnalysisConcurrency);
      if (this.baselineStore) await this.baselineStore.save(this.baseline.snapshot());
      if (successfulEvaluations > 0) this.onStatus({ state: 'running', ...this.status() });
      return results;
    } finally { this.polling = false; }
  }

  #admitDeepAnalysisWork() {
    const now = this.clock();
    const topGainers = this.universe
      .filter((item) => finite(item.priceChange24hPct) && Number(item.priceChange24hPct) > 0)
      .sort((left, right) => Number(right.priceChange24hPct) - Number(left.priceChange24hPct)
        || Number(right.quoteVolumeUsd || 0) - Number(left.quoteVolumeUsd || 0))
      .slice(0, 10);
    const eligible = topGainers
      .filter((item) => {
        const failure = this.symbolFailures.get(item.symbol);
        if (failure?.quarantineUntil > now) return false;
        if (this.topRunnerMode) return Number(this.topRunnerSuppressedSymbols.get(item.symbol) || 0) <= now;
        const last = this.deepAnalysisLastAdmittedAt.get(item.symbol);
        return !Number.isFinite(last) || now - last >= this.deepAnalysisPerSymbolCooldownMs;
      });
    const admitted = eligible.slice(0, this.deepAnalysisQueueLimit);
    const dropped = this.universe.length - admitted.length;
    if (dropped > 0) {
      this.deepAnalysisDropped += dropped;
      this.restGovernor?.noteCoalesced?.(dropped);
    }
    for (const item of admitted) this.deepAnalysisLastAdmittedAt.set(item.symbol, now);
    return admitted;
  }

  submitCandidate(candidate) {
    this.pool.add(candidate);
    if (this.competitionTimer) return;
    this.competitionTimer = this.setTimeoutImpl(() => { this.competitionTimer = null; void this.flushCompetition(); }, this.competitionWindowMs);
    this.competitionTimer?.unref?.();
  }

  async flushCompetition() {
    const ranked = this.pool.selectRanked(this.clock());
    if (!ranked) return null;
    if (this.competitionTimer) this.clearTimeoutImpl(this.competitionTimer);
    this.competitionTimer = null;
    let lastCandidate = null;
    for (const candidate of ranked) {
      lastCandidate = candidate;
      const result = await this.onCandidate(candidate);
      if (result === undefined || result?.published === true || result?.status === 'preview' || result?.status === 'PUBLISHED') return candidate;
      if (result?.reason === 'global_cooldown' || result?.reason === 'rolling_24h_cap' || result?.reason === 'utc_day_cap') return candidate;
    }
    return lastCandidate;
  }

  async #bootstrapUniverse() {
    const [exchangeInfo, tickers] = await Promise.all([this.client.getExchangeInfo(), this.client.get24hTickers()]);
    const now = this.clock();
    for (const ticker of tickers || []) this.ingestMarketUpdate({
      type: 'ticker', symbol: ticker.symbol, close: Number(ticker.lastPrice || ticker.close || 0), quoteVolumeUsd: Number(ticker.quoteVolume || 0), priceChange24hPct: Number(ticker.priceChangePercent), occurredAt: now,
    });
    const baselineHoursBySymbol = {};
    for (const symbol of exchangeInfo?.symbols || []) baselineHoursBySymbol[symbol.symbol] = this.baseline.summary(symbol.symbol, now).sampleHours;
    const preliminaryUniverse = buildUniverse(exchangeInfo, tickers, { now, baselineHoursBySymbol });
    for (const symbol of exchangeInfo?.symbols || []) baselineHoursBySymbol[symbol.symbol] = this.baseline.summary(symbol.symbol, now).sampleHours;
    this.universe = buildUniverse(exchangeInfo, tickers, { now, baselineHoursBySymbol }).sort((left, right) => right.quoteVolumeUsd - left.quoteVolumeUsd);
    if (this.baselineStore) await this.baselineStore.save(this.baseline.snapshot());
  }

  async #refreshTickerFallback() {
    const now = this.clock();
    if (now - this.lastTickerFallbackAt < 5 * 60_000 || [...this.marketCache.values()].some((entry) => now - Number(entry.lastTickerAt || 0) < 2 * this.scannerIntervalMs)) return;
    this.lastTickerFallbackAt = now;
    try {
      const tickers = await this.client.get24hTickers();
      for (const ticker of tickers || []) this.ingestMarketUpdate({
      type: 'ticker', symbol: ticker.symbol, close: Number(ticker.lastPrice || ticker.close || 0), quoteVolumeUsd: Number(ticker.quoteVolume || 0), priceChange24hPct: Number(ticker.priceChangePercent), occurredAt: now,
      });
    } catch (error) {
      this.onStatus({ state: 'degraded', reason: 'ticker_fallback_failed', error: this.#publicError(error) });
    }
  }

  async #runBounded(tasks, limit) {
    const workers = Array.from({ length: Math.max(1, Math.min(tasks.length || 1, limit)) }, async () => {
      while (tasks.length) await tasks.shift()();
    });
    await Promise.all(workers);
  }

  #publicError(error) {
    const message = String(error?.message || 'unknown_error');
    const status = Number(error?.status);
    return {
      kind: Number.isFinite(status) ? 'http' : 'runtime',
      ...(Number.isFinite(status) ? { status } : {}),
      code: /^[A-Z0-9_]+$/.test(String(error?.code || '')) ? error.code : 'MARKET_DATA_FAILED',
      message: message.slice(0, 160),
    };
  }

  #recordSymbolFailure(symbol, error) {
    const previous = this.symbolFailures.get(symbol) || { count: 0 };
    const count = previous.count + 1;
    const backoffMs = Math.min(30 * 60_000, 60_000 * (2 ** Math.min(count - 1, 5)));
    const failure = { count, lastFailureAt: this.clock(), quarantineUntil: this.clock() + backoffMs, error: this.#publicError(error) };
    this.symbolFailures.set(symbol, failure);
    this.onStatus({ state: 'degraded', reason: 'symbol_poll_failed', symbol, failures: count, retryInMs: backoffMs, error: failure.error });
  }
}
