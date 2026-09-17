import { randomUUID } from 'node:crypto';
import { createCryptoEvent } from '../event-types.js';

const MIN_POST_SPACING_MS = 40 * 60_000;
const MAX_POST_SPACING_MS = 40 * 60_000;
const SQUARE_PARAGRAPH_SEPARATOR = '\n\u200B\n';

export function formatSquarePostText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n(?:[\t \u200B]*\n)+/g, SQUARE_PARAGRAPH_SEPARATOR)
    .trim();
}

function publicationSpacingMs(random) {
  const value = Number(random());
  const bounded = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
  return MIN_POST_SPACING_MS + Math.round((MAX_POST_SPACING_MS - MIN_POST_SPACING_MS) * bounded);
}

async function loadOfficialAdapter() {
  return import('../../../vendor/binance-skills-hub-upstream/skills/binance/square-post/scripts/lib.mjs');
}

function publicResult(result) {
  const unknown = result?.publishStatus === 'success_without_post_id' || (!result?.id && !result?.shareLink);
  return {
    status: unknown ? 'UNKNOWN' : 'PUBLISHED',
    published: !unknown,
    id: result?.id ?? null,
    shareLink: result?.shareLink ?? null,
  };
}

export class SquarePublisher {
  constructor({ stateStore, eventStore = null, adapter = null, now = () => Date.now(), random = Math.random } = {}) {
    this.stateStore = stateStore;
    this.eventStore = eventStore;
    this.adapter = adapter;
    this.now = now;
    this.random = random;
  }

  async credentialStatus() {
    try {
      const adapter = await this.#adapter();
      const key = adapter.resolveApiKey([]);
      return { configured: Boolean(key), source: process.env.BINANCE_SQUARE_OPENAPI_KEY?.trim() ? 'environment' : 'saved_file' };
    } catch {
      return { configured: false, source: null };
    }
  }

