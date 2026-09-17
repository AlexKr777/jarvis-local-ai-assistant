import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CURRENT_STATE_VERSION = 3;
const READY_RECOVERY = Object.freeze({ status: 'ready', reason: null, migratedFrom: null });

export const DEFAULT_CRYPTO_STATE = Object.freeze({
  version: CURRENT_STATE_VERSION,
  mode: 'DRY_RUN',
  cryptoThreadId: null,
  pendingPublish: null,
  posts: [],
  dryRunVerifiedAt: null,
  autoReady: false,
  autoArmed: false,
  manualAutoOverride: false,
  autoArm: null,
  codexHealth: { status: 'unknown', checkedAt: null, reason: null },
  fingerprints: [],
  tokenLastAnalyzedAt: {},
  learning: { samples: 0, adjustments: {} },
  pendingCandidates: [],
  editorialHistory: [],
  tokenNarratives: {},
  recovery: READY_RECOVERY,
});

function normalizedState(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceVersion = Number.isInteger(source.version) ? source.version : CURRENT_STATE_VERSION;
  const unsupportedVersion = sourceVersion > CURRENT_STATE_VERSION;
  const validMode = ['OFF', 'DRY_RUN', 'AUTO'].includes(source.mode);
  const suppliedRecovery = source.recovery && typeof source.recovery === 'object' ? source.recovery : null;
  const blockedReason = unsupportedVersion
    ? 'unsupported_state_version'
    : (!validMode && source.mode !== undefined ? 'invalid_state' : null);
  const recovery = blockedReason
    ? { status: 'blocked', reason: blockedReason, migratedFrom: null }
    : suppliedRecovery?.status === 'blocked'
      ? { status: 'blocked', reason: String(suppliedRecovery.reason || 'invalid_state'), migratedFrom: suppliedRecovery.migratedFrom ?? null }
      : {
          status: 'ready',
          reason: null,
          migratedFrom: sourceVersion < CURRENT_STATE_VERSION ? sourceVersion : (suppliedRecovery?.migratedFrom ?? null),
        };
  return {
    ...structuredClone(DEFAULT_CRYPTO_STATE),
    ...source,
    version: CURRENT_STATE_VERSION,
    mode: recovery.status === 'blocked' ? 'OFF' : (validMode ? source.mode : DEFAULT_CRYPTO_STATE.mode),
    autoReady: recovery.status === 'blocked' ? false : Boolean(source.autoReady),
    autoArmed: recovery.status === 'blocked' ? false : Boolean(source.autoArmed),
    manualAutoOverride: recovery.status === 'blocked' ? false : Boolean(source.manualAutoOverride),
    autoArm: source.autoArm && typeof source.autoArm === 'object' ? structuredClone(source.autoArm) : null,
    codexHealth: source.codexHealth && typeof source.codexHealth === 'object'
      ? { status: String(source.codexHealth.status || 'unknown'), checkedAt: source.codexHealth.checkedAt ?? null, reason: source.codexHealth.reason ?? null }
      : { status: 'unknown', checkedAt: null, reason: null },
    posts: Array.isArray(source.posts) ? source.posts.slice(-500) : [],
    fingerprints: Array.isArray(source.fingerprints) ? source.fingerprints.slice(-500) : [],
    tokenLastAnalyzedAt: source.tokenLastAnalyzedAt && typeof source.tokenLastAnalyzedAt === 'object' ? source.tokenLastAnalyzedAt : {},
    learning: source.learning && typeof source.learning === 'object' ? source.learning : { samples: 0, adjustments: {} },
    pendingCandidates: Array.isArray(source.pendingCandidates) ? source.pendingCandidates.slice(-20) : [],
    editorialHistory: Array.isArray(source.editorialHistory) ? source.editorialHistory.slice(-100) : [],
    tokenNarratives: source.tokenNarratives && typeof source.tokenNarratives === 'object' ? source.tokenNarratives : {},
    recovery,
  };
}

export class CryptoStateStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.state) return structuredClone(this.state);
    try {
      this.state = normalizedState(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') this.state = normalizedState();
      else if (error instanceof SyntaxError) {
        this.state = normalizedState({
          mode: 'OFF',
          autoReady: false,
          recovery: { status: 'blocked', reason: 'corrupt_state', migratedFrom: null },
        });
      } else throw error;
    }
    return structuredClone(this.state);
  }

  async update(updater) {
    let result;
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const current = await this.load();
      const next = normalizedState(await updater(structuredClone(current)));
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
      this.state = next;
      result = structuredClone(next);
    });
    await this.writeQueue;
    return result;
  }
}
