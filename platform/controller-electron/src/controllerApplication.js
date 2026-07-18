import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { ERROR_CODES } from '../../controller-core/src/errors.js';
import { mapFieldsToNamedInputs, mapRowsToDevices, parseInputText } from '../../input-parser/src/inputParser.js';
import { createWorkflowRevisionFromExtensionProfile, extensionProfileFromWorkflowRevision } from '../../workflow-core/src/workflowMetadata.js';
import { applyLinksToSteps, collectOutgoingIds, validateGraph } from '../../../src/graph.js';
import { normalizeProfile, validateProfile } from '../../../src/shared.js';
import { toPublicRuntimeConfig } from './runtimeConfig.js';

export const DISPATCH_DEADLINE_SECONDS = Object.freeze({ min: 10, default: 300, max: 86400 });
// Serialized renderer-provided workflow inputs are capped before command dispatch.
export const MAX_DISPATCH_INPUT_BYTES = 64 * 1024;
const MAX_INPUT_DEPTH = 8;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_GROUPED_INPUT_BYTES = 64 * 1024;
const MAX_GROUPED_INPUT_ROWS = 200;
const GROUPED_INPUT_MODES = new Set(['text', 'table', 'cell']);

export class ControllerApplicationService extends EventEmitter {
  constructor({ core, wssRuntime = null, wssTransport = null, containerAdapter = null, config = null, version = '0.1.0', settingsStore = null, now = () => new Date().toISOString(), id = (prefix) => `${prefix}-${crypto.randomUUID()}` }) { super(); this.core = core; this.wssRuntime = wssRuntime; this.wssTransport = wssTransport || wssRuntime?.adapter || wssRuntime; this.containerAdapter = containerAdapter; this.config = config; this.version = version; this.settingsStore = settingsStore; this.now = now; this.id = id; this.sequence = 0; }
  result(data) { return Object.freeze({ ok: true, data: structuredClone(data) }); }
  invalidate(domain, identifiers = {}) { this.emit('invalidation', Object.freeze({ sequence: ++this.sequence, domain, ...identifiers })); }
  getBootstrapState() { return this.result({ applicationVersion: this.version, protocolVersion: 'v1', deviceCount: this.core.devices.listDevices().devices.length, sessionCount: this.core.sessions.listSessions().length, groupCount: this.core.groups.listGroups().groups.length, workflowCount: this.core.workflows.listMetadata().length, wss: this.getRuntimeStatus().data }); }
  getRuntimeStatus() {
    const publicConfig = this.config ? toPublicRuntimeConfig(this.config) : null;
    return this.result({
      enabled: Boolean(this.wssRuntime),
      status: this.wssRuntime ? 'running' : (publicConfig?.wss?.status || 'disabled'),
      bindHost: publicConfig?.wss?.host || '127.0.0.1',
      port: this.wssRuntime?.server?.address?.()?.port || publicConfig?.wss?.port || 0,
      storeStatus: publicConfig?.storeStatus || 'loaded',
      degraded: Boolean(publicConfig?.degraded),
      applicationVersion: this.version,
      protocolVersion: 'v1'
    });
  }
  listPairings() { return this.result({ pending: this.core.pairing.listPendingPairings(), paired: this.core.pairing.listPairedAgents() }); }
  async requestPairing({ device, displayName, requestId }) { const data = await this.core.pairing.requestPairing({ device, displayName, requestId }); this.invalidate('pairings', { deviceId: device?.deviceId }); return this.result(data); }
  async confirmPairing({ requestId, code }) { const data = await this.core.pairing.confirmPairing(requestId, code); this.invalidate('pairings', { deviceId: data.deviceId }); this.invalidate('devices', { deviceId: data.deviceId }); return this.result(data); }
  async rejectPairing({ pairingId, reason }) { const data = await this.core.pairing.rejectPairing(pairingId, reason); this.invalidate('pairings'); return this.result(data); }
  async revokeAgent({ deviceId }) {
    const data = await this.core.pairing.revoke(deviceId);
    await this.core.sessions.closeDeviceSession(deviceId, 'revoked');
    this.invalidate('pairings', { deviceId });
    this.invalidate('devices', { deviceId });
    this.invalidate('sessions', { deviceId });
    return this.result(data);
  }
  listDevices() { return this.result(this.core.devices.listDevices()); }
  getDevice({ deviceId }) { return this.result(this.core.devices.getDevice(deviceId)); }
  async getSettings() { return this.result(await this.settingsStore.get()); }
  async updateSettings(payload) { const data = await this.settingsStore.update(payload); this.invalidate('settings'); return this.result(data); }
  listSessions() { return this.result({ sessions: this.core.sessions.listSessions() }); }
  listContainers() { return this.result(this.core.containers.listContainers()); }
  async addContainer(payload) {
    const deviceId = payload.deviceId || `managed-${crypto.randomUUID()}`;
    const provisioning = await this.core.pairing.provisionManagedAgent({
      device: managedDeviceDescriptor({ deviceId, displayName: payload.name }),
      displayName: payload.name,
    });
    const container = await this.core.containers.createContainer({ ...payload, deviceId });
    const operation = await this.safeContainerOperation('create', { ...container, provisioning });
    const next = operation.ok ? await this.core.containers.updateStatus(container.id, operation.status || 'running', { desiredState: 'running', runtime: operation.runtime }) : await this.core.containers.updateStatus(container.id, 'failed', { lastError: operation.error });
    if (!operation.ok) await this.core.pairing.revoke(deviceId).catch(() => {});
    this.invalidate('containers', { containerId: container.id });
    this.invalidate('pairings', { deviceId });
    this.invalidate('devices', { deviceId });
    return this.result({ container: next, operation });
  }
  async startContainer({ containerId }) { return this.containerLifecycle(containerId, 'start', 'running', 'running'); }
  async stopContainer({ containerId }) { return this.containerLifecycle(containerId, 'stop', 'stopped', 'stopped'); }
  async restartContainer({ containerId }) { return this.containerLifecycle(containerId, 'restart', 'running', 'running'); }
  async refreshContainer({ containerId }) {
    const container = this.core.containers.getContainer(containerId);
    const operation = await this.safeContainerOperation('status', container);
    const next = operation.ok ? await this.core.containers.updateStatus(containerId, operation.status || container.status, { resourceUsage: operation.resourceUsage, runtime: operation.runtime }) : await this.core.containers.updateStatus(containerId, 'failed', { lastError: operation.error });
    this.invalidate('containers', { containerId });
    return this.result({ container: next, operation });
  }
  async duplicateContainer({ containerId, name }) {
    const source = this.core.containers.getContainer(containerId);
    const deviceId = `managed-${crypto.randomUUID()}`;
    const provisioning = await this.core.pairing.provisionManagedAgent({
      device: managedDeviceDescriptor({ deviceId, displayName: name || `${source.name} copy` }),
      displayName: name || `${source.name} copy`,
    });
    const dockerName = `${source.runtime?.dockerName || source.id}-copy-${crypto.randomUUID().slice(0, 8)}`;
    const container = await this.core.containers.duplicateContainer(containerId, {
      name,
      deviceId,
      runtime: { ...source.runtime, dockerName },
    });
    const operation = await this.safeContainerOperation('create', { ...container, provisioning });
    const next = operation.ok ? await this.core.containers.updateStatus(container.id, operation.status || 'running', { desiredState: 'running', runtime: operation.runtime }) : await this.core.containers.updateStatus(container.id, 'failed', { lastError: operation.error });
    if (!operation.ok) await this.core.pairing.revoke(deviceId).catch(() => {});
    this.invalidate('containers', { containerId: container.id });
    this.invalidate('pairings', { deviceId });
    this.invalidate('devices', { deviceId });
    return this.result({ container: next, operation });
  }
  async deleteContainer({ containerId }) {
    const container = this.core.containers.getContainer(containerId);
    if (container.deviceId) {
      await this.revokeAgent({ deviceId: container.deviceId }).catch((error) => {
        if (error?.code !== 'DEVICE_NOT_FOUND') throw error;
      });
    }
    const operation = await this.safeContainerOperation('delete', container);
    const next = operation.ok
      ? await this.core.containers.deleteContainer(containerId)
      : await this.core.containers.updateStatus(containerId, 'failed', { desiredState: 'deleted', lastError: operation.error });
    this.invalidate('containers', { containerId });
    return this.result({ container: next, operation });
  }
  listGroups() { return this.result(this.core.groups.listGroups()); }
  async createGroup(payload) { const data = await this.core.groups.createGroup(payload); this.invalidate('groups'); return this.result(data); }
  async updateGroup({ groupId, ...payload }) { const data = await this.core.groups.updateGroup(groupId, payload); this.invalidate('groups'); return this.result(data); }
  async deleteGroup({ groupId }) { const data = await this.core.groups.deleteGroup(groupId); this.invalidate('groups'); return this.result(data); }
  async addDeviceToGroup({ groupId, deviceId }) { const data = await this.core.groups.addDevice(groupId, deviceId); this.invalidate('groups', { deviceId }); return this.result(data); }
  async removeDeviceFromGroup({ groupId, deviceId }) { const data = await this.core.groups.removeDevice(groupId, deviceId); this.invalidate('groups', { deviceId }); return this.result(data); }
  listWorkflows() { return this.result({ workflows: this.core.workflows.listMetadata() }); }
  getWorkflowRevision({ workflowId, revision }) { return this.result(this.core.workflows.getRevision(workflowId, revision)); }
  async importWorkflowRevision({ workflow }) { const data = await this.core.workflows.putRevision(workflow); this.invalidate('workflows'); return this.result(data); }
  getWorkflowGraph(payload) { return this.result(this.buildWorkflowGraph(payload)); }
  previewWorkflowGraph(payload) { return this.result(this.buildWorkflowGraph(payload)); }
  async saveWorkflowGraph(payload) {
    const request = validateGraphRequest(payload);
    const current = this.core.workflows.getRevision(request.workflowId, request.revision);
    const profile = applyGraphOperations(extensionProfileFromWorkflowRevision(current), request.operations, this.id);
    validateProfile(profile);
    const validation = validateGraph(profile);
    if (!validation.ok) throw codedError('WORKFLOW_GRAPH_INVALID', 'Workflow graph is invalid', validation.errors);
    const nextRevision = createWorkflowRevisionFromExtensionProfile(profile, {
      sourceDeviceId: 'controller-graph',
      revision: current.revision + 1,
      now: this.now(),
    });
    const saved = await this.core.workflows.putRevision(nextRevision);
    this.invalidate('workflows');
    return this.result({ saved, graph: graphView(saved.revision) });
  }
  buildWorkflowGraph(payload) {
    const request = validateGraphRequest(payload);
    const workflow = this.core.workflows.getRevision(request.workflowId, request.revision);
    const profile = request.operations.length
      ? applyGraphOperations(extensionProfileFromWorkflowRevision(workflow), request.operations, this.id)
      : extensionProfileFromWorkflowRevision(workflow);
    return {
      workflow: { workflowId: workflow.workflowId, revision: workflow.revision, name: workflow.name, contentHash: workflow.contentHash },
      nodes: profile.steps,
      edges: graphEdges(profile.steps),
      validation: validateGraph(profile),
      executionPlan: executionPlan(profile),
    };
  }
  async previewOriginSync({ deviceId }) {
    const session = this.requireOnlineSession(deviceId);
    const response = await this.wssTransport.requestOriginInventory(deviceId, session.generation, { entityTypes: ['workflows'] });
    const inventory = sanitizeOriginInventory(response.payload || {});
    const preview = this.buildOriginPreview(deviceId, inventory);
    return this.result(preview);
  }
  async pullOriginSync({ deviceId, conflictPolicy = 'preserveBoth' }) {
    if (!['preserveBoth', 'skip'].includes(conflictPolicy)) throw codedError('INVALID_ORIGIN_SYNC_POLICY', 'Unsupported origin sync policy');
    const session = this.requireOnlineSession(deviceId);
    const preview = this.buildOriginPreview(deviceId, sanitizeOriginInventory((await this.wssTransport.requestOriginInventory(deviceId, session.generation, { entityTypes: ['workflows'] })).payload || {}));
    const imported = [];
    const skipped = [];
    for (const item of preview.workflows) {
      if (item.action === 'skipIdentical' || (item.conflict && conflictPolicy === 'skip')) {
        skipped.push({ workflowId: item.workflowId, revision: item.revision, reason: item.action });
        continue;
      }
      const response = await this.wssTransport.requestOriginWorkflow(deviceId, session.generation, { workflowId: item.workflowId, revision: item.revision });
      if (response.payload?.error) throw codedError(response.payload.error.code || 'ORIGIN_WORKFLOW_GET_FAILED', response.payload.error.message || 'Origin workflow pull failed');
      const workflow = sanitizeOriginWorkflow(response.payload?.workflow);
      const result = await this.core.workflows.putRevision(workflow);
      imported.push({ workflowId: result.revision.workflowId, revision: result.revision.revision, created: result.created, contentHash: result.revision.contentHash });
    }
    const syncResult = await this.persistOriginSyncResult({ deviceId, conflictPolicy, imported, skipped, preview });
    this.invalidate('workflows');
    this.invalidate('originSync', { deviceId });
    return this.result(syncResult);
  }
  listJobs(payload) { return this.result({ jobs: this.core.jobs.listCommands(payload) }); }
  getJob({ jobId }) { return this.result(this.core.jobs.getCommand(jobId)); }
  listJobEvents(payload) { return this.result({ events: this.core.events.listRecent(payload) }); }
  previewGroupedInput(payload) { return this.result(this.buildGroupedInputPlan(payload)); }
  async dispatchGroupedInput(payload) {
    const plan = this.buildGroupedInputPlan(payload);
    const dispatched = [];
    for (const assignment of plan.assignments) {
      const result = await this.dispatchWorkflow({
        deviceId: assignment.deviceId,
        workflowId: plan.workflow.workflowId,
        revision: plan.workflow.revision,
        inputs: assignment.inputs,
        deadlineSeconds: plan.deadlineSeconds,
      });
      dispatched.push({ deviceId: assignment.deviceId, job: result.data.job, transport: result.data.transport });
    }
    return this.result({ ...plan, dispatched });
  }
  async dispatchWorkflow(payload) {
    const request = validateDispatchRequest(payload);
    const device = this.core.devices.getDevice(request.deviceId);
    if (device.revoked) throw codedError(ERROR_CODES.DEVICE_REVOKED, 'Device is revoked');
    const session = this.core.sessions.getPublicSession(request.deviceId);
    if (!session) throw codedError('SESSION_OFFLINE', 'Active session not found');
    const workflow = this.core.workflows.getRevision(request.workflowId, request.revision);
    const inputs = validateWorkflowInputs(workflow, request.inputs || {});
    const deadline = this.createDeadline(request.deadlineSeconds);
    const idempotencyKey = this.id('dispatch');
    const { command, dispatch } = await this.core.sessions.dispatch({
      deviceId: request.deviceId,
      generation: session.generation,
      workflowId: workflow.workflowId,
      workflowRevision: workflow.revision,
      workflowContentHash: workflow.contentHash,
      inputs,
      deadline,
      idempotencyKey
    });
    const transport = this.deliverDispatch(request.deviceId, session.generation, dispatch);
    this.invalidate('jobs', { jobId: command.id });
    return this.result({ job: sanitizeJob(command), transport });
  }

