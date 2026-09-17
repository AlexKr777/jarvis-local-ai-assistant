import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { CHART_PRESETS, renderCryptoChart, selectChartSeries } from '../src/crypto/charts/chart-renderer.js';

function candles({ flat = false } = {}) {
  return Array.from({ length: 72 }, (_, index) => {
    const open = flat ? 100 : 100 + Math.sin(index / 5) * 4 + index * 0.12;
    const close = flat ? 100 : open + Math.sin(index * 1.7) * 1.4;
    return {
      openTime: Date.UTC(2026, 7, 20, 10) + index * 60_000,
      open,
      high: Math.max(open, close) + (flat ? 0 : 0.8),
      low: Math.min(open, close) - (flat ? 0 : 0.8),
      close,
      quoteVolume: 100_000 + index * 7_500,
    };
  });
}

function fourHourRunnerCandles() {
  return Array.from({ length: 90 }, (_, index) => {
    const base = index < 65 ? 100 + index * 0.04 : 102.6 + (index - 65) * 1.05;
    const close = index >= 86 ? base - (index - 85) * 0.24 : base + 0.12;
    const open = close - 0.16;
    return {
      openTime: Date.UTC(2026, 7, 10) + index * 4 * 60 * 60_000,
      open, high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.25, close,
      quoteVolume: 100_000 + index * 7_500,
    };
  });
}

function staleFourHourPeakCandles() {
  return Array.from({ length: 90 }, (_, index) => {
    const base = index < 44 ? 100 + index * 2 : index < 70 ? 185 - (index - 44) * 2.6 : 117 + (index - 70) * 0.35;
    const open = base;
    const close = base + (index % 2 ? 0.18 : -0.08);
    return {
      openTime: Date.UTC(2026, 7, 10) + index * 4 * 60 * 60_000,
      open, high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3, close,
      quoteVolume: 100_000 + index * 7_500,
    };
  });
}

function freshHourlyPeakCandles() {
  return Array.from({ length: 96 }, (_, index) => {
    const base = index < 76 ? 100 + Math.sin(index / 4) * 2 : 102 + (index - 76) * 2.5;
    const open = base;
    const close = base + (index >= 76 ? 1.5 : (index % 2 ? 0.25 : -0.12));
    return {
      openTime: Date.UTC(2026, 7, 10) + index * 60 * 60_000,
      open, high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3, close,
      quoteVolume: 100_000 + index * 7_500,
    };
  });
}


function recentRightEdgeHeroCandles({ olderHigherIndex = 78 } = {}) {
  return Array.from({ length: 96 }, (_, index) => {
    const base = 100 + index * 0.06 + Math.sin(index / 4) * 0.2;
    const open = base;
    const close = base + (index % 3 === 0 ? 0.12 : -0.04);
    let high = Math.max(open, close) + 0.28;
    let low = Math.min(open, close) - 0.28;
    if (index === olderHigherIndex) high = 120;
    if (index === 91) {
      high = 118;
      low = Math.min(low, 116.8);
    }
    if (index >= 92) high = Math.min(high, 117.2 - (index - 92) * 0.08);
    return {
      openTime: Date.UTC(2026, 7, 20) + index * 15 * 60_000,
      open, high, low, close,
      quoteVolume: 100_000 + index * 2_000,
    };
  });
}

function candidate(overrides = {}) {
  return {
    id: 'candidate-1',
    symbol: 'BTCUSDT',
    cashtag: '$BTC',
    score: 91,
    direction: 'up',
    metrics: { candles: candles(), return5mPct: 2.14, volume5mUsd: 9_200_000 },
    openInterestSeries: Array.from({ length: 72 }, (_, index) => 1_000_000 + index * 4_000),
    liquidations: [{ occurredAt: Date.UTC(2026, 7, 20, 10, 40), notionalUsd: 2_400_000, side: 'SELL' }],
    claimsAllowed: [{ key: 'return5m', display: '+2.14%' }],
    ...overrides,
  };
}

