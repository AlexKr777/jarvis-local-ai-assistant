import { spawn as spawnProcess } from 'node:child_process';
import { canonicalPublicCashtag } from '../market/token-identity.js';
import { buildEditorialFingerprint, classifyMarketStory, evaluateDiversity, selectStoryChartIntent } from './editorial-engine.js';
import { V4EditorialPipeline } from './v4-editorial-pipeline.js';
import { V5EditorialPipeline } from './v5-editorial-pipeline.js';

const DEFAULT_MODEL = 'gemma4:12b-it-q4_K_M';
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const WRITER_TIMEOUT_MS = 120_000;
const RECOVERY_WAIT_MS = 1_000;
const BANNED_GEMMA_LANGUAGE = Object.freeze([
  'intense massive participation', 'intense participation', 'market participation', 'participation expanded',
  'rapid price action is taking hold', 'highlights intense', 'highlights strong', 'highlights recent',
  'this highlights', 'this showcases', 'this demonstrates', 'huge activity just hit the tape',
  'watch the move', 'keep an eye on', 'market structure', 'broader structure', 'contained noise',
  'the real story', 'active pause', 'not a confirmed reversal', 'continuation structure', 'footprint',
  'follow-through momentum', 'market participants', 'interesting activity', 'notable activity',
  'data suggests', 'the setup remains', 'the broader daily trend', 'the broader move remains active',
  'catch the momentum', 'catching eyes', 'massive activity is unfolding', 'huge activity is unfolding',
  'this indicates massive activity', 'significant price action', 'move intensity', 'the move gained significant speed',
  'steady upward move', 'move is picking up speed', 'high activity is meeting heavy demand',
  'intense activity is concentrated', 'clear acceleration in price action', 'fast moves are happening now',
  'rapid price acceleration recently', 'high activity meets intense price action',
  'significant upward movement', 'significant activity', 'strong trend', 'upward trend', 'upward momentum',
  'current level', 'current period', 'for the asset', 'consistent growth', 'recent activity', 'high volume activity',
  'for the token', 'significant gain for the token', 'large move for the asset',
  'marking a significant move', 'marking a significant', 'primary move gained momentum', 'during the short period',
  'sign of consolidation', 'a brief pause', 'rapid price action', 'the asset maintained', 'fresh momentum',
  'new momentum', 'a cooling period', 'new push for price', 'will the price hold', 'did you notice',
  'major daily move', 'significant daily gain', 'price action gained strength', 'consistent gains',
  'steady climb', 'sustained push', 'minor pullback', 'brief rest', 'local peak', 'continuing push',
  'brief spike', 'momentary burst', 'period of consolidation', 'strong daily move', 'daily gain met',
  'past performance is no guarantee of future results', 'past performance, no guarantee of tomorrow',
  'this is not financial advice', 'do your own research', 'only time will tell',
  'i bought', 'i purchased', 'i loaded', 'i entered', 'i was right', 'my profit', 'my profits',
  'my position', 'my entry', 'i am in profit', "i'm in profit", 'i profited', 'i made money',
]);