  async cancelJob({ jobId }) {
    const current = this.core.jobs.getCommand(jobId);
    const session = this.core.sessions.getPublicSession(current.deviceId);
    const job = await this.core.jobs.cancelCommand(jobId);
    const transport = this.deliverCancel(job, session);
    this.invalidate('jobs', { jobId });
    return this.result({ job: sanitizeJob(job), transport });
  }

  requireOnlineSession(deviceId) {
    const session = this.core.sessions.getPublicSession(deviceId);
    if (!session || session.status !== 'online') throw codedError('SESSION_OFFLINE', 'Origin device is not connected');
    if (!this.wssTransport?.requestOriginInventory || !this.wssTransport?.requestOriginWorkflow) throw codedError('ORIGIN_SYNC_UNAVAILABLE', 'Origin sync transport is unavailable');
    return session;
  }

  buildOriginPreview(deviceId, inventory) {
    const local = this.core.workflows.listMetadata();
    const workflows = inventory.workflows.map((item) => {
      const sameHash = local.find((entry) => entry.workflowId === item.workflowId && entry.contentHash === item.contentHash);
      const sameId = local.find((entry) => entry.workflowId === item.workflowId);
      const conflict = Boolean(!sameHash && sameId);
      return {
        workflowId: item.workflowId,
        revision: item.revision,
        name: item.name,
        contentHash: item.contentHash,
        updatedAt: item.updatedAt,
        conflict,
        action: sameHash ? 'skipIdentical' : conflict ? 'preserveBoth' : 'importNew',
      };
    });
    return { deviceId, counts: { workflows: workflows.length }, workflows };
  }

