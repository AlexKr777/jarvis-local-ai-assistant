import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVoiceDisplay, compactVoiceAnswer } from '../src/voice-display.js';

test('keeps a short final answer intact and never launches a second summarization pass', () => {
  assert.deepEqual(compactVoiceAnswer('Сейчас в Кишинёве около +18 °C, облачно.'), {
    text: 'Сейчас в Кишинёве около +18 °C, облачно.',
    truncated: false,
  });
});

test('compacts long markdown deterministically while preserving the full answer outside the display payload', () => {
  const full = `## Коротко\n\n${'Погода переменная, возможен дождь около 18:00. '.repeat(20)}\n\nИсточник: example.com`;
  const display = compactVoiceAnswer(full);

  assert.ok(display.text.length <= 320);
  assert.equal(display.text.includes('примерно'), false);
  assert.equal(display.truncated, true);
  assert.equal(Object.hasOwn(display, 'fullText'), false);
});

test('routes real web results as answers and real file changes as compact action success', () => {
  assert.equal(buildVoiceDisplay({
    requestId: 'voice-1',
    answer: 'Сейчас +18 °C, облачно.',
    activities: [{ category: 'web', state: 'complete' }],
  }).type, 'answer');

  assert.equal(buildVoiceDisplay({
    requestId: 'voice-2',
    answer: 'Папка «Архив» создана.',
    activities: [{ category: 'file', state: 'complete' }],
  }).type, 'action-success');

  assert.equal(buildVoiceDisplay({
    requestId: 'voice-3',
    transcript: 'Открой Spotify',
    answer: 'Spotify открыт.',
    activities: [{ category: 'command', state: 'complete' }],
  }).type, 'action-success');
});

test('uses truthful error/auth/queue states without exposing secrets', () => {
  assert.deepEqual(buildVoiceDisplay({ requestId: 'voice-3', state: 'queued' }), {
    requestId: 'voice-3', type: 'queued', text: 'В очереди', truncated: false,
  });
  assert.deepEqual(buildVoiceDisplay({ requestId: 'voice-4', state: 'auth-required' }), {
    requestId: 'voice-4', type: 'auth-required', text: 'Требуется вход в Codex', truncated: false,
  });
});
