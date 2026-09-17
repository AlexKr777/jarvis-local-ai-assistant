function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value) {
  return Math.round(value * 1e8) / 1e8;
}

function tickSizeValue(value) {
  const tick = finite(value);
  return tick !== null && tick > 0 ? tick : null;
}

function quantizeToTick(value, tick, direction = 'nearest') {
  if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0) return value;
  const units = value / tick;
  const roundedUnits = direction === 'down' ? Math.floor(units + 1e-10)
    : direction === 'up' ? Math.ceil(units - 1e-10) : Math.round(units);
  return rounded(roundedUnits * tick);
}

function percentChange(value, reference) {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference === 0) return null;
  return rounded(((value - reference) / reference) * 100);
}

function range24h(ticker = {}) {
  const currentPrice = finite(ticker.lastPrice ?? ticker.price);
  const high = finite(ticker.highPrice ?? ticker.high);
  const low = finite(ticker.lowPrice ?? ticker.low);
  if (currentPrice === null || high === null || low === null || high <= low) return null;
  return Object.freeze({
    id: 'market:24h-range',
    low,
    high,
    currentPrice,
    position: rounded((currentPrice - low) / (high - low)),
    drawdownFromHighPct: percentChange(currentPrice, high),
  });
}

function swings(candles, timeframe) {
  const rows = Array.isArray(candles) ? candles : [];
  const result = [];
  for (let index = 1; index < rows.length - 1; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const next = rows[index + 1];
    const high = finite(current?.high);
    const low = finite(current?.low);
    if (high !== null && high >= finite(previous?.high) && high >= finite(next?.high)) {
      result.push({ side: 'resistance', price: high, timeframe, candleOpenTime: current.openTime, kind: 'swing_high' });
    }
    if (low !== null && low <= finite(previous?.low) && low <= finite(next?.low)) {
      result.push({ side: 'support', price: low, timeframe, candleOpenTime: current.openTime, kind: 'swing_low' });
    }
  }
  return result;
}

function inferredTick(points) {
  const ordered = [...new Set(points.map((point) => point.price ?? point.midpoint).filter(Number.isFinite))].sort((left, right) => left - right);
  const gaps = ordered.slice(1).map((value, index) => value - ordered[index]).filter((value) => value > 0);
  return gaps.length ? Math.min(...gaps) : 1e-8;
}

function toleranceFor(points, atr) {
  const values = points.map((point) => point.price).filter(Number.isFinite);
  if (!values.length) return 0;
  // Price areas scale with the instrument's present movement, not with a
  // fixed percentage of its nominal price. The inferred tick keeps a quiet
  // or flat series deterministic without inventing a percentage fallback.
  return Number.isFinite(atr) && atr > 0 ? Math.max(atr * 0.25, 1e-8) : inferredTick(points) * 2;
}

function cluster(points, side, atr) {
  const candidates = points.filter((point) => point.side === side).sort((left, right) => left.price - right.price);
  const tolerance = toleranceFor(candidates, atr);
  const clusters = [];
  for (const point of candidates) {
    const existing = clusters.at(-1);
    if (existing && Math.abs(point.price - existing.midpoint) <= tolerance) {
      existing.points.push(point);
      existing.midpoint = existing.points.reduce((sum, item) => sum + item.price, 0) / existing.points.length;
    } else clusters.push({ midpoint: point.price, points: [point] });
  }
  return clusters
    .filter((item) => item.points.length >= 2)
    .map((item, index) => {
      const prices = item.points.map((point) => point.price);
      const timeframes = [...new Set(item.points.map((point) => point.timeframe))];
      const timeframeScore = item.points.reduce((sum, point) => sum + ({ '5m': 1, '15m': 2, '1h': 3, '4h': 4 }[point.timeframe] || 1), 0);
      return Object.freeze({
        id: `level:${side}:${index + 1}`,
        side,
        priceLow: rounded(Math.min(...prices)),
        priceHigh: rounded(Math.max(...prices)),
        midpoint: rounded(item.midpoint),
        timeframes,
        touches: item.points.length,
        timeframeScore,
        totalScore: rounded(item.points.length * 10 + timeframeScore),
        evidence: item.points.map(({ candleOpenTime, kind, timeframe }) => ({ candleOpenTime, kind, timeframe })),
      });
    })
    .sort((left, right) => right.totalScore - left.totalScore || right.midpoint - left.midpoint);
}