  async persistOriginSyncResult(result) {
    const item = {
      id: this.id('origin-sync'),
      deviceId: result.deviceId,
      conflictPolicy: result.conflictPolicy,
      imported: result.imported,
      skipped: result.skipped,
      previewCounts: result.preview.counts,
      completedAt: this.now(),
    };
    return this.core.store.update((state) => {
      state.originSyncResults ||= [];
      state.originSyncResults.push(item);
      if (state.originSyncResults.length > 100) state.originSyncResults = state.originSyncResults.slice(-100);
      this.core.audit.append(state, 'origin.sync.completed', { syncId: item.id, deviceId: item.deviceId, imported: item.imported.length, skipped: item.skipped.length });
      return structuredClone(item);
    });
  }

  createDeadline(deadlineSeconds) {
    const seconds = deadlineSeconds ?? DISPATCH_DEADLINE_SECONDS.default;
    if (!Number.isInteger(seconds) || seconds < DISPATCH_DEADLINE_SECONDS.min || seconds > DISPATCH_DEADLINE_SECONDS.max) {
      throw codedError('DEADLINE_SECONDS_OUT_OF_RANGE', 'Deadline seconds is outside the supported range');
    }
    return new Date(Date.parse(this.now()) + seconds * 1000).toISOString();
  }

