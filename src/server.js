import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentStore } from './attachment-store.js';
import { JarvisSession } from './jarvis-session.js';
import { TranscriptionService } from './transcription-service.js';
import { VoiceRuntime, VoiceStateStore } from './voice-runtime.js';
import { createCryptoRuntime } from './crypto/create-runtime.js';
import { createParserRuntime } from './parser/runtime.js';
import { handleParserRequest } from './parser/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const publicDirectory = path.join(projectRoot, 'public');
const port = Number.parseInt(process.env.JARVIS_PORT || '3210', 10);

const REQUEST_LIMITS = Object.freeze({
  json: 64 * 1024,
  attachments: 36 * 1024 * 1024,
  audio: 35 * 1024 * 1024,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTACHMENTS = 4;
const PUBLIC_MESSAGES = Object.freeze({
  invalidJson: 'Не удалось прочитать запрос.',
  tooLarge: 'Запрос слишком большой.',
  validation: 'Проверьте данные запроса.',
  notFound: 'Запрошенный ресурс не найден.',
  server: 'JARVIS не смог обработать запрос. Проверьте локальный журнал.',
});

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/api.js', ['api.js', 'text/javascript; charset=utf-8']],
  ['/state.js', ['state.js', 'text/javascript; charset=utf-8']],
  ['/chat-view.js', ['chat-view.js', 'text/javascript; charset=utf-8']],
  ['/crypto-ui.js', ['crypto-ui.js', 'text/javascript; charset=utf-8']],
  ['/parser-ui.js', ['parser-ui.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

function requestError(status, code, message) {
  return new HttpError(status, code, message);
}

async function readJson(request, limit) {
  const declaredLength = request.headers['content-length'];
  if (/^\d+$/.test(declaredLength || '') && Number(declaredLength) > limit) {
    request.resume();
    throw requestError(413, 'REQUEST_TOO_LARGE', PUBLIC_MESSAGES.tooLarge);
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) {
      request.resume();
      throw requestError(413, 'REQUEST_TOO_LARGE', PUBLIC_MESSAGES.tooLarge);
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(bytes === 0 ? '{}' : Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw requestError(400, 'INVALID_JSON', PUBLIC_MESSAGES.invalidJson);
  }
}

function setSecurityHeaders(response) {
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(self), geolocation=()');
}

function safeSegments(pathname) {
  try {
    return pathname.split('/').slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
  }
  return value;
}

function requireMessage(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 4_000) {
    throw requestError(422, 'VALIDATION_ERROR', 'Введите сообщение длиной до 4000 символов.');
  }
  return value.trim();
}

function requireAttachmentIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
  }
  return value.map(requireUuid);
}

function requireThreadName(value) {
  if (typeof value !== 'string') throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 120) {
    throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
  }
  return normalized;
}

function requireExactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
  }
  return value;
}

function bearerMatches(request, expectedToken) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function publicAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
  };
}

function asNotFound(error) {
  if (error?.code === 'NOT_FOUND') {
    return requestError(404, 'NOT_FOUND', PUBLIC_MESSAGES.notFound);
  }
  return error;
}

function attachmentError(error) {
  if (/unknown|not found/i.test(String(error?.message || ''))) {
    return requestError(404, 'NOT_FOUND', PUBLIC_MESSAGES.notFound);
  }
  return requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
}

function speechError(error) {
  if (/unsupported|strict base64|size exceeds/i.test(String(error?.message || ''))) {
    return requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
  }
  return error;
}

export function startupErrorMessage(error) {
  if (error?.code === 'EADDRINUSE') {
    return `JARVIS не запущен: порт ${port} уже занят. Закройте другое окно JARVIS и повторите запуск.`;
  }
  return 'JARVIS не удалось запустить. Подробности сохранены в локальном журнале.';
}

