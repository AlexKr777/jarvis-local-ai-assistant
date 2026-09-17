import { canonicalPublicCashtag } from '../market/token-identity.js';
import { buildEditorialFingerprint, classifyMarketStory, evaluateDiversity, selectStoryChartIntent } from './editorial-engine.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'minimax/minimax-m3:free';
const WRITER_TIMEOUT_MS = 20_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;

export const OPENROUTER_CRYPTO_SYSTEM_PROMPT = `You write ONE short Binance Square post about a verified crypto market event. The event has already been selected as interesting.

Your job is to turn the supplied verified facts into a post that makes a crypto reader stop scrolling. You are not a market analyst, trading adviser, or signal finder.

PUBLIC LANGUAGE: English.
TARGET: usually 45-80 words. Do not pad merely to hit a word count.
Include exactly one canonical cashtag supplied by the application, for example $ENA. Never use a different token cashtag.

Use ONLY facts supplied by the application. Never invent percentages, prices, volume values, open-interest values, catalysts, news, whales, institutions, liquidations, insider activity, market makers, or causation.

FIRST UNDERSTAND THE NUMBERS INTERNALLY:
- Compare overlapping time windows before writing. If a shorter recent window has a substantially stronger return than the longer window containing it, this is recent acceleration, a late burst, renewed momentum, or a move picking up speed — not weak momentum, flat action, or lack of follow-through.
- Example: 24h +46.88%, 1h +0.72%, 15m +2.03% means the latest 15 minutes outperformed the entire hour and shows a late acceleration. The earlier 45 minutes were weaker or partly offset the final burst.
- If 24h +10% and 4h +9%, most of the daily move happened recently. If 4h +6%, 1h +1%, and 15m -0.5%, the wider move is strong but the newest edge is pulling back.
- If volume is 13.6x while 15m price is -0.18%, the story is huge activity with little price reaction.
- Do not casually describe positive or negative returns as "flat". Use it only for a genuinely negligible move in context; +0.72% in one hour is not automatically flat.

POST FLOW:
1. HOOK: lead with the strongest verified fact. Put a huge verified number such as +10%, +20%, +40%, or 10x volume immediately in the first line when present.
2. WHY IT IS WEIRD: explain the specific relationship between the facts, not the number alone.
3. EVIDENCE: use only one or two facts needed to prove the story. Do not dump every metric.
4. PAYOFF: finish with one short, memorable observation that is specific to this event, then stop.

VOICE: simple English, short sentences, natural wording, human rhythm, confident but factual, social-feed style. Make the point immediately understandable.

Do not sound like a Bloomberg analyst, research report, AI summary, legal disclaimer, or trading-signal bot. Avoid: market structure, broader structure, participation expanded, participation signal, alignment, contained noise, the real story, changed the character of the move, active pause, not a confirmed reversal, continuation structure, the setup remains, data suggests, footprint, follow-through momentum.

Never use generic financial disclaimers: "Past performance is no guarantee of future results.", "Past performance, no guarantee of tomorrow.", "This is not financial advice.", or "Do your own research." Do not use boilerplate endings such as "It remains to be seen what happens next.", "Only time will tell.", or "Traders should keep an eye on this."

Do not manufacture hype or claim explosion, insane action, whales buying, buyers taking control, smart money, a cause, or a forecast unless the supplied facts prove it. Do not give buy or sell advice, price targets, guarantees, or fake FOMO.

OUTPUT: Return only the final public post as plain text, or exactly {"skip":true} when the supplied facts genuinely cannot support an interesting factual post. No reasoning, explanation, scores, headings, markdown, commentary, or JSON around a normal post.`;

