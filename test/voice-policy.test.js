import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyConcreteAction,
  classifyVoiceIntent,
  normalizeConfirmation,
} from '../src/voice-policy.js';

test('hard-blocks disk, partition, boot, and core Windows destruction with no override', () => {
  const samples = [
    'Отформатируй диск C:',
    'запусти diskpart и выполни clean disk 0',
    'Clear-Disk -Number 0 -RemoveData',
    'Remove-Partition -DiskNumber 0 -PartitionNumber 1',
    'bcdedit /delete {current}',
    'Remove-Item -Recurse -Force C:\\Windows\\System32',
  ];

  for (const value of samples) {
    const result = classifyVoiceIntent(value, { cwd: 'C:\\Users\\user' });
    assert.equal(result.level, 'hard-block', value);
    assert.equal(result.overrideAllowed, false, value);
  }
});

test('requires approval for ordinary deletes and extracts one normalized exact target', () => {
  const result = classifyConcreteAction({
    command: 'Remove-Item -LiteralPath ".\\notes.txt"',
    cwd: 'C:\\Users\\user\\Desktop',
  });

  assert.equal(result.level, 'approval');
  assert.deepEqual(result.targets, ['C:\\Users\\user\\Desktop\\notes.txt']);
  assert.equal(result.overrideAllowed, true);
});

test('keeps ordinary safe commands automatic and does not confuse UI cleanup with disk cleanup', () => {
  assert.equal(classifyConcreteAction({ command: 'New-Item -ItemType Directory demo', cwd: 'C:\\work' }).level, 'auto');
  assert.equal(classifyVoiceIntent('Очисти список Activity').level, 'auto');
  assert.equal(classifyVoiceIntent('Открой папку Downloads').level, 'auto');
});

test('accepts the approved Russian and English yes/no confirmation phrases', () => {
  for (const value of [
    'да', 'да подтверждаю', 'да, подтверждаю', 'ага', 'окей', 'ок', 'разрешаю', 'давай', 'делай', 'выполняй', 'yes', 'confirm',
  ]) assert.equal(normalizeConfirmation(value), 'accept', value);
  for (const value of [
    'нет', 'отмена', 'отмени', 'не надо', 'не делай', 'запрещаю', 'no', 'cancel',
  ]) assert.equal(normalizeConfirmation(value), 'decline', value);
  for (const value of ['да и открой браузер', 'удали файл', '', 'может быть']) assert.equal(normalizeConfirmation(value), null);
});
