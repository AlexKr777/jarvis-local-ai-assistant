import { createHash } from 'node:crypto';
import { deriveMarketRelationship } from './market-relationship.js';

function normalizedWords(value) {
  return String(value || '').toLowerCase().replace(/\$[a-z0-9]+/g, '$token').match(/[a-z0-9]+/g) || [];
}

function shingles(text, size = 4) {
  const words = normalizedWords(text);
  const output = new Set();
  for (let index = 0; index <= words.length - size; index += 1) output.add(words.slice(index, index + size).join(' '));
  return output;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const item of left) if (right.has(item)) common += 1;
  return common / (left.size + right.size - common);
}

function sign(value) {
  const number = Number(value || 0);
  return number > 0 ? 'up' : number < 0 ? 'down' : 'flat';
}

function paragraphs(text) {
  return String(text || '').trim().split(/\n\s*\n/).filter(Boolean);
}

function sentenceCount(value) {
  return (String(value).match(/[.!?]+(?:\s|$)/g) || []).length || (String(value).trim() ? 1 : 0);
}

function paragraphPattern(text) {
  return paragraphs(text).map((block) => sentenceCount(block)).join('-') || 'empty';
}

function openingFamily(text) {
  const opening = paragraphs(text)[0] || '';
  if (/^\$[a-z0-9]+\b/i.test(opening) && /\d/.test(opening)) return 'cashtag_number';
  if (/^\s*[+-]?\d/.test(opening)) return 'number_lead';
  if (/\?\s*$/.test(opening)) return 'question';
  return 'statement';
}

function contrastFamily(text) {
  const normalized = String(text || '').toLowerCase();
  if (/\bexcept\b/.test(normalized)) return 'except';
  if (/\bsame\b[^.!?]{0,80}\bdifferent\b/.test(normalized)) return 'same_different';
  if (/\bbut\b/.test(normalized)) return 'but';
  return 'none';
}

function endingFamily(text) {
  const ending = paragraphs(text).at(-1) || '';
  if (/\?\s*$/.test(ending)) return 'question';
  if (/\bsame\b[^.!?]{0,80}\bdifferent\b/i.test(ending)) return 'same_different';
  if (/\b(?:watch|watching|needs to|has to)\b/i.test(ending)) return 'watchpoint';
  return 'statement';
}

