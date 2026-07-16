import { PROTOCOL_VERSION, validateNativeBridgeEnvelope } from '../../protocol/src/protocolV2.js';

export class NativeBridgeHandler {
  constructor({ identity, registry, version, supervisor, dispatcher, log = () => {}, now = () => new Date().toISOString() }) {
    this.identity = identity;
    this.registry = registry;
    this.version = version;
    this.supervisor = supervisor;
    this.dispatcher = dispatcher;
    this.log = log;
    this.now = now;
    this.jobs = new Map();
  }

  async handle(envelope) {
    const validation = validateNativeBridgeEnvelope(envelope);
    if (!validation.ok) return this.response(envelope, { ok: false, error: { code: 'invalid_envelope', details: validation.errors } });
    switch (envelope.type) {
      case 'bridge.hello':
      case 'bridge.health':
      case 'native.bridge.request':
        return this.handleBridgeRequest(envelope);
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
    return this.response(envelope, { ok: true, accepted: true });
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
