import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export const APP_SERVER_APPROVAL_POLICY = 'on-request';
export const APP_SERVER_THREAD_SANDBOX = 'danger-full-access';
export const APP_SERVER_TURN_SANDBOX_POLICY = 'dangerFullAccess';

export function appServerCommand(platform = process.platform) {
  return platform === 'win32' ? 'codex.cmd' : 'codex';
}

export function appServerLaunch(platform = process.platform) {
  const command = appServerCommand(platform);
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `${command} app-server`] };
  }
  return { command, args: ['app-server'] };
}

export function appServerInitializeParams() {
  return {
    clientInfo: { name: 'jarvis-local', title: 'JARVIS Local', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  };
}

export function extractAssistantText(item) {
  if (typeof item?.text === 'string') return item.text;
  if (!Array.isArray(item?.content)) return '';
  return item.content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

export function appServerRequestError(error) {
  const requestError = new Error(error?.message || 'Codex App Server error.');
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) {
    requestError.code = error.code;
  }
  return requestError;
}

function appServerCapabilityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function modelEntries(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.models)) return result.models;
  return Array.isArray(result) ? result : [];
}

function modelId(model) {
  return String(model?.id || model?.model || model?.slug || '').trim();
}

function safeExecutionContext(account, model, generation = 0) {
  const identityMaterial = JSON.stringify({
    id: account?.id || account?.accountId || null,
    email: account?.email || null,
    type: account?.type || account?.authMode || null,
    plan: account?.planType || account?.plan || null,
    model,
    generation,
  });
  return {
    healthy: true,
    authMode: String(account?.type || account?.authMode || 'authenticated').slice(0, 40),
    planType: String(account?.planType || account?.plan || 'unknown').slice(0, 40),
    model,
    fingerprint: createHash('sha256').update(`jarvis-codex-context-v1\n${identityMaterial}`).digest('hex'),
  };
}

export class AppServerClient extends EventEmitter {
  constructor({ cwd, logger = () => {}, configuredModel = process.env.JARVIS_CODEX_MODEL || null }) {
    super();
    this.cwd = cwd;
    this.logger = logger;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connecting = null;
    this.configuredModel = String(configuredModel || '').trim() || null;
    this.executionContextCache = null;
    this.executionContextRequest = null;
    this.selectedModel = null;
    this.executionContextGeneration = 0;
  }

  async connect() {
    if (this.connecting) return this.connecting;
    if (this.child) return;

    this.connecting = this.#start();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async startThread() {
    await this.executionContext();
    return this.request('thread/start', {
      cwd: this.cwd,
      approvalPolicy: APP_SERVER_APPROVAL_POLICY,
      sandbox: APP_SERVER_THREAD_SANDBOX,
      personality: 'friendly',
      serviceName: 'jarvis-local',
      threadSource: 'jarvis-local',
      model: this.selectedModel,
    });
  }

  async listThreads({ cursor = null, searchTerm = null, limit = 50, sourceKinds = ['appServer'] } = {}) {
    await this.connect();
    return this.request('thread/list', {
      cwd: this.cwd,
      sourceKinds,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      cursor,
      searchTerm,
      limit,
    });
  }

  async readThread(threadId) {
    await this.connect();
    return this.request('thread/read', { threadId, includeTurns: true });
  }

  async resumeThread(threadId) {
    await this.executionContext();
    return this.request('thread/resume', { threadId, model: this.selectedModel });
  }

  async setThreadName(threadId, name) {
    await this.connect();
    return this.request('thread/name/set', { threadId, name });
  }

  async deleteThread(threadId) {
    await this.connect();
    return this.request('thread/delete', { threadId });
  }

  async interruptTurn(threadId, turnId) {
    await this.connect();
    return this.request('turn/interrupt', { threadId, turnId });
  }