function pngSize(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('renderer supports all five contract presets at 1200x900', async () => {
  assert.deepEqual(CHART_PRESETS, ['price_oi_divergence', 'volume_shock', 'timeline_mystery', 'liquidation_burst', 'receipt']);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-charts-'));
  for (const preset of CHART_PRESETS) {
    const outputPath = path.join(directory, `${preset}.png`);
    const result = await renderCryptoChart({
      candidate: candidate(),
      visualIntent: { preset, revealOnOpen: preset === 'timeline_mystery' },
      outputPath,
    });
    const buffer = await readFile(outputPath);
    assert.deepEqual(pngSize(buffer), { width: 1200, height: 900 });
    assert.equal(result.preset, preset);
    assert.equal(result.safeAreaPx, 60);
    assert.ok(buffer.length > 25_000);
    assert.ok(result.labels.includes('BINANCE FUTURES DATA / CUSTOM CHART'));
    assert.ok(result.labels.includes('1 MIN CANDLES / UP TO 5H VIEW'));
    assert.ok(result.labels.every((label) => !/order book|balance|official binance/i.test(label)));
  }
});

test('same facts render byte-identical deterministic charts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-deterministic-'));
  const one = path.join(directory, 'one.png');
  const two = path.join(directory, 'two.png');
  const input = { candidate: candidate(), visualIntent: { preset: 'volume_shock', revealOnOpen: false } };
  await renderCryptoChart({ ...input, outputPath: one });
  await renderCryptoChart({ ...input, outputPath: two });
  const hashes = await Promise.all([one, two].map(async (file) => createHash('sha256').update(await readFile(file)).digest('hex')));
  assert.equal(hashes[0], hashes[1]);
});

test('renderer prefers a fresh 15m hero over higher-timeframe alternatives when the lower timeframe is usable', async () => {
  const source = candidate({
    metrics: {
      candles: candles(),
      chartCandles: { '15m': candles(), '1h': freshHourlyPeakCandles(), '4h': staleFourHourPeakCandles() },
      return5mPct: 2.14, volume5mUsd: 9_200_000,
    },
  });
  const selected = selectChartSeries(source);
  assert.equal(selected.timeframe, '15m');
  assert.equal(selected.label, '15 MIN CANDLES / UP TO 24H VIEW');
  assert.equal(selected.candles.length, 72, 'a usable lower timeframe remains preferred instead of being replaced by 1h/4h quality scoring');
  assert.equal(selected.freshPeakIndex, 71);
});

test('renderer chooses the final meaningful right-edge peak even when a nearby older spike is slightly higher', () => {
  const fifteenMinute = recentRightEdgeHeroCandles({ olderHigherIndex: 78 });
  const source = candidate({
    metrics: { candles: candles(), chartCandles: { '15m': fifteenMinute } },
  });

  const selected = selectChartSeries(source);
  assert.equal(selected.timeframe, '15m');
  assert.equal(selected.candles.length, 96, 'a nearby older high stays as useful recent context');
  assert.equal(selected.heroPeakHigh, 118);
  assert.equal(selected.candles[selected.heroPeakIndex].high, 118);
  assert.equal(Math.max(...selected.candles.map((candle) => candle.high)), 120, 'the older nearby spike may remain visible without becoming the hero');
});

test('renderer never crops recent context below sixty candles just to hide an older higher high', () => {
  const fifteenMinute = recentRightEdgeHeroCandles({ olderHigherIndex: 50 });
  const source = candidate({
    metrics: { candles: candles(), chartCandles: { '15m': fifteenMinute } },
  });

  const selected = selectChartSeries(source);
  assert.equal(selected.timeframe, '15m');
  assert.ok(selected.candles.length >= 60, 'public chart keeps enough candles to remain readable');
  assert.equal(selected.heroPeakHigh, 118);
});

test('Story-driven historical arrow points at the selected final hero peak, not the highest older candle', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-final-hero-arrow-'));
  const fifteenMinute = recentRightEdgeHeroCandles({ olderHigherIndex: 78 });
  const result = await renderCryptoChart({
    candidate: candidate({
      direction: 'up',
      metrics: { candles: candles(), chartCandles: { '15m': fifteenMinute } },
    }),
    factPack: {
      levels: {
        supports: [
          { id: 'reaction', midpoint: 110, evidence: [{}] },
          { id: 'invalidation', midpoint: 106, evidence: [{}] },
        ],
        resistances: [{ id: 'watch', midpoint: 116, evidence: [{}] }],
      },
    },
    finalStory: {
      spine: {
        storyBrief: {
          valid: true,
          firstReactionZone: { role: 'first_reaction_zone', levelId: 'reaction', midpoint: 110 },
          structuralInvalidation: { role: 'structural_invalidation', levelId: 'invalidation', midpoint: 106 },
          nextWatch: { role: 'next_watch', levelId: 'watch', midpoint: 116 },
        },
      },
    },
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'final-hero.png'),
  });

  assert.equal(result.annotation.type, 'historical_peak_arrow');
  assert.equal(result.annotation.heroPeakArrow.peak.price, 118);
  assert.notEqual(result.annotation.heroPeakArrow.peak.price, 120);
});

