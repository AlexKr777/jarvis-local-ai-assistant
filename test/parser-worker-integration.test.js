import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

test('isolated Parser worker answers status and performs a graceful shutdown', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-parser-worker-'));
  const projectRoot = process.cwd();
  const child = spawn(
    path.join(projectRoot, '.venv', 'Scripts', 'python.exe'),
    ['-u', path.join(projectRoot, 'parser_worker', 'worker.py'), '--data-dir', dataDir],
    { cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1' } },
  );
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', (line) => responses.push(JSON.parse(line)));

  const waitFor = async (id) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const found = responses.find((response) => response.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Worker did not answer ${id}`);
  };

  try {
    child.stdin.write(`${JSON.stringify({ id: 'status-1', method: 'status', params: {} })}\n`);
    const status = await waitFor('status-1');
    assert.equal(status.ok, true);
    assert.equal(status.result.worker, 'RUNNING');
    assert.ok(['SETUP_REQUIRED', 'STOPPED'].includes(status.result.state));
    assert.doesNotMatch(JSON.stringify(status), /accessHash|telegram_session|bot_token/);

    child.stdin.write(`${JSON.stringify({ id: 'shutdown-1', method: 'shutdown', params: {} })}\n`);
    assert.equal((await waitFor('shutdown-1')).ok, true);
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill();
    lines.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