function rangeLevel(side, price, range) {
  if (!range || !Number.isFinite(price)) return null;
  const label = side === 'resistance' ? '24h_high' : '24h_low';
  return Object.freeze({
    id: `level:${side}:${label}`,
    side,
    priceLow: rounded(price),
    priceHigh: rounded(price),
    midpoint: rounded(price),
    timeframes: ['24h'],
    touches: 1,
    timeframeScore: 4,
    totalScore: 4,
    evidence: [{ kind: label, timeframe: '24h', observedAt: null }],
  });
}

function distanceFromSpot(level, spot) {
  return Math.abs(level.midpoint - spot) / Math.max(Math.abs(spot), 1e-8);
}

function distancePctFromSpot(level, spot) {
  if (!Number.isFinite(spot)) return null;
  return rounded(distanceFromSpot(level, spot) * 100);
}

function minimumStructuralDistancePct(spot, atr) {
  if (!Number.isFinite(spot) || !Number.isFinite(atr) || spot === 0 || atr <= 0) return null;
  // A structural role has to be at least one current 5m true range away.
  // This is deliberately volatility-relative: 0.5% can be substantial for a
  // calm contract and ordinary noise for a volatile one.
  return rounded((atr / Math.abs(spot)) * 100);
}

function uniqueLevels(items) {
  return [...new Map(items.filter(Boolean).map((level) => [level.id, level])).values()];
}

function mergeOverlappingLevels(levels, atr) {
  const tolerance = Number.isFinite(atr) && atr > 0 ? atr * 0.5 : inferredTick(levels || []) * 2;
  const groups = [];
  for (const level of [...levels].filter(Boolean).sort((left, right) => left.priceLow - right.priceLow)) {
    const group = groups.at(-1);
    if (group && level.priceLow <= group.priceHigh + tolerance) {
      group.levels.push(level);
      group.priceHigh = Math.max(group.priceHigh, level.priceHigh);
    } else groups.push({ priceHigh: level.priceHigh, levels: [level] });
  }
  return groups.map(({ levels }) => {
    if (levels.length === 1) return levels[0];
    const primary = [...levels].sort((left, right) => right.totalScore - left.totalScore || left.id.localeCompare(right.id))[0];
    const evidence = levels.flatMap((level) => level.evidence);
    const touches = levels.reduce((sum, level) => sum + level.touches, 0);
    const weightedMidpoint = levels.reduce((sum, level) => sum + level.midpoint * level.touches, 0) / touches;
    return Object.freeze({
      ...primary,
      priceLow: rounded(Math.min(...levels.map((level) => level.priceLow))),
      priceHigh: rounded(Math.max(...levels.map((level) => level.priceHigh))),
      midpoint: rounded(weightedMidpoint),
      timeframes: [...new Set(levels.flatMap((level) => level.timeframes))],
      touches,
      timeframeScore: levels.reduce((sum, level) => sum + level.timeframeScore, 0),
      totalScore: rounded(levels.reduce((sum, level) => sum + level.totalScore, 0)),
      evidence,
    });
  });
}

function normalizePublicLevel(level, tick) {
  if (!Number.isFinite(tick) || tick <= 0) return level;
  const priceLow = quantizeToTick(level.priceLow, tick, 'down');
  const priceHigh = quantizeToTick(level.priceHigh, tick, 'up');
  const midpoint = Math.max(priceLow, Math.min(priceHigh, quantizeToTick(level.midpoint, tick)));
  return Object.freeze({ ...level, priceLow, priceHigh, midpoint, zoneLow: priceLow, zoneHigh: priceHigh, displayPrice: midpoint, tickSize: tick });
}

