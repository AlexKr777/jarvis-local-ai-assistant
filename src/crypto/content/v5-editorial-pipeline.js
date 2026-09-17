import { buildStoryBrief } from './story-brief.js';
import { buildEditorialFingerprint, classifyMarketStory, evaluateDiversity, selectStoryChartIntent } from './editorial-engine.js';
import { assessPublicTextRhythm } from './public-text-format.js';
import { validateV4Draft } from './v4-editorial-pipeline.js';

const GENERIC_CTA = /(?:what do you think|bullish or bearish|are you buying|would you take this trade|who else is watching)\??\s*$/i;
const FUNDING_TREND = /\bfunding\s+(?:keeps?|is|has been|was)\s+(?:rising|falling|climbing|increasing|decreasing)\b/i;
const CHANGE_OF_MIND = /\b(?:my first read|i(?:'ve| have) softened|i(?:'ve| have) refined|my view changed)\b/i;
const OI_WORDS = /\b(?:open[ -]?interest|\bOI\b)\b/i;
const TAKER_WORDS = /\b(?:taker(?:\s+(?:ratio|flow))?|buy.sell ratio)\b/i;

function compact(value, limit = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function paragraphs(text) {
  return String(text || '').trim().split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
}

function wordCount(text) {
  return compact(text, 50_000).split(/\s+/).filter(Boolean).length;
}

const V5_MIN_WORDS = 90;
const V5_MAX_WORDS = 240;
const V4_LEGACY_EDITORIAL_ERRORS = new Set(['length', 'banned_language', 'missing_human_view', 'technical_context_underused', 'unsupported_price']);
const V5_PRICE_MENTION = /(?<![\d.])\$?\d+\.\d+(?!\d|%|x|\.\d)/g;

function normalizedDecimal(value) {
  const source = String(value || '').trim().replace(/^\+/, '');
  if (!/^\d+(?:\.\d+)?$/.test(source)) return null;
  const [whole, fraction = ''] = source.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction ? `${String(Number(whole))}.${trimmedFraction}` : String(Number(whole));
}

function v5AllowedLevels(brain) {
  return [
    ['immediate', brain?.immediateLevel],
    ['structural', brain?.structuralLevel],
    ['next', brain?.nextLevel],
  ].flatMap(([focus, level]) => {
    const normalized = normalizedDecimal(level?.price);
    return normalized ? [{ focus, role: level.role, id: level.id, price: String(level.price), normalized }] : [];
  });
}

function sentenceAt(text, index) {
  const before = String(text).slice(0, index);
  const separatorsBefore = [...before.matchAll(/(?<!\d)[.!?](?=\s|$)|\n/g)];
  const start = separatorsBefore.length ? separatorsBefore.at(-1).index + 1 : 0;
  const after = String(text).slice(index);
  const endOffset = after.search(/(?<!\d)[.!?](?=\s|$)|\n/);
  return String(text).slice(start, endOffset < 0 ? String(text).length : index + endOffset);
}

function paragraphAt(text, index) {
  const value = String(text || '');
  const start = value.lastIndexOf('\n\n', index) + 2;
  const end = value.indexOf('\n\n', index);
  return value.slice(start, end < 0 ? value.length : end);
}

function hasAuthorialJudgment(text) {
  return /\b(?:interesting|useful|worth|key question|hinges|depends|matters more|little value|constructive case|the (?:practical )?read|the distinction|only after|rather than|meaningful|more interested|less comfortable|whole game|decides whether|open question)\b/i.test(text);
}

function v5TechnicalErrors(text, brain) {
  const value = String(text || '');
  const errors = [];
  const evidence = new Set(brain?.strongestEvidence || brain?.evidence || []);
  const evidencePatterns = {
    price_structure: /\b(?:higher[ -]high|higher[ -]low|lower[ -]high|lower[ -]low|structure|retest|defend(?:ed)?|reaction|continuation)\b/i,
    volume: /\bvolume\b/i,
    open_interest: /\b(?:open[ -]?interest|OI)\b/i,
    taker: /\btaker(?:\s+(?:ratio|flow))?\b/i,
    funding_snapshot: /\bfunding\b/i,
  };
  for (const type of evidence) {
    if (evidencePatterns[type] && !evidencePatterns[type].test(value)) errors.push('selected_evidence_not_used');
  }
  for (const match of value.matchAll(V5_PRICE_MENTION)) {
    const normalized = normalizedDecimal(match[0].replace('$', ''));
    const level = v5AllowedLevels(brain).find((item) => item.normalized === normalized);
    if (!level) continue;
    const sentence = sentenceAt(value, match.index).toLowerCase();
    const paragraph = paragraphAt(value, match.index).toLowerCase();
    const explicitlyNotStructural = /\b(?:not|would not|does not|doesn't)\s+(?:break\w*|lose\w*|invalidat\w*|end\w*)\b/.test(sentence);
    if (level.focus === 'immediate' && !explicitlyNotStructural && /\b(?:below|break\w*|lose\w*|loss|invalidat\w*|ends?|abandon\w*)\b/.test(sentence)) errors.push('level_role_mismatch');
    if (level.focus === 'structural' && !/\b(?:below|break\w*|lose\w*|loss|if|unless|end\w*|abandon\w*|fail\w*)\b/.test(paragraph)) errors.push('level_role_mismatch');
    if (level.focus === 'next' && /\b(?:is|becomes|as)\s+(?:the\s+)?target\b|\btarget\s+(?:at|of|for)\b|\b(?:will|going to|must reach)\b/.test(sentence)) errors.push('level_role_mismatch');
  }
  return errors;
}

function v5PriceDiagnostics(text, brain) {
  const allowed = v5AllowedLevels(brain);
  const mentions = [];
  for (const match of String(text || '').matchAll(V5_PRICE_MENTION)) {
    const raw = match[0].replace('$', '');
    const normalized = normalizedDecimal(raw);
    const level = allowed.find((item) => item.normalized === normalized);
    mentions.push({ text: match[0], parsed: normalized, accepted: Boolean(level), ...(level ? { sourceRole: level.role, sourceLevelId: level.id, canonical: level.price } : { reason: 'not_a_selected_fact_pack_level' }) });
  }
  return mentions;
}

function levelPrice(level) {
  const value = Number(level?.midpoint);
  if (!Number.isFinite(value)) return null;
  const tick = Number(level?.tickSize);
  const decimals = Number.isFinite(tick) && tick > 0 ? Math.min(12, Math.max(0, Math.ceil(-Math.log10(tick)))) : 8;
  return value.toFixed(decimals).replace(/\.?0+$/, '');
}

function allowedDerivative(factPack, key) {
  return factPack?.derivatives?.[key]?.accepted === true;
}

function evidenceFor(factPack) {
  const volume = factPack?.technicalEvidence?.volume || {};
  const structure = factPack?.technicalEvidence?.structure || {};
  const evidence = [];
  if (Object.values(structure).some((item) => item?.direction || item?.phase)) evidence.push('price_structure');
  if (volume?.trend && volume.trend !== 'insufficient_data') evidence.push('volume');
  if (allowedDerivative(factPack, 'openInterest')) evidence.push('open_interest');
  if (allowedDerivative(factPack, 'takerRatio')) evidence.push('taker');
  if (factPack?.derivatives?.funding?.accepted) evidence.push('funding_snapshot');
  return evidence;
}

export function summarizeRecentFeed(history = []) {
  const entries = (Array.isArray(history) ? history : []).slice(-20).map((entry) => ({
    text: compact(entry?.text, 2_000),
    signature: entry?.narrativeSignature || null,
  })).filter((entry) => entry.text);
  const count = (predicate) => entries.filter(({ text }) => predicate(text)).length;
  return Object.freeze({
    sampleSize: entries.length,
    repeatedOpenings: entries.map(({ text }) => paragraphs(text)[0] || '').filter(Boolean).slice(-8),
    firstPersonCount: count((text) => /\b(?:i'm|i am|i\s+(?:think|want|need|prefer|care))\b/i.test(text)),
    changeOfMindCount: count((text) => CHANGE_OF_MIND.test(text)),
    ctaCount: count((text) => /\?\s*$/.test(text)),
    watchingCount: count((text) => /\bi(?:'m| am) watching\b/i.test(text)),
    paragraphGeometries: entries.map(({ text }) => paragraphs(text).map(wordCount).join('-')),
    signatures: entries.map(({ signature }) => signature).filter(Boolean),
  });
}

export function previousPublicThesis(factPack, history = []) {
  const symbol = factPack?.identity?.symbol;
  const prior = [...(Array.isArray(history) ? history : [])].reverse()
    .find((entry) => entry?.symbol === symbol && entry?.publishedThesis && typeof entry.publishedThesis === 'object');
  return prior ? Object.freeze({ ...prior.publishedThesis, publishedAt: prior.createdAt || prior.publishedAt || null }) : null;
}

export function buildAnalystBrain(factPack, history = []) {
  const brief = buildStoryBrief(factPack);
  const reaction = brief.firstReactionZone;
  const invalidation = brief.structuralInvalidation;
  const watch = brief.nextWatch;
  const evidence = evidenceFor(factPack);
  const volumeState = factPack?.technicalEvidence?.volume?.trend;
  const oi = allowedDerivative(factPack, 'openInterest');
  const funding = factPack?.derivatives?.funding?.accepted;
  const stance = oi || funding ? 'constructive_with_positioning_caution' : 'constructive';
  return Object.freeze({
    valid: brief.valid,
    mainThesis: brief.technicalThesis,
    strongestEvidence: [brief.technicalReasoning?.observedStructure, volumeState && volumeState !== 'insufficient_data' ? `volume_${volumeState}` : null].filter(Boolean),
    counterEvidence: [oi ? 'open_interest_accepted' : null, funding ? 'funding_snapshot' : null].filter(Boolean),
    evidence,
    stance,
    certainty: oi || funding ? 'medium' : 'measured',
    immediateLevel: reaction ? { id: reaction.levelId, price: levelPrice(reaction), role: 'local_reaction', why: reaction.why } : null,
    structuralLevel: invalidation ? { id: invalidation.levelId, price: levelPrice(invalidation), role: 'structural_invalidation', why: invalidation.why } : null,
    nextLevel: watch ? { id: watch.levelId, price: levelPrice(watch), role: 'next_watch', why: watch.why } : null,
    previousPublicThesis: previousPublicThesis(factPack, history),
    recentFeed: summarizeRecentFeed(history),
  });
}

function analystBrainError(code, message) {
  const error = new Error(message);
  error.name = 'AnalystBrainContractError';
  error.code = code;
  return error;
}

function requiredString(value, field) {
  const normalized = compact(value, 360);
  if (!normalized || normalized !== String(value || '').trim() || /[\r\n]/.test(normalized)) {
    throw analystBrainError('ANALYST_BRAIN_SCHEMA_INVALID', `Analyst Brain field ${field} must be one compact string.`);
  }
  return normalized;
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw analystBrainError('ANALYST_BRAIN_SCHEMA_INVALID', `Analyst Brain field ${field} must be a string array.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

export function parseAnalystBrainOutput(raw, deterministicBrain) {
  const source = String(raw || '').trim();
  if (!source.startsWith('{')) {
    throw analystBrainError('ANALYST_BRAIN_NON_STRUCTURED_OUTPUT', 'Analyst Brain returned text outside the required JSON object.');
  }
  if (!source.endsWith('}') && /\}/.test(source)) {
    throw analystBrainError('ANALYST_BRAIN_NON_STRUCTURED_OUTPUT', 'Analyst Brain returned text outside the required JSON object.');
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw analystBrainError('ANALYST_BRAIN_JSON_INVALID', 'Analyst Brain returned malformed JSON.');
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw analystBrainError('ANALYST_BRAIN_SCHEMA_INVALID', 'Analyst Brain output must be one JSON object.');
  }
  const expectedKeys = ['mainThesis', 'stance', 'certainty', 'selectedEvidence', 'counterEvidence', 'levelFocus', 'previousThesisRelation'];
  if (Object.keys(value).length !== expectedKeys.length || expectedKeys.some((key) => !(key in value))) {
    throw analystBrainError('ANALYST_BRAIN_SCHEMA_INVALID', 'Analyst Brain JSON must use exactly the required contract fields.');
  }
  const mainThesis = requiredString(value.mainThesis, 'mainThesis');
  if (/\d/.test(mainThesis)) {
    throw analystBrainError('ANALYST_BRAIN_FACT_REFERENCE_INVALID', 'Analyst Brain mainThesis must reference levels by role, not introduce numeric values.');
  }
  const stance = requiredString(value.stance, 'stance');
  const certainty = requiredString(value.certainty, 'certainty');
  if (!['constructive', 'constructive_with_positioning_caution', 'cautious', 'mixed'].includes(stance)
    || !['measured', 'medium', 'low'].includes(certainty)) {
    throw analystBrainError('ANALYST_BRAIN_SCHEMA_INVALID', 'Analyst Brain stance or certainty is not allowed.');
  }
  const selectedEvidence = stringList(value.selectedEvidence, 'selectedEvidence');
  const counterEvidence = stringList(value.counterEvidence, 'counterEvidence');
  const allowedEvidence = new Set(deterministicBrain?.evidence || []);
  if (!selectedEvidence.length || [...selectedEvidence, ...counterEvidence].some((item) => !allowedEvidence.has(item))) {
    throw analystBrainError('ANALYST_BRAIN_FACT_REFERENCE_INVALID', 'Analyst Brain referenced evidence that is not present in the Fact Pack.');
  }
  const roles = value.levelFocus;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)
    || roles.immediate !== 'local_reaction' || roles.structural !== 'structural_invalidation' || roles.next !== 'next_watch') {
    throw analystBrainError('ANALYST_BRAIN_LEVEL_ROLE_INVALID', 'Analyst Brain changed a deterministic level role.');
  }
  const previousThesisRelation = requiredString(value.previousThesisRelation, 'previousThesisRelation');
  const allowedRelations = deterministicBrain?.previousPublicThesis ? ['confirms', 'refines', 'contradicts'] : ['none'];
  if (!allowedRelations.includes(previousThesisRelation)) {
    throw analystBrainError('ANALYST_BRAIN_SCHEMA_INVALID', 'Analyst Brain previous-thesis relation does not match persisted public history.');
  }
  return Object.freeze({ mainThesis, stance, certainty, selectedEvidence, counterEvidence, levelFocus: Object.freeze({ ...roles }), previousThesisRelation });
}

export function narrativeSignature(text, brain = {}) {
  const blocks = paragraphs(text);
  const opening = blocks[0] || '';
  return Object.freeze({
    openingMode: /^\$[A-Z0-9]+\b/.test(opening) && /\d/.test(opening) ? 'ticker_number' : /\?$/.test(opening) ? 'question' : /\b(?:but|yet|while|despite)\b/i.test(opening) ? 'contrast' : 'observation',
    mainThesisType: brain.stance || 'measured',
    evidenceMix: brain.evidence || [],
    levelEmphasis: [brain.immediateLevel?.role, brain.structuralLevel?.role, brain.nextLevel?.role].filter(Boolean),
    changeOfMindUsed: CHANGE_OF_MIND.test(text),
    paragraphGeometry: blocks.map(wordCount),
    endingMode: /\?\s*$/.test(String(text).trim()) ? 'question' : 'analysis',
    ctaPresent: GENERIC_CTA.test(text),
  });
}

export function validateV5Draft(text, { factPack, candidate, brain } = {}) {
  const base = validateV4Draft(text, { factPack, candidate });
  const errors = base.errors.filter((error) => !V4_LEGACY_EDITORIAL_ERRORS.has(error));
  const count = wordCount(text);
  if (count < V5_MIN_WORDS || count > V5_MAX_WORDS) errors.push('length');
  if (/\bgaining\s+over\s+the\s+past\b/i.test(base.text)) errors.push('malformed_sentence');
  if (!hasAuthorialJudgment(base.text)) errors.push('missing_authorial_judgment');
  errors.push(...v5TechnicalErrors(base.text, brain));
  const priceDiagnostics = v5PriceDiagnostics(base.text, brain);
  if (priceDiagnostics.some((item) => !item.accepted)) errors.push('unsupported_price');
  if (OI_WORDS.test(text) && !allowedDerivative(factPack, 'openInterest')) errors.push('derivative_evidence_not_valid');
  if (TAKER_WORDS.test(text) && !allowedDerivative(factPack, 'takerRatio')) errors.push('derivative_evidence_not_valid');
  if (FUNDING_TREND.test(text)) errors.push('funding_snapshot_as_trend');
  if (CHANGE_OF_MIND.test(text) && !brain?.previousPublicThesis && !brain?.materialContradiction) errors.push('unnecessary_change_of_mind');
  return Object.freeze({ ...base, ok: errors.length === 0, errors: [...new Set(errors)], wordCount: count, length: { words: count, acceptedRange: [V5_MIN_WORDS, V5_MAX_WORDS], platformHardMaximum: null }, priceDiagnostics });
}

function writerPrompt({ factPack, brain, draft }) {
  const levels = [brain.immediateLevel, brain.structuralLevel, brain.nextLevel].filter(Boolean)
    .map((level) => `${level.role}: ${level.price}`).join('; ');
  const derivativeRules = [
    allowedDerivative(factPack, 'openInterest') ? 'OI is accepted and may be mentioned without inventing a cause.' : 'Do not mention OI.',
    allowedDerivative(factPack, 'takerRatio') ? 'Taker evidence is accepted and may be mentioned.' : 'Do not mention taker flow.',
    factPack?.derivatives?.funding?.accepted ? 'Funding is a current snapshot only; never describe a funding trend.' : 'Do not mention funding.',
  ].join(' ');
  return `Write one substantial English crypto market note (90-240 words) from verified facts only. This is public prose, not a report or a template. Use uneven natural paragraphs; CTA is optional. Use the cashtag exactly once and only allowed prices/numbers. Never invent a trade, position, causality, prior post, or personal history. Local reaction and structural invalidation are different roles and must stay different.\n\nFACT PACK: ${factPack.identity.cashtag}; 24h ${factPack.ranking.change24h}; levels ${levels}.\nPRIVATE ANALYST BRAIN (never expose labels): thesis ${brain.mainThesis}; strongest evidence ${brain.strongestEvidence.join(', ') || 'none'}; counter-evidence ${brain.counterEvidence.join(', ') || 'none'}; stance ${brain.stance}; uncertainty ${brain.certainty}.\n${derivativeRules}\nRECENT FEED WARNING: ${JSON.stringify(brain.recentFeed)}\nDRAFT DIRECTION: ${draft}. Do not manufacture a change-of-mind story unless the supplied previous public thesis makes it necessary.`;
}

function criticPrompt({ factPack, brain, text }) {
  return `You are a surgical factual critic. Return exactly PASS, or ISSUE: CODE\nSPAN: exact short text\nINSTRUCTION: smallest possible repair. Allowed codes: UNSUPPORTED_NUMBER, WRONG_LEVEL_ROLE, INVENTED_CAUSALITY, INVENTED_PERSONAL_POSITION, BROKEN_SUBJECT, MALFORMED_SENTENCE, TICKER_IDENTITY_ERROR, CONTRADICTORY_CLAIM, GENERIC_CTA, RECENT_OPENING_REPETITION, NARRATIVE_PATTERN_REPETITION, UNNECESSARY_CHANGE_OF_MIND, DERIVATIVE_EVIDENCE_NOT_VALID. Do not request general polishing, engagement, professionalism, flow, naturalness, or a full rewrite.\nFACTS: ${factPack.identity.cashtag}; levels ${JSON.stringify([brain.immediateLevel, brain.structuralLevel, brain.nextLevel])}; derivatives ${JSON.stringify(factPack.derivatives || {})}.\nDRAFT:\n${text}`;
}

function parseCritic(raw) {
  const value = String(raw || '').trim();
  if (/^PASS\b/i.test(value)) return { verdict: 'PASS', issue: null, span: null, instruction: null };
  const issue = value.match(/ISSUE:\s*([A-Z_]+)/i)?.[1]?.toUpperCase() || 'MALFORMED_SENTENCE';
  return { verdict: 'ISSUE', issue, span: compact(value.match(/SPAN:\s*([^\n]+)/i)?.[1], 220), instruction: compact(value.match(/INSTRUCTION:\s*([^\n]+)/i)?.[1], 300) };
}

function repairPrompt({ factPack, brain, text, critic }) {
  return `Repair only the exact span in this English crypto post. Keep every unaffected sentence verbatim. Do not polish or restructure it. Return only the repaired complete post.\nISSUE: ${critic.issue}\nSPAN: ${critic.span || 'unspecified'}\nINSTRUCTION: ${critic.instruction || 'Remove the invalid phrase.'}\nFACTS: ${factPack.identity.cashtag}; levels ${JSON.stringify([brain.immediateLevel, brain.structuralLevel, brain.nextLevel])}.\nPOST:\n${text}`;
}

function selectionScore(draft, brain, recent) {
  const rhythm = assessPublicTextRhythm(draft.text);
  const diversity = evaluateDiversity({ text: draft.text, fingerprint: buildEditorialFingerprint({ text: draft.text, plan: { storyFamily: brain.stance, hookFamily: 'v5', format: 'long_form', readerExperienceFamily: brain.stance }, marketStoryCluster: '' }), recent });
  // Diversity is deliberately only a tiebreaker after factual validity.
  return { score: (rhythm.ok ? 3 : 0) + Math.min(3, brain.evidence.length) + (diversity.pass ? 1 : 0), diversity };
}

export class V5EditorialPipeline {
  constructor({ invoke } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('V5EditorialPipeline requires an invoke function.');
    this.invoke = invoke;
  }

  async generate({ factPack, candidate, editorialHistory = [] } = {}) {
    const deterministicBrain = buildAnalystBrain(factPack, editorialHistory);
    if (!deterministicBrain.valid) return { status: 'skip', reason: 'ANALYST_BRAIN_INVALID_FACT_PACK', audit: { factPack, analystBrain: deterministicBrain } };
    const analystSystem = 'You are not writing the post. Return exactly one compact JSON object and nothing else: {"mainThesis":"short private analytical fragment without numerals","stance":"constructive|constructive_with_positioning_caution|cautious|mixed","certainty":"measured|medium|low","selectedEvidence":["allowed evidence id"],"counterEvidence":["allowed evidence id"],"levelFocus":{"immediate":"local_reaction","structural":"structural_invalidation","next":"next_watch"},"previousThesisRelation":"the only relation allowed by input"}. Do not use markdown, prose, CTA, hashtags, a public opening, or a public conclusion. Select only supplied evidence ids; use level roles instead of prices in mainThesis; do not invent facts, prices, chronology, positions, or personal history.';
    const analystUser = JSON.stringify({
      deterministicState: deterministicBrain,
      contract: 'Return JSON only. selectedEvidence must be non-empty. Every evidence id must come from deterministicState.evidence. levelFocus values are fixed and must be copied exactly. previousThesisRelation must be none without previousPublicThesis; otherwise confirms, refines, or contradicts.',
    });
    const brainRaw = await this.invoke({ stage: 'analyst_brain', system: analystSystem, user: analystUser });
    let analystOutput;
    try {
      analystOutput = parseAnalystBrainOutput(brainRaw, deterministicBrain);
    } catch (error) {
      return {
        status: 'skip',
        reason: error?.code || 'ANALYST_BRAIN_SCHEMA_INVALID',
        audit: {
          factPack,
          analystBrain: deterministicBrain,
          analystBrainResponse: { raw: String(brainRaw || ''), parse: { ok: false, code: error?.code || null, message: error?.message || 'Analyst Brain contract failed.' } },
        },
      };
    }
    const analystBrainResponse = { raw: String(brainRaw || ''), parse: { ok: true, code: null, artifact: analystOutput } };
    const brain = Object.freeze({
      ...deterministicBrain,
      mainThesis: analystOutput.mainThesis,
      strongestEvidence: analystOutput.selectedEvidence,
      counterEvidence: analystOutput.counterEvidence,
      stance: analystOutput.stance,
      certainty: analystOutput.certainty,
      analystContract: analystOutput,
    });
    const [first, second] = await Promise.all([
      this.invoke({ stage: 'writer_reflection', system: 'You write factual English crypto market notes.', user: writerPrompt({ factPack, brain, draft: 'Candidate A: centre a concrete observation or price/positioning contradiction. Do not begin with a percentage headline.' }) }),
      this.invoke({ stage: 'writer_tension', system: 'You write factual English crypto market notes.', user: writerPrompt({ factPack, brain, draft: 'Candidate B: centre the level hierarchy or what would weaken the read. Use a materially different reasoning order from A.' }) }),
    ]);
    const candidates = [{ id: 'a', text: String(first || '').trim() }, { id: 'b', text: String(second || '').trim() }]
      .map((draft) => ({ ...draft, validation: validateV5Draft(draft.text, { factPack, candidate, brain }) }));
    const viable = candidates.filter((draft) => draft.validation.ok);
    if (!viable.length) return { status: 'skip', reason: 'WRITER_CONTRACT_INVALID', audit: { factPack, analystBrain: brain, analystBrainResponse, writerCandidates: candidates } };
    const ranked = viable.map((draft) => ({ ...draft, selection: selectionScore(draft, brain, editorialHistory) }))
      .sort((left, right) => right.selection.score - left.selection.score);
    let selected = ranked[0];
    const critic = parseCritic(await this.invoke({ stage: 'critic', system: 'You are a surgical factual critic.', user: criticPrompt({ factPack, brain, text: selected.text }) }));
    let repair = null;
    if (critic.verdict !== 'PASS') {
      const repairedText = await this.invoke({ stage: 'repair', system: 'You make the smallest factual repair only.', user: repairPrompt({ factPack, brain, text: selected.text, critic }) });
      const validation = validateV5Draft(repairedText, { factPack, candidate, brain });
      repair = { issue: critic.issue, span: critic.span, before: selected.text, after: String(repairedText || '').trim(), validation };
      if (!validation.ok) return { status: 'skip', reason: 'CRITIC_REPAIR_INVALID', audit: { factPack, analystBrain: brain, analystBrainResponse, writerCandidates: candidates, selected, critic, repair } };
      selected = { ...selected, id: `${selected.id}_repair`, text: validation.text, validation };
      const verification = parseCritic(await this.invoke({ stage: 'critic', system: 'You are a surgical factual critic.', user: criticPrompt({ factPack, brain, text: selected.text }) }));
      repair.verification = verification;
      if (verification.verdict !== 'PASS') return { status: 'skip', reason: 'CRITIC_REPAIR_REJECTED', audit: { factPack, analystBrain: brain, analystBrainResponse, writerCandidates: candidates, selected, critic, repair } };
    }
    const signature = narrativeSignature(selected.text, brain);
    const plan = { storyFamily: brain.stance, heroFactType: 'return24h', hookFamily: signature.openingMode, format: 'long_form', readerExperienceFamily: brain.stance, allowedChartEvidence: ['return24h', brain.immediateLevel?.id, brain.structuralLevel?.id, brain.nextLevel?.id].filter(Boolean), abConflict: { use: false } };
    const marketStoryCluster = classifyMarketStory(candidate);
    const fingerprint = buildEditorialFingerprint({ text: selected.text, plan, chartPreset: 'receipt', marketStoryCluster });
    const claimsUsed = (factPack.numbersAllowed || []).filter((claim) => claim.key === 'return24h' && selected.text.includes(claim.display)).map((claim) => ({ key: claim.key, display: claim.display }));
    const visualIntent = { ...selectStoryChartIntent(plan, candidate), preset: 'receipt', revealOnOpen: false, factIds: plan.allowedChartEvidence.filter((id) => id.startsWith('level:')) };
    const publishedThesis = { centralThesis: compact(brain.mainThesis), stance: brain.stance, keyConcern: compact(brain.counterEvidence.join(', ')), importantLevels: [brain.immediateLevel, brain.structuralLevel, brain.nextLevel].filter(Boolean).map(({ price, role }) => ({ price, role })), whatMattersNext: brain.nextLevel?.price || brain.immediateLevel?.price || null };
    return { status: 'ready', content: { decision: 'publish', reason: '', postText: selected.text, cashtag: factPack.identity.cashtag, claimsUsed, visualIntent }, plan, finalStory: { ...plan, spine: { storyKind: brain.stance, storyBrief: buildStoryBrief(factPack) } }, fingerprint, marketStoryCluster, narrativeSignature: signature, publishedThesis, audit: { factPack, analystBrain: brain, analystBrainResponse, recentFeed: brain.recentFeed, previousPublicThesis: brain.previousPublicThesis, writerCandidates: candidates, selected: { id: selected.id, text: selected.text, validation: selected.validation }, critic, repair, narrativeSignature: signature } };
  }
}