test('renderer can use a complete dense five-minute view for a fresh story without synthetic cropping', () => {
  const fiveMinute = Array.from({ length: 120 }, (_, index) => ({
    openTime: Date.UTC(2026, 7, 20, 10) + index * 5 * 60_000,
    open: 100 + index * 0.18, high: 101 + index * 0.18, low: 99.8 + index * 0.18,
    close: 100.4 + index * 0.18, quoteVolume: 100_000 + index * 1_000,
  }));
  const source = candidate({
    metrics: { candles: candles(), chartCandles: { '5m': fiveMinute } },
  });
  const selected = selectChartSeries(source);
  assert.equal(selected.timeframe, '5m');
  assert.equal(selected.candles.length, 96);
  assert.equal(selected.label, '5 MIN CANDLES / UP TO 8H VIEW');
});

test('readiness charts identify the artifact as a non-published public-data dry run', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-readiness-chart-'));
  const result = await renderCryptoChart({
    candidate: candidate({ readinessOnly: true, score: 42 }),
    visualIntent: { preset: 'volume_shock', revealOnOpen: false },
    outputPath: path.join(directory, 'readiness.png'),
  });
  assert.ok(result.labels.includes('PUBLIC DATA / DRY RUN'));
  assert.ok(result.labels.includes('DRY RUN / NOT PUBLISHED'));
  assert.equal(result.labels.some((label) => /ANOMALY SCORE 96/.test(label)), false);
});

test('every chart preset renders one centered 24h hero without a 15-minute header or marker', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-receipt-hero-'));
  for (const preset of CHART_PRESETS) {
    const result = await renderCryptoChart({
      candidate: candidate({
        symbol: 'ADAUSDT', cashtag: '$ADA', readinessOnly: true,
        claimsAllowed: [
          { key: 'return24h', display: '+10.47%', timeframe: '24h' },
          { key: 'return15m', display: '+0.67%', timeframe: '15m' },
        ],
      }),
      visualIntent: { preset, revealOnOpen: false },
      outputPath: path.join(directory, `ada-${preset}.png`),
    });
    const labels = result.labels.join(' | ');
    assert.match(labels, /\+10\.47% LAST 24H/);
    assert.doesNotMatch(labels, /LAST 15 MIN|\+0\.67%/);
  }
});

test('a final volume-shock story renders only its authorized hero metric and never OI context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-final-story-chart-'));
  const result = await renderCryptoChart({
    candidate: candidate({
      claimsAllowed: [
        { key: 'volumeRatio', display: '13.6x', timeframe: '5m' },
        { key: 'return15m', display: '-0.18%', timeframe: '15m' },
        { key: 'return4h', display: '+6.27%', timeframe: '4h' },
        { key: 'openInterestChange', display: '+10.26%', timeframe: '4h' },
      ],
    }),
    finalStory: {
      storyFamily: 'contained_damage',
      allowedChartEvidence: ['volumeRatio', 'return15m', 'return4h'],
      heroMetric: { key: 'volumeRatio', display: '13.6x', timeframe: '5m' },
    },
    visualIntent: { preset: 'volume_shock', revealOnOpen: false, relationship: 'none' },
    outputPath: path.join(directory, 'btc-volume-shock.png'),
  });
  const labels = result.labels.join(' | ');
  assert.match(labels, /13\.6X VOLUME \/ 5M/);
  assert.doesNotMatch(labels, /OPEN INTEREST|LAST 15 MIN|\+10\.26%/);
});

test('a level-only final story never adds an unused 24h metric to its chart header', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-level-only-story-'));
  const result = await renderCryptoChart({
    candidate: candidate({
      claimsAllowed: [{ key: 'return24h', display: '+10.47%', timeframe: '24h' }],
    }),
    finalStory: {
      storyFamily: 'technical_thesis',
      allowedChartEvidence: ['level:support:near', 'level:resistance:next'],
      heroMetric: null,
    },
    visualIntent: { preset: 'receipt', revealOnOpen: false, relationship: 'none' },
    outputPath: path.join(directory, 'level-only.png'),
  });
  assert.doesNotMatch(result.labels.join(' | '), /\+10\.47%|LAST 24H/);
});

