import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AppServerClient, extractAssistantText } from './app-server-client.js';
import { activityFromItem } from './activity.js';
import { compactThreadTitle, isJarvisThread, threadDetail, threadSummary } from './thread-view.js';
import { EXECUTION_POLICY, classifyExecutionRequest } from './execution-policy.js';

function userFacingError(error) {
  const message = String(error?.message || error);
  if (/ENOENT|not recognized|не является/i.test(message)) {
    return 'JARVIS не смог запустить локальный сервис. Проверьте установку и перезапустите приложение.';
  }
  if (error?.code === 'AUTH_REQUIRED' || /token[_ -]?revoked|unauthorized|authentication|login|auth|\b401\b/i.test(message)) {
    return 'JARVIS не авторизован. Выполните вход и повторите запрос.';
  }
  if (error?.code === 'MODEL_UNAVAILABLE') {
    return 'Настроенная модель Codex недоступна для текущего аккаунта.';
  }
  if (/connection|network|internet|HttpConnectionFailed/i.test(message)) {
    return 'Не удалось подключиться к локальному сервису или интернету. Проверьте соединение и повторите.';
  }
  return 'JARVIS не смог завершить запрос. Подробности сохранены в локальном журнале.';
}

function isMissingThreadError(error) {
  return error?.code === 'NOT_FOUND' || /\bthread not loaded\b/i.test(String(error?.message || error));
}

function isAuthError(error) {
  return error?.code === 'AUTH_REQUIRED'
    || /token[_ -]?revoked|unauthorized|authentication|login|auth|\b401\b/i.test(String(error?.message || error));
}

function runtimeState() {
  return {
    resumed: false,
    activeTurn: false,
    activeTurnId: null,
    turnWatchdog: null,
    turnWatchdogChecks: 0,
    deleting: false,
    activeItem: null,
    assistantText: '',
    queue: [],
    activities: new Map(),
    status: { state: 'idle', detail: 'Готов к запросу.' },
  };
}

function approvalDetails(message) {
  const params = message.params || {};
  const isNetwork = Boolean(params.networkApprovalContext);
  const availableDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.filter((decision) => typeof decision === 'string')
    : [];
  return {
    id: message.id,
    method: message.method,
    threadId: params.threadId,
    turnId: params.turnId || null,
    itemId: params.itemId || null,
    kind: isNetwork ? 'network' : message.method.includes('fileChange') ? 'file-change' : 'command',
    reason: params.reason || (isNetwork ? 'JARVIS запрашивает сетевой доступ.' : 'JARVIS запрашивает разрешение.'),
    command: Array.isArray(params.command) ? params.command.join(' ') : params.command || null,
    commandActions: Array.isArray(params.commandActions) ? structuredClone(params.commandActions) : [],
    cwd: params.cwd || null,
    target: params.networkApprovalContext?.host || params.grantRoot || null,
    grantRoot: params.grantRoot || null,
    networkApprovalContext: params.networkApprovalContext || null,
    permissions: params.permissions || null,
    availableDecisions,
  };
}

function approvalWireDecision(pending, decision) {
  const available = pending.approval?.availableDecisions || [];
  if (available.length === 0 || available.includes(decision)) return decision;
  if (decision === 'decline' && available.includes('cancel')) return 'cancel';
  const error = new Error('Approval decision is not available for this request.');
  error.code = 'INVALID_DECISION';
  throw error;
}

function rawThread(result) {
  return result?.thread || result;
}

function rawThreadList(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.threads)) return result.threads;
  return Array.isArray(result) ? result : [];
}

function isTransientThreadReadError(error) {
  const message = String(error?.message || error);
  return /rollout.*empty|failed to read (?:canonical )?session metadata/i.test(message);
}

function publicAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
  };
}

function publicQueueItem(item) {
  return {
    id: item.id,
    message: item.message,
    attachments: item.attachments.map(publicAttachment),
    createdAt: item.createdAt,
    source: item.source,
  };
}