  async publishPackage({ mode, content, candidate, validation, chartPath }) {
    if (mode === 'OFF') return { status: 'off', published: false };
    if (!validation?.ok) throw new Error('Square publishing requires validated content.');
    if (mode === 'DRY_RUN') {
      return { status: 'preview', published: false, preview: { postText: content.postText, chartPath } };
    }
    if (mode !== 'AUTO') throw new Error('Unsupported Crypto runtime mode.');
    const state = await this.stateStore.load();
    if (!state.autoArmed || (!state.autoReady && state.manualAutoOverride !== true)) throw new Error('AUTO is not armed until a current successful DRY_RUN.');
    if (state.pendingPublish) throw new Error('AUTO is blocked by an unresolved publish lifecycle.');

    const adapter = await this.#adapter();
    let apiKey;
    try {
      apiKey = adapter.resolveApiKey([]);
    } catch {
      throw new Error('Binance Square credential is unavailable.');
    }
    const preparedAt = this.now();
    const intent = {
      id: randomUUID(),
      status: 'CREATED',
      stage: 'PREPARED',
      candidateId: candidate.id,
      token: candidate.token,
      fingerprint: validation.fingerprint,
      chartPath,
      preparedAt,
    };
    await this.stateStore.update((current) => ({ ...current, pendingPublish: intent }));
    await this.#event('publish_intent', { intentId: intent.id, candidateId: candidate.id, token: candidate.token });

    let stage = 'UPLOAD';
    try {
      await this.stateStore.update((current) => ({
        ...current,
        pendingPublish: { ...intent, status: 'PUBLISHING', stage, publishingAt: this.now() },
      }));
      const imageUrl = await adapter.uploadImage(apiKey, chartPath);
      stage = 'PUBLISH';
      await this.stateStore.update((current) => ({
        ...current,
        pendingPublish: { ...intent, status: 'PUBLISHING', stage, imageUploadedAt: this.now() },
      }));
      const result = await adapter.publish(apiKey, {
        contentType: 1,
        bodyTextOnly: formatSquarePostText(content.postText),
        imageList: [imageUrl],
      });
      const published = publicResult(result);
      const publicationCooldownMs = publicationSpacingMs(this.random);
      await this.stateStore.update((current) => ({
        ...current,
        pendingPublish: published.status === 'UNKNOWN'
          ? { ...intent, status: 'UNKNOWN', stage, unknownAt: this.now() }
          : null,
        posts: [
          ...(current.posts || []),
          {
            token: candidate.token,
            symbol: candidate.symbol,
            candidateId: candidate.id,
            fingerprint: validation.fingerprint,
            hookFamily: validation.hookFamily,
            openingFingerprint: validation.openingFingerprint,
            entryPrice: Number.isFinite(Number(candidate?.metrics?.close)) ? Number(candidate.metrics.close) : null,
            publicationSequence: Number.isInteger(candidate?.publicationSequence) ? candidate.publicationSequence : 1,
            publishedAt: preparedAt,
            publicationCooldownMs,
            nextEligibleAt: preparedAt + publicationCooldownMs,
            squareId: published.id,
            shareLink: published.shareLink,
            status: published.status,
          },
        ],
        fingerprints: [...new Set([...(current.fingerprints || []), validation.fingerprint])].slice(-500),
      }));
      await this.#event(published.status === 'UNKNOWN' ? 'publish_unknown' : 'publish_completed', {
        intentId: intent.id,
        candidateId: candidate.id,
        status: published.status,
        id: published.id,
      });
      return published;
    } catch {
      const status = stage === 'UPLOAD' ? 'FAILED_UPLOAD' : 'UNKNOWN';
      await this.stateStore.update((current) => ({
        ...current,
        pendingPublish: {
          ...intent,
          status,
          stage,
          failureCode: status === 'FAILED_UPLOAD' ? 'UPLOAD_FAILED' : 'PUBLISH_OUTCOME_UNKNOWN',
          failedAt: this.now(),
        },
      }));
      await this.#event(status === 'UNKNOWN' ? 'publish_unknown' : 'publish_failed', { intentId: intent.id, candidateId: candidate.id, status });
      throw new Error('Square publish state requires manual review and no automatic retry was attempted.');
    }
  }

  async recoverPending() {
    const pending = (await this.stateStore.load()).pendingPublish;
    if (!pending) return { status: 'clean' };
    if (pending.status === 'FAILED_UPLOAD' && pending.stage === 'UPLOAD') {
      await this.stateStore.update((current) => ({ ...current, pendingPublish: null }));
      await this.#event('publish_failed_upload_recovered', { intentId: pending.id, candidateId: pending.candidateId });
      return { status: 'recovered_failed_upload', intentId: pending.id };
    }
    const status = pending.status === 'FAILED' ? 'FAILED' : 'UNKNOWN';
    if (pending.status !== status) {
      await this.stateStore.update((current) => ({
        ...current,
        pendingPublish: { ...pending, status, recoveredAt: this.now() },
      }));
    }
    return { status, intentId: pending.id };
  }

  async resolveFailedUpload({ intentId } = {}) {
    let resolved = null;
    await this.stateStore.update((current) => {
      const pending = current.pendingPublish;
      const isNamedFailure = pending?.id === intentId
        && (pending.status === 'FAILED' || (pending.status === 'FAILED_UPLOAD' && pending.stage === 'UPLOAD'));
      if (!isNamedFailure) return current;
      resolved = pending;
      return { ...current, pendingPublish: null };
    });
    if (!resolved) throw new Error('Only an upload failure with the matching intent can be released; unknown publication outcomes stay blocked.');
    await this.#event('publish_failed_upload_resolved', { intentId: resolved.id, candidateId: resolved.candidateId });
    return { status: 'resolved_failed_upload', intentId: resolved.id };
  }

  async #adapter() {
    if (!this.adapter) this.adapter = await loadOfficialAdapter();
    return this.adapter;
  }

  async #event(type, payload) {
    if (!this.eventStore) return;
    await this.eventStore.append(createCryptoEvent(type, payload, { occurredAt: new Date(this.now()).toISOString(), source: 'binance-square' }));
  }
}