  deliverDispatch(deviceId, generation, dispatch) {
    if (!this.wssTransport?.sendDispatch) return { delivered: false, warningCode: 'SESSION_OFFLINE' };
    try {
      this.wssTransport.sendDispatch(deviceId, generation, dispatch);
      return { delivered: true };
    } catch (error) {
      return { delivered: false, warningCode: typeof error?.code === 'string' ? error.code : 'WSS_SEND_FAILED' };
    }
  }

  deliverCancel(job, session) {
    if (!session || !this.wssTransport?.sendCancel) return { delivered: false, acknowledged: false, warningCode: 'SESSION_OFFLINE' };
    try {
      this.wssTransport.sendCancel(job.deviceId, session.generation, {
        jobId: job.id,
        deadline: this.createDeadline(DISPATCH_DEADLINE_SECONDS.default),
        idempotencyKey: this.id('cancel')
      });
      return { delivered: true, acknowledged: false };
    } catch (error) {
      return { delivered: false, acknowledged: false, warningCode: typeof error?.code === 'string' ? error.code : 'WSS_SEND_FAILED' };
    }
  }

  buildGroupedInputPlan(payload) {
    const request = validateGroupedInputRequest(payload);
    const workflow = this.core.workflows.getRevision(request.workflowId, request.revision);
    const definitions = Array.isArray(workflow.requiredInputs) ? workflow.requiredInputs : [];
    const devices = request.deviceIds.map((deviceId) => {
      const device = this.core.devices.getDevice(deviceId);
      if (device.revoked) throw codedError(ERROR_CODES.DEVICE_REVOKED, 'Device is revoked');
      return { id: device.id || device.deviceId, name: device.name || device.displayName || deviceId };
    });
    const parsed = parseInputText(request.text);
    if (parsed.rows.length > MAX_GROUPED_INPUT_ROWS) throw codedError('GROUPED_INPUT_TOO_MANY_ROWS', 'Grouped input has too many rows');
    const mappedRows = mapRowsToDevices({
      rows: parsed.rows,
      devices,
      expectedFieldCount: expectedFieldCountFor(definitions),
      broadcastSingleRow: request.broadcastSingleRow,
    });
    const assignments = mappedRows.map((row) => {
      const inputs = coerceGroupedInputs(mapFieldsToNamedInputs(row.fields, definitions), definitions);
      validateWorkflowInputs(workflow, inputs);
      return {
        deviceId: row.deviceId,
        sourceRowIndex: row.sourceRowIndex,
        inputs,
        preview: redactGroupedPreview(inputs, definitions),
      };
    });
    return {
      mode: request.mode,
      workflow: { workflowId: workflow.workflowId, revision: workflow.revision, name: workflow.name, requiredInputs: definitions },
      counts: { devices: devices.length, rows: parsed.rows.length, assignments: assignments.length },
      deadlineSeconds: request.deadlineSeconds,
      assignments,
    };
  }