async function serveStatic(response, directory, pathname) {
  const item = staticFiles.get(pathname);
  if (!item) return false;
  const [filename, contentType] = item;
  const filePath = path.join(directory, filename);
  try {
    await stat(filePath);
  } catch {
    sendError(response, 500, 'STATIC_FILE_MISSING', 'Не найден файл интерфейса JARVIS.');
    return true;
  }
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  createReadStream(filePath).pipe(response);
  return true;
}

async function serveCryptoChart(response, filePath) {
  const details = await stat(filePath);
  if (!details.isFile()) throw new Error('Crypto chart is not a file.');
  response.writeHead(200, {
    'content-type': 'image/png',
    'content-length': details.size,
    'cache-control': 'private, no-store',
  });
  createReadStream(filePath).pipe(response);
}

async function sendMessage({ jarvis, attachmentStore, cryptoRuntime, body, routeThreadId }) {
  let threadId = routeThreadId ?? body.threadId ?? jarvis.activeThreadId;
  if (!threadId && typeof jarvis.createThread === 'function') {
    const thread = await jarvis.createThread();
    threadId = thread?.id;
  }
  requireUuid(threadId);
  const message = requireMessage(body.message);
  const attachmentIds = requireAttachmentIds(body.attachmentIds);

  let attachments;
  try {
    attachments = await attachmentStore.resolveForTurn(threadId, attachmentIds);
  } catch (error) {
    throw attachmentError(error);
  }
  const isCrypto = typeof cryptoRuntime?.isThread === 'function' && await cryptoRuntime.isThread(threadId);
  const additionalContext = isCrypto && typeof cryptoRuntime.manualTurnContext === 'function'
    ? await cryptoRuntime.manualTurnContext()
    : undefined;
  return jarvis.send({
    threadId,
    message,
    attachments,
    ...(isCrypto ? { source: 'crypto', additionalContext } : {}),
  });
}

function listOptions(url) {
  const options = {};
  const search = url.searchParams.get('search');
  const cursor = url.searchParams.get('cursor');
  if (search) options.searchTerm = search;
  if (cursor) options.cursor = cursor;
  return options;
}

