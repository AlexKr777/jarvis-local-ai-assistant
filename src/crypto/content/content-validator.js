import { createHash } from 'node:crypto';
import { deriveMarketRelationship } from './market-relationship.js';
import { canonicalPublicCashtag } from '../market/token-identity.js';
import { formatPublicPrice } from '../market/price-precision.js';

const PRESETS = new Set(['price_oi_divergence', 'volume_shock', 'timeline_mystery', 'liquidation_burst', 'receipt']);
const UNSAFE_LANGUAGE = /\b(?:guaranteed|guarantee|buy now|sell now|easy profit|risk[- ]free|100x|financial advice)\b/i;
const BANNED_PUBLIC_LANGUAGE = /(?:the supplied (?:metrics|data|evidence) (?:do|does) not establish|this observation is limited|this does not indicate whether|this is a market-structure observation|this is not a trading instruction|momentum remains|the setup merits attention|this setup merits attention|what do you think|breakout or trap|something unusual is happening|here is the real puzzle|let's break it down|here's what caught my attention|the supplied metrics suggest|the supplied data suggests|the data paints an interesting picture|one key metric stands out|pick one before (?:you )?(?:read|open)|the answer may surprise you)/i;
const FORMULAIC_PUBLIC_COPY = /(?:here is the real puzzle|pick one|now choose|choose (?:one|a side)|before (?:you )?(?:read|open)|before we reveal|reveal the answer|the answer may surprise you|here is your choice)/i;
const NON_ENGLISH_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}]/u;
const EXPLICIT_A = /^A\s*(?::|\u2014|\u2013|-)\s*\S/im;
const EXPLICIT_B = /^B\s*(?::|\u2014|\u2013|-)\s*\S/im;
const GENERIC_AB = /\bA\s*(?:or|\/)\s*B\b/i;
const NATURAL_CONFLICT = /\b(?:longs?|shorts?|buyers?|sellers?|profit[- ]taking|unwind(?:ing)?)\b[^\n?]{0,80}(?:\u2014|-|\bor\b|\bversus\b|\bvs\.?\b)[^\n?]{0,80}\b(?:longs?|shorts?|buyers?|sellers?|profit[- ]taking|unwind(?:ing)?)\b/i;
const POSITION_TAKING = /(?:\b(?:i'm|i am)\s+(?:on\b|not buying\b)|\bi (?:do not|don't|wouldn't|would not) buy\b|\b(?:cleaner explanation|better-supported read|stronger explanation)\b|\bfits\b[^.!?\n]{0,90}\bbetter\b|\bhard to defend\b|\b(?:A|B)\s+(?:is|fits|looks|wins)\b)/i;
const LOSING_CASE_EXPECTATION = /(?:\bif\b[\s\S]{0,180}\bshould\b|\bwould expect\b)/i;
const CONTRADICTING_EVIDENCE = /\b(?:instead|opposite|but|yet|they(?:'re| are) expanding|it (?:rose|climbed|expanded)|positions? (?:rose|climbed|expanded)|open interest (?:rose|climbed|expanded))\b/i;
const NUMERIC_CLAIM = /[+-]?\d+(?:\.\d+)?(?:%|x)?/gi;
const RELATIVE_RECENCY = /\b(?:now|just|today|currently|recently|at the moment)\b/i;
const JUST_AMOUNT_LIMITER = /\bjust\s+(?=(?:under\s+)?[+-]?\$?\d+(?:\.\d+)?(?:%|x)?\b|\d+(?:\.\d+)?\s+(?:minutes?|hours?|days?)\b(?!\s+ago))/gi;
const TIMEFRAME_WORDS = Object.freeze([
  ['twenty-four', '24'], ['twenty four', '24'], ['fifteen', '15'], ['five', '5'], ['four', '4'], ['two', '2'], ['one', '1'],
]);

function paragraphsOf(text) {
  return text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

function normalizeForMatching(text) {
  return String(text || '').replace(/[\u2018\u2019]/g, "'");
}

function timeframeFor(claim) {
  if (typeof claim?.timeframe === 'string' && claim.timeframe) return claim.timeframe.toLowerCase();
  const suffix = String(claim?.key || '').match(/(\d+)(m|h|d)$/i);
  return suffix ? `${suffix[1]}${suffix[2].toLowerCase()}` : null;
}

function normalizeTimeframeText(value) {
  let text = String(value || '').toLowerCase().replace(/[–—]/g, '-');
  for (const [word, number] of TIMEFRAME_WORDS) text = text.replace(new RegExp(`\\b${word}\\b`, 'g'), number);
  return text
    .replace(/\ban\s+hour\b/g, '1 hour')
    .replace(/\ba\s+day\b/g, '1 day')
    .replace(/([a-z0-9])-(?=[a-z0-9])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasTimeframeLabel(paragraph, timeframe) {
  const text = normalizeTimeframeText(paragraph);
  const patterns = {
    '5m': /\b5\s*(?:m|minutes?|mins?)\b/,
    '15m': /\b15\s*(?:m|minutes?|mins?)\b/,
    '1h': /\b1\s*(?:h|hour)\b/,
    '2h': /\b2\s*(?:h|hours?)\b/,
    '4h': /\b4\s*(?:h|hours?)(?:\s+stretch)?\b|\blast\s+4\b/,
    '24h': /\b(?:24\s*(?:h|hours?)|1\s*day)\b|\btoday\b/,
  };
  return patterns[timeframe]?.test(text) || false;
}

function numericParts(value) {
  const match = String(value || '').match(/^([+-]?)(\d+(?:\.\d+)?)(%|x)?$/);
  if (!match) return null;
  return { sign: match[1], value: Number(match[2]), suffix: match[3] || '', decimals: (match[2].split('.')[1] || '').length };
}

function safelyRoundsClaim(number, claim) {
  const written = numericParts(number);
  const source = numericParts(claim?.display);
  if (!written || !source || written.suffix !== source.suffix) return false;
  if (source.sign === '-' && written.sign !== '-') return false;
  if (source.sign !== '-' && written.sign === '-') return false;
  const tolerance = written.decimals === 0 ? 0.5 : 0.5 / (10 ** written.decimals);
  return Math.abs(written.value - source.value) < tolerance;
}

function claimAppearsInParagraph(paragraph, claim) {
  if (paragraph.includes(String(claim.display || ''))) return true;
  return (paragraph.match(NUMERIC_CLAIM) || []).some((number) => safelyRoundsClaim(number, claim));
}

function hasHistoricalRecency(text) {
  // "not just" and amount-limiter "just -0.18%" are non-temporal contrasts.
  // Present-time forms such as "BTC just surged" remain visible to the recency check.
  return RELATIVE_RECENCY.test(String(text || '')
    .replace(/\bnot\s+just\b/gi, '')
    .replace(JUST_AMOUNT_LIMITER, ''));
}

function fingerprint(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

function unique(values) {
  return [...new Set(values)];
}

function conflictShape(text) {
  const explicitA = EXPLICIT_A.test(text);
  const explicitB = EXPLICIT_B.test(text);
  const takesPosition = POSITION_TAKING.test(text);
  const framed = explicitA || explicitB || GENERIC_AB.test(text) || NATURAL_CONFLICT.test(text) || takesPosition;
  return {
    explicitA,
    explicitB,
    framed,
    takesPosition,
    hasDiscriminatingEvidence: LOSING_CASE_EXPECTATION.test(text) && CONTRADICTING_EVIDENCE.test(text),
  };
}

export function classifyHookFamily(text) {
  const opening = paragraphsOf(String(text || '')).slice(0, 2).join(' ');
  if (/\?/.test(opening)) return 'question';
  if (/\b(?:i'm not|i am not|i don't|i do not|i wouldn't|i would not)\b/i.test(opening)) return 'direct_disagreement';
  if (/\b(?:before|after|then|minutes? later|hours? later|by the time)\b/i.test(opening)) return 'timeline_mystery';
  if ((opening.match(NUMERIC_CLAIM) || []).length >= 2) return 'surprising_number';
  if (/\b(?:but|yet|while|despite|instead)\b/i.test(opening)) return 'contradiction';
  if (/\b(?:versus|vs\.?|compared with|than)\b/i.test(opening)) return 'hidden_comparison';
  return 'direct_statement';
}

export function validateContentPackage(content, candidate, options = {}) {
  if (content?.decision === 'skip') {
    return { ok: true, decision: 'skip', reason: String(content.reason || 'SKIP_CONTENT') };
  }
  const errors = [];
  if (content?.decision !== 'publish') errors.push('invalid_decision');
  const text = typeof content?.postText === 'string' ? content.postText.trim() : '';
  const normalizedText = normalizeForMatching(text);
  const paragraphs = paragraphsOf(text);
  if (NON_ENGLISH_SCRIPTS.test(text)) errors.push('public_text_not_english');
  if (UNSAFE_LANGUAGE.test(normalizedText)) errors.push('unsafe_language');
  if (BANNED_PUBLIC_LANGUAGE.test(normalizedText)) errors.push('banned_public_language');
  if (FORMULAIC_PUBLIC_COPY.test(normalizedText)) errors.push('formulaic_public_copy');
  if (candidate?.historicalReplay && hasHistoricalRecency(normalizedText)) errors.push('historical_recency_overstated');
  const cashtags = text.match(/\$[A-Z][A-Z0-9]{1,11}\b/g) || [];
  const expectedCashtag = canonicalPublicCashtag(candidate);
  if (content?.cashtag !== expectedCashtag || cashtags.length !== 1 || cashtags[0] !== expectedCashtag) {
    errors.push('invalid_cashtag');
  }
  const allowedClaims = Array.isArray(candidate?.claimsAllowed) ? candidate.claimsAllowed : [];
  const allowed = new Map(allowedClaims.map((claim) => [claim.key, claim.display]));
  const used = Array.isArray(content?.claimsUsed) ? content.claimsUsed : [];
  if (used.some((claim) => !allowed.has(claim?.key) || allowed.get(claim.key) !== claim.display)) {
    errors.push('unsupported_claim');
  }
  const supportedNumbers = new Set(used.flatMap((claim) => String(claim.display || '').match(NUMERIC_CLAIM) || []));
  const factPackPrices = [
    ...(options.factPack?.levels?.supports || []),
    ...(options.factPack?.levels?.resistances || []),
  ].filter((level) => Number.isFinite(Number(level?.midpoint)));
  for (const level of factPackPrices) {
    supportedNumbers.add(formatPublicPrice(level.midpoint, level.tickSize));
  }
  for (const claim of used) {
    const source = allowedClaims.find((item) => item.key === claim.key);
    const timeframe = timeframeFor(source || claim);
    const amount = timeframe?.match(/^\d+/)?.[0];
    if (amount) supportedNumbers.add(amount);
    const display = String(claim.display || '');
    const containing = paragraphs.filter((paragraph) => claimAppearsInParagraph(paragraph, claim));
    if (containing.length === 0) errors.push('missing_claim_display');
    if (timeframe && containing.some((paragraph) => !hasTimeframeLabel(paragraph, timeframe))) errors.push('missing_timeframe_label');
  }
  const numericClaims = text.match(NUMERIC_CLAIM) || [];
  if (numericClaims.some((number) => !supportedNumbers.has(number) && !used.some((claim) => safelyRoundsClaim(number, claim)))) {
    errors.push('unsupported_number');
  }
  const conflict = conflictShape(normalizedText);
  if (conflict.framed && !candidate?.conflict?.allowed) errors.push('conflict_not_allowed');
  if (conflict.explicitA !== conflict.explicitB || (conflict.framed && !conflict.takesPosition)) {
    errors.push('invalid_conflict_structure');
  }
  if (conflict.framed && conflict.takesPosition && !conflict.hasDiscriminatingEvidence) {
    errors.push('missing_discriminating_evidence');
  }
  if (conflict.framed && candidate?.conflict?.verdictStyle === 'calibrated' && /\b(?:definitely|clearly|the answer is)\b/i.test(normalizedText)) {
    errors.push('overstated_conflict');
  }
  if (!content?.visualIntent || !PRESETS.has(content.visualIntent.preset) || typeof content.visualIntent.revealOnOpen !== 'boolean') {
    errors.push('invalid_visual_intent');
  }
  if (content?.visualIntent?.preset === 'price_oi_divergence') {
    const relationship = deriveMarketRelationship(candidate);
    if (relationship && content.visualIntent.relationship !== relationship) errors.push('visual_fact_mismatch');
  }
  const digest = fingerprint(text);
  const openingFingerprint = fingerprint(paragraphs.slice(0, 2).join('\n\n'));
  if ((options.fingerprints || []).includes(digest)) errors.push('duplicate_content');
  if ((options.openingFingerprints || []).includes(openingFingerprint)) errors.push('repeated_opening');
  return {
    ok: errors.length === 0,
    errors: unique(errors),
    fingerprint: digest,
    hookFamily: classifyHookFamily(text),
    openingFingerprint,
  };
}
