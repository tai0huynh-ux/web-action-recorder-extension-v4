import { EventEmitter } from 'node:events';
import { PROTOCOL_VERSION, validateEnvelope } from '../../protocol/src/protocolV2.js';
import { ControllerCoreError } from '../../controller-core/src/errors.js';

export class ControllerWssServerAdapter extends EventEmitter {
  constructor({ sessionManager, maxPayloadBytes = 1024 * 1024, now = () => new Date().toISOString(), id = (prefix) => `${prefix}-${Date.now()}` } = {}) {
    super();
    this.sessionManager = sessionManager;
    this.maxPayloadBytes = maxPayloadBytes;
    this.now = now;
    this.id = id;
    this.connections = new Set();
  }

  accept(connection, { credential } = {}) {
    const state = { session: null, closed: false };
    this.connections.add(connection);
    const cleanup = () => {
      if (state.closed) return;
      state.closed = true;
      this.connections.delete(connection);
      if (state.session) this.sessionManager.disconnect(state.session.deviceId, state.session.generation, 'reconnecting');
    };
    connection.on?.('close', cleanup);
    connection.on?.('message', async (message) => {
      const response = await this.handleMessage(message, state, credential, () => connection.close?.());
      if (response) connection.send?.(JSON.stringify(response));
    });
    return cleanup;
  }

  async handleMessage(raw, state, credential, close) {
    try {
      if (Buffer.byteLength(String(raw), 'utf8') > this.maxPayloadBytes) throw publicError('payload_too_large', 'Payload too large', 413);
      const envelope = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const validation = validateEnvelope(envelope);
      if (!validation.ok) throw publicError('invalid_envelope', 'Malformed envelope rejected', 400, validation.errors);
      if (envelope.protocolVersion !== PROTOCOL_VERSION) throw publicError('protocol_version_rejected', 'Protocol version rejected', 426);
      if (envelope.type === 'agent.hello') {
        state.session = await this.sessionManager.authenticateHello(envelope, { credential });
        this.sessionManager.attachClose(state.session.deviceId, state.session.generation, close);
        return this.response(envelope, { ok: true, session: state.session, replay: this.sessionManager.replayNonTerminal(state.session.deviceId, state.session.generation) });
      }
      if (!state.session) throw publicError('unauthenticated', 'Agent session is not authenticated', 401);
      const withSession = { ...envelope, deviceId: envelope.deviceId || state.session.deviceId, sessionId: envelope.sessionId || state.session.sessionId, payload: { ...envelope.payload, generation: state.session.generation } };
      if (envelope.type === 'agent.presence') return this.response(envelope, { ok: true, session: await this.sessionManager.handlePresence(withSession) });
      if (envelope.type === 'agent.execution.event' || envelope.type === 'execution.event' || envelope.type === 'execution.result' || envelope.type === 'execution.cancelled') {
        return this.response(envelope, { ok: true, event: await this.sessionManager.receiveExecutionEvent(withSession) });
      }
      throw publicError('unsupported_message', `Unsupported message ${envelope.type}`, 400);
    } catch (error) {
      return this.errorResponse(error);
    }
  }

  dispatchToAgent(session, dispatch) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      messageId: this.id('controller'),
      type: 'execution.dispatch',
      sentAt: this.now(),
      deadline: dispatch.deadline,
      idempotencyKey: dispatch.idempotencyKey,
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      jobId: dispatch.jobId,
      payload: dispatch
    };
  }

  shutdown() {
    for (const connection of this.connections) connection.close?.();
    this.connections.clear();
    this.sessionManager.shutdown();
  }

  response(request, payload) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      messageId: this.id('controller'),
      type: 'native.bridge.response',
      sentAt: this.now(),
      correlationId: request.messageId,
      deviceId: request.deviceId,
      sessionId: payload.session?.sessionId || request.sessionId,
      payload
    };
  }

  errorResponse(error) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      messageId: this.id('controller-error'),
      type: 'native.bridge.response',
      sentAt: this.now(),
      payload: {
        ok: false,
        error: {
          code: error.code || 'internal_error',
          message: error.message || 'Internal error',
          ...(error.details ? { details: error.details } : {})
        }
      }
    };
  }
}

function publicError(code, message, status, details) {
  const error = new ControllerCoreError(code, message, status, details);
  return error;
}
