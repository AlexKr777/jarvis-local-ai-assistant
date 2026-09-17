import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyVoiceIntent, normalizeConfirmation } from './voice-policy.js';
import { buildVoiceDisplay } from './voice-display.js';

const MAX_TRANSCRIPT_CHARS = 4_000;
const MAX_COMMANDS = 100;

export class VoiceStateStore {
  constructor({ projectRoot } = {}) {
    this.directory = path.join(path.resolve(projectRoot), 'data', 'voice');
    this.filePath = path.join(this.directory, 'state.json');
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8'));
      return typeof value?.threadId === 'string' ? { threadId: value.threadId } : {};
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return {};
      throw error;
    }
  }

  async save({ threadId }) {
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify({ threadId })}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, this.filePath);
  }
}

function publicApproval(pending) {
  if (!pending) return null;
  return {
    id: pending.id,
    commandId: pending.commandId,
    target: pending.target || null,
    expiresAt: pending.expiresAt,
    answering: pending.answering === true,
  };
}

function publicCommand(command) {
  const { answer, activities, ...publicFields } = command;
  return {
    ...publicFields,
    display: command.display || buildVoiceDisplay({
      requestId: command.commandId,
      state: command.state,
      answer,
      transcript: command.transcript,
      activities,
    }),
  };
}

export class VoiceRuntime {
  constructor({
    jarvis,
    stateStore,
    approvalTtlMs = 60_000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    now = () => Date.now(),
  } = {}) {
    if (!jarvis || !stateStore) throw new Error('VoiceRuntime requires jarvis and stateStore.');
    this.jarvis = jarvis;
    this.stateStore = stateStore;
    this.approvalTtlMs = approvalTtlMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.now = now;
    this.threadId = null;
    this.threadPromise = null;
    this.commands = new Map();
    this.pendingApprovals = new Map();
    this.paused = false;
    this.unsubscribe = jarvis.subscribe((event) => this.#handleEvent(event));
  }

  setPaused(paused) {
    if (typeof paused !== 'boolean') throw new Error('paused must be boolean.');
    this.paused = paused;
    return this.snapshot();
  }

  snapshot() {
    const latest = Array.from(this.commands.values()).at(-1) || null;
    const pending = this.#singlePendingApproval();
    return {
      state: this.paused ? 'paused' : latest?.state || 'idle',
      paused: this.paused,
      threadId: this.threadId,
      pendingApproval: publicApproval(pending),
      pendingApprovalCount: this.pendingApprovals.size,
    };
  }

  status(commandId) {
    const command = this.commands.get(commandId);
    if (!command) {
      const error = new Error('Voice command was not found.');
      error.code = 'NOT_FOUND';
      throw error;
    }
    return publicCommand(command);
  }

  async submitTranscript(transcript) {
    const normalized = typeof transcript === 'string' ? transcript.trim() : '';
    if (!normalized || normalized.length > MAX_TRANSCRIPT_CHARS) throw new Error('Voice transcript is invalid.');

    if (this.pendingApprovals.size > 0) {
      const confirmation = normalizeConfirmation(normalized);
      if (confirmation) return this.#resolveApproval(confirmation);
      const pending = this.#singlePendingApproval();
      return {
        kind: 'approval-pending',
        commandId: pending?.commandId || null,
        state: 'approval',
        pendingCount: this.pendingApprovals.size,
      };
    }
    if (this.paused) {
      const error = new Error('Voice input is paused.');
      error.code = 'VOICE_PAUSED';
      throw error;
    }

    const safety = classifyVoiceIntent(normalized, { cwd: process.cwd() });
    if (safety.level === 'hard-block') {
      const commandId = randomUUID();
      const command = {
        kind: 'command',
        commandId,
        threadId: this.threadId,
        transcript: normalized,
        state: 'blocked',
        overrideAllowed: false,
        createdAt: new Date(this.now()).toISOString(),
        answer: '',
        activities: [],
      };
      this.#remember(command);
      return publicCommand(command);
    }

    const threadId = await this.#ensureThread();
    const routedAtUnixMs = this.now();
    const accepted = await this.jarvis.send({
      threadId,
      message: normalized,
      attachments: [],
      source: 'voice',
    });
    const acceptedAtUnixMs = this.now();
    const commandId = accepted.itemId;
    const command = {
      kind: 'command',
      commandId,
      threadId,
      transcript: normalized,
      state: accepted.disposition === 'queued' ? 'queued' : 'executing',
      createdAt: new Date(this.now()).toISOString(),
      answer: '',
      activities: [],
      timings: {
        routedAtUnixMs,
        acceptedAtUnixMs,
        turnStartedAtUnixMs: Number.isFinite(accepted.turnStartedAtUnixMs) ? accepted.turnStartedAtUnixMs : null,
      },
    };
    this.#remember(command);
    return publicCommand(command);
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingApprovals.clear();
  }

  async resetConversation() {
    this.threadId = null;
    this.threadPromise = null;
    this.pendingApprovals.clear();
    const threadId = await this.#ensureThread();
    return { threadId };
  }

  async #ensureThread() {
    if (this.threadId) return this.threadId;
    if (this.threadPromise) return this.threadPromise;
    this.threadPromise = (async () => {
      const stored = await this.stateStore.load();
      if (stored.threadId) {
        try {
          const thread = await this.jarvis.readThread(stored.threadId, { activate: false });
          this.threadId = thread.id;
          return this.threadId;
        } catch (error) {
          if (error?.code !== 'NOT_FOUND') throw error;
        }
      }

      const thread = await this.jarvis.createThread({ activate: false });
      this.threadId = thread.id;
      await this.jarvis.renameThread(this.threadId, 'Voice Commands');
      await this.stateStore.save({ threadId: this.threadId });
      return this.threadId;
    })();
    try {
      return await this.threadPromise;
    } finally {
      this.threadPromise = null;
    }
  }

