import { buildDatasetAssignments } from './datasetAssignment.js';
import { requireDevice, rejectRevoked } from './deviceRegistry.js';
import { domainError, ERROR_CODES } from './errors.js';
import { assertTransition, companionToUnifiedStatus, TERMINAL_STATUSES, unifiedToCompanionStatus } from './stateTransitions.js';

export const COMMAND_TYPES = new Set(['run_profile', 'stop_run', 'get_state']);

export class JobService {
  constructor({ store, audit, now, id }) {
    this.store = store;
    this.audit = audit;
    this.now = now;
    this.id = id;
  }

  createDispatchPlan(body) {
    return this.store.update((state) => {
      const devices = state.devices.filter((device) => (body.deviceIds || []).includes(device.id));
      if (!devices.length) throw domainError(ERROR_CODES.INVALID_TARGET, 'No target devices');
      for (const device of devices) rejectRevoked(device);
      const batchId = this.id('batch');
      const assignments = buildDatasetAssignments({
        devices,
        inputs: body.inputs || {},
        dataset: body.dataset || [],
        assignmentMode: body.assignmentMode || 'same',
        allowDuplicate: body.allowDuplicate !== false,
        seed: body.seed || batchId
      });
      const targetSnapshot = { deviceIds: devices.map((device) => device.id), groupIds: body.groupIds || [] };
      const commands = assignments.map((assignment, index) => this.createCommand({
        id: this.id('cmd'),
        batchId,
        deviceId: assignment.deviceId,
        type: body.type || 'run_profile',
        profileId: body.profileId,
        inputs: assignment.inputs,
        notBefore: new Date(Date.now() + Number(body.delayMs || 0) * index).toISOString(),
        targetSnapshot,
        idempotencyKey: body.idempotencyKey ? `${body.idempotencyKey}:${assignment.deviceId}` : undefined
      }));
      const batch = {
        id: batchId,
        name: body.name || `Batch ${batchId}`,
        profileId: body.profileId,
        status: 'queued',
        assignmentMode: body.assignmentMode || 'same',
        allowDuplicate: body.allowDuplicate !== false,
        createdAt: this.now(),
        commandIds: commands.map((command) => command.id),
        targetSnapshot
      };
      state.commands.push(...commands);
      state.batches.push(batch);
      this.audit.append(state, 'job.created', { batchId, commandCount: commands.length });
      return summarizeBatch(batch, commands);
    });
  }

  enqueueLegacyCommand(body) {
    if (!COMMAND_TYPES.has(body.type)) throw domainError(ERROR_CODES.INVALID_TARGET, 'Unsupported command type');
    return this.store.update((state) => {
      const deviceId = body.deviceId || state.devices[0]?.id || 'legacy';
      if (!state.devices.some((device) => device.id === deviceId)) state.devices.push({ id: deviceId, name: 'Legacy endpoint', tokenHash: '', createdAt: this.now(), lastSeenAt: null, status: 'unknown', profiles: [] });
      const existing = body.idempotencyKey ? state.commands.find((command) => command.idempotencyKey === body.idempotencyKey) : null;
      if (existing) return structuredClone(existing);
      const command = this.createCommand({
        id: this.id('cmd'),
        deviceId,
        type: body.type,
        profileId: body.profileId,
        runId: body.runId,
        inputs: body.inputs || {},
        idempotencyKey: body.idempotencyKey
      });
      state.commands.push(command);
      return structuredClone(command);
    });
  }

  leaseNext(deviceId, leaseMs) {
    return this.store.update((state) => {
      requeueExpired(state, Date.now());
      const device = state.devices.find((item) => item.id === deviceId);
      if (device) rejectRevoked(device);
      const command = state.commands.find((item) => item.deviceId === deviceId && companionToUnifiedStatus(item.status) === 'queued' && Date.parse(item.notBefore || 0) <= Date.now());
      if (!command) return null;
      this.transition(command, 'dispatched', { leaseMs });
      command.status = unifiedToCompanionStatus('dispatched');
      return structuredClone(command);
    });
  }

  acknowledge(deviceId, commandId, leaseId) {
    return this.store.update((state) => {
      const command = requireCommand(state, deviceId, commandId, leaseId);
      this.transition(command, 'running');
      return structuredClone(command);
    });
  }

  finish(deviceId, commandId, leaseId, result) {
    return this.store.update((state) => {
      const command = requireCommand(state, deviceId, commandId, leaseId);
      const nextStatus = result?.ok === false ? 'failed' : 'succeeded';
      this.transition(command, nextStatus, { result });
      command.result = result;
      command.completedAt = this.now();
      state.results.push({ commandId, deviceId, result: redactResult(result), completedAt: command.completedAt });
      this.audit.append(state, 'job.terminal', { commandId, status: command.status });
      return structuredClone(command);
    });
  }