  async containerLifecycle(containerId, action, status, desiredState) {
    const progressStatus = action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'restarting';
    const container = await this.core.containers.updateStatus(containerId, progressStatus, { desiredState });
    const operation = await this.safeContainerOperation(action, container);
    const next = operation.ok ? await this.core.containers.updateStatus(containerId, status, { desiredState, resourceUsage: operation.resourceUsage, runtime: operation.runtime }) : await this.core.containers.updateStatus(containerId, 'failed', { desiredState, lastError: operation.error });
    this.invalidate('containers', { containerId });
    return this.result({ container: next, operation });
  }

  async safeContainerOperation(action, container) {
    if (!this.containerAdapter?.[action]) return { ok: false, error: 'CONTAINER_ADAPTER_UNAVAILABLE' };
    try {
      const result = await this.containerAdapter[action](structuredClone(container));
      return { ok: true, ...(result || {}) };
    } catch (error) {
      return { ok: false, error: sanitizeContainerError(error) };
    }
  }
}

function validateDispatchRequest(payload) {
  if (!isPlainObject(payload)) throw codedError('INVALID_DISPATCH_PAYLOAD', 'Dispatch payload must be an object');
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key !== 'string' || !['deviceId', 'workflowId', 'revision', 'inputs', 'deadlineSeconds'].includes(key)) {
      throw codedError('INVALID_DISPATCH_PAYLOAD', 'Dispatch payload contains an unknown property');
    }
  }
  if (typeof payload.deviceId !== 'string' || payload.deviceId.trim() === '') throw codedError('INVALID_DISPATCH_PAYLOAD', 'Invalid deviceId');
  if (typeof payload.workflowId !== 'string' || payload.workflowId.trim() === '') throw codedError('INVALID_DISPATCH_PAYLOAD', 'Invalid workflowId');
  if (!Number.isInteger(payload.revision) || payload.revision < 1) throw codedError('INVALID_DISPATCH_PAYLOAD', 'Invalid revision');
  if (payload.inputs !== undefined && !isPlainObject(payload.inputs)) throw codedError('INVALID_WORKFLOW_INPUTS', 'Workflow inputs must be an object');
  return {
    deviceId: payload.deviceId,
    workflowId: payload.workflowId,
    revision: payload.revision,
    inputs: payload.inputs === undefined ? {} : structuredClone(payload.inputs),
    deadlineSeconds: payload.deadlineSeconds
  };
}

