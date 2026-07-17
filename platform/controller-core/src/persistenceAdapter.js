export class PersistenceAdapter {
  constructor(store) {
    this.store = store;
  }

  async load() {
    const state = await this.store.load();
    await this.migrate();
    return state;
  }

  snapshot() {
    return this.store.snapshot();
  }

  update(mutator) {
    return this.store.update((state) => mutator(ensureControllerState(state)));
  }

  async migrate() {
    await this.store.update((state) => {
      ensureControllerState(state);
      state.controllerCore ||= {};
      state.controllerCore.schemaVersion = 1;
      state.controllerCore.migrationVersion = Math.max(Number(state.controllerCore.migrationVersion || 0), 1);
    });
  }
}

export function ensureControllerState(state) {
  state.schemaVersion ||= 1;
  state.devices ||= [];
  state.commands ||= [];
  state.batches ||= [];
  state.datasets ||= [];
  state.results ||= [];
  state.groups ||= [];
  state.workflowRevisions ||= [];
  state.executionEvents ||= [];
  state.managedContainers ||= [];
  state.originSyncResults ||= [];
  state.auditEvents ||= [];
  state.pendingPairings ||= [];
  state.pairedAgents ||= [];
  state.controllerCore ||= { schemaVersion: 1, migrationVersion: 1 };
  return state;
}