export class JarvisSession {
  constructor({
    projectRoot,
    clientFactory,
    logDirectory = path.join(projectRoot, 'logs'),
    onDeleteThread,
    approvalTtlMs = 60_000,
    approvalResolutionTtlMs = 10_000,
    turnWatchdogMs = 90_000,
    turnWatchdogMaxChecks = 2,
    deleteInterruptTtlMs = 5_000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    now = () => Date.now(),
    threadReadRetryDelays = [40, 80, 160, 320, 640],
    sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    this.projectRoot = projectRoot;
    this.clientFactory = clientFactory || ((options) => new AppServerClient(options));
    this.logDirectory = logDirectory;
    this.onDeleteThread = onDeleteThread || (async () => {});
    this.events = new EventEmitter();
    this.client = null;
    this.activeThreadId = null;
    this.ownedThreadIds = new Set();
    this.runtimes = new Map();
    this.pendingApprovals = new Map();
    this.respondedApprovalIds = new Set();
    this.titleAttempts = new Set();
    this.approvalTtlMs = approvalTtlMs;
    this.approvalResolutionTtlMs = approvalResolutionTtlMs;
    this.turnWatchdogMs = turnWatchdogMs;
    this.turnWatchdogMaxChecks = turnWatchdogMaxChecks;
    this.deleteInterruptTtlMs = deleteInterruptTtlMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.now = now;
    this.threadReadRetryDelays = [...threadReadRetryDelays];
    this.sleepImpl = sleepImpl;
  }

  status(threadId = this.activeThreadId) {
    if (!threadId) return { state: 'idle', detail: 'Готов к запросу.' };
    return { ...this.#runtime(threadId).status };
  }

  subscribe(listener) {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  async executionContext(options = {}) {
    try {
      const client = await this.#getClient();
      const context = await client.executionContext(options);
      if (!context?.healthy || !context?.model || !context?.fingerprint) {
        const error = new Error('Codex execution context is incomplete.');
        error.code = 'MODEL_UNAVAILABLE';
        throw error;
      }
      return {
        healthy: true,
        authMode: String(context.authMode || 'authenticated').slice(0, 40),
        planType: String(context.planType || 'unknown').slice(0, 40),
        model: String(context.model).slice(0, 120),
        fingerprint: String(context.fingerprint).slice(0, 128),
      };
    } catch (error) {
      throw await this.#publicError(error);
    }
  }

  async createThread({ activate = true } = {}) {
    try {
      const client = await this.#getClient();
      const thread = this.#verifiedThread(await client.startThread());
      const runtime = this.#runtime(thread.id);
      runtime.resumed = true;
      if (activate) this.activeThreadId = thread.id;
      const detail = this.#activeThread(thread, runtime);
      this.#emit({ type: 'thread-created', threadId: thread.id, thread: detail });
      return detail;
    } catch (error) {
      throw await this.#publicError(error);
    }
  }

  async listThreads(options = {}) {
    try {
      const client = await this.#getClient();
      let result = await client.listThreads({ ...options, sourceKinds: ['appServer'] });
      let verifiedThreads = await this.#verifiedListedThreads(client, result);
      if (verifiedThreads.length === 0) {
        result = await client.listThreads({ ...options, sourceKinds: null });
        verifiedThreads = await this.#verifiedListedThreads(client, result);
      }
      return {
        data: this.#threadSummaries(verifiedThreads),
        nextCursor: typeof result?.nextCursor === 'string' ? result.nextCursor : null,
      };
    } catch (error) {
      throw await this.#publicError(error);
    }
  }

  async readThread(threadId, { activate = true } = {}) {
    try {
      const client = await this.#getClient();
      const thread = this.#verifiedThread(await this.#readThreadWithRetry(client, threadId));
      if (activate) this.activeThreadId = thread.id;
      this.#rememberExistingTitle(thread);
      return this.#activeThread(thread, this.#runtime(thread.id));
    } catch (error) {
      throw await this.#publicError(error, threadId);
    }
  }

  async resumeThread(threadId) {
    try {
      const client = await this.#getClient();
      const thread = this.#verifiedThread(await client.resumeThread(threadId));
      const runtime = this.#runtime(thread.id);
      runtime.resumed = true;
      this.activeThreadId = thread.id;
      this.#rememberExistingTitle(thread);
      return this.#activeThread(thread, runtime);
    } catch (error) {
      throw await this.#publicError(error, threadId);
    }
  }

  async renameThread(threadId, name) {
    const normalized = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (!normalized) throw new Error('Название чата не может быть пустым.');
    try {
      const client = await this.#getClient();
      await client.setThreadName(threadId, normalized);
      this.titleAttempts.add(threadId);
      this.#emit({ type: 'thread-renamed', threadId, name: normalized });
      return { threadId, name: normalized };
    } catch (error) {
      throw await this.#publicError(error, threadId);
    }
  }

  async deleteThread(threadId) {
    const runtime = this.runtimes.get(threadId);
    try {
      const client = await this.#getClient();
      if (runtime?.activeTurn) await this.#interruptForDeletion(threadId, runtime, client);
      await client.deleteThread(threadId);
      await this.onDeleteThread(threadId);
      this.#clearTurnWatchdog(this.runtimes.get(threadId));
      this.runtimes.delete(threadId);
      this.ownedThreadIds.delete(threadId);
      this.titleAttempts.delete(threadId);
      for (const [id, approval] of this.pendingApprovals) {
        if (approval.threadId === threadId) this.#clearPendingApproval(id);
      }
      if (this.activeThreadId === threadId) this.activeThreadId = null;
      this.#emit({ type: 'thread-deleted', threadId });
      return { deleted: true, threadId };
    } catch (error) {
      if (runtime?.deleting) {
        runtime.deleting = false;
        this.#emit({ type: 'queue', threadId, items: this.#queueSnapshot(runtime) });
      }
      throw await this.#publicError(error, threadId);
    }
  }

  async send({ threadId, message, attachments = [], source = 'ui', additionalContext } = {}) {
    if (typeof threadId !== 'string' || !threadId) throw new Error('Не выбран чат JARVIS.');
    if (typeof message !== 'string') throw new Error('Сообщение JARVIS должно быть текстом.');
    const safeAttachments = Array.isArray(attachments) ? attachments.map((attachment) => ({ ...attachment })) : [];
    const contextEntries = additionalContext && typeof additionalContext === 'object' && !Array.isArray(additionalContext)
      ? Object.values(additionalContext)
      : [];
    if (additionalContext !== undefined && (
      contextEntries.length === 0
      || contextEntries.some((entry) => !entry || !['application', 'untrusted'].includes(entry.kind) || typeof entry.value !== 'string')
    )) throw new Error('Typed JARVIS context is invalid.');
    const runtime = this.#runtime(threadId);
    const queuedItem = {
      kind: 'user',
      id: randomUUID(),
      message,
      attachments: safeAttachments,
      createdAt: new Date().toISOString(),
      source: source === 'voice' ? 'voice' : source === 'crypto' ? 'crypto' : 'ui',
      ...(contextEntries.length > 0 ? { additionalContext: structuredClone(additionalContext) } : {}),
    };

    if (runtime.activeTurn) {
      runtime.queue.push(queuedItem);
      const queue = this.#queueSnapshot(runtime);
      this.#emit({ type: 'queue', threadId, items: queue });
      return { accepted: true, disposition: 'queued', threadId, itemId: queuedItem.id, queue };
    }

    try {
      const turnStartedAtUnixMs = await this.#startTurn(threadId, queuedItem);
      return {
        accepted: true,
        disposition: 'started',
        threadId,
        itemId: queuedItem.id,
        queue: this.#queueSnapshot(runtime),
        turnStartedAtUnixMs,
      };
    } catch (error) {
      throw await this.#publicError(error, threadId);
    }
  }

  async runAutomationTurn({ threadId, additionalContext, outputSchema } = {}) {
    if (typeof threadId !== 'string' || !threadId) throw new Error('A JARVIS thread is required for automation.');
    const contextEntries = additionalContext && typeof additionalContext === 'object' && !Array.isArray(additionalContext)
      ? Object.values(additionalContext)
      : [];
    if (
      contextEntries.length === 0
      || contextEntries.some((entry) => !entry || !['application', 'untrusted'].includes(entry.kind) || typeof entry.value !== 'string')
    ) throw new Error('Typed automation context is required.');
    if (!outputSchema || typeof outputSchema !== 'object') throw new Error('An automation output schema is required.');
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const item = {
      kind: 'automation',
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      additionalContext: structuredClone(additionalContext),
      outputSchema: structuredClone(outputSchema),
      resolve: resolveCompletion,
      reject: rejectCompletion,
    };
    const runtime = this.#runtime(threadId);
    if (runtime.activeTurn) {
      runtime.queue.push(item);
      this.#emit({ type: 'queue', threadId, items: this.#queueSnapshot(runtime) });
      return completion;
    }
    try {
      await this.#startTurn(threadId, item);
    } catch (error) {
      throw await this.#publicError(error, threadId);
    }
    return completion;
  }

  async removeQueued(threadId, queueId) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return { removed: false, threadId, queue: [] };
    const index = runtime.queue.findIndex((item) => item.kind !== 'automation' && item.id === queueId);
    if (index === -1) {
      return { removed: false, threadId, queue: this.#queueSnapshot(runtime) };
    }
    runtime.queue.splice(index, 1);
    const queue = this.#queueSnapshot(runtime);
    this.#emit({ type: 'queue', threadId, items: queue });
    return { removed: true, threadId, queue };
  }

  async respondToApproval(id, decision) {
    if (decision !== 'accept' && decision !== 'decline') {
      throw new Error('Approval decision must be accept or decline.');
    }
    const pending = this.pendingApprovals.get(id);
    if (!pending || pending.visibility !== 'user') {
      const error = new Error('Approval request is not pending.');
      error.code = 'NOT_FOUND';
      throw error;
    }
    if (pending.responseSentAt !== null) {
      const error = new Error('Approval request was already answered and is awaiting App Server resolution.');
      error.code = 'ALREADY_ANSWERED';
      throw error;
    }
    try {
      await this.#getClient();
      this.#sendApprovalResponse(id, pending, decision);
      return { id, decision, threadId: pending.threadId, pending: true };
    } catch (error) {
      throw await this.#publicError(error, pending.threadId);
    }
  }

  async reset() {
    const client = this.client;
    this.client = null;
    await client?.stop();
    for (const runtime of this.runtimes.values()) this.#rejectAutomation(runtime, new Error('JARVIS session reset.'));
    for (const runtime of this.runtimes.values()) this.#clearTurnWatchdog(runtime);
    this.runtimes.clear();
    this.ownedThreadIds.clear();
    this.#clearAllApprovals();
    this.respondedApprovalIds.clear();
    this.titleAttempts.clear();
    this.activeThreadId = null;
    return { reset: true };
  }

  async stop() {
    const client = this.client;
    this.client = null;
    if (client) {
      for (const [id] of this.pendingApprovals) {
        try { client.respondToServerRequest(id, { decision: 'decline' }); } catch {}
      }
    }
    this.#clearAllApprovals();
    await client?.stop();
    for (const [threadId, runtime] of this.runtimes) {
      this.#rejectAutomation(runtime, new Error('JARVIS stopped.'));
      this.#clearTurnWatchdog(runtime);
      runtime.activeTurn = false;
      runtime.activeTurnId = null;
      runtime.activeItem = null;
      this.#setStatus(threadId, 'stopped', 'JARVIS остановлен.');
    }
  }

  #runtime(threadId) {
    let runtime = this.runtimes.get(threadId);
    if (!runtime) {
      runtime = runtimeState();
      this.runtimes.set(threadId, runtime);
    }
    return runtime;
  }

  #activeThread(thread, runtime) {
    const detail = threadDetail(thread);
    if (!detail) throw new Error('Unsafe JARVIS thread response.');
    return {
      ...detail,
      queue: this.#queueSnapshot(runtime),
      status: { ...runtime.status },
    };
  }

  #verifiedThread(result) {
    let thread = rawThread(result);
    if (
      thread?.threadSource == null
      && this.ownedThreadIds.has(thread?.id)
      && isJarvisThread({ ...thread, threadSource: 'jarvis-local' }, this.projectRoot)
    ) {
      thread = { ...thread, threadSource: 'jarvis-local' };
    }
    if (!isJarvisThread(thread, this.projectRoot)) throw new Error('Unsafe JARVIS thread response.');
    this.ownedThreadIds.add(thread.id);
    return thread;
  }

