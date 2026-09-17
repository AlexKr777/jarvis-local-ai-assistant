import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { deriveMarketRelationship } from '../content/market-relationship.js';
import { formatPublicPrice } from '../market/price-precision.js';

export const CHART_PRESETS = Object.freeze([
  'price_oi_divergence',
  'volume_shock',
  'timeline_mystery',
  'liquidation_burst',
  'receipt',
]);

const WIDTH = 1_200;
const HEIGHT = 900;
const SAFE = 60;
const PRICE_SCALE_X = WIDTH - 90;
const COLORS = Object.freeze({
  background: [12, 15, 19],
  panel: [20, 25, 31],
  panelRaised: [25, 31, 38],
  grid: [43, 51, 61],
  text: [230, 235, 239],
  muted: [137, 149, 160],
  cyan: [93, 210, 196],
  coral: [244, 126, 113],
  amber: [232, 189, 98],
  blue: [105, 157, 221],
});

const FONT = Object.freeze({
  A: ['01110','10001','10001','11111','10001','10001','10001'], B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'], D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'], F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'], H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'], J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'], L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'], N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'], P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'], R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'], T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'], V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'], X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'], Z: ['11111','00001','00010','00100','01000','10000','11111'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'], '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'], '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'], '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'], '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'], '9': ['01110','10001','10001','01111','00001','00001','01110'],
  '$': ['00100','01111','10100','01110','00101','11110','00100'], '+': ['00000','00100','00100','11111','00100','00100','00000'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'], '.': ['00000','00000','00000','00000','00000','01100','01100'],
  ':': ['00000','01100','01100','00000','01100','01100','00000'], '/': ['00001','00010','00010','00100','01000','01000','10000'],
  '%': ['11001','11010','00100','01000','10110','00110','00000'], '_': ['00000','00000','00000','00000','00000','00000','11111'],
  '?': ['01110','10001','00001','00010','00100','00000','00100'],
});

class Raster {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 3);
    this.fill(background);
  }

  fill(color) {
    for (let offset = 0; offset < this.pixels.length; offset += 3) {
      this.pixels[offset] = color[0];
      this.pixels[offset + 1] = color[1];
      this.pixels[offset + 2] = color[2];
    }
  }

  pixel(x, y, color) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const offset = (py * this.width + px) * 3;
    this.pixels[offset] = color[0];
    this.pixels[offset + 1] = color[1];
    this.pixels[offset + 2] = color[2];
  }

  rect(x, y, width, height, color) {
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const right = Math.min(this.width, Math.round(x + width));
    const bottom = Math.min(this.height, Math.round(y + height));
    for (let py = top; py < bottom; py += 1) {
      for (let px = left; px < right; px += 1) this.pixel(px, py, color);
    }
  }

  line(x0, y0, x1, y1, color, thickness = 1) {
    let left = Math.round(x0);
    let top = Math.round(y0);
    const right = Math.round(x1);
    const bottom = Math.round(y1);
    const dx = Math.abs(right - left);
    const sx = left < right ? 1 : -1;
    const dy = -Math.abs(bottom - top);
    const sy = top < bottom ? 1 : -1;
    let error = dx + dy;
    while (true) {
      this.rect(left - Math.floor(thickness / 2), top - Math.floor(thickness / 2), thickness, thickness, color);
      if (left === right && top === bottom) break;
      const twice = 2 * error;
      if (twice >= dy) { error += dy; left += sx; }
      if (twice <= dx) { error += dx; top += sy; }
    }
  }

  text(value, x, y, color, scale = 2) {
    let cursor = x;
    for (const character of String(value).toUpperCase()) {
      if (character === ' ') { cursor += 4 * scale; continue; }
      const glyph = FONT[character];
      if (!glyph) { cursor += 4 * scale; continue; }
      glyph.forEach((row, rowIndex) => {
        [...row].forEach((cell, columnIndex) => {
          if (cell === '1') this.rect(cursor + columnIndex * scale, y + rowIndex * scale, scale, scale, color);
        });
      });
      cursor += 6 * scale;
    }
    return cursor;
  }
}

function textWidth(value, scale) {
  return [...String(value).toUpperCase()].reduce((width, character) => width + (character === ' ' ? 4 : FONT[character] ? 6 : 4) * scale, 0);
}

