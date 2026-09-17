import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://anymodel.org/v1';
const DEFAULT_MODEL = 'kmc/k3';
// Kimi's two-candidate editorial stage has observed valid completions above
// ninety seconds. Keep a finite deadline, but do not cancel a normal long-form
// response before the provider can finish it.
const DEFAULT_TIMEOUT_MS = 150_000;
const MAX_TRANSIENT_ATTEMPTS = 3;
const WRITER_STAGES = new Set(['writer_reflection', 'writer_tension']);
const DEFAULT_EDITORIAL_MAX_TOKENS = 4_800;
export const V5_STAGE_TOKEN_BUDGETS = Object.freeze({
  analyst_brain: 900,
  writer_reflection: 1_200,
  writer_tension: 1_200,
  critic: 320,
  repair: 1_000,
});

function v5StageMaxTokens(stage, budgets = V5_STAGE_TOKEN_BUDGETS) {
  const value = Number(budgets?.[stage]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_EDITORIAL_MAX_TOKENS;
}

function compact(value, maximum = 320) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function numericUsage(value) {
  const usage = value && typeof value === 'object' ? value : {};
  const pick = (name) => Number.isFinite(Number(usage[name])) ? Number(usage[name]) : null;
  const completionTokens = pick('completion_tokens');
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object'
    ? usage.completion_tokens_details
    : {};
  const reasoningTokens = Number.isFinite(Number(completionDetails.reasoning_tokens))
    ? Number(completionDetails.reasoning_tokens)
    : pick('reasoning_tokens');
  return {
    promptTokens: pick('prompt_tokens'),
    completionTokens,
    totalTokens: pick('total_tokens'),
    reasoningTokens,
    visibleOutputTokens: completionTokens !== null && reasoningTokens !== null
      ? Math.max(0, completionTokens - reasoningTokens)
      : null,
  };
}

function parseRetryAfter(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(30_000, seconds * 1_000) : null;
}

function stripJsonFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function isSensitiveKey(key) {
  const normalized = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized.includes('authorization')
    || normalized.includes('apikey')
    || normalized.includes('accesstoken')
    || normalized.includes('refreshtoken')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('cookie')
    || normalized.includes('session');
}

function sanitizeResponseValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeResponseValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, isSensitiveKey(key) ? '[REDACTED]' : sanitizeResponseValue(entry)]));
}

function sanitizeResponseHeaders(headers) {
  if (!headers || typeof headers.entries !== 'function') return {};
  return Object.fromEntries([...headers.entries()].map(([key, value]) => [key, isSensitiveKey(key) ? '[REDACTED]' : value]));
}

