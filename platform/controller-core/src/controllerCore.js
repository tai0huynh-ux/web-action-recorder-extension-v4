import crypto from 'node:crypto';
import { AuditService } from './auditService.js';
import { AuthPolicy } from './authPolicy.js';
import { DeviceRegistry } from './deviceRegistry.js';
import { ExecutionEventStore } from './executionEventStore.js';
import { GroupRegistry } from './groupRegistry.js';
import { JobService } from './jobService.js';
import { PersistenceAdapter } from './persistenceAdapter.js';
import { PairingService } from './pairingService.js';
import { SessionManager } from './sessionManager.js';
import { WorkflowRegistry } from './workflowRegistry.js';

export class ControllerCore {
  constructor({ store, now = () => new Date().toISOString(), id = defaultId, authPolicy } = {}) {
    this.store = store instanceof PersistenceAdapter ? store : new PersistenceAdapter(store);
    this.now = now;
    this.id = id;
    this.audit = new AuditService({ store: this.store, now });
    this.devices = new DeviceRegistry({ store: this.store, audit: this.audit, now, id });
    this.workflows = new WorkflowRegistry({ store: this.store, audit: this.audit, now });
    this.groups = new GroupRegistry({ store: this.store, audit: this.audit, now, id });
    this.jobs = new JobService({ store: this.store, audit: this.audit, now, id });
    this.events = new ExecutionEventStore({ store: this.store, now });
    this.auth = authPolicy || new AuthPolicy({ verifyCredential: () => false, ipAllowed: () => true });
    this.pairing = new PairingService({ store: this.store, audit: this.audit, now });
    this.sessions = new SessionManager({ core: this, now, id });
  }

  async load() {
    return this.store.load();
  }
}

function defaultId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export { buildDatasetAssignments } from './datasetAssignment.js';
export { ControllerCoreError, ERROR_CODES } from './errors.js';
export { PersistenceAdapter } from './persistenceAdapter.js';
export { PairingService, hashSecret } from './pairingService.js';
export { SessionManager } from './sessionManager.js';
export { assertTransition, companionToUnifiedStatus, TERMINAL_STATUSES, UNIFIED_JOB_STATUSES } from './stateTransitions.js';