const LEGACY_GEMMA_CRYPTO_SYSTEM_PROMPT = `You write ONE short Binance Square post about a cryptocurrency market event.

The application has already decided that this event is interesting enough to publish. Your only job is to understand the supplied VERIFIED FACTS and turn them into a strong human social post.

LANGUAGE: English.
LENGTH: Usually 45-80 words.
USE ONLY VERIFIED FACTS. Use the supplied cashtag exactly once, preferably as the first token of the first line. Copy any number you use with its exact displayed precision and sign: write +46.88%, not 47%, 46.9%, or 46.88%.

Never invent numbers, price changes, volume, open interest, liquidations, news, catalysts, whales, buyers or sellers, institutions, insider activity, or causation.

FIRST UNDERSTAND THE NUMBERS.
Compare nested time windows correctly. If 24h is +46.88%, 1h is +0.72%, and 15m is +2.03%, the latest 15 minutes gained more than the full one-hour result: that is strong recent acceleration. It does NOT mean "no follow-through momentum", and +0.72% must not automatically be called "flat".

If 24h is +10% and 4h is +9%, most of the daily move happened in the latest four hours. If 4h is +6%, 1h is +1%, and 15m is -0.5%, the wider move is strong but the newest edge is pulling back. If volume is 13.6x while 15m price is -0.18%, the story is huge activity with very little price reaction.

Find the real interesting relationship between the supplied numbers.

POST STRUCTURE:
1. strongest verified hook in the first line
2. why that number is weird or interesting
3. one or two facts proving it
4. short punchy payoff

Write a social-feed post, not a market summary. Prefer a concrete construction such as "$TOKEN is up +10.47% today — and +8.63% of that happened in four hours." or "13.6x normal volume hit $TOKEN — while price slipped -0.18% in 15m." Do not reuse these examples literally unless their facts are supplied.

Put a huge verified number such as +10%, +20%, +40%, or 10x volume in the first line when present.

STYLE: human, simple English, short sentences, energetic, social-feed style, easy to understand instantly, factual.

Do not sound like an analyst report, research memo, AI summary, legal disclaimer, or trading signal. Never use generic endings such as "Past performance is no guarantee of future results.", "This is not financial advice.", "Do your own research.", "Only time will tell.", or "Traders should keep an eye on this."

Avoid analyst sludge: market structure, broader structure, participation expanded, alignment, contained noise, the real story, active pause, not a confirmed reversal, continuation structure, footprint, follow-through momentum, significant strength, strong momentum, broader daily trend, remains robust, significant price action, move intensity, or "is showing".

Do not manufacture hype. Do not give buy or sell advice, targets, or guarantees.

OUTPUT ONLY THE FINAL PUBLIC POST. No reasoning, explanation, headings, scores, internal comments, markdown, or JSON wrapper. If the facts genuinely cannot support a factual post, output exactly SKIP.`;