function sanitizeRawResponseText(value) {
  return String(value || '')
    .replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\b(\s*[:=]\s*["']?)[^\s,"'}\]]+/gi, '$1$2[REDACTED]');
}

function sanitizedTransportError(error) {
  const rawCode = String(error?.code || '').toUpperCase();
  return {
    name: String(error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error',
    code: /^[A-Z][A-Z0-9_]{1,79}$/.test(rawCode) ? rawCode : null,
    message: sanitizeRawResponseText(compact(error?.message, 600)),
  };
}

function transportShape({ rawBody, headers, responseParseError }) {
  const contentType = headers?.get?.('content-type') || '';
  return {
    contentType: String(contentType || ''),
    bodyKind: rawBody ? 'text' : 'empty',
    bodyLength: rawBody.length,
    streamingEnvelope: /(?:^|\n)\s*data:\s*/.test(rawBody) || /text\/event-stream/i.test(contentType),
    responseParseError: responseParseError || null,
  };
}

function abortedReadError() {
  const error = new Error('The chat completion response body exceeded its deadline.');
  error.name = 'AbortError';
  return error;
}

async function readSseChunk(reader, signal) {
  if (!signal) return reader.read();
  let removeAbortListener = () => {};
  const aborted = new Promise((_, reject) => {
    const onAbort = () => {
      // A response body can outlive the original fetch promise. Cancel the
      // reader as well, otherwise a provider that opens SSE but never sends a
      // chunk leaves the editorial queue permanently blocked.
      void reader.cancel().catch(() => {});
      reject(abortedReadError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    removeAbortListener();
  }
}

async function readChatResponseBody(response, signal) {
  const contentType = String(response?.headers?.get?.('content-type') || '');
  if (!/text\/event-stream/i.test(contentType) || !response?.body?.getReader) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  try {
    while (true) {
      const { done, value } = await readSseChunk(reader, signal);
      if (done) return raw + decoder.decode();
      raw += decoder.decode(value, { stream: true });
      // Providers sometimes leave SSE connections open after an otherwise
      // complete completion. `[DONE]` is the explicit protocol terminator,
      // so stop reading there instead of converting a usable answer into a
      // timeout. The strict parser below still requires one full completion.
      if (/(?:^|\n)\s*data:\s*\[DONE\](?:\r?\n|$)/.test(raw)) {
        await reader.cancel();
        return raw + decoder.decode();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function valueKind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function contentText(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object' && !Array.isArray(value) && value.type === 'text' && typeof value.text === 'string') return value.text.trim() || null;
  if (!Array.isArray(value) || !value.length) return null;
  const parts = [];
  for (const part of value) {
    if (!part || typeof part !== 'object' || Array.isArray(part) || part.type !== 'text' || typeof part.text !== 'string') return null;
    const text = part.text.trim();
    if (text) parts.push(text);
  }
  return parts.length ? parts.join(' ') : null;
}

export function extractAnyModelCompletion(payload) {
  const firstChoice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = firstChoice && typeof firstChoice === 'object' && !Array.isArray(firstChoice)
    ? firstChoice.message
    : null;
  const messageContent = message && typeof message === 'object' && !Array.isArray(message)
    ? message.content
    : undefined;
  const shape = {
    payloadKind: valueKind(payload),
    choices: { present: Array.isArray(payload?.choices), count: Array.isArray(payload?.choices) ? payload.choices.length : null },
    choice: firstChoice && typeof firstChoice === 'object' && !Array.isArray(firstChoice)
      ? { keys: Object.keys(firstChoice).sort(), finishReason: firstChoice.finish_reason ?? null }
      : null,
    message: message && typeof message === 'object' && !Array.isArray(message)
      ? { keys: Object.keys(message).sort() }
      : null,
    content: { kind: valueKind(messageContent) },
    reasoningContent: {
      present: Boolean(message && typeof message === 'object' && Object.hasOwn(message, 'reasoning_content')),
      kind: valueKind(message?.reasoning_content),
    },
    alternativeText: {
      present: Boolean(firstChoice && typeof firstChoice === 'object' && !Array.isArray(firstChoice) && typeof firstChoice.text === 'string' && firstChoice.text.trim()),
      kind: valueKind(firstChoice?.text),
    },
  };
  const primary = contentText(messageContent);
  if (primary) {
    const source = typeof messageContent === 'string'
      ? 'choices[0].message.content.string'
      : Array.isArray(messageContent)
        ? 'choices[0].message.content.text_parts'
        : 'choices[0].message.content.text_object';
    return { content: primary, source, shape };
  }
  if (typeof firstChoice?.text === 'string' && firstChoice.text.trim()) {
    return { content: firstChoice.text.trim(), source: 'choices[0].text', shape };
  }
  return { content: null, source: null, shape };
}

export function parseAnyModelTransport(rawBody, contentType = '') {
  const body = String(rawBody || '');
  if (!body.trim()) return { payload: null, protocol: 'empty', responseParseError: 'EMPTY_BODY' };
  try {
    return { payload: JSON.parse(body), protocol: 'json', responseParseError: null };
  } catch {}
  const isSse = /text\/event-stream/i.test(String(contentType || '')) || /(?:^|\n)\s*data:\s*/.test(body);
  if (!isSse) return { payload: null, protocol: 'invalid', responseParseError: 'INVALID_JSON' };
  const data = body.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (!data.length || data.at(-1) !== '[DONE]') return { payload: null, protocol: 'sse_invalid', responseParseError: 'UNTERMINATED_SSE' };
  const chunks = data.slice(0, -1);
  if (chunks.length !== 1) return { payload: null, protocol: 'sse_invalid', responseParseError: 'UNSUPPORTED_SSE_CHUNK_COUNT' };
  try {
    const payload = JSON.parse(chunks[0]);
    // We permit only a complete OpenAI chat-completion object. Streaming deltas
    // are intentionally unsupported so private reasoning or arbitrary event
    // fields cannot become public text by concatenation.
    if (!Array.isArray(payload?.choices) || !payload.choices.length || !payload.choices[0]?.message) {
      return { payload: null, protocol: 'sse_invalid', responseParseError: 'UNSUPPORTED_SSE_SHAPE' };
    }
    return { payload, protocol: 'sse_complete_completion', responseParseError: null };
  } catch {
    return { payload: null, protocol: 'sse_invalid', responseParseError: 'INVALID_SSE_JSON' };
  }
}

export class AnyModelWriterError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'AnyModelWriterError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class AnyModelCryptoWriter {
  constructor({
    apiKey = '',
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    diagnosticDirectory = null,
    captureResponseDiagnostics = false,
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
    this.model = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.diagnosticDirectory = diagnosticDirectory ? path.resolve(diagnosticDirectory) : null;
    this.captureResponseDiagnostics = Boolean(captureResponseDiagnostics);
    this.state = this.apiKey ? 'configured' : 'missing_key';
    this.lastErrorCode = this.apiKey ? null : 'ANYMODEL_API_KEY_MISSING';
    this.lastPerformance = null;
    this.requestQueue = Promise.resolve();
    this.callAudit = [];
    this.writerCandidateBatch = null;
    this.writerCandidateMetadata = null;
  }

  status() {
    return {
      provider: 'anymodel',
      model: this.model,
      endpoint: this.baseUrl,
      configured: Boolean(this.apiKey),
      state: this.state,
      lastErrorCode: this.lastErrorCode,
      ...(this.lastPerformance ? { lastPerformance: this.lastPerformance } : {}),
    };
  }

  async initialize() {
    if (!this.apiKey) {
      this.state = 'missing_key';
      this.lastErrorCode = 'ANYMODEL_API_KEY_MISSING';
      return false;
    }
    this.state = 'ready';
    this.lastErrorCode = null;
    return true;
  }

  // Kept separate from editorial generation so an operator can distinguish a
  // provider/adapter fault from V5 orchestration without changing its prompts.
  async generateDiagnosticCompletion({ prompt = 'Return exactly OK.', maxTokens = 128 } = {}) {
    if (!(await this.initialize())) throw new AnyModelWriterError('ANYMODEL_API_KEY_MISSING', 'AnyModel writer requires ANYMODEL_API_KEY.');
    this.callAudit = [];
    const content = await this.#chat({
      stage: 'diagnostic',
      system: 'Return only the exact requested short response.',
      user: String(prompt || 'Return exactly OK.'),
      temperature: 0,
      maxTokens: Math.max(1, Math.min(4_800, Number(maxTokens) || 128)),
    });
    return { content, audit: { ...this.callAudit.at(-1) } };
  }

  async generateV4({ candidate, factPack, editorialHistory = [] } = {}) {
    if (!(await this.initialize())) throw new AnyModelWriterError('ANYMODEL_API_KEY_MISSING', 'AnyModel writer requires ANYMODEL_API_KEY.');
    const { V4EditorialPipeline } = await import('./v4-editorial-pipeline.js');
    this.callAudit = [];
    this.writerCandidateBatch = null;
    this.writerCandidateMetadata = null;
    const pipeline = new V4EditorialPipeline({
      invoke: async ({ stage, system, user }) => this.#invokeStage({ stage, system, user, factPack }),
    });
    try {
      const result = await pipeline.generate({ factPack, candidate, editorialHistory });
      const provider = this.#providerAudit();
      this.lastPerformance = provider.summary;
      return {
        ...result,
        provider: 'anymodel',
        model: this.model,
        audit: { ...(result.audit || {}), writerCandidateMetadata: this.writerCandidateMetadata, provider },
      };
    } catch (error) {
      this.lastErrorCode = String(error?.code || 'ANYMODEL_UNAVAILABLE');
      this.state = 'offline';
      throw error;
    } finally {
      this.writerCandidateBatch = null;
    }
  }

  async generateV5({ candidate, factPack, editorialHistory = [], diagnostic = null } = {}) {
    if (!(await this.initialize())) throw new AnyModelWriterError('ANYMODEL_API_KEY_MISSING', 'AnyModel writer requires ANYMODEL_API_KEY.');
    const { V5EditorialPipeline } = await import('./v5-editorial-pipeline.js');
    this.callAudit = [];
    const budgets = { ...V5_STAGE_TOKEN_BUDGETS, ...(diagnostic?.stageTokenBudgets || {}) };
    const requestOptions = diagnostic ? {
      timeoutMs: Number.isFinite(Number(diagnostic.timeoutMs)) ? Number(diagnostic.timeoutMs) : this.timeoutMs,
      maxAttempts: Number.isFinite(Number(diagnostic.maxAttempts)) ? Number(diagnostic.maxAttempts) : 1,
      retryDelayMs: Number.isFinite(Number(diagnostic.retryDelayMs)) ? Number(diagnostic.retryDelayMs) : null,
    } : {};
    const pipeline = new V5EditorialPipeline({ invoke: async ({ stage, system, user }) => this.#chat({
      stage,
      system,
      user,
      temperature: stage === 'critic' || stage === 'analyst_brain' ? 0.2 : 0.55,
      maxTokens: v5StageMaxTokens(stage, budgets),
      ...requestOptions,
    }) });
    try {
      const result = await pipeline.generate({ factPack, candidate, editorialHistory });
      const provider = this.#providerAudit();
      this.lastPerformance = provider.summary;
      return { ...result, provider: 'anymodel', model: this.model, audit: { ...(result.audit || {}), provider } };
    } catch (error) {
      this.lastErrorCode = String(error?.code || 'ANYMODEL_UNAVAILABLE');
      this.state = 'offline';
      throw error;
    }
  }

  async #invokeStage({ stage, system, user, factPack }) {
    if (WRITER_STAGES.has(stage)) {
      if (!this.writerCandidateBatch) this.writerCandidateBatch = this.#requestWriterCandidates({ user, factPack });
      const candidates = await this.writerCandidateBatch;
      return stage === 'writer_reflection' ? candidates.candidateA.text : candidates.candidateB.text;
    }
    return this.#chat({ stage, system: this.#systemForStage(stage, system), user });
  }

  #systemForStage(stage, fallback) {
    if (stage === 'trader_thought' || stage === 'trader_thought_repair') {
      return 'You form private trader reasoning from verified evidence only. Return the requested nine labelled lines. Do not claim past trades, personal experience, positions, or unsupplied facts. If no prior persisted analysis is supplied, use present-tense openings such as "My first read" or "At first glance", never "I expected".';
    }
    if (stage === 'critic') return 'You are a strict crypto social editor. Return only the requested PASS or ISSUE structure. Judge factual grounding, human reasoning, useful level explanation, preferred scenario, future expectation, invalidation, and non-template rhythm.';
    if (stage === 'repair' || stage === 'writer_contract_repair') return 'You are a precise English social writer. Return only fresh public copy grounded in the supplied Fact Pack and private thought. Never invent facts, prices, causality, personal history, a trade, a position, or a prior expectation.';
    if (stage === 'planner') return 'You plan a factual crypto story from immutable supplied facts. Return only the requested internal lines. Never invent facts or causality.';
    return fallback;
  }

  async #requestWriterCandidates({ user, factPack }) {
    const allowedClaimIds = (factPack?.numbersAllowed || []).map((claim) => claim.key).filter(Boolean);
    const allowedLevelIds = [
      ...(factPack?.levels?.supports || []),
      ...(factPack?.levels?.resistances || []),
    ].map((level) => level?.id).filter(Boolean);
    const request = `${user}\n\nReturn exactly one JSON object, with no markdown: {"candidateA":{"text":"...","thesis":"...","preferredScenario":"...","invalidationClaimId":"level id or null","usedClaimIds":["allowed claim id"],"usedLevelIds":["allowed level id"]},"candidateB":{same fields}}. Candidate A must begin with a change or refinement of the view; Candidate B must begin with a doubt, a level, or a detail a trader might miss. They must differ in at least two of opening function, reveal order, paragraph rhythm, level order, or ending job. Metadata may cite only these claim ids: ${JSON.stringify(allowedClaimIds)} and level ids: ${JSON.stringify(allowedLevelIds)}.`;
    let raw = await this.#chat({
      stage: 'writer_candidates',
      system: 'You are the active Kimi editorial Writer. Create two materially different, natural English crypto posts from the supplied verified Fact Pack and private Story Brief. Never invent a fact, price, research source, personal history, trade, position, or causal explanation. Keep the public thought human and uneven, not an analyst template.',
      user: request,
      temperature: 0.72,
      // K3 expends a substantial hidden-reasoning budget before emitting
      // visible JSON. Leave room for that work and both public candidates.
      maxTokens: 4_800,
    });
    try {
      const candidates = this.#validateCandidatePackage(raw, { allowedClaimIds, allowedLevelIds });
      this.writerCandidateMetadata = candidates;
      return candidates;
    } catch (error) {
      raw = await this.#chat({
        stage: 'writer_candidates_format_repair',
        system: 'Return valid JSON only. Preserve no extra commentary and use only the requested candidate schema.',
        user: `${request}\n\nYour previous response was not valid for the required schema. Reformat this response into the schema without adding facts:\n${compact(raw, 8_000)}`,
        temperature: 0,
        maxTokens: 4_800,
      });
      const candidates = this.#validateCandidatePackage(raw, { allowedClaimIds, allowedLevelIds });
      this.writerCandidateMetadata = candidates;
      return candidates;
    }
  }

  #validateCandidatePackage(raw, { allowedClaimIds, allowedLevelIds }) {
    let parsed;
    try {
      parsed = JSON.parse(stripJsonFence(raw));
    } catch {
      throw new AnyModelWriterError('ANYMODEL_WRITER_JSON_INVALID', 'AnyModel Writer did not return valid candidate JSON.');
    }
    const validateCandidate = (value, label) => {
      if (!value || typeof value !== 'object' || !String(value.text || '').trim()) throw new AnyModelWriterError('ANYMODEL_WRITER_SCHEMA_INVALID', `${label} is missing text.`);
      const usedClaimIds = Array.isArray(value.usedClaimIds) ? value.usedClaimIds.map(String) : [];
      const usedLevelIds = Array.isArray(value.usedLevelIds) ? value.usedLevelIds.map(String) : [];
      if (usedClaimIds.some((id) => !allowedClaimIds.includes(id)) || usedLevelIds.some((id) => !allowedLevelIds.includes(id))) throw new AnyModelWriterError('ANYMODEL_WRITER_SCHEMA_INVALID', `${label} referenced a value outside the Fact Pack.`);
      const invalidationClaimId = value.invalidationClaimId == null ? null : String(value.invalidationClaimId);
      if (invalidationClaimId && !allowedLevelIds.includes(invalidationClaimId)) throw new AnyModelWriterError('ANYMODEL_WRITER_SCHEMA_INVALID', `${label} invalidation is outside the Fact Pack.`);
      return {
        text: String(value.text).trim(),
        thesis: compact(value.thesis, 360),
        preferredScenario: compact(value.preferredScenario, 360),
        invalidationClaimId,
        usedClaimIds,
        usedLevelIds,
      };
    };
    return { candidateA: validateCandidate(parsed?.candidateA, 'candidateA'), candidateB: validateCandidate(parsed?.candidateB, 'candidateB') };
  }

  async #chat({ stage, system, user, temperature = 0.3, maxTokens = DEFAULT_EDITORIAL_MAX_TOKENS, timeoutMs = this.timeoutMs, maxAttempts = MAX_TRANSIENT_ATTEMPTS, retryDelayMs = null }) {
    const work = async () => {
      const startedAt = Date.now();
      let lastError;
      const attemptsLimit = Math.max(1, Math.min(MAX_TRANSIENT_ATTEMPTS, Math.floor(Number(maxAttempts) || 1)));
      const boundedTimeoutMs = Math.max(1, Math.floor(Number(timeoutMs) || this.timeoutMs));
      for (let attempt = 0; attempt < attemptsLimit; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), boundedTimeoutMs);
        try {
          const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature, max_tokens: maxTokens, stream: false }),
            signal: controller.signal,
          });
          const headersAt = Date.now();
          const rawBody = await readChatResponseBody(response, controller.signal);
          const completedAt = Date.now();
          const parsedTransport = parseAnyModelTransport(rawBody, response.headers.get('content-type'));
          const payload = parsedTransport.payload;
          const responseParseError = parsedTransport.responseParseError;
          const completion = extractAnyModelCompletion(payload);
          const shouldCapture = this.captureResponseDiagnostics || !response.ok || !completion.content;
          const diagnosticPath = shouldCapture
            ? await this.#captureResponseDiagnostic({ stage, response, payload, completion, rawBody, responseParseError })
            : null;
          if (!response.ok) {
            const retryable = response.status === 429 || response.status >= 500;
            const providerErrorCode = String(payload?.error?.code || '').toLowerCase();
            const quotaExhausted = response.status === 402 || providerErrorCode === 'payment_required';
            const error = new AnyModelWriterError(
              response.status === 401 || response.status === 403 ? 'ANYMODEL_AUTH_FAILED' : quotaExhausted ? 'ANYMODEL_QUOTA_EXHAUSTED' : retryable ? 'ANYMODEL_TRANSIENT_ERROR' : 'ANYMODEL_REQUEST_FAILED',
              `AnyModel request failed with HTTP ${response.status}.`,
              { retryable },
            );
            error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
            error.diagnosticPath = diagnosticPath;
            throw error;
          }
          if (!completion.content) {
            const error = new AnyModelWriterError('ANYMODEL_INVALID_RESPONSE', 'AnyModel response did not match a supported chat completion text shape.');
            error.responseShape = completion.shape;
            error.diagnosticPath = diagnosticPath;
            error.callAuditMeta = {
              headersAt: new Date(headersAt).toISOString(),
              headersLatencyMs: headersAt - startedAt,
              bodyDurationMs: completedAt - headersAt,
              responseBytes: Buffer.byteLength(rawBody),
              maxTokens,
              finishReason: payload?.choices?.[0]?.finish_reason ?? null,
              usage: numericUsage(payload?.usage),
              contentSource: completion.source,
              contentPresent: false,
              transportProtocol: parsedTransport.protocol,
            };
            throw error;
          }
          this.callAudit.push({
            stage,
            status: 'ok',
            startedAt: new Date(startedAt).toISOString(),
            headersAt: new Date(headersAt).toISOString(),
            completedAt: new Date(completedAt).toISOString(),
            headersLatencyMs: headersAt - startedAt,
            bodyDurationMs: completedAt - headersAt,
            totalDurationMs: completedAt - startedAt,
            latencyMs: completedAt - startedAt,
            responseBytes: Buffer.byteLength(rawBody),
            attempts: attempt + 1,
            maxAttempts: attemptsLimit,
            timeoutMs: boundedTimeoutMs,
            maxTokens,
            finishReason: payload?.choices?.[0]?.finish_reason ?? null,
            usage: numericUsage(payload?.usage),
            contentSource: completion.source,
            contentPresent: Boolean(completion.content),
            transportProtocol: parsedTransport.protocol,
            ...(diagnosticPath ? { diagnosticPath } : {}),
          });
          return completion.content;
        } catch (error) {
          let diagnosticPath = error?.diagnosticPath || null;
          // A transport failure has no provider envelope to audit later. Keep
          // one sanitized error artifact whenever a diagnostic directory is
          // available, even when successful-response capture is disabled.
          if (!diagnosticPath && this.diagnosticDirectory) {
            try {
              diagnosticPath = await this.#captureTransportFailureDiagnostic({ stage, error });
            } catch { /* transport diagnostics never hide the real provider failure */ }
          }
          const normalized = error instanceof AnyModelWriterError
            ? error
            : new AnyModelWriterError(error?.name === 'AbortError' ? 'ANYMODEL_TIMEOUT' : 'ANYMODEL_UNAVAILABLE', 'AnyModel request was unavailable.', { retryable: true });
          if (diagnosticPath && !normalized.diagnosticPath) normalized.diagnosticPath = diagnosticPath;
          lastError = normalized;
          if (!normalized.retryable || attempt === attemptsLimit - 1) {
            const completedAt = Date.now();
            this.callAudit.push({
              stage,
              status: 'error',
              startedAt: new Date(startedAt).toISOString(),
              completedAt: new Date(completedAt).toISOString(),
              totalDurationMs: completedAt - startedAt,
              latencyMs: completedAt - startedAt,
              attempts: attempt + 1,
              maxAttempts: attemptsLimit,
              timeoutMs: boundedTimeoutMs,
              maxTokens,
              code: normalized.code,
              ...(normalized.callAuditMeta || {}),
              ...(normalized.diagnosticPath ? { diagnosticPath: normalized.diagnosticPath } : {}),
            });
            throw normalized;
          }
          await this.sleep(normalized.retryAfterMs ?? (retryDelayMs !== null && retryDelayMs !== undefined && Number.isFinite(Number(retryDelayMs)) ? Math.max(1_000, Math.min(3_000, Number(retryDelayMs))) : 300 * (attempt + 1)));
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError;
    };
    const pending = this.requestQueue.then(work, work);
    this.requestQueue = pending.catch(() => {});
    return pending;
  }

  async #captureResponseDiagnostic({ stage, response, payload, completion, rawBody, responseParseError }) {
    if (!this.diagnosticDirectory) return null;
    const safeStage = String(stage || 'chat').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'chat';
    const fileName = `anymodel-response-${Date.now()}-${safeStage}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filePath = path.join(this.diagnosticDirectory, fileName);
    const artifact = {
      schemaVersion: 1,
      kind: 'anymodel_chat_completion_response',
      capturedAt: new Date().toISOString(),
      request: {
        endpoint: `${this.baseUrl}/chat/completions`,
        model: this.model,
        stage: safeStage,
        stream: false,
      },
      http: {
        status: Number(response?.status) || null,
        statusText: String(response?.statusText || ''),
        headers: sanitizeResponseHeaders(response?.headers),
      },
      transportShape: transportShape({ rawBody, headers: response?.headers, responseParseError }),
      completionShape: completion?.shape || null,
      ...(responseParseError ? { responseParseError, rawBody: sanitizeRawResponseText(rawBody) } : {}),
      response: sanitizeResponseValue(payload),
    };
    await mkdir(this.diagnosticDirectory, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return filePath;
  }

  async #captureTransportFailureDiagnostic({ stage, error }) {
    if (!this.diagnosticDirectory) return null;
    const safeStage = String(stage || 'chat').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'chat';
    const fileName = `anymodel-transport-failure-${Date.now()}-${safeStage}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filePath = path.join(this.diagnosticDirectory, fileName);
    const artifact = {
      schemaVersion: 1,
      kind: 'anymodel_transport_failure',
      capturedAt: new Date().toISOString(),
      request: {
        endpoint: `${this.baseUrl}/chat/completions`,
        model: this.model,
        stage: safeStage,
        stream: false,
      },
      http: { status: null, statusText: '', headers: {} },
      error: sanitizedTransportError(error),
    };
    await mkdir(this.diagnosticDirectory, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return filePath;
  }

  #providerAudit() {
    const calls = this.callAudit.map((call) => ({ ...call }));
    const summary = {
      latencyMs: calls.reduce((total, call) => total + (Number(call.latencyMs) || 0), 0),
      promptTokens: calls.reduce((total, call) => total + (Number(call.usage?.promptTokens) || 0), 0),
      completionTokens: calls.reduce((total, call) => total + (Number(call.usage?.completionTokens) || 0), 0),
      totalTokens: calls.reduce((total, call) => total + (Number(call.usage?.totalTokens) || 0), 0),
    };
    return { provider: 'anymodel', model: this.model, calls, summary };
  }
}
