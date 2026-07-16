import { EventEmitter } from 'node:events';
import { PROTOCOL_VERSION, validateNativeBridgeEnvelope } from '../../protocol/src/protocolV2.js';

const MAX_PENDING_DOWNLINK = 128;

export class NativeBridgeHandler extends EventEmitter {
  constructor({ identity, registry, version, supervisor, dispatcher, log = () => {}, now = () => new Date().toISOString(), onExecutionEnvelope = null } = {}) {
    super();
    this.identity = identity;
    this.registry = registry;
    this.version = version;
    this.supervisor = supervisor;
    this.dispatcher = dispatcher;
    this.log = log;
    this.now = now;
    this.onExecutionEnvelope = onExecutionEnvelope;
    this.jobs = new Map();
    this.pendingDownlink = [];
    this.activeJobs = new Map();
    this.completedJobs = new Set();
  }

  async handle(envelope) {
    const validation = validateNativeBridgeEnvelope(envelope);
    if (!validation.ok) return this.response(envelope, { ok: false, error: { code: 'invalid_envelope', details: validation.errors } });
    switch (envelope.type) {
      case 'bridge.hello':
      case 'bridge.health':
      case 'native.bridge.request':
        return this.handleBridgeRequest(envelope);
      case 'bridge.health.request':
        return this.handleBridgePoll(envelope);
      case 'workflow.upload':
        return this.handleWorkflowUpload(envelope);
      case 'workflow.list':
        return this.response(envelope, { ok: true, workflows: this.registry.listMetadata() });
      case 'workflow.get':
        return this.handleWorkflowGet(envelope);
      case 'execution.event':
      case 'execution.result':
      case 'execution.cancelled':
      case 'emergency.stop.ack':
        return this.handleExecutionEvent(envelope);
      default:
        return this.response(envelope, { ok: false, error: { code: 'unsupported_message', message: `Unsupported message ${envelope.type}` } });
    }
  }

  async handleBridgeRequest(envelope) {
    const state = this.supervisor?.getState?.() || {};
    return this.response(envelope, {
      ok: true,
      type: envelope.type === 'bridge.hello' ? 'bridge.welcome' : 'bridge.health.result',
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.identity.deviceId,
      version: this.version,
      capabilities: {
        workflowExecution: true,
        nativeBridge: true,
        legacyCompanionPolling: true
      },
      browserState: state.browserState,
      extensionLoaded: state.extensionLoaded
    });
  }

  handleWorkflowUpload(envelope) {
    const result = this.registry.putRevision(envelope.payload.revision);
    return this.response(envelope, {
      ok: true,
      type: 'workflow.upload.result',
      created: result.created,
      revision: result.revision.revision,
      workflowId: result.revision.workflowId,
      contentHash: result.revision.contentHash
    });
  }

  handleWorkflowGet(envelope) {
    const revision = this.registry.getRevision(envelope.payload.workflowId, envelope.payload.revision);
    return this.response(envelope, revision ? { ok: true, type: 'workflow.get.result', revision } : { ok: false, error: { code: 'workflow_not_found' } });
  }

  handleExecutionEvent(envelope) {
    if (envelope.jobId) this.jobs.set(envelope.jobId, { updatedAt: this.now(), envelope });
    this.onExecutionEnvelope?.(envelope);
    this.emit('execution', envelope);
    if (envelope.type === 'execution.result' || envelope.type === 'execution.cancelled') {
      this.completedJobs.add(envelope.jobId);
      this.activeJobs.delete(envelope.jobId);
    }
    return this.response(envelope, { ok: true, accepted: true });
  }

  enqueueDispatch(dispatch) {
    if (!dispatch?.jobId) throw new Error('Dispatch payload is missing jobId.');
    if (this.completedJobs.has(dispatch.jobId) || this.activeJobs.has(dispatch.jobId)) return { queued: false, duplicate: true };
    if (this.pendingDownlink.length >= MAX_PENDING_DOWNLINK) throw new Error('Native bridge downlink queue is full.');
    const revision = this.registry.getRevision(dispatch.workflowId, dispatch.workflowRevision);
    if (!revision || revision.contentHash !== dispatch.workflowContentHash) throw new Error('Workflow revision is not available for extension execution.');
    const payload = {
      ...dispatch,
      profilePayload: revision.profilePayload
    };
    this.activeJobs.set(dispatch.jobId, { idempotencyKey: dispatch.idempotencyKey, queuedAt: this.now() });
    this.pendingDownlink.push({
      protocolVersion: PROTOCOL_VERSION,
      messageId: `agent-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'execution.dispatch',
      sentAt: this.now(),
      deadline: dispatch.deadline,
      idempotencyKey: dispatch.idempotencyKey,
      deviceId: this.identity.deviceId,
      jobId: dispatch.jobId,
      payload
    });
    return { queued: true };
  }

  enqueueCancel(cancel) {
    if (!cancel?.jobId) return { queued: false };
    this.pendingDownlink.unshift({
      protocolVersion: PROTOCOL_VERSION,
      messageId: `agent-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'execution.cancel',
      sentAt: this.now(),
      deadline: cancel.deadline || new Date(Date.parse(this.now()) + 30000).toISOString(),
      idempotencyKey: cancel.idempotencyKey || `${cancel.jobId}-cancel`,
      deviceId: this.identity.deviceId,
      jobId: cancel.jobId,
      payload: { jobId: cancel.jobId }
    });
    return { queued: true };
  }

  handleBridgePoll(envelope) {
    const next = this.pendingDownlink.shift();
    if (next) return { ...next, correlationId: envelope.correlationId || envelope.messageId };
    return this.response(envelope, {
      ok: true,
      type: 'bridge.health.result',
      pending: 0,
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.identity.deviceId
    });
  }

  response(request, payload) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      messageId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: responseTypeFor(request?.type),
      sentAt: this.now(),
      correlationId: request?.correlationId || request?.messageId,
      deviceId: this.identity.deviceId,
      jobId: request?.jobId,
      payload
    };
  }
}

function responseTypeFor(type) {
  if (type === 'workflow.upload') return 'workflow.upload.result';
  if (type === 'workflow.list') return 'workflow.list.result';
  if (type === 'workflow.get') return 'workflow.get.result';
  if (type === 'bridge.hello') return 'bridge.welcome';
  return 'native.bridge.response';
}
