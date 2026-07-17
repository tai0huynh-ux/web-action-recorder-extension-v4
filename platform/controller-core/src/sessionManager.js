import { PROTOCOL_VERSION, validateAgentEnvelope, validateEnvelope } from '../../protocol/src/protocolV2.js';
import { requireDevice } from './deviceRegistry.js';
import { domainError, ERROR_CODES } from './errors.js';
import { companionToUnifiedStatus } from './stateTransitions.js';

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_MAX_IDEMPOTENCY = 1000;

export class SessionManager {
  constructor({ core, now = () => new Date().toISOString(), id = (prefix) => `${prefix}-${Date.now()}`, heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS, maxSessions = DEFAULT_MAX_SESSIONS, maxIdempotency = DEFAULT_MAX_IDEMPOTENCY } = {}) {
    this.core = core;
    this.now = now;
    this.id = id;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.maxSessions = maxSessions;
    this.maxIdempotency = maxIdempotency;
    this.sessions = new Map();
    this.idempotency = new Map();
  }

  async authenticateHello(envelope, { credential }) {
    const validation = validateAgentEnvelope(envelope);
    if (!validation.ok) throw domainError(ERROR_CODES.INVALID_TARGET, 'Invalid AgentHello envelope', 400, validation.errors);
    if (envelope.payload.protocolVersion !== PROTOCOL_VERSION) throw domainError(ERROR_CODES.INVALID_TARGET, 'Protocol version rejected', 426);
    const device = envelope.payload.device;
    this.core.pairing.verifyCredential(device.deviceId, credential);
    if (this.sessions.size >= this.maxSessions && !this.sessions.has(device.deviceId)) throw domainError(ERROR_CODES.CAPACITY_EXCEEDED, 'Session registry limit exceeded', 413);
    const previous = this.sessions.get(device.deviceId);
    if (previous?.close) previous.close({ code: 'replaced', generation: previous.generation });
    const session = {
      sessionId: this.id('session'),
      generation: Number(previous?.generation || 0) + 1,
      deviceId: device.deviceId,
      nonce: envelope.payload.sessionNonce,
      connectedAt: this.now(),
      lastSeenAt: this.now(),
      status: 'online',
      close: null,
      pendingJobs: new Map()
    };
    this.sessions.set(device.deviceId, session);
    await this.core.devices.registerDevice(device.deviceId, descriptorToRegistration(device));
    return publicSession(session);
  }

  attachClose(deviceId, generation, close) {
    const session = this.requireSession(deviceId, generation);
    session.close = close;
  }

  async handlePresence(envelope) {
    const validation = validateAgentEnvelope(envelope);
    if (!validation.ok) throw domainError(ERROR_CODES.INVALID_TARGET, 'Invalid presence envelope', 400, validation.errors);
    const session = this.requireSession(envelope.deviceId || envelope.payload.deviceId, sessionGeneration(envelope));
    session.status = envelope.payload.status;
    session.lastSeenAt = envelope.payload.lastSeenAt;
    await this.core.devices.heartbeat(session.deviceId, { status: envelope.payload.status });
    return publicSession(session);
  }

  async markHeartbeat(deviceId, generation) {
    const session = this.requireSession(deviceId, generation);
    session.lastSeenAt = this.now();
    session.status = 'online';
    await this.core.devices.heartbeat(deviceId, { status: 'online' });
    return publicSession(session);
  }

  async expireHeartbeats() {
    const nowMs = Date.parse(this.now());
    const expired = [];
    for (const session of this.sessions.values()) {
      if (nowMs - Date.parse(session.lastSeenAt) <= this.heartbeatTimeoutMs) continue;
      session.status = 'offline';
      await this.core.devices.setStatus(session.deviceId, 'offline');
      expired.push(publicSession(session));
    }
    return expired;
  }

  async reconcileWorkflows(deviceId, generation, revisions = []) {
    this.requireSession(deviceId, generation);
    const results = [];
    for (const revision of revisions) results.push(await this.core.workflows.putRevision(revision));
    return results;
  }

  async dispatch({ deviceId, generation, workflowId, workflowRevision, workflowContentHash, inputs = {}, deadline, idempotencyKey }) {
    const session = this.requireSession(deviceId, generation);
    if (!deadline || Date.parse(deadline) <= Date.parse(this.now())) throw domainError(ERROR_CODES.JOB_EXPIRED, 'Dispatch deadline expired', 408);
    const ledgerKey = `dispatch:${idempotencyKey}`;
    const existing = this.idempotency.get(ledgerKey);
    if (existing) return structuredClone(existing);
    const workflow = this.core.workflows.getRevision(workflowId, workflowRevision);
    if (workflow.contentHash !== workflowContentHash) throw domainError(ERROR_CODES.WORKFLOW_HASH_MISMATCH, 'Workflow content hash mismatch', 409);
    const command = await this.core.jobs.enqueueLegacyCommand({
      type: 'run_profile',
      deviceId,
      profileId: workflowId,
      inputs,
      idempotencyKey
    });
    if (command.dispatchMetadata) {
      const result = { command, dispatch: structuredClone(command.dispatchMetadata) };
      session.pendingJobs.set(command.id, { payload: result.dispatch, generation });
      this.remember(ledgerKey, result);
      return structuredClone(result);
    }
    const leased = await this.core.jobs.leaseNext(deviceId, Math.max(1000, Date.parse(deadline) - Date.parse(this.now())));
    if (!leased) throw domainError(ERROR_CODES.INVALID_TARGET, 'No dispatchable command available', 409);
    const payload = {
      schemaVersion: 1,
      jobId: leased.id,
      workflowId,
      workflowRevision,
      workflowContentHash,
      inputs,
      deadline,
      idempotencyKey,
      controlPath: 'native_bridge',
      leaseId: leased.leaseId
    };
    const persisted = await this.core.jobs.setDispatchMetadata(leased.id, payload);
    session.pendingJobs.set(leased.id, { payload, generation });
    const result = { command: persisted, dispatch: payload };
    this.remember(ledgerKey, result);
    return structuredClone(result);
  }

