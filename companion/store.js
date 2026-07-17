import fs from 'node:fs/promises';
import path from 'node:path';

export const EMPTY_STATE = {
  schemaVersion: 1,
  controllerCore: { schemaVersion: 1, migrationVersion: 1 },
  devices: [],
  commands: [],
  batches: [],
  datasets: [],
  results: [],
  groups: [],
  workflowRevisions: [],
  executionEvents: [],
  managedContainers: [],
  auditEvents: [],
  pendingPairings: [],
  pairedAgents: []
};

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = structuredClone(EMPTY_STATE);
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = { ...structuredClone(EMPTY_STATE), ...JSON.parse(raw) };
      await this.migrateIfNeeded();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await fs.copyFile(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => {});
        throw new Error(`STORE_CORRUPT: ${path.basename(this.filePath)} was copied aside for recovery`);
      }
    }
    return this.state;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async update(mutator) {
    const run = async () => {
      const result = await mutator(this.state);
      await this.flush();
      return result;
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  async flush() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
    await fs.rename(tmp, this.filePath);
  }

  async migrateIfNeeded() {
    const migrationVersion = Number(this.state.controllerCore?.migrationVersion || 0);
    if (migrationVersion >= 1) return;
    await fs.copyFile(this.filePath, `${this.filePath}.backup-v${migrationVersion}-${Date.now()}`).catch(() => {});
    this.state = { ...structuredClone(EMPTY_STATE), ...this.state, controllerCore: { schemaVersion: 1, migrationVersion: 1 } };
    await this.flush();
  }
}

export function createMemoryStore(initial = EMPTY_STATE) {
  const state = structuredClone({ ...EMPTY_STATE, ...initial });
  return {
    state,
    async load() {
      return state;
    },
    snapshot() {
      return structuredClone(state);
    },
    async update(mutator) {
      return mutator(state);
    }
  };
}