  legacyResult(commandId, result) {
    return this.store.update((state) => {
      const command = state.commands.find((item) => item.id === commandId);
      if (!command) throw domainError(ERROR_CODES.INVALID_TARGET, 'Command not found', 404);
      const nextStatus = result?.ok === false ? 'failed' : 'succeeded';
      this.transition(command, nextStatus, { result });
      command.result = result;
      command.completedAt = this.now();
      return { ok: true };
    });
  }

  cancelBatch(batchId) {
    return this.store.update((state) => {
      const batch = state.batches.find((item) => item.id === batchId);
      if (!batch) throw domainError(ERROR_CODES.INVALID_TARGET, 'Batch not found', 404);
      batch.status = 'cancelled';
      for (const command of state.commands.filter((item) => item.batchId === batchId && !TERMINAL_STATUSES.has(companionToUnifiedStatus(item.status)))) {
        this.transition(command, 'cancelled');
        command.completedAt = this.now();
      }
      this.audit.append(state, 'job.cancelled', { batchId });
      return summarizeBatch(batch, state.commands.filter((command) => command.batchId === batchId));
    });
  }

  getBatch(batchId) {
    const state = this.store.snapshot();
    const batch = state.batches.find((item) => item.id === batchId);
    if (!batch) throw domainError(ERROR_CODES.INVALID_TARGET, 'Batch not found', 404);
    return summarizeBatch(batch, state.commands.filter((command) => command.batchId === batchId));
  }

  getCommand(commandId) {
    const command = this.store.snapshot().commands.find((item) => item.id === commandId);
    if (!command) throw domainError(ERROR_CODES.INVALID_TARGET, 'Command not found', 404);
    return command;
  }

  listCommandsForDevice(deviceId) {
    return this.store.snapshot().commands.filter((item) => item.deviceId === deviceId).map((item) => structuredClone(item));
  }

  setDispatchMetadata(commandId, dispatchMetadata) {
    return this.store.update((state) => {
      const command = state.commands.find((item) => item.id === commandId);
      if (!command) throw domainError(ERROR_CODES.INVALID_TARGET, 'Command not found', 404);
      command.dispatchMetadata = structuredClone(dispatchMetadata);
      return structuredClone(command);
    });
  }

  createCommand(fields) {
    return {
      id: fields.id,
      deviceId: fields.deviceId,
      type: fields.type,
      profileId: fields.profileId,
      runId: fields.runId,
      inputs: fields.inputs || {},
      status: 'queued',
      attempt: 0,
      maxAttempts: 3,
      createdAt: this.now(),
      notBefore: fields.notBefore || this.now(),
      batchId: fields.batchId,
      targetSnapshot: fields.targetSnapshot,
      idempotencyKey: fields.idempotencyKey,
      dispatchMetadata: fields.dispatchMetadata
    };
  }

  transition(command, unifiedStatus, options = {}) {
    const from = companionToUnifiedStatus(command.status);
    assertTransition(from, unifiedStatus, { previousResult: command.result, nextResult: options.result });
    command.status = unifiedToCompanionStatus(unifiedStatus);
    if (unifiedStatus === 'dispatched') {
      command.attempt = Number(command.attempt || 0) + 1;
      command.leaseId = this.id('lease');
      command.leaseUntil = new Date(Date.now() + Number(options.leaseMs || 30000)).toISOString();
      command.startedAt ||= this.now();
    }
  }
}

export function requeueExpired(state, now = Date.now()) {
  for (const command of state.commands) {
    const status = companionToUnifiedStatus(command.status);
    if (status !== 'dispatched' && status !== 'running') continue;
    if (!command.leaseUntil || Date.parse(command.leaseUntil) > now) continue;
    if (Number(command.attempt || 0) >= Number(command.maxAttempts || 3)) {
      command.status = unifiedToCompanionStatus('failed');
      command.error = 'Lease expired';
      command.completedAt = new Date(now).toISOString();
    } else {
      command.status = 'queued';
      command.leaseId = null;
      command.leaseUntil = null;
      command.notBefore = new Date(now + 1000).toISOString();
    }
  }
}

export function summarizeBatch(batch, commands) {
  const counts = commands.reduce((acc, command) => {
    acc[command.status] = (acc[command.status] || 0) + 1;
    return acc;
  }, {});
  return { ...structuredClone(batch), counts, commands: structuredClone(commands) };
}

function requireCommand(state, deviceId, commandId, leaseId) {
  requireDevice(state, deviceId);
  const command = state.commands.find((item) => item.id === commandId && item.deviceId === deviceId);
  if (!command) throw domainError(ERROR_CODES.INVALID_TARGET, 'Command not found', 404);
  if (command.leaseId !== leaseId) throw domainError(ERROR_CODES.INVALID_TARGET, 'Lease mismatch');
  return command;
}

function redactResult(result) {
  if (Array.isArray(result)) return result.map(redactResult);
  if (!result || typeof result !== 'object') return result;
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [
    key,
    /password|passwd|token|secret|otp|pin|credential/i.test(key) ? '[REDACTED]' : redactResult(value)
  ]));
}
