import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

import { createJarvisHttpServer } from '../src/server.js';
import { JarvisSession } from '../src/jarvis-session.js';
import { extractLocalPath, normalizeActivityState, recentActivities } from '../public/chat-view.js';

const THREAD_ID = '0191f47a-0e6c-7d6a-b5cb-953c58db5f68';
const OTHER_THREAD_ID = '0191f47a-0e6c-7d6a-b5cb-953c58db5f69';
const ATTACHMENT_ID = '550e8400-e29b-41d4-a716-446655440000';
const QUEUE_ID = '650e8400-e29b-41d4-a716-446655440000';
const VOICE_THREAD_ID = '0191f47a-0e6c-7d6a-b5cb-953c58db5f70';
const CRYPTO_THREAD_ID = '0191f47a-0e6c-7d6a-b5cb-953c58db5f71';
const NEW_THREAD_ID = '0191f47a-0e6c-7d6a-b5cb-953c58db5f72';

class FakeJarvis {
  constructor() {
    this.calls = [];
    this.activeThreadId = THREAD_ID;
    this.listener = null;
    this.deleteFailure = null;
  }

  status(threadId) {
    this.calls.push(['status', threadId]);
    return { state: 'ready', detail: 'JARVIS готов.' };
  }

  subscribe(listener) {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  async listThreads(options) {
    this.calls.push(['listThreads', options]);
    return { data: [{ id: THREAD_ID, name: 'Первый чат' }], nextCursor: null };
  }

  async createThread() {
    this.calls.push(['createThread']);
    this.activeThreadId = THREAD_ID;
    return { id: THREAD_ID, messages: [], queue: [] };
  }

  async readThread(threadId) {
    this.calls.push(['readThread', threadId]);
    return { id: threadId, messages: [] };
  }

  async resumeThread(threadId) {
    this.calls.push(['resumeThread', threadId]);
    return { id: threadId, resumed: true };
  }

  async renameThread(threadId, name) {
    this.calls.push(['renameThread', threadId, name]);
    return { threadId, name };
  }

  async deleteThread(threadId) {
    this.calls.push(['deleteThread', threadId]);
    if (this.deleteFailure) throw this.deleteFailure;
    return { deleted: true, threadId };
  }

  async send(input) {
    this.calls.push(['send', input]);
    return { accepted: true, disposition: 'started', threadId: input.threadId, queue: [] };
  }

  async removeQueued(threadId, queueId) {
    this.calls.push(['removeQueued', threadId, queueId]);
    return { removed: queueId === QUEUE_ID, threadId, queue: [] };
  }

  async respondToApproval(id, decision) {
    this.calls.push(['respondToApproval', id, decision]);
    if (id === 404) throw Object.assign(new Error('Approval request is not pending.'), { code: 'NOT_FOUND' });
    return { id, decision, threadId: THREAD_ID };
  }

  async reset() {
    this.calls.push(['reset']);
    this.activeThreadId = null;
    return { reset: true };
  }

  async stop() {}
}

class FakeAttachments {
  constructor(order = []) {
    this.calls = [];
    this.order = order;
  }

  async save(input) {
    this.calls.push(['save', input]);
    return { id: ATTACHMENT_ID, name: input.name, mime: input.mime, size: 8 };
  }

  async resolveForTurn(threadId, ids) {
    this.calls.push(['resolveForTurn', threadId, ids]);
    if (ids.includes(OTHER_THREAD_ID)) throw new Error('Attachment is unknown for this thread.');
    return ids.map((id) => ({ id, path: `C:\\private\\${id}.png`, name: 'image.png', mime: 'image/png', size: 8 }));
  }

  async remove(threadId, attachmentId) {
    this.calls.push(['remove', threadId, attachmentId]);
    if (attachmentId === OTHER_THREAD_ID) throw new Error('Attachment is unknown.');
    return { removed: true, id: attachmentId };
  }

