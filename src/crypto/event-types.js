import { randomUUID } from 'node:crypto';

export const CRYPTO_EVENT_TYPES = Object.freeze([
  'scanner_started',
  'scanner_stopped',
  'universe_updated',
  'anomaly_detected',
  'deep_analysis_started',
  'deep_analysis_completed',
  'candidate_selected',
  'candidate_rejected',
  'fact_pack_built',
  'review_package_written',
  'writer_started',
  'writer_completed',
  'writer_unavailable',
  // Retained solely to read historical event files written before the writer migration.
  'codex_started',
  'codex_completed',
  'content_rejected',
  'chart_rendered',
  'publish_intent',
  'publish_completed',
  'publish_failed',
  'publish_failed_upload_recovered',
  'publish_failed_upload_resolved',
  'outcome_measured',
  'mode_changed',
  'post_limit_reset',
  'runtime_error',
  'storage_corruption_detected',
  'recovery_blocked',
  'candidate_queued',
  'candidate_dequeued',
  'publish_unknown',
  'post_preview_ready',
  'publication_result',
  'binance_rest_state_changed',
]);

export function createCryptoEvent(type, payload, options = {}) {
  if (!CRYPTO_EVENT_TYPES.includes(type)) {
    throw new TypeError(`Unsupported crypto event type: ${type}`);
  }
  return Object.freeze({
    eventId: options.eventId || randomUUID(),
    type,
    occurredAt: options.occurredAt || new Date().toISOString(),
    source: options.source || 'jarvis-crypto',
    schemaVersion: 1,
    ...(typeof options.threadId === 'string' && options.threadId ? { threadId: options.threadId } : {}),
    payload: payload && typeof payload === 'object' ? payload : {},
  });
}
