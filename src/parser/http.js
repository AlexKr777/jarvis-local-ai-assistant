const BODY_LIMIT = 64 * 1024;
const INVALID = { code: 'PARSER_VALIDATION_ERROR', message: 'Check the Parser request fields.' };

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const declared = request.headers['content-length'];
  if (/^\d+$/.test(declared || '') && Number(declared) > BODY_LIMIT) {
    request.resume();
    throw Object.assign(new Error('Parser request is too large.'), { status: 413, code: 'REQUEST_TOO_LARGE' });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > BODY_LIMIT) {
      request.resume();
      throw Object.assign(new Error('Parser request is too large.'), { status: 413, code: 'REQUEST_TOO_LARGE' });
    }
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(bytes ? Buffer.concat(chunks, bytes).toString('utf8') : '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    throw Object.assign(new Error('Parser request JSON is invalid.'), { status: 400, code: 'INVALID_JSON' });
  }
}

function exact(body, allowed, required = []) {
  if (Object.keys(body).some((key) => !allowed.includes(key)) || required.some((key) => !(key in body))) {
    throw Object.assign(new Error(INVALID.message), { status: 422, code: INVALID.code });
  }
  return body;
}

function text(value, { required = false, max = 500 } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw Object.assign(new Error(INVALID.message), { status: 422, code: INVALID.code });
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) {
    throw Object.assign(new Error(INVALID.message), { status: 422, code: INVALID.code });
  }
  return normalized;
}

function id(value) {
  return text(value, { required: true, max: 128 });
}

function integer(value, { minimum, maximum, optional = true }) {
  if ((value === undefined || value === null || value === '') && optional) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw Object.assign(new Error(INVALID.message), { status: 422, code: INVALID.code });
  }
  return parsed;
}

