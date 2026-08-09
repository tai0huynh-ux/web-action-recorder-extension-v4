import { EventEmitter } from 'node:events';
import os from 'node:os';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, MESSAGE_TYPES, validateEnvelope } from '../../protocol/src/protocolV2.js';

const DEFAULT_MIN_RECONNECT_MS = 500;
const DEFAULT_MAX_RECONNECT_MS = 30000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_QUEUE = 256;
const CONTROLLER_REQUEST_TYPES = new Set([
  'execution.dispatch',
  'execution.cancel',
  'remote.control.request',
  'origin.inventory.request',
  'origin.workflow.get'
]);

export class ControllerSessionClient extends EventEmitter {
  constructor({
    url,
    credential,
    identity,
    version = '0.1.0',
    connector = createWebSocketConnector,
    connectorOptions = {},
    scheduler = globalScheduler,
    random = Math.random,
    now = () => new Date().toISOString(),
    minReconnectMs = DEFAULT_MIN_RECONNECT_MS,
    maxReconnectMs = DEFAULT_MAX_RECONNECT_MS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    maxPending = DEFAULT_MAX_PENDING,
    maxQueue = DEFAULT_MAX_QUEUE,
    log = () => {}
  } = {}) {
    super();
    if (!url || !String(url).startsWith('wss://')) throw new Error('Controller session requires a wss:// URL');
    if (String(url).includes('token=') || String(url).includes('credential=')) throw new Error('Controller credential must not be placed in URL');
    this.url = url;
    this.credential = credential;
    this.identity = identity;
    this.version = version;
    this.connector = connector;
    this.connectorOptions = connectorOptions;
    this.scheduler = scheduler;
    this.random = random;
    this.now = now;
    this.minReconnectMs = minReconnectMs;
    this.maxReconnectMs = maxReconnectMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.maxPending = maxPending;
    this.maxQueue = maxQueue;
    this.log = log;
    this.socket = null;
    this.status = 'offline';
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.heartbeatTimer = null;
    this.pending = new Map();
    this.queue = [];
    this.stopped = true;
    this.closedSockets = new WeakSet();
    this.session = null;
    this.helloMessageId = null;
  }

  start() {
    this.stopped = false;
    return this.connect();
  }

  connect() {
    this.clearReconnect();
    this.clearConnectTimeout();
    this.status = 'reconnecting';
    this.socket = this.connector(this.url, {
      ...this.connectorOptions,
      headers: { ...(this.connectorOptions.headers || {}), Authorization: `Bearer ${this.credential}` },
      credential: this.credential
    });
    const socket = this.socket;
    socket.on?.('open', () => this.onOpen(socket));
    socket.on?.('message', (message) => this.onMessage(message, socket));
    socket.on?.('close', () => this.onClose(socket));
    this.socket.on?.('error', (error) => {
      this.log('warn', 'controllerSession', 'socket_error', { message: sanitizeErrorMessage(error?.message) });
      this.onClose(socket);
      retireSocket(socket);
    });
    this.connectTimer = this.scheduler.setTimeout(() => {
      if (socket !== this.socket || this.stopped || this.status !== 'reconnecting') return;
      this.log('warn', 'controllerSession', 'connect_timeout', { timeoutMs: this.connectTimeoutMs });
      this.onClose(socket);
      retireSocket(socket);
    }, this.connectTimeoutMs);
    return this.socket;
  }

  onOpen(socket = this.socket) {
    if (socket !== this.socket || this.stopped) return;
    this.clearConnectTimeout();
    this.status = 'online';
    this.reconnectAttempts = 0;
    const hello = this.helloEnvelope();
    this.helloMessageId = hello.messageId;
    this.send(hello);
    this.flushQueue();
    this.scheduleHeartbeat();
  }