  async cancel({ deviceId, generation, jobId, idempotencyKey }) {
    const session = this.requireSession(deviceId, generation);
    const ledgerKey = `cancel:${idempotencyKey}`;
    const existing = this.idempotency.get(ledgerKey);
    if (existing) return structuredClone(existing);
    const job = this.core.jobs.getCommand(jobId);
    if (job.deviceId !== deviceId) throw domainError(ERROR_CODES.INVALID_TARGET, 'Job does not belong to device', 409);
    const cancelled = await this.core.jobs.cancelCommand(jobId);
    session.pendingJobs.delete(jobId);
    const result = { ok: true, job: cancelled };
    this.remember(ledgerKey, result);
    return result;
  }

  async receiveExecutionEvent(envelope) {
    const validation = validateEnvelope(envelope, { expectedTypes: ['agent.execution.event', 'execution.event', 'execution.result', 'execution.cancelled'] });
    if (!validation.ok) throw domainError(ERROR_CODES.INVALID_TARGET, 'Invalid execution envelope', 400, validation.errors);
    const session = this.requireSession(envelope.deviceId, sessionGeneration(envelope));
    const command = this.core.jobs.getCommand(envelope.jobId || envelope.payload.jobId);
    if (command.deviceId !== session.deviceId) throw domainError(ERROR_CODES.INVALID_TARGET, 'Stale session event rejected', 409);
    if (envelope.sessionId !== session.sessionId) throw domainError(ERROR_CODES.INVALID_TARGET, 'Stale session event rejected', 409);
    const event = await this.core.events.appendEvent({ ...envelope.payload, deviceId: session.deviceId, jobId: command.id });
    if ((envelope.type === 'agent.execution.event' || envelope.type === 'execution.event') && envelope.payload.eventType === 'job_started' && companionToUnifiedStatus(command.status) === 'dispatched') {
      await this.core.jobs.acknowledge(session.deviceId, command.id, command.leaseId);
    }
    if (envelope.type === 'execution.result') {
      if (companionToUnifiedStatus(command.status) === 'dispatched') await this.core.jobs.acknowledge(session.deviceId, command.id, command.leaseId);
      await this.core.jobs.finish(session.deviceId, command.id, command.leaseId, envelope.payload.result || { ok: envelope.payload.eventType === 'job_succeeded' });
      session.pendingJobs.delete(command.id);
    }
    if (envelope.type === 'execution.cancelled') {
      session.pendingJobs.delete(command.id);
    }
    return event;
  }

  async replayNonTerminal(deviceId, generation) {
    const session = this.requireSession(deviceId, generation);
    const commands = await this.core.jobs.prepareReplayDispatches(deviceId, { now: Date.parse(this.now()) });
    const replay = [];
    for (const payload of commands) {
      session.pendingJobs.set(payload.jobId, { payload, generation });
      replay.push(payload);
    }
    return replay;
  }

  async disconnect(deviceId, generation, status = 'reconnecting') {
    const session = this.sessions.get(deviceId);
    if (!session || session.generation !== generation) return false;
    session.status = status;
    session.lastSeenAt = this.now();
    await this.core.devices.setStatus(deviceId, status);
    await this.core.jobs.failRunningForDevice(deviceId);
    return true;
  }

  shutdown() {
    for (const session of this.sessions.values()) {
      session.close?.({ code: 'shutdown' });
    }
    this.sessions.clear();
    this.idempotency.clear();
  }

  listSessions() {
    return [...this.sessions.values()].map(publicSession);
  }

  getPublicSession(deviceId) {
    const session = this.sessions.get(deviceId);
    return session ? publicSession(session) : null;
  }

  requireSession(deviceId, generation) {
    const session = this.sessions.get(deviceId);
    if (!session || (generation !== undefined && session.generation !== generation)) throw domainError(ERROR_CODES.AUTH_DENIED, 'Active session not found', 401);
    requireDevice(this.core.store.snapshot(), deviceId);
    return session;
  }

  remember(key, result) {
    this.idempotency.set(key, structuredClone(result));
    if (this.idempotency.size > this.maxIdempotency) this.idempotency.delete(this.idempotency.keys().next().value);
  }
}

function descriptorToRegistration(device) {
  return {
    name: device.displayName,
    groupIds: device.groupIds,
    labels: device.labels,
    extensionVersion: device.extensionVersion,
    browser: device.browserVersion,
    capabilities: device.capabilities
  };
}

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    generation: session.generation,
    deviceId: session.deviceId,
    status: session.status,
    lastSeenAt: session.lastSeenAt
  };
}

function sessionGeneration(envelope) {
  return envelope?.payload?.generation ?? envelope?.generation;
}