function recentReactionSupport(candles, atr) {
  const recent = (Array.isArray(candles) ? candles : []).slice(-24);
  const values = recent.map((candle) => ({ candle, low: finite(candle?.low) })).filter((entry) => entry.low !== null);
  if (values.length < 5 || !Number.isFinite(atr) || atr <= 0) return null;
  const reactionIndex = values.reduce((lowest, entry, index) => entry.low < values[lowest].low ? index : lowest, 0);
  // A first bar in a steady climb is merely an old observation. A local
  // reaction needs a preceding decline plus at least two closed bars of
  // recovery large enough to matter versus the current true range.
  if (reactionIndex < 1 || reactionIndex > values.length - 3) return null;
  const reaction = values[reactionIndex];
  const beforeClose = finite(values[reactionIndex - 1]?.candle?.close);
  const recoveryHigh = Math.max(...values.slice(reactionIndex + 1).map((entry) => finite(entry.candle?.close)).filter(Number.isFinite));
  if (beforeClose === null || beforeClose <= reaction.low || !Number.isFinite(recoveryHigh) || recoveryHigh - reaction.low < atr * 0.5) return null;
  return Object.freeze({
    id: 'level:support:recent_reaction', side: 'support',
    priceLow: rounded(reaction.low), priceHigh: rounded(reaction.low), midpoint: rounded(reaction.low),
    timeframes: ['5m'], touches: 1, timeframeScore: 1, totalScore: 1,
    evidence: [{ kind: 'recent_reaction_low', timeframe: '5m', candleOpenTime: reaction.candle.openTime }],
  });
}

function selectLevels({ supports, resistances, marketRange }) {
  const spot = marketRange?.currentPrice;
  if (!Number.isFinite(spot)) {
    return {
      supports: supports.slice(0, 2),
      resistances: resistances.slice(0, 2),
    };
  }

  const below = uniqueLevels(supports)
    .filter((level) => Number.isFinite(level.midpoint) && level.midpoint < spot);
  const above = uniqueLevels(resistances)
    .filter((level) => Number.isFinite(level.midpoint) && level.midpoint >= spot);

  const sortImmediate = (left, right) => distanceFromSpot(left, spot) - distanceFromSpot(right, spot)
    || (right.strengthScore ?? right.totalScore ?? 0) - (left.strengthScore ?? left.totalScore ?? 0);

  // The first qualified structure beyond the immediate reaction is the
  // invalidation boundary. A much older, heavily touched level can remain a
  // candidate, but must not displace nearer qualified structure merely by
  // accumulating historical touches.
  const sortStructural = (left, right) => distanceFromSpot(left, spot) - distanceFromSpot(right, spot)
    || (right.structuralScore ?? 0) - (left.structuralScore ?? 0)
    || (right.strengthScore ?? right.totalScore ?? 0) - (left.strengthScore ?? left.totalScore ?? 0);

  const immediateSupport = [...below].sort(sortImmediate)[0] || null;
  const immediateResistance = [...above].sort(sortImmediate)[0] || null;

  // Keep the closest levels as local reaction context, but never promote a
  // level inside the structural distance floor to structural invalidation or
  // next-watch. The public exclusion band is a hard 2%; ATR remains evidence
  // and a ranking input, not a second hard distance gate.
  const structuralSupport = [...below]
    .filter((level) => level.structuralEligible && level.id !== immediateSupport?.id)
    .sort(sortStructural)[0] || null;
  const structuralResistance = [...above]
    .filter((level) => level.structuralEligible)
    .sort(sortStructural)[0] || null;

  return {
    supports: uniqueLevels([immediateSupport, structuralSupport]),
    resistances: uniqueLevels([immediateResistance, structuralResistance]),
  };
}

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function atr14(candles) {
  const rows = (Array.isArray(candles) ? candles : [])
    .map((candle) => ({ high: finite(candle?.high), low: finite(candle?.low), close: finite(candle?.close) }))
    .filter((row) => row.high !== null && row.low !== null && row.close !== null);
  if (rows.length < 2) return null;
  const ranges = rows.slice(-14).map((row, index, selected) => {
    const previousClose = index === 0 ? rows[Math.max(0, rows.length - selected.length - 1)]?.close : selected[index - 1]?.close;
    return Math.max(row.high - row.low, Math.abs(row.high - previousClose), Math.abs(row.low - previousClose));
  });
  return rounded(ranges.reduce((sum, value) => sum + value, 0) / ranges.length);
}