function displayAppearsInLabel(label, display) {
  const target = String(display || '').trim();
  if (!target) return false;

  const rendered = String(label || '');
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^\$?[-+]?\d+(?:\.\d+)?(?:%|x)?$/i.test(target)) {
    return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`, 'i').test(rendered);
  }
  return rendered.toLowerCase().includes(target.toLowerCase());
}

function normalizedAngleWords(angle = {}) {
  return normalizedWords(`${angle.humanPremise || angle.humanObservation || ''} ${angle.surprisingThing || angle.surprise || ''} ${angle.tension || ''} ${angle.readerPayoff || angle.payoff || ''}`)
    .filter((word) => !['token', 'rose', 'gained', 'up', 'with', 'while', 'and'].includes(word));
}

function overlap(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return jaccard(leftSet, rightSet);
}

function evidenceKeysForText(value, allowedEvidence = []) {
  const text = String(value || '').toLowerCase();
  const known = Array.isArray(allowedEvidence) ? allowedEvidence : [];
  const keys = new Set();
  for (const claim of known) {
    const display = String(claim?.display || '').toLowerCase().trim();
    if (display && text.includes(display)) keys.add(claim.key);
  }
  const topicMatchers = [
    { pattern: /\b(?:open[ -]?interest|oi|market exposure|participation)\b/i, key: /(?:openinterest|open_interest|(?:^|_)oi(?:_|$))/i },
    { pattern: /\bvolume\b/i, key: /volume/i },
    { pattern: /\bfunding\b/i, key: /funding/i },
    { pattern: /\b(?:taker|buy.sell)\b/i, key: /taker/i },
    { pattern: /\bliquidations?\b/i, key: /liquidation/i },
  ];
  for (const topic of topicMatchers) {
    if (!topic.pattern.test(text)) continue;
    const matchingClaim = known.find((claim) => topic.key.test(String(claim?.key || '')));
    if (matchingClaim) keys.add(matchingClaim.key);
  }
  return keys;
}

function withoutMarketMetrics(value) {
  return String(value || '')
    .replace(/\$[a-z0-9]+/gi, ' ')
    .replace(/\b(?:price|open[ -]?interest|oi|volume|funding|liquidations?|taker flow|return|metric|metrics?|ticker|token)\b/gi, ' ')
    .replace(/[+\-]?\d+(?:\.\d+)?(?:%|x)?/g, ' ');
}

export function buildStorySpines({ angles = [], selectedClaims = [] } = {}) {
  const claims = Array.isArray(selectedClaims) ? selectedClaims : [];
  const selectedKeys = claims.map((claim) => claim?.key).filter(Boolean);
  return (Array.isArray(angles) ? angles : []).slice(0, 2).map((angle) => {
    const heroEvidence = [...evidenceKeysForText(angle.heroFact, claims)];
    const evidenceNeeded = [...new Set([
      ...(heroEvidence.length ? heroEvidence : selectedKeys.slice(0, 1)),
      ...(Array.isArray(angle.supportingEvidence) ? angle.supportingEvidence : []),
    ])].filter((key) => selectedKeys.includes(key));
    return {
      angleId: String(angle.angleId || ''),
      humanThesis: String(angle.humanPremise || ''),
      readerLikelyAssumption: String(angle.readerInitialAssumption || ''),
      tension: String(angle.tension || ''),
      turn: String(angle.reveal || ''),
      payoff: String(angle.readerPayoff || ''),
      whyThisIsInteresting: String(angle.whyReaderStops || ''),
      evidenceNeeded,
      evidenceToOmit: selectedKeys.filter((key) => !evidenceNeeded.includes(key)),
      endingJob: String(angle.endingJob || ''),
      readerExperience: String(angle.readerExperienceFamily || ''),
    };
  });
}

export function evaluateStorySpines(spines = [], { allowedEvidence = [] } = {}) {
  const compact = Array.isArray(spines) ? spines.slice(0, 2) : [];
  if (compact.length !== 2) return { pass: false, reason: 'INCOMPLETE_STORY_SPINE' };
  const allowed = new Set((Array.isArray(allowedEvidence) ? allowedEvidence : []).map((claim) => claim?.key).filter(Boolean));
  const required = ['angleId', 'humanThesis', 'readerLikelyAssumption', 'tension', 'turn', 'payoff', 'whyThisIsInteresting', 'endingJob', 'readerExperience'];
  for (const spine of compact) {
    if (required.some((field) => !String(spine?.[field] || '').trim()) || !Array.isArray(spine?.evidenceNeeded) || !Array.isArray(spine?.evidenceToOmit)) {
      return { pass: false, reason: 'INCOMPLETE_STORY_SPINE', angleId: spine?.angleId || null };
    }
    const ideaWords = normalizedWords(withoutMarketMetrics(spine.humanThesis))
      .filter((word) => !['rose', 'rising', 'gained', 'climbed', 'higher', 'lower', 'faster', 'slower', 'while', 'than', 'with', 'aligned'].includes(word));
    if (ideaWords.length < 4) return { pass: false, reason: 'METRIC_CENTRIC_STORY_SPINE', angleId: spine.angleId };
    const unknownEvidence = [...spine.evidenceNeeded, ...spine.evidenceToOmit].find((key) => !allowed.has(key));
    if (unknownEvidence) return { pass: false, reason: 'UNSUPPORTED_STORY_SPINE_EVIDENCE', angleId: spine.angleId, evidenceKey: unknownEvidence };
  }
  if (compact[0].angleId === compact[1].angleId || overlap(normalizedWords(compact[0].humanThesis), normalizedWords(compact[1].humanThesis)) >= 0.55) {
    return { pass: false, reason: 'STORY_SPINE_DIVERSITY_FAIL' };
  }
  return { pass: true, reason: null };
}

export function evaluateCandidateDiversity(candidates = [], { storySpines = [] } = {}) {
  const compact = Array.isArray(candidates) ? candidates.slice(0, 2) : [];
  if (compact.length !== 2) return { pass: false, reason: 'CANDIDATE_DIVERSITY_FAIL' };
  const [left, right] = compact;
  const knownAngles = new Set((Array.isArray(storySpines) ? storySpines : []).map((spine) => spine.angleId));
  if (!knownAngles.has(left.angleId) || !knownAngles.has(right.angleId) || left.angleId === right.angleId) {
    return { pass: false, reason: 'CANDIDATE_DIVERSITY_FAIL' };
  }
  const leftClaims = (left.claimsUsed || []).map((claim) => claim.key).join('|');
  const rightClaims = (right.claimsUsed || []).map((claim) => claim.key).join('|');
  const structuralDifferences = [
    openingFamily(left.postText) !== openingFamily(right.postText),
    paragraphPattern(left.postText) !== paragraphPattern(right.postText),
    endingFamily(left.postText) !== endingFamily(right.postText),
    leftClaims !== rightClaims,
    Math.abs(normalizedWords(left.postText).length - normalizedWords(right.postText).length) >= 14,
  ].filter(Boolean).length;
  const similarity = jaccard(shingles(left.postText), shingles(right.postText));
  if (similarity >= 0.42 || structuralDifferences < 2) return { pass: false, reason: 'CANDIDATE_DIVERSITY_FAIL' };
  return { pass: true, reason: null, structuralDifferences, similarity: Math.round(similarity * 100) / 100 };
}

function evidenceSufficiency(angle, allowedEvidence = []) {
  const known = new Set((Array.isArray(allowedEvidence) ? allowedEvidence : []).map((claim) => claim?.key).filter(Boolean));
  if (!known.size) return { pass: true };
  const supportingEvidence = Array.isArray(angle.supportingEvidence) ? angle.supportingEvidence : [];
  for (const evidenceKey of supportingEvidence) {
    if (!known.has(evidenceKey)) return { pass: false, evidenceKey };
  }
  const heroEvidence = evidenceKeysForText(angle.heroFact, allowedEvidence);
  const claimedEvidence = evidenceKeysForText([
    angle.humanPremise,
    angle.whyReaderStops,
    angle.surprisingThing,
    angle.tension,
    angle.reveal,
    angle.readerPayoff,
    angle.reasonToOpenCashtag,
  ].join(' '), allowedEvidence);
  const availableEvidence = new Set([...heroEvidence, ...supportingEvidence]);
  for (const evidenceKey of claimedEvidence) {
    if (!availableEvidence.has(evidenceKey)) return { pass: false, evidenceKey };
  }
  return { pass: true };
}

export function evaluateAngleBoard(angles = [], { allowedEvidence = [] } = {}) {
  const compact = Array.isArray(angles) ? angles.slice(0, 3) : [];
  if (compact.length < 2) return { pass: false, reason: 'INSUFFICIENT_ANGLES' };
  const requiredHumanFields = ['humanPremise', 'whyReaderStops', 'readerInitialAssumption', 'surprisingThing', 'tension', 'reveal', 'readerPayoff', 'reasonToOpenCashtag', 'heroFact', 'readerExperienceFamily', 'openingFamily', 'endingJob', 'feedDifference', 'confidence'];
  for (let index = 0; index < compact.length; index += 1) {
    const angle = compact[index];
    if (!Array.isArray(angle.supportingEvidence) || requiredHumanFields.some((field) => !String(angle[field] || '').trim())) {
      return { pass: false, reason: 'INCOMPLETE_HUMAN_ANGLE', angleId: angle.angleId };
    }
    const humanIdea = String(angle.humanPremise || '')
      .replace(/\b(?:price|open interest|oi|volume|funding|liquidations?|taker flow|return|metric|metrics?)\b/gi, '')
      .replace(/[+\-]?\d+(?:\.\d+)?(?:%|x)?/g, ' ');
    const humanWords = normalizedWords(humanIdea).filter((word) => !['rose', 'rising', 'gained', 'climbed', 'higher', 'lower', 'faster', 'slower', 'while', 'than', 'with'].includes(word));
    if (humanWords.length < 4 || (!String(angle.readerInitialAssumption || '').trim() && !String(angle.tension || '').trim())) {
      return { pass: false, reason: 'METRIC_CENTRIC_ANGLE', angleId: angle.angleId };
    }
    const evidence = evidenceSufficiency(angle, allowedEvidence);
    if (!evidence.pass) return { pass: false, reason: 'UNSUPPORTED_ANGLE_CLAIM', angleId: angle.angleId, evidenceKey: evidence.evidenceKey };
    for (let other = index + 1; other < compact.length; other += 1) {
      const left = angle;
      const right = compact[other];
      const sameShape = left.storyFamily === right.storyFamily
        && left.openingMechanic === right.openingMechanic
        && left.endingJob === right.endingJob;
      if (sameShape && overlap(normalizedAngleWords(left), normalizedAngleWords(right)) >= 0.38) {
        return { pass: false, reason: 'SYNONYM_ANGLE_BOARD', pair: [left.angleId, right.angleId] };
      }
    }
  }
  return { pass: true, reason: null };
}

export function selectBestDraft(candidates = [], selection = {}) {
  const required = ['surprise', 'scrollStop', 'readThrough', 'humanVoice', 'eventSpecificity', 'payoff', 'cashtagCuriosity', 'feedNovelty', 'noAiSlop', 'compression'];
  const supporting = ['pointOfView', 'readerReward', 'insightNovelty'];
  const scored = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const scores = candidate.scores || {};
    const weak = required.filter((key) => Number(scores[key]) < 7);
    const weakSupporting = supporting.filter((key) => Number(scores[key]) < 6);
    const merit = Number(scores.surprise || 0) + Number(scores.scrollStop || 0) + Number(scores.readThrough || 0)
      + Number(scores.humanVoice || 0) + Number(scores.eventSpecificity || 0) + Number(scores.pointOfView || 0)
      + Number(scores.payoff || 0) + Number(scores.cashtagCuriosity || 0) + Number(scores.feedNovelty || 0)
      + Number(scores.noAiSlop || 0) + Number(scores.compression || 0);
    return { ...candidate, scores, weak, weakSupporting, merit };
  }).filter((candidate) => candidate.weak.length === 0 && candidate.weakSupporting.length === 0 && candidate.underdevelopedStory !== true);
  if (!scored.length) return { pass: false, reason: 'NO_CANDIDATE_WITH_EDITORIAL_MERIT', winner: null };
  const selectorWinner = scored.find((candidate) => candidate.candidateId === selection.winner);
  scored.sort((left, right) => {
    if (selectorWinner) {
      if (left.candidateId === selectorWinner.candidateId) return -1;
      if (right.candidateId === selectorWinner.candidateId) return 1;
    }
    return right.merit - left.merit;
  });
  return { pass: true, reason: null, winner: scored[0], candidates: scored };
}

function nonConclusionPattern(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const observationThenUnknown = /\b(?:numbers?|data|evidence|metrics?|structure)\b[^.]{0,110}\b(?:do(?:es)? not|don't|cannot|can't|fail to)\b[^.]{0,90}\b(?:reveal|show|tell|establish|distinguish|determine|confirm)\b/;
  const unresolvedSubject = /\b(?:positioning|participation|exposure|driver|cause|intent|read)\b[^.]{0,70}\b(?:is|remains|stays)\b[^.]{0,50}\b(?:unclear|unknown|unresolved|ambiguous|not clear|open to interpretation)\b/;
  const falseClarityEnding = /\b(?:advance|rally|move|price action)\b[^.;]{0,55}\bis clear\b[^.;]{0,90}\b(?:positioning|participation|driver|cause)\b[^.;]{0,70}\b(?:is not|isn't|remains unclear|remains unknown)\b/;
  const twoPossibilities = /\b(?:may|might|could|can)\b[^.]{0,100}\b(?:or|but)\b[^.]{0,100}\b(?:may|might|could|can)\b/;
  const terminalUnknown = /\b(?:cannot|can't|do not|don't)\b[^.]{0,100}\b(?:distinguish|determine|know|tell|establish|confirm)\b/;
  return observationThenUnknown.test(normalized)
    || unresolvedSubject.test(normalized)
    || falseClarityEnding.test(normalized)
    || (twoPossibilities.test(normalized) && terminalUnknown.test(normalized));
}

export function evaluateEditorialMerit(text = '') {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return { score: 0, hasTension: false, hasAssumptionShift: false, hasReaderPayoff: false };
  const hasTension = /\b(?:but|yet|except|although|instead|rather than|even though|still)\b/.test(normalized);
  const hasAssumptionShift = /\b(?:obvious|easy|natural|usual|common|first)\s+(?:read|reaction|assumption|take|view)\b|\b(?:assume|expect|expectation|too late)\b|\b(?:most|moves?)\b.{0,45}\b(?:usually|normally|start|should)\b.{0,55}\b(?:cool(?:ing)?|fad(?:e|ing)|slow(?:ing)?|tire(?:d|s)?)\b|\byou(?:'d| would) expect\b/.test(normalized);
  const hasReaderPayoff = /\b(?:changes?|reframes?|makes? .{0,50}\b(?:incomplete|different)\b|not the whole story|worth (?:opening|watching|checking)|found another gear|not (?:a )?(?:slow|quiet) (?:grind|move)|almost no damage)\b/.test(normalized);
  let score = 5 + Number(hasTension) + Number(hasAssumptionShift) + Number(hasReaderPayoff);
  // A contrast alone is a competent caption, not a reader-changing story.
  if (!hasAssumptionShift) score = Math.min(score, 6);
  return { score, hasTension, hasAssumptionShift, hasReaderPayoff };
}

export function evaluateEditorialPreGate({ text = '', recent = [] } = {}) {
  const blocks = paragraphs(text);
  const normalized = String(text).toLowerCase();
  const modalCount = (normalized.match(/\b(?:can|could|may|might)\b/g) || []).length;
  const numbers = (normalized.match(/(?:[+-]?\d+(?:\.\d+)?%|\d+(?:\.\d+)?x)/g) || []).length;
  const bothSidesWithoutView = /\b(?:can|could|may|might)\b[^.]{0,180}\b(?:but|although|or)\b[^.]{0,120}\b(?:can|could|may|might)\b/.test(normalized)
    || /\b(?:open to interpretation|requires interpretation|further confirmation)\b/.test(normalized);
  const nonConclusionAnalystPattern = nonConclusionPattern(text);
  const analystTone = bothSidesWithoutView || nonConclusionAnalystPattern
    || (/\b(?:positioning|exposure)\b/.test(normalized) && modalCount >= 2)
    || /\b(?:the rally|the move) is clear\b/.test(normalized)
    || /\b(?:not a confirmed reversal|active pause|market structure|the real story|contained noise|changed the character of the move)\b/.test(normalized);
  const weakEnding = /(?:open to interpretation|requires interpretation|remains uncertain|further confirmation)[.!?]?$/.test(normalized.trim()) || nonConclusionAnalystPattern;
  const equalFourParagraphRhythm = blocks.length === 4 && blocks.every((block) => sentenceCount(block) === 1);
  const hasStoryDevelopment = /\b(?:but|yet|except|although|instead|that(?:'s| is) the part|which (?:makes|means)|the obvious|not proof|does(?:n't| not))\b/i.test(normalized);
  const editorialMerit = evaluateEditorialMerit(text);
  const underdevelopedStory = (blocks.length <= 2 && numbers >= 2 && !hasStoryDevelopment) || editorialMerit.score < 7;
  const recentSkeleton = recent.slice(-8).some((entry) => {
    const prior = paragraphs(entry.text);
    return prior.length === blocks.length && prior.length === 4
      && prior.every((block) => sentenceCount(block) === 1) && equalFourParagraphRhythm;
  });
  const risks = {
    analystTone,
    nonConclusionAnalystPattern,
    templateSimilarity: recentSkeleton,
    bothSidesWithoutView,
    metricDump: numbers > 3,
    weakHook: blocks.length > 0 && !/\d|\$[a-z0-9]+/i.test(blocks[0]),
    weakPayoff: nonConclusionAnalystPattern,
    genericEnding: nonConclusionAnalystPattern,
    weakEnding,
    underdevelopedStory,
  };
  const failures = Object.entries(risks).filter(([, value]) => value).map(([key]) => key);
  if (modalCount >= 3) failures.push('excessive_modal_hedging');
  return { pass: failures.length === 0, failures: [...new Set(failures)], risks, editorialMerit: editorialMerit.score, paragraphCount: blocks.length, modalCount, metricCount: numbers };
}

export function evaluateCriticGate(critic = {}, { text = '' } = {}) {
  const scores = critic.scores || {};
  const requiredScores = ['scrollStop', 'humanVoice', 'eventSpecificity', 'cashtagCuriosity', 'noAiSlop', 'payoff', 'feedNovelty', 'readerReward', 'insightNovelty'];
  const lowScores = requiredScores.filter((key) => Number(scores[key]) < 7);
  const editorialMerit = text ? evaluateEditorialMerit(text).score : null;
  if (editorialMerit !== null && editorialMerit < 7) lowScores.push('editorialMerit');
  const hardRisks = Object.entries(critic.risks || {}).filter(([, value]) => value).map(([key]) => key);
  return { pass: critic.decision === 'PASS' && lowScores.length === 0 && hardRisks.length === 0, lowScores, hardRisks, editorialMerit };
}

export function classifyMarketStory(candidate = {}) {
  const metrics = candidate.metrics || {};
  const occurredAt = Math.floor(Number(candidate.occurredAt || 0) / (60 * 60_000));
  const broad = sign(metrics.return4hPct ?? metrics.return1hPct);
  const short = sign(metrics.return15mPct ?? metrics.return5mPct);
  const relationship = candidate.marketRelationship || deriveMarketRelationship(candidate) || 'none';
  return `${occurredAt}:${broad}:${short}:${relationship}`;
}

export function buildEditorialFingerprint({ text = '', plan = {}, chartPreset = 'receipt', marketStoryCluster = '' } = {}) {
  const opening = normalizedWords(String(text).split(/\n\s*\n/)[0]).slice(0, 12).join(' ');
  return {
    storyFamily: String(plan.storyFamily || 'other'),
    hookFamily: String(plan.hookFamily || 'direct_statement'),
    formatFamily: String(plan.format || 'short'),
    endingFamily: endingFamily(text),
    openingFamily: openingFamily(text),
    paragraphPattern: paragraphPattern(text),
    contrastFamily: contrastFamily(text),
    chartPreset,
    lengthBucket: String(text).trim().split(/\s+/).filter(Boolean).length < 70 ? 'short' : 'medium',
    marketStoryCluster,
    abUsed: Boolean(plan.abConflict?.use),
    heroFactType: String(plan.heroFactType || 'other'),
    readerExperienceFamily: String(plan.readerExperienceFamily || 'other'),
    openingFingerprint: createHash('sha256').update(opening).digest('hex'),
  };
}

export function evaluateDiversity({ text = '', fingerprint = {}, recent = [] } = {}) {
  const subject = shingles(text);
  for (const prior of recent.slice(-20)) {
    const similarity = jaccard(subject, shingles(prior.text));
    const sameFingerprint = prior.fingerprint
      && fingerprint.storyFamily === prior.fingerprint.storyFamily
      && fingerprint.hookFamily === prior.fingerprint.hookFamily
      && fingerprint.chartPreset === prior.fingerprint.chartPreset
      && fingerprint.marketStoryCluster === prior.fingerprint.marketStoryCluster;
    if (similarity >= 0.42 || (sameFingerprint && similarity >= 0.22)) {
      return { pass: false, reason: 'DIVERSITY_CONFLICT', similarity: Math.round(similarity * 100) / 100 };
    }
    const priorFingerprint = prior.fingerprint || {};
    const structuralMatches = [
      fingerprint.storyFamily === priorFingerprint.storyFamily,
      fingerprint.hookFamily === priorFingerprint.hookFamily,
      fingerprint.openingFamily === priorFingerprint.openingFamily,
      fingerprint.paragraphPattern === priorFingerprint.paragraphPattern,
      fingerprint.contrastFamily === priorFingerprint.contrastFamily && fingerprint.contrastFamily !== 'none',
      fingerprint.endingFamily === priorFingerprint.endingFamily,
      fingerprint.readerExperienceFamily === priorFingerprint.readerExperienceFamily,
      fingerprint.abUsed === priorFingerprint.abUsed,
    ].filter(Boolean).length;
    if (structuralMatches >= 6) {
      return { pass: false, reason: 'FEED_REPETITION', similarity: Math.round(similarity * 100) / 100, structuralMatches };
    }
  }
  return { pass: true, reason: null, similarity: 0 };
}

export function selectStoryChartIntent(plan = {}, candidate = {}) {
  const story = plan.storyFamily;
  if (story === 'volume_shock' || story === 'contained_damage' || story === 'activity_without_direction') return { preset: 'volume_shock', relationship: 'none', revealOnOpen: false };
  if (story === 'reversal' || story === 'runner_pullback' || story === 'rally_resilience' || story === 'scale_conflict') return { preset: 'timeline_mystery', relationship: 'none', revealOnOpen: true };
  if (story === 'major_runner') return { preset: 'receipt', relationship: 'none', revealOnOpen: false };
  const allowedEvidence = Array.isArray(plan.allowedChartEvidence) ? new Set(plan.allowedChartEvidence) : null;
  if (allowedEvidence && !allowedEvidence.has('openInterestChange')) return { preset: 'receipt', relationship: 'none', revealOnOpen: false };
  const relationship = candidate.marketRelationship || deriveMarketRelationship(candidate);
  return relationship
    ? { preset: 'price_oi_divergence', relationship, revealOnOpen: true }
    : { preset: 'receipt', relationship: 'none', revealOnOpen: false };
}

export function validateStoryChart({ candidate = {}, plan = {}, finalStory = null, visualIntent = {}, chart = {} } = {}) {
  if (chart.width !== 1200 || chart.height !== 900) return { pass: false, reason: 'VISUAL_DIMENSIONS_INVALID' };
  if (!Array.isArray(chart.labels) || !chart.labels.some((label) => String(label).includes(candidate.cashtag || candidate.symbol || ''))) {
    return { pass: false, reason: 'VISUAL_SYMBOL_MISMATCH' };
  }
  const story = finalStory || plan;
  const expected = selectStoryChartIntent(story, candidate);
  if (visualIntent.preset !== expected.preset || visualIntent.relationship !== expected.relationship) {
    return { pass: false, reason: finalStory ? 'CHART_STORY_MISMATCH' : 'VISUAL_STORY_MISMATCH' };
  }
  const labels = chart.labels.map((label) => String(label));
  const allowedChartEvidence = new Set(finalStory?.allowedChartEvidence || []);
  if (finalStory && visualIntent.preset === 'price_oi_divergence' && !allowedChartEvidence.has('openInterestChange')) {
    return { pass: false, reason: 'CHART_STORY_MISMATCH' };
  }
  if (finalStory && labels.some((label) => /\bOPEN INTEREST\b/i.test(label)) && !allowedChartEvidence.has('openInterestChange')) {
    return { pass: false, reason: 'CHART_STORY_MISMATCH' };
  }
  if (finalStory) {
    const unauthorizedMetric = (candidate.claimsAllowed || []).find((claim) => (
      !allowedChartEvidence.has(claim.key)
      && String(claim.display || '').trim()
      && labels.some((label) => displayAppearsInLabel(label, claim.display))
    ));
    if (unauthorizedMetric) return { pass: false, reason: 'CHART_STORY_MISMATCH' };
    const allowedDisplays = (candidate.claimsAllowed || [])
      .filter((claim) => allowedChartEvidence.has(claim.key))
      .map((claim) => String(claim.display || '').toLowerCase())
      .concat(String(finalStory.heroMetric?.display || '').toLowerCase())
      .filter(Boolean);
    const inventedMetric = labels.some((label) => /[+-]?\d+(?:\.\d+)?(?:%|x)(?![a-z0-9])/i.test(label)
      && !allowedDisplays.some((display) => displayAppearsInLabel(label, display)));
    if (inventedMetric) return { pass: false, reason: 'CHART_STORY_MISMATCH' };
  }
  const fifteenMinuteIsHero = story.heroFactType === 'return15m';
  if (!fifteenMinuteIsHero && chart.labels.some((label) => /\bLAST\s+15\s+MIN\b/i.test(String(label)))) {
    return { pass: false, reason: 'VISUAL_UNEXPECTED_15M' };
  }
  const latest = Number(candidate.metrics?.candles?.at(-1)?.closeTime || 0);
  if (candidate.historicalReplay && latest > Number(candidate.occurredAt || 0)) return { pass: false, reason: 'VISUAL_LOOKAHEAD' };
  return { pass: true, reason: null };
}