export function createJarvisHttpServer(options = {}) {
  const attachmentStore = options.attachmentStore
    || new AttachmentStore({ root: path.join(projectRoot, 'data', 'attachments') });
  const transcriptionService = options.transcriptionService || new TranscriptionService({ projectRoot });
  const jarvis = options.jarvis || new JarvisSession({ projectRoot });
  const cryptoRuntime = options.cryptoRuntime || null;
  const voiceRuntime = options.voiceRuntime || null;
  const parserRuntime = options.parserRuntime || null;
  const hostToken = typeof options.hostToken === 'string' ? options.hostToken : (process.env.JARVIS_HOST_TOKEN || '');
  const onHostShutdown = typeof options.onHostShutdown === 'function' ? options.onHostShutdown : () => {};
  const directory = options.publicDirectory || publicDirectory;
  const staticDirectory = directory instanceof URL ? fileURLToPath(directory) : directory;

  async function deleteThreadWithCleanup(threadId) {
    const result = await jarvis.deleteThread(threadId);
    await attachmentStore.removeThread(threadId);
    return result;
  }

  async function listAllThreads() {
    const threads = [];
    const seenThreadIds = new Set();
    const seenCursors = new Set();
    let cursor = null;
    for (let page = 0; page < 100; page += 1) {
      const result = await jarvis.listThreads(cursor ? { cursor } : {});
      for (const thread of Array.isArray(result?.data) ? result.data : []) {
        if (!thread?.id || seenThreadIds.has(thread.id)) continue;
        seenThreadIds.add(thread.id);
        threads.push(thread);
      }
      if (!result?.nextCursor || seenCursors.has(result.nextCursor)) break;
      cursor = result.nextCursor;
      seenCursors.add(cursor);
    }
    return threads;
  }

  return http.createServer(async (request, response) => {
    setSecurityHeaders(response);

    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && await serveStatic(response, staticDirectory, url.pathname)) return;

      const segments = safeSegments(url.pathname);
      if (!segments) throw requestError(404, 'NOT_FOUND', PUBLIC_MESSAGES.notFound);

      if (await handleParserRequest({ request, response, url, segments, runtime: parserRuntime })) return;

      if (segments[0] === 'api' && segments[1] === 'host') {
        if (!hostToken || !voiceRuntime) {
          throw requestError(503, 'HOST_UNAVAILABLE', 'JARVIS Windows host is not active.');
        }
        if (!bearerMatches(request, hostToken)) {
          throw requestError(401, 'UNAUTHORIZED', 'JARVIS Windows host authorization failed.');
        }

        if (request.method === 'GET' && segments.length === 3 && segments[2] === 'status') {
          return sendJson(response, 200, { managed: true, ...voiceRuntime.snapshot() });
        }

        if (request.method === 'POST' && segments.length === 3 && segments[2] === 'transcriptions') {
          const body = requireExactObject(await readJson(request, REQUEST_LIMITS.audio), ['mime', 'base64']);
          if (typeof body.mime !== 'string' || typeof body.base64 !== 'string') {
            throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
          }
          try {
            return sendJson(response, 200, await transcriptionService.transcribe(body));
          } catch (error) {
            throw speechError(error);
          }
        }

        if (request.method === 'POST' && segments.length === 3 && segments[2] === 'commands') {
          const body = requireExactObject(await readJson(request, REQUEST_LIMITS.json), ['transcript']);
          const transcript = requireMessage(body.transcript);
          return sendJson(response, 202, await voiceRuntime.submitTranscript(transcript));
        }

        if (request.method === 'GET' && segments.length === 4 && segments[2] === 'commands') {
          const commandId = requireUuid(segments[3]);
          try {
            return sendJson(response, 200, voiceRuntime.status(commandId));
          } catch (error) {
            throw asNotFound(error);
          }
        }

        if (request.method === 'POST' && segments.length === 3 && segments[2] === 'pause') {
          const body = requireExactObject(await readJson(request, REQUEST_LIMITS.json), ['paused']);
          if (typeof body.paused !== 'boolean') throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
          return sendJson(response, 200, voiceRuntime.setPaused(body.paused));
        }

        if (request.method === 'POST' && segments.length === 3 && segments[2] === 'shutdown') {
          requireExactObject(await readJson(request, REQUEST_LIMITS.json), []);
          sendJson(response, 202, { stopping: true });
          setImmediate(onHostShutdown);
          return;
        }

        throw requestError(404, 'NOT_FOUND', PUBLIC_MESSAGES.notFound);
      }

      if (request.method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'status') {
        const requestedThreadId = url.searchParams.get('threadId');
        if (requestedThreadId !== null) requireUuid(requestedThreadId);
        return sendJson(response, 200, jarvis.status(requestedThreadId || undefined));
      }

      if (request.method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'events') {
        const status = jarvis.status();
        const threadId = status?.threadId ?? jarvis.activeThreadId ?? null;
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        response.write(`data: ${JSON.stringify({ type: 'status', threadId, ...status })}\n\n`);
        const unsubscribe = jarvis.subscribe((event) => {
          if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const unsubscribeCrypto = cryptoRuntime?.subscribe((event) => {
          if (!response.destroyed) {
            response.write(`data: ${JSON.stringify({
              type: 'crypto-activity',
              eventId: event.eventId,
              threadId: event.threadId,
              eventType: event.type,
              occurredAt: event.occurredAt,
              payload: event.payload,
            })}\n\n`);
          }
        }) || (() => {});
        const unsubscribeParser = parserRuntime?.subscribe((event) => {
          if (!response.destroyed) response.write(`data: ${JSON.stringify({ ...event, type: 'parser-activity', eventType: event.type })}\n\n`);
        }) || (() => {});
        request.once('close', () => {
          unsubscribe();
          unsubscribeCrypto();
          unsubscribeParser();
        });
        return;
      }

      if (segments[0] === 'api' && segments[1] === 'crypto' && cryptoRuntime) {
        if (request.method === 'GET' && segments.length === 4 && segments[2] === 'chart') {
          try {
            return await serveCryptoChart(response, cryptoRuntime.resolveChart(segments[3]));
          } catch {
            throw requestError(404, 'NOT_FOUND', PUBLIC_MESSAGES.notFound);
          }
        }
        if (request.method === 'GET' && segments.length === 3 && segments[2] === 'status') {
          return sendJson(response, 200, await cryptoRuntime.status());
        }
        if (request.method === 'POST' && segments.length === 3 && segments[2] === 'mode') {
          const body = await readJson(request, REQUEST_LIMITS.json);
          if (typeof body.mode !== 'string' || !['OFF', 'DRY_RUN', 'AUTO'].includes(body.mode.toUpperCase())) {
            throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
          }
          try {
            return sendJson(response, 200, await cryptoRuntime.setMode(body.mode.toUpperCase()));
          } catch {
            throw requestError(409, 'CRYPTO_MODE_CONFLICT', 'Crypto mode is not ready for this transition.');
          }
        }
        if (request.method === 'POST' && segments.length === 3 && segments[2] === 'dry-run') {
          try {
            return sendJson(response, 200, await cryptoRuntime.runLiveDryRun());
          } catch {
            throw requestError(503, 'CRYPTO_DRY_RUN_FAILED', 'Crypto DRY_RUN did not complete. No content was published.');
          }
        }
        if (request.method === 'POST' && segments.length === 3 && segments[2] === 'reset-post-limit') {
          try {
            return sendJson(response, 200, await cryptoRuntime.resetPostLimit());
          } catch {
            throw requestError(409, 'CRYPTO_LIMIT_RESET_CONFLICT', 'Crypto publication limit could not be reset.');
          }
        }
        if (request.method === 'POST' && segments.length === 4 && segments[2] === 'binance-rest' && segments[3] === 'recovery-probe') {
          try {
            return sendJson(response, 200, await cryptoRuntime.runBinanceRestRecoveryProbe());
          } catch {
            throw requestError(503, 'BINANCE_REST_PROBE_BLOCKED', 'Binance REST recovery probe did not run. No retry was sent.');
          }
        }
        if (request.method === 'POST' && segments.length === 3 && segments[2] === 'replay') {
          const body = await readJson(request, REQUEST_LIMITS.json);
          const count = body.count === undefined ? 8 : body.count;
          const lookbackDays = body.lookbackDays === undefined ? 21 : body.lookbackDays;
          const regressionSet = body.regressionSet === undefined ? false : body.regressionSet;
          if (!Number.isInteger(count) || count < 1 || count > 12 || !Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 21 || typeof regressionSet !== 'boolean') {
            throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
          }
          try {
            return sendJson(response, 200, await cryptoRuntime.runHistoricalReplay({ count, lookbackDays, regressionSet }));
          } catch {
            throw requestError(503, 'CRYPTO_REPLAY_FAILED', 'Historical replay did not complete. No content was published.');
          }
        }
        if (request.method === 'POST' && segments.length === 3 && segments[2] === 'confirm-auto') {
          try {
            const body = await readJson(request, REQUEST_LIMITS.json);
            if (body.force !== undefined && typeof body.force !== 'boolean') throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
            return sendJson(response, 200, await cryptoRuntime.confirmAutoArm(body.force === true ? { force: true } : undefined));
          } catch {
            throw requestError(409, 'CRYPTO_MODE_CONFLICT', 'Crypto AUTO confirmation is not ready.');
          }
        }
      }

      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'threads') {
        if (request.method === 'GET') return sendJson(response, 200, await jarvis.listThreads(listOptions(url)));
        if (request.method === 'POST') return sendJson(response, 201, await jarvis.createThread());
        if (request.method === 'DELETE') {
          const threads = await listAllThreads();
          const cryptoThreadId = typeof cryptoRuntime?.status === 'function'
            ? (await cryptoRuntime.status())?.threadId || null
            : null;
          const preservedThreadIds = cryptoThreadId ? [cryptoThreadId] : [];
          const deletedThreadIds = [];
          for (const thread of threads) {
            if (thread.id === cryptoThreadId) continue;
            await deleteThreadWithCleanup(thread.id);
            deletedThreadIds.push(thread.id);
          }
          const voiceThreadId = typeof voiceRuntime?.resetConversation === 'function'
            ? (await voiceRuntime.resetConversation()).threadId
            : null;
          const thread = await jarvis.createThread();
          return sendJson(response, 200, {
            deleted: true,
            deletedCount: deletedThreadIds.length,
            deletedThreadIds,
            preservedThreadIds,
            voiceThreadId,
            thread,
          });
        }
      }

      const isThreadItem = segments.length === 3;
      const isThreadResume = segments.length === 4 && segments[3] === 'resume';
      const isThreadQueue = segments.length === 4 && segments[3] === 'queue';
      const isThreadQueueItem = segments.length === 5 && segments[3] === 'queue';
      if (
        segments[0] === 'api'
        && segments[1] === 'threads'
        && (isThreadItem || isThreadResume || isThreadQueue || isThreadQueueItem)
      ) {
        const threadId = requireUuid(segments[2]);

        if (isThreadItem) {
          if (request.method === 'GET') return sendJson(response, 200, await jarvis.readThread(threadId));
          if (request.method === 'PATCH') {
            if (typeof cryptoRuntime?.isThread === 'function' && await cryptoRuntime.isThread(threadId)) {
              throw requestError(409, 'CRYPTO_THREAD_PROTECTED', 'The pinned Crypto conversation cannot be renamed.');
            }
            const body = await readJson(request, REQUEST_LIMITS.json);
            return sendJson(response, 200, await jarvis.renameThread(threadId, requireThreadName(body.name)));
          }
          if (request.method === 'DELETE') {
            if (typeof cryptoRuntime?.isThread === 'function' && await cryptoRuntime.isThread(threadId)) {
              throw requestError(409, 'CRYPTO_THREAD_PROTECTED', 'The pinned Crypto conversation cannot be deleted.');
            }
            const result = await deleteThreadWithCleanup(threadId);
            return sendJson(response, 200, result);
          }
        }

        if (isThreadResume && request.method === 'POST') {
          return sendJson(response, 200, await jarvis.resumeThread(threadId));
        }

        if (isThreadQueue && request.method === 'POST') {
          const body = await readJson(request, REQUEST_LIMITS.json);
          return sendJson(response, 202, await sendMessage({ jarvis, attachmentStore, cryptoRuntime, body, routeThreadId: threadId }));
        }

        if (isThreadQueueItem && request.method === 'DELETE') {
          const queueId = requireUuid(segments[4]);
          const result = await jarvis.removeQueued(threadId, queueId);
          if (!result?.removed) throw requestError(404, 'NOT_FOUND', PUBLIC_MESSAGES.notFound);
          return sendJson(response, 200, result);
        }
      }

      if (request.method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'chat') {
        const body = await readJson(request, REQUEST_LIMITS.json);
        return sendJson(response, 202, await sendMessage({ jarvis, attachmentStore, cryptoRuntime, body }));
      }

      if (request.method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'attachments') {
        const body = await readJson(request, REQUEST_LIMITS.attachments);
        if (Array.isArray(body.attachments)) {
          const threadId = requireUuid(body.threadId);
          if (body.attachments.length === 0 || body.attachments.length > MAX_ATTACHMENTS) {
            throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
          }
          const saved = [];
          try {
            for (const item of body.attachments) saved.push(await attachmentStore.save({ ...item, threadId }));
          } catch (error) {
            for (const item of saved) {
              try { await attachmentStore.remove(threadId, item.id); } catch {}
            }
            throw attachmentError(error);
          }
          return sendJson(response, 201, { attachments: saved.map(publicAttachment) });
        }

        const threadId = requireUuid(body.threadId);
        try {
          return sendJson(response, 201, publicAttachment(await attachmentStore.save({
            threadId,
            name: body.name,
            mime: body.mime,
            base64: body.base64,
          })));
        } catch (error) {
          throw attachmentError(error);
        }
      }

      if (request.method === 'DELETE' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'attachments') {
        const attachmentId = requireUuid(segments[2]);
        let threadId = url.searchParams.get('threadId');
        if (threadId === null) threadId = (await readJson(request, REQUEST_LIMITS.json)).threadId;
        requireUuid(threadId);
        try {
          return sendJson(response, 200, await attachmentStore.remove(threadId, attachmentId));
        } catch (error) {
          throw attachmentError(error);
        }
      }

      if (request.method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'transcriptions') {
        const body = await readJson(request, REQUEST_LIMITS.audio);
        if (typeof body.mime !== 'string' || typeof body.base64 !== 'string') {
          throw requestError(422, 'VALIDATION_ERROR', PUBLIC_MESSAGES.validation);
        }
        try {
          return sendJson(response, 200, await transcriptionService.transcribe({ mime: body.mime, base64: body.base64 }));
        } catch (error) {
          throw speechError(error);
        }
      }

      if (request.method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'approvals') {
        const body = await readJson(request, REQUEST_LIMITS.json);
        if (!Number.isInteger(body.id) || !['accept', 'decline'].includes(body.decision)) {
          throw requestError(422, 'VALIDATION_ERROR', 'Некорректное решение для подтверждения.');
        }
        try {
          return sendJson(response, 200, await jarvis.respondToApproval(body.id, body.decision));
        } catch (error) {
          throw asNotFound(error);
        }
      }

      if (request.method === 'POST' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'session' && segments[2] === 'new') {
        return sendJson(response, 200, await jarvis.reset());
      }

      throw requestError(404, 'NOT_FOUND', PUBLIC_MESSAGES.notFound);
    } catch (error) {
      const publicError = asNotFound(error);
      if (publicError instanceof HttpError) {
        return sendError(response, publicError.status, publicError.code, publicError.message);
      }
      return sendError(response, 500, 'SERVER_ERROR', PUBLIC_MESSAGES.server);
    }
  });
}

