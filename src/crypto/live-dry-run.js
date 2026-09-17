import { deriveWindowMetrics } from './market/window-metrics.js';
import { scoreCandidate } from './scoring/anomaly-score.js';
import { canonicalMarketIdentity } from './market/token-identity.js';

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function sumQuoteVolume(candles) {
  return candles.reduce((total, candle) => total + Number(candle.quoteVolume || 0), 0);
}

function strongestVerifiedWindow(candles, { minimumOccurredAt = Number.NEGATIVE_INFINITY } = {}) {
  if (!Array.isArray(candles) || candles.length < 66) {
    throw new Error('Live Binance public candles were incomplete.');
  }
  let strongest = null;
  for (let end = 60; end < candles.length; end += 1) {
    const window = candles.slice(end - 60, end + 1);
    if (Number(window.at(-1)?.closeTime || 0) < minimumOccurredAt) continue;
    const metrics = deriveWindowMetrics(window);
    const priorVolumes = [];
    const priorReturns = [];
    for (let cursor = 5; cursor <= 55; cursor += 5) {
      priorVolumes.push(sumQuoteVolume(window.slice(cursor - 5, cursor)));
      const previous = Number(window[cursor - 5]?.close);
      const current = Number(window[cursor]?.close);
      if (Number.isFinite(previous) && Number.isFinite(current) && previous !== 0) {
        priorReturns.push(Math.abs(((current - previous) / previous) * 100));
      }
    }
    const baselineVolume = median(priorVolumes);
    const baselineReturn = Math.max(0.01, median(priorReturns));
    const volumeRatio = baselineVolume > 0 ? metrics.volume5mUsd / baselineVolume : 0;
    const priceSurprise = Math.abs(metrics.return5mPct) / baselineReturn;
    const tension = priceSurprise * Math.max(1, Math.min(20, volumeRatio));
    if (!strongest || tension > strongest.tension) strongest = { window, metrics, volumeRatio, priceSurprise, tension };
  }
  if (!strongest || !Number.isFinite(strongest.metrics.close) || !Number.isFinite(strongest.volumeRatio)) {
    throw new Error('Live Binance public candles contained non-finite facts.');
  }
  return strongest;
}