test('flat and extreme candles remain renderable inside the safe chart area', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-edge-chart-'));
  const flatPath = path.join(directory, 'flat.png');
  const extremePath = path.join(directory, 'extreme.png');
  await renderCryptoChart({ candidate: candidate({ metrics: { candles: candles({ flat: true }), return5mPct: 0, volume5mUsd: 1 } }), visualIntent: { preset: 'receipt', revealOnOpen: false }, outputPath: flatPath });
  const extreme = candles().map((item, index) => ({ ...item, high: index === 30 ? 1_000_000 : item.high, low: index === 31 ? 0.00001 : item.low }));
  await renderCryptoChart({ candidate: candidate({ metrics: { candles: extreme, return5mPct: -88, volume5mUsd: 1e12 } }), visualIntent: { preset: 'liquidation_burst', revealOnOpen: true }, outputPath: extremePath });
  assert.deepEqual(pngSize(await readFile(flatPath)), { width: 1200, height: 900 });
  assert.deepEqual(pngSize(await readFile(extremePath)), { width: 1200, height: 900 });
});

test('renderer rejects missing or non-finite market facts instead of drawing fiction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-invalid-chart-'));
  await assert.rejects(() => renderCryptoChart({ candidate: candidate({ metrics: { candles: [{ open: 1, high: 1, low: 1, close: 1 }] } }), visualIntent: { preset: 'receipt', revealOnOpen: false }, outputPath: path.join(directory, 'bad.png') }), /at least two valid candles/i);
  const invalid = candles();
  invalid[4].high = Number.NaN;
  await assert.rejects(() => renderCryptoChart({ candidate: candidate({ metrics: { candles: invalid } }), visualIntent: { preset: 'receipt', revealOnOpen: false }, outputPath: path.join(directory, 'nan.png') }), /finite candle/i);
  await assert.rejects(() => renderCryptoChart({ candidate: candidate(), visualIntent: { preset: 'unknown', revealOnOpen: false }, outputPath: path.join(directory, 'unknown.png') }), /unsupported chart preset/i);
});

test('public conflict chart is market-first, hides internal scoring, and preserves exact source labels', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-public-quality-'));
  const source = candidate({
    symbol: 'ROBOUSDT',
    cashtag: '$ROBO',
    score: 88,
    direction: 'down',
    metrics: { candles: candles(), return5mPct: -3.43, return15mPct: -3.81 },
    openInterestChangePct: 9.286618935273228,
    takerBuySellRatio: 0.6775,
    openInterestSeries: Array.from({ length: 24 }, (_, index) => 7_710_062.5739072 + index * 31_130.6143873861),
    claimsAllowed: [
      { key: 'return24h', display: '+14.75%', timeframe: '24h' },
      { key: 'return15m', display: '-3.81%', timeframe: '15m' },
      { key: 'openInterestChange', display: '+9.29%', timeframe: '2h' },
    ],
  });
  const result = await renderCryptoChart({
    candidate: source,
    visualIntent: { preset: 'price_oi_divergence', revealOnOpen: true, relationship: 'price_down_oi_up' },
    outputPath: path.join(directory, 'robo.png'),
  });
  const publicLabels = result.labels.join(' | ');
  assert.doesNotMatch(publicLabels, /anomaly|score|confidence|rank/i);
  assert.match(publicLabels, /\+14\.75% LAST 24H/);
  assert.doesNotMatch(publicLabels, /LAST 15 MIN|-3\.81%/);
  assert.match(publicLabels, /OPEN INTEREST \+9\.29% \/ 2H/);
  assert.doesNotMatch(publicLabels, /PICK ONE|CHOOSE|A LONGS|B FRESH|BETTER|VERDICT|ANSWER|LONGS EXITING|FRESH SHORTS/i);
  assert.equal(result.relationship, 'price_down_oi_up');
  assert.ok(result.marketVisualizationRatio >= 0.6 && result.marketVisualizationRatio <= 0.75);
});

