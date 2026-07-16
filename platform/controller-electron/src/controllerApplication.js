import { EventEmitter } from 'node:events';

export class ControllerApplicationService extends EventEmitter {
  constructor({ core, wssRuntime = null, version = '0.1.0' }) { super(); this.core = core; this.wssRuntime = wssRuntime; this.version = version; this.sequence = 0; }
  result(data) { return Object.freeze({ ok: true, data: structuredClone(data) }); }
  invalidate(domain, identifiers = {}) { this.emit('invalidation', Object.freeze({ sequence: ++this.sequence, domain, ...identifiers })); }
  getBootstrapState() { return this.result({ applicationVersion: this.version, protocolVersion: 'v1', deviceCount: this.core.devices.listDevices().devices.length, sessionCount: this.core.sessions.listSessions().length, groupCount: this.core.groups.listGroups().groups.length, workflowCount: this.core.workflows.listMetadata().length, wss: this.getRuntimeStatus().data }); }
  getRuntimeStatus() { return this.result({ enabled: Boolean(this.wssRuntime), status: this.wssRuntime ? 'running' : 'disabled' }); }
  listPairings() { return this.result({ pending: this.core.pairing.listPendingPairings(), paired: this.core.pairing.listPairedAgents() }); }
  listDevices() { return this.result(this.core.devices.listDevices()); }
  getDevice({ deviceId }) { return this.result(this.core.devices.getDevice(deviceId)); }
  listSessions() { return this.result({ sessions: this.core.sessions.listSessions() }); }
  listGroups() { return this.result(this.core.groups.listGroups()); }
  createGroup(payload) { const data = this.core.groups.createGroup(payload); this.invalidate('groups'); return this.result(data); }
  updateGroup({ groupId, ...payload }) { const data = this.core.groups.updateGroup(groupId, payload); this.invalidate('groups'); return this.result(data); }
  deleteGroup({ groupId }) { const data = this.core.groups.deleteGroup(groupId); this.invalidate('groups'); return this.result(data); }
  addDeviceToGroup({ groupId, deviceId }) { const data = this.core.groups.addDevice(groupId, deviceId); this.invalidate('groups', { deviceId }); return this.result(data); }
  removeDeviceFromGroup({ groupId, deviceId }) { const data = this.core.groups.removeDevice(groupId, deviceId); this.invalidate('groups', { deviceId }); return this.result(data); }
  listWorkflows() { return this.result({ workflows: this.core.workflows.listMetadata() }); }
  getWorkflowRevision({ workflowId, revision }) { return this.result(this.core.workflows.getRevision(workflowId, revision)); }
  importWorkflowRevision({ workflow }) { const data = this.core.workflows.putRevision(workflow); this.invalidate('workflows'); return this.result(data); }
  listJobs(payload) { return this.result({ jobs: this.core.jobs.listCommands(payload) }); }
  getJob({ jobId }) { return this.result(this.core.jobs.getCommand(jobId)); }
  listJobEvents(payload) { return this.result({ events: this.core.events.listRecent(payload) }); }
  dispatchWorkflow() { const error = new Error('Electron dispatch delivery is not available in this checkpoint'); error.code = 'DISPATCH_UNAVAILABLE'; throw error; }
  cancelJob({ jobId }) { const data = this.core.jobs.legacyResult(jobId, { ok: false, cancelled: true }); this.invalidate('jobs', { jobId }); return this.result(data); }
}
