import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCryptoRuntime } from './create-runtime.js';

const projectRoot = process.cwd();
const dataDirectory = path.join(projectRoot, 'data', 'crypto', 'controlled-dry-run');
const outputPath = path.join(dataDirectory, 'result.json');
const runtime = createCryptoRuntime({ projectRoot, dataDirectory });
// Binance governor delays are intentionally unref'ed in the app so they do
// not prevent normal shutdown. A one-shot CLI must keep its own event loop
// alive while awaiting that same governed request.
const keepAlive = setInterval(() => {}, 1_000);

let result;
try {
  await runtime.initialize({ startScanner: false });
  await runtime.setMode('DRY_RUN');
  const before = await runtime.status();
  const dryRun = await runtime.runLiveDryRun();
  const after = await runtime.status();
  result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    modeBefore: before.mode,
    modeAfter: after.mode,
    safety: {
      autoArmed: after.autoArmed === true,
      autoReady: after.autoReady === true,
      scanner: after.scanner,
      noPublishing: dryRun?.checks?.noPublishing === true,
    },
    dryRun,
    lastPreview: after.lastPreview || null,
  };
} catch (error) {
  result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    error: { code: String(error?.code || 'CONTROLLED_DRY_RUN_FAILED').slice(0, 80) },
  };
} finally {
  await runtime.stop();
  clearInterval(keepAlive);
}

await mkdir(dataDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`${JSON.stringify({ outputPath, ok: !result.error, safety: result.safety || null })}\n`);
