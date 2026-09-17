import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function corruptArchivePath(filePath, now = Date.now()) {
  const extension = path.extname(filePath);
  const basename = path.basename(filePath, extension);
  return path.join(path.dirname(filePath), `${basename}.corrupt-${now}${extension || '.json'}`);
}

export class BaselineSnapshotStore {
  constructor({ filePath }) { this.filePath = filePath; }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      if (error instanceof SyntaxError) {
        await rename(this.filePath, corruptArchivePath(this.filePath));
        return {};
      }
      throw error;
    }
  }

  async save(snapshot) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