function validateGroupedInputRequest(payload) {
  if (!isPlainObject(payload)) throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'Grouped input payload must be an object');
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key !== 'string' || !['workflowId', 'revision', 'deviceIds', 'text', 'mode', 'broadcastSingleRow', 'deadlineSeconds'].includes(key)) {
      throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'Grouped input payload contains an unknown property');
    }
  }
  if (typeof payload.workflowId !== 'string' || payload.workflowId.trim() === '') throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'Invalid workflowId');
  if (!Number.isInteger(payload.revision) || payload.revision < 1) throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'Invalid revision');
  if (!Array.isArray(payload.deviceIds) || payload.deviceIds.length === 0 || payload.deviceIds.length > 200 || payload.deviceIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'At least one bounded deviceId is required');
  }
  if (typeof payload.text !== 'string') throw codedError('INVALID_GROUPED_INPUT_PAYLOAD', 'Grouped input text is required');
  if (Buffer.byteLength(payload.text, 'utf8') > MAX_GROUPED_INPUT_BYTES) throw codedError('GROUPED_INPUT_TOO_LARGE', 'Grouped input exceeds maximum size');
  const mode = payload.mode || 'text';
  if (!GROUPED_INPUT_MODES.has(mode)) throw codedError('INVALID_GROUPED_INPUT_MODE', 'Unsupported grouped input mode');
  return {
    workflowId: payload.workflowId,
    revision: payload.revision,
    deviceIds: [...payload.deviceIds],
    text: payload.text,
    mode,
    broadcastSingleRow: payload.broadcastSingleRow !== false,
    deadlineSeconds: payload.deadlineSeconds,
  };
}

function validateGraphRequest(payload) {
  if (!isPlainObject(payload)) throw codedError('INVALID_GRAPH_PAYLOAD', 'Graph payload must be an object');
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key !== 'string' || !['workflowId', 'revision', 'operations'].includes(key)) throw codedError('INVALID_GRAPH_PAYLOAD', 'Graph payload contains an unknown property');
  }
  if (typeof payload.workflowId !== 'string' || payload.workflowId.trim() === '') throw codedError('INVALID_GRAPH_PAYLOAD', 'Invalid workflowId');
  if (!Number.isInteger(payload.revision) || payload.revision < 1) throw codedError('INVALID_GRAPH_PAYLOAD', 'Invalid revision');
  if (payload.operations !== undefined && (!Array.isArray(payload.operations) || payload.operations.length > 100)) throw codedError('INVALID_GRAPH_PAYLOAD', 'Invalid graph operations');
  return { workflowId: payload.workflowId, revision: payload.revision, operations: structuredClone(payload.operations || []) };
}

function graphView(revision) {
  const profile = extensionProfileFromWorkflowRevision(revision);
  const validation = validateGraph(profile);
  return {
    workflowId: revision.workflowId,
    revision: revision.revision,
    contentHash: revision.contentHash,
    nodes: profile.steps,
    edges: graphEdges(profile.steps),
    validation,
    executionPlan: executionPlan(profile),
  };
}

function graphEdges(steps) {
  return steps.flatMap((step) => collectOutgoingIds(step).map((to) => ({ from: step.id, to })));
}

function executionPlan(profile) {
  const roots = validateGraph(profile).roots || [];
  const byId = new Map((profile.steps || []).map((step) => [step.id, step]));
  const seen = new Set();
  const ordered = [];
  const visit = (id) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    ordered.push(id);
    for (const next of collectOutgoingIds(byId.get(id))) visit(next);
  };
  roots.forEach(visit);
  return ordered;
}

function applyGraphOperations(profile, operations, idFactory) {
  const next = normalizeProfile(profile);
  for (const operation of operations) applyGraphOperation(next, operation, idFactory);
  return next;
}

