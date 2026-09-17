import { EventEmitter } from 'node:events';
import path from 'node:path';
import { CRYPTO_MODES } from './config.js';
import { createCryptoEvent } from './event-types.js';
import { validateContentPackage } from './content/content-validator.js';
import { buildFactPack } from './content/fact-pack.js';
import { formatSquareEditorialPost } from './content/public-text-format.js';
import { writeReviewPackage } from './content/review-package.js';
import { evaluatePublicationEligibility } from './scoring/candidate-pool.js';
import { BASE_PUBLICATION_SCORE } from './scoring/anomaly-score.js';
import { classifyMarketStory, validateStoryChart } from './content/editorial-engine.js';

const SIX_HOURS = 6 * 60 * 60_000;
const ONE_HOUR = 60 * 60_000;
const TWO_HOURS = 2 * ONE_HOUR;
const CANDIDATE_QUEUE_TTL = 10 * 60_000;
const MAX_PENDING_CANDIDATES = 12;

function quotaPostsInWindow(state, now) {
  const posts = (state.posts || []).filter((post) => now - post.publishedAt < 24 * 60 * 60_000);
  const savedResetAt = Number(state.postLimitResetAt);
  const resetAt = Number.isFinite(savedResetAt) && savedResetAt <= now ? savedResetAt : null;
  return resetAt === null ? posts : posts.filter((post) => post.publishedAt >= resetAt);
}

function safeFileId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'candidate';
}

function publicPreview(preview) {
  if (!preview) return null;
  const { chartPath, ...publicFields } = preview;
  const filename = path.basename(String(chartPath || ''));
  return {
    ...publicFields,
    chartUrl: /^[a-zA-Z0-9_-]{1,80}\.png$/.test(filename)
      ? `/api/crypto/chart/${encodeURIComponent(filename)}`
      : null,
  };
}

const MEANINGFUL_EVENT_TYPES = new Set([
  'scanner_started',
  'scanner_stopped',
  'candidate_selected',
  'fact_pack_built',
  'review_package_written',
  'writer_started',
  'writer_completed',
  'writer_unavailable',
  'content_rejected',
  'candidate_queued',
  'candidate_dequeued',
  'post_preview_ready',
  'publish_intent',
  'publish_completed',
  'publish_failed',
  'publish_unknown',
  'publication_result',
  'mode_changed',
  'post_limit_reset',
  'runtime_error',
  'storage_corruption_detected',
  'recovery_blocked',
  'binance_rest_state_changed',
]);