export class OpenRouterWriterError extends Error {
  constructor(code, message, { retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'OpenRouterWriterError';
    this.code = code;
    this.retryable = retryable;
    if (Number.isFinite(retryAfterMs)) this.retryAfterMs = retryAfterMs;
  }
}

function compactText(value, maximum = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function parseNumeric(value) {
  const match = String(value || '').trim().match(/^([+-]?)(\d+(?:\.\d+)?)(%|x)$/i);
  return match ? { sign: match[1], value: Number(match[2]), suffix: match[3].toLowerCase(), decimals: (match[2].split('.')[1] || '').length } : null;
}

function claimMatchesNumber(claim, number) {
  const source = parseNumeric(claim?.display);
  const written = parseNumeric(number);
  if (!source || !written || source.suffix !== written.suffix || source.sign !== written.sign) return false;
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
    finalStory: {
      ...plan,
      heroMetric: hero,
      allowedChartEvidence: [...usedKeys],
      selectedChartIntent: visualIntent,
    },
  };
}

function retryAfterMs(response) {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1_000))
    : 60_000;
}

function writerFacts(candidate, editorialHistory) {
  const facts = (candidate?.claimsAllowed || []).slice(0, 5).map((claim) => ({
    key: claim.key,
    display: claim.display,
    timeframe: claim.timeframe || null,
  }));
  return JSON.stringify({
    token: candidate?.token,
    cashtag: canonicalPublicCashtag(candidate),
    verifiedMarketFacts: facts,
    recentFeed: (editorialHistory || []).slice(-5).map((entry) => ({
      storyFamily: entry?.fingerprint?.storyFamily || entry?.marketStoryCluster || 'other',
      hookFamily: entry?.hookFamily || entry?.fingerprint?.hookFamily || 'other',
      opening: compactText(String(entry?.text || '').split(/\n\s*\n/)[0], 100),
    })),
    archival: candidate?.historicalReplay === true || candidate?.readinessOnly === true,
  });
}

function parseOutput(response) {
  const raw = response?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new OpenRouterWriterError('OPENROUTER_INVALID_RESPONSE', 'OpenRouter returned no usable writer output.');
  }
  const content = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = null; }
  if (parsed && typeof parsed === 'object') {
    if (parsed.skip === true || parsed.decision === 'SKIP') {
      return { decision: 'SKIP', post: '', reason: compactText(parsed.reason, 120) || 'EVENT_NOT_INTERESTING_ENOUGH' };
    }
    if (parsed.decision === 'POST' && typeof parsed.post === 'string' && parsed.post.trim()) {
      return { decision: 'POST', post: parsed.post, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
    }
    throw new OpenRouterWriterError('OPENROUTER_INVALID_RESPONSE', 'OpenRouter returned an invalid writer contract.');
  }
  if (/^SKIP\b/i.test(content)) return { decision: 'SKIP', post: '', reason: 'EVENT_NOT_INTERESTING_ENOUGH' };
  return { decision: 'POST', post: content, reason: '' };
}

export class OpenRouterCryptoWriter {
  constructor({ apiKey, model = DEFAULT_MODEL, fetchImpl = fetch, now = () => Date.now(), timeoutMs = WRITER_TIMEOUT_MS, endpoint = OPENROUTER_URL } = {}) {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    this.model = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.endpoint = endpoint;
    this.cooldownUntil = 0;
    this.lastErrorCode = null;
  }

  status() {
    const remainingMs = Math.max(0, this.cooldownUntil - this.now());
    return {
      provider: 'openrouter', model: this.model,
      configured: Boolean(this.apiKey),
      state: !this.apiKey ? 'missing_key' : remainingMs > 0 ? 'cooldown' : 'ready',
      ...(remainingMs > 0 ? { remainingMs } : {}),
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
    };
  }