export const OLLAMA_GEMMA_CRYPTO_SYSTEM_PROMPT = `Write ONE Binance Square post from ONLY the supplied VERIFIED FACTS.

OUTPUT: exactly FOUR non-empty paragraphs, separated by exactly ONE blank line. Return only the post. No title, JSON, analysis, markdown, or checklist. If the event cannot be described factually, return only {"skip":true}.

LENGTH: normally 45-85 words; never more than 95. Use the supplied cashtag exactly once. Copy every used number with its exact sign and precision.

PARAGRAPH 1 — one-sentence hook. Include the cashtag and strongest verified number immediately, then say why it matters. Do not waste the opening.

PARAGRAPH 2 — proof. Use at most three verified metrics. Explain their relationship in simple English; do not dump numbers.

PARAGRAPH 3 — payoff. One meaningful event-specific statement, no more than about 15 words.

If the VERIFIED EVENT PACKAGE says bullishScenarioArrow is true, paragraph 3 may use a warm first-person watchlist view. It remains a personal view, never a price target, trading instruction, or guarantee. Do not force legal-sounding wording such as "not a certainty".

PARAGRAPH 4 — one short question ending in ?. Speak directly to the reader using "you" and offer two natural interpretations, normally using "or". Make the reader feel the immediate choice between catching this specific move and watching it, but never claim they made money, missed guaranteed profits, or should buy. It is a reader question, not a prediction, trading advice, target, or urgency.

UNDERSTAND NESTED WINDOWS. If 24h is +46.88%, 1h is +0.72%, and 15m is +2.03%, the latest 15 minutes beat the entire last hour: recent acceleration. Do not call +6.61% "most" of +46.88%. If volume is 13.6x and 15m price is -0.18%, say huge activity produced almost no immediate price reaction. Never invent people, causes, demand, supply, news, liquidations, whales, or positioning.

Use normal human words: rose, fell, jumped, added, lost, accelerated, slowed, pulled back, held, moved, spiked; and price, volume, hour, day, move. Do not stack strong adjectives; at most one of massive, huge, insane.

NEVER USE: intense massive participation; intense participation; market participation; participation expanded; rapid price action is taking hold; highlights intense; highlights strong; highlights recent; this highlights; this showcases; this demonstrates; huge activity just hit the tape; watch the move; keep an eye on; market structure; broader structure; contained noise; the real story; active pause; not a confirmed reversal; continuation structure; footprint; follow-through momentum; market participants; interesting activity; notable activity; data suggests; the setup remains; Past performance is no guarantee of future results; This is not financial advice; Do your own research.

WRITE TIMEFRAMES IN FULL WORDS next to every number: "24 hours" or "today", "4 hours", "2 hours", "1 hour", "15 minutes", "5 minutes". Never write 24h, 4h, 2h, 1h, 15m, or 5m. Never mention a supplied metric without its exact displayed number.

Do not use vague filler: significant upward movement, significant activity, strong trend, upward trend, upward momentum, current level, current period, asset, consistent growth, recent activity, high volume activity, consolidation, brief pause, or the phrase "showing". Do not describe volume as a cause of price movement.

Paragraph 2 uses no more than TWO extra metrics after the hook. Paragraph 3 must not introduce a new metric; turn the exact relationship already stated into a short concrete payoff. For a daily runner, say what time window made the move unusual. For a volume shock, say "Huge activity. Almost no price reaction." For a pullback, say the strong wider move met a short-term pullback. Never use a generic observation.

Make paragraph 4 event-specific and address the reader. Do not ask "will the price hold", "did you notice", "was it steady", "sign of consolidation", "a pause", "fresh momentum", "new momentum", or "a cooling period". Prefer a direct question such as "Did you catch this move, or are you watching the next leg from the sidelines?" For a volume shock, connect that direct question to the unusual volume; for a runner, to the rapid move; for a pullback, to the reset-versus-cooldown choice.

For a verified continuation post, the event package will say post number 2 or 3. Treat it as a new update, not a rewrite of the first post: lead with the fresh verified number and explain that the earlier move did not fade. Post 2 can naturally say the first jump did not fade. Post 3 can naturally say the move still has not cooled off. Use a warm human watchlist point of view to create anticipation: the author may say they are watching the setup closely or considering an entry if it keeps holding. Paragraph 3 MUST use a first-person watchlist voice about considering a possible entry, not a generic market summary. Paragraph 3 MUST start with "I'm" or "I am". Paragraph 4 must contain only the reader question, with no first-person claim. Make it feel like an unfolding move and make the question of timing interesting, never like a dry disclaimer. Never imply the author bought, sold, held, or profited; never write "I was right", "I bought", "my position", "my entry", or personal gains. Keep the energy in the market fact and a possible decision, not a made-up trade story.

The VERIFIED EVENT PACKAGE includes a WRITING BRIEF chosen from the facts. Follow its factual angle, payoff meaning, and question axis. It is guidance only: write your own natural English, but do not substitute a generic synonym for its event-specific payoff or choice.

For a fresh-acceleration runner, use this exact idea in natural words: "$TOKEN is up +X% today — and the latest 15 minutes beat the entire last hour." Do not add "for the asset", "for the token", "marking a move", or another generic label. State the comparison with both exact values in paragraph 2, then say the big daily move accelerated again in paragraph 3.

FINAL WRITING PATTERNS: a volume shock hook contrasts volume with the small immediate price move; a fresh acceleration hook contrasts 15 minutes with one hour; a multi-hour runner hook says most or almost all of the day happened in four hours only when the facts support it; a runner-pullback hook contrasts the wider gain with the latest pullback. In paragraph 3, name that exact contrast in plain words. Do not write "marking", "significant move", "primary move", "gained momentum", or another label instead of the contrast.

MANDATORY HOOK SKELETONS — select the one matching the WRITING BRIEF and fill it only with supplied facts: fresh acceleration: "$TOKEN is up +X% today — and the latest 15 minutes beat the entire last hour." Volume shock: "Xx normal volume hit $TOKEN — but price moved only Y% in 15 minutes." Multi-hour runner: "$TOKEN is up +X% today — and most of the move came in four hours." Runner-pullback: "$TOKEN rose +X% today — but price just pulled back Y% in 15 minutes." Do not append a generic explanation to these hooks. Never use "for the asset", "for the token", "highlighting", "showing why", or an unsupported cause.

Silently verify: four paragraphs, correct cashtag, exact verified numbers, factual first three paragraphs, event-specific payoff, and a final A/B question.`;