function meaningfulEvents(events, limit = 12) {
  const seen = new Set();
  return (Array.isArray(events) ? events : [])
    .filter((event) => {
      if (!event || !MEANINGFUL_EVENT_TYPES.has(event.type)) return false;
      const key = event.eventId || `${event.type}:${event.occurredAt}:${event.payload?.candidateId || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-limit);
}

function openingExcerpt(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('\n\n')
    .slice(0, 280);
}

function recentEditorialContext(state) {
  const published = (state.posts || []).slice(-11).map((post) => ({
    source: 'published',
    token: post.token,
    hookFamily: post.hookFamily,
    openingFingerprint: post.openingFingerprint,
    publishedAt: post.publishedAt,
  }));
  const preview = state.lastPreview
    ? [{
        source: 'preview',
        hookFamily: state.lastPreview.hookFamily,
        openingFingerprint: state.lastPreview.openingFingerprint,
        opening: openingExcerpt(state.lastPreview.postText),
        createdAt: state.lastPreview.createdAt,
      }]
    : [];
  return [...published, ...preview].slice(-12);
}

function emptyResearchContext() {
  return { status: 'none_found', sources: [], claims: [], cleanCatalystFound: false };
}

async function collectResearchContext({ collector, provider, candidate }) {
  const identity = { symbol: candidate.symbol, baseAsset: candidate.token, projectName: candidate.token };
  if (collector?.collect) return collector.collect({ identity, occurredAt: candidate.occurredAt });
  if (typeof provider !== 'function') return emptyResearchContext();
  const result = await provider({ candidate, occurredAt: candidate.occurredAt, historical: candidate.historicalReplay === true });
  return {
    status: result?.status || 'none_found',
    sources: Array.isArray(result?.sources) ? result.sources : [],
    claims: Array.isArray(result?.facts) ? result.facts.map((text, index) => ({ id: `legacy-research:${index + 1}`, text, causalLanguageAllowed: false })) : [],
    cleanCatalystFound: false,
  };
}

function isCodexAuthError(error) {
  return error?.code === 'AUTH_REQUIRED'
    || /token[_ -]?revoked|unauthorized|authentication|\blogin\b|\bauth\b|\b401\b/i.test(String(error?.message || error));
}

function isMissingCodexThread(error) {
  return error?.code === 'NOT_FOUND'
    || /\bthread (?:was )?not found\b|\bthread not loaded\b/i.test(String(error?.message || error));
}

export class CryptoRuntime {
  constructor({
    config,
    stateStore,
    eventStore,
    jarvis,
    writer,
    chartRenderer,
    publisher,
    scannerController = null, binanceRestGovernor = null, binanceRestProbeRunner = null,
    liveDryRunRunner = null,
    historicalReplayRunner = null,
    researchProvider = null,
    researchCollector = null,
    researchPolicy = null,
    reviewPackageWriter = writeReviewPackage,
    clock = () => Date.now(),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    random = Math.random,
    pipelineFingerprint = 'runtime-unfingerprinted',
  } = {}) {
    this.config = config;
    this.stateStore = stateStore;
    this.eventStore = eventStore;
    this.jarvis = jarvis;
    this.writer = writer;
    this.chartRenderer = chartRenderer;
    this.publisher = publisher;
    this.scannerController = scannerController;
    this.binanceRestGovernor = binanceRestGovernor;
    this.binanceRestProbeRunner = binanceRestProbeRunner;
    this.liveDryRunRunner = liveDryRunRunner;
    this.historicalReplayRunner = historicalReplayRunner;
    this.researchProvider = researchProvider;
    this.researchCollector = researchCollector;
    this.researchPolicy = researchPolicy;
    this.reviewPackageWriter = reviewPackageWriter;
    this.clock = clock;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.random = random;
    this.pipelineFingerprint = pipelineFingerprint;
    this.events = new EventEmitter();
    this.initialized = false;
    this.scannerRunning = false;
    this.lastEvent = null;
    this.cryptoThreadId = null;
    this.startedAt = null;
    this.recoveryStatus = { status: 'pending', reason: null, migratedFrom: null };
    this.scannerStatus = { state: 'stopped' };
    this.binanceStatus = { state: 'disconnected' };
    this.binanceRestStatus = null;
    this.candidateRetryTimer = null;
    this.candidateRetryAttempt = 0;
    this.threadRecoveryPromise = null;
    this.codexExecutionContext = null;
  }

  subscribe(listener) {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  async initialize({ startScanner = true } = {}) {
    if (this.initialized) return this.status();
    let state = await this.stateStore.load();
    await this.#invalidateStaleAutoArm(state);
    await this.#reconcileRequestedMode();
    this.startedAt = this.clock();
    this.recoveryStatus = state.recovery || { status: 'ready', reason: null, migratedFrom: null };
    if (this.recoveryStatus.status !== 'ready') {
      this.initialized = true;
      this.scannerStatus = { state: 'blocked', reason: this.recoveryStatus.reason };
      await this.#record('recovery_blocked', { reason: this.recoveryStatus.reason });
      return this.status();
    }
    const localWriterReady = typeof this.writer?.initialize === 'function'
      ? await this.writer.initialize()
      : true;
    if (!localWriterReady) {
      const writerStatus = typeof this.writer?.status === 'function' ? this.writer.status() : {};
      const code = String(writerStatus.lastErrorCode || `${String(writerStatus.provider || 'writer').toUpperCase()}_UNAVAILABLE`).slice(0, 80);
      await this.#invalidateWriterReadiness(code.toLowerCase());
      await this.#record('writer_unavailable', {
        code, retryable: false, provider: writerStatus.provider || 'unknown',
      });
    }
    // The pinned manual Crypto conversation is convenience UI only. Its Codex
    // thread must never gate the independent local publication path.
    try {
      await this.#ensureCryptoThread();
      await this.#markCodexHealthy();
    } catch (error) {
      await this.stateStore.update((current) => ({
        ...current,
        codexHealth: { status: 'degraded', checkedAt: this.clock(), reason: 'manual_chat_unavailable' },
      }));
    }
    const storageAudit = typeof this.eventStore?.auditRecent === 'function' ? await this.eventStore.auditRecent() : null;
    if (storageAudit?.malformedLines) await this.#record('storage_corruption_detected', {
      malformedLines: storageAudit.malformedLines,
      files: [...new Set(storageAudit.diagnostics.map((item) => item.file))].slice(0, 8),
    });
    const publicationRecovery = await this.publisher.recoverPending();
    this.recoveryStatus = { ...this.recoveryStatus, publication: publicationRecovery.status };
    await this.#pruneCandidateQueue();
    if (startScanner && this.config.scannerEnabled && this.scannerController) {
      await this.scannerController.start({ onCandidate: (candidate) => this.processCandidate(candidate) });
      this.scannerRunning = true;
      this.scannerStatus = { state: 'running' };
      await this.#record('scanner_started', { mode: (await this.stateStore.load()).mode });
    }
    this.initialized = true;
    this.#scheduleCandidateRetry();
    return this.status();
  }

  async stop() {
    if (this.candidateRetryTimer) this.clearTimeoutImpl(this.candidateRetryTimer);
    this.candidateRetryTimer = null;
    if (this.scannerRunning) await this.scannerController?.stop?.();
    this.scannerRunning = false;
    this.scannerStatus = { state: 'stopped' };
    if (this.initialized) await this.#record('scanner_stopped', {});
    this.initialized = false;
  }

  async status() {
    const state = await this.stateStore.load();
    const credential = await this.publisher.credentialStatus();
    const posts24h = quotaPostsInWindow(state, this.clock()).length;
    const persistedEvents = typeof this.eventStore?.listRecent === 'function'
      ? await this.eventStore.listRecent({ limit: 40, types: [...MEANINGFUL_EVENT_TYPES] })
      : [];
    return {
      mode: state.mode,
      scanner: this.scannerRunning ? 'running' : 'stopped',
      runtime: this.initialized ? 'running' : 'stopped',
      startedAt: this.startedAt,
      recovery: this.recoveryStatus.status === 'pending'
        ? (state.recovery || { status: 'ready', reason: null, migratedFrom: null })
        : this.recoveryStatus,
      scannerStatus: this.scannerStatus,
      binanceStatus: this.binanceStatus,
      binanceRestStatus: this.binanceRestStatus,
      threadId: state.cryptoThreadId,
      autoReady: Boolean(state.autoReady),
      autoArmed: Boolean(state.autoArmed),
      manualAutoOverride: Boolean(state.manualAutoOverride),
      autoArm: state.autoArm ? {
        fingerprint: state.autoArm.pipelineFingerprint || null,
        verifiedAt: state.autoArm.verifiedAt || null,
        reason: state.autoArm.reason || null,
        result: state.autoArm.result || null,
        writerFingerprint: state.autoArm.writerFingerprint || null,
      } : null,
      writer: typeof this.writer?.status === 'function'
        ? this.writer.status()
        : { provider: 'unknown', configured: false, state: 'offline' },
      dryRunVerifiedAt: state.dryRunVerifiedAt,
      squareCredentialConfigured: credential.configured,
      squareCredentialSource: credential.source,
      publishAvailability: state.recovery?.status === 'blocked'
        ? 'PUBLISH_DISABLED: recovery_blocked'
        : state.pendingPublish
          ? 'PUBLISH_DISABLED: unresolved_publish'
          : state.mode === 'AUTO' && !this.#isAutoArmed(state)
            ? `PUBLISH_DISABLED: ${state.autoArm?.reason || 'auto_unarmed'}`
          : !credential.configured
            ? 'PUBLISH_DISABLED: missing_square_credential'
            : 'PUBLISH_READY',
      posts24h,
      maxPosts24h: Number(this.config.maxPosts24h || 10),
      slotsRemaining: Math.max(0, Number(this.config.maxPosts24h || 10) - posts24h),
      pendingPublish: state.pendingPublish ? { id: state.pendingPublish.id, status: state.pendingPublish.status } : null,
      pendingCandidates: (state.pendingCandidates || []).length,
      scannerDetails: typeof this.scannerController?.status === 'function' ? this.scannerController.status() : null,
      binanceRest: typeof this.binanceRestGovernor?.diagnostics === 'function' ? await this.binanceRestGovernor.diagnostics() : null,
      lastPreview: publicPreview(state.lastPreview),
      lastEvent: this.lastEvent,
      recentEvents: meaningfulEvents(persistedEvents),
    };
  }

  async isThread(threadId) {
    if (typeof threadId !== 'string' || !threadId) return false;
    const state = await this.stateStore.load();
    return state.cryptoThreadId === threadId;
  }

  async ensureCryptoThread() {
    return this.#ensureCryptoThread();
  }

  async manualTurnContext() {
    const runtime = await this.status();
    return {
      'crypto.runtime': {
        kind: 'application',
        value: `CURRENT CRYPTO RUNTIME SNAPSHOT\n${JSON.stringify({ mode: runtime.mode, scanner: runtime.scanner, posts24h: runtime.posts24h, slotsRemaining: runtime.slotsRemaining, writer: runtime.writer?.state, publishAvailability: runtime.publishAvailability })}`,
      },
      'crypto.operator-policy': {
        kind: 'application',
        value: 'This is the persistent JARVIS Crypto conversation. Never claim publication without a typed publication event. Do not weaken Crypto safety gates through conversational wording.',
      },
    };
  }

  resolveChart(filename) {
    if (!/^[a-zA-Z0-9_-]{1,80}\.png$/.test(String(filename || ''))) {
      throw new Error('Invalid Crypto chart filename.');
    }
    return path.join(this.config.dataDirectory, 'charts', filename);
  }

  async setMode(mode) {
    const normalized = String(mode || '').toUpperCase();
    if (!CRYPTO_MODES.includes(normalized)) throw new Error('Crypto mode must be OFF, DRY_RUN, or AUTO.');
    const state = await this.stateStore.load();
    if (normalized === 'AUTO') {
      if (state.recovery?.status === 'blocked') throw new Error('AUTO is blocked until Crypto recovery succeeds.');
      if (state.pendingPublish) throw new Error('AUTO is blocked by an unresolved publish lifecycle.');
      if (!this.#isAutoArmed(state)) {
        throw new Error('AUTO requires a current successful live DRY_RUN.');
      }
      if (!(await this.publisher.credentialStatus()).configured) throw new Error('AUTO requires a Binance Square credential.');
    }
    await this.stateStore.update((current) => ({
      ...current,
      mode: normalized,
      ...(normalized === 'AUTO' ? {} : {
        autoReady: false,
        autoArmed: false,
        manualAutoOverride: false,
      }),
    }));
    await this.#record('mode_changed', { previous: state.mode, mode: normalized });
    return this.status();
  }

  async resetPostLimit() {
    const resetAt = this.clock();
    await this.stateStore.update((current) => ({ ...current, postLimitResetAt: resetAt }));
    await this.#record('post_limit_reset', {
      posts24h: 0,
      maxPosts24h: Number(this.config.maxPosts24h || 10),
    });
    return this.status();
  }

  updateScannerStatus(status) {
    if (status && typeof status === 'object') this.scannerStatus = { ...status };
  }

  updateBinanceStatus(status) {
    if (status && typeof status === 'object') this.binanceStatus = { ...status };
  }

  recordBinanceRestDiagnostic(diagnostic) {
    if (!diagnostic || typeof diagnostic !== 'object') return;
    const safe = {
      at: Number(diagnostic.at) || this.clock(),
      type: String(diagnostic.type || 'unknown').slice(0, 80),
      caller: String(diagnostic.caller || 'unknown').slice(0, 80),
      endpoint: String(diagnostic.endpoint || 'unknown').split('?')[0].slice(0, 120),
      ...(Number.isFinite(Number(diagnostic.status)) ? { status: Number(diagnostic.status) } : {}),
      ...(Number.isFinite(Number(diagnostic.binanceCode)) ? { binanceCode: Number(diagnostic.binanceCode) } : {}),
      ...(Number.isFinite(Number(diagnostic.retryAfterSeconds)) ? { retryAfterSeconds: Number(diagnostic.retryAfterSeconds) } : {}),
      ...(Number.isFinite(Number(diagnostic.usedWeight1m)) ? { usedWeight1m: Number(diagnostic.usedWeight1m) } : {}),
      ...(Number.isFinite(Number(diagnostic.blockedUntil)) ? { blockedUntil: Number(diagnostic.blockedUntil) } : {}),
    };
    this.binanceRestStatus = safe;
    if (['cooldown', 'banned', 'recovery_started', 'recovery_succeeded', 'persisted_block_loaded'].includes(safe.type)) {
      void this.#record('binance_rest_state_changed', safe).catch(() => {});
    }
  }

  async runLiveDryRun() {
    if (typeof this.liveDryRunRunner !== 'function') throw new Error('Live DRY_RUN is unavailable.');
    const result = await this.liveDryRunRunner();
    if (!result?.ok || result?.checks?.fullPipeline !== true || result?.checks?.noPublishing !== true) {
      throw new Error('Live DRY_RUN failed.');
    }
    const publishablePreview = result.result === 'PUBLISHABLE_PREVIEW'
      || (result.result === undefined && result.pipeline?.status === 'preview' && result.pipeline?.published === false);
    if (!publishablePreview) {
      const state = await this.stateStore.load();
      return {
        ...result,
        autoReady: false,
        autoArmed: false,
        publishBlocked: 'not_publishable_preview',
      };
    }
    const verifiedAt = this.clock();
    await this.stateStore.update((current) => ({
      ...current,
      // A dry-run proves a preview only. It never changes future
      // publication readiness: AUTO must remain explicitly user-controlled.
      autoReady: false,
      autoArmed: false,
      manualAutoOverride: false,
      dryRunVerifiedAt: verifiedAt,
      autoArm: {
        pipelineFingerprint: this.pipelineFingerprint,
        writerFingerprint: this.#writerFingerprint(),
        verifiedAt,
        result: 'live_dry_run_passed',
        reason: 'manual_confirmation_required',
      },
      liveDryRun: { ...result, verifiedAt },
    }));
    return { ...result, autoReady: false, autoArmed: false, publishBlocked: 'manual_confirmation_required' };
  }

  async runHistoricalReplay(options = {}) {
    if (typeof this.historicalReplayRunner !== 'function') throw new Error('Historical replay is unavailable.');
    // This is intentionally isolated from processCandidate: it does not alter
    // AUTO readiness, live previews, cooldowns, or publication state.
    return this.historicalReplayRunner(options);
  }

  async runBinanceRestRecoveryProbe() {
    if (typeof this.binanceRestProbeRunner !== 'function') throw new Error('Binance REST recovery probe is unavailable.');
    const before = typeof this.binanceRestGovernor?.diagnostics === 'function' ? await this.binanceRestGovernor.diagnostics() : null;
    const response = await this.binanceRestProbeRunner();
    const after = typeof this.binanceRestGovernor?.diagnostics === 'function' ? await this.binanceRestGovernor.diagnostics() : null;
    return { ok: true, response, before, after };
  }

  async confirmAutoArm({ force = false } = {}) {
    const state = await this.stateStore.load();
    const credential = await this.publisher.credentialStatus();
    if (!credential.configured) throw new Error('AUTO confirmation requires a Binance Square credential.');
    if (state.recovery?.status === 'blocked') throw new Error('AUTO is blocked until Crypto recovery succeeds.');
    if (state.pendingPublish) throw new Error('AUTO is blocked by an unresolved publish lifecycle.');
    if (force === true) {
      await this.stateStore.update((current) => ({
        ...current,
        mode: 'AUTO',
        autoArmed: true,
        manualAutoOverride: true,
        autoArm: {
          pipelineFingerprint: this.pipelineFingerprint,
          writerFingerprint: this.#writerFingerprint(),
          verifiedAt: this.clock(),
          result: 'manual_override',
          reason: 'explicit_user_override',
        },
      }));
      await this.#record('mode_changed', { previous: state.mode, mode: 'AUTO', manualAutoOverride: true });
      return this.status();
    }
    if (
      !state.autoReady
      || state.autoArm?.pipelineFingerprint !== this.pipelineFingerprint
      || state.autoArm?.result !== 'live_dry_run_passed'
      || state.autoArm?.reason !== 'manual_confirmation_required'
      || state.autoArm?.writerFingerprint !== this.#writerFingerprint()
    ) throw new Error('AUTO confirmation requires a current successful live DRY_RUN.');
    await this.stateStore.update((current) => ({
      ...current,
      mode: 'AUTO',
      autoArmed: true,
      manualAutoOverride: false,
      autoArm: {
        ...current.autoArm,
        reason: null,
        result: 'manual_confirmation_after_live_dry_run',
      },
    }));
    await this.#record('mode_changed', { previous: state.mode, mode: 'AUTO', manualAutoOverride: false });
    return this.status();
  }

  async processCandidate(candidate, options = {}) {
    await this.#record('anomaly_detected', {
      candidateId: candidate.id,
      symbol: candidate.symbol,
      score: candidate.score,
      scoreSource: candidate.scoreSource || 'deterministic-code',
      validationForcedCandidate: candidate.validationForcedCandidate === true,
      productionEligible: candidate.productionEligible === true,
    });
    let state = await this.stateStore.load();
    const effectiveMode = options.modeOverride || state.mode;
    if (effectiveMode === 'OFF') return { status: 'off', candidateId: candidate.id };
    if (effectiveMode === 'AUTO' && !options.bypassEligibility && !this.#isAutoArmed(state)) {
      await this.#record('candidate_rejected', { candidateId: candidate.id, reason: 'auto_unarmed' });
      return { status: 'auto_blocked', reason: 'auto_unarmed', candidateId: candidate.id };
    }
    const topRunner = this.config.topRunnerMode === true && candidate.livePublicData === true;
    const requireScore = !topRunner && (this.config.requireScoreForLiveRunner !== false || candidate.livePublicData !== true || candidate.freshRunnerEligible !== true);
    if (requireScore && candidate.score < BASE_PUBLICATION_SCORE && !options.bypassEligibility) {
      await this.#record('candidate_rejected', { candidateId: candidate.id, reason: 'score_under_75', score: candidate.score });
      return { status: 'observed', reason: 'score_under_75', candidateId: candidate.id };
    }
    if (!topRunner && candidate.autoEligible !== true) {
      await this.#record('candidate_rejected', { candidateId: candidate.id, reason: 'monitor_only', score: candidate.score });
      return { status: 'rejected', reason: 'monitor_only', candidateId: candidate.id };
    }
    if (!topRunner && candidate.livePublicData === true && candidate.freshRunnerEligible !== true && !options.bypassEligibility) {
      await this.#record('candidate_rejected', { candidateId: candidate.id, reason: 'final_impulse_not_fresh', score: candidate.score });
      return { status: 'rejected', reason: 'final_impulse_not_fresh', candidateId: candidate.id };
    }
    if (candidate.expired && !options.bypassEligibility) {
      await this.#record('candidate_rejected', { candidateId: candidate.id, reason: 'expired' });
      return { status: 'rejected', reason: 'expired', candidateId: candidate.id };
    }
    if (!options.bypassEligibility) {
      const eligibility = evaluatePublicationEligibility(candidate, state, this.clock(), {
        maxPosts24h: Number(this.config.maxPosts24h || 10),
        requireScore,
      });
      if (!eligibility.eligible) {
        await this.#record('candidate_rejected', { candidateId: candidate.id, reason: eligibility.reason, score: candidate.score });
        return { status: candidate.score < 86 ? 'watch' : 'rejected', reason: eligibility.reason, candidateId: candidate.id };
      }
      candidate = {
        ...candidate,
        publicationSequence: eligibility.postNumber || 1,
        verifiedContinuation: eligibility.verifiedContinuation === true,
        materialFollowUp: eligibility.verifiedContinuation === true,
      };
    }
    const lastAnalyzedAt = Number(state.tokenLastAnalyzedAt?.[candidate.token] || 0);
    const analysisCooldown = TWO_HOURS;
    if (!options.bypassEligibility && lastAnalyzedAt && this.clock() - lastAnalyzedAt < analysisCooldown) {
      await this.#record('candidate_rejected', { candidateId: candidate.id, reason: 'same_token_analysis_cooldown' });
      return { status: 'rejected', reason: 'same_token_analysis_cooldown', candidateId: candidate.id };
    }
    const editorialHistory = Array.isArray(state.editorialHistory) ? state.editorialHistory : [];
    const marketStoryCluster = classifyMarketStory(candidate);
    const sibling = editorialHistory.find((entry) => entry.marketStoryCluster === marketStoryCluster);
    const isSameTokenContinuation = candidate.verifiedContinuation === true && sibling?.symbol === candidate.symbol;
    if (sibling && !isSameTokenContinuation) {
      await this.#record('candidate_rejected', { candidateId: candidate.id, reason: 'MARKET_STORY_DUPLICATE', representative: sibling.symbol || null });
      return { status: 'rejected', reason: 'MARKET_STORY_DUPLICATE', candidateId: candidate.id };
    }
    await this.#record('candidate_selected', {
      candidateId: candidate.id,
      symbol: candidate.symbol,
      score: candidate.score,
      validationForcedCandidate: candidate.validationForcedCandidate === true,
      productionEligible: candidate.productionEligible === true,
    });
    let research;
    try {
      research = await collectResearchContext({ collector: this.researchCollector, provider: this.researchProvider, candidate });
    } catch {
      // Editorial research is optional; a technical story must remain able to publish.
      research = emptyResearchContext();
    }
    const factPackResult = buildFactPack({
      candidate,
      technicalContext: candidate.technicalContext,
      research,
      priorTokenState: state.tokenNarratives?.[candidate.token] || null,
    });
    if (!factPackResult.ok) {
      await this.#record('content_rejected', { candidateId: candidate.id, errors: [factPackResult.reason] });
      return { status: 'content_rejected', errors: [factPackResult.reason], candidateId: candidate.id };
    }
    const factPack = factPackResult.factPack;
    await this.#record('fact_pack_built', { candidateId: candidate.id, researchStatus: factPack.research.status, levelCount: Object.keys(factPack.factsById).filter((id) => id.startsWith('level:')).length });
    await this.#record('writer_started', { candidateId: candidate.id, provider: this.writer?.status?.().provider || 'unknown' });
    let content;
    let editorial = null;
    try {
      if (typeof this.writer?.generateV5 === 'function') {
        editorial = await this.writer.generateV5({
          candidate,
          factPack,
          editorialHistory: [...editorialHistory, ...recentEditorialContext(state)].slice(-20),
        });
      } else if (typeof this.writer?.generateV4 === 'function') {
        editorial = await this.writer.generateV4({
          candidate,
          factPack,
          editorialHistory: [...editorialHistory, ...recentEditorialContext(state)].slice(-12),
        });
      } else if (typeof this.writer?.generate === 'function') {
        editorial = await this.writer.generate({ candidate, editorialHistory: [...editorialHistory, ...recentEditorialContext(state)].slice(-12) });
      } else throw new Error('Local Gemma writer is unavailable.');
      if (editorial.status !== 'ready') {
        const reason = editorial.reason || 'editorial_skip';
        await this.#record('writer_completed', { candidateId: candidate.id, decision: 'skip', reason, provider: editorial.provider || this.writer?.status?.().provider || 'unknown' });
        await this.#record('content_rejected', { candidateId: candidate.id, errors: [reason] });
        if (editorial?.audit && typeof this.reviewPackageWriter === 'function') {
          try {
            const review = await this.reviewPackageWriter({
              directory: path.join(this.config.dataDirectory, 'reviews'), candidate, factPack, editorial,
              validation: { ok: false, errors: [reason] }, chart: null,
              publication: { status: 'content_skipped', published: false },
            });
            await this.#record('review_package_written', { candidateId: candidate.id, reviewId: review.id });
          } catch {}
        }
        return { status: 'content_skipped', reason, candidateId: candidate.id };
      }
      content = editorial.content;
    } catch (error) {
      // A provider failure is still an auditable editorial attempt. Keep the
      // deterministic Fact Pack and a sanitized failure code in review, even
      // for readiness-only DRY_RUNs that subsequently rethrow the transport
      // error to the runner.
      if (typeof this.reviewPackageWriter === 'function') {
        try {
          const code = String(error?.code || 'WRITER_UNAVAILABLE').slice(0, 80);
          const review = await this.reviewPackageWriter({
            directory: path.join(this.config.dataDirectory, 'reviews'),
            candidate,
            factPack,
            editorial: { audit: { writerFailure: { code } } },
            validation: { ok: false, errors: [code.toLowerCase()] },
            chart: null,
            publication: { status: 'writer_unavailable', published: false },
          });
          await this.#record('review_package_written', { candidateId: candidate.id, reviewId: review.id });
        } catch (reviewError) {
          await this.#record('runtime_error', { candidateId: candidate.id, stage: 'review_package', code: String(reviewError?.code || 'WRITE_FAILED').slice(0, 80) });
        }
      }
      return this.#writerFailureResult(error, candidate, options);
    }
    await this.stateStore.update((current) => ({
      ...current,
      tokenLastAnalyzedAt: { ...(current.tokenLastAnalyzedAt || {}), [candidate.token]: this.clock() },
    }));
    await this.#record('writer_completed', { candidateId: candidate.id, decision: content.decision, provider: editorial.provider || this.writer?.status?.().provider || 'unknown', model: editorial.model || null });
    if (content.decision === 'skip') return { status: 'content_skipped', reason: content.reason, candidateId: candidate.id };
    content = {
      ...content,
      postText: formatSquareEditorialPost({
        text: content.postText,
        candidate,
        storyKind: editorial?.finalStory?.spine?.storyKind || editorial?.plan?.storyKind,
      }),
    };
    const currentState = await this.stateStore.load();
    const recentEditorialHistory = recentEditorialContext(currentState);
    const validation = validateContentPackage(content, candidate, {
      factPack,
      fingerprints: currentState.fingerprints,
      openingFingerprints: recentEditorialHistory.map((entry) => entry.openingFingerprint).filter(Boolean),
    });
    if (!validation.ok) {
      await this.#record('content_rejected', { candidateId: candidate.id, errors: validation.errors });
      if (editorial?.audit && typeof this.reviewPackageWriter === 'function') {
        try {
          const review = await this.reviewPackageWriter({
            directory: path.join(this.config.dataDirectory, 'reviews'), candidate, factPack, editorial, validation,
            chart: null, publication: { status: 'content_rejected', published: false },
          });
          await this.#record('review_package_written', { candidateId: candidate.id, reviewId: review.id });
        } catch {}
      }
      return { status: 'content_rejected', errors: validation.errors, candidateId: candidate.id };
    }
    const chartPath = path.join(this.config.dataDirectory, 'charts', `${safeFileId(candidate.id)}.png`);
    const chart = await this.chartRenderer({ candidate, factPack, visualIntent: content.visualIntent, finalStory: editorial.finalStory || null, outputPath: chartPath });
    const visual = validateStoryChart({ candidate, factPack, plan: editorial.plan, finalStory: editorial.finalStory || null, visualIntent: content.visualIntent, chart });
    if (!visual.pass) {
      await this.#record('content_rejected', { candidateId: candidate.id, errors: [visual.reason] });
      if (editorial?.audit && typeof this.reviewPackageWriter === 'function') {
        try {
          const review = await this.reviewPackageWriter({
            directory: path.join(this.config.dataDirectory, 'reviews'),
            candidate,
            factPack,
            editorial,
            validation: { ...validation, ok: false, errors: [visual.reason] },
            chart,
            publication: { status: 'content_rejected', published: false },
          });
          await this.#record('review_package_written', { candidateId: candidate.id, reviewId: review.id });
        } catch {}
      }
      return { status: 'content_rejected', errors: [visual.reason], candidateId: candidate.id };
    }
    await this.#record('chart_rendered', { candidateId: candidate.id, preset: content.visualIntent.preset, sha256: chart.sha256 });
    let published;
    try {
      published = await this.publisher.publishPackage({
        mode: effectiveMode,
        content,
        candidate,
        validation,
        chartPath: chart.path,
      });
    } catch (error) {
      await this.#record('publication_result', { candidateId: candidate.id, symbol: candidate.symbol, status: 'failed' });
      throw error;
    }
    let reviewPackage = null;
    if (editorial?.audit && typeof this.reviewPackageWriter === 'function') {
      try {
        reviewPackage = await this.reviewPackageWriter({
          directory: path.join(this.config.dataDirectory, 'reviews'),
          candidate,
          factPack,
          editorial,
          validation,
          chart,
          publication: published,
        });
        await this.#record('review_package_written', { candidateId: candidate.id, reviewId: reviewPackage.id });
      } catch (error) {
        await this.#record('runtime_error', { candidateId: candidate.id, stage: 'review_package', code: String(error?.code || 'WRITE_FAILED').slice(0, 80) });
      }
    }
    if (published.status === 'preview') {
      await this.stateStore.update((current) => ({
        ...current,
        autoReady: candidate.livePublicData === true && !options.readinessOnly ? true : current.autoReady,
        dryRunVerifiedAt: candidate.livePublicData === true && !options.readinessOnly ? this.clock() : current.dryRunVerifiedAt,
        lastPreview: {
          ...published.preview,
          candidateId: candidate.id,
          score: candidate.score,
          createdAt: this.clock(),
          readinessOnly: candidate.readinessOnly === true,
          validationForcedCandidate: candidate.validationForcedCandidate === true,
          productionEligible: candidate.productionEligible === true,
          observedAt: candidate.occurredAt,
          reviewId: reviewPackage?.id || null,
          hookFamily: validation.hookFamily,
          openingFingerprint: validation.openingFingerprint,
        },
        fingerprints: [...new Set([...(current.fingerprints || []), validation.fingerprint])].slice(-500),
        editorialHistory: editorial
          ? [...(current.editorialHistory || []), { symbol: candidate.symbol, text: content.postText, fingerprint: editorial.fingerprint, marketStoryCluster: editorial.marketStoryCluster, hookFamily: validation.hookFamily, openingFingerprint: validation.openingFingerprint, narrativeSignature: editorial.narrativeSignature || null, publishedThesis: editorial.publishedThesis || null, createdAt: this.clock() }].slice(-100)
          : (current.editorialHistory || []),
        tokenNarratives: editorial?.publishedThesis
          ? { ...(current.tokenNarratives || {}), [candidate.token]: { ...editorial.publishedThesis, publishedAt: this.clock() } }
          : (current.tokenNarratives || {}),
      }));
      await this.#record('post_preview_ready', {
        candidateId: candidate.id,
        symbol: candidate.symbol,
        score: candidate.score,
        published: false,
        validationForcedCandidate: candidate.validationForcedCandidate === true,
        productionEligible: candidate.productionEligible === true,
        postText: content.postText,
      });
    } else {
      await this.stateStore.update((current) => ({
        ...current,
        editorialHistory: editorial
          ? [...(current.editorialHistory || []), { symbol: candidate.symbol, text: content.postText, fingerprint: editorial.fingerprint, marketStoryCluster: editorial.marketStoryCluster, hookFamily: validation.hookFamily, openingFingerprint: validation.openingFingerprint, narrativeSignature: editorial.narrativeSignature || null, publishedThesis: editorial.publishedThesis || null, createdAt: this.clock() }].slice(-100)
          : (current.editorialHistory || []),
        tokenNarratives: editorial?.publishedThesis
          ? { ...(current.tokenNarratives || {}), [candidate.token]: { ...editorial.publishedThesis, publishedAt: this.clock() } }
          : (current.tokenNarratives || {}),
      }));
      await this.#record('publication_result', {
        candidateId: candidate.id,
        symbol: candidate.symbol,
        status: published.status,
        published: published.published === true,
        postText: content.postText,
      });
    }
    return { ...published, candidateId: candidate.id };
  }

  async #queueCandidate(candidate, reason = 'writer_unavailable') {
    const queuedAt = this.clock();
    await this.stateStore.update((current) => {
      const active = (current.pendingCandidates || [])
        .filter((item) => item?.expiresAt > queuedAt && item?.candidate?.id !== candidate.id);
      active.push({
        id: candidate.id,
        queuedAt,
        expiresAt: queuedAt + CANDIDATE_QUEUE_TTL,
        candidate: structuredClone(candidate),
      });
      return { ...current, pendingCandidates: active.slice(-MAX_PENDING_CANDIDATES) };
    });
    await this.#record('candidate_queued', { candidateId: candidate.id, reason });
    this.#scheduleCandidateRetry();
  }

  async #pruneCandidateQueue() {
    const now = this.clock();
    await this.stateStore.update((current) => ({
      ...current,
      pendingCandidates: (current.pendingCandidates || []).filter((item) => item?.expiresAt > now).slice(-MAX_PENDING_CANDIDATES),
    }));
  }

  #scheduleCandidateRetry() {
    if (this.candidateRetryTimer || !this.initialized) return;
    void this.stateStore.load().then((state) => {
      if (this.candidateRetryTimer || (state.pendingCandidates || []).length === 0 || !this.initialized) return;
      const base = Math.min(5 * 60_000, 30_000 * (2 ** Math.min(this.candidateRetryAttempt, 4)));
      const delay = Math.round(base * (0.85 + (this.random() * 0.3)));
      this.candidateRetryTimer = this.setTimeoutImpl(() => {
        this.candidateRetryTimer = null;
        void this.#retryCandidateQueue().catch(() => {
          this.candidateRetryAttempt += 1;
          this.#scheduleCandidateRetry();
        });
      }, delay);
      this.candidateRetryTimer?.unref?.();
    }).catch(() => {});
  }

  async #retryCandidateQueue() {
    await this.#pruneCandidateQueue();
    const state = await this.stateStore.load();
    const queued = state.pendingCandidates?.[0];
    if (!queued) {
      this.candidateRetryAttempt = 0;
      return;
    }
    const result = await this.processCandidate(queued.candidate, { fromQueue: true });
    if (result.status === 'queued') {
      this.candidateRetryAttempt += 1;
      this.#scheduleCandidateRetry();
      return;
    }
    await this.stateStore.update((current) => ({
      ...current,
      pendingCandidates: (current.pendingCandidates || []).filter((item) => item.id !== queued.id),
    }));
    this.candidateRetryAttempt = 0;
    await this.#record('candidate_dequeued', { candidateId: queued.id, result: result.status });
    this.#scheduleCandidateRetry();
  }

  async #ensureCryptoThread() {
    if (this.threadRecoveryPromise) return this.threadRecoveryPromise;
    this.threadRecoveryPromise = this.#recoverCryptoThread();
    try {
      return await this.threadRecoveryPromise;
    } finally {
      this.threadRecoveryPromise = null;
    }
  }

  async #recoverCryptoThread() {
    const execution = await this.#requireCodexExecutionContext();
    const state = await this.stateStore.load();
    if (state.cryptoThreadId) {
      if (typeof this.jarvis.readThread === 'function') {
        try {
          await this.jarvis.readThread(state.cryptoThreadId);
          this.cryptoThreadId = state.cryptoThreadId;
          return state.cryptoThreadId;
        } catch (error) {
          if (!isMissingCodexThread(error)) {
            await this.#invalidateCodexReadiness(isCodexAuthError(error) ? 'codex_auth_required' : 'codex_thread_unavailable', error);
            throw error;
          }
        }
      } else {
        this.cryptoThreadId = state.cryptoThreadId;
        return state.cryptoThreadId;
      }
    }
    const thread = await this.jarvis.createThread();
    await this.jarvis.renameThread(thread.id, 'Crypto');
    const executionAfter = await this.#requireCodexExecutionContext();
    if (executionAfter.fingerprint !== execution.fingerprint) {
      await this.#invalidateCodexReadiness('codex_execution_context_changed');
      const error = new Error('Codex execution context changed during thread recovery.');
      error.code = 'CODEX_CONTEXT_CHANGED';
      throw error;
    }
    await this.stateStore.update((current) => ({
      ...current,
      cryptoThreadId: thread.id,
    }));
    this.cryptoThreadId = thread.id;
    return thread.id;
  }

  #isAutoArmed(state) {
    if (state.autoArmed === true && state.manualAutoOverride === true && state.autoArm?.result === 'manual_override') return true;
    return state.autoArmed === true
      && state.autoArm?.result === 'manual_confirmation_after_live_dry_run'
      && this.#isLiveReadinessCurrent(state);
  }

  #isLiveReadinessCurrent(state) {
    return state.autoReady === true
      && state.autoArm?.pipelineFingerprint === this.pipelineFingerprint
      && ['live_dry_run_passed', 'manual_confirmation_after_live_dry_run'].includes(state.autoArm?.result)
      && state.autoArm?.writerFingerprint === this.#writerFingerprint();
  }

  #writerFingerprint() {
    const status = typeof this.writer?.status === 'function' ? this.writer.status() : {};
    return `${String(status.provider || 'ollama')}:${String(status.model || 'unavailable')}`;
  }

  async #invalidateStaleAutoArm(state) {
    if (state.autoArmed === true && state.manualAutoOverride === true && state.autoArm?.result === 'manual_override') return;
    if (this.#isLiveReadinessCurrent(state)) return;
    if (state.autoReady === false && state.autoArmed === false && state.autoArm?.reason === 'missing_or_stale_validation') return;
    await this.stateStore.update((current) => ({
      ...current,
      autoReady: false,
      autoArmed: false,
      manualAutoOverride: false,
      autoArm: {
        pipelineFingerprint: current.autoArm?.pipelineFingerprint || null,
        writerFingerprint: current.autoArm?.writerFingerprint || null,
        verifiedAt: current.autoArm?.verifiedAt || null,
        result: current.autoArm?.result || null,
        reason: 'missing_or_stale_validation',
      },
    }));
  }

  async #reconcileRequestedMode() {
    const state = await this.stateStore.load();
    if (state.mode !== 'AUTO') {
      if (state.autoArmed !== true && state.manualAutoOverride !== true && state.autoReady !== true) return;
      await this.stateStore.update((current) => ({
        ...current,
        autoReady: false,
        autoArmed: false,
        manualAutoOverride: false,
      }));
      return;
    }
    if (this.#isAutoArmed(state)) return;
    await this.stateStore.update((current) => ({
      ...current,
      mode: 'DRY_RUN',
      autoArmed: false,
      manualAutoOverride: false,
    }));
    await this.#record('mode_changed', { previous: 'AUTO', mode: 'DRY_RUN', reason: 'auto_unarmed_reconciled' });
  }

  async #requireCodexExecutionContext() {
    const context = typeof this.jarvis?.executionContext === 'function'
      ? await this.jarvis.executionContext()
      : { healthy: true, authMode: 'unmanaged', planType: 'unknown', model: 'unmanaged', fingerprint: 'legacy-unmanaged-context' };
    if (!context?.healthy || !context?.model || !context?.fingerprint) {
      const error = new Error('Codex execution capabilities are unavailable.');
      error.code = 'MODEL_UNAVAILABLE';
      throw error;
    }
    const safe = {
      healthy: true,
      authMode: String(context.authMode || 'authenticated').slice(0, 40),
      planType: String(context.planType || 'unknown').slice(0, 40),
      model: String(context.model).slice(0, 120),
      fingerprint: String(context.fingerprint).slice(0, 128),
    };
    if (this.codexExecutionContext?.fingerprint && this.codexExecutionContext.fingerprint !== safe.fingerprint) {
      await this.#invalidateCodexReadiness('codex_execution_context_changed');
    }
    this.codexExecutionContext = safe;
    return safe;
  }

  async #invalidateCodexReadiness(reason, error = null) {
    const authRequired = isCodexAuthError(error) || reason === 'codex_auth_required';
    await this.stateStore.update((current) => ({
      ...current,
      codexHealth: {
        status: authRequired ? 'auth_required' : 'degraded',
        checkedAt: this.clock(),
        reason: authRequired ? 'token_revoked_or_login_required' : reason,
        executionFingerprint: this.codexExecutionContext?.fingerprint || null,
      },
    }));
  }

  async #markCodexHealthy() {
    await this.stateStore.update((current) => ({
      ...current,
      codexHealth: { status: 'healthy', checkedAt: this.clock(), reason: null },
    }));
  }

  async #writerFailureResult(error, candidate, options = {}) {
    const code = String(error?.code || 'WRITER_UNAVAILABLE').slice(0, 80);
    const unavailableWithoutRetry = code.startsWith('OLLAMA_') || code === 'ANYMODEL_API_KEY_MISSING' || code === 'ANYMODEL_AUTH_FAILED';
    const retryable = error?.retryable === true && !options.readinessOnly && !unavailableWithoutRetry;
    const reason = code.toLowerCase();
    if (!retryable) await this.#invalidateWriterReadiness(reason);
    await this.#record('writer_unavailable', { candidateId: candidate.id, code, retryable, provider: this.writer?.status?.().provider || 'unknown' });
    await this.#record('content_rejected', { candidateId: candidate.id, errors: [reason] });
    if (options.readinessOnly) throw error;
    if (retryable) {
      await this.#queueCandidate(candidate, reason);
      return { status: 'queued', reason, candidateId: candidate.id };
    }
    return { status: 'content_skipped', reason, candidateId: candidate.id };
  }

  async #invalidateWriterReadiness(reason) {
    await this.stateStore.update((current) => ({
      ...current,
      autoReady: false,
      // A provider can reject or truncate one completion while the account,
      // publish credential, and explicit operator choice remain valid. Keep a
      // deliberate manual AUTO override armed so the next eligible candidate
      // can retry after the provider recovers.
      autoArmed: current.mode === 'AUTO' && current.autoArmed === true
        && current.manualAutoOverride === true && current.autoArm?.result === 'manual_override',
      manualAutoOverride: current.mode === 'AUTO' && current.autoArmed === true
        && current.manualAutoOverride === true && current.autoArm?.result === 'manual_override',
      autoArm: {
        pipelineFingerprint: current.autoArm?.pipelineFingerprint || null,
        writerFingerprint: current.autoArm?.writerFingerprint || this.#writerFingerprint(),
        verifiedAt: current.autoArm?.verifiedAt || null,
        result: current.autoArm?.result || null,
        reason,
      },
    }));
  }

  async #record(type, payload) {
    const event = createCryptoEvent(type, payload, {
      occurredAt: new Date(this.clock()).toISOString(),
      source: 'jarvis-crypto',
      threadId: this.cryptoThreadId,
    });
    if (this.eventStore) await this.eventStore.append(event);
    this.lastEvent = { type: event.type, occurredAt: event.occurredAt, payload: event.payload };
    this.events.emit('event', event);
    return event;
  }
}