function applyGraphOperation(profile, operation, idFactory) {
  if (!isPlainObject(operation) || typeof operation.type !== 'string') throw codedError('INVALID_GRAPH_OPERATION', 'Invalid graph operation');
  if (operation.type === 'addNode') {
    profile.steps.push(sanitizeGraphNode({ id: idFactory('step'), ...(operation.node || {}) }));
  } else if (operation.type === 'updateNode') {
    const index = profile.steps.findIndex((step) => step.id === operation.nodeId);
    if (index < 0) throw codedError('WORKFLOW_GRAPH_NODE_NOT_FOUND', 'Graph node not found');
    profile.steps[index] = sanitizeGraphNode({ ...profile.steps[index], ...(operation.patch || {}), id: profile.steps[index].id });
  } else if (operation.type === 'removeNode') {
    profile.steps = profile.steps.filter((step) => step.id !== operation.nodeId).map((step) => removeOutgoing(step, operation.nodeId));
  } else if (operation.type === 'addEdge') {
    setEdge(profile.steps, operation.from, operation.to, operation.fromPort || 'out');
  } else if (operation.type === 'removeEdge') {
    profile.steps = profile.steps.map((step) => step.id === operation.from ? removeOutgoing(step, operation.to) : step);
  } else {
    throw codedError('INVALID_GRAPH_OPERATION', 'Unsupported graph operation');
  }
}

function sanitizeGraphNode(node) {
  const allowed = new Set(['id', 'name', 'type', 'selector', 'text', 'message', 'url', 'keys', 'shortcut', 'delayAfterMs', 'condition', 'conditions', 'ifSteps', 'elseSteps', 'next', 'ui', 'timeoutMs']);
  const clean = {};
  for (const [key, value] of Object.entries(node)) if (allowed.has(key)) clean[key] = structuredClone(value);
  clean.id = typeof clean.id === 'string' && clean.id.trim() ? clean.id : `step-${crypto.randomUUID()}`;
  clean.name = typeof clean.name === 'string' && clean.name.trim() ? clean.name.slice(0, 120) : clean.id;
  clean.type = typeof clean.type === 'string' ? clean.type : 'log';
  return clean;
}

function setEdge(steps, from, to, fromPort) {
  if (!steps.some((step) => step.id === from) || !steps.some((step) => step.id === to)) throw codedError('WORKFLOW_GRAPH_NODE_NOT_FOUND', 'Graph edge references missing node');
  const links = graphLinks(steps).filter((link) => !(link.from === from && link.fromPort === fromPort));
  links.push({ from, fromPort, to, toPort: 'in' });
  const next = applyLinksToSteps(steps, links);
  steps.splice(0, steps.length, ...next);
}

function graphLinks(steps) {
  const links = [];
  for (const step of steps) {
    if (step.next) links.push({ from: step.id, fromPort: 'out', to: step.next, toPort: 'in' });
    (step.ifSteps || []).forEach((to) => links.push({ from: step.id, fromPort: 'if-out', to, toPort: 'in' }));
    (step.elseSteps || []).forEach((to) => links.push({ from: step.id, fromPort: 'else-out', to, toPort: 'in' }));
    (step.conditions || []).forEach((condition, index) => condition.next && links.push({ from: step.id, fromPort: `cond-${index}-out`, to: condition.next, toPort: 'in' }));
  }
  return links;
}

function removeOutgoing(step, targetId) {
  const next = { ...step };
  if (next.next === targetId) delete next.next;
  if (Array.isArray(next.ifSteps)) next.ifSteps = next.ifSteps.filter((id) => id !== targetId);
  if (Array.isArray(next.elseSteps)) next.elseSteps = next.elseSteps.filter((id) => id !== targetId);
  if (Array.isArray(next.conditions)) next.conditions = next.conditions.map((condition) => condition.next === targetId ? { ...condition, next: null } : condition);
  return next;
}

function expectedFieldCountFor(definitions) {
  if (!definitions.length) return 0;
  return definitions.reduce((max, definition) => Math.max(max, definition.index), -1) + 1;
}

function redactGroupedPreview(inputs, definitions) {
  const sensitive = new Set(definitions.filter((definition) => definition.sensitive).map((definition) => definition.name));
  return Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, sensitive.has(key) ? '[REDACTED]' : value]));
}

function coerceGroupedInputs(inputs, definitions) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const coerced = {};
  for (const [key, value] of Object.entries(inputs)) {
    const definition = byName.get(key);
    const type = definition?.type || definition?.schema?.type;
    if (value === '' || type === undefined || typeof value !== 'string') {
      coerced[key] = value;
    } else if (type === 'integer' && /^-?\d+$/.test(value)) {
      coerced[key] = Number(value);
    } else if (type === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) {
      coerced[key] = Number(value);
    } else if (type === 'boolean' && ['true', 'false'].includes(value.toLowerCase())) {
      coerced[key] = value.toLowerCase() === 'true';
    } else {
      coerced[key] = value;
    }
  }
  return coerced;
}