function candleRows(candles) {
  return (Array.isArray(candles) ? candles : []).map((candle) => ({
    candle,
    high: finite(candle?.high),
    low: finite(candle?.low),
    close: finite(candle?.close),
    quoteVolume: finite(candle?.quoteVolume ?? candle?.volume),
    takerBuyQuoteVolume: finite(candle?.takerBuyQuoteVolume),
  })).filter((row) => row.high !== null && row.low !== null && row.close !== null);
}

function volumeEvidence(candles) {
  const rows = candleRows(candles);
  if (rows.length < 4) return Object.freeze({ trend: 'insufficient_data', latestRatio: null, recentMedian: null, priorMedian: null });
  const recent = rows.slice(-6).map((row) => row.quoteVolume).filter(Number.isFinite);
  const prior = rows.slice(-18, -6).map((row) => row.quoteVolume).filter(Number.isFinite);
  const recentMedian = median(recent);
  const priorMedian = median(prior);
  const latest = rows.at(-1)?.quoteVolume ?? null;
  const latestRatio = Number.isFinite(latest) && Number.isFinite(priorMedian) && priorMedian > 0 ? rounded(latest / priorMedian) : null;
  const change = Number.isFinite(recentMedian) && Number.isFinite(priorMedian) && priorMedian > 0 ? recentMedian / priorMedian : null;
  const trend = change === null ? 'insufficient_data' : change >= 1.25 ? 'expanding' : change <= 0.8 ? 'contracting' : 'steady';
  return Object.freeze({ trend, latestRatio, recentMedian, priorMedian, latestQuoteVolume: latest });
}

function takerFlowEvidence(candles) {
  const rows = candleRows(candles).slice(-12).filter((row) => Number.isFinite(row.quoteVolume) && Number.isFinite(row.takerBuyQuoteVolume));
  if (!rows.length) return Object.freeze({ bias: 'unavailable', buyShare: null, sampleSize: 0 });
  const total = rows.reduce((sum, row) => sum + row.quoteVolume, 0);
  const buys = rows.reduce((sum, row) => sum + row.takerBuyQuoteVolume, 0);
  if (total <= 0) return Object.freeze({ bias: 'unavailable', buyShare: null, sampleSize: rows.length });
  const buyShare = rounded(buys / total);
  return Object.freeze({
    bias: buyShare >= 0.56 ? 'buy_dominant' : buyShare <= 0.44 ? 'sell_dominant' : 'balanced',
    buyShare,
    sampleSize: rows.length,
  });
}

function momentumEvidence(candles) {
  const rows = candleRows(candles);
  if (rows.length < 6) return Object.freeze({ state: 'insufficient_data', recentReturnPct: null, priorReturnPct: null });
  const recent = rows.slice(-4);
  const prior = rows.slice(-8, -4);
  const recentReturnPct = percentChange(recent.at(-1).close, recent[0].close);
  const priorReturnPct = percentChange(prior.at(-1).close, prior[0].close);
  const sameDirection = Number.isFinite(recentReturnPct) && Number.isFinite(priorReturnPct) && Math.sign(recentReturnPct) === Math.sign(priorReturnPct);
  const state = !sameDirection ? 'steady'
    : Math.abs(recentReturnPct) > Math.abs(priorReturnPct) * 1.15 ? 'accelerating'
      : Math.abs(recentReturnPct) < Math.abs(priorReturnPct) * 0.75 ? 'decelerating' : 'steady';
  return Object.freeze({ state, recentReturnPct, priorReturnPct });
}