function list(value, { required = false, max = 200 } = {}) {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > max || value.some((item) => typeof item !== 'string')) {
    throw Object.assign(new Error(INVALID.message), { status: 422, code: INVALID.code });
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function queryParams(url) {
  const output = {};
  for (const name of ['search', 'language', 'topic', 'type', 'sort', 'direction', 'status', 'class']) {
    const value = url.searchParams.get(name);
    if (value) output[name] = text(value, { max: 100 });
  }
  for (const [name, minimum, maximum] of [
    ['minimumMembers', 0, 100_000_000], ['minimumScore', 0, 100], ['minimumActivity', 0, 100],
    ['limit', 1, 500], ['offset', 0, 100_000],
  ]) {
    const value = url.searchParams.get(name);
    if (value !== null) output[name] = integer(value, { minimum, maximum, optional: false });
  }
  if (url.searchParams.get('includeIgnored') === 'true') output.includeIgnored = true;
  return output;
}

function groupQueryParams(url) {
  const output = queryParams(url);
  if (output.status && !['ALL', 'NEW', 'QUEUED', 'JOINED', 'MONITORING'].includes(output.status.toUpperCase())) {
    throw Object.assign(new Error(INVALID.message), { status: 422, code: INVALID.code });
  }
  if (output.status) output.status = output.status.toUpperCase();
  const rawRunIds = url.searchParams.get('runIds');
  if (rawRunIds !== null) {
    const parts = rawRunIds.split(',').map((item) => item.trim());
    if (!parts.length || parts.some((item) => !item || item.length > 128)) {
      throw Object.assign(new Error(INVALID.message), { status: 422, code: INVALID.code });
    }
    const runIds = [...new Set(parts)];
    if (runIds.length > 100) {
      throw Object.assign(new Error(INVALID.message), { status: 422, code: INVALID.code });
    }
    output.runIds = runIds;
  }
  return output;
}

function auditQueryParams(url) {
  const output = {};
  for (const name of ['gate', 'outcome', 'aiState', 'notificationState', 'group', 'text', 'since']) {
    const value = url.searchParams.get(name);
    if (value) output[name] = text(value, { max: name === 'text' ? 200 : 100 });
  }
  const limit = url.searchParams.get('limit');
  if (limit !== null) output.limit = integer(limit, { minimum: 1, maximum: 1000, optional: false });
  if (url.searchParams.get('potentialMissed') === 'true') output.potentialMissed = true;
  return output;
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const code = String(error?.code || '');
  if (['BOT_TOKEN_NOT_CONFIGURED', 'DESTINATION_NOT_CONFIGURED', 'BOT_TOKEN_INVALID',
    'DESTINATION_NOT_FOUND', 'NOTIFICATION_CREDENTIALS_UNREADABLE',
    'OPENROUTER_API_KEY_NOT_CONFIGURED', 'OPENROUTER_MODEL_NOT_CONFIGURED',
    'OPENROUTER_CREDENTIALS_UNREADABLE', 'OPENROUTER_API_KEY_INVALID',
    'OPENROUTER_MODEL_NOT_FOUND', 'OPENROUTER_STRUCTURED_OUTPUT_UNSUPPORTED',
    'OPENROUTER_INVALID_CLASSIFICATION'].includes(code)) return 422;
  if (code === 'OPENROUTER_CREDITS_REQUIRED') return 402;
  if (['OPENROUTER_RATE_LIMITED', 'OPENROUTER_PROVIDER_UNAVAILABLE', 'OPENROUTER_UNREACHABLE'].includes(code)) return 503;
  if (code.includes('NOT_FOUND')) return 404;
  if (code.includes('UNAVAILABLE') || code.includes('DISCONNECTED') || code.includes('WORKER')) return 503;
  if (code.includes('RUNNING') || code.includes('ACTIVE') || code.includes('RESUMABLE') || code.includes('CONFLICT')) return 409;
  if (code.startsWith('INVALID') || code.includes('VALIDATION') || code.includes('NOT_CONFIGURED')) return 422;
  return 500;
}

function publicErrorMessage(error, status, code) {
  if (status < 500 && typeof error?.message === 'string' && error.message.length <= 240) return error.message;
  const safeUnavailable = {
    WORKER_UNAVAILABLE: 'Parser worker is unavailable.',
    WORKER_EXITED: 'Parser worker is unavailable.',
    WORKER_STOPPED: 'Parser worker is unavailable.',
    WORKER_TIMEOUT: 'Parser worker did not respond in time.',
    TELEGRAM_API_UNAVAILABLE: 'Telegram Bot API is temporarily unavailable.',
    OPENROUTER_RATE_LIMITED: 'OpenRouter rate limit reached. Try again shortly.',
    OPENROUTER_PROVIDER_UNAVAILABLE: 'The OpenRouter provider is temporarily unavailable.',
    OPENROUTER_UNREACHABLE: 'OpenRouter could not be reached.',
  };
  if (status === 503 && safeUnavailable[code]) return safeUnavailable[code];
  return status === 503 ? 'Parser is temporarily unavailable.' : 'Parser could not complete the request.';
}

async function route(request, url, segments, runtime) {
  if (request.method === 'GET' && segments.length === 3 && segments[2] === 'status') return runtime.status();
  if (request.method === 'POST' && segments.length === 3 && ['start', 'stop'].includes(segments[2])) {
    exact(await readJson(request), []);
    return runtime.call(segments[2]);
  }
  if (segments.length === 3 && segments[2] === 'settings') {
    if (request.method === 'GET') return runtime.call('settings_get');
    if (request.method === 'PUT') {
      const body = exact(await readJson(request), [
        'settings', 'telegramApiHash', 'phone', 'openrouterKey', 'botToken', 'destinationId',
      ], ['settings']);
      if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
        throw Object.assign(new Error(INVALID.message), { status: 422, code: INVALID.code });
      }
      for (const name of ['telegramApiHash', 'phone', 'openrouterKey', 'botToken', 'destinationId']) {
        if (body[name] !== undefined) text(body[name], { max: 500 });
      }
      return runtime.call('settings_save', body);
    }
  }
  if (request.method === 'POST' && segments.length === 4 && segments[2] === 'telegram') {
    if (segments[3] === 'send-code') {
      const body = exact(await readJson(request), ['apiId', 'apiHash', 'phone'], ['apiId', 'apiHash', 'phone']);
      return runtime.call('telegram_send_code', {
        apiId: integer(body.apiId, { minimum: 1, maximum: 2_147_483_647, optional: false }),
        apiHash: text(body.apiHash, { max: 128 }) || '', phone: text(body.phone, { max: 32 }) || '',
      });
    }
    if (segments[3] === 'reconnect') {
      exact(await readJson(request), []);
      return runtime.call('telegram_reconnect');
    }
    if (segments[3] === 'verify') {
      const body = exact(await readJson(request), ['code', 'password']);
      return runtime.call('telegram_verify', {
        code: text(body.code, { max: 16 }) || '', password: text(body.password, { max: 256 }) || '',
      });
    }
    if (segments[3] === 'disconnect') {
      exact(await readJson(request), []);
      return runtime.call('telegram_disconnect');
    }
  }
  if (segments[2] === 'discovery') {
    if (request.method === 'GET' && segments.length === 4 && segments[3] === 'runs') {
      return runtime.call('discovery_runs_list', {
        limit: integer(url.searchParams.get('limit'), { minimum: 1, maximum: 200 }) ?? 100,
        offset: integer(url.searchParams.get('offset'), { minimum: 0, maximum: 100_000 }) ?? 0,
      });
    }
    if (request.method === 'GET' && segments.length === 4 && segments[3] === 'status') {
      return runtime.call('discovery_status', { runId: text(url.searchParams.get('runId') || undefined, { max: 128 }) });
    }
    if (request.method === 'POST' && segments.length === 4 && segments[3] === 'start') {
      const body = exact(await readJson(request), ['queries'], ['queries']);
      return runtime.call('discovery_start', { queries: list(body.queries, { required: true, max: 100 }) });
    }
    if (request.method === 'POST' && segments.length === 4 && segments[3] === 'stop') {
      exact(await readJson(request), []);
      return runtime.call('discovery_stop');
    }
    if (request.method === 'POST' && segments.length === 4 && segments[3] === 'resume') {
      const body = exact(await readJson(request), ['runId']);
      return runtime.call('discovery_resume', { runId: text(body.runId, { max: 128 }) });
    }
  }
  if (segments[2] === 'groups') {
    if (request.method === 'GET' && segments.length === 3) return runtime.call('groups_list', groupQueryParams(url));
    if (request.method === 'POST' && segments.length === 5 && segments[4] === 'ignore') {
      exact(await readJson(request), []);
      return runtime.call('groups_ignore', { groupId: id(segments[3]) });
    }
    if (request.method === 'POST' && segments.length === 5 && segments[4] === 'leave') {
      exact(await readJson(request), []);
      return runtime.call('leave_group', { groupId: id(segments[3]) });
    }
  }
  if (segments[2] === 'queue') {
    if (request.method === 'GET' && segments.length === 3) return runtime.call('queue_list');
    if (request.method === 'POST' && segments.length === 4 && segments[3] === 'clear-completed') {
      exact(await readJson(request), []);
      return runtime.call('queue_clear_completed');
    }
    if (request.method === 'POST' && segments.length === 4 && segments[3] === 'add') {
      const body = exact(await readJson(request), ['groupIds'], ['groupIds']);
      return runtime.call('queue_add', { groupIds: list(body.groupIds, { required: true, max: 200 }) });
    }
    if (request.method === 'POST' && segments.length === 4 && ['pause', 'resume'].includes(segments[3])) {
      exact(await readJson(request), []);
      return runtime.call(`queue_${segments[3]}`);
    }
    if (request.method === 'DELETE' && segments.length === 4) return runtime.call('queue_remove', { itemId: id(segments[3]) });
  }
  if (segments[2] === 'monitoring') {
    if (request.method === 'GET' && segments.length === 3) return runtime.call('monitoring_list');
    if (request.method === 'POST' && segments.length === 5 && ['start', 'stop'].includes(segments[4])) {
      exact(await readJson(request), []);
      return runtime.call(`monitoring_${segments[4]}`, { groupId: id(segments[3]) });
    }
  }
  if (segments[2] === 'leads') {
    if (request.method === 'GET' && segments.length === 3) return runtime.call('leads_list', queryParams(url));
    if (request.method === 'POST' && segments.length === 5 && segments[4] === 'feedback') {
      const body = exact(await readJson(request), ['verdict', 'reason'], ['verdict']);
      return runtime.call('lead_feedback', {
        leadId: id(segments[3]), verdict: text(body.verdict, { required: true, max: 12 }), reason: text(body.reason, { max: 120 }),
      });
    }
    if (request.method === 'POST' && segments.length === 5 && segments[4] === 'ignore-author') {
      const body = exact(await readJson(request), ['authorId'], ['authorId']);
      return runtime.call('ignore_author', { leadId: id(segments[3]), authorId: id(body.authorId) });
    }
    if (request.method === 'POST' && segments.length === 5 && segments[4] === 'ignore-chat') {
      const body = exact(await readJson(request), ['telegramGroupId'], ['telegramGroupId']);
      return runtime.call('ignore_chat', { leadId: id(segments[3]), telegramGroupId: id(body.telegramGroupId) });
    }
  }
  if (segments[2] === 'audit' && request.method === 'GET' && segments.length === 3) {
    return runtime.call('audit_history_list', auditQueryParams(url));
  }
  if (segments[2] === 'audit' && request.method === 'POST' && segments.length === 5 && segments[4] === 'feedback') {
    const body = exact(await readJson(request), ['verdict', 'correctedCategory', 'reason'], ['verdict']);
    return runtime.call('audit_feedback', {
      revisionId: id(segments[3]), verdict: text(body.verdict, { required: true, max: 32 }),
      correctedCategory: text(body.correctedCategory, { max: 80 }), reason: text(body.reason, { max: 120 }),
    });
  }
  if (request.method === 'POST' && segments.length === 4 && ['ai', 'notification'].includes(segments[2]) && segments[3] === 'test') {
    exact(await readJson(request), []);
    return runtime.call(`${segments[2]}_test`);
  }
  throw Object.assign(new Error('Parser route was not found.'), { status: 404, code: 'PARSER_NOT_FOUND' });
}

export async function handleParserRequest({ request, response, url, segments, runtime }) {
  if (segments[0] !== 'api' || segments[1] !== 'parser') return false;
  if (!runtime) {
    sendJson(response, 503, { error: { code: 'PARSER_UNAVAILABLE', message: 'Parser is unavailable.' } });
    return true;
  }
  try {
    sendJson(response, 200, await route(request, url, segments, runtime));
  } catch (error) {
    const status = errorStatus(error);
    const code = typeof error?.code === 'string' && error.code.length <= 80 ? error.code : 'PARSER_REQUEST_FAILED';
    const message = publicErrorMessage(error, status, code);
    sendJson(response, status, { error: { code, message } });
  }
  return true;
}