  onMessage(message, socket = this.socket) {
    if (socket !== this.socket || this.closedSockets.has(socket) || this.stopped) return;
    let envelope;
    try {
      envelope = typeof message === 'string' ? JSON.parse(message) : message;
    } catch {
      this.protocolError('malformed_envelope');
      return;
    }
    const validation = validateEnvelope(envelope);
    if (!validation.ok || envelope.protocolVersion !== PROTOCOL_VERSION) {
      this.rejectPendingResponse(envelope?.correlationId);
      this.protocolError('invalid_envelope');
      return;
    }
    const key = envelope.correlationId;
    if (key && this.pending.has(key)) {
      const pending = this.pending.get(key);
      this.scheduler.clearTimeout(pending.timer);
      this.pending.delete(key);
      if (envelope.payload?.session && !this.setSession(envelope.payload.session)) {
        pending.reject(new Error('Controller response session rejected'));
        this.protocolError('session_mismatch');
        return;
      }
      pending.resolve(envelope);
      return;
    }
    if (key === this.helloMessageId && envelope.type === 'native.bridge.response') {
      if (!this.setSession(envelope.payload?.session)) {
        this.protocolError('session_mismatch');
        return;
      }
      this.emitReplay(envelope.payload.replay);
      return;
    }
    if (!CONTROLLER_REQUEST_TYPES.has(envelope.type)) {
      this.protocolError('unsupported_message');
      return;
    }
    if (!this.isCurrentSessionEnvelope(envelope)) {
      this.protocolError('session_mismatch');
      return;
    }
    if (envelope.deadline && Date.parse(envelope.deadline) <= Date.parse(this.now())) {
      this.protocolError('deadline_expired');
      return;
    }
    if (envelope.type === 'execution.dispatch') this.emit('dispatch', envelope.payload);
    if (envelope.type === 'execution.cancel') this.emit('cancel', envelope.payload);
    if (envelope.type === 'remote.control.request') this.emit('remoteControl', envelope);
    if (envelope.type === 'origin.inventory.request') this.emit('originInventoryRequest', envelope);
    if (envelope.type === 'origin.workflow.get') this.emit('originWorkflowGet', envelope);
  }

  setSession(session) {
    if (!isValidSession(session, this.identity?.deviceId)) return false;
    const changed = this.session?.sessionId !== session?.sessionId || this.session?.generation !== session?.generation;
    this.session = session;
    if (changed) this.emit('authenticated', session);
    return true;
  }

  isCurrentSessionEnvelope(envelope) {
    return Boolean(this.session)
      && envelope.deviceId === this.session.deviceId
      && envelope.deviceId === this.identity.deviceId
      && envelope.sessionId === this.session.sessionId;
  }

  emitReplay(replay) {
    if (!Array.isArray(replay)) return;
    for (const item of replay) this.emit('dispatch', item);
  }

  protocolError(code) {
    this.emit('protocolError', { code: String(code).slice(0, 64) });
  }

  rejectPendingResponse(correlationId) {
    if (!correlationId || !this.pending.has(correlationId)) return;
    const pending = this.pending.get(correlationId);
    this.scheduler.clearTimeout(pending.timer);
    this.pending.delete(correlationId);
    pending.reject(new Error('Controller response rejected'));
  }

  sendOriginResponse(request, payload) {
    return this.send({
      protocolVersion: PROTOCOL_VERSION,
      messageId: id('origin'),
      type: request.type === 'origin.workflow.get' ? 'origin.workflow.response' : 'origin.inventory.response',
      sentAt: this.now(),
      correlationId: request.messageId,
      deviceId: this.identity.deviceId,
      sessionId: this.session?.sessionId,
      payload
    });
  }

  sendRemoteControlResponse(request, payload, { transient = false } = {}) {
    return this.send({
      protocolVersion: PROTOCOL_VERSION,
      messageId: id('remote-response'),
      type: 'remote.control.response',
      sentAt: this.now(),
      correlationId: request.messageId,
      deviceId: this.identity.deviceId,
      sessionId: this.session?.sessionId,
      payload
    }, { transient });
  }

