import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { startupErrorMessage } from '../src/server.js';

test('explains a busy local port in plain Russian', () => {
  assert.equal(
    startupErrorMessage({ code: 'EADDRINUSE' }),
    'JARVIS не запущен: порт 3210 уже занят. Закройте другое окно JARVIS и повторите запуск.',
  );
});

test('redacts unexpected startup failures', () => {
  const message = startupErrorMessage(new Error('C:\\Users\\secret\\token.txt'));
  assert.equal(message, 'JARVIS не удалось запустить. Подробности сохранены в локальном журнале.');
  assert.equal(message.includes('secret'), false);
});

test('STOP_JARVIS delegates shutdown to the single-instance Windows host without process matching', async () => {
  const script = await readFile(new URL('../STOP_JARVIS.bat', import.meta.url), 'utf8');
  assert.match(script, /JarvisVoiceHost\.exe" --stop/i);
  assert.doesNotMatch(script, /Stop-Process|taskkill|src[\\/]server\.js/i);
});