test('a fresh upside impulse gets one bullish arrow and one watch-level price badge', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-bullish-scenario-chart-'));
  const result = await renderCryptoChart({
    candidate: candidate({
      freshUpsideImpulsePriority: true,
      claimsAllowed: [{ key: 'return4h', display: '+10.08%', timeframe: '4h' }],
    }),
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'bullish-scenario.png'),
  });

  assert.equal(result.annotation.type, 'bullish_scenario_arrow');
  assert.ok([0, 1, 2].includes(result.annotation.variation));
  assert.ok(result.annotation.target.y >= 160 && result.annotation.target.y <= 205, 'the factual peak is drawn close to the top of the chart');
  assert.ok(result.annotation.target.peak.x - result.annotation.target.x >= 28, 'the arrow tip stays left of the peak candle wick');
  assert.ok(result.annotation.target.peak.y - result.annotation.target.y >= 10, 'the arrow tip stays above the peak candle wick');
  assert.ok(result.annotation.head.every((point) => point.x < result.annotation.target.x), 'the arrowhead stays left of the peak candle');
  assert.ok(result.annotation.start.y - result.annotation.target.y >= 160, 'arrow is large enough to read as the main annotation');
  assert.ok(result.annotation.watchLabel.y + result.annotation.watchLabel.height <= result.annotation.target.y - 8, 'watch label sits directly above the arrow target');
  assert.ok(Math.abs((result.annotation.watchLabel.x + result.annotation.watchLabel.width / 2) - result.annotation.target.x) <= 1, 'watch label is centered directly over the arrow target');
  assert.match(result.labels.join(' | '), /WATCH \$\d/);
  assert.doesNotMatch(result.labels.join(' | '), /scenario|2x|2×|opinion|guarantee|target/i);
});

test('Fact Pack levels become chart annotations and replace the synthetic x2 watch price', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-fact-pack-chart-'));
  const result = await renderCryptoChart({
    candidate: candidate({ freshUpsideImpulsePriority: true }),
    factPack: { levels: { supports: [{ id: 'level:support:1', midpoint: 102, evidence: [{}] }], resistances: [{ id: 'level:resistance:1', midpoint: 110, evidence: [{}] }] } },
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'fact-pack.png'),
  });
  assert.match(result.labels.join(' | '), /SUPPORT \$102\.00|RESISTANCE \$110\.00/);
  assert.match(result.labels.join(' | '), /WATCH \$110\.00/);
  assert.ok(result.annotation.factIds.includes('level:resistance:1'));
});

test('story chart refuses a role whose level is absent from the Fact Pack', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-chart-role-boundary-'));
  const result = await renderCryptoChart({
    candidate: candidate({ direction: 'up' }),
    factPack: {
      levels: {
        supports: [{ id: 'reaction', midpoint: 102, evidence: [{}] }],
        resistances: [{ id: 'watch', midpoint: 110, evidence: [{}] }],
      },
    },
    finalStory: {
      spine: {
        storyBrief: {
          valid: true,
          firstReactionZone: { role: 'first_reaction_zone', levelId: 'reaction', midpoint: 102 },
          structuralInvalidation: { role: 'structural_invalidation', levelId: 'not-in-fact-pack', midpoint: 98 },
          nextWatch: { role: 'next_watch', levelId: 'watch', midpoint: 110 },
        },
      },
    },
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'role-boundary.png'),
  });
  assert.equal(result.technicalLevels.some((level) => level.id === 'not-in-fact-pack'), false);
  assert.equal(result.technicalLevels.length, 2);
});

test('Story-driven chart uses deterministic role labels and a historical peak arrow once watch is already exceeded', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-story-driven-chart-'));
  const sourceCandles = candles();
  const factualHigh = Math.max(...sourceCandles.map((item) => item.high));
  const result = await renderCryptoChart({
    candidate: candidate({ direction: 'up', metrics: { candles: sourceCandles } }),
    factPack: {
      levels: {
        supports: [
          { id: 'reaction', midpoint: 102, evidence: [{}] },
          { id: 'invalidation', midpoint: 98, evidence: [{}] },
        ],
        resistances: [{ id: 'watch', midpoint: 110, evidence: [{}] }],
      },
    },
    finalStory: {
      spine: {
        storyBrief: {
          valid: true,
          firstReactionZone: { role: 'first_reaction_zone', levelId: 'reaction', midpoint: 102 },
          structuralInvalidation: { role: 'structural_invalidation', levelId: 'invalidation', midpoint: 98 },
          nextWatch: { role: 'next_watch', levelId: 'watch', midpoint: 110 },
        },
      },
    },
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'story-driven.png'),
  });

  assert.equal(result.annotation.type, 'historical_peak_arrow');
  assert.equal(result.annotation.lineStyle, 'solid');
  assert.equal(result.annotation.heroPeakArrow.peak.price, factualHigh);
  assert.match(result.labels.join(' | '), /REACTION \$102\.00/);
  assert.match(result.labels.join(' | '), /INVALIDATION \$98\.00/);
  assert.match(result.labels.join(' | '), /WATCH \$110\.00/);
  assert.doesNotMatch(result.labels.join(' | '), /SUPPORT|RESISTANCE/);
  assert.deepEqual(result.annotation.factIds.sort(), ['invalidation', 'reaction', 'watch']);
});