  #remember(command) {
    this.commands.set(command.commandId, command);
    while (this.commands.size > MAX_COMMANDS) this.commands.delete(this.commands.keys().next().value);
  }

  #handleEvent(event) {
    if (!event || event.source !== 'voice') return;
    const command = event.commandId || event.itemId ? this.commands.get(event.commandId || event.itemId) : null;
    if (event.type === 'turn-started' && command) command.state = 'executing';
    if (event.type === 'activity' && command && event.activity) command.activities.push({ ...event.activity });
    if (event.type === 'assistant-message' && command && typeof event.text === 'string') command.answer = event.text;
    if (event.type === 'turn-completed' && command) {
      command.state = event.status === 'completed' ? 'success' : 'error';
      command.display = buildVoiceDisplay({
        requestId: command.commandId,
        state: command.state,
        answer: command.answer,
        transcript: command.transcript,
        activities: command.activities,
      });
      command.answer = '';
      command.activities = [];
    }
    if (event.type === 'error' && command) {
      command.state = event.authRequired ? 'auth-required' : 'error';
      command.display = buildVoiceDisplay({ requestId: command.commandId, state: command.state });
      command.answer = '';
      command.activities = [];
    }
    if (event.type === 'safety-blocked' && command) {
      command.state = 'blocked';
      command.overrideAllowed = false;
      command.display = buildVoiceDisplay({ requestId: command.commandId, state: command.state });
    }
    if (event.type === 'approval') this.#setPendingApproval(event);
    if (event.type === 'approval-resolved') this.#resolvePendingFromServer(event);
  }

  #setPendingApproval(event) {
    const pending = {
      id: event.approval.id,
      commandId: event.commandId,
      target: event.approval.target || null,
      expiresAt: event.approval.expiresAt || new Date(this.now() + this.approvalTtlMs).toISOString(),
      answering: false,
      decision: null,
    };
    this.pendingApprovals.set(pending.id, pending);
    const command = this.commands.get(pending.commandId);
    if (command) {
      command.state = 'confirming';
      command.display = buildVoiceDisplay({ requestId: command.commandId, state: command.state });
    }
  }

  async #resolveApproval(decision) {
    if (this.pendingApprovals.size !== 1) {
      return {
        kind: 'approval-conflict',
        state: 'approval',
        pendingCount: this.pendingApprovals.size,
      };
    }
    const pending = this.#singlePendingApproval();
    if (pending.answering) {
      return {
        kind: 'approval',
        decision: pending.decision,
        commandId: pending.commandId,
        state: 'approval',
        pending: true,
      };
    }
    pending.answering = true;
    pending.decision = decision;
    try {
      await this.jarvis.respondToApproval(pending.id, decision);
    } catch (error) {
      pending.answering = false;
      pending.decision = null;
      throw error;
    }
    const command = this.commands.get(pending.commandId);
    if (command) {
      command.state = 'approval';
      command.display = buildVoiceDisplay({ requestId: command.commandId, state: command.state });
    }
    return {
      kind: 'approval',
      decision,
      commandId: pending.commandId,
      state: 'confirming',
      pending: true,
    };
  }

  #singlePendingApproval() {
    if (this.pendingApprovals.size !== 1) return null;
    return this.pendingApprovals.values().next().value;
  }

  #resolvePendingFromServer(event) {
    const pending = this.pendingApprovals.get(event.id);
    if (!pending) return;
    this.pendingApprovals.delete(event.id);
    const decision = event.decision || pending.decision;
    const command = this.commands.get(pending.commandId);
    if (!command) return;
    if (decision === 'accept') {
      command.state = 'executing';
      command.display = buildVoiceDisplay({ requestId: command.commandId, state: command.state });
      return;
    }
    command.state = 'success';
    command.display = {
      requestId: command.commandId,
      type: 'action-success',
      text: event.expired ? 'Подтверждение истекло' : 'Действие отклонено',
      truncated: false,
    };
  }
}