export class OllamaWriterError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'OllamaWriterError';
    this.code = code;
    this.retryable = retryable;
  }
}

function compactText(value, maximum = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normalizeGemmaPost(value) {
  const paragraphs = String(value || '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  return { paragraphs, text: paragraphs.join('\n\n') };
}

function matchingBannedPhrase(text) {
  const lower = String(text || '').toLowerCase();
  return BANNED_GEMMA_LANGUAGE.find((phrase) => lower.includes(phrase)) || null;
}

export function validateGemmaPostContract(value, candidate = {}) {
  const { paragraphs, text } = normalizeGemmaPost(value);
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  const expectedCashtag = canonicalPublicCashtag(candidate);
  const cashtags = text.match(/\$[A-Z][A-Z0-9]{1,11}\b/g) || [];
  const bannedPhrase = matchingBannedPhrase(text);
  const strongAdjectives = text.match(/\b(?:massive|huge|insane)\b/gi) || [];
  const errors = [];

  if (paragraphs.length !== 4) errors.push('paragraph_count_invalid');
  if (words.length > 95) errors.push('word_count_invalid');
  if (!expectedCashtag || cashtags.length !== 1 || cashtags[0] !== expectedCashtag) errors.push('cashtag_invalid');
  if (bannedPhrase) errors.push('banned_language');
  if (strongAdjectives.length > 1) errors.push('stacked_strong_adjectives');
  if (paragraphs[0] && !/[.!?]$/.test(paragraphs[0])) errors.push('hook_sentence_invalid');
  if (paragraphs[2] && (paragraphs[2].split(/\s+/).length > 15 || /\?$/.test(paragraphs[2]))) errors.push('payoff_invalid');
  const question = paragraphs[3] || '';
  if (!question.endsWith('?') || !/\bor\b/i.test(question)) errors.push('ending_question_invalid');
  if (!/\b(?:did|do|have|are|were|will|can)\s+you\b|\byou(?:'re| are)\b/i.test(question)) errors.push('reader_question_invalid');

  return { ok: errors.length === 0, errors, text, paragraphs, wordCount: words.length };
}

function parseNumeric(value) {
  const match = String(value || '').trim().match(/^([+-]?)(\d+(?:\.\d+)?)(%|x)$/i);
  return match ? { sign: match[1], value: Number(match[2]), suffix: match[3].toLowerCase(), decimals: (match[2].split('.')[1] || '').length } : null;
}

function claimMatchesNumber(claim, number) {
  const source = parseNumeric(claim?.display);
  const written = parseNumeric(number);
  if (!source || !written || source.suffix !== written.suffix) return false;
  if (source.sign === '-' && written.sign !== '-') return false;
  if (source.sign !== '-' && written.sign === '-') return false;
  const tolerance = written.decimals === 0 ? 0.5 : 0.5 / (10 ** written.decimals);
  return Math.abs(source.value - written.value) < tolerance;
}

function claimsUsedBy(text, candidate) {
  const numbers = String(text || '').match(/[+-]?\d+(?:\.\d+)?(?:%|x)/gi) || [];
  return (candidate?.claimsAllowed || [])
    .map((claim) => ({ claim, index: numbers.findIndex((number) => claimMatchesNumber(claim, number)) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map(({ claim }) => ({ key: claim.key, display: claim.display }));
}

function storyFamily(candidate, claims) {
  const keys = new Set(claims.map((claim) => claim.key));
  if ([...keys].some((key) => /volume/i.test(key))) return 'volume_shock';
  if ([...keys].some((key) => /liquidation/i.test(key))) return 'reversal';
  if (keys.has('return24h')) return 'major_runner';
  if ([...keys].some((key) => /return(?:1h|2h|4h)/i.test(key))) return 'runner_pullback';
  return 'other';
}

function planFor(candidate, claims, postText) {
  const usedKeys = new Set(claims.map((claim) => claim.key));
  const hero = (candidate.claimsAllowed || []).find((claim) => claim.key === claims[0]?.key) || null;
  const family = storyFamily(candidate, claims);
  const plan = {
    storyFamily: family,
    heroFactType: hero?.key || 'other',
    heroFact: hero?.display || '',
    hookFamily: /^\$[A-Z0-9]+\b/.test(postText.trim()) ? 'direct_statement' : 'surprising_number',
    format: postText.trim().split(/\s+/).length < 70 ? 'short' : 'medium',
    allowedChartEvidence: [...usedKeys],
    abConflict: { use: false },
    readerExperienceFamily: family,
  };
  const visualIntent = selectStoryChartIntent(plan, candidate);
  return {
    plan,
    visualIntent,
    finalStory: { ...plan, heroMetric: hero, allowedChartEvidence: [...usedKeys], selectedChartIntent: visualIntent },
  };
}

function writerFacts(candidate, editorialHistory) {
  const allClaims = Array.isArray(candidate?.claimsAllowed) ? candidate.claimsAllowed : [];
  const byKey = (key) => allClaims.find((claim) => claim.key === key);
  const return24h = byKey('return24h');
  const return4h = byKey('return4h');
  const return2h = byKey('return2h');
  const return1h = byKey('return1h');
  const return15m = byKey('return15m');
  const volumeRatio = byKey('volumeRatio');
  const volumeValue = Number(volumeRatio?.value || 0);
  const dayMove = Math.abs(Number(return24h?.value || 0));
  const fourHourShare = dayMove > 0 ? Math.abs(Number(return4h?.value || 0)) / dayMove : 0;
  const selected = volumeValue >= 10
    ? [volumeRatio, return15m, return1h, return4h]
    : dayMove >= 20 && Number(return15m?.value || 0) > Number(return1h?.value || 0)
      ? [return24h, return15m, return1h, return4h]
    : dayMove >= 10
      ? [return24h, return4h, return2h, return15m]
      : [return24h, return4h, return15m, volumeRatio];
  const facts = selected.filter(Boolean).map((claim) => ({ key: claim.key, display: claim.display, timeframe: claim.timeframe || null }));
  const writingBrief = candidate?.topRunnerVisualState === 'pullback'
    ? 'BULLISH WATCHLIST PULLBACK: The token is still a top daily runner, but a visible pullback followed its recent rise. Hook the verified daily move and latest pullback. Explain the rise happened before the reset. Paragraph 3 must use a warm first-person watchlist view such as "I\'m keeping this pullback on my watchlist for a possible entry." It is personal interest, never a buy instruction, target, guarantee, or claim of an existing position. Question: a reset worth watching or a deeper fade?'
    : volumeValue >= 10 && Math.abs(Number(return15m?.value || 0)) <= 0.25
    ? 'VOLUME SHOCK: Hook the volume against the small 15-minute price move. Explain that huge activity caused almost no immediate price reaction. Payoff must be "Huge activity. Almost no price reaction." Question: breakout pressure or a short burst of activity?'
    : dayMove >= 20 && Number(return15m?.value || 0) > Number(return1h?.value || 0)
      ? 'FRESH ACCELERATION: Hook the huge 24-hour move and that the latest 15 minutes beat the entire hour. Payoff: the huge daily move accelerated again. Question: another push or a cooldown first?'
      : fourHourShare >= 0.9 && Number(return15m?.value || 0) < 0
        ? 'FAST RUN THEN PULLBACK: Hook the daily move and that almost all of it came in four hours. Explain the latest 15-minute pullback. Payoff: a fast four-hour run met a short-term pullback. Question: reset or deeper cooldown?'
        : fourHourShare >= 0.75
          ? 'MULTI-HOUR RUNNER: Hook the daily move and that most of it came in four hours. Payoff: most of the daily move happened in four hours. Question: another push or a cooldown first?'
          : 'USE THE MOST UNUSUAL VERIFIED RELATIONSHIP. The payoff and question must be specific to it.';
  const postNumber = Number(candidate?.publicationSequence);
  const verifiedContinuation = candidate?.verifiedContinuation === true && (postNumber === 2 || postNumber === 3);
  const bullishScenarioArrow = candidate?.freshUpsideImpulsePriority === true || Number(candidate?.freshUpsideImpulsePriority) > 0;
  const continuationBrief = !verifiedContinuation
    ? writingBrief
    : `${writingBrief} CONTINUATION POST ${postNumber}: the price is verified above the prior publication reference and the latest window is positive. This is a new update, not a repeat. Lead with the fresh fact; describe that the first move did not fade${postNumber === 3 ? ' and still has not cooled off' : ''}. Make this feel like an unfolding move, where the question of timing matters. Paragraph 3 MUST use a first-person watchlist voice and Paragraph 3 MUST start with "I'm" or "I am": ${postNumber === 2 ? 'the author is considering an entry if this setup keeps holding.' : 'the move is still on the author’s watchlist because it has not given the first jump back.'} Paragraph 4 must contain only the reader question. Never claim a completed personal trade, entry, profit, or that the author was right.`;
  return JSON.stringify({
    token: candidate?.token,
    cashtag: canonicalPublicCashtag(candidate),
    verifiedMarketFacts: facts,
    writingBrief: `${continuationBrief}${bullishScenarioArrow ? ' BULLISH SCENARIO CHART: keep paragraph 3 short, personal, and factual. It may use a watchlist view, but never add a target, buy instruction, guarantee, or claim of a completed trade.' : ''}`,
    publicationSeries: { postNumber: verifiedContinuation ? postNumber : 1, verifiedContinuation },
    bullishScenarioArrow,
    recentFeed: (editorialHistory || []).slice(-5).map((entry) => ({
      storyFamily: entry?.fingerprint?.storyFamily || entry?.marketStoryCluster || 'other',
      hookFamily: entry?.hookFamily || entry?.fingerprint?.hookFamily || 'other',
      opening: compactText(String(entry?.text || '').split(/\n\s*\n/)[0], 100),
    })),
    archival: candidate?.historicalReplay === true || candidate?.readinessOnly === true,
  });
}

function parseOutput(response) {
  const raw = response?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) throw new OllamaWriterError('OLLAMA_INVALID_RESPONSE', 'Ollama returned no usable writer output.');
  const post = raw.trim().replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (/^(?:SKIP|\{"skip":true\})\s*$/i.test(post)) return { decision: 'SKIP', post: '', reason: 'EVENT_NOT_INTERESTING_ENOUGH' };
  return { decision: 'POST', post, reason: '' };
}

function durationMs(nanoseconds) {
  return Number.isFinite(Number(nanoseconds)) ? Math.round(Number(nanoseconds) / 1_000_000) : null;
}

function performanceFrom(response) {
  const evalDurationNs = Number(response?.eval_duration || 0);
  const evalCount = Number(response?.eval_count || 0);
  return {
    totalDurationMs: durationMs(response?.total_duration),
    loadDurationMs: durationMs(response?.load_duration),
    promptEvalDurationMs: durationMs(response?.prompt_eval_duration),
    evalDurationMs: durationMs(evalDurationNs),
    evalCount: Number.isFinite(evalCount) ? evalCount : null,
    tokensPerSecond: evalDurationNs > 0 && evalCount > 0 ? Math.round((evalCount / (evalDurationNs / 1_000_000_000)) * 10) / 10 : null,
  };
}

export class OllamaCryptoWriter {
  constructor({
    model = DEFAULT_MODEL,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    spawnImpl = spawnProcess,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = WRITER_TIMEOUT_MS,
  } = {}) {
    this.model = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL;
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
    this.state = 'unknown';
    this.healthChecked = false;
    this.recoveryAttempted = false;
    this.lastErrorCode = null;
    this.lastPerformance = null;
  }

  status() {
    return {
      provider: 'ollama', model: this.model, endpoint: this.baseUrl,
      configured: true,
      state: this.state,
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
      ...(this.lastPerformance ? { lastPerformance: this.lastPerformance } : {}),
    };
  }

  async initialize() {
    if (this.healthChecked) return this.state === 'ready';
    this.healthChecked = true;
    if (await this.#healthy()) return true;
    if (!this.recoveryAttempted) {
      this.recoveryAttempted = true;
      try {
        const child = this.spawnImpl('ollama', ['serve'], { windowsHide: true, stdio: 'ignore' });
        child?.unref?.();
      } catch {}
      await this.sleep(RECOVERY_WAIT_MS);
      if (await this.#healthy()) return true;
    }
    this.state = 'offline';
    this.lastErrorCode = 'OLLAMA_UNAVAILABLE';
    return false;
  }

  async generate({ candidate, editorialHistory = [] } = {}) {
    if (!(await this.initialize())) throw new OllamaWriterError('OLLAMA_UNAVAILABLE', 'Local Gemma/Ollama is not running.');
    let response;
    try {
      response = await this.#request(writerFacts(candidate, editorialHistory));
    } catch (error) {
      this.state = 'offline';
      this.lastErrorCode = error.code || 'OLLAMA_UNAVAILABLE';
      throw error;
    }
    this.lastPerformance = performanceFrom(response);
    const output = parseOutput(response);
    if (output.decision === 'SKIP') return { status: 'skip', reason: output.reason, rawPostText: output.post, provider: 'ollama', model: this.model, performance: this.lastPerformance };
    const contract = validateGemmaPostContract(output.post, candidate);
    const postText = contract.text;
    const words = contract.wordCount;
    if (!contract.ok) {
      return { status: 'skip', reason: `WRITER_CONTRACT_${contract.errors[0].toUpperCase()}`, contractErrors: contract.errors, rawPostText: postText, provider: 'ollama', model: this.model, performance: this.lastPerformance };
    }
    const claimsUsed = claimsUsedBy(postText, candidate);
    if (words < 30 || words > 110 || claimsUsed.length === 0) {
      return { status: 'skip', reason: words < 30 || words > 110 ? 'WRITER_LENGTH_INVALID' : 'WRITER_NO_VERIFIED_CLAIM', rawPostText: postText, provider: 'ollama', model: this.model, performance: this.lastPerformance };
    }
    const story = planFor(candidate, claimsUsed, postText);
    const marketStoryCluster = classifyMarketStory(candidate);
    const fingerprint = buildEditorialFingerprint({ text: postText, plan: story.plan, chartPreset: story.visualIntent.preset, marketStoryCluster });
    const diversity = evaluateDiversity({ text: postText, fingerprint, recent: editorialHistory });
    if (!diversity.pass) return { status: 'skip', reason: diversity.reason, rawPostText: postText, diversity, provider: 'ollama', model: this.model, performance: this.lastPerformance };
    return {
      status: 'ready', provider: 'ollama', model: this.model, performance: this.lastPerformance,
      content: { decision: 'publish', reason: '', postText, cashtag: canonicalPublicCashtag(candidate), claimsUsed, visualIntent: story.visualIntent },
      plan: story.plan, finalStory: story.finalStory, fingerprint, marketStoryCluster, diversity,
    };
  }

  async generateV4({ candidate, factPack, editorialHistory = [] } = {}) {
    if (!(await this.initialize())) throw new OllamaWriterError('OLLAMA_UNAVAILABLE', 'Local Gemma/Ollama is not running.');
    const pipeline = new V4EditorialPipeline({ invoke: async ({ stage, system, user }) => {
      const stageSystem = stage === 'trader_thought' || stage === 'trader_thought_repair'
        ? 'You are a private trader-reasoning engine. Return exactly nine labelled lines required by the user, each 8 to 22 words. Form a first-person opinion from supplied evidence; do not narrate the asset, write a trade plan, entry, exit, target, or public post. NEXT must state behaviour, not merely a price.'
        : stage === 'writer_reflection' || stage === 'writer_tension'
        ? 'You are a precise English social writer. Return only a 65 to 170 word post in two to five deliberately uneven human paragraphs; one paragraph may be one line. Your job is to make a trader’s opinion unfold, not to summarize a chart. Begin with an expectation, doubt, or concrete level observation — never a cashtag, percentage, “the move”, or generic market slogan. Include the supplied percentage later as evidence with “in 24 hours”. Never write a report or explain the task. A good result has a personal change of view, one level with a reason, a preferred next scenario, and an explicit condition that would change the view. Required quality reference, not reusable wording: "$SAMPLE is +51.20% in 24 hours. I still need $0.0120 to survive the first retest; without that, I have no reason to expect the move to extend.\n\nIf that defence appears, $0.0132 is where I would reassess next. A close below $0.0114 removes that expectation."'
        : stage === 'writer_contract_repair' || stage === 'repair'
          ? 'You are a precise English social editor repairing one post. Return only a 65 to 170 word post in two to five deliberately uneven human paragraphs; one paragraph may be one line. Write a fresh human thought from the verified facts and private reasoning; never explain the task or imitate a rejected draft. Begin with an expectation, doubt, or concrete level observation — never a cashtag, percentage, “the move”, or generic market slogan. Put the supplied percentage later as evidence with “in 24 hours”. Preserve one meaningful level reason, preferred next scenario, expected chart behaviour, and invalidation. Required quality reference, not reusable wording: "$SAMPLE is +51.20% in 24 hours. I need $0.0120 to survive the first retest before I change my reading.\n\nOnly then would $0.0132 matter to me. A close below $0.0114 ends that expectation."'
          : system;
      const response = await this.#requestMessages([
        { role: 'system', content: stageSystem },
        { role: 'user', content: user },
      ], {
        // Planning and repairs benefit from obedience over novelty. The two
        // initial Writer strategies retain enough variation to be genuinely
        // different; their bounded repair must not drift back into filler.
        temperature: stage === 'planner' || stage === 'critic' || stage === 'trader_thought' || stage === 'trader_thought_repair' ? 0.25
          : stage === 'writer_contract_repair' || stage === 'repair' ? 0.35 : 0.55,
        numPredict: stage === 'trader_thought' || stage === 'trader_thought_repair' ? 520 : 360,
      });
      this.lastPerformance = performanceFrom(response);
      return parseOutput(response).post;
    } });
    try {
      const result = await pipeline.generate({ candidate, factPack, editorialHistory });
      return { ...result, provider: 'ollama', model: this.model, performance: this.lastPerformance };
    } catch (error) {
      this.state = 'offline';
      this.lastErrorCode = error.code || 'OLLAMA_UNAVAILABLE';
      throw error;
    }
  }

  async generateV5({ candidate, factPack, editorialHistory = [] } = {}) {
    if (!(await this.initialize())) throw new OllamaWriterError('OLLAMA_UNAVAILABLE', 'Local Gemma/Ollama is not running.');
    const pipeline = new V5EditorialPipeline({ invoke: async ({ stage, system, user }) => {
      const response = await this.#requestMessages([{ role: 'system', content: system }, { role: 'user', content: user }], {
        temperature: stage === 'critic' || stage === 'analyst_brain' ? 0.2 : stage === 'repair' ? 0.3 : 0.55,
        numPredict: stage === 'analyst_brain' ? 500 : 700,
      });
      this.lastPerformance = performanceFrom(response);
      return parseOutput(response).post;
    } });
    const result = await pipeline.generate({ candidate, factPack, editorialHistory });
    return { ...result, provider: 'ollama', model: this.model, performance: this.lastPerformance };
  }

  async #healthy() {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, { method: 'GET' });
      if (!response.ok) return false;
      const payload = await response.json();
      const installed = Array.isArray(payload?.models)
        && payload.models.some((entry) => String(entry?.name || '').replace(/:latest$/, '') === this.model.replace(/:latest$/, ''));
      if (!installed) return false;
      this.state = 'ready';
      this.lastErrorCode = null;
      return true;
    } catch {
      return false;
    }
  }

  async #request(facts) {
    return this.#requestMessages([
      { role: 'system', content: OLLAMA_GEMMA_CRYPTO_SYSTEM_PROMPT },
      { role: 'user', content: `VERIFIED EVENT PACKAGE\n${facts}\n\nWrite the one final post.` },
    ]);
  }

  async #requestMessages(messages, { temperature = 1.0, numPredict = 220 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          think: false,
          options: { num_ctx: 4096, temperature, top_p: 0.95, top_k: 64, num_predict: numPredict },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new OllamaWriterError('OLLAMA_UNAVAILABLE', 'Local Gemma/Ollama request failed.', { retryable: true });
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new OllamaWriterError('OLLAMA_TIMEOUT', 'Local Gemma/Ollama timed out.', { retryable: true });
      if (error instanceof OllamaWriterError) throw error;
      throw new OllamaWriterError('OLLAMA_UNAVAILABLE', 'Local Gemma/Ollama is not running.', { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }
}
