import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createApi } from '../public/api.js';
import {
  cryptoActivityLabel,
  cryptoMessageView,
  cryptoStatusLabel,
  cryptoTimelineEntry,
  meaningfulCryptoEvents,
  publicCryptoMessage,
} from '../public/crypto-ui.js';

test('Crypto is pinned below New Chat and its controls live inside the conversation', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['crypto-open', 'crypto-status', 'crypto-context', 'crypto-mode', 'crypto-enable-auto', 'crypto-dry-run', 'crypto-reset-post-limit', 'crypto-slots', 'crypto-credential', 'crypto-event-stream', 'crypto-side-event-stream']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
  }
  assert.ok(html.indexOf('id="new-chat"') < html.indexOf('id="crypto-open"'));
  assert.ok(html.indexOf('id="crypto-open"') < html.indexOf('class="conversation-nav"'));
  assert.ok(html.indexOf('id="chat"') < html.indexOf('id="crypto-context"'));
  assert.doesNotMatch(html, /class="crypto-section"/);
  assert.equal((html.match(/data-crypto-mode=/g) || []).length, 3);
  assert.match(html, /aria-label="Crypto publishing mode"/);
  assert.doesNotMatch(html, /OPENAI_API_KEY|api\.openai\.com/i);
});

test('browser API exposes only local crypto routes', async () => {
  const calls = [];
  const api = createApi({ fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, text: async () => '{}' };
  }, EventSourceImpl: class {} });
  await api.cryptoStatus();
  await api.setCryptoMode('OFF');
  await api.runCryptoDryRun();
  await api.confirmCryptoAuto(true);
  await api.resetCryptoPostLimit();
  assert.deepEqual(calls.map((call) => [call.url, call.options.method || 'GET']), [
    ['/api/crypto/status', 'GET'],
    ['/api/crypto/mode', 'POST'],
    ['/api/crypto/dry-run', 'POST'],
    ['/api/crypto/confirm-auto', 'POST'],
    ['/api/crypto/reset-post-limit', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls.at(-2).options.body), { force: true });
  assert.doesNotMatch(JSON.stringify(calls), /api\.openai\.com|OPENAI_API_KEY/);
});

test('crypto UI helpers stay calm, public, and strip structured automation envelopes', () => {
  assert.equal(cryptoStatusLabel({ scanner: 'running', mode: 'DRY_RUN', autoReady: true }), 'Dry run verified');
  assert.equal(cryptoStatusLabel({ scanner: 'running', mode: 'AUTO', autoArmed: false }), 'AUTO: OFF · 0/10');
  assert.equal(cryptoStatusLabel({ recovery: { status: 'blocked' } }), 'Recovery blocked');
  assert.equal(cryptoStatusLabel({ scanner: 'running', binanceStatus: { state: 'reconnecting' } }), 'Binance reconnecting');
  assert.equal(cryptoActivityLabel({ eventType: 'candidate_selected', payload: { symbol: 'BTCUSDT' } }), '🧠 Анализ — BTC · Ищу лучший угол для поста.');
  assert.equal(publicCryptoMessage('{"decision":"publish","postText":"$BTC factual public copy","reason":"ok"}'), '$BTC factual public copy');
  assert.equal(publicCryptoMessage('{"decision":"skip","reason":"not_distinctive"}'), 'Пост пропущен.');
  assert.equal(publicCryptoMessage('ordinary assistant answer'), 'ordinary assistant answer');

  assert.deepEqual(cryptoMessageView('{"decision":"publish","postText":"$BTC factual public copy","reason":"distinctive","visualIntent":{"preset":"volume_shock"}}'), {
    kind: 'publish',
    text: '$BTC factual public copy',
    reason: 'distinctive',
    preset: 'volume_shock',
  });
  assert.deepEqual(meaningfulCryptoEvents([
    { eventType: 'universe_updated', occurredAt: '1', payload: {} },
    { eventType: 'anomaly_detected', occurredAt: '2', payload: { score: 65 } },
    { eventType: 'candidate_selected', occurredAt: '3', payload: { symbol: 'BTCUSDT' } },
    { eventType: 'candidate_selected', occurredAt: '3', payload: { symbol: 'BTCUSDT' } },
    { eventType: 'publish_completed', occurredAt: '4', payload: { symbol: 'BTCUSDT' } },
  ]).map((event) => event.eventType), ['anomaly_detected', 'candidate_selected', 'publish_completed']);
});