function enrichLevel(level, { candlesByTimeframe, spot, atr, volume }) {
  const evidenceRows = level.evidence.flatMap((entry) => {
    const row = (candlesByTimeframe?.[entry.timeframe] || []).find((candle) => candle?.openTime === entry.candleOpenTime);
    return row ? [{ ...entry, candle: row }] : [];
  });
  const touches = evidenceRows.length || level.touches;
  const recentTouchCount = evidenceRows.filter((entry) => {
    const rows = candlesByTimeframe?.[entry.timeframe] || [];
    return rows.slice(-12).some((candle) => candle?.openTime === entry.candleOpenTime);
  }).length;
  const wickReactionCount = evidenceRows.filter(({ candle }) => {
    const close = finite(candle?.close);
    if (close === null) return false;
    return level.side === 'support' ? close > level.midpoint : close < level.midpoint;
  }).length;
  const closeAbove = evidenceRows.filter(({ candle }) => finite(candle?.close) >= level.midpoint).length;
  const closeBehavior = !evidenceRows.length ? 'insufficient_data'
    : closeAbove === evidenceRows.length ? 'accepted_above'
      : closeAbove === 0 ? 'accepted_below' : 'mixed';
  const touchVolumes = evidenceRows.map(({ candle }) => finite(candle?.quoteVolume ?? candle?.volume)).filter(Number.isFinite);
  const touchMedian = median(touchVolumes);
  const baseline = volume?.priorMedian;
  const reactionRatio = Number.isFinite(touchMedian) && Number.isFinite(baseline) && baseline > 0 ? rounded(touchMedian / baseline) : null;
  const distance = Number.isFinite(spot) ? rounded(Math.abs(level.midpoint - spot)) : null;
  const distancePct = distancePctFromSpot(level, spot);
  const distanceATR = Number.isFinite(distance) && Number.isFinite(atr) && atr > 0 ? rounded(distance / atr) : null;
  const strengthScore = rounded(level.totalScore + touches * 2 + wickReactionCount + (recentTouchCount * 1.5));
  const confidence = strengthScore >= 30 ? 'high' : strengthScore >= 15 ? 'medium' : 'low';

  const structuralDistancePct = minimumStructuralDistancePct(spot, atr);
  const timeframeSet = new Set(Array.isArray(level.timeframes) ? level.timeframes : []);
  const multiTimeframe = timeframeSet.size >= 2;
  const higherTimeframe = [...timeframeSet].some((timeframe) => ['1h', '4h', '24h'].includes(timeframe));
  const verifiedRangeBoundary = [...timeframeSet].includes('24h');
  // Stronger, independently repeated structure can be useful closer to spot,
  // but a one-candle local extreme still needs a full current true range.
  const minimumStructuralDistanceATR = (multiTimeframe || higherTimeframe || verifiedRangeBoundary) ? 0.5 : 1;
  const tooClose = Number.isFinite(distanceATR) && distanceATR < minimumStructuralDistanceATR;
  const enoughPriceActionEvidence = multiTimeframe
    || higherTimeframe
    || verifiedRangeBoundary
    || touches >= 3
    || strengthScore >= 20;
  const structuralEligible = Number.isFinite(distanceATR) && !tooClose && enoughPriceActionEvidence;

  const tooClosePenalty = tooClose && Number.isFinite(distanceATR)
    ? rounded(20 + Math.max(0, minimumStructuralDistanceATR - distanceATR) * 10)
    : 0;
  const structuralScore = rounded(
    strengthScore
      + (level.timeframeScore || 0) * 2
      + (multiTimeframe ? 6 : 0)
      + (higherTimeframe ? 4 : 0)
      + (verifiedRangeBoundary ? 2 : 0)
      + (reactionRatio !== null && reactionRatio >= 1.5 ? 2 : 0)
      - tooClosePenalty,
  );
  const levelClass = structuralEligible ? 'structural' : tooClose ? 'micro_reaction' : 'weak_non_structural';

  return Object.freeze({
    ...level,
    zoneLow: level.priceLow,
    zoneHigh: level.priceHigh,
    displayPrice: level.midpoint,
    touchCount: touches,
    recentTouchCount,
    wickReactionCount,
    closeBehavior,
    previousRole: 'unknown',
    volumeReaction: Object.freeze({ relativeToBaseline: reactionRatio, classification: reactionRatio === null ? 'unavailable' : reactionRatio >= 1.5 ? 'elevated' : 'normal' }),
    distanceFromCurrentPrice: distance,
    distanceFromCurrentPricePct: distancePct,
    distanceATR,
    minimumStructuralDistanceATR,
    minimumStructuralDistancePct: structuralDistancePct,
    tooClosePenalty,
    levelClass,
    structuralEligible,
    structuralScore,
    strengthScore,
    confidence,
    evidenceCandleIds: Object.freeze(evidenceRows.map((entry) => `${entry.timeframe}:${entry.candleOpenTime}`)),
  });
}