  onClose(socket = this.socket) {
    if (socket !== this.socket || this.closedSockets.has(socket)) return;
    this.closedSockets.add(socket);
    this.clearConnectTimeout();
    this.clearHeartbeat();
    this.socket = null;
    for (const pending of this.pending.values()) {
      this.scheduler.clearTimeout(pending.timer);
      pending.reject(new Error('Controller session disconnected'));
    }
    this.pending.clear();
    if (this.stopped) {
      this.status = 'offline';
      return;
    }
    this.status = 'reconnecting';
    const delay = this.nextReconnectDelay();
    this.clearReconnect();
    this.reconnectTimer = this.scheduler.setTimeout(() => this.connect(), delay);
  }

  send(envelope, { expectResponse = false, timeoutMs = 10000, transient = false } = {}) {
    if (!this.socket || this.status !== 'online') {
      if (transient) throw new Error('Controller session is offline for transient response');
      const encoded = JSON.stringify(envelope);
      if (this.queue.length >= this.maxQueue) throw new Error('Controller session outbound queue limit exceeded');
      this.queue.push(encoded);
      return expectResponse ? Promise.reject(new Error('Controller session is offline')) : undefined;
    }
    const encoded = JSON.stringify(envelope);
    if (expectResponse) {
      if (this.pending.size >= this.maxPending) return Promise.reject(new Error('Controller session pending request limit exceeded'));
      const promise = new Promise((resolve, reject) => {
        const timer = this.scheduler.setTimeout(() => {
          this.pending.delete(envelope.messageId);
          reject(new Error('Controller session request timed out'));
        }, timeoutMs);
        this.pending.set(envelope.messageId, { resolve, reject, timer });
      });
      this.socket.send(encoded);
      return promise;
    }
    this.socket.send(encoded);
    return undefined;
  }

  sendPresence(status) {
    return this.send({
      protocolVersion: PROTOCOL_VERSION,
      messageId: id('presence'),
      type: 'agent.presence',
      sentAt: this.now(),
      deviceId: this.identity.deviceId,
      payload: { deviceId: this.identity.deviceId, status, lastSeenAt: this.now() }
    });
  }

  sendExecutionEvent({ jobId, eventType, message, result, idempotencyKey }) {
    const sentAt = this.now();
    return this.sendExecutionEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      messageId: id('execution'),
      type: eventType === 'job_succeeded' || eventType === 'job_failed' ? 'execution.result' : 'execution.event',
      sentAt,
      deviceId: this.identity.deviceId,
      sessionId: this.session?.sessionId,
      jobId,
      deadline: new Date(Date.parse(sentAt) + 30000).toISOString(),
      idempotencyKey: idempotencyKey || `${jobId}-${eventType}`,
      payload: {
        jobId,
        eventType,
        sentAt,
        ...(message ? { message } : {}),
        ...(result !== undefined ? { result } : {})
      }
    }, { expectResponse: eventType === 'job_succeeded' || eventType === 'job_failed' });
  }

  sendExecutionCancelled({ jobId, idempotencyKey }) {
    const sentAt = this.now();
    return this.sendExecutionEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      messageId: id('cancelled'),
      type: 'execution.cancelled',
      sentAt,
      deviceId: this.identity.deviceId,
      sessionId: this.session?.sessionId,
      jobId,
      deadline: new Date(Date.parse(sentAt) + 30000).toISOString(),
      idempotencyKey: idempotencyKey || `${jobId}-cancelled`,
      payload: {
        jobId,
        eventType: 'job_cancelled',
        sentAt
      }
    }, { expectResponse: true });
  }

  sendExecutionEnvelope(envelope, { expectResponse = false, timeoutMs = 5000 } = {}) {
    const sentAt = this.now();
    return this.send({
      ...envelope,
      protocolVersion: PROTOCOL_VERSION,
      messageId: id('execution'),
      sentAt,
      deviceId: this.identity.deviceId,
      sessionId: this.session?.sessionId,
      deadline: new Date(Date.parse(sentAt) + 30000).toISOString()
    }, { expectResponse, timeoutMs });
  }

  gracefulShutdown() {
    this.stopped = true;
    this.clearReconnect();
    this.clearConnectTimeout();
    this.clearHeartbeat();
    for (const pending of this.pending.values()) {
      this.scheduler.clearTimeout(pending.timer);
      pending.reject(new Error('Controller session stopped'));
    }
    this.pending.clear();
    this.queue = [];
    const socket = this.socket;
    this.socket = null;
    socket?.close?.();
    this.status = 'offline';
  }

  nextReconnectDelay() {
    const base = Math.min(this.maxReconnectMs, this.minReconnectMs * (2 ** this.reconnectAttempts));
    this.reconnectAttempts += 1;
    return Math.max(this.minReconnectMs, Math.min(this.maxReconnectMs, Math.floor(base + base * 0.25 * this.random())));
  }

  scheduleHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = this.scheduler.setTimeout(() => {
      if (this.status === 'online') {
        this.sendPresence('online');
        this.scheduleHeartbeat();
      }
    }, 10000);
  }

  clearReconnect() {
    if (this.reconnectTimer) this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  clearConnectTimeout() {
    if (this.connectTimer) this.scheduler.clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) this.scheduler.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  flushQueue() {
    const queued = this.queue.splice(0, this.queue.length);
    for (const item of queued) this.socket.send(item);
  }

  helloEnvelope() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      messageId: id('hello'),
      type: 'agent.hello',
      sentAt: this.now(),
      deviceId: this.identity.deviceId,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        device: buildDeviceDescriptor(this.identity, this.version, this.now),
        supportedMessageTypes: MESSAGE_TYPES,
        sessionNonce: id('nonce'),
        sentAt: this.now()
      }
    };
  }
}

