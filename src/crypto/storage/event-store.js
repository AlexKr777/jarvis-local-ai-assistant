import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const SECRET_KEY = /(?:api[-_]?key|token|secret|password|signature|authorization)/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const safe = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!SECRET_KEY.test(key)) safe[key] = redact(nested);
  }
  return safe;
}

export class CryptoEventStore {
  constructor({ directory }) {
    this.directory = directory;
    this.writeQueue = Promise.resolve();
    this.lastDiagnostics = [];
  }

  async append(event) {
    if (!event?.eventId || !event?.type || !event?.occurredAt) throw new TypeError('A typed crypto event is required.');
    const day = new Date(event.occurredAt).toISOString().slice(0, 10);
    const filePath = path.join(this.directory, `${day}.jsonl`);
    const line = `${JSON.stringify(redact(event))}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
    });
    await this.writeQueue;
    return { filePath };
  }

  async listRecent({ limit = 20, types } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const allowedTypes = Array.isArray(types) && types.length > 0 ? new Set(types) : null;
    const { events } = await this.#readRecent({ allowedTypes, quarantine: false });
    return events.slice(-safeLimit);
  }

  async auditRecent() {
    const { diagnostics } = await this.#readRecent({ allowedTypes: null, quarantine: true });
    return { malformedLines: diagnostics.length, diagnostics: diagnostics.map(({ lineHash, ...diagnostic }) => diagnostic) };
  }

  async #readRecent({ allowedTypes, quarantine }) {
    let names;
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return { events: [], diagnostics: [] };
      throw error;
    }
    const files = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-7);
    const events = [];
    const diagnostics = [];
    for (const name of files) {
      const text = await readFile(path.join(this.directory, name), 'utf8');
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event?.eventId && event?.type && event?.occurredAt && (!allowedTypes || allowedTypes.has(event.type))) events.push(redact(event));
        } catch {
          diagnostics.push({
            kind: 'malformed_event_line', file: name, line: index + 1, bytes: Buffer.byteLength(line),
            lineHash: createHash('sha256').update(line).digest('hex'),
          });
        }
      }
    }
    this.lastDiagnostics = diagnostics;
    if (quarantine && diagnostics.length) await this.#writeQuarantine(diagnostics);
    return { events, diagnostics };
  }

  async #writeQuarantine(diagnostics) {
    const byFile = new Map();
    for (const diagnostic of diagnostics) {
      const items = byFile.get(diagnostic.file) || [];
      items.push(diagnostic);
      byFile.set(diagnostic.file, items);
    }
    const directory = path.join(this.directory, 'quarantine');
    await mkdir(directory, { recursive: true });
    for (const [file, items] of byFile) {
      const destination = path.join(directory, file.replace(/\.jsonl$/, '.bad-lines.jsonl'));
      const lines = items.map((item) => `${JSON.stringify(item)}\n`).join('');
      await appendFile(destination, lines, { encoding: 'utf8', mode: 0o600 });
    }
  }
}