function cleanNumber(value, digits = 2) {
  const rounded = Number(Number(value).toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function signedPercent(value) {
  const rounded = cleanNumber(value);
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`;
}

function makeReadinessCandidate({ strongest, ticker, symbolInfo, now }) {
  const occurredAt = Number(strongest.window.at(-1).closeTime || now);
  const return5m = cleanNumber(strongest.metrics.return5mPct);
  const return15m = cleanNumber(strongest.metrics.return15mPct);
  const volumeRatio = cleanNumber(strongest.volumeRatio);
  const ageMinutes = Math.max(0, (now - occurredAt) / 60_000);
  const scored = scoreCandidate({
    priceSurprise: strongest.priceSurprise,
    volumeSurprise: strongest.volumeRatio,
    derivativesStrength: 0,
    crossMarketStrength: 0,
    quoteVolumeUsd: Number(ticker?.quoteVolume || 0),
    spreadPct: Number.POSITIVE_INFINITY,
    ageMinutes,
    storyStrength: [strongest.priceSurprise >= 3, strongest.volumeRatio >= 3].filter(Boolean).length / 2,
    broadMarketShare: 0,
    repeatedHook: false,
  });
  const identity = canonicalMarketIdentity(symbolInfo);
  if (!identity) throw new Error('Live Binance public market identity was incomplete.');
  const { symbol, baseAsset, quoteAsset, cashtag } = identity;
  return {
    id: `live-dry-run-${symbol}-${occurredAt}`,
    occurredAt,
    symbol,
    token: `${baseAsset}_READINESS_${occurredAt}`,
    baseAsset,
    quoteAsset,
    cashtag,
    score: scored.score,
    scoreComponents: scored.components,
    scoreSource: 'deterministic-code',
    expired: scored.expired,
    confidence: 1,
    quoteVolumeUsd: Number(ticker?.quoteVolume || 0),
    spreadPct: null,
    direction: strongest.metrics.direction,
    livePublicData: true,
    readinessOnly: true,
    validationForcedCandidate: true,
    productionEligible: false,
    autoEligible: true,
    conflict: { allowed: false, confidence: 1, verdictStyle: 'none', options: [] },
    claimsAllowed: [
      { key: 'return5m', value: return5m, display: signedPercent(return5m) },
      { key: 'return15m', value: return15m, display: signedPercent(return15m) },
      { key: 'volumeRatio', value: volumeRatio, display: `${volumeRatio.toFixed(2)}x` },
    ],
    metrics: {
      ...strongest.metrics,
      return5mPct: return5m,
      return15mPct: return15m,
      volumeRatio,
      candles: strongest.window,
    },
  };
}

function dryRunOutcome(pipelineResult, candidate) {
  const status = String(pipelineResult?.status || '');
  const base = {
    ok: true,
    success: true,
    symbol: candidate.symbol,
    reason: pipelineResult?.reason || null,
    wouldPublish: false,
    pipeline: {
      status,
      published: false,
      candidateId: pipelineResult?.candidateId || candidate.id,
    },
  };
  if (status === 'preview' && pipelineResult?.published === false) {
    return { ...base, result: 'PUBLISHABLE_PREVIEW', wouldPublish: true };
  }
  if (status === 'content_skipped') return { ...base, result: 'EDITORIAL_SKIP' };
  if (status === 'content_rejected') return { ...base, result: 'FACTUAL_SKIP' };
  if (['rejected', 'watch', 'observed'].includes(status)) return { ...base, result: 'SKIP' };
  throw new Error('Live DRY_RUN full pipeline did not produce a valid non-publishing outcome.');
}

function executionFailureOutcome(error, candidate) {
  const rawCode = String(error?.code || 'CANDIDATE_EXECUTION_FAILED').toUpperCase();
  const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(rawCode)
    ? rawCode
    : 'CANDIDATE_EXECUTION_FAILED';
  return {
    ok: false,
    success: false,
    symbol: candidate.symbol,
    reason: code.toLowerCase(),
    wouldPublish: false,
    result: 'WRITER_UNAVAILABLE',
    pipeline: {
      status: 'writer_unavailable',
      published: false,
      candidateId: candidate.id,
    },
  };
}

function marketDataFailureOutcome(error, candidate) {
  const rawCode = String(error?.code || 'MARKET_DATA_UNAVAILABLE').toUpperCase();
  const code = /^BINANCE_[A-Z0-9_]{1,72}$/.test(rawCode)
    ? rawCode
    : 'MARKET_DATA_UNAVAILABLE';
  return {
    ok: false,
    success: false,
    symbol: candidate.symbol,
    reason: code.toLowerCase(),
    wouldPublish: false,
    result: 'MARKET_DATA_UNAVAILABLE',
    pipeline: {
      status: 'market_data_unavailable',
      published: false,
      candidateId: candidate.id,
    },
  };
}

function isWriterTransportFailure(error) {
  const code = String(error?.code || '').toUpperCase();
  return /^(?:ANYMODEL|OLLAMA|OPENROUTER|WRITER)_/.test(code);
}

function permanentWriterBlock(error) {
  const code = String(error?.code || '').toUpperCase();
  if (!['ANYMODEL_QUOTA_EXHAUSTED', 'ANYMODEL_AUTH_FAILED', 'ANYMODEL_API_KEY_MISSING'].includes(code)) {
    return null;
  }
  return { code };
}

function isBinanceRestBlocked(error) {
  return String(error?.code || '').toUpperCase() === 'BINANCE_REST_BLOCKED';
}

function isBinanceTransientDataFailure(error) {
  return ['BINANCE_TIMEOUT', 'BINANCE_NETWORK', 'BINANCE_INVALID_JSON'].includes(String(error?.code || '').toUpperCase());
}

function restBlockedOutcome(restBlock) {
  return {
    ok: false,
    success: false,
    reason: 'binance_rest_blocked',
    wouldPublish: false,
    result: 'REST_BLOCKED',
    pipeline: {
      status: 'rest_blocked',
      published: false,
      candidateId: null,
    },
    restBlock,
  };
}

export async function runLivePublicDryRun({ client, executeCandidate, deepAnalyzer = null, maxCandidates = 1, clock = () => Date.now() }) {
  const [exchangeInfo, tickers] = await Promise.all([
    client.getExchangeInfo(),
    client.get24hTickers(),
  ]);
  const activeSymbols = new Set((exchangeInfo?.symbols || []).filter((item) => item.status === 'TRADING').map((item) => item.symbol));
  const tickerBySymbol = new Map(Array.isArray(tickers) ? tickers.map((item) => [item.symbol, item]) : []);
  const btcTicker = tickerBySymbol.get('BTCUSDT');
  const ethTicker = tickerBySymbol.get('ETHUSDT');
  if (!activeSymbols.has('BTCUSDT') || !activeSymbols.has('ETHUSDT') || !btcTicker || !ethTicker) {
    throw new Error('Live Binance public universe verification failed.');
  }
  const eligible = (exchangeInfo?.symbols || []).filter((item) =>
    item.status === 'TRADING'
    && (item.contractType === undefined || item.contractType === 'PERPETUAL')
    && (item.quoteAsset === undefined || ['USDT', 'USDC'].includes(item.quoteAsset))
    && canonicalMarketIdentity(item)
    && tickerBySymbol.has(item.symbol));
  const required = eligible.filter((item) => ['BTCUSDT', 'ETHUSDT'].includes(item.symbol));
  const topTen = [...eligible]
    .sort((left, right) => Number(tickerBySymbol.get(right.symbol)?.priceChangePercent || Number.NEGATIVE_INFINITY) - Number(tickerBySymbol.get(left.symbol)?.priceChangePercent || Number.NEGATIVE_INFINITY))
    .slice(0, 10)
    .map((item, index) => ({ ...item, top10Rank: index + 1 }));
  const selectedSymbols = [...new Map([...required, ...topTen].map((item) => [item.symbol, item])).values()].slice(0, 12);
  const candleSets = await Promise.all(selectedSymbols.map(async (symbolInfo) => ({
    symbolInfo,
    candles: await client.getKlines(symbolInfo.symbol, '1m', 121),
  })));
  const minimumOccurredAt = clock() - 45 * 60_000;
  const samples = candleSets.map(({ symbolInfo, candles }) => ({
    symbolInfo,
    ticker: tickerBySymbol.get(symbolInfo.symbol),
    strongest: strongestVerifiedWindow(candles, { minimumOccurredAt }),
  }));
  const btc = samples.find((item) => item.symbolInfo.symbol === 'BTCUSDT')?.strongest;
  const eth = samples.find((item) => item.symbolInfo.symbol === 'ETHUSDT')?.strongest;
  if (!Number.isFinite(btc?.metrics.close) || !Number.isFinite(eth?.metrics.close)) {
    throw new Error('Live Binance public price verification failed.');
  }
  if (typeof executeCandidate !== 'function') {
    throw new Error('Live DRY_RUN full pipeline is unavailable.');
  }
  const rankedSamples = samples
    .filter((item) => topTen.some((top) => top.symbol === item.symbolInfo.symbol))
    .sort((left, right) => Number(left.symbolInfo.top10Rank || 99) - Number(right.symbolInfo.top10Rank || 99))
    .slice(0, Math.max(1, Math.min(5, Number(maxCandidates) || 1)));
  const outcomes = [];
  let restBlock = null;
  let writerBlock = null;
  for (const sample of rankedSamples) {
    let candidate = makeReadinessCandidate({ ...sample, now: clock() });
    if (deepAnalyzer && typeof deepAnalyzer.analyze === 'function') {
      try {
        const preliminary = {
          reasons: ['live_readiness'],
          ratios: {
            priceSurprise5m: sample.strongest.priceSurprise,
            priceSurprise15m: sample.strongest.priceSurprise,
            volume5mRatio: sample.strongest.volumeRatio,
            volume15mRatio: sample.strongest.volumeRatio,
            liquidationRatio: 0,
          },
        };
        const analyzed = await deepAnalyzer.analyze({
          ...sample.symbolInfo,
          quoteVolumeUsd: Number(sample.ticker?.quoteVolume || 0),
          priceChange24hPct: Number(sample.ticker?.priceChangePercent),
          market: { spreadPct: 0, liquidationUsd: 0, liquidations: [] },
        }, preliminary, clock());
        if (!analyzed?.id || !Array.isArray(analyzed.claimsAllowed) || !analyzed.metrics?.candles?.length) {
          throw new Error('Live DRY_RUN deep analysis did not produce a verified candidate.');
        }
        candidate = {
          ...analyzed,
          ...canonicalMarketIdentity(sample.symbolInfo),
          livePublicData: true,
          readinessOnly: true,
          validationForcedCandidate: true,
          productionEligible: false,
          autoEligible: true,
          top10Rank: sample.symbolInfo.top10Rank || null,
        };
      } catch (error) {
        if (isBinanceRestBlocked(error)) {
          restBlock = {
            state: String(error?.state || 'COOLDOWN'),
            blockedUntil: Number.isFinite(Number(error?.blockedUntil)) ? Number(error.blockedUntil) : null,
          };
          break;
        }
        if (isBinanceTransientDataFailure(error)) {
          outcomes.push({ candidate, outcome: marketDataFailureOutcome(error, candidate) });
          continue;
        }
        throw error;
      }
    }
    try {
      outcomes.push({ candidate, outcome: dryRunOutcome(await executeCandidate(candidate), candidate) });
    } catch (error) {
      if (!isWriterTransportFailure(error)) throw error;
      outcomes.push({ candidate, outcome: executionFailureOutcome(error, candidate) });
      writerBlock = permanentWriterBlock(error);
      if (writerBlock) break;
    }
  }
  const previewOutcome = outcomes.find(({ outcome }) => outcome.result === 'PUBLISHABLE_PREVIEW')?.outcome;
  const outcome = previewOutcome || outcomes[0]?.outcome || restBlockedOutcome(restBlock);
  const executionFailures = outcomes.filter(({ outcome: item }) => item.result === 'WRITER_UNAVAILABLE').length;
  const marketDataFailures = outcomes.filter(({ outcome: item }) => item.result === 'MARKET_DATA_UNAVAILABLE').length;
  const fullPipeline = !restBlock && !writerBlock && executionFailures === 0 && marketDataFailures === 0;
  return {
    ...outcome,
    ok: fullPipeline && outcome.ok === true,
    success: fullPipeline && outcome.success === true,
    source: 'Binance USD-M public market data',
    liveSymbols: ['BTCUSDT', 'ETHUSDT'],
    checks: {
      exchangeInfo: true,
      tickers24h: true,
      klines: true,
      finitePrices: true,
      publicData: true,
      fullPipeline,
      deepAnalysis: Boolean(deepAnalyzer),
      noPublishing: true,
      restBlocked: Boolean(restBlock),
      restBlock,
      writerBlocked: Boolean(writerBlock),
      writerBlock,
      sampledSymbols: samples.length,
      topTen: topTen.length,
      completedCandidates: outcomes.length,
      executionFailures,
      marketDataFailures,
    },
    candidates: outcomes.map(({ candidate, outcome: item }) => ({ symbol: candidate.symbol, top10Rank: candidate.top10Rank || null, result: item.result, pipeline: item.pipeline })),
    validationForcedCandidate: true,
    productionEligible: false,
    observedAt: clock(),
  };
}