  async removeThread(threadId) {
    this.calls.push(['removeThread', threadId]);
    this.order.push('attachments');
    return { removed: true, threadId };
  }
}

class FakeTranscription {
  constructor() {
    this.calls = [];
  }

  async transcribe(input) {
    this.calls.push(input);
    return { text: 'Проверить запись', durationMs: 1200, language: 'ru' };
  }
}

async function withServer(run, overrides = {}) {
  const jarvis = overrides.jarvis || new FakeJarvis();
  const attachmentStore = overrides.attachmentStore || new FakeAttachments();
  const transcriptionService = overrides.transcriptionService || new FakeTranscription();
  const server = createJarvisHttpServer({
    jarvis,
    attachmentStore,
    transcriptionService,
    voiceRuntime: overrides.voiceRuntime,
    cryptoRuntime: overrides.cryptoRuntime,
    publicDirectory: new URL('../public/', import.meta.url),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`, { jarvis, attachmentStore, transcriptionService, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonRequest(baseUrl, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

function oversizedRequest(port, pathname, contentLength) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(contentLength) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(Buffer.alloc(contentLength, 0x20));
  });
}

test('reports status with localhost security headers and same-origin microphone permission', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { state: 'ready', detail: 'JARVIS готов.' });
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(self), geolocation=()');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('serves the redesigned shell and local favicon', async () => {
  await withServer(async (baseUrl) => {
    const shell = await fetch(baseUrl);
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.match(html, /class="sidebar"/);
    assert.match(html, /id="activity-panel"/);
    assert.doesNotMatch(html, /Codex/);

    const favicon = await fetch(`${baseUrl}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get('content-type'), /image\/svg\+xml/);
  });
});