function validateWorkflowInputs(workflow, inputs) {
  assertInputSafe(inputs);
  const definitions = Array.isArray(workflow.requiredInputs) ? workflow.requiredInputs : [];
  if (definitions.some((definition) => definition?.sensitive)) throw codedError('SENSITIVE_INPUT_UNSUPPORTED', 'Sensitive workflow inputs are not supported');
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  for (const key of Object.keys(inputs)) {
    if (!byName.has(key)) throw codedError('UNKNOWN_WORKFLOW_INPUT', 'Workflow input is not defined');
  }
  const sanitized = {};
  for (const definition of definitions) {
    const hasInput = Object.hasOwn(inputs, definition.name);
    if (!hasInput && definition.required && !Object.hasOwn(definition, 'defaultValue')) throw codedError('MISSING_WORKFLOW_INPUT', 'Required workflow input is missing');
    if (!hasInput && Object.hasOwn(definition, 'defaultValue')) {
      sanitized[definition.name] = structuredClone(definition.defaultValue);
      continue;
    }
    if (hasInput) {
      assertInputType(definition, inputs[definition.name]);
      sanitized[definition.name] = structuredClone(inputs[definition.name]);
    }
  }
  assertInputSize(sanitized);
  return sanitized;
}

function assertInputSafe(value, depth = 0) {
  if (depth > MAX_INPUT_DEPTH) throw codedError('WORKFLOW_INPUT_TOO_DEEP', 'Workflow input nesting is too deep');
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertInputSafe(item, depth + 1);
    return;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) throw codedError('DANGEROUS_WORKFLOW_INPUT', 'Workflow input contains a dangerous key');
    assertInputSafe(value[key], depth + 1);
  }
}

function assertInputSize(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DISPATCH_INPUT_BYTES) throw codedError('WORKFLOW_INPUT_TOO_LARGE', 'Workflow inputs exceed maximum serialized size');
}

function assertInputType(definition, value) {
  const expected = definition.type || definition.schema?.type;
  if (!expected) return;
  const ok = expected === 'array' ? Array.isArray(value)
    : expected === 'integer' ? Number.isInteger(value)
      : expected === 'object' ? isPlainObject(value)
        : typeof value === expected;
  if (!ok) throw codedError('WORKFLOW_INPUT_TYPE_MISMATCH', 'Workflow input type is not compatible with its definition');
}

function sanitizeJob(job) {
  const { inputs: _inputs, dispatchMetadata: _dispatchMetadata, leaseId: _leaseId, ...safe } = job;
  return structuredClone(safe);
}

function sanitizeOriginInventory(payload = {}) {
  const workflows = Array.isArray(payload.workflows) ? payload.workflows.slice(0, 200).map((item) => ({
    workflowId: String(item.workflowId || ''),
    revision: Number.isInteger(item.revision) ? item.revision : 1,
    name: String(item.name || item.workflowId || 'Workflow').slice(0, 200),
    contentHash: String(item.contentHash || ''),
    updatedAt: String(item.updatedAt || item.createdAt || ''),
  })).filter((item) => item.workflowId && /^[a-f0-9]{64}$/.test(item.contentHash)) : [];
  return { workflows };
}

function sanitizeOriginWorkflow(workflow) {
  const clone = structuredClone(workflow || {});
  stripSecretLikeFields(clone);
  return clone;
}

function stripSecretLikeFields(value) {
  if (Array.isArray(value)) return value.forEach(stripSecretLikeFields);
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (/password|passwd|token|secret|credential|cookie/i.test(key)) delete value[key];
    else stripSecretLikeFields(value[key]);
  }
}

function managedDeviceDescriptor({ deviceId, displayName }) {
  return {
    deviceId,
    displayName,
    hostName: 'managed-container',
    platform: 'linux',
    architecture: 'x64',
    agentVersion: 'managed',
    extensionVersion: '',
    browserVersion: '',
    protocolVersion: 'v1',
    capabilities: {
      workflowExecution: true,
      semanticControl: true,
      rawViewportInput: true,
      rawBrowserInput: true,
      nativeX11Input: true,
      screenshot: true,
      clipboardText: true,
      synchronizedInput: false
    },
    labels: ['managed-container'],
    groupIds: []
  };
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeContainerError(error) {
  return String(error?.message || error || 'Container operation failed')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(credential|token|password)=\S+/gi, '$1=[REDACTED]')
    .slice(0, 500);
}