  async generate({ candidate, editorialHistory = [] } = {}) {
    if (!this.apiKey) throw new OpenRouterWriterError('OPENROUTER_NOT_CONFIGURED', 'OpenRouter недоступен: OPENROUTER_API_KEY не настроен.');
    if (this.cooldownUntil > this.now()) {
      throw new OpenRouterWriterError('OPENROUTER_COOLDOWN', 'OpenRouter cooldown is active.', { retryable: true, retryAfterMs: this.cooldownUntil - this.now() });
    }
    const output = await this.#request(writerFacts(candidate, editorialHistory));
    if (output.decision === 'SKIP') {
      return { status: 'skip', reason: compactText(output.reason, 120) || 'EVENT_NOT_INTERESTING_ENOUGH', provider: 'openrouter', model: this.model };
    }
    const postText = output.post.trim();
    const words = postText.split(/\s+/).filter(Boolean).length;
    const claimsUsed = claimsUsedBy(postText, candidate);
    if (words < 30 || words > 110 || claimsUsed.length === 0) {
      return { status: 'skip', reason: words < 30 || words > 110 ? 'WRITER_LENGTH_INVALID' : 'WRITER_NO_VERIFIED_CLAIM', provider: 'openrouter', model: this.model };
    }
    const story = planFor(candidate, claimsUsed, postText);
    const marketStoryCluster = classifyMarketStory(candidate);
    const fingerprint = buildEditorialFingerprint({ text: postText, plan: story.plan, chartPreset: story.visualIntent.preset, marketStoryCluster });
    const diversity = evaluateDiversity({ text: postText, fingerprint, recent: editorialHistory });
    if (!diversity.pass) return { status: 'skip', reason: diversity.reason, diversity, provider: 'openrouter', model: this.model };
    return {
      status: 'ready', provider: 'openrouter', model: this.model,
      content: { decision: 'publish', reason: '', postText, cashtag: canonicalPublicCashtag(candidate), claimsUsed, visualIntent: story.visualIntent },
      plan: story.plan, finalStory: story.finalStory, fingerprint, marketStoryCluster, diversity,
    };
  }

  async #request(facts) {
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: OPENROUTER_CRYPTO_SYSTEM_PROMPT },
        { role: 'user', content: `VERIFIED EVENT PACKAGE\n${facts}\n\nWrite the one final post or exactly SKIP.` },
      ],
      temperature: 0.9,
      top_p: 0.95,
      max_tokens: 220,
      stream: false,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (response.status === 429) {
          const delay = retryAfterMs(response);
          this.cooldownUntil = this.now() + delay;
          this.lastErrorCode = 'OPENROUTER_RATE_LIMITED';
          throw new OpenRouterWriterError('OPENROUTER_RATE_LIMITED', 'OpenRouter rate limit reached.', { retryable: true, retryAfterMs: delay });
        }
        if (response.status >= 500 && attempt === 0) continue;
        if (!response.ok) {
          this.lastErrorCode = response.status >= 500 ? 'OPENROUTER_PROVIDER_UNAVAILABLE' : 'OPENROUTER_REQUEST_FAILED';
          throw new OpenRouterWriterError(this.lastErrorCode, 'OpenRouter writer request failed.', { retryable: response.status >= 500 });
        }
        this.lastErrorCode = null;
        return parseOutput(await response.json());
      } catch (error) {
        if (controller.signal.aborted) {
          this.lastErrorCode = 'OPENROUTER_TIMEOUT';
          throw new OpenRouterWriterError('OPENROUTER_TIMEOUT', 'OpenRouter writer timed out.');
        }
        if (error instanceof OpenRouterWriterError) throw error;
        if (attempt === 0) continue;
        this.lastErrorCode = 'OPENROUTER_UNREACHABLE';
        throw new OpenRouterWriterError('OPENROUTER_UNREACHABLE', 'OpenRouter writer could not be reached.', { retryable: true });
      } finally {
        clearTimeout(timer);
      }
    }
    this.lastErrorCode = 'OPENROUTER_PROVIDER_UNAVAILABLE';
    throw new OpenRouterWriterError('OPENROUTER_PROVIDER_UNAVAILABLE', 'OpenRouter writer is temporarily unavailable.', { retryable: true });
  }
}