test('premium shell keeps real controls visible and rejects forbidden visual copy', async () => {
  const publicDirectory = new URL('../public/', import.meta.url);
  const [html, css, app] = await Promise.all([
    readFile(new URL('index.html', publicDirectory), 'utf8'),
    readFile(new URL('style.css', publicDirectory), 'utf8'),
    readFile(new URL('app.js', publicDirectory), 'utf8'),
  ]);

  for (const id of [
    'history-search',
    'history-list',
    'history-open',
    'history-close',
    'queue-tray',
    'attachment-input',
    'attach-button',
    'attachment-preview',
    'mic-button',
    'activity-open',
    'activity-clear',
    'activity-toggle',
    'activity-close',
    'approval-dialog',
    'delete-all-threads',
    'delete-all-dialog',
    'delete-all-count',
    'delete-all-cancel',
    'delete-all-confirm',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
  }

  const quickActions = Array.from(html.matchAll(/<button\b(?=[^>]*\bclass="suggestion-card")(?=[^>]*\bdata-prompt="([^"]+)")[^>]*>/g));
  assert.equal(quickActions.length, 4);
  assert.ok(quickActions.every(([, prompt]) => prompt.trim().length > 0));
  assert.doesNotMatch(html, /Локальная сессия|Локальный помощник/);
  assert.doesNotMatch(html, /Здесь появляются только реальные действия JARVIS\./);
  assert.doesNotMatch(html, /\b(?:reasoning|implementation|app server|codex)\b/i);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\s*\(/i);
  assert.match(css, /@media\s*\(max-width:\s*900px\)/);
  assert.match(css, /@media\s*\(max-width:\s*680px\)/);
  assert.match(css, /@media\s*\(max-width:\s*390px\)/);
  assert.match(css, /@media\s*\(max-width:\s*340px\)/);
  assert.match(css, /@media\s*\(max-width:\s*680px\)[\s\S]*?min-height:\s*2\.5rem/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /--ease-out:\s*cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/);
  assert.match(css, /--control-speed:\s*150ms/);
  assert.match(css, /--panel-speed:\s*220ms/);
  assert.match(css, /--message-speed:\s*220ms/);
  assert.match(css, /\.app-shell\s*\{[\s\S]*?grid-template-columns:\s*16rem minmax\(0, 1fr\) 0/);
  assert.match(css, /\.app-shell\.has-activity-panel\s*\{[\s\S]*?grid-template-columns:[^;]*19rem/);
  assert.match(css, /transition:[^;]*grid-template-columns[^;]*var\(--panel-speed\)/);
  assert.match(app, /appShell\.classList\.toggle\('has-activity-panel',\s*open\)/);
  const desktopNarrowBlock = css.match(/@media\s*\(max-width:\s*1200px\)[\s\S]*?(?=@media\s*\()/)?.[0] || '';
  assert.doesNotMatch(desktopNarrowBlock, /\.activity-panel\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.activity-panel\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(app, /dialog\.addEventListener\('cancel',[\s\S]*?preventDefault\(\)/);
  assert.match(css, /animation:\s*fallback-reveal\s+380ms/);
  assert.match(css, /animation:\s*typing-dot\s+900ms/);
  assert.match(css, /transform:\s*translateY\(-1px\)/);
  assert.match(css, /transform:\s*scale\(0\.988\)/);
  assert.match(css, /transition-duration:\s*85ms/);
  assert.match(css, /\.message-path-value[\s\S]*?user-select:\s*text/);
  assert.match(css, /\.composer-wrap\s*\{[\s\S]*?position:\s*absolute/);
  assert.doesNotMatch(css, /ambient-layer/);

  assert.match(app, /activityElementsByThread\s*=\s*new Map\(\)/);
  assert.match(app, /activityElementsByThread\.set\(threadId, elements\)/);
  assert.match(app, /elements\.get\(activity\.id\)/);
  assert.match(app, /slice\(-5\)/);
  assert.match(app, /type:\s*'activity-cleared'/);
  assert.match(app, /activityOpen\.hidden\s*=\s*!hasActivity/);
  assert.match(app, /for \(let index = 0; index < 3; index \+= 1\)/);
  assert.match(app, /body\.append\(pathSection\)/);
  assert.doesNotMatch(app, /\.field\.disabled\s*=/);
  assert.doesNotMatch(`${html}\n${app}`, />\s*(?:Открыть|Показать в папке|Reveal)\s*</i);

  const buttons = Array.from(html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g));
  assert.ok(buttons.length > 10);
  for (const [, attributes, contents] of buttons) {
    const visibleText = contents.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    assert.ok(/\baria-label\s*=/.test(attributes) || visibleText, `button has no accessible name: ${attributes}`);
  }
  for (const id of ['history-search', 'attachment-input', 'message']) {
    assert.match(html, new RegExp(`<label[^>]+for=["']${id}["']`), `${id} label`);
  }
  assert.match(app, /summary\.setAttribute\('aria-label'/);
});

test('premium view keeps one copyable local path and five stable activity ids', () => {
  assert.deepEqual(extractLocalPath('Готово.\nПуть: C:\\Users\\user\\Очень длинная папка\\отчёт.txt'), {
    text: 'Готово.',
    path: 'C:\\Users\\user\\Очень длинная папка\\отчёт.txt',
  });
  assert.deepEqual(extractLocalPath('Обычный ответ без пути.'), {
    text: 'Обычный ответ без пути.',
    path: '',
  });

  const activities = Array.from({ length: 7 }, (_, index) => ({
    id: `activity-${index}`,
    title: `Шаг ${index}`,
    state: 'working',
  }));
  activities.push({ id: 'activity-6', title: 'Шаг завершён', state: 'complete' });
  const recent = recentActivities(activities);
  assert.deepEqual(recent.map(({ id }) => id), ['activity-2', 'activity-3', 'activity-4', 'activity-5', 'activity-6']);
  assert.equal(recent.at(-1).title, 'Шаг завершён');
  assert.equal(normalizeActivityState(recent.at(-1).state), 'completed');
  assert.equal(normalizeActivityState('failed'), 'error');
});

test('lists, creates, reads, resumes, and renames UUID-addressed threads', async () => {
  await withServer(async (baseUrl, { jarvis }) => {
    let result = await jsonRequest(baseUrl, '/api/threads?search=%D1%82%D0%B5%D1%81%D1%82&cursor=next');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.data[0].id, THREAD_ID);

    result = await jsonRequest(baseUrl, '/api/threads', { method: 'POST' });
    assert.equal(result.response.status, 201);
    assert.equal(result.payload.id, THREAD_ID);

    result = await jsonRequest(baseUrl, `/api/threads/${THREAD_ID}`);
    assert.equal(result.response.status, 200);
    result = await jsonRequest(baseUrl, `/api/threads/${THREAD_ID}/resume`, { method: 'POST' });
    assert.equal(result.response.status, 200);
    result = await jsonRequest(baseUrl, `/api/threads/${THREAD_ID}`, { method: 'PATCH', body: { name: '  Новый чат  ' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.name, 'Новый чат');

    assert.deepEqual(jarvis.calls.filter(([name]) => ['listThreads', 'createThread', 'readThread', 'resumeThread', 'renameThread'].includes(name)), [
      ['listThreads', { searchTerm: 'тест', cursor: 'next' }],
      ['createThread'],
      ['readThread', THREAD_ID],
      ['resumeThread', THREAD_ID],
      ['renameThread', THREAD_ID, 'Новый чат'],
    ]);
  });
});

test('resolves attachment ids before send and exposes the explicit queue alias', async () => {
  await withServer(async (baseUrl, { jarvis, attachmentStore }) => {
    const body = { threadId: THREAD_ID, message: 'Что на изображении?', attachmentIds: [ATTACHMENT_ID] };
    let result = await jsonRequest(baseUrl, '/api/chat', { method: 'POST', body });
    assert.equal(result.response.status, 202);
    assert.equal(result.payload.disposition, 'started');

    result = await jsonRequest(baseUrl, `/api/threads/${THREAD_ID}/queue`, {
      method: 'POST',
      body: { message: 'Следующий вопрос', attachmentIds: [] },
    });
    assert.equal(result.response.status, 202);
    assert.deepEqual(attachmentStore.calls[0], ['resolveForTurn', THREAD_ID, [ATTACHMENT_ID]]);
    assert.equal(jarvis.calls.find(([name]) => name === 'send')[1].attachments[0].path.includes('private'), true);
    assert.equal(jarvis.calls.filter(([name]) => name === 'send').length, 2);
  });
});

test('removes only known queued items and returns 404 for an unknown queue id', async () => {
  await withServer(async (baseUrl) => {
    let result = await jsonRequest(baseUrl, `/api/threads/${THREAD_ID}/queue/${QUEUE_ID}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.removed, true);

    result = await jsonRequest(baseUrl, `/api/threads/${THREAD_ID}/queue/${ATTACHMENT_ID}`, { method: 'DELETE' });
    assert.equal(result.response.status, 404);
    assert.equal(result.payload.error.code, 'NOT_FOUND');
  });
});

test('uploads and deletes attachments using thread ownership', async () => {
  await withServer(async (baseUrl, { attachmentStore }) => {
    let result = await jsonRequest(baseUrl, '/api/attachments', {
      method: 'POST',
      body: { threadId: THREAD_ID, name: 'image.png', mime: 'image/png', base64: 'iVBORw0KGgo=' },
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.payload.id, ATTACHMENT_ID);

    result = await jsonRequest(baseUrl, `/api/attachments/${ATTACHMENT_ID}?threadId=${THREAD_ID}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(attachmentStore.calls.map(([name]) => name), ['save', 'remove']);
  });
});

test('does not let a batch item override its owning thread', async () => {
  await withServer(async (baseUrl, { attachmentStore }) => {
    const result = await jsonRequest(baseUrl, '/api/attachments', {
      method: 'POST',
      body: {
        threadId: THREAD_ID,
        attachments: [{ threadId: OTHER_THREAD_ID, name: 'image.png', mime: 'image/png', base64: 'iVBORw0KGgo=' }],
      },
    });
    assert.equal(result.response.status, 201);
    assert.equal(attachmentStore.calls[0][1].threadId, THREAD_ID);
  });
});

test('returns transcript data without sending it as chat', async () => {
  await withServer(async (baseUrl, { jarvis, transcriptionService }) => {
    const result = await jsonRequest(baseUrl, '/api/transcriptions', {
      method: 'POST',
      body: { mime: 'audio/webm;codecs=opus', base64: 'AAAA' },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload, { text: 'Проверить запись', durationMs: 1200, language: 'ru' });
    assert.equal(transcriptionService.calls.length, 1);
    assert.equal(jarvis.calls.some(([name]) => name === 'send'), false);
  });
});

test('serves semantic image, queue, drag, and voice composer controls', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    for (const id of ['attachment-input', 'attach-button', 'attachment-preview', 'queue-tray', 'drag-overlay', 'mic-button', 'recording-timer', 'send-icon', 'check-icon', 'media-status']) {
      assert.match(html, new RegExp(`id=["']${id}["']`), id);
    }
    assert.match(html, /accept="image\/png,image\/jpeg,image\/webp,image\/gif"/);
    assert.match(html, /id="attachment-input"[^>]*multiple/);
    assert.match(html, /aria-label="Прикрепить изображения"/);
    assert.match(html, /aria-label="Записать голос"/);
    assert.match(html, /data-mode="files"[^>]*aria-label="Файлы"/);
    assert.match(html, /data-mode="web"[^>]*aria-label="Интернет"/);
    assert.match(html, /id="media-status"[^>]*aria-live="polite"/);
  });
});

test('routes approval decisions without changing their wire values', async () => {
  await withServer(async (baseUrl, { jarvis }) => {
    const result = await jsonRequest(baseUrl, '/api/approvals', {
      method: 'POST',
      body: { id: 17, decision: 'decline' },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(jarvis.calls.at(-1), ['respondToApproval', 17, 'decline']);
  });
});

test('returns 404 for an approval id that is no longer pending', async () => {
  await withServer(async (baseUrl) => {
    const result = await jsonRequest(baseUrl, '/api/approvals', {
      method: 'POST',
      body: { id: 404, decision: 'accept' },
    });
    assert.equal(result.response.status, 404);
    assert.equal(result.payload.error.code, 'NOT_FOUND');
  });
});

test('deletes upstream first, then performs validated attachment cleanup', async () => {
  const order = [];
  const jarvis = new FakeJarvis();
  jarvis.deleteThread = async (threadId) => {
    order.push('upstream-and-runtime');
    return { deleted: true, threadId };
  };
  const attachmentStore = new FakeAttachments(order);
  await withServer(async (baseUrl) => {
    const result = await jsonRequest(baseUrl, `/api/threads/${THREAD_ID}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(order, ['upstream-and-runtime', 'attachments']);
  }, { jarvis, attachmentStore });
});

test('deletes all chat history through the single-thread path, preserves Crypto, and recreates Voice Commands plus a usable chat', async () => {
  const order = [];
  const jarvis = new FakeJarvis();
  jarvis.listThreads = async () => ({
    data: [
      { id: THREAD_ID, name: 'Обычный чат' },
      { id: VOICE_THREAD_ID, name: 'Voice Commands' },
      { id: CRYPTO_THREAD_ID, name: 'Crypto' },
    ],
    nextCursor: null,
  });
  jarvis.deleteThread = async (threadId) => {
    order.push(`delete:${threadId}`);
    return { deleted: true, threadId };
  };
  jarvis.createThread = async () => {
    order.push('create:user');
    return { id: NEW_THREAD_ID, messages: [], queue: [] };
  };
  const attachmentStore = new FakeAttachments(order);
  const voiceRuntime = {
    snapshot: () => ({ threadId: VOICE_THREAD_ID }),
    async resetConversation() {
      order.push('create:voice');
      return { threadId: VOICE_THREAD_ID };
    },
  };
  const cryptoRuntime = {
    status: async () => ({ threadId: CRYPTO_THREAD_ID }),
    isThread: async (threadId) => threadId === CRYPTO_THREAD_ID,
    subscribe: () => () => {},
  };

  await withServer(async (baseUrl) => {
    const result = await jsonRequest(baseUrl, '/api/threads', { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload, {
      deleted: true,
      deletedCount: 2,
      deletedThreadIds: [THREAD_ID, VOICE_THREAD_ID],
      preservedThreadIds: [CRYPTO_THREAD_ID],
      voiceThreadId: VOICE_THREAD_ID,
      thread: { id: NEW_THREAD_ID, messages: [], queue: [] },
    });
    assert.deepEqual(order, [
      `delete:${THREAD_ID}`,
      'attachments',
      `delete:${VOICE_THREAD_ID}`,
      'attachments',
      'create:voice',
      'create:user',
    ]);
  }, { jarvis, attachmentStore, voiceRuntime, cryptoRuntime });
});

test('does not clean local state when upstream thread deletion fails', async () => {
  const jarvis = new FakeJarvis();
  jarvis.deleteFailure = new Error('C:\\private\\rollout.jsonl failed');
  const attachmentStore = new FakeAttachments();
  await withServer(async (baseUrl) => {
    const result = await jsonRequest(baseUrl, `/api/threads/${THREAD_ID}`, { method: 'DELETE' });
    assert.equal(result.response.status, 500);
    assert.equal(attachmentStore.calls.length, 0);
    assert.equal(JSON.stringify(result.payload).includes('private'), false);
  }, { jarvis, attachmentStore });
});

test('returns 400, 422, and 404 for malformed JSON, validation, and unknown routes or ids', async () => {
  await withServer(async (baseUrl) => {
    let result = await jsonRequest(baseUrl, '/api/chat', { method: 'POST', body: '{' });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error.code, 'INVALID_JSON');

    result = await jsonRequest(baseUrl, '/api/chat', {
      method: 'POST',
      body: { threadId: '../secret', message: 'test', attachmentIds: [] },
    });
    assert.equal(result.response.status, 422);
    assert.equal(result.payload.error.code, 'VALIDATION_ERROR');

    result = await jsonRequest(baseUrl, `/api/attachments/${OTHER_THREAD_ID}?threadId=${THREAD_ID}`, { method: 'DELETE' });
    assert.equal(result.response.status, 404);

    result = await jsonRequest(baseUrl, '/api/threads/%E0%A4%A');
    assert.equal(result.response.status, 404);

    result = await jsonRequest(baseUrl, '/api/threads/not-a-uuid/not-a-route');
    assert.equal(result.response.status, 404);

    result = await jsonRequest(baseUrl, '/api/does-not-exist');
    assert.equal(result.response.status, 404);
  });
});

test('enforces route-specific byte caps before reading request bodies', async () => {
  await withServer(async (_baseUrl, { port }) => {
    const chat = await oversizedRequest(port, '/api/chat', (64 * 1024) + 1);
    assert.equal(chat.status, 413);
    assert.equal(JSON.parse(chat.body).error.code, 'REQUEST_TOO_LARGE');

    const attachments = await oversizedRequest(port, '/api/attachments', (36 * 1024 * 1024) + 1);
    assert.equal(attachments.status, 413);

    const audio = await oversizedRequest(port, '/api/transcriptions', (35 * 1024 * 1024) + 1);
    assert.equal(audio.status, 413);
  });
});

test('redacts internal errors with one stable public 500 envelope', async () => {
  const jarvis = new FakeJarvis();
  jarvis.send = async () => { throw new Error('C:\\Users\\secret\\rollout.jsonl\nstack trace'); };
  await withServer(async (baseUrl) => {
    const result = await jsonRequest(baseUrl, '/api/chat', {
      method: 'POST',
      body: { threadId: THREAD_ID, message: 'Проверить ошибку', attachmentIds: [] },
    });
    assert.equal(result.response.status, 500);
    assert.deepEqual(result.payload, {
      error: { code: 'SERVER_ERROR', message: 'JARVIS не смог обработать запрос. Проверьте локальный журнал.' },
    });
  }, { jarvis });
});

test('maps only a structured NOT_FOUND code and never error message text', async () => {
  const jarvis = new FakeJarvis();
  jarvis.readThread = async () => { throw new Error('not found at C:\\private\\rollout.jsonl'); };
  await withServer(async (baseUrl) => {
    const result = await jsonRequest(baseUrl, `/api/threads/${THREAD_ID}`);
    assert.equal(result.response.status, 500);
    assert.equal(JSON.stringify(result.payload).includes('private'), false);
  }, { jarvis });
});

test('returns redacted 404s for unknown valid thread UUIDs through a real JarvisSession', async (t) => {
  class NotFoundAppServerClient extends EventEmitter {
    #notFound() {
      return Object.assign(new Error('Thread missing at C:\\private\\rollout.jsonl'), { code: 'NOT_FOUND' });
    }

    async readThread() { throw this.#notFound(); }
    async resumeThread() { throw this.#notFound(); }
    async setThreadName() { throw this.#notFound(); }
    async deleteThread() { throw this.#notFound(); }
    async stop() {}
  }

  const logDirectory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-server-not-found-'));
  t.after(() => rm(logDirectory, { recursive: true, force: true }));
  const client = new NotFoundAppServerClient();
  const jarvis = new JarvisSession({
    projectRoot: process.cwd(),
    clientFactory: () => client,
    logDirectory,
  });
  const attachmentStore = new FakeAttachments();
  const cases = [
    ['GET', `/api/threads/${OTHER_THREAD_ID}`],
    ['POST', `/api/threads/${OTHER_THREAD_ID}/resume`],
    ['PATCH', `/api/threads/${OTHER_THREAD_ID}`, { name: 'Неизвестный чат' }],
    ['DELETE', `/api/threads/${OTHER_THREAD_ID}`],
    ['POST', '/api/chat', { threadId: OTHER_THREAD_ID, message: 'Проверить', attachmentIds: [] }],
    ['POST', `/api/threads/${OTHER_THREAD_ID}/queue`, { message: 'Проверить', attachmentIds: [] }],
  ];

  await withServer(async (baseUrl) => {
    for (const [method, route, body] of cases) {
      const result = await jsonRequest(baseUrl, route, { method, body });
      assert.equal(result.response.status, 404, `${method} ${route}`);
      assert.deepEqual(result.payload, {
        error: { code: 'NOT_FOUND', message: 'Запрошенный ресурс не найден.' },
      });
      assert.equal(JSON.stringify(result.payload).includes('private'), false);
    }
  }, { jarvis, attachmentStore });

  assert.equal(attachmentStore.calls.some(([name]) => name === 'removeThread'), false);
});

test('streams initial and subscribed SSE events with threadId', async () => {
  const jarvis = new FakeJarvis();
  await withServer(async (baseUrl) => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value, { stream: true });
    jarvis.listener({ type: 'queue', threadId: OTHER_THREAD_ID, items: [] });
    while (!text.includes('"type":"queue"')) {
      text += decoder.decode((await reader.read()).value, { stream: true });
    }
    controller.abort();
    assert.match(text, new RegExp(`"type":"status","threadId":"${THREAD_ID}"`));
    assert.match(text, new RegExp(`"type":"queue","threadId":"${OTHER_THREAD_ID}"`));
  }, { jarvis });
});

test('keeps the legacy reset route and creates a thread for legacy chat bodies', async () => {
  await withServer(async (baseUrl, { jarvis }) => {
    let result = await jsonRequest(baseUrl, '/api/session/new', { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload, { reset: true });

    result = await jsonRequest(baseUrl, '/api/chat', { method: 'POST', body: { message: 'Старый интерфейс' } });
    assert.equal(result.response.status, 202);
    assert.equal(jarvis.calls.some(([name]) => name === 'createThread'), true);
  });
});