function timeframeStructure(candles, timeframe) {
  const rows = (Array.isArray(candles) ? candles : [])
    .map((candle) => ({ candle, close: finite(candle?.close) }))
    .filter((entry) => entry.close !== null);
  if (rows.length < 3) return Object.freeze({ timeframe, direction: 'insufficient_data', phase: 'insufficient_data', swingState: 'insufficient_data', returnPct: null, impulsePct: null, candleCount: rows.length });
  const recent = rows.slice(-Math.min(rows.length, 8));
  const first = recent[0].close;
  const last = recent.at(-1).close;
  const change = percentChange(last, first);
  const positive = recent.slice(1).filter((entry, index) => entry.close > recent[index].close).length;
  const negative = recent.slice(1).filter((entry, index) => entry.close < recent[index].close).length;
  const direction = change > 0.35 && positive >= negative ? 'up' : change < -0.35 && negative >= positive ? 'down' : 'range';
  const impulse = percentChange(last, rows.at(-Math.min(rows.length, 4))?.close);
  const overallRange = Math.max(...recent.map((entry) => finite(entry.candle?.high) ?? entry.close)) - Math.min(...recent.map((entry) => finite(entry.candle?.low) ?? entry.close));
  const phase = Math.abs(impulse ?? 0) >= 1.2 ? 'impulse'
    : direction === 'range' && overallRange / Math.max(Math.abs(last), 1e-8) <= 0.015 ? 'consolidation'
      : direction === 'range' ? 'range' : 'pullback';
  const swingState = direction === 'up' ? 'higher_highs_higher_lows'
    : direction === 'down' ? 'lower_highs_lower_lows' : 'mixed';
  return Object.freeze({
    timeframe,
    direction,
    phase,
    swingState,
    returnPct: change,
    impulsePct: impulse,
    candleCount: rows.length,
    observedAt: recent.at(-1)?.candle?.closeTime ?? null,
  });
}

function structureByTimeframe(candlesByTimeframe) {
  return Object.freeze(Object.fromEntries(['5m', '15m', '1h', '4h'].map((timeframe) => [
    timeframe,
    timeframeStructure(candlesByTimeframe?.[timeframe], timeframe),
  ])));
}

function roleFor(level, role, why, response = null) {
  if (!level) return null;
  return Object.freeze({
    role,
    levelId: level.id,
    side: level.side,
    priceLow: level.priceLow,
    priceHigh: level.priceHigh,
    midpoint: level.midpoint,
    why,
    response,
  });
}

function selectEvidenceRoles(levels, marketRange) {
  const firstReaction = levels.supports?.[0] || null;
  const structuralInvalidation = (levels.supports || [])
    .find((level) => level.id !== firstReaction?.id && level.structuralEligible) || null;
  const nextWatch = (levels.resistances || [])
    .find((level) => level.structuralEligible) || null;

  return Object.freeze({
    firstReactionZone: roleFor(
      firstReaction,
      'first_reaction_zone',
      firstReaction?.levelClass === 'micro_reaction'
        ? 'Nearest deterministic reaction support below current price. It is intentionally kept as micro context and is not treated as structural invalidation.'
        : 'Nearest deterministic support below current price; its first retest is the immediate proof-or-failure point.',
    ),
    structuralInvalidation: roleFor(
      structuralInvalidation,
      'structural_invalidation',
      structuralInvalidation
        ? `Structurally qualified support outside the micro-distance band (minimum ${structuralInvalidation.minimumStructuralDistancePct}% from spot). Losing it removes the continuation structure rather than merely failing a local retest.`
        : null,
    ),
    nextWatch: roleFor(
      nextWatch,
      'next_watch',
      !nextWatch ? null
        : marketRange?.high === nextWatch?.midpoint
          ? 'Verified 24h high outside the micro-distance band; it is the next factual structural watch boundary, not a predicted target.'
          : `Structurally qualified resistance outside the micro-distance band (minimum ${nextWatch.minimumStructuralDistancePct}% from spot). It is the next meaningful area where acceptance or rejection can change the read.`,
    ),
  });
}