function openBrowser(url) {
  if (process.env.JARVIS_NO_BROWSER === '1') return;
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  import('node:child_process').then(({ spawn }) => spawn(command, args, { detached: true, stdio: 'ignore' }).unref());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const jarvis = new JarvisSession({ projectRoot });
  const cryptoRuntime = createCryptoRuntime({ projectRoot, jarvis });
  const parserRuntime = createParserRuntime({ projectRoot });
  const attachmentStore = new AttachmentStore({ root: path.join(projectRoot, 'data', 'attachments') });
  const transcriptionService = new TranscriptionService({ projectRoot });
  const voiceRuntime = new VoiceRuntime({ jarvis, stateStore: new VoiceStateStore({ projectRoot }) });
  let shuttingDown = false;
  let server;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    voiceRuntime.stop();
    await transcriptionService.stop();
    await cryptoRuntime.stop();
    await parserRuntime.stop();
    await jarvis.stop();
    server.close(() => process.exit(0));
  };
  server = createJarvisHttpServer({
    jarvis,
    cryptoRuntime,
    parserRuntime,
    attachmentStore,
    transcriptionService,
    voiceRuntime,
    hostToken: process.env.JARVIS_HOST_TOKEN || '',
    onHostShutdown: () => { void shutdown(); },
    publicDirectory,
  });
  server.once('error', async (error) => {
    console.error(startupErrorMessage(error));
    await transcriptionService.stop();
    await cryptoRuntime.stop();
    await parserRuntime.stop();
    await jarvis.stop();
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`JARVIS запущен: ${url}`);
    openBrowser(url);
    void cryptoRuntime.initialize().catch(() => {
      console.error('JARVIS Crypto scanner could not initialize. Chat remains available.');
    });
    void parserRuntime.initialize().catch(() => {
      console.error('JARVIS Parser worker could not initialize. Chat remains available.');
    });
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
