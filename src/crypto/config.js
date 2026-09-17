import path from 'node:path';

export const CRYPTO_MODES = Object.freeze(['OFF', 'DRY_RUN', 'AUTO']);

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function boolean(value, fallback) {
  if (value === undefined) return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase());
}

export function loadCryptoConfig(env = process.env, projectRoot = process.cwd()) {
  const requestedMode = String(env.JARVIS_CRYPTO_MODE || 'DRY_RUN').toUpperCase();
  const requestedWriterProvider = String(env.JARVIS_CRYPTO_WRITER_PROVIDER || 'ollama').trim().toLowerCase();
  const tierS = integer(env.JARVIS_CRYPTO_TIER_S, 92, 85, 100);
  const tierA = integer(env.JARVIS_CRYPTO_TIER_A, 82, 70, tierS - 1);
  const tierB = integer(env.JARVIS_CRYPTO_TIER_B, 72, 60, tierA - 1);
  return Object.freeze({
    mode: CRYPTO_MODES.includes(requestedMode) ? requestedMode : 'DRY_RUN',
    writerProvider: ['ollama', 'anymodel'].includes(requestedWriterProvider) ? requestedWriterProvider : 'ollama',
    ollamaCryptoModel: String(env.CRYPTO_WRITER_MODEL || 'gemma4:12b-it-q4_K_M').trim() || 'gemma4:12b-it-q4_K_M',
    ollamaBaseUrl: String(env.CRYPTO_WRITER_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '') || 'http://127.0.0.1:11434',
    anymodelApiKey: String(env.ANYMODEL_API_KEY || '').trim(),
    anymodelBaseUrl: String(env.JARVIS_CRYPTO_ANYMODEL_BASE_URL || 'https://anymodel.org/v1').trim().replace(/\/+$/, '') || 'https://anymodel.org/v1',
    anymodelModel: String(env.JARVIS_CRYPTO_ANYMODEL_MODEL || 'kmc/k3').trim() || 'kmc/k3',
    // Disabled by default. It captures only sanitized provider responses for a
    // one-off DRY_RUN transport diagnosis; request bodies and credentials stay out.
    anymodelCaptureResponseDiagnostics: boolean(env.JARVIS_CRYPTO_CAPTURE_ANYMODEL_RESPONSE, false),
    scannerEnabled: boolean(env.JARVIS_CRYPTO_SCANNER_ENABLED, true),
    // Runner mode ranks only the current top ten positive 24-hour movers.  The
    // old anomaly score is still recorded for diagnostics, but never decides publication.
    topRunnerMode: boolean(env.JARVIS_CRYPTO_TOP_RUNNER_MODE, true),
    requireScoreForLiveRunner: boolean(env.JARVIS_CRYPTO_REQUIRE_SCORE_FOR_LIVE_RUNNER, false),
    maxPosts24h: integer(env.JARVIS_CRYPTO_MAX_POSTS_24H, 10, 1, 10),
    competitionWindowMs: integer(env.JARVIS_CRYPTO_COMPETITION_WINDOW_MS, 0, 0, 30 * 60_000),
    deepAnalysisConcurrency: integer(env.JARVIS_CRYPTO_DEEP_ANALYSIS_CONCURRENCY, 2, 1, 4),
    deepAnalysisPerSymbolCooldownMs: integer(env.JARVIS_CRYPTO_DEEP_ANALYSIS_PER_SYMBOL_COOLDOWN_MS, 60_000, 30_000, 60 * 60_000),
    deepAnalysisQueueLimit: integer(env.JARVIS_CRYPTO_DEEP_ANALYSIS_QUEUE_LIMIT, 1, 1, 24),
    binanceRestMaxConcurrency: integer(env.BINANCE_REST_MAX_CONCURRENCY, 1, 1, 2),
    binanceRestMinIntervalMs: integer(env.BINANCE_REST_MIN_INTERVAL_MS, 750, 250, 10_000),
    binanceRestQueueLimit: integer(env.BINANCE_REST_QUEUE_LIMIT, 24, 4, 100),
    binanceRestMaxQueueAgeMs: integer(env.BINANCE_REST_MAX_QUEUE_AGE_MS, 30_000, 1_000, 10 * 60_000),
    scannerIntervalMs: integer(env.JARVIS_CRYPTO_SCANNER_INTERVAL_MS, 60_000, 15_000, 5 * 60_000),
    tierThresholds: Object.freeze({
      S: tierS,
      A: tierA,
      B: tierB,
    }),
    researchPolicy: Object.freeze({
      extreme24hPct: integer(env.JARVIS_CRYPTO_RESEARCH_EXTREME_24H_PCT, 20, 5, 100),
      extreme4hPct: integer(env.JARVIS_CRYPTO_RESEARCH_EXTREME_4H_PCT, 12, 3, 50),
      extremeHumanShock: integer(env.JARVIS_CRYPTO_RESEARCH_EXTREME_HUMAN_SHOCK, 8, 2, 30),
      extremeRelativeShock: integer(env.JARVIS_CRYPTO_RESEARCH_EXTREME_RELATIVE_SHOCK, 8, 2, 30),
    }),
    dataDirectory: path.join(projectRoot, 'data', 'crypto'),
    restBaseUrl: 'https://fapi.binance.com',
    publicStreamBaseUrl: 'wss://fstream.binance.com/public/stream',
    marketStreamBaseUrl: 'wss://fstream.binance.com/market/stream',
  });
}