function latestPriceEvent(candles, marketRange) {
  const rows = (Array.isArray(candles) ? candles : [])
    .map((candle) => ({ candle, close: finite(candle?.close), high: finite(candle?.high), low: finite(candle?.low) }))
    .filter((entry) => entry.close !== null && entry.high !== null && entry.low !== null);
  if (rows.length < 4) return null;
  const latest = rows.at(-1);
  const prior = rows.slice(-7, -1);
  const priorHigh = Math.max(...prior.map((entry) => entry.high));
  const priorLow = Math.min(...prior.map((entry) => entry.low));
  if (latest.close > priorHigh) {
    return Object.freeze({
      id: 'event:local_breakout', kind: 'breakout', timeframe: '5m', direction: 'up', value: latest.close,
      evidence: [{ kind: 'close_above_prior_window_high', timeframe: '5m', candleOpenTime: latest.candle.openTime, priorHigh: rounded(priorHigh) }],
    });
  }
  if (latest.close < priorLow) {
    return Object.freeze({
      id: 'event:local_breakdown', kind: 'breakdown', timeframe: '5m', direction: 'down', value: latest.close,
      evidence: [{ kind: 'close_below_prior_window_low', timeframe: '5m', candleOpenTime: latest.candle.openTime, priorLow: rounded(priorLow) }],
    });
  }
  if (marketRange && latest.high >= marketRange.high * 0.998 && latest.close < marketRange.high) {
    return Object.freeze({
      id: 'event:near_high_rejection', kind: 'resistance_rejection', timeframe: '5m', direction: 'down', value: latest.close,
      evidence: [{ kind: 'tested_24h_high_then_closed_below', timeframe: '5m', candleOpenTime: latest.candle.openTime }],
    });
  }
  return null;
}

function technicalEvents({ candlesByTimeframe, marketRange, ticker }) {
  const events = [];
  const change24h = finite(ticker.priceChangePercent ?? ticker.priceChange24hPct);
  if (change24h !== null && Math.abs(change24h) >= 8) {
    events.push(Object.freeze({
      id: 'event:daily_runner', kind: change24h > 0 ? 'daily_runner' : 'daily_drawdown',
      timeframe: '24h', direction: change24h > 0 ? 'up' : 'down', value: rounded(change24h),
      evidence: [{ kind: 'ticker_change_24h', timeframe: '24h' }],
    }));
  }
  if (marketRange?.position >= 0.8) {
    events.push(Object.freeze({
      id: 'event:near_24h_high', kind: 'near_24h_high', timeframe: '24h', direction: 'up',
      value: marketRange.position, evidence: [{ kind: 'range_position', timeframe: '24h' }],
    }));
  }
  if (marketRange?.drawdownFromHighPct <= -2) {
    events.push(Object.freeze({
      id: 'event:pullback_from_24h_high', kind: 'pullback_from_24h_high', timeframe: '24h', direction: 'down',
      value: marketRange.drawdownFromHighPct, evidence: [{ kind: 'drawdown_from_24h_high', timeframe: '24h' }],
    }));
  }
  const fiveMinute = Array.isArray(candlesByTimeframe['5m']) ? candlesByTimeframe['5m'] : [];
  const volumes = fiveMinute.map((candle) => finite(candle?.quoteVolume ?? candle?.volume));
  const lastVolume = volumes.at(-1);
  const baselineVolume = median(volumes.slice(-49, -1));
  if (Number.isFinite(lastVolume) && Number.isFinite(baselineVolume) && baselineVolume > 0 && lastVolume >= baselineVolume * 2) {
    events.push(Object.freeze({
      id: 'event:unusual_5m_volume', kind: 'unusual_volume', timeframe: '5m', direction: null,
      value: rounded(lastVolume / baselineVolume), evidence: [{ kind: 'relative_quote_volume', timeframe: '5m' }],
    }));
  }
  const localEvent = latestPriceEvent(fiveMinute, marketRange);
  if (localEvent) events.push(localEvent);
  return Object.freeze(events);
}