function centeredText(raster, value, y, color, scale) {
  raster.text(value, Math.round((WIDTH - textWidth(value, scale)) / 2), y, color, scale);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function encodePng(raster) {
  const raw = Buffer.alloc((raster.width * 3 + 1) * raster.height);
  const stride = raster.width * 3;
  for (let y = 0; y < raster.height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    raster.pixels.copy(raw, row + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(raster.width, 0);
  header.writeUInt32BE(raster.height, 4);
  header[8] = 8;
  header[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 2 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function formatMetric(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  const absolute = Math.abs(number);
  if (absolute >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return number.toFixed(2);
}

function formatPrice(value, tickSize = null) {
  return formatPublicPrice(value, tickSize);
}

function claim(candidate, key) {
  return (candidate?.claimsAllowed || []).find((item) => item?.key === key) || null;
}

function strongestPriceClaim(candidate) {
  const candidates = ['return15m', 'return5m']
    .map((key) => claim(candidate, key))
    .filter(Boolean)
    .sort((left, right) => Math.abs(Number(right.value ?? String(right.display).replace('%', '')))
      - Math.abs(Number(left.value ?? String(left.display).replace('%', ''))));
  return candidates[0] || null;
}

function timeframeLabel(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === '24h') return 'LAST 24H';
  const match = normalized.match(/^(\d+)(m|h|d)$/);
  if (!match) return '';
  if (match[2] === 'm') return `LAST ${match[1]} MIN`;
  return `${match[1]}${match[2].toUpperCase()}`;
}

function metricLabel(source, prefix = '') {
  if (!source) return null;
  const timeframe = timeframeLabel(source.timeframe);
  return [prefix, source.display, timeframe].filter(Boolean).join(' ');
}

function finalStoryHeroLabel(finalStory) {
  const hero = finalStory?.heroMetric;
  if (!hero?.display) return null;
  const timeframe = String(hero.timeframe || '').toUpperCase();
  if (hero.key === 'volumeRatio') return `${String(hero.display).toUpperCase()} VOLUME / ${timeframe}`;
  if (hero.key === 'openInterestChange') return `OPEN INTEREST ${hero.display} / ${timeframe}`;
  return metricLabel(hero);
}

const CHART_TIMEFRAMES = Object.freeze([
  { key: '5m', label: '5 MIN CANDLES / UP TO 8H VIEW', viewCount: 96 },
  { key: '15m', label: '15 MIN CANDLES / UP TO 24H VIEW', viewCount: 96 },
  { key: '1h', label: '1 HOUR CANDLES / UP TO 3 DAY VIEW', viewCount: 72 },
  { key: '4h', label: '4 HOUR CANDLES / UP TO 8 DAY VIEW', viewCount: 48 },
]);

function isFiniteCandleSeries(candles) {
  return Array.isArray(candles) && candles.length >= 16 && candles.every((candle) =>
    [candle?.open, candle?.high, candle?.low, candle?.close, candle?.quoteVolume].every(Number.isFinite));
}

const MIN_DENSE_PUBLIC_CANDLES = 70;
const MIN_PUBLIC_CONTEXT_CANDLES = 60;
const HERO_SEARCH_FRACTION = 0.28;
const MIN_HERO_SEARCH_CANDLES = 16;
const HERO_SWING_RADIUS = 2;
const HERO_PROMINENCE_RANGES = 1.25;

function median(values) {
  const finite = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return 0;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function latestMeaningfulHeroPeak(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const searchCount = Math.min(
    candles.length,
    Math.max(MIN_HERO_SEARCH_CANDLES, Math.ceil(candles.length * HERO_SEARCH_FRACTION)),
  );
  const start = Math.max(HERO_SWING_RADIUS, candles.length - searchCount);
  const typicalRange = Math.max(0, median(candles.slice(start).map((candle) => candle.high - candle.low)));
  const tailStart = Math.max(start, candles.length - Math.min(10, candles.length));

  const meaningfulSwingFrom = (lowerBound) => {
    for (let index = candles.length - 2; index >= lowerBound; index -= 1) {
      const left = candles.slice(Math.max(0, index - HERO_SWING_RADIUS), index);
      const right = candles.slice(index + 1, Math.min(candles.length, index + HERO_SWING_RADIUS + 1));
      if (!left.length || !right.length) continue;
      const high = candles[index].high;
      const isLocalHigh = left.every((candle) => high >= candle.high)
        && right.every((candle) => high > candle.high);
      if (!isLocalHigh) continue;
      const neighborLow = Math.max(
        Math.min(...left.map((candle) => candle.low)),
        Math.min(...right.map((candle) => candle.low)),
      );
      const prominence = high - neighborLow;
      if (typicalRange <= 0 || prominence >= typicalRange * HERO_PROMINENCE_RANGES) {
        return { index, high };
      }
    }
    return null;
  };

  // First prefer a confirmed swing in the final few candles. This keeps the
  // arrow on the current right-edge event even when a slightly higher spike
  // remains nearby as useful context.
  const finalSwing = meaningfulSwingFrom(tailStart);
  if (finalSwing) return finalSwing;

  // If the move is still making highs at the edge, there may be no confirmed
  // swing yet. In that case the last few candles are the active hero rather
  // than an older oscillation deeper in the chart.
  let tailPeakIndex = tailStart;
  for (let index = tailStart + 1; index < candles.length; index += 1) {
    if (candles[index].high >= candles[tailPeakIndex].high) tailPeakIndex = index;
  }
  if (tailPeakIndex >= candles.length - 3) {
    return { index: tailPeakIndex, high: candles[tailPeakIndex].high };
  }

  // Otherwise expand to the broader recent window and take the latest
  // meaningful swing, still preferring recency rather than absolute height.
  const recentSwing = meaningfulSwingFrom(start);
  if (recentSwing) return recentSwing;
  return { index: tailPeakIndex, high: candles[tailPeakIndex].high };
}

function resolvedHeroPeakIndex(candles, preferredIndex = null) {
  if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < candles.length) return preferredIndex;
  return latestMeaningfulHeroPeak(candles)?.index ?? null;
}

function buildPublicHeroWindow(candles, candidate) {
  if (!Array.isArray(candles) || !candles.length) {
    return { candles: [], heroPeakIndex: null, heroPeakHigh: null, excludedStaleHigherHigh: false };
  }

  // Downside and neutral stories keep the ordinary complete view. The
  // recency crop exists specifically to frame an active upside peak without
  // pretending that an older, already-stale higher high is part of the same
  // immediate move.
  if (candidate?.direction !== 'up') {
    const peakIndex = candles.reduce((best, candle, index) => candle.high >= candles[best].high ? index : best, 0);
    return {
      candles,
      heroPeakIndex: peakIndex,
      heroPeakHigh: candles[peakIndex].high,
      excludedStaleHigherHigh: false,
    };
  }

  const recentPeak = latestMeaningfulHeroPeak(candles);
  if (!recentPeak) return { candles, heroPeakIndex: null, heroPeakHigh: null, excludedStaleHigherHigh: false };

  let lastOlderHigherHigh = -1;
  for (let index = recentPeak.index - 1; index >= 0; index -= 1) {
    if (candles[index].high > recentPeak.high) {
      lastOlderHigherHigh = index;
      break;
    }
  }

  // A separately classified pullback is different: once the market has
  // materially moved away from the peak, that already-happened price action
  // remains visible and is never hidden for presentation.
  const trailingCount = candles.length - recentPeak.index - 1;
  const preservePostPeak = candidate?.topRunnerVisualState === 'pullback' || trailingCount >= 2;
  const end = preservePostPeak ? candles.length : recentPeak.index + 1;

  // Crop an old higher high only when doing so still leaves a proper trader
  // chart. Nearby higher spikes are valid context and stay visible; they just
  // must not steal the hero arrow from the final meaningful peak.
  const proposedStart = lastOlderHigherHigh >= 0 ? lastOlderHigherHigh + 1 : 0;
  const canCropStaleHigh = lastOlderHigherHigh >= 0 && end - proposedStart >= MIN_PUBLIC_CONTEXT_CANDLES;
  const start = canCropStaleHigh ? proposedStart : 0;
  const visible = candles.slice(start, end);
  return {
    candles: visible,
    heroPeakIndex: recentPeak.index - start,
    heroPeakHigh: recentPeak.high,
    excludedStaleHigherHigh: canCropStaleHigh,
  };
}

function seriesProfile(candles, heroPeakIndex = null) {
  const peakIndex = Number.isInteger(heroPeakIndex)
    ? heroPeakIndex
    : candles.reduce((best, candle, index) => candle.high >= candles[best].high ? index : best, 0);
  const freshStart = Math.ceil(candles.length * 0.72);
  if (peakIndex < 4) return { quality: -Infinity, peakIndex, hasFreshPeak: false };
  const beforePeak = candles.slice(0, peakIndex + 1);
  const low = Math.min(...beforePeak.map((candle) => candle.low));
  const peak = candles[peakIndex].high;
  if (!Number.isFinite(low) || low <= 0 || !Number.isFinite(peak) || peak <= low) {
    return { quality: -Infinity, peakIndex, hasFreshPeak: false };
  }
  const risePct = ((peak - low) / low) * 100;
  const peakPosition = peakIndex / Math.max(1, candles.length - 1);
  const advancing = beforePeak.slice(1).filter((candle, index) => candle.close >= beforePeak[index].close).length;
  return {
    peakIndex,
    hasFreshPeak: peakIndex >= freshStart,
    quality: risePct + peakPosition * 14 + (advancing / Math.max(1, beforePeak.length - 1)) * 8,
  };
}

export function selectChartSeries(candidate) {
  const source = candidate?.metrics?.chartCandles || {};
  const options = CHART_TIMEFRAMES
    .map((definition) => {
      const raw = source[definition.key];
      if (!isFiniteCandleSeries(raw)) return null;
      const baseCandles = raw.slice(-definition.viewCount);
      const publicWindow = buildPublicHeroWindow(baseCandles, candidate);
      if (publicWindow.candles.length < 2) return null;
      const profile = seriesProfile(publicWindow.candles, publicWindow.heroPeakIndex);
      return {
        ...definition,
        timeframe: definition.key,
        candles: publicWindow.candles,
        quality: profile.quality,
        freshPeakIndex: profile.peakIndex,
        hasFreshPeak: profile.hasFreshPeak,
        heroPeakIndex: publicWindow.heroPeakIndex,
        heroPeakHigh: publicWindow.heroPeakHigh,
        excludedStaleHigherHigh: publicWindow.excludedStaleHigherHigh,
      };
    })
    .filter(Boolean);

  // Public trader charts prefer dense lower timeframes. A stronger 4h score
  // must not replace a perfectly usable 5m/15m view. If both lower
  // timeframes are available, prefer the first one that still carries the
  // normal 70+ candle context after the stale-higher-high crop. Otherwise use
  // whichever lower timeframe preserves more recent context, with 5m winning
  // ties. 1h/4h are true fallbacks only.
  const lowerTimeframes = options.filter((option) => option.key === '5m' || option.key === '15m');
  const denseLower = lowerTimeframes.find((option) => option.candles.length >= MIN_DENSE_PUBLIC_CANDLES);
  if (denseLower) return denseLower;
  if (lowerTimeframes.length) {
    return [...lowerTimeframes].sort((left, right) => right.candles.length - left.candles.length
      || (left.key === '5m' ? -1 : 1))[0];
  }

  const oneHour = options.find((option) => option.key === '1h');
  if (oneHour) return oneHour;
  const fourHour = options.find((option) => option.key === '4h');
  if (fourHour) return fourHour;

  return { key: '1m', timeframe: '1m', label: '1 MIN CANDLES / UP TO 5H VIEW', candles: candidate?.metrics?.candles || [], quality: 0 };
}

function validCandles(candles, candidate) {
  if (!Array.isArray(candles) || candles.length < 2) throw new Error('Chart requires at least two valid candles.');
  for (const candle of candles) {
    if (![candle.open, candle.high, candle.low, candle.close, candle.quoteVolume].every(Number.isFinite)) {
      throw new Error('Chart requires finite candle facts.');
    }
  }
  const visible = candles.slice(-300);
  const last = visible.at(-1);
  const preceding = visible.at(-2);
  // A single closing red minute after an otherwise intact upside impulse is
  // not the event being shown. Keep the chart ending on the confirmed green
  // candle; deeper pullbacks remain visible and are never hidden.
  if (candidate?.direction === 'up' && candidate?.topRunnerVisualState !== 'pullback' && visible.length > 2 && last.close < last.open && preceding.close >= preceding.open) return visible.slice(0, -1);
  return visible;
}

function drawGrid(raster, area) {
  raster.rect(area.x, area.y, area.width, area.height, COLORS.panel);
  for (let index = 1; index < 5; index += 1) {
    const y = area.y + (area.height * index) / 5;
    raster.line(area.x, y, area.x + area.width, y, COLORS.grid);
  }
  for (let index = 1; index < 6; index += 1) {
    const x = area.x + (area.width * index) / 6;
    raster.line(x, area.y, x, area.y + area.height, COLORS.grid);
  }
}

function candleScale(candles, area, topHeadroom = 0) {
  const maximum = Math.max(...candles.map((item) => item.high));
  const minimum = Math.min(...candles.map((item) => item.low));
  const span = maximum === minimum ? Math.max(Math.abs(maximum) * 0.02, 1) : maximum - minimum;
  const displayMaximum = maximum + span * topHeadroom;
  const displaySpan = Math.max(displayMaximum - minimum, span);
  return {
    maximum,
    minimum,
    step: area.width / candles.length,
    yFor: (value) => area.y + ((displayMaximum - value) / displaySpan) * area.height,
  };
}

function drawCandles(raster, candles, area, range) {
  const { step, yFor } = range;
  const bodyWidth = Math.max(3, Math.floor(step * 0.58));
  candles.forEach((candle, index) => {
    const x = area.x + step * index + step / 2;
    const color = candle.close >= candle.open ? COLORS.cyan : COLORS.coral;
    raster.line(x, yFor(candle.high), x, yFor(candle.low), color, 2);
    const top = Math.min(yFor(candle.open), yFor(candle.close));
    const height = Math.max(3, Math.abs(yFor(candle.open) - yFor(candle.close)));
    raster.rect(x - bodyWidth / 2, top, bodyWidth, height, color);
  });
}

function bullishScenarioVariation(candidate) {
  const source = String(candidate?.id || candidate?.symbol || candidate?.cashtag || 'market');
  return [...source].reduce((total, character) => total + character.charCodeAt(0), 0) % 3;
}

function hasBullishScenarioArrow(candidate) {
  return candidate?.direction === 'up';
}

function bullishScenarioStyle(variation) {
  return [
    { name: 'curved_bold', pathKind: 'curved', thickness: 18, startX: 188, startY: 184, retreatX: 34, retreatY: 70, approachX: 94, approachY: 76, headX: 54, headY: 18, headLowX: 36, headLowY: 58 },
    { name: 'straight_slim', pathKind: 'straight', thickness: 10, startX: 198, startY: 188, headX: 42, headY: 14, headLowX: 28, headLowY: 46 },
    { name: 'curved_medium', pathKind: 'curved', thickness: 14, startX: 176, startY: 170, retreatX: 28, retreatY: 60, approachX: 82, approachY: 66, headX: 48, headY: 16, headLowX: 32, headLowY: 52 },
  ][variation];
}

function drawBullishScenarioArrow(raster, candles, area, range, variation, heroPeakIndex = null) {
  const peakIndex = resolvedHeroPeakIndex(candles, heroPeakIndex);
  if (!Number.isInteger(peakIndex)) return null;
  const peakX = area.x + range.step * peakIndex + range.step / 2;
  const peakY = range.yFor(candles[peakIndex].high);
  const color = [30, 126, 66];
  const style = bullishScenarioStyle(variation);
  const wickClearanceX = Math.max(28, range.step * 2 + style.thickness / 2);
  const wickClearanceY = Math.max(10, style.thickness / 2 + 3);
  const target = {
    // Point toward the factual high from clear chart space rather than
    // painting over the candle body or its wick.
    x: peakX - wickClearanceX,
    y: peakY - wickClearanceY,
  };
  const start = {
    x: Math.max(area.x + 56, peakX - style.startX),
    y: Math.min(area.y + area.height - 44, peakY + style.startY),
  };
  const points = style.pathKind === 'straight'
    ? [[start.x, start.y], [target.x, target.y]]
    : [
      [start.x, start.y],
      [start.x - style.retreatX, start.y - style.retreatY],
      [target.x - style.approachX, target.y + style.approachY],
      [target.x, target.y],
    ];
  for (let index = 1; index < points.length; index += 1) {
    raster.line(...points[index - 1], ...points[index], color, style.thickness);
  }
  const tip = points.at(-1);
  const head = [
    { x: tip[0] - style.headX, y: tip[1] + style.headY },
    { x: tip[0] - style.headLowX, y: tip[1] + style.headLowY },
  ];
  for (const point of head) raster.line(tip[0], tip[1], point.x, point.y, color, style.thickness);
  return { x: tip[0], y: tip[1], start, peak: { x: peakX, y: peakY }, clearance: { x: wickClearanceX, y: wickClearanceY }, head, style: style.name, pathKind: style.pathKind, pathPointCount: points.length };
}

function drawStoryHeroPeakArrow(raster, candles, area, range, heroPeakIndex = null) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const peakIndex = resolvedHeroPeakIndex(candles, heroPeakIndex);
  if (!Number.isInteger(peakIndex)) return null;
  const peak = candles[peakIndex];
  const peakX = area.x + range.step * peakIndex + range.step / 2;
  const peakY = range.yFor(peak.high);
  const color = [30, 126, 66];
  const thickness = 5;
  const horizontalSpan = Math.max(72, Math.min(132, range.step * 11));
  const verticalSpan = Math.max(54, Math.min(92, area.height * 0.14));
  const tip = {
    x: Math.max(area.x + 18, peakX - Math.max(8, range.step * 0.65)),
    y: Math.min(area.y + area.height - 18, peakY + 6),
  };
  const start = {
    x: Math.max(area.x + 24, tip.x - horizontalSpan),
    y: Math.min(area.y + area.height - 30, tip.y + verticalSpan),
  };
  if (tip.x - start.x < 36) return null;

  raster.line(start.x, start.y, tip.x, tip.y, color, thickness);
  const angle = Math.atan2(tip.y - start.y, tip.x - start.x);
  const headLength = 15;
  const head = [];
  for (const shift of [Math.PI * 0.82, -Math.PI * 0.82]) {
    const point = {
      x: tip.x + Math.cos(angle + shift) * headLength,
      y: tip.y + Math.sin(angle + shift) * headLength,
    };
    head.push(point);
    raster.line(tip.x, tip.y, point.x, point.y, color, thickness);
  }

  return {
    type: 'historical_peak_arrow',
    lineStyle: 'solid',
    start,
    end: tip,
    peak: { x: peakX, y: peakY, index: peakIndex, price: peak.high },
    head,
  };
}

function drawBullishWatchLevel(raster, candles, tip, variation, area, factPack = null) {
  const lastClose = Number(candles.at(-1)?.close);
  if (!Number.isFinite(lastClose) || lastClose <= 0 || !tip) return null;
  const approvedWatch = (factPack?.levels?.resistances || []).find((level) => Number.isFinite(Number(level?.midpoint)));
  // A v4 package may never manufacture a price objective. Legacy callers
  // retain their existing visual, but Fact Pack-driven charts label a watch
  // price only when a deterministic resistance has been selected.
  if (factPack && !approvedWatch) return null;
  const label = `WATCH $${formatPrice(approvedWatch ? approvedWatch.midpoint : lastClose * 2, approvedWatch?.tickSize)}`;
  const width = textWidth(label, 2) + 24;
  const height = 31;
  const x = Math.max(SAFE + 12, Math.min(WIDTH - SAFE - width, tip.x - width / 2));
  const y = Math.max(area.y + 16, tip.y - height - 8);
  raster.rect(x, y, width, height, [14, 49, 31]);
  raster.rect(x, y, width, 2, [30, 126, 66]);
  raster.text(label, x + 12, y + 9, [93, 210, 140], 2);
  return { label, x, y, width, height, factId: approvedWatch?.id || null };
}

function drawTechnicalLevels(raster, factPack, area, range, labels) {
  const entries = [
    ...(factPack?.levels?.supports || []).map((level) => ({ ...level, label: 'SUPPORT', color: COLORS.blue })),
    ...(factPack?.levels?.resistances || []).map((level) => ({ ...level, label: 'RESISTANCE', color: COLORS.amber })),
  ].filter((level) => Number.isFinite(Number(level.midpoint)) && Array.isArray(level.evidence) && level.evidence.length > 0);
  return entries.map((level) => {
    const y = range.yFor(level.midpoint);
    if (y < area.y + 12 || y > area.y + area.height - 12) return null;
    raster.line(area.x + 12, y, area.x + area.width - 12, y, level.color, 1);
    const label = `${level.label} $${formatPrice(level.midpoint, level.tickSize)}`;
    raster.text(label, area.x + 18, Math.max(area.y + 10, y - 14), level.color, 1);
    labels.push(label);
    return { id: level.id, label, y };
  }).filter(Boolean);
}

function storyLevelEntries(finalStory, factPack) {
  const brief = finalStory?.spine?.storyBrief || finalStory?.storyBrief || null;
  if (!brief?.valid) return null;
  const levelsById = Object.fromEntries([
    ...(factPack?.levels?.supports || []),
    ...(factPack?.levels?.resistances || []),
  ].map((level) => [level.id, level]));
  const roles = [
    { key: 'firstReactionZone', label: 'REACTION', color: COLORS.blue },
    { key: 'structuralInvalidation', label: 'INVALIDATION', color: COLORS.coral },
    { key: 'nextWatch', label: 'WATCH', color: COLORS.amber },
  ];
  const entries = roles.map(({ key, label, color }) => {
    const role = brief[key];
    // A Story Brief carries references, not alternate price authority. The
    // chart may only render the exact Fact Pack level that the text received.
    // The role-only fallback is used internally after this check has already
    // established a Fact Pack-backed story, to draw its conditional arrow.
    const level = factPack ? levelsById[role?.levelId] : role;
    if (!role || !level || !Number.isFinite(Number(level.midpoint))) return null;
    return { id: role.levelId, label, color, midpoint: Number(level.midpoint), tickSize: level.tickSize, role: role.role };
  }).filter(Boolean);
  return entries.length === 3 ? entries : null;
}

function drawStoryLevels(raster, factPack, finalStory, area, range, labels) {
  const entries = storyLevelEntries(finalStory, factPack);
  if (!entries) return null;
  const visible = entries.map((level) => ({ ...level, y: range.yFor(level.midpoint) }))
    .filter((level) => level.y >= area.y + 12 && level.y <= area.y + area.height - 12)
    .sort((left, right) => left.y - right.y);
  const minimumLabelGap = 14;
  const minimumLabelY = area.y + 10;
  const maximumLabelY = area.y + area.height - 22;
  let nextLabelY = minimumLabelY;
  for (const level of visible) {
    level.labelY = Math.max(minimumLabelY, Math.min(maximumLabelY, level.y - 14), nextLabelY);
    nextLabelY = level.labelY + minimumLabelGap;
  }
  const overflow = Math.max(0, nextLabelY - minimumLabelGap - maximumLabelY);
  if (overflow > 0) {
    for (const level of visible) level.labelY -= overflow;
  }
  return visible.map((level) => {
    raster.line(area.x + 12, level.y, area.x + area.width - 12, level.y, level.color, 1);
    const label = `${level.label} $${formatPrice(level.midpoint, level.tickSize)}`;
    raster.text(label, area.x + 18, level.labelY, level.color, 1);
    labels.push(label);
    return { id: level.id, label, y: level.y, labelY: level.labelY, role: level.role };
  });
}

function drawDashedLine(raster, start, end, color, thickness = 3, dash = 10, gap = 7) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return;
  const ux = dx / distance;
  const uy = dy / distance;
  for (let offset = 0; offset < distance; offset += dash + gap) {
    const to = Math.min(distance, offset + dash);
    raster.line(start.x + ux * offset, start.y + uy * offset, start.x + ux * to, start.y + uy * to, color, thickness);
  }
}

function drawConditionalScenario(raster, area, range, finalStory, candidate, candles, heroPeakIndex = null) {
  if (candidate?.direction !== 'up') return null;
  const entries = storyLevelEntries(finalStory, null);
  if (!entries) return null;
  const reaction = entries.find((entry) => entry.role === 'first_reaction_zone');
  const watch = entries.find((entry) => entry.role === 'next_watch');
  if (!reaction || !watch || watch.midpoint <= reaction.midpoint) return null;
  const resolvedPeakIndex = resolvedHeroPeakIndex(candles, heroPeakIndex);
  const heroPeak = Number.isInteger(resolvedPeakIndex) ? Number(candles[resolvedPeakIndex]?.high) : Number.NaN;
  // A next-watch price that has already been reached or exceeded by the
  // active hero peak is not a future projection. An older nearby spike may
  // remain visible for context without suppressing a still-valid scenario.
  if (!Number.isFinite(heroPeak) || watch.midpoint <= heroPeak) return null;

  const startY = range.yFor(reaction.midpoint);
  const endY = range.yFor(watch.midpoint);
  if (endY < area.y + 18 || endY > area.y + area.height - 18) return null;
  // A nearly horizontal projection is visually noisy and communicates no
  // useful directional scenario. In that case the factual level lines are
  // enough and the future arrow is intentionally omitted.
  if (Math.abs(endY - startY) < 24) return null;

  const projectionWidth = Math.max(72, Math.min(132, range.step * 10));
  const endX = area.x + area.width - 28;
  const startX = Math.max(area.x + 28, endX - projectionWidth);
  const start = { x: startX, y: startY };
  const end = { x: endX, y: endY };
  const color = [64, 172, 108];
  drawDashedLine(raster, start, end, color, 3);
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLength = 12;
  for (const shift of [Math.PI * 0.82, -Math.PI * 0.82]) {
    raster.line(end.x, end.y, end.x + Math.cos(angle + shift) * headLength, end.y + Math.sin(angle + shift) * headLength, color, 3);
  }
  const label = 'IF HELD';
  const labelY = Math.min(area.y + area.height - 24, Math.max(area.y + 8, start.y + 10));
  raster.rect(start.x - 4, labelY, textWidth(label, 1) + 12, 18, [18, 52, 35]);
  raster.text(label, start.x + 2, labelY + 4, [93, 210, 140], 1);
  return { type: 'conditional_scenario_arrow', lineStyle: 'dashed', label, start, end, factIds: [reaction.id, watch.id] };
}

function drawVolumes(raster, candles, area, highlight = false) {
  const maximum = Math.max(1, ...candles.map((item) => item.quoteVolume));
  const step = area.width / candles.length;
  candles.forEach((candle, index) => {
    const height = (candle.quoteVolume / maximum) * area.height;
    const hot = highlight && index >= candles.length - 5;
    raster.rect(area.x + step * index + 1, area.y + area.height - height, Math.max(2, step - 2), height, hot ? COLORS.amber : COLORS.blue);
  });
}

function drawSeries(raster, values, area, color) {
  const finiteValues = values.map(Number).filter(Number.isFinite).slice(-72);
  if (finiteValues.length < 2) return;
  const maximum = Math.max(...finiteValues);
  const minimum = Math.min(...finiteValues);
  const span = maximum === minimum ? 1 : maximum - minimum;
  const step = area.width / (finiteValues.length - 1);
  for (let index = 1; index < finiteValues.length; index += 1) {
    const x0 = area.x + step * (index - 1);
    const x1 = area.x + step * index;
    const y0 = area.y + ((maximum - finiteValues[index - 1]) / span) * area.height;
    const y1 = area.y + ((maximum - finiteValues[index]) / span) * area.height;
    raster.line(x0, y0, x1, y1, color, 3);
  }
}

function drawTimeScale(raster, candles, area, labels) {
  const indexes = [0, Math.floor((candles.length - 1) / 2), candles.length - 1];
  indexes.forEach((index, position) => {
    const date = new Date(candles[index].openTime);
    const label = Number.isFinite(date.getTime())
      ? `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`
      : '--:-- UTC';
    const x = position === 0 ? area.x + 10 : position === 1 ? area.x + area.width / 2 - 45 : area.x + area.width - 115;
    raster.text(label, x, area.y + area.height - 24, COLORS.muted, 1);
    labels.push(label);
  });
}

function drawIndicator(raster, preset, candidate, candles, area, labels) {
  raster.rect(area.x, area.y, area.width, area.height, COLORS.panelRaised);
  if (preset === 'price_oi_divergence') {
    const oi = claim(candidate, 'openInterestChange');
    const label = oi ? `OPEN INTEREST ${oi.display} / ${String(oi.timeframe || '2h').toUpperCase()}` : 'OPEN INTEREST';
    raster.text(label, area.x + 18, area.y + 14, COLORS.amber, 2);
    drawSeries(raster, candidate.openInterestSeries || [], { x: area.x + 18, y: area.y + 42, width: area.width - 36, height: area.height - 54 }, COLORS.amber);
    labels.push(label);
    return;
  }
  if (preset === 'volume_shock') {
    const volume = claim(candidate, 'volumeRatio');
    const label = metricLabel(volume, 'VOLUME') || 'VOLUME';
    raster.text(label, area.x + 18, area.y + 14, COLORS.amber, 2);
    drawVolumes(raster, candles, { x: area.x + 18, y: area.y + 40, width: area.width - 36, height: area.height - 50 }, true);
    labels.push(label);
    return;
  }
  if (preset === 'timeline_mystery') {
    raster.text('MARKET TIMELINE', area.x + 18, area.y + 14, COLORS.muted, 2);
    const y = area.y + 72;
    raster.line(area.x + 80, y, area.x + area.width - 80, y, COLORS.grid, 3);
    [0.22, 0.5, 0.78].forEach((position, index) => {
      const x = area.x + area.width * position;
      raster.rect(x - 5, y - 5, 10, 10, index === 2 ? COLORS.amber : COLORS.blue);
    });
    labels.push('MARKET TIMELINE');
    return;
  }
  if (preset === 'liquidation_burst') {
    raster.text('LIQUIDATIONS / LAST 5 MIN', area.x + 18, area.y + 14, COLORS.muted, 2);
    const items = candidate.liquidations || [];
    const total = items.reduce((sum, item) => sum + Number(item.notionalUsd || 0), 0);
    raster.text(`TOTAL ${formatMetric(total)} USD`, area.x + 18, area.y + 60, COLORS.coral, 3);
    labels.push('LIQUIDATIONS / LAST 5 MIN', `TOTAL ${formatMetric(total)} USD`);
    return;
  }
  raster.text('TRADED VOLUME', area.x + 18, area.y + 14, COLORS.muted, 2);
  drawVolumes(raster, candles, { x: area.x + 18, y: area.y + 40, width: area.width - 36, height: area.height - 50 });
  labels.push('TRADED VOLUME');
}

function conflictCopy(relationship) {
  if (relationship === 'price_down_oi_up') return ['LONGS EXITING', 'OR FRESH SHORTS ENTERING?'];
  if (relationship === 'price_up_oi_down') return ['FRESH LONGS ENTERING', 'OR SHORTS EXITING?'];
  if (relationship === 'price_up_oi_up') return ['SHORTS EXITING', 'OR FRESH LONGS ENTERING?'];
  if (relationship === 'price_down_oi_down') return ['FRESH SHORTS ENTERING', 'OR LONGS EXITING?'];
  return ['ORDINARY MOVE', 'OR POSITIONING SHIFT?'];
}

function drawQuestion(raster, area, relationship, labels) {
  const [optionA, optionB] = conflictCopy(relationship);
  raster.rect(area.x, area.y, area.width, area.height, COLORS.panel);
  raster.text('WHO ADDED RISK?', area.x + 20, area.y + 16, COLORS.text, 3);
  raster.text(optionA, area.x + 20, area.y + 58, COLORS.muted, 2);
  raster.text(optionB, area.x + area.width / 2 + 10, area.y + 58, COLORS.muted, 2);
  labels.push('WHO ADDED RISK?', optionA, optionB);
}

export async function renderCryptoChart({ candidate, factPack = null, visualIntent, finalStory = null, outputPath }) {
  if (!CHART_PRESETS.includes(visualIntent?.preset)) throw new Error('Unsupported chart preset.');
  if (typeof outputPath !== 'string' || !outputPath) throw new Error('A chart output path is required.');
  const chartSeries = selectChartSeries(candidate);
  const candles = validCandles(chartSeries.candles, candidate);
  const raster = new Raster(WIDTH, HEIGHT, COLORS.background);
  const labels = [];
  // Sparse flat texture keeps large matte surfaces visually stable without directional color effects.
  for (let y = SAFE; y < HEIGHT - SAFE; y += 16) {
    for (let x = SAFE + ((y / 16) % 2) * 8; x < WIDTH - SAFE; x += 16) raster.pixel(x, y, [17, 21, 26]);
  }
  const quote = String(candidate.symbol || '').endsWith('USDC') ? 'USDC' : 'USDT';
  const publicTitle = `${candidate.cashtag || candidate.symbol || 'MARKET'} / ${quote} PERP`;
  raster.text(publicTitle, SAFE, 42, COLORS.text, 3);
  raster.text(chartSeries.label, WIDTH - SAFE - 380, 48, COLORS.muted, 2);
  labels.push(publicTitle, chartSeries.label);
  if (candidate.readinessOnly) {
    raster.text('PUBLIC DATA / DRY RUN', SAFE, 80, COLORS.amber, 2);
    labels.push('PUBLIC DATA / DRY RUN');
  }
  const today = claim(candidate, 'return24h');
  const move = strongestPriceClaim(candidate);
  // Every preset has one editorially selected price fact: the daily move when
  // supplied, otherwise the strongest verified price window. Other windows
  // remain in the candidate for analysis but never compete in the header.
  // A final Story Brief is authoritative: if its public story is level-only,
  // the chart must not manufacture a daily metric just because it exists in
  // the broader Fact Pack. The fallback remains for legacy/non-story charts.
  const hero = finalStory ? finalStory.heroMetric : (today || move);
  const heroLabel = finalStoryHeroLabel(finalStory) || metricLabel(hero);
  if (heroLabel) {
    centeredText(raster, heroLabel, 82, Number(hero.value) >= 0 ? COLORS.cyan : COLORS.coral, 4);
    labels.push(heroLabel);
  }
  const chartArea = { x: SAFE, y: 130, width: WIDTH - SAFE * 2, height: 540 };
  drawGrid(raster, chartArea);
  const priceArea = { x: chartArea.x, y: chartArea.y, width: chartArea.width - 120, height: chartArea.height - 34 };
  const storyDriven = Boolean(storyLevelEntries(finalStory, factPack));
  const legacyBullishScenarioArrow = !storyDriven && hasBullishScenarioArrow(candidate);
  const storyHeroPeakArrow = storyDriven && hasBullishScenarioArrow(candidate);
  // Keep only compact headroom above factual highs. Story-driven charts now
  // use a solid historical arrow aimed at the actual visible hero peak, while
  // any future scenario remains a separate compact dashed projection.
  const range = candleScale(candles, priceArea, storyDriven ? 0.08 : legacyBullishScenarioArrow ? 0.16 : 0);
  const technicalLevels = storyDriven
    ? drawStoryLevels(raster, factPack, finalStory, priceArea, range, labels)
    : drawTechnicalLevels(raster, factPack, priceArea, range, labels);

  const selectedHeroPeakIndex = resolvedHeroPeakIndex(candles, chartSeries.heroPeakIndex);
  let annotation = storyDriven
    ? drawConditionalScenario(raster, priceArea, range, finalStory, candidate, candles, selectedHeroPeakIndex)
    : legacyBullishScenarioArrow ? { type: 'bullish_scenario_arrow', variation: bullishScenarioVariation(candidate) } : null;

  // Draw all arrows beneath the factual candles so annotations never cover
  // the market data. The story hero arrow is historical/solid and always
  // points at the highest visible candle in the recency-framed public window.
  const heroPeakArrow = storyHeroPeakArrow
    ? drawStoryHeroPeakArrow(raster, candles, priceArea, range, selectedHeroPeakIndex)
    : null;
  const arrowTarget = legacyBullishScenarioArrow
    ? drawBullishScenarioArrow(raster, candles, priceArea, range, annotation.variation, selectedHeroPeakIndex)
    : null;

  drawCandles(raster, candles, priceArea, range);

  const watchLevel = legacyBullishScenarioArrow
    ? drawBullishWatchLevel(raster, candles, arrowTarget, annotation.variation, priceArea, factPack)
    : null;

  if (annotation && arrowTarget && watchLevel) {
    annotation.target = arrowTarget;
    annotation.start = arrowTarget.start;
    annotation.head = arrowTarget.head;
    annotation.style = arrowTarget.style;
    annotation.pathKind = arrowTarget.pathKind;
    annotation.pathPointCount = arrowTarget.pathPointCount;
    annotation.watchLabel = watchLevel;
    annotation.factIds = [watchLevel.factId, ...technicalLevels.map((level) => level.id)].filter(Boolean);
  }

  if (storyDriven) {
    if (annotation) {
      annotation.factIds = [...new Set([...(annotation.factIds || []), ...technicalLevels.map((level) => level.id)])];
      if (heroPeakArrow) annotation.heroPeakArrow = heroPeakArrow;
    } else if (heroPeakArrow) {
      annotation = {
        type: 'historical_peak_arrow',
        lineStyle: 'solid',
        heroPeakArrow,
        factIds: [...new Set(technicalLevels.map((level) => level.id).filter(Boolean))],
      };
    }
  }

  if (watchLevel) labels.push(watchLevel.label);
  raster.text(formatPrice(range.maximum), PRICE_SCALE_X, chartArea.y + 18, COLORS.muted, 2);
  raster.text(formatPrice(range.minimum), PRICE_SCALE_X, chartArea.y + chartArea.height - 58, COLORS.muted, 2);
  drawTimeScale(raster, candles, chartArea, labels);
  const indicatorArea = { x: SAFE, y: 690, width: WIDTH - SAFE * 2, height: 100 };
  drawIndicator(raster, visualIntent.preset, candidate, candles, indicatorArea, labels);
  const relationship = deriveMarketRelationship(candidate);
  const provenance = 'BINANCE FUTURES DATA / CUSTOM CHART';
  raster.text(provenance, SAFE, 866, COLORS.muted, 1);
  const footerLabel = candidate.readinessOnly ? 'DRY RUN / NOT PUBLISHED' : 'JARVIS';
  raster.text(footerLabel, WIDTH - SAFE - (candidate.readinessOnly ? 172 : 48), 866, COLORS.muted, 1);
  labels.push(provenance, footerLabel);
  const buffer = encodePng(raster);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer, { mode: 0o600 });
  return {
    path: outputPath,
    preset: visualIntent.preset,
    width: WIDTH,
    height: HEIGHT,
    safeAreaPx: SAFE,
    relationship,
    marketVisualizationRatio: Math.round(((chartArea.height + indicatorArea.height) / HEIGHT) * 100) / 100,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    labels,
    technicalLevels,
    annotation,
  };
}