  async #verifiedListedThreads(client, result) {
    const verified = [];
    for (const candidate of rawThreadList(result)) {
      try {
        verified.push(this.#verifiedThread(candidate));
        continue;
      } catch {}
      if (
        candidate?.threadSource != null
        || typeof candidate?.id !== 'string'
        || !isJarvisThread({ ...candidate, threadSource: 'jarvis-local' }, this.projectRoot)
      ) continue;
      try {
        verified.push(this.#verifiedThread(await this.#readThreadWithRetry(client, candidate.id)));
      } catch {
        // Source-less list rows are not trusted unless their full thread is verified.
      }
    }
    return verified;
  }

  async #readThreadWithRetry(client, threadId) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.readThread(threadId);
      } catch (error) {
        const delay = this.threadReadRetryDelays[attempt];
        if (!isTransientThreadReadError(error) || delay === undefined) throw error;
        await this.sleepImpl(delay);
      }
    }
  }

  #threadSummaries(verifiedThreads) {
    const summaries = [];
    for (const thread of verifiedThreads) {
      this.#rememberExistingTitle(thread);
      const summary = threadSummary(thread);
      if (summary) summaries.push(summary);
    }
    return summaries.filter(Boolean);
  }

  #rememberExistingTitle(thread) {
    if (typeof thread?.name === 'string' && thread.name.trim()) this.titleAttempts.add(thread.id);
  }

  #queueSnapshot(runtime) {
    return runtime.queue.filter((item) => item.kind !== 'automation').map(publicQueueItem);
  }

  async #startTurn(threadId, item) {
    const runtime = this.#runtime(threadId);
    runtime.activeTurn = true;
    runtime.activeTurnId = null;
    runtime.turnWatchdogChecks = 0;
    runtime.activeItem = item;
    runtime.assistantText = '';
    this.#setStatus(threadId, 'working', 'JARVIS обрабатывает запрос…');
    if (item.kind === 'automation') {
      this.#emit({ type: 'automation-started', threadId, automationId: item.id });
    } else {
      this.#emit({
        type: 'turn-started',
        threadId,
        itemId: item.id,
        source: item.source,
        message: item.message,
        attachments: item.attachments.map(publicAttachment),
      });
    }

    try {
      const client = await this.#getClient();
      if (!runtime.resumed) {
        const thread = this.#verifiedThread(await client.resumeThread(threadId));
        runtime.resumed = true;
        this.#rememberExistingTitle(thread);
      }
      let started;
      if (item.kind === 'automation') {
        started = await client.startTurn(threadId, [], {
          automation: true,
          additionalContext: item.additionalContext,
          outputSchema: item.outputSchema,
        });
      } else {
        const input = [
          { type: 'text', text: item.message },
          ...item.attachments.map((attachment) => ({ type: 'localImage', path: attachment.path })),
        ];
        if (item.additionalContext) {
          started = await client.startTurn(threadId, input, { additionalContext: item.additionalContext });
        } else {
          started = await client.startTurn(threadId, input);
        }
        this.#persistFirstTitle(client, threadId, item.message);
      }
      runtime.activeTurnId = started?.turn?.id || started?.turnId || null;
      this.#scheduleTurnWatchdog(threadId, item.id);
      return this.now();
    } catch (error) {
      runtime.activeTurn = false;
      runtime.activeTurnId = null;
      runtime.activeItem = null;
      throw error;
    }
  }

  #persistFirstTitle(client, threadId, message) {
    const title = compactThreadTitle(message);
    if (!title || this.titleAttempts.has(threadId)) return;
    this.titleAttempts.add(threadId);
    Promise.resolve(client.setThreadName(threadId, title)).catch((error) => {
      void this.#log('error', `Не удалось сохранить заголовок чата: ${String(error?.message || error)}`);
    });
  }

  async #getClient() {
    if (this.client) return this.client;
    const client = this.clientFactory({
      cwd: this.projectRoot,
      logger: (level, message) => this.#log(level, message),
    });
    client.on('notification', (message) => {
      if (this.client === client) this.#handleNotification(message);
    });
    client.on('serverRequest', (message) => {
      if (this.client === client) this.#handleServerRequest(message);
    });
    client.on('fatal', (error) => {
      if (this.client !== client) return;
      for (const threadId of this.runtimes.keys()) this.#handleError(error, threadId);
    });
    this.client = client;
    return client;
  }

  #handleNotification(message) {
    const params = message?.params || {};
    if (message?.method === 'account/updated') {
      this.client?.invalidateExecutionContext?.();
      for (const runtime of this.runtimes.values()) runtime.resumed = false;
      this.#emit({ type: 'codex-execution-context-changed' });
      return;
    }
    const threadId = params.threadId;
    if (typeof threadId !== 'string' || !threadId) {
      void this.#log('error', `Уведомление App Server без threadId: ${String(message?.method || 'unknown')}`);
      return;
    }
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      void this.#log('info', `Уведомление для неизвестного JARVIS thread: ${threadId}`);
      return;
    }

    if (message.method === 'serverRequest/resolved') {
      this.#handleApprovalResolved(params.requestId, threadId);
      return;
    }

    if (message.method === 'item/agentMessage/delta') {
      if (typeof params.delta === 'string' && params.delta) {
        this.#emit({ type: 'assistant-delta', threadId, text: params.delta });
      }
      return;
    }

    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item || {};
      if (message.method === 'item/completed' && item.type === 'agentMessage') {
        const text = extractAssistantText(item);
        if (text) runtime.assistantText = text;
      }
      const phase = message.method === 'item/started' ? 'started' : 'completed';
      const activity = activityFromItem(item, phase);
      if (activity) {
        runtime.activities.set(activity.id, activity);
        this.#emit({
          type: 'activity',
          threadId,
          source: runtime.activeItem?.source || 'ui',
          commandId: runtime.activeItem?.id || null,
          activity,
        });
      }
      void this.#log('info', `Событие JARVIS: ${item.type || 'unknown'} (${item.status || phase}).`);
      return;
    }

    if (message.method === 'turn/completed') {
      this.#completeTurn(threadId, params.turn || {});
      return;
    }

    if (message.method === 'error') {
      this.#handleError(new Error(params.error?.message || 'Ошибка локального сервиса JARVIS.'), threadId);
    }
  }

  #completeTurn(threadId, turn) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime?.activeTurn) return;
    this.#clearTurnWatchdog(runtime);
    const failed = turn.status !== 'completed';
    const completedItem = runtime.activeItem;
    const completedText = runtime.assistantText;
    if (completedItem?.kind === 'automation') {
      if (failed) completedItem.reject(new Error('Codex automation turn failed.'));
      else if (!completedText) completedItem.reject(new Error('Codex automation returned no structured output.'));
      else completedItem.resolve(completedText);
      this.#emit({
        type: 'automation-completed',
        threadId,
        automationId: completedItem.id,
        status: failed ? 'failed' : 'completed',
      });
    } else if (!failed && completedText) {
      this.#emit({
        type: 'assistant-message',
        threadId,
        text: runtime.assistantText,
        source: completedItem?.source || 'ui',
        commandId: completedItem?.id || null,
      });
    }
    if (completedItem?.kind !== 'automation') {
      this.#emit({
        type: 'turn-completed',
        threadId,
        itemId: completedItem?.id,
        source: completedItem?.source || 'ui',
        status: failed ? 'failed' : 'completed',
      });
    }
    runtime.assistantText = '';
    runtime.activeTurn = false;
    runtime.activeTurnId = null;
    runtime.activeItem = null;
    this.#settleApprovalsForThread(threadId, 'turn-completed');
    this.#setStatus(
      threadId,
      failed ? 'error' : 'idle',
      failed ? 'JARVIS завершил запрос с ошибкой.' : 'Готов к следующему запросу.',
    );

    const next = runtime.deleting ? null : runtime.queue.shift();
    this.#emit({ type: 'queue', threadId, items: this.#queueSnapshot(runtime) });
    if (next) {
      void this.#startTurn(threadId, next).catch((error) => {
        if (next.kind === 'automation') next.reject(error);
        this.#handleError(error, threadId);
      });
    }
  }

  #scheduleTurnWatchdog(threadId, itemId) {
    if (!(this.turnWatchdogMs > 0) || !(this.turnWatchdogMaxChecks > 0)) return;
    const runtime = this.runtimes.get(threadId);
    if (!runtime?.activeTurn || runtime.activeItem?.id !== itemId) return;
    if (runtime.turnWatchdog) this.clearTimeoutImpl(runtime.turnWatchdog);
    runtime.turnWatchdog = null;
    runtime.turnWatchdog = this.setTimeoutImpl(
      () => this.#reconcileActiveTurn(threadId, itemId),
      this.turnWatchdogMs,
    );
    runtime.turnWatchdog?.unref?.();
  }

  async #interruptForDeletion(threadId, runtime, client) {
    if (typeof runtime.activeTurnId !== 'string' || !runtime.activeTurnId) {
      const error = new Error('Active turn cannot be safely interrupted yet.');
      error.code = 'ACTIVE_TURN';
      throw error;
    }
    runtime.deleting = true;
    for (const [id, pending] of [...this.pendingApprovals.entries()]) {
      if (pending.threadId !== threadId || pending.responseSentAt !== null) continue;
      try { this.#sendApprovalResponse(id, pending, 'decline'); } catch {}
    }
    const waiter = this.#waitForTurnStop(threadId);
    try {
      await client.interruptTurn(threadId, runtime.activeTurnId);
      await waiter.promise;
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  #waitForTurnStop(threadId) {
    let settled = false;
    let timer;
    let resolvePromise;
    let rejectPromise;
    const cleanup = () => {
      if (timer) this.clearTimeoutImpl(timer);
      this.events.off('event', onEvent);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error); else resolvePromise();
    };
    const onEvent = (event) => {
      if (event?.threadId !== threadId) return;
      if (event.type === 'turn-completed' || event.type === 'error') finish();
    };
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.events.on('event', onEvent);
    timer = this.setTimeoutImpl(() => {
      const error = new Error('Active turn did not stop before thread deletion.');
      error.code = 'ACTIVE_TURN';
      finish(error);
    }, this.deleteInterruptTtlMs);
    timer?.unref?.();
    return { promise, cancel: () => finish() };
  }

  async #reconcileActiveTurn(threadId, itemId) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime?.activeTurn || runtime.activeItem?.id !== itemId) return;
    runtime.turnWatchdog = null;
    runtime.turnWatchdogChecks += 1;
    try {
      const client = await this.#getClient();
      const thread = this.#verifiedThread(await client.readThread(threadId));
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      const turn = runtime.activeTurnId
        ? turns.find((candidate) => candidate?.id === runtime.activeTurnId)
        : turns.at(-1);
      if (turn && ['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status)) {
        if (!runtime.assistantText) {
          const lastAgentItem = [...(Array.isArray(turn.items) ? turn.items : [])]
            .reverse()
            .find((item) => item?.type === 'agentMessage');
          runtime.assistantText = extractAssistantText(lastAgentItem);
        }
        this.#completeTurn(threadId, turn);
        void this.#log('info', `Turn ${runtime.activeTurnId || 'unknown'} reconciled from authoritative thread state.`);
        return;
      }
    } catch (error) {
      void this.#log('error', `Не удалось сверить состояние активного turn: ${String(error?.message || error)}`);
    }
    if (runtime.turnWatchdogChecks < this.turnWatchdogMaxChecks) {
      this.#scheduleTurnWatchdog(threadId, itemId);
      return;
    }
    if (runtime.activeItem?.kind === 'automation') {
      const timeoutError = new Error('Codex automation turn did not reach a terminal state.');
      timeoutError.code = 'AUTOMATION_TURN_TIMEOUT';
      try {
        const client = await this.#getClient();
        if (typeof runtime.activeTurnId === 'string' && runtime.activeTurnId) {
          await client.interruptTurn(threadId, runtime.activeTurnId);
        }
      } catch (error) {
        void this.#log('error', `Не удалось прервать зависший automation turn: ${String(error?.message || error)}`);
      }
      this.#handleError(timeoutError, threadId);
      return;
    }
    this.#setStatus(threadId, 'working', 'JARVIS всё ещё выполняет запрос…');
  }

  #clearTurnWatchdog(runtime) {
    if (!runtime) return;
    if (runtime.turnWatchdog) this.clearTimeoutImpl(runtime.turnWatchdog);
    runtime.turnWatchdog = null;
    runtime.turnWatchdogChecks = 0;
  }

  #handleServerRequest(message) {
    if (!message?.method?.includes('requestApproval')) return;
    if (this.respondedApprovalIds.has(String(message.id)) || this.pendingApprovals.has(message.id)) {
      void this.#logApproval({ id: message.id, threadId: message.params?.threadId }, 'duplicate-ignored');
      return;
    }
    const threadId = message.params?.threadId;
    if (typeof threadId !== 'string' || !threadId) {
      this.#declineOrphanApproval(message, 'missing-thread');
      return;
    }
    const runtime = this.runtimes.get(threadId);
    if (!runtime?.activeTurn) {
      this.#declineOrphanApproval(message, 'inactive-thread');
      return;
    }
    const approval = approvalDetails(message);
    let safety = classifyExecutionRequest({
      ...approval,
      explicitUserRequest: runtime.activeItem?.kind === 'user',
    });
    const canAcceptOnce = approval.availableDecisions.length === 0 || approval.availableDecisions.includes('accept');
    if (safety.policy === EXECUTION_POLICY.AUTO_ALLOW && !canAcceptOnce) {
      safety = { ...safety, policy: EXECUTION_POLICY.CONFIRM_REQUIRED, reason: 'one-shot-accept-unavailable' };
    }
    approval.policy = safety.policy;
    approval.safetyLevel = safety.policy;
    approval.canAcceptOnce = canAcceptOnce;
    approval.targets = safety.targets;
    if (safety.target) approval.target = safety.target;
    const source = runtime.activeItem?.source || 'ui';
    const commandId = runtime.activeItem?.id || null;
    const createdAt = new Date(this.now()).toISOString();
    const pending = {
      id: message.id,
      requestId: message.id,
      threadId,
      turnId: approval.turnId,
      itemId: approval.itemId,
      method: message.method,
      source,
      commandId,
      approval,
      policy: safety.policy,
      policyReason: safety.reason,
      visibility: safety.policy === EXECUTION_POLICY.CONFIRM_REQUIRED ? 'user' : 'silent',
      status: 'pending',
      decision: null,
      wireDecision: null,
      responseSentAt: null,
      resolvedAt: null,
      createdAt,
      expired: false,
      timer: null,
      resolutionTimer: null,
    };
    this.pendingApprovals.set(message.id, pending);

    if (safety.policy === EXECUTION_POLICY.HARD_BLOCK) {
      this.#sendApprovalResponse(message.id, pending, 'decline');
      this.#emit({
        type: 'safety-blocked',
        threadId,
        source,
        commandId,
        target: approval.target,
        overrideAllowed: false,
      });
      void this.#logApproval(pending, 'hard-blocked');
      return;
    }

    if (safety.policy === EXECUTION_POLICY.AUTO_ALLOW) {
      this.#sendApprovalResponse(message.id, pending, 'accept');
      void this.#logApproval(pending, 'auto-allowed');
      return;
    }

    const expiresAtMs = this.now() + this.approvalTtlMs;
    approval.expiresAt = new Date(expiresAtMs).toISOString();
    pending.timer = this.setTimeoutImpl(() => this.#expireApproval(message.id, pending), this.approvalTtlMs);
    pending.timer?.unref?.();
    this.#emit({ type: 'approval', threadId, source, commandId, approval });
    void this.#logApproval(pending, 'confirmation-required');
  }

  async #expireApproval(id, pending) {
    if (this.pendingApprovals.get(id) !== pending) return;
    try {
      pending.expired = true;
      await this.#getClient();
      this.#sendApprovalResponse(id, pending, 'decline');
      void this.#logApproval(pending, 'expired-declined');
    } catch {
      void this.#log('error', 'JARVIS could not decline an expired approval.');
      this.#settlePendingApproval(id, pending, 'expiry-response-failed');
    }
  }

  #sendApprovalResponse(id, pending, decision) {
    if (pending.responseSentAt !== null || this.respondedApprovalIds.has(String(id))) {
      const error = new Error('Approval request was already answered and is awaiting App Server resolution.');
      error.code = 'ALREADY_ANSWERED';
      throw error;
    }
    const wireDecision = approvalWireDecision(pending, decision);
    const client = this.client;
    if (!client) throw new Error('Codex App Server is unavailable.');
    if (pending.timer) {
      this.clearTimeoutImpl(pending.timer);
      pending.timer = null;
    }
    pending.status = 'answering';
    pending.decision = decision;
    pending.wireDecision = wireDecision;
    pending.responseSentAt = new Date(this.now()).toISOString();
    this.#rememberRespondedApproval(id);
    try {
      client.respondToServerRequest(id, { decision: wireDecision });
    } catch (error) {
      this.respondedApprovalIds.delete(String(id));
      pending.status = 'pending';
      pending.decision = null;
      pending.wireDecision = null;
      pending.responseSentAt = null;
      throw error;
    }
    pending.resolutionTimer = this.setTimeoutImpl(
      () => this.#settlePendingApproval(id, pending, 'resolution-watchdog'),
      this.approvalResolutionTtlMs,
    );
    pending.resolutionTimer?.unref?.();
  }

  #declineOrphanApproval(message, reason) {
    const approval = approvalDetails(message);
    const pending = {
      id: message.id,
      requestId: message.id,
      threadId: approval.threadId || null,
      turnId: approval.turnId,
      itemId: approval.itemId,
      method: message.method,
      source: 'system',
      commandId: null,
      approval,
      policy: EXECUTION_POLICY.CONFIRM_REQUIRED,
      policyReason: reason,
      visibility: 'silent',
      status: 'pending',
      decision: null,
      wireDecision: null,
      responseSentAt: null,
      resolvedAt: null,
      createdAt: new Date(this.now()).toISOString(),
      expired: false,
      timer: null,
      resolutionTimer: null,
    };
    this.pendingApprovals.set(message.id, pending);
    try {
      this.#sendApprovalResponse(message.id, pending, 'decline');
      void this.#logApproval(pending, reason);
    } catch (error) {
      this.pendingApprovals.delete(message.id);
      void this.#log('error', `Не удалось отклонить некорректный approval request: ${String(error?.message || error)}`);
    }
  }

  #rememberRespondedApproval(id) {
    this.respondedApprovalIds.add(String(id));
    while (this.respondedApprovalIds.size > 1_000) {
      this.respondedApprovalIds.delete(this.respondedApprovalIds.values().next().value);
    }
  }

  #handleApprovalResolved(requestId, notificationThreadId) {
    const entries = [...this.pendingApprovals.entries()];
    let entry = entries.find(([id]) => id === requestId);
    if (!entry) entry = entries.find(([id]) => String(id) === String(requestId));
    if (!entry) {
      void this.#log('info', 'App Server подтвердил уже очищенный approval request.');
      return;
    }
    const [id, pending] = entry;
    if (pending.threadId !== notificationThreadId) {
      void this.#log('error', 'App Server вернул approval resolution с несовпадающим threadId.');
      return;
    }
    this.#clearPendingApproval(id);
    pending.resolvedAt = new Date(this.now()).toISOString();
    if (pending.visibility === 'user') this.#emit({
      type: 'approval-resolved',
      threadId: pending.threadId,
      id,
      decision: pending.decision || 'decline',
      source: pending.source,
      commandId: pending.commandId,
      expired: pending.expired,
    });
    void this.#logApproval(pending, 'server-resolved');
  }

  #clearPendingApproval(id) {
    const pending = this.pendingApprovals.get(id);
    if (pending?.timer) this.clearTimeoutImpl(pending.timer);
    if (pending?.resolutionTimer) this.clearTimeoutImpl(pending.resolutionTimer);
    this.pendingApprovals.delete(id);
  }

  #clearAllApprovals() {
    for (const id of this.pendingApprovals.keys()) this.#clearPendingApproval(id);
  }

  #settlePendingApproval(id, pending, reason) {
    if (this.pendingApprovals.get(id) !== pending) return;
    this.#clearPendingApproval(id);
    if (pending.visibility === 'user') this.#emit({
      type: 'approval-resolved',
      threadId: pending.threadId,
      id,
      decision: pending.decision || 'decline',
      source: pending.source,
      commandId: pending.commandId,
      expired: pending.expired,
      cancelled: pending.decision === null,
      reason,
    });
    void this.#logApproval(pending, reason);
  }

  #settleApprovalsForThread(threadId, reason) {
    for (const [id, pending] of [...this.pendingApprovals.entries()]) {
      if (pending.threadId === threadId) this.#settlePendingApproval(id, pending, reason);
    }
  }

  #handleError(error, threadId) {
    const friendly = userFacingError(error);
    const runtime = this.#runtime(threadId);
    this.#clearTurnWatchdog(runtime);
    if (runtime.activeItem?.kind === 'automation') runtime.activeItem.reject(error);
    const failedItem = runtime.activeItem;
    runtime.activeTurn = false;
    runtime.activeTurnId = null;
    runtime.activeItem = null;
    this.#settleApprovalsForThread(threadId, 'turn-error');
    this.#setStatus(threadId, 'error', friendly);
    this.#emit({
      type: 'error',
      threadId,
      message: friendly,
      itemId: failedItem?.id,
      commandId: failedItem?.id,
      source: failedItem?.source || 'ui',
      authRequired: isAuthError(error),
    });
    void this.#log('error', isAuthError(error) ? 'Codex authentication required (AUTH_REQUIRED).' : String(error?.message || error));
  }

  #setStatus(threadId, state, detail) {
    this.#runtime(threadId).status = { state, detail };
    this.#emit({ type: 'status', threadId, state, detail });
  }

  #emit(event) {
    this.events.emit('event', event);
  }

  #rejectAutomation(runtime, error) {
    if (runtime.activeItem?.kind === 'automation') runtime.activeItem.reject(error);
    for (const item of runtime.queue) {
      if (item.kind === 'automation') item.reject(error);
    }
  }

  async #publicError(error, threadId) {
    if (threadId) this.#handleError(error, threadId);
    else await this.#log('error', isAuthError(error) ? 'Codex authentication required (AUTH_REQUIRED).' : String(error?.message || error));
    if (isAuthError(error)) this.client?.invalidateExecutionContext?.();
    const publicError = new Error(userFacingError(error));
    if (isMissingThreadError(error)) publicError.code = 'NOT_FOUND';
    else if (isAuthError(error)) publicError.code = 'AUTH_REQUIRED';
    else if (error?.code === 'MODEL_UNAVAILABLE') publicError.code = 'MODEL_UNAVAILABLE';
    return publicError;
  }

  async #log(level, message) {
    try {
      await mkdir(this.logDirectory, { recursive: true });
      const safeMessage = String(message).replace(/[\r\n]+/g, ' ');
      const line = `${new Date().toISOString()} ${String(level).toUpperCase()} ${safeMessage}\n`;
      await appendFile(path.join(this.logDirectory, 'jarvis.log'), line, 'utf8');
    } catch {
      // Logging must never make the assistant unavailable.
    }
  }

  async #logApproval(pending, result) {
    const trace = {
      event: 'approval-policy',
      requestId: String(pending?.requestId ?? pending?.id ?? '').slice(0, 128),
      threadId: typeof pending?.threadId === 'string' ? pending.threadId : null,
      turnId: typeof pending?.turnId === 'string' ? pending.turnId : null,
      itemId: typeof pending?.itemId === 'string' ? pending.itemId : null,
      type: typeof pending?.method === 'string' ? pending.method : null,
      policy: pending?.policy || null,
      result,
      responseSent: pending?.responseSentAt !== null,
      createdAt: pending?.createdAt || null,
      responseSentAt: pending?.responseSentAt || null,
      resolvedAt: pending?.resolvedAt || null,
    };
    await this.#log('info', JSON.stringify(trace));
  }
}
