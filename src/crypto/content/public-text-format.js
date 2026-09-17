function words(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

const PUBLIC_CASHTAG = /\$[A-Z][A-Z0-9]{1,11}\b/gi;
const PUBLIC_HASHTAG = /#[A-Z][A-Z0-9_]*\b/gi;

function canonicalCashtag(candidate = {}) {
  const value = String(candidate.cashtag || '').trim().toUpperCase();
  return /^\$[A-Z][A-Z0-9]{1,11}$/.test(value) ? value : null;
}

function topicalHashtag(storyKind) {
  const normalized = String(storyKind || '').toLowerCase();
  if (/(?:retest|reclaim)/.test(normalized)) return '#Retest';
  if (/(?:breakout|pressure_near_high)/.test(normalized)) return '#Breakout';
  if (/(?:rejection|resistance)/.test(normalized)) return '#Resistance';
  if (/(?:reversal|recovery)/.test(normalized)) return '#Reversal';
  if (/(?:volume)/.test(normalized)) return '#Volume';
  return '#ChartAnalysis';
}

// The model owns the story; the application owns the Square navigation and
// discovery shell. Strip model-added tags so every post has one searchable
// cashtag at the top and exactly two stable, relevant hashtags at the bottom.
export function formatSquareEditorialPost({ text, candidate = {}, storyKind = null } = {}) {
  const cashtag = canonicalCashtag(candidate);
  if (!cashtag) return normalizePublicText(text).text;
  const body = normalizePublicText(text).text
    .replace(PUBLIC_CASHTAG, '')
    .replace(PUBLIC_HASHTAG, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const footer = `#Crypto ${topicalHashtag(storyKind)}`;
  return body
    ? `${cashtag} ${body}\n\n${footer}`
    : `${cashtag}\n\n${footer}`;
}

function standardDeviation(values) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
}

export function normalizePublicText(raw) {
  const text = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const paragraphs = text ? text.split(/\n{2}/).filter(Boolean) : [];
  return Object.freeze({
    text,
    paragraphCount: paragraphs.length,
    paragraphLengths: paragraphs.map((paragraph) => words(paragraph).length),
    usedInvisibleSeparator: false,
  });
}

export function assessPublicTextRhythm(raw) {
  const normalized = normalizePublicText(raw);
  const lengths = normalized.paragraphLengths;
  const issues = [];
  if (lengths.length >= 4) {
    const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
    const similar = lengths.filter((value) => Math.abs(value - mean) <= Math.max(2, mean * 0.2)).length;
    if (similar / lengths.length >= 0.75) issues.push('SYMMETRIC_PARAGRAPH_SHAPE');
  }
  if (lengths.length >= 4 && lengths.filter((value) => value <= 8).length / lengths.length >= 0.75) {
    issues.push('MECHANICAL_MICRO_PARAGRAPHS');
  }
  const distinctLengths = new Set(lengths.map((value) => Math.round(value / 4))).size;
  return Object.freeze({
    ok: issues.length === 0,
    issues,
    paragraphCount: normalized.paragraphCount,
    paragraphLengths: lengths,
    paragraphLengthDeviation: standardDeviation(lengths),
    paragraphVariation: distinctLengths,
    normalizedText: normalized.text,
    usedInvisibleSeparator: false,
  });
}