  async startTurn(threadId, input, options = {}) {
    await this.executionContext();
    const automation = options.automation === true;
    const params = {
      threadId,
      cwd: this.cwd,
      approvalPolicy: automation ? 'never' : APP_SERVER_APPROVAL_POLICY,
      sandboxPolicy: automation
        ? { type: 'readOnly', networkAccess: false }
        : { type: APP_SERVER_TURN_SANDBOX_POLICY },
      input,
      personality: 'friendly',
      summary: 'concise',
      model: this.selectedModel,
    };
    if (
      options.additionalContext
      && typeof options.additionalContext === 'object'
      && !Array.isArray(options.additionalContext)
    ) params.additionalContext = options.additionalContext;
    if (options.outputSchema && typeof options.outputSchema === 'object') params.outputSchema = options.outputSchema;
    return this.request('turn/start', params);
  }

  async readAccount() {
    await this.connect();
    return this.request('account/read', { refreshToken: false });
  }

  async listModels() {
    await this.connect();
    return this.request('model/list', { limit: 100, includeHidden: true });
  }

  async executionContext({ refresh = false } = {}) {
    if (!refresh && this.executionContextCache) return { ...this.executionContextCache };
    if (this.executionContextRequest) return this.executionContextRequest;
    this.executionContextRequest = this.#discoverExecutionContext();
    try {
      return await this.executionContextRequest;
    } finally {
      this.executionContextRequest = null;
    }
  }

  invalidateExecutionContext() {
    this.executionContextCache = null;
    this.selectedModel = null;
    this.executionContextGeneration += 1;
  }

  respondToServerRequest(id, result) {
    this.#write({ id, result });
  }

  async stop() {
    for (const { reject } of this.pending.values()) {
      reject(new Error('Codex App Server stopped.'));
    }
    this.pending.clear();
    this.connecting = null;
    this.invalidateExecutionContext();
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    child.kill();
  }

  async #start() {
    const launch = appServerLaunch();
    this.logger('info', `Starting ${appServerCommand()} app-server.`);
    this.child = spawn(launch.command, launch.args, {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.once('error', (error) => this.#failAll(error));
    this.child.once('exit', (code) => {
      this.child = null;
      this.#failAll(new Error(`Codex App Server exited (code ${code ?? 'unknown'}).`));
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.logger('error', String(chunk).trim()));
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.#handleLine(line));

    await this.request('initialize', appServerInitializeParams());
    this.#write({ method: 'initialized', params: {} });
    this.logger('info', 'Codex App Server initialized.');
  }

  async #discoverExecutionContext() {
    const [accountResult, modelsResult] = await Promise.all([this.readAccount(), this.listModels()]);
    const account = accountResult?.account || accountResult;
    if (!account || accountResult?.account === null) {
      throw appServerCapabilityError('AUTH_REQUIRED', 'Codex authentication is required.');
    }
    const available = modelEntries(modelsResult).filter((model) => modelId(model));
    const selected = this.configuredModel
      ? available.find((model) => modelId(model) === this.configuredModel)
      : available.find((model) => model?.isDefault === true)
        || available.find((model) => model?.hidden !== true)
        || available[0];
    if (!selected) {
      throw appServerCapabilityError('MODEL_UNAVAILABLE', this.configuredModel
        ? 'The configured Codex model is unavailable for the current account.'
        : 'No Codex model is available for the current account.');
    }
    this.selectedModel = modelId(selected);
    this.executionContextCache = safeExecutionContext(account, this.selectedModel, this.executionContextGeneration);
    return { ...this.executionContextCache };
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) {
      throw new Error('Codex App Server is unavailable. Check that Codex is installed and authenticated.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger('error', 'Codex App Server returned an invalid service message.');
      return;
    }

    if (Object.hasOwn(message, 'id') && !message.method) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(appServerRequestError(message.error));
      else request.resolve(message.result);
      return;
    }

    if (Object.hasOwn(message, 'id') && message.method) {
      this.emit('serverRequest', message);
      return;
    }

    this.emit('notification', message);
  }

  #failAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.invalidateExecutionContext();
    this.emit('fatal', error);
  }
}
