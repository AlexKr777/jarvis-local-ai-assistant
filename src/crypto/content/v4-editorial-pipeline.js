import { canonicalPublicCashtag } from '../market/token-identity.js';
import { buildEditorialFingerprint, classifyMarketStory, evaluateDiversity, selectStoryChartIntent } from './editorial-engine.js';
import { buildStoryBrief } from './story-brief.js';
import { assessPublicTextRhythm } from './public-text-format.js';
import { formatPublicPrice } from '../market/price-precision.js';

const BANNED = /\b(?:guaranteed|guarantee|buy now|sell now|easy profit|100x|financial advice|do your own research|market structure|the data suggests|keep an eye on|price action|the asset|(?:strong|upward|current) momentum|momentum feels|upward trend|the move (?:stays|remains) interesting|the setup (?:stays|remains) interesting|current (?:view|read)|refus(?:e|ing) to chase|staying patient|choosing not to chase|daily runner|local reaction support|technical structure|invalidates this read|i noticed|caught my attention|current data shows|openinterestchange|takerbuysellratio|volumeratio|fundingrate|my view only changes|i(?:'m| am) starting to reconsider|i(?:'m| am) watching .* closely|the ideal scenario involves|the bullish idea is over|the case for (?:a )?continuation is over|i prefer seeing|(?:massive )?(?:surge|spike|jump) .* (?:noise|headline)|momentum has actual staying power|next target|my conviction|i(?:'m| am) (?:only )?feel(?:ing)? confident|if the trend (?:holds|persists)|staying power|feels hollow|surface (?:fact|metric)|confirmed (?:base|floor)|solid floor|just a (?:number|headline|statistic|vanity metric)|temporary spike|fleeting (?:moment|spike)|(?:solid|stable) base|coiled spring|higher territory|sideways (?:grind|movement)|the real story|the floor)\b/i;
const REFLECTION_EDITORIAL_REFERENCE = `I was actually expecting the token to push a little higher before I started taking the bearish idea seriously.

Now I’m not so sure.

The rejection around one level is the first thing that changed my mind, but I still would not call that enough alone. Two higher prices matter more to me. After a move like this, buyers should be able to attack those levels with conviction. If price gets there, stalls, and gets pushed straight back down, that tells me more than another green candle.

That is the condition I would rather wait for.

Could buyers still squeeze through both levels? Of course.

If they take the higher one, I am done with the bearish idea. Until then, I am more interested in the failed push than chasing what already happened.`;
const PRICE = /\$\d+(?:\.\d+)?\b/g;
const NUMBER = /[+-]?\d+(?:\.\d+)?(?:%|x)\b/g;

function compact(value, limit = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function words(value) {
  return compact(value, 50_000).split(/\s+/).filter(Boolean);
}

function quotePrice(value, tickSize = null) {
  const rendered = formatPublicPrice(value, tickSize);
  return rendered === '--' ? null : rendered;
}

function publicLevels(factPack) {
  const normalize = (level) => ({
    id: level.id,
    kind: level.side || level.kind,
    price: quotePrice(level.midpoint, level.tickSize),
    evidence: Array.isArray(level.evidence) ? level.evidence.length : 0,
  });
  return {
    supports: (factPack?.levels?.supports || []).filter((item) => item?.evidence?.length).slice(0, 2).map(normalize),
    resistances: (factPack?.levels?.resistances || []).filter((item) => item?.evidence?.length).slice(0, 2).map(normalize),
  };
}

function deterministicSpine(factPack) {
  const storyBrief = buildStoryBrief(factPack);
  const levels = publicLevels(factPack);
  const support = storyBrief.firstReactionZone || levels.supports[0] || null;
  const invalidation = storyBrief.structuralInvalidation || levels.supports[1] || support;
  const resistance = storyBrief.nextWatch || levels.resistances[0] || null;
  const current = quotePrice(factPack?.market?.currentPrice);
  const drawdown = Number(factPack?.market?.drawdownFromHighPct);
  const rangePosition = Number(factPack?.market?.range24h?.position);
  const storyKind = Number.isFinite(drawdown) && drawdown <= -30
    ? 'stale_runner'
    : Number.isFinite(rangePosition) && rangePosition >= 0.8
      ? 'pressure_near_high'
      : 'retest_continuation';
  return {
    // A deeply faded runner is an explicit safety classification. A Story
    // Brief may describe its remaining structure, but it may never relabel
    // that state into a continuation story.
    storyKind: storyKind === 'stale_runner' ? storyKind : (storyBrief.storyFamily || storyKind),
    thesis: storyBrief.technicalThesis,
    readerAssumption: storyKind === 'pressure_near_high'
      ? 'A price near its daily high can continue without proving any support.'
      : 'A large daily percentage alone is enough to explain the setup.',
    tension: storyKind === 'stale_runner'
      ? `${factPack?.ranking?.change24h || 'The daily move'} is materially below the 24h high${current ? ` near ${current}` : ''}.`
      : `${factPack?.ranking?.change24h || 'The daily move'} meets a concrete price location${current ? ` near ${current}` : ''}.`,
    preferredScenario: storyBrief.preferredScenario || (resistance ? `A defence of ${quotePrice(support?.midpoint, support?.tickSize) || 'support'} would keep ${quotePrice(resistance.midpoint, resistance.tickSize)} as the next watch zone.` : 'The next reaction must confirm the move rather than merely extend the percentage.'),
    invalidation: storyBrief.alternativeScenario || (invalidation ? `A move below ${quotePrice(invalidation.midpoint, invalidation.tickSize)} removes the continuation case.` : 'A loss of the supplied local support removes the continuation case.'),
    expectedNextMove: storyBrief.expectedNextMove,
    storyBrief,
    selectedLevelIds: storyBrief.selectedEvidenceIds.filter((id) => id.startsWith('level:')),
  };
}

function hasHumanView(value) {
  return /\b(?:i'm|i am|i\s+(?:want|need|think|see|care|would|keep|find|prefer|doubt|trust|am not)|my\s+(?:view|read|interest|attention|confidence|conviction))\b/i.test(value);
}

function parsePlanner(raw, factPack) {
  const fallback = deterministicSpine(factPack);
  // Gemma is the planner of the human angle, never an authority for a
  // number, price, support or invalidation. Keep its note for audit, but
  // derive every public boundary from the immutable Fact Pack.
  return Object.freeze({
    ...fallback,
    gemmaAngleNote: compact(raw, 1_000),
  });
}

const THOUGHT_FIELDS = Object.freeze(['INITIAL', 'CHANGE', 'LEVEL_REASON', 'BUYER_SELLER', 'PREFERRED', 'INVALIDATION', 'NEXT', 'MISSED', 'CAUTION']);

function traderThoughtPrompt({ factPack, spine }) {
  const levels = publicLevels(factPack);
  const reasoning = spine?.storyBrief?.technicalReasoning || {};
  return `You are a trader thinking privately before writing, not a copywriter and not a signal seller. Use only the public representations below from the verified Fact Pack. The point is to form a human trading opinion, not narrate the chart.\n\nCashtag ${factPack.identity.cashtag}; 24h change ${factPack.ranking.change24h}; story kind ${spine.storyKind}; support ${levels.supports.map((level) => `$${level.price}`).join(', ')}; resistance ${levels.resistances.map((level) => `$${level.price}`).join(', ')}. Deterministic technical reading: ${reasoning.observedStructure || 'none'}; first reaction: ${reasoning.firstReactionMeaning || 'none'}; invalidation: ${reasoning.invalidationMeaning || 'none'}; next watch: ${reasoning.nextWatchMeaning || 'none'}.\n\nReasoning moves to make, without copying their wording: start from a present-tense first read, doubt, or concrete observation; say what exact price fact made that read more or less convincing; make one level matter through the response you need to see there; choose one currently preferred outcome; name the next test; name what ends that view. A prior personal expectation is allowed only when the supplied editorial history proves it.\n\nReturn exactly these nine labelled lines, each 8 to 22 words and each specific: INITIAL:, CHANGE:, LEVEL_REASON:, BUYER_SELLER:, PREFERRED:, INVALIDATION:, NEXT:, MISSED:, CAUTION:. INITIAL must start with a present-tense honest view such as "My first read" or "At first glance" unless verified prior analysis is supplied; CHANGE must name the exact fact that refined that view; LEVEL_REASON must state the supplied price exactly as digits, then say why that response changes the read; PREFERRED must start with what I prefer to see, not a trade action; INVALIDATION must state the supplied price exactly as digits and say what makes me abandon the view; NEXT must describe a concrete expected chart behaviour; MISSED must identify one easily missed detail; CAUTION must state what keeps me unconvinced. Describe buyer/seller behaviour through the price response required at the level. Do not turn prices into words. Do not introduce any number beyond the supplied 24h change and prices. Do not use generic chart narration, an asset, high demand, heavy selling pressure, momentum, trend, consolidation, correction, volatility, entry, exit, long, short, buy, sell, accumulate, or target. This is private reasoning, not public prose.`;
}

function hasUnsupportedPrivatePrecision(text, factPack) {
  const allowed = allowedPrices(factPack);
  return [...String(text || '').matchAll(/-?\d+\.\d{3,}/g)]
    .some((match) => !allowed.has(match[0].replace(/^-/, '')));
}

function parseTraderThought(raw, { factPack, spine }) {
  const source = String(raw || '').trim();
  const fields = Object.fromEntries(THOUGHT_FIELDS.map((field) => {
    const match = source.match(new RegExp(`(?:^|\\n)${field}:\\s*([^\\n]+)`, 'i'));
    return [field.toLowerCase(), compact(match?.[1], 320)];
  }));
  const allPresent = THOUGHT_FIELDS.every((field) => fields[field.toLowerCase()]?.split(/\s+/).length >= 4);
  const prices = [...allowedPrices(factPack)];
  const hasSupport = prices.some((price) => fields.level_reason?.includes(price) || fields.preferred?.includes(price) || fields.invalidation?.includes(price));
  const changeHasExactFact = prices.some((price) => fields.change?.includes(price)) || fields.change?.includes(String(factPack.ranking.change24h || ''));
  const levelExplainsWhy = /\b(?:because|so that|which means|separates|shows|tells me|proves|matters)\b/i.test(fields.level_reason);
  const hasFuture = /\b(?:if|when|unless|then|would|expect|next|retest|reject|reclaim|defend)\b/i.test(`${fields.buyer_seller} ${fields.preferred} ${fields.next}`);
  const generic = /\b(?:massive move|momentum|staying power|raw percentage|firm hold|headline|vanity metric|hollow|the asset|substantial price increase|high demand|upper resistance boundary|heavy selling pressure|historically more consistent|upward trend|entering a correction|rapid price appreciation|volatility|active buyers|current price is positioned|sideways movement|floor remains firm|higher territory)\b/i.test(source);
  const tradePlan = /\b(?:entry|exit|target|accumulate|\blong\b|\bshort\b)\b/i.test(source);
  const personalProgress = /\bI\s+(?:expected|thought|doubted|wanted|needed|prefer|care|would|do not|don't|am not)\b/i.test(`${fields.initial} ${fields.change} ${fields.preferred} ${fields.caution}`);
  const unsupportedPrecision = hasUnsupportedPrivatePrecision(source, factPack);
  const thought = Object.freeze({ ...fields, raw: compact(source, 3_000), valid: allPresent && hasSupport && changeHasExactFact && levelExplainsWhy && hasFuture && personalProgress && !generic && !tradePlan && !unsupportedPrecision, reason: tradePlan ? 'trade_plan' : !allPresent ? 'missing_field' : !changeHasExactFact ? 'no_exact_change_fact' : !hasSupport || !levelExplainsWhy ? 'no_level_reasoning' : !hasFuture ? 'no_future_view' : !personalProgress ? 'no_personal_progression' : generic ? 'generic_thought' : unsupportedPrecision ? 'unsupported_private_precision' : null, storyKind: spine.storyKind });
  return thought;
}

function factPackThoughtFallback(factPack, spine) {
  const levels = publicLevels(factPack);
  const support = spine?.storyBrief?.firstReactionZone || levels.supports[0];
  const invalidation = spine?.storyBrief?.structuralInvalidation || levels.supports[1] || support;
  const resistance = spine?.storyBrief?.nextWatch || levels.resistances[0];
  const supportPrice = quotePrice(support?.midpoint, support?.tickSize) || support?.price;
  const invalidationPrice = quotePrice(invalidation?.midpoint, invalidation?.tickSize) || invalidation?.price;
  const resistancePrice = quotePrice(resistance?.midpoint, resistance?.tickSize) || resistance?.price;
  if (!support || !invalidation || !resistance) return null;
  const fields = {
    initial: `My first read is that the daily change puts ${resistancePrice} in focus.`,
    change: `The next useful fact is whether ${supportPrice} survives the first pullback.`,
    level_reason: `${supportPrice} matters because a retest there separates a defended move from one that only ran.`,
    buyer_seller: `If sellers press lower, I need ${supportPrice} to absorb that pressure before the high matters again.`,
    preferred: `I prefer to see ${supportPrice} hold on a retest before revisiting ${resistancePrice}.`,
    invalidation: `A move below ${invalidationPrice} makes me drop the continuation view.`,
    next: `I expect either a retest at ${supportPrice} or a failed push into ${resistancePrice} next.`,
    missed: `The daily percentage is visible; the response at ${supportPrice} is the detail that changes the read.`,
    caution: `I stay cautious until the next reaction proves the move can keep its ground.`,
  };
  const raw = THOUGHT_FIELDS.map((field) => `${field}: ${fields[field.toLowerCase()]}`).join('\n');
  return Object.freeze({ ...fields, raw, valid: true, reason: null, storyKind: spine.storyKind, generatedBy: 'fact_pack_fallback' });
}

function allowedPrices(factPack) {
  const levels = publicLevels(factPack);
  return new Set([...levels.supports, ...levels.resistances].map((level) => level.price).filter(Boolean));
}

function allowedNumbers(factPack) {
  const hero = (factPack?.numbersAllowed || []).find((claim) => claim.key === 'return24h') || null;
  return new Set(hero ? [String(hero.display)] : []);
}

function claimIsWritten(text, claim) {
  const display = String(claim?.display || '');
  if (!display) return false;
  // Gemma may omit a cosmetic leading plus sign, but it may not change the
  // magnitude, unit or direction. Keep the canonical Fact Pack display in
  // claimsUsed so the shared validator can demand its matching timeframe.
  return text.includes(display) || (display.startsWith('+') && text.includes(display.slice(1)));
}

function sentenceContaining(text, price) {
  const escaped = String(price || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A final sentence stop is punctuation, not a continuation of the decimal.
  // Keep rejecting a real extra fractional digit such as 0.02901.
  const exactPrice = new RegExp(`(?<![0-9.])\\$?${escaped}(?!\\d|\\.\\d)`);
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).find((sentence) => exactPrice.test(sentence)) || '';
}

function priceNeighborhood(sentence, price, radius = 34) {
  const escaped = String(price || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?<![0-9.])\\$?${escaped}(?!\\d|\\.\\d)`, 'i').exec(String(sentence || ''));
  if (!match) return '';
  const start = Math.max(0, match.index - radius);
  const end = Math.min(String(sentence).length, match.index + match[0].length + radius);
  return String(sentence).slice(start, end);
}

export function technicalStoryErrors(text, factPack) {
  const brief = buildStoryBrief(factPack);
  if (!brief.valid) return [];
  const reaction = quotePrice(brief.firstReactionZone?.midpoint, brief.firstReactionZone?.tickSize);
  const invalidation = quotePrice(brief.structuralInvalidation?.midpoint, brief.structuralInvalidation?.tickSize);
  const watch = quotePrice(brief.nextWatch?.midpoint, brief.nextWatch?.tickSize);
  const errors = [];
  const reactionSentence = sentenceContaining(text, reaction);
  const invalidationSentence = sentenceContaining(text, invalidation);
  const watchSentence = sentenceContaining(text, watch);
  if (!reactionSentence || !invalidationSentence) errors.push('technical_context_underused');
  // A sentence can legitimately mention both zones: e.g. “below 0.0289,
  // reclaiming 0.0290 would not rescue the read”. Bind the action to the
  // nearby price instead of treating any "below" in the sentence as an
  // invalidation of every level mentioned in it.
  const reactionContext = priceNeighborhood(reactionSentence, reaction);
  const invalidationContext = priceNeighborhood(invalidationSentence, invalidation);
  const watchContext = priceNeighborhood(watchSentence, watch);
  if (reactionContext && /\b(?:below|break\w*|lose\w*|loss|invalidat\w*|ends?|abandon\w*)\b/i.test(reactionContext)) errors.push('level_role_mismatch');
  if (invalidationContext && !/\b(?:below|break\w*|lose\w*|loss|if|unless|end\w*|abandon\w*|fail\w*|line in (?:the )?sand)\b/i.test(invalidationContext)) errors.push('level_role_mismatch');
  if (watchContext && /\b(?:will|going to|must reach|target)\b/i.test(watchContext)) errors.push('level_role_mismatch');
  return errors;
}

export function validateV4Draft(text, { factPack, candidate }) {
  const formatting = assessPublicTextRhythm(text);
  const value = formatting.normalizedText;
  const errors = [];
  const cashtag = canonicalPublicCashtag(candidate || factPack?.identity || {});
  const cashtags = value.match(/\$[A-Z][A-Z0-9]{1,11}\b/g) || [];
  const count = words(value).length;
  if (!value) errors.push('empty');
  if (count < 50 || count > 220) errors.push('length');
  if (!cashtag || cashtags.length !== 1 || cashtags[0] !== cashtag) errors.push('cashtag');
  if (BANNED.test(value)) errors.push('banned_language');
  if (!hasHumanView(value)) errors.push('missing_human_view');
  for (const issue of formatting.issues) errors.push(issue.toLowerCase());
  errors.push(...technicalStoryErrors(value, factPack));
  for (const price of value.match(PRICE) || []) {
    if (!allowedPrices(factPack).has(price.slice(1))) errors.push('unsupported_price');
  }
  for (const number of value.match(/\b0\.\d{3,}\b/g) || []) {
    if (!allowedPrices(factPack).has(number)) errors.push('unsupported_price');
  }
  for (const number of value.match(NUMBER) || []) {
    if (!allowedNumbers(factPack).has(number)) errors.push('unsupported_number');
  }
  return Object.freeze({ ok: errors.length === 0, errors: [...new Set(errors)], wordCount: count, text: value, formatting });
}

function writerPrompt({ factPack, spine, strategy, recent }) {
  const levels = publicLevels(factPack);
  const hero = (factPack.numbersAllowed || []).find((claim) => claim.key === 'return24h') || null;
  const claim = hero ? `${hero.display} (${hero.timeframe || '24h'})` : 'none';
  return `Write only a 65 to 90 word English crypto post in two unequal paragraphs. Under 65 words is rejected. It must sound like one person's changing opinion, not a report.

Facts: ${factPack.identity.cashtag}; 24h move ${claim}; support ${levels.supports.map((item) => item.price).join(', ') || 'none'}; watch resistance ${levels.resistances.map((item) => item.price).join(', ') || 'none'}.

Use the cashtag once. Write the supplied daily number as "${claim} in 24 hours"; a bare percentage is invalid. Use only that number and supplied prices. In paragraph one, make a concrete first-person judgment about why the percentage alone is not enough, then name the price that would make the judgment more credible. In paragraph two, explain the conditional next step, one higher level to watch, and the price that makes you abandon this continuation idea. No trade instruction, catalyst, question, or extra metric.

Style reference only — use comparable length and specificity, but do not copy its words, ticker, or prices: "The percentage has already made its point. I care about how the first pullback behaves because that is where a fast move becomes either a real floor or a number people are chasing after the fact.\n\nIf buyers defend it, the next ceiling becomes worth my attention. If they lose it, I stop treating the upside as the live scenario."

Never use: I noticed; caught my attention; price action; daily runner; local reaction support; technical structure; refusing to chase; staying patient; current view; "my view only changes"; "I am starting to reconsider"; "I am watching closely"; "ideal scenario"; "bullish idea is over"; surge, spike, jump, noise, headline, momentum, confidence, conviction, target, or "staying power". Do not call the move a trend. Generic metric lists are forbidden. ${strategy}`;
}

function plannerPrompt(factPack) {
  const levels = publicLevels(factPack);
  return `You are the active Gemma planner. Build a concise internal trading thought from this immutable Fact Pack. Do not write public copy and do not invent facts.\nToken ${factPack.identity.cashtag}; rank ${factPack.ranking.top10Rank}; 24h ${factPack.ranking.change24h}; current price ${quotePrice(factPack.market.currentPrice)}. Supports: ${levels.supports.map((item) => `${item.id} $${item.price}`).join(', ') || 'none'}. Resistances: ${levels.resistances.map((item) => `${item.id} $${item.price}`).join(', ') || 'none'}.\nReturn exactly three lines: THESIS:, WATCH:, INVALIDATION:.`;
}

function thoughtWriterPrompt({ factPack, thought, spine, strategy }) {
  const levels = publicLevels(factPack);
  const hero = (factPack.numbersAllowed || []).find((claim) => claim.key === 'return24h') || null;
  const claim = hero ? `${hero.display} (${hero.timeframe || '24h'})` : 'none';
  const brief = spine?.storyBrief || buildStoryBrief(factPack);
  const technicalRoles = `FIRST REACTION ${quotePrice(brief.firstReactionZone?.midpoint, brief.firstReactionZone?.tickSize)}; STRUCTURAL INVALIDATION ${quotePrice(brief.structuralInvalidation?.midpoint, brief.structuralInvalidation?.tickSize)}; NEXT WATCH ${quotePrice(brief.nextWatch?.midpoint, brief.nextWatch?.tickSize)}. These roles are distinct.`;
  return `Write one 65 to 170 word English crypto post from the private Trader Thought below. It is a small human story, not a technical summary. Use 2 to 5 deliberately uneven paragraphs; one paragraph may be a single line.\n\nVerified facts: ${factPack.identity.cashtag}; 24h ${claim}; support ${levels.supports.map((level) => `$${level.price}`).join(', ') || 'none'}; resistance ${levels.resistances.map((level) => `$${level.price}`).join(', ') || 'none'}.\n\nPRIVATE TRADER THOUGHT (do not expose labels):\nINITIAL: ${thought.initial}\nCHANGE: ${thought.change}\nLEVEL_REASON: ${thought.level_reason}\nBUYER_SELLER: ${thought.buyer_seller}\nPREFERRED: ${thought.preferred}\nINVALIDATION: ${thought.invalidation}\nNEXT: ${thought.next}\nMISSED: ${thought.missed}\nCAUTION: ${thought.caution}\n\nThe opening is a personal expectation, doubt, or concrete observation — never a percentage, a cashtag, or “the move”. Put ${claim} in 24 hours after the thought has begun, as proof rather than the headline. Centre the post on one level and explain what the chart must do there before your opinion changes. State the preferred scenario, expected next behaviour, and invalidation in the author’s own terms. Do not turn BUYER_SELLER into an abstract battle of demand versus supply: describe the actual response needed at the price. Use the cashtag exactly once and only verified numbers/prices. No trade instruction, catalyst, generic metric list, obligatory question, or invented personal history, trade, experience, or commitment.\n\nThis is the main qualitative editorial reference. Use its thought progression, human rhythm, level reasoning, preferred scenario, future expectation, invalidation clarity, trader voice, reader curiosity, and non-template structure. Never reuse its phrases, numbers, paragraph sequence, or exact argumentative order:\n---\n${REFLECTION_EDITORIAL_REFERENCE}\n---\n\nBefore writing, silently distil only INITIAL, CHANGE, LEVEL_REASON, PREFERRED, INVALIDATION, NEXT, and CAUTION into one small story. Do not mechanically repeat nine Thought labels or turn BUYER_SELLER into an abstract demand-versus-supply paragraph. Never claim volume, sentiment, personal history, a trade, or a position unless supplied. Do not use stock substitutes: massive, surge, spike, momentum, floor, base, trend, target, conviction, noise, volume, ceiling, higher territory, “real story”, coiled spring, or sideways consolidation.\n\n${strategy}`;
}

function thoughtWriterPromptV2({ factPack, thought, spine, strategy }) {
  const levels = publicLevels(factPack);
  const hero = (factPack.numbersAllowed || []).find((claim) => claim.key === 'return24h') || null;
  const claim = hero ? `${hero.display} (${hero.timeframe || '24h'})` : 'none';
  const brief = spine?.storyBrief || buildStoryBrief(factPack);
  const technicalRoles = `First reaction ${quotePrice(brief.firstReactionZone?.midpoint, brief.firstReactionZone?.tickSize)}; structural invalidation ${quotePrice(brief.structuralInvalidation?.midpoint, brief.structuralInvalidation?.tickSize)}; next watch ${quotePrice(brief.nextWatch?.midpoint, brief.nextWatch?.tickSize)}.`;
  return [
    'Write one 65 to 170 word English crypto post from a private Trader Thought and deterministic Story Brief. It is a small human story, not a technical summary.',
    'Use normal blank lines between meaningful visual blocks. Human rhythm is a quality rule: vary paragraph lengths when the thought benefits from it, but never force a fixed paragraph count, a one-line paragraph, or a repeating pattern.',
    `Verified facts: ${factPack.identity.cashtag}; 24h ${claim}; support ${levels.supports.map((level) => `$${level.price}`).join(', ') || 'none'}; resistance ${levels.resistances.map((level) => `$${level.price}`).join(', ') || 'none'}.`,
    `DETERMINISTIC TECHNICAL ROLES (not public labels): ${technicalRoles} These roles are distinct: explain the first reaction, use structural invalidation only as the scenario-ending condition, and treat the next watch as conditional rather than a prediction.`,
    'PRIVATE TRADER THOUGHT (do not expose labels):',
    `INITIAL: ${thought.initial}`, `CHANGE: ${thought.change}`, `LEVEL_REASON: ${thought.level_reason}`, `BUYER_SELLER: ${thought.buyer_seller}`, `PREFERRED: ${thought.preferred}`, `INVALIDATION: ${thought.invalidation}`, `NEXT: ${thought.next}`, `MISSED: ${thought.missed}`, `CAUTION: ${thought.caution}`,
    `The opening is a personal expectation, doubt, or concrete observation — never a percentage, cashtag, or “the move”. Put ${claim} in 24 hours after the thought begins, as proof rather than headline. Centre the post on one level and explain what must happen there before the opinion changes. State preferred scenario, expected next behaviour, and structural invalidation in the author’s own terms. Do not make BUYER_SELLER an abstract battle of demand versus supply: describe the response actually needed at the price. Use the cashtag exactly once and only verified numbers/prices. No trade instruction, catalyst, generic metric list, obligatory question, or invented personal history, trade, experience, or commitment.`,
    'Use the following editorial reference only for thought progression, human rhythm, level reasoning, preferred scenario, future expectation, invalidation clarity, trader voice, reader curiosity, and non-template structure. Never reuse its phrases, numbers, paragraph sequence, or exact argumentative order:',
    '---', REFLECTION_EDITORIAL_REFERENCE, '---',
    'Do not mechanically repeat labels or turn buyer/seller behaviour into abstract demand-versus-supply prose. Never claim volume, sentiment, personal history, a trade, or a position unless supplied. Do not use stock substitutes: massive, surge, spike, momentum, floor, base, trend, target, conviction, noise, volume, ceiling, higher territory, real story, coiled spring, or sideways consolidation.',
    strategy,
  ].join('\n\n');
}

function writerPromptFor({ factPack, thought, spine, strategy }) {
  const storyBrief = [
    `Earlier view: ${thought.initial}`,
    `What changed it: ${thought.change}`,
    `The level and why: ${thought.level_reason}`,
    `What I now prefer: ${thought.preferred}`,
    `What ends that view: ${thought.invalidation}`,
    `What should happen next: ${thought.next}`,
    `What keeps me cautious: ${thought.caution}`,
  ].join('\n');
  return thoughtWriterPromptV2({ factPack, thought, spine, strategy }).replace(
    /PRIVATE TRADER THOUGHT \(do not expose labels\):[\s\S]*?\n\nThe opening/,
    `PRIVATE STORY BRIEF (not public prose):\n${storyBrief}\n\nThe opening`,
  );
}

function criticPrompt({ factPack, spine, text }) {
  return `You are an adversarial crypto social editor. Check this draft only against the Fact Pack and spine. Return PASS, or REWRITE: followed by one precise repair instruction. PASS requires an honest first-person opening that is specific to this token's actual price/24h fact, one non-generic thought, a real conditional scenario, and a clear invalidation. Reject generic analysis, invented levels, causal claims, trade instructions, repeated template language, report prose, missing invalidation, or a weak human payoff. Generic phrases such as refusing to chase, staying patient, daily runner, local reaction support, technical structure, and invalidates this read must be rewritten.\nFact Pack cashtag ${factPack.identity.cashtag}; allowed levels ${[...allowedPrices(factPack)].map((p) => `$${p}`).join(', ') || 'none'}; spine ${spine.thesis} / ${spine.preferredScenario} / ${spine.invalidation}.\nDRAFT:\n${text}`;
}

function contractRepairPrompt({ factPack, spine, drafts }) {
  return `${writerPrompt({
    factPack,
    spine,
    strategy: 'This is the single bounded contract repair. Rewrite into one original human thought, not a checklist. The author may change their view conditionally, but may not describe a personal trade.',
    recent: [],
  })}\n\nBoth initial drafts failed their deterministic contracts. Return only one fully rewritten final post, not commentary and not an explanation. Do not quote, imitate, summarize, or respond to either rejected draft: they are deliberately withheld so their weak wording cannot anchor you. Build an original thought around this fact pattern, with the actual approved values but not the wording: the daily percentage is already visible; the author needs [SUPPORT] to be defended on a retest before taking continuation seriously; [RESISTANCE] is the next reference only after that; below [SUPPORT] the author drops the continuation thesis.`;
}

function thoughtCriticPromptV2({ factPack, thought, spine, text }) {
  const brief = spine?.storyBrief || buildStoryBrief(factPack);
  return [
    'You are an adversarial editor judging a crypto social post against a private Trader Thought, deterministic Story Brief, and verified Fact Pack.',
    'Do not reward a correct metric summary. PASS requires thought progression, human rhythm, an explained level, one preferred scenario, future chart expectation, clear structural invalidation, trader voice, reader curiosity, and non-template structure. A factually correct token-moved/support-is/continuation-is-possible post must fail.',
    'Never approve generic crypto imagery, abstract buyer-versus-seller narration, invented personal history, or an opening that could fit another token.',
    'Return exactly PASS, or ISSUE: one of weak_thesis|generic_opening|no_reason_for_level|no_preferred_scenario|no_future_view|analyst_voice|symmetric_structure|mechanical_micro_paragraphs|weak_invalidation|template_language|technical_context_underused|level_role_mismatch followed by a newline INSTRUCTION: one precise repair action.',
    `Fact Pack: ${factPack.identity.cashtag}; 24h ${factPack.ranking.change24h}; allowed prices ${[...allowedPrices(factPack)].map((price) => `$${price}`).join(', ')}.`,
    `Technical roles: first reaction ${quotePrice(brief.firstReactionZone?.midpoint, brief.firstReactionZone?.tickSize)}; structural invalidation ${quotePrice(brief.structuralInvalidation?.midpoint, brief.structuralInvalidation?.tickSize)}; next watch ${quotePrice(brief.nextWatch?.midpoint, brief.nextWatch?.tickSize)}. These roles are distinct: the first reaction is not invalidation and the next watch is not a prediction.`,
    `Trader Thought: ${thought.raw}`,
    'Quality reference (judge qualities, never phrase overlap):', '---', REFLECTION_EDITORIAL_REFERENCE, '---',
    `DRAFT:\n${text}`,
  ].join('\n\n');
}

function thoughtCriticPrompt({ factPack, thought, text }) {
  return `You are an adversarial editor judging a crypto social post against a private Trader Thought and verified Fact Pack. Do not reward a correct metric summary. PASS requires thought progression, human rhythm, an explained level, one preferred scenario, future chart expectation, clear invalidation, trader voice, reader curiosity, and non-template structure. A factually correct version of “token moved X%, support is Y, continuation is possible” must fail. Never approve generic crypto imagery, abstract buyer-versus-seller narration, invented personal history, or an opening that could fit another token.\n\nReturn exactly PASS, or ISSUE: one of weak_thesis|generic_opening|no_reason_for_level|no_preferred_scenario|no_future_view|analyst_voice|symmetric_structure|weak_invalidation|template_language followed by a newline INSTRUCTION: one precise repair action.\n\nJudge qualities, not phrase overlap, against this reference:\n---\n${REFLECTION_EDITORIAL_REFERENCE}\n---\n\nFact Pack: ${factPack.identity.cashtag}; 24h ${factPack.ranking.change24h}; allowed prices ${[...allowedPrices(factPack)].map((price) => `$${price}`).join(', ')}.\nTrader Thought: ${thought.raw}\nDRAFT:\n${text}`;
}

function parseCritic(raw) {
  const value = String(raw || '').trim();
  if (/^PASS\b/i.test(value)) return { verdict: 'PASS', issue: null, instruction: null, raw: compact(value, 700) };
  const issue = value.match(/ISSUE:\s*([a-z_]+)/i)?.[1]?.toLowerCase() || 'analyst_voice';
  const instruction = compact(value.match(/INSTRUCTION:\s*([\s\S]+)/i)?.[1] || value, 500);
  return { verdict: 'REWRITE', issue, instruction, raw: compact(value, 700) };
}

function thoughtRepairPrompt({ factPack, thought, spine, issue }) {
  return `${writerPromptFor({
    factPack,
    thought,
    spine,
    strategy: `This is the one bounded repair. Fix only this editorial issue: ${issue}. Write a fresh post from the Trader Thought; do not quote, paraphrase, or imitate any previous public draft.`,
  })}\n\nReturn only the fresh post.`;
}

function separation(a, b) {
  const first = new Set(words(a.toLowerCase()).filter((word) => word.length > 3));
  const second = new Set(words(b.toLowerCase()).filter((word) => word.length > 3));
  const common = [...first].filter((word) => second.has(word)).length;
  return 1 - common / Math.max(1, new Set([...first, ...second]).size);
}

function draftScore(text, spine) {
  const lower = text.toLowerCase();
  let score = Math.min(20, words(text).length / 8);
  if (hasHumanView(text)) score += 5;
  if (/\b(?:changed my view|not chasing|need to see|refuse to chase|only reason)\b/i.test(lower)) score += 4;
  if (/\b(?:if|while|unless)\b/i.test(lower)) score += 3;
  if (spine.invalidation && lower.includes(compact(spine.invalidation, 80).toLowerCase().split(' ').slice(-3).join(' '))) score += 4;
  if (/\b(?:watch|zone|support|hold|invalidate)/i.test(lower)) score += 3;
  return score;
}

function planForSelectedDraft({ selected, spine, factPack }) {
  const claimsUsed = (factPack.numbersAllowed || [])
    .filter((claim) => claim.key === 'return24h' && claimIsWritten(selected.text, claim))
    .map((claim) => ({ key: claim.key, display: claim.display }));
  const isTension = selected.id === 'tension';
  return {
    // These fields are a record of the public story that was actually selected,
    // rather than a fixed V4 default.  Diversity must compare real narrative
    // shapes, otherwise it rejects a genuinely different candidate as a clone.
    storyFamily: spine.storyBrief?.storyFamily || spine.storyKind || 'technical_thesis',
    heroFactType: claimsUsed[0]?.key || 'return24h',
    hookFamily: isTension ? 'level_observation' : 'view_refinement',
    format: 'social_story',
    readerExperienceFamily: isTension ? 'tension' : 'reflection',
    allowedChartEvidence: [...new Set([
      ...(spine.selectedLevelIds || []),
      ...claimsUsed.map((claim) => claim.key),
    ])],
    abConflict: { use: false },
  };
}

function selectDiverseDraft({ viable, spine, factPack, candidate, editorialHistory }) {
  const marketStoryCluster = classifyMarketStory(candidate);
  const ranked = [...viable].sort((left, right) => draftScore(right.text, spine) - draftScore(left.text, spine));
  const options = ranked.map((draft) => {
    const plan = planForSelectedDraft({ selected: draft, spine, factPack });
    const fingerprint = buildEditorialFingerprint({ text: draft.text, plan, chartPreset: 'receipt', marketStoryCluster });
    const diversity = evaluateDiversity({ text: draft.text, fingerprint, recent: editorialHistory });
    return { id: draft.id, score: draftScore(draft.text, spine), plan, fingerprint, diversity, draft };
  });
  // This is selection, not a diversity bypass: keep the best editorial draft
  // among candidates that are independently valid and non-repetitive.
  const selectedOption = options.find((option) => option.diversity.pass) || options[0];
  return { ...selectedOption, options, marketStoryCluster };
}

export class V4EditorialPipeline {
  constructor({ invoke } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('V4EditorialPipeline requires an invoke function.');
    this.invoke = invoke;
  }

  async generate({ factPack, candidate, editorialHistory = [] }) {
    const plannerRaw = await this.invoke({ stage: 'planner', system: 'You plan factual crypto stories.', user: plannerPrompt(factPack) });
    const spine = parsePlanner(plannerRaw, factPack);
    if (spine.storyKind === 'stale_runner') {
      return { status: 'skip', reason: 'STALE_DAILY_RUNNER', audit: { factPack, planner: spine } };
    }
    const thoughtRaw = await this.invoke({ stage: 'trader_thought', system: 'You form concrete private trader reasoning from verified facts only.', user: traderThoughtPrompt({ factPack, spine }) });
    const initialThought = parseTraderThought(thoughtRaw, { factPack, spine });
    let thought = initialThought;
    let traderThoughtRepair = null;
    let traderThoughtFallback = null;
    if (!thought.valid) {
      const repairedRaw = await this.invoke({
        stage: 'trader_thought_repair',
        system: 'You repair private trader reasoning from verified facts only.',
        user: `${traderThoughtPrompt({ factPack, spine })}\n\nThe first private thought failed ${initialThought.reason}. Return a fresh nine-line thought from the facts. Do not quote or imitate the failed thought.`,
      });
      const repairedThought = parseTraderThought(repairedRaw, { factPack, spine });
      traderThoughtRepair = { initialReason: initialThought.reason, raw: compact(repairedRaw, 3_000), valid: repairedThought.valid, reason: repairedThought.reason };
      thought = Object.freeze({ ...repairedThought, repaired: true, initialReason: initialThought.reason });
    }
    if (!thought.valid && ['generic_thought', 'missing_field', 'no_exact_change_fact', 'no_level_reasoning', 'no_personal_progression', 'unsupported_private_precision'].includes(thought.reason)) {
      const fallback = factPackThoughtFallback(factPack, spine);
      if (fallback) {
        traderThoughtFallback = { used: true, reason: thought.reason, source: fallback.generatedBy };
        thought = fallback;
      }
    }
    if (!thought.valid) return { status: 'skip', reason: `TRADER_THOUGHT_${String(thought.reason || 'INVALID').toUpperCase()}`, audit: { factPack, planner: spine, traderThought: thought, traderThoughtRepair, traderThoughtFallback } };
    const recent = editorialHistory.slice(-8).map((entry) => compact(entry?.text || entry?.opening || '', 110));
    const [reflection, tension] = await Promise.all([
      this.invoke({ stage: 'writer_reflection', system: 'You write human crypto social posts from verified facts only.', user: writerPromptFor({ factPack, thought, spine, strategy: 'Candidate A: begin with a change or refinement in the author’s view. Let the reason for that change unfold before the levels. Do not use the same paragraph shape as Candidate B.' }) }),
      this.invoke({ stage: 'writer_tension', system: 'You write human crypto social posts from verified facts only.', user: writerPromptFor({ factPack, thought, spine, strategy: 'Candidate B: begin with a doubt, a level, or an observation a trader might miss. Develop the reasoning in a different order from Candidate A; a question is optional.' }) }),
    ]);
    const writerCandidates = [
      { id: 'reflection', text: String(reflection || '').trim() },
      { id: 'tension', text: String(tension || '').trim() },
    ].map((draft) => ({ ...draft, validation: validateV4Draft(draft.text, { factPack, candidate }) }));
    const viable = writerCandidates.filter((draft) => draft.validation.ok);
    let contractRepair = null;
    if (!viable.length) {
      const repaired = await this.invoke({
        stage: 'writer_contract_repair', system: 'You repair one crypto social draft using verified facts only.',
        user: thoughtRepairPrompt({ factPack, thought, spine, issue: 'writer_contract' }),
      });
      const validation = validateV4Draft(repaired, { factPack, candidate });
      contractRepair = { text: String(repaired || '').trim(), validation };
      if (!validation.ok) return { status: 'skip', reason: 'WRITER_CONTRACT_INVALID', audit: { planner: spine, traderThought: thought, traderThoughtRepair, traderThoughtFallback, writerCandidates, contractRepair } };
      viable.push({ id: 'contract_repair', text: validation.text, validation });
    }
    if (viable.length > 1 && separation(viable[0].text, viable[1].text) < 0.2) {
      return { status: 'skip', reason: 'CANDIDATE_DIVERSITY_FAIL', audit: { planner: spine, traderThought: thought, traderThoughtRepair, traderThoughtFallback, writerCandidates, contractRepair } };
    }
    const selection = selectDiverseDraft({ viable, spine, factPack, candidate, editorialHistory });
    let selected = selection.draft;
    const criticRaw = await this.invoke({ stage: 'critic', system: 'You are an adversarial editor.', user: thoughtCriticPromptV2({ factPack, thought, spine, text: selected.text }) });
    const critic = parseCritic(criticRaw);
    if (critic.verdict !== 'PASS') {
      const repaired = await this.invoke({
        stage: 'repair', system: 'Rewrite one factual crypto social post using verified facts only.',
        user: thoughtRepairPrompt({ factPack, thought, spine, issue: `${critic.issue}: ${critic.instruction}` }),
      });
      const validation = validateV4Draft(repaired, { factPack, candidate });
      if (!validation.ok) return { status: 'skip', reason: 'CRITIC_REPAIR_INVALID', audit: { planner: spine, traderThought: thought, traderThoughtRepair, traderThoughtFallback, writerCandidates, contractRepair, selected, critic, repair: { text: repaired, validation } } };
      selected = { id: `${selected.id}_repair`, text: validation.text, validation };
      const verificationRaw = await this.invoke({ stage: 'critic', system: 'You are an adversarial editor.', user: thoughtCriticPromptV2({ factPack, thought, spine, text: selected.text }) });
      const verification = parseCritic(verificationRaw);
      if (verification.verdict !== 'PASS') return { status: 'skip', reason: 'CRITIC_REPAIR_REJECTED', audit: { planner: spine, traderThought: thought, traderThoughtRepair, traderThoughtFallback, writerCandidates, contractRepair, selected, critic, repair: { text: repaired, validation, verification } } };
      critic.verdict = 'REPAIRED';
      critic.verification = verification;
    }
    const plan = planForSelectedDraft({ selected, spine, factPack });
    const claimsUsed = (factPack.numbersAllowed || []).filter((claim) => plan.allowedChartEvidence.includes(claim.key)).map((claim) => ({ key: claim.key, display: claim.display }));
    const visualIntent = { ...selectStoryChartIntent(plan, candidate), preset: 'receipt', revealOnOpen: false, factIds: spine.selectedLevelIds };
    const marketStoryCluster = selection.marketStoryCluster;
    const fingerprint = buildEditorialFingerprint({ text: selected.text, plan, chartPreset: visualIntent.preset, marketStoryCluster });
    const diversity = evaluateDiversity({ text: selected.text, fingerprint, recent: editorialHistory });
    if (!diversity.pass) return { status: 'skip', reason: diversity.reason, audit: { planner: spine, traderThought: thought, traderThoughtRepair, traderThoughtFallback, writerCandidates, contractRepair, selection, selected, critic, diversity } };
    return {
      status: 'ready',
      content: { decision: 'publish', reason: '', postText: selected.text, cashtag: factPack.identity.cashtag, claimsUsed, visualIntent },
      plan,
      finalStory: {
        ...plan,
        spine,
        selectedLevelIds: spine.selectedLevelIds,
        heroMetric: (factPack.numbersAllowed || []).find((claim) => plan.allowedChartEvidence.includes(claim.key)) || null,
      },
      fingerprint,
      marketStoryCluster,
      diversity,
      audit: { factPack, planner: spine, storyBrief: spine.storyBrief, traderThought: thought, traderThoughtRepair, traderThoughtFallback, writerCandidates, contractRepair, selection, selected: { id: selected.id, text: selected.text, score: draftScore(selected.text, spine), validation: selected.validation }, critic, diversity },
    };
  }
}
