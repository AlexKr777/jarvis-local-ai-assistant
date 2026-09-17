import path from 'node:path';
import { loadCryptoConfig } from './config.js';
import { createPipelineFingerprint } from './pipeline-fingerprint.js';
import { CryptoRuntime } from './runtime.js';
import { CryptoStateStore } from './storage/state-store.js';
import { CryptoEventStore } from './storage/event-store.js';
import { BaselineSnapshotStore } from './storage/baseline-store.js';
import { BinancePublicClient } from './market/binance-public-client.js';
import { BinanceRestGovernor } from './market/binance-rest-governor.js';
import { BinanceStreamMonitor } from './market/stream-monitor.js';
import { RollingBaseline } from './market/rolling-baseline.js';
import { DeepMarketAnalyzer } from './market/deep-analyzer.js';
import { CryptoScannerController } from './market/scanner-controller.js';
import { OllamaCryptoWriter } from './content/ollama-writer.js';
import { AnyModelCryptoWriter } from './content/anymodel-writer.js';
import { OfficialContextResearch } from './content/official-context-research.js';
import { ResearchContextCollector } from './content/research-context.js';
import { renderCryptoChart } from './charts/chart-renderer.js';
import { SquarePublisher } from './publish/square-publisher.js';
import { runLivePublicDryRun } from './live-dry-run.js';
import { HistoricalReplayRunner, HISTORICAL_REPLAY_V2_REGRESSION_EVENTS } from './historical-replay.js';

export function createCryptoRuntime({ projectRoot, jarvis, dataDirectory = null } = {}) {
  const loadedConfig = loadCryptoConfig(process.env, projectRoot);
  // One-shot editorial reviews may use real exchange data while keeping their
  // duplicate history, previews and audit artefacts separate from the local
  // runtime. This never changes the requested mode or enables publishing.
  const config = dataDirectory ? Object.freeze({ ...loadedConfig, dataDirectory }) : loadedConfig;
  const pipelineFingerprint = createPipelineFingerprint({ projectRoot, config });
  const stateStore = new CryptoStateStore({ filePath: path.join(config.dataDirectory, 'state.json') });
  const eventStore = new CryptoEventStore({ directory: path.join(config.dataDirectory, 'events') });
  const baselineStore = new BaselineSnapshotStore({ filePath: path.join(config.dataDirectory, 'baselines.json') });
  const binanceRestGovernor = new BinanceRestGovernor({
    filePath: path.join(config.dataDirectory, 'binance-rest-state.json'),
    maxConcurrency: config.binanceRestMaxConcurrency,
    minIntervalMs: config.binanceRestMinIntervalMs,
    queueLimit: config.binanceRestQueueLimit,
    maxQueueAgeMs: config.binanceRestMaxQueueAgeMs,
  });
  const client = new BinancePublicClient({ baseUrl: config.restBaseUrl, governor: binanceRestGovernor });
  const baseline = new RollingBaseline({ windowMs: 24 * 60 * 60_000, maxSamples: 4_000 });
  const deepAnalyzer = new DeepMarketAnalyzer({ client: client.withCaller('deep_analysis') });
  let runtime;
  const streamMonitor = new BinanceStreamMonitor({
    onStatus: (status) => runtime?.updateBinanceStatus(status),
  });
  const scannerController = new CryptoScannerController({
    client: client.withCaller('scanner'),
    baseline,
    baselineStore,
    deepAnalyzer,
    streamMonitor,
    competitionWindowMs: config.competitionWindowMs,
    deepAnalysisConcurrency: config.deepAnalysisConcurrency,
    deepAnalysisPerSymbolCooldownMs: config.deepAnalysisPerSymbolCooldownMs,
    deepAnalysisQueueLimit: config.deepAnalysisQueueLimit,
    topRunnerMode: config.topRunnerMode,
    requireScoreForLiveRunner: config.requireScoreForLiveRunner,
    restGovernor: binanceRestGovernor,
    scannerIntervalMs: config.scannerIntervalMs,
    tierThresholds: config.tierThresholds,
    onStatus: (status) => runtime?.updateScannerStatus(status),
  });
  const writer = config.writerProvider === 'anymodel'
    ? new AnyModelCryptoWriter({
      apiKey: config.anymodelApiKey,
      baseUrl: config.anymodelBaseUrl,
      model: config.anymodelModel,
      diagnosticDirectory: path.join(config.dataDirectory, 'transport'),
      captureResponseDiagnostics: config.anymodelCaptureResponseDiagnostics,
    })
    : new OllamaCryptoWriter({ model: config.ollamaCryptoModel, baseUrl: config.ollamaBaseUrl });
  const researchProvider = new OfficialContextResearch();
  const researchCollector = new ResearchContextCollector({
    providers: [{
      name: 'binance_official',
      search: async ({ identity, occurredAt }) => {
        const result = await researchProvider.research({
          candidate: { symbol: identity.symbol, token: identity.baseAsset, cashtag: `$${identity.baseAsset}` },
          occurredAt,
          historical: false,
        });
        return (result.sources || []).map((source) => ({
          url: source.url,
          title: source.title,
          publishedAt: source.publishedAt,
          evidenceText: source.title,
        }));
      },
    }],
  });
  const publisher = new SquarePublisher({ stateStore, eventStore });
  runtime = new CryptoRuntime({
    config,
    pipelineFingerprint,
    stateStore,
    eventStore,
    jarvis,
    writer,
    researchProvider: (request) => researchProvider.research(request),
    researchCollector,
    researchPolicy: config.researchPolicy,
    chartRenderer: renderCryptoChart,
    publisher,
    scannerController,
    binanceRestGovernor,
    binanceRestProbeRunner: () => client.withCaller('operator_recovery_probe').getServerTime(),
    liveDryRunRunner: () => runLivePublicDryRun({
      client: client.withCaller('live_dry_run'),
      deepAnalyzer,
      // A controlled review handles exactly one fresh deterministic Top-10
      // candidate. It is isolated from production eligibility and remains
      // hard-pinned to DRY_RUN below regardless of persisted readiness state.
      maxCandidates: 1,
      executeCandidate: (candidate) => runtime.processCandidate(candidate, {
        modeOverride: 'DRY_RUN',
        bypassEligibility: true,
        readinessOnly: true,
      }),
    }),
    historicalReplayRunner: (options) => new HistoricalReplayRunner({
      client: client.withCaller('historical_replay'),
      writer,
      chartRenderer: renderCryptoChart,
      dataDirectory: config.dataDirectory,
    }).run(options?.regressionSet ? { ...options, events: HISTORICAL_REPLAY_V2_REGRESSION_EVENTS } : options),
  });
  binanceRestGovernor.onDiagnostic = (diagnostic) => runtime?.recordBinanceRestDiagnostic(diagnostic);
  return runtime;
}