test('Story-driven chart separates stacked role labels when deterministic levels are nearly identical', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-story-label-spacing-'));
  const result = await renderCryptoChart({
    candidate: candidate({ direction: 'up' }),
    factPack: {
      levels: {
        supports: [
          { id: 'reaction', midpoint: 104.01, evidence: [{}] },
          { id: 'invalidation', midpoint: 104.00, evidence: [{}] },
        ],
        resistances: [{ id: 'watch', midpoint: 104.02, evidence: [{}] }],
      },
    },
    finalStory: {
      spine: {
        storyBrief: {
          valid: true,
          firstReactionZone: { role: 'first_reaction_zone', levelId: 'reaction', midpoint: 104.01 },
          structuralInvalidation: { role: 'structural_invalidation', levelId: 'invalidation', midpoint: 104.00 },
          nextWatch: { role: 'next_watch', levelId: 'watch', midpoint: 104.02 },
        },
      },
    },
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'story-label-spacing.png'),
  });

  const labelYs = result.technicalLevels.map((level) => level.labelY).sort((left, right) => left - right);
  assert.equal(labelYs.length, 3);
  assert.ok(labelYs[1] - labelYs[0] >= 14);
  assert.ok(labelYs[2] - labelYs[1] >= 14);
});

test('Story-driven chart keeps the reached next-watch label visible and points a solid arrow at the factual high', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-story-watch-high-'));
  const sourceCandles = candles();
  const factualHigh = Math.max(...sourceCandles.map((item) => item.high));
  const result = await renderCryptoChart({
    candidate: candidate({ metrics: { candles: sourceCandles, return5mPct: 2.14, volume5mUsd: 9_200_000 } }),
    factPack: {
      levels: {
        supports: [
          { id: 'reaction', midpoint: factualHigh - 4, evidence: [{}] },
          { id: 'invalidation', midpoint: factualHigh - 6, evidence: [{}] },
        ],
        resistances: [{ id: 'watch', midpoint: factualHigh, evidence: [{}] }],
      },
    },
    finalStory: {
      spine: {
        storyBrief: {
          valid: true,
          firstReactionZone: { role: 'first_reaction_zone', levelId: 'reaction', midpoint: factualHigh - 4 },
          structuralInvalidation: { role: 'structural_invalidation', levelId: 'invalidation', midpoint: factualHigh - 6 },
          nextWatch: { role: 'next_watch', levelId: 'watch', midpoint: factualHigh },
        },
      },
    },
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'story-watch-high.png'),
  });

  assert.match(result.labels.join(' | '), /WATCH \$\d/);
  assert.equal(result.annotation.type, 'historical_peak_arrow');
  assert.equal(result.annotation.lineStyle, 'solid');
  assert.equal(result.annotation.heroPeakArrow.peak.price, factualHigh);
});