export function buildDeviceDescriptor(identity, version, now) {
  return {
    deviceId: identity.deviceId,
    displayName: identity.displayName || os.hostname(),
    hostName: os.hostname(),
    platform: process.platform,
    architecture: process.arch,
    agentVersion: version,
    extensionVersion: identity.extensionVersion || version,
    browserVersion: identity.browserVersion || 'unknown',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      workflowExecution: true,
      semanticControl: true,
      rawViewportInput: true,
      rawBrowserInput: true,
      nativeX11Input: true,
      screenshot: true,
      remoteVideo: true,
      clipboardText: true,
      synchronizedInput: true
    },
    labels: identity.labels || [],
    groupIds: identity.groupIds || [],
    status: 'online',
    lastSeenAt: now()
  };
}

export function createWebSocketConnector(url, options = {}) {
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  if (typeof WebSocketImpl !== 'function') throw new Error('Runtime WebSocket client is unavailable');
  const wsOptions = {
    headers: options.headers || {},
    ...(options.ca ? { ca: options.ca } : {})
  };
  const socket = new WebSocketImpl(url, [], wsOptions);
  return {
    send: (message) => socket.send(message),
    close: () => socket.close(),
    terminate: () => retireSocket(socket),
    on(event, handler) {
      if (typeof socket.on === 'function') {
        if (event === 'message') socket.on('message', (message) => handler(normalizeMessage(message)));
        else socket.on(event, handler);
        return;
      }
      if (event === 'open') socket.addEventListener('open', handler);
      if (event === 'close') socket.addEventListener('close', handler);
      if (event === 'error') socket.addEventListener('error', (error) => handler(error?.error || error));
      if (event === 'message') socket.addEventListener('message', (message) => handler(normalizeMessage(message.data)));
    }
  };
}

function normalizeMessage(message) {
  if (typeof message === 'string') return message;
  if (Buffer.isBuffer(message)) return message.toString('utf8');
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString('utf8');
  if (ArrayBuffer.isView(message)) return Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString('utf8');
  return String(message);
}

function sanitizeErrorMessage(message = '') {
  return String(message).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

function retireSocket(socket) {
  if (typeof socket?.terminate === 'function') socket.terminate();
  else socket?.close?.();
}

function isValidSession(session, deviceId) {
  return Boolean(session)
    && typeof session.sessionId === 'string'
    && session.sessionId.length > 0
    && session.sessionId.length <= 4096
    && session.deviceId === deviceId
    && Number.isInteger(session.generation)
    && session.generation > 0;
}

const globalScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer)
};

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
