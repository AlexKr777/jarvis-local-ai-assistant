import { scoreThresholdForSlots } from './anomaly-score.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEGACY_POST_SPACING_MS = 40 * 60_000;
const MAX_POSTS_PER_TOKEN_PER_DAY = 3;

function utcDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

export function evaluatePublicationEligibility(candidate, state = {}, now = Date.now(), { maxPosts24h = 10, requireScore = true } = {}) {
  const posts = (state.posts || []).filter((post) => now - post.publishedAt < DAY);
  const savedResetAt = Number(state.postLimitResetAt);
  const resetAt = Number.isFinite(savedResetAt) && savedResetAt <= now ? savedResetAt : null;
  const quotaPosts = resetAt === null ? posts : posts.filter((post) => post.publishedAt >= resetAt);
  if (quotaPosts.length >= maxPosts24h) return { eligible: false, reason: 'rolling_24h_cap' };
  if (quotaPosts.filter((post) => utcDay(post.publishedAt) === utcDay(now)).length >= maxPosts24h) {
    return { eligible: false, reason: 'utc_day_cap' };
  }
  if (candidate.fingerprint && posts.some((post) => post.fingerprint === candidate.fingerprint)) {
    return { eligible: false, reason: 'duplicate_fingerprint' };
  }
  const tokenPosts = posts
    .filter((post) => post.token === candidate.token)
    .sort((left, right) => Number(right.publishedAt) - Number(left.publishedAt));
  const latestTokenPost = tokenPosts[0] || null;
  const postNumber = tokenPosts.length + 1;
  if (postNumber > MAX_POSTS_PER_TOKEN_PER_DAY) return { eligible: false, reason: 'same_token_daily_cap' };
  if (latestTokenPost) {
    const elapsed = now - latestTokenPost.publishedAt;
    const currentClose = Number(candidate?.metrics?.close);
    const priorClose = Number(latestTokenPost.entryPrice);
    if (!Number.isFinite(priorClose)) {
      return { eligible: false, reason: elapsed < 6 * HOUR ? 'same_token_cooldown' : 'follow_up_not_holding' };
    }
    if (elapsed < 2 * HOUR) return { eligible: false, reason: 'follow_up_cooldown' };
    if (!Number.isFinite(currentClose) || !Number.isFinite(priorClose) || currentClose <= priorClose) {
      return { eligible: false, reason: 'follow_up_not_holding' };
    }
  }
  const latest = posts.reduce((latestPost, post) => !latestPost || post.publishedAt > latestPost.publishedAt ? post : latestPost, null);
  if (latest) {
    const storedNextEligibleAt = Number(latest.nextEligibleAt);
    const nextEligibleAt = Number.isFinite(storedNextEligibleAt)
      ? storedNextEligibleAt
      : latest.publishedAt + LEGACY_POST_SPACING_MS;
    if (now < nextEligibleAt) return { eligible: false, reason: 'global_cooldown', nextEligibleAt };
  }
  const threshold = scoreThresholdForSlots(quotaPosts.length, { maxPosts24h });
  if (requireScore && candidate.score < threshold) return { eligible: false, reason: 'score_below_threshold', threshold };
  return {
    eligible: true,
    reason: 'eligible',
    threshold: requireScore ? threshold : null,
    postNumber,
    verifiedContinuation: postNumber > 1,
  };
}

export class CandidatePool {
  constructor({ competitionWindowMs = 600_000, tierThresholds = { S: 92, A: 82, B: 72 } } = {}) {
    this.competitionWindowMs = competitionWindowMs;
    this.items = [];
    this.tierThresholds = tierThresholds;
  }

  get size() {
    return this.items.length;
  }

  add(candidate) {
    if (!candidate?.id || !Number.isFinite(candidate.occurredAt)) throw new TypeError('Candidate id and occurredAt are required.');
    const tier = candidate.tier || (candidate.score >= this.tierThresholds.S ? 'S' : candidate.score >= this.tierThresholds.A ? 'A' : candidate.score >= this.tierThresholds.B ? 'B' : 'WATCH');
    this.items.push({ ...candidate, tier });
  }

  selectRanked(now = Date.now()) {
    if (this.items.length === 0) return null;
    const openedAt = Math.min(...this.items.map((item) => item.occurredAt));
    if (now - openedAt < this.competitionWindowMs) return null;
    const ranked = [...this.items].sort((left, right) => {
      const leftGain = Number(left.priceChange24hPct || 0);
      const rightGain = Number(right.priceChange24hPct || 0);
      if (leftGain > 0 && rightGain > 0 && rightGain !== leftGain) return rightGain - leftGain;
      if (rightGain > 0 && leftGain <= 0) return 1;
      if (leftGain > 0 && rightGain <= 0) return -1;
      return right.score - left.score
        || Number(right.visualImpulsePriority || 0) - Number(left.visualImpulsePriority || 0)
        || right.confidence - left.confidence
        || right.quoteVolumeUsd - left.quoteVolumeUsd
        || right.occurredAt - left.occurredAt;
    });
    this.items = [];
    return ranked;
  }

  select(now = Date.now()) {
    return this.selectRanked(now)?.[0] || null;
  }
}
