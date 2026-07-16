import { EventEmitter } from 'node:events';
import os from 'node:os';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, MESSAGE_TYPES } from '../../protocol/src/protocolV2.js';

const DEFAULT_MIN_RECONNECT_MS = 500;
const DEFAULT_MAX_RECONNECT_MS = 30000;
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_QUEUE = 256;

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
    this.maxPending = maxPending;
    this.maxQueue = maxQueue;
    this.log = log;
    this.socket = null;
    this.status = 'offline';
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.pending = new Map();
    this.queue = [];
    this.stopped = true;
    this.closedSockets = new WeakSet();
    this.session = null;
  }

  start() {
    this.stopped = false;
    return this.connect();
  }

  connect() {
    this.clearReconnect();
    this.status = 'reconnecting';
    this.socket = this.connector(this.url, {
      ...this.connectorOptions,
      headers: { ...(this.connectorOptions.headers || {}), Authorization: `Bearer ${this.credential}` },
      credential: this.credential
    });
    const socket = this.socket;
    socket.on?.('open', () => this.onOpen(socket));
    socket.on?.('message', (message) => this.onMessage(message));
    socket.on?.('close', () => this.onClose(socket));
    this.socket.on?.('error', (error) => {
      this.log('warn', 'controllerSession', 'socket_error', { message: sanitizeErrorMessage(error?.message) });
      this.onClose(socket);
    });
    return this.socket;
  }

  onOpen(socket = this.socket) {
    if (socket !== this.socket || this.stopped) return;
    this.status = 'online';
    this.reconnectAttempts = 0;
    this.send(this.helloEnvelope());
    this.flushQueue();
    this.scheduleHeartbeat();
  }

  onMessage(message) {
    let envelope;
    try {
      envelope = typeof message === 'string' ? JSON.parse(message) : message;
    } catch {
      this.emit('protocolError', { code: 'malformed_envelope' });
      return;
    }
    const key = envelope.correlationId;
    if (key && this.pending.has(key)) {
      const pending = this.pending.get(key);
      this.scheduler.clearTimeout(pending.timer);
      this.pending.delete(key);
      if (envelope.payload?.session) this.session = envelope.payload.session;
      pending.resolve(envelope);
    }
    if (envelope.payload?.session) this.session = envelope.payload.session;
    if (envelope.type === 'execution.dispatch') this.emit('dispatch', envelope.payload);
    if (envelope.type === 'execution.cancel') this.emit('cancel', envelope.payload);
    if (Array.isArray(envelope.payload?.replay)) envelope.payload.replay.forEach((item) => this.emit('dispatch', item));
  }

  onClose(socket = this.socket) {
    if (socket !== this.socket || this.closedSockets.has(socket)) return;
    this.closedSockets.add(socket);
    this.clearHeartbeat();
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

  send(envelope, { expectResponse = false, timeoutMs = 10000 } = {}) {
    const encoded = JSON.stringify(envelope);
    if (!this.socket || this.status !== 'online') {
      if (this.queue.length >= this.maxQueue) throw new Error('Controller session outbound queue limit exceeded');
      this.queue.push(encoded);
      return expectResponse ? Promise.reject(new Error('Controller session is offline')) : undefined;
    }
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
    return this.send({
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
    });
  }

  sendExecutionCancelled({ jobId, idempotencyKey }) {
    const sentAt = this.now();
    return this.send({
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
    });
  }

  gracefulShutdown() {
    this.stopped = true;
    this.clearReconnect();
    this.clearHeartbeat();
    for (const pending of this.pending.values()) {
      this.scheduler.clearTimeout(pending.timer);
      pending.reject(new Error('Controller session stopped'));
    }
    this.pending.clear();
    this.queue = [];
    this.socket?.close?.();
    this.socket = null;
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
      remoteVideo: false,
      clipboardText: false,
      synchronizedInput: false
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

const globalScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer)
};

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