test('Story-driven chart keeps a compact dashed future scenario only while next watch remains above the factual high', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-story-future-watch-'));
  const sourceCandles = candles();
  const factualHigh = Math.max(...sourceCandles.map((item) => item.high));
  const futureWatch = factualHigh + 0.5;
  const result = await renderCryptoChart({
    candidate: candidate({ metrics: { candles: sourceCandles, return5mPct: 2.14, volume5mUsd: 9_200_000 } }),
    factPack: {
      levels: {
        supports: [
          { id: 'reaction', midpoint: factualHigh - 4, evidence: [{}] },
          { id: 'invalidation', midpoint: factualHigh - 6, evidence: [{}] },
        ],
        resistances: [{ id: 'watch', midpoint: futureWatch, evidence: [{}] }],
      },
    },
    finalStory: {
      spine: {
        storyBrief: {
          valid: true,
          firstReactionZone: { role: 'first_reaction_zone', levelId: 'reaction', midpoint: factualHigh - 4 },
          structuralInvalidation: { role: 'structural_invalidation', levelId: 'invalidation', midpoint: factualHigh - 6 },
          nextWatch: { role: 'next_watch', levelId: 'watch', midpoint: futureWatch },
        },
      },
    },
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'story-future-watch.png'),
  });

  assert.equal(result.annotation.type, 'conditional_scenario_arrow');
  assert.equal(result.annotation.lineStyle, 'dashed');
  assert.equal(result.annotation.heroPeakArrow.lineStyle, 'solid');
  assert.equal(result.annotation.heroPeakArrow.peak.price, factualHigh);
  assert.ok(Math.abs(result.annotation.end.x - result.annotation.start.x) <= 150, 'future scenario arrow stays compact');
});

test('Fact Pack charts omit a watch price when no evidence-backed resistance exists', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-no-watch-zone-'));
  const result = await renderCryptoChart({
    candidate: candidate({ freshUpsideImpulsePriority: true }),
    factPack: { levels: { supports: [], resistances: [] } },
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'no-watch-zone.png'),
  });
  assert.equal(result.annotation.watchLabel, undefined);
  assert.doesNotMatch(result.labels.join(' | '), /WATCH \$/);
});

test('every positive public candidate gets one bullish arrow even without fresh-impulse priority', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-positive-arrow-'));
  const result = await renderCryptoChart({
    candidate: candidate({ freshUpsideImpulsePriority: false, direction: 'up', score: 75 }),
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'positive-runner.png'),
  });

  assert.equal(result.annotation.type, 'bullish_scenario_arrow');
});

test('positive charts rotate between bold curved, medium curved, and slim straight arrow styles', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-arrow-styles-'));
  const results = await Promise.all(['style-a', 'style-b', 'style-c'].map(async (id) => renderCryptoChart({
    candidate: candidate({ id }),
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, `${id}.png`),
  })));

  assert.deepEqual(results.map((result) => result.annotation.style).sort(), ['curved_bold', 'curved_medium', 'straight_slim']);
  const straight = results.find((result) => result.annotation.style === 'straight_slim');
  assert.equal(straight.annotation.pathKind, 'straight');
  assert.equal(straight.annotation.pathPointCount, 2);
});

test('an upward chart omits one trailing red candle and ends at the preceding green candle', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-trailing-red-candle-'));
  const withTrailingRed = candles();
  const preceding = withTrailingRed.at(-2);
  preceding.open = preceding.close - 1;
  preceding.high = preceding.close + 0.5;
  preceding.low = preceding.open - 0.5;
  const final = withTrailingRed.at(-1);
  final.open = final.close + 1;
  final.high = final.open + 0.5;
  final.low = final.close - 0.5;
  const result = await renderCryptoChart({
    candidate: candidate({ direction: 'up', metrics: { candles: withTrailingRed, return5mPct: 2.14, volume5mUsd: 9_200_000 } }),
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'trailing-red.png'),
  });

  const labels = result.labels.join(' | ');
  assert.match(labels, /11:10 UTC/);
  assert.doesNotMatch(labels, /11:11 UTC/);
});

test('an upward chart keeps a second trailing red candle visible', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-two-trailing-red-candles-'));
  const withTrailingReds = candles();
  for (const candle of withTrailingReds.slice(-2)) {
    candle.open = candle.close + 1;
    candle.high = candle.open + 0.5;
    candle.low = candle.close - 0.5;
  }
  const result = await renderCryptoChart({
    candidate: candidate({ direction: 'up', metrics: { candles: withTrailingReds, return5mPct: 2.14, volume5mUsd: 9_200_000 } }),
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'two-trailing-red.png'),
  });

  assert.match(result.labels.join(' | '), /11:11 UTC/);
});

test('downside candidates do not receive a bullish arrow', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-crypto-downside-arrow-'));
  const result = await renderCryptoChart({
    candidate: candidate({ direction: 'down', score: 91 }),
    visualIntent: { preset: 'receipt', revealOnOpen: false },
    outputPath: path.join(directory, 'downside.png'),
  });

  assert.equal(result.annotation, null);
});