test('Crypto timeline is timestamped, human-readable, and keeps selector JSON out of the main feed', () => {
  const entry = cryptoTimelineEntry({ eventType: 'post_preview_ready', occurredAt: '2026-08-25T19:20:18.000Z', payload: { symbol: 'ENAUSDT', postText: '$ENA is moving.' } });
  assert.match(entry.time, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(entry.title, '✍️ Пост готов — ENA');
  assert.equal(entry.detail, '$ENA is moving.');
  const view = cryptoMessageView('{"candidateId":"x","scores":{"readerReward":9},"strongestLine":"internal"}');
  assert.equal(view.kind, 'technical');
  assert.equal(view.text, '');
});

test('Crypto UI exposes concise local Gemma writer progress and unavailable state', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<dt>Writer<\/dt><dd id="crypto-ai">/);
  assert.match(html, /<dt>Ollama<\/dt><dd id="crypto-ollama">/);
  const writing = cryptoTimelineEntry({ eventType: 'writer_started', occurredAt: '2026-08-27T19:20:18.000Z', payload: { symbol: 'ENAUSDT' } });
  assert.equal(writing.title, '✍️ Gemma пишет — ENA');
  const unavailable = cryptoTimelineEntry({ eventType: 'writer_unavailable', occurredAt: '2026-08-27T19:20:18.000Z', payload: { code: 'OLLAMA_UNAVAILABLE' } });
  assert.equal(unavailable.title, '⚠️ Local Writer unavailable');
  assert.equal(unavailable.detail, 'Gemma/Ollama is not running.');
});

test('Crypto styling remains flat, restrained, reduced-motion safe and focus-visible', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.crypto-nav-item/);
  assert.match(css, /\.crypto-context/);
  assert.match(css, /\.chat-content\.crypto-active/);
  assert.match(css, /position:\s*fixed/);
  assert.match(css, /\.crypto-mode-button:focus-visible/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.crypto-context/);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\s*\(/i);
});

test('Crypto status and lifecycle labels make AUTO and publication outcomes readable', () => {
  assert.equal(cryptoStatusLabel({ scanner: 'running', mode: 'AUTO', autoArmed: false, posts24h: 3, maxPosts24h: 10 }), 'AUTO: OFF · 3/10');
  assert.equal(cryptoStatusLabel({ scanner: 'running', mode: 'AUTO', autoArmed: true, posts24h: 3, maxPosts24h: 10 }), 'AUTO: ON · 3/10');
  assert.equal(cryptoActivityLabel({ eventType: 'publish_completed', payload: { symbol: 'BTCUSDT', posts24h: 3, maxPosts24h: 10 } }), '✅ Опубликовано — BTC · Пост 3/10 за последние 24ч.');
  assert.equal(cryptoActivityLabel({ eventType: 'candidate_rejected', payload: { symbol: 'XRPUSDT', reason: 'MARKET_STORY_DUPLICATE' } }), '⏭ Пропущено — XRP · Похожая история недавно уже публиковалась.');
});

test('app imports the Crypto adapter and handles typed crypto activity without rebuilding chat', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /import\('\.\/crypto-ui\.js'\)/);
  assert.match(app, /event\.type === 'crypto-activity'/);
  assert.match(app, /api\.cryptoStatus\(\)/);
  assert.match(app, /api\.confirmCryptoAuto\(/);
  assert.match(app, /Включить AUTO всё равно\?/);
  assert.match(app, /AUTO: \$\{cryptoStatus\.autoArmed \? 'ON' : 'OFF'\}/);
  assert.match(app, /chatContent\.classList\.toggle\('crypto-active'/);
  assert.match(app, /cryptoTimelineEntry\(event\)\.title !== 'Crypto update'/);
  assert.match(app, /controller\.selectThread\(cryptoStatus\.threadId\)/);
  assert.match(app, /excludedThreadIds/);
  assert.match(app, /controller\.reloadThread/);
});
