import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { ERROR_CODES } from '../../controller-core/src/errors.js';
import { toPublicRuntimeConfig } from './runtimeConfig.js';

export const DISPATCH_DEADLINE_SECONDS = Object.freeze({ min: 10, default: 300, max: 86400 });
// Serialized renderer-provided workflow inputs are capped before command dispatch.
export const MAX_DISPATCH_INPUT_BYTES = 64 * 1024;
const MAX_INPUT_DEPTH = 8;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class ControllerApplicationService extends EventEmitter {
  constructor({ core, wssRuntime = null, wssTransport = null, config = null, version = '0.1.0', settingsStore = null, now = () => new Date().toISOString(), id = (prefix) => `${prefix}-${crypto.randomUUID()}` }) { super(); this.core = core; this.wssRuntime = wssRuntime; this.wssTransport = wssTransport || wssRuntime?.adapter || wssRuntime; this.config = config; this.version = version; this.settingsStore = settingsStore; this.now = now; this.id = id; this.sequence = 0; }
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
  listGroups() { return this.result(this.core.groups.listGroups()); }
  async createGroup(payload) { const data = await this.core.groups.createGroup(payload); this.invalidate('groups'); return this.result(data); }
  async updateGroup({ groupId, ...payload }) { const data = await this.core.groups.updateGroup(groupId, payload); this.invalidate('groups'); return this.result(data); }
  async deleteGroup({ groupId }) { const data = await this.core.groups.deleteGroup(groupId); this.invalidate('groups'); return this.result(data); }
  async addDeviceToGroup({ groupId, deviceId }) { const data = await this.core.groups.addDevice(groupId, deviceId); this.invalidate('groups', { deviceId }); return this.result(data); }
  async removeDeviceFromGroup({ groupId, deviceId }) { const data = await this.core.groups.removeDevice(groupId, deviceId); this.invalidate('groups', { deviceId }); return this.result(data); }
  listWorkflows() { return this.result({ workflows: this.core.workflows.listMetadata() }); }
  getWorkflowRevision({ workflowId, revision }) { return this.result(this.core.workflows.getRevision(workflowId, revision)); }
  async importWorkflowRevision({ workflow }) { const data = await this.core.workflows.putRevision(workflow); this.invalidate('workflows'); return this.result(data); }
  listJobs(payload) { return this.result({ jobs: this.core.jobs.listCommands(payload) }); }
  getJob({ jobId }) { return this.result(this.core.jobs.getCommand(jobId)); }
  listJobEvents(payload) { return this.result({ events: this.core.events.listRecent(payload) }); }
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

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