export function analyzeTechnicalContext({ symbol, candlesByTimeframe = {}, ticker = {}, tickSize = null } = {}) {
  if (typeof symbol !== 'string' || !symbol) throw new TypeError('Technical context requires a symbol.');

  const points = Object.entries(candlesByTimeframe).flatMap(([timeframe, candles]) => swings(candles, timeframe));
  const marketRange = range24h(ticker);
  const currentPrice = marketRange?.currentPrice ?? finite(ticker.lastPrice ?? ticker.price);
  const atr = atr14(candlesByTimeframe['5m']);
  const volume = volumeEvidence(candlesByTimeframe['5m']);

  // Enrich every candidate before selection. The old flow selected by
  // proximity first and only then calculated ATR/strength data, which allowed
  // tiny local levels to become structural roles.
  const rawSupportCandidates = mergeOverlappingLevels(uniqueLevels([
    recentReactionSupport(candlesByTimeframe['5m'], atr),
    ...cluster(points, 'support', atr),
    rangeLevel('support', marketRange?.low, marketRange),
  ]), atr);
  const rawResistanceCandidates = mergeOverlappingLevels(uniqueLevels([
    rangeLevel('resistance', marketRange?.high, marketRange),
    ...cluster(points, 'resistance', atr),
  ]), atr);

  const enrichedCandidates = Object.freeze({
    supports: Object.freeze(rawSupportCandidates.map((level) => enrichLevel(level, {
      candlesByTimeframe, spot: currentPrice, atr, volume,
    }))),
    resistances: Object.freeze(rawResistanceCandidates.map((level) => enrichLevel(level, {
      candlesByTimeframe, spot: currentPrice, atr, volume,
    }))),
  });

  const selected = selectLevels({
    supports: enrichedCandidates.supports,
    resistances: enrichedCandidates.resistances,
    marketRange,
  });
  const publicTickSize = tickSizeValue(tickSize);
  const selectedLevels = Object.freeze({
    supports: Object.freeze(selected.supports.map((level) => normalizePublicLevel(level, publicTickSize))),
    resistances: Object.freeze(selected.resistances.map((level) => normalizePublicLevel(level, publicTickSize))),
  });

  const roles = selectEvidenceRoles(selectedLevels, marketRange);
  const structure = structureByTimeframe(candlesByTimeframe);
  const distanceFromLowPct = marketRange ? percentChange(currentPrice, marketRange.low) : null;
  const publicLevelIds = Object.freeze([...new Set([
    roles.firstReactionZone?.levelId,
    roles.structuralInvalidation?.levelId,
    roles.nextWatch?.levelId,
  ].filter(Boolean))]);

  return Object.freeze({
    symbol,
    market: Object.freeze({
      range24h: marketRange,
      drawdownFromHighPct: marketRange?.drawdownFromHighPct ?? null,
      distanceFrom24hLowPct: distanceFromLowPct,
      volatility: Object.freeze({
        atr14: atr,
        atr14Pct: Number.isFinite(atr) && Number.isFinite(currentPrice) && currentPrice !== 0
          ? rounded((atr / Math.abs(currentPrice)) * 100) : null,
        minimumStructuralDistancePct: minimumStructuralDistancePct(currentPrice, atr),
      }),
    }),
    levels: Object.freeze(selectedLevels),
    evidence: Object.freeze({
      structure,
      roles,
      zones: Object.freeze([...selectedLevels.supports, ...selectedLevels.resistances]),
      candidateZones: Object.freeze([...enrichedCandidates.supports, ...enrichedCandidates.resistances]),
      momentum: momentumEvidence(candlesByTimeframe['5m']),
      volume,
      takerFlow: takerFlowEvidence(candlesByTimeframe['5m']),
    }),
    technicalEvents: technicalEvents({ candlesByTimeframe, marketRange, ticker }),
    publicLevelIds,
  });
}
