import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PIPELINE_SCHEMA_VERSION = 7;

export const PIPELINE_FILES = Object.freeze([
  'src/app-server-client.js',
  'src/jarvis-session.js',
  'src/crypto/runtime.js',
  'src/crypto/create-runtime.js',
  'src/crypto/live-dry-run.js',
  'src/crypto/market/scanner-controller.js',
  'src/crypto/market/binance-public-client.js',
  'src/crypto/market/binance-rest-governor.js',
  'src/crypto/market/market-scanner.js',
  'src/crypto/market/deep-analyzer.js',
  'src/crypto/market/token-identity.js',
  'src/crypto/scoring/anomaly-score.js',
  'src/crypto/scoring/candidate-pool.js',
  'src/crypto/content/ollama-writer.js',
  'src/crypto/content/anymodel-writer.js',
  'src/crypto/content/editorial-engine.js',
  'src/crypto/content/content-validator.js',
  'src/crypto/content/public-text-format.js',
  'src/crypto/content/fact-pack.js',
  'src/crypto/content/v5-editorial-pipeline.js',
  'src/crypto/content/research-policy.js',
  'src/crypto/content/official-context-research.js',
  'src/crypto/charts/chart-renderer.js',
  'src/crypto/publish/square-publisher.js',
  'docs/crypto/playbook-core.md',
]);

function fileDigest(projectRoot, relativePath) {
  try {
    return createHash('sha256').update(readFileSync(path.join(projectRoot, relativePath))).digest('hex');
  } catch {
    return 'missing';
  }
}

export function createPipelineFingerprint({ projectRoot = process.cwd(), config = {} } = {}) {
  const relevantConfig = {
    maxPosts24h: config.maxPosts24h,
    topRunnerMode: config.topRunnerMode,
    requireScoreForLiveRunner: config.requireScoreForLiveRunner,
    competitionWindowMs: config.competitionWindowMs,
    deepAnalysisConcurrency: config.deepAnalysisConcurrency,
    deepAnalysisPerSymbolCooldownMs: config.deepAnalysisPerSymbolCooldownMs,
    deepAnalysisQueueLimit: config.deepAnalysisQueueLimit,
    binanceRestMaxConcurrency: config.binanceRestMaxConcurrency,
    binanceRestMinIntervalMs: config.binanceRestMinIntervalMs,
    binanceRestQueueLimit: config.binanceRestQueueLimit,
    binanceRestMaxQueueAgeMs: config.binanceRestMaxQueueAgeMs,
    scannerIntervalMs: config.scannerIntervalMs,
    tierThresholds: config.tierThresholds,
    writerProvider: config.writerProvider,
    ollamaCryptoModel: config.ollamaCryptoModel,
    ollamaBaseUrl: config.ollamaBaseUrl,
    anymodelBaseUrl: config.anymodelBaseUrl,
    anymodelModel: config.anymodelModel,
  };
  const manifest = {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    config: relevantConfig,
    files: Object.fromEntries(PIPELINE_FILES.map((relativePath) => [relativePath, fileDigest(projectRoot, relativePath)])),
  };
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export { PIPELINE_SCHEMA_VERSION };
