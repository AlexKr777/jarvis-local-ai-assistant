import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(import.meta.dirname, '..');

test('voice benchmark template defines a balanced 20-phrase human PTT corpus', async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'data', 'voice-benchmark', 'corpus.json'), 'utf8'));
  assert.equal(manifest.samples.length, 20);
  assert.equal(manifest.samples.filter(({ language }) => language === 'ru').length, 10);
  assert.equal(manifest.samples.filter(({ language }) => language === 'en').length, 10);
  assert.equal(manifest.samples.every(({ source }) => source === 'human-microphone'), true);
  assert.equal(new Set(manifest.samples.map(({ id }) => id)).size, 20);
});

test('voice benchmark fails closed instead of inventing results when recordings are absent', () => {
  const result = spawnSync(
    path.join(projectRoot, '.venv', 'Scripts', 'python.exe'),
    [path.join(projectRoot, 'speech', 'benchmark.py'), '--manifest', path.join(projectRoot, 'data', 'voice-benchmark', 'corpus.json'), '--validate-only'],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /20 real human WAV recordings are required/i);
  assert.equal(result.stdout, '');
});

test('benchmark intent scoring does not confuse weather with Russian approval yes', () => {
  const result = spawnSync(
    path.join(projectRoot, '.venv', 'Scripts', 'python.exe'),
    ['-c', 'from speech.benchmark import detect_intent; print(detect_intent("какая погода сегодня")); print(detect_intent("да подтверждаю"))'],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['weather', 'approval-accept']);
});
