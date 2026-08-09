import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { WebSocketServer } from 'ws';

const DEFAULT_PATH = '/v1/agent-session';
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 10000;
const DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE = 4;
const MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE = 64;
const DEFAULT_SOURCE_RATE_BURST = 12;
const SOURCE_RATE_REFILL_MS = 5000;
const MAX_SOURCE_RECORDS = 1024;
const SOURCE_RECORD_SWEEP_MS = 60 * 1000;
const SOURCE_RECORD_IDLE_MS = 2 * 60 * 1000;
const UNKNOWN_DIRECT_SOURCE = 'unknown-direct-source';

export class ControllerWssRuntimeServer {
  constructor({
    server,
    adapter,
    path = DEFAULT_PATH,
    maxPayloadBytes = 1024 * 1024,
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    authenticationTimeoutMs = DEFAULT_AUTHENTICATION_TIMEOUT_MS,
    maxUnauthenticatedConnectionsPerSource = DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE,
    now = () => Date.now(),
  } = {}) {
    if (!server) throw new Error('Controller WSS runtime requires an HTTP or HTTPS server');
    if (!adapter) throw new Error('Controller WSS runtime requires an adapter');
    this.server = server;
    this.adapter = adapter;
    this.path = path;
    this.maxConnections = maxConnections;
    this.authenticationTimeoutMs = authenticationTimeoutMs;
    this.now = now;
    this.maxUnauthenticatedConnectionsPerSource = requireBoundedPositiveInteger(
      maxUnauthenticatedConnectionsPerSource,
      'maxUnauthenticatedConnectionsPerSource'
    );
    this.closed = false;
    this.connections = new Set();
    this.unauthenticatedBySource = new Map();
    this.sourceRateLimits = new Map();
    this.sourceRateSweepTimer = setInterval(() => this.sweepSourceRateLimits(), SOURCE_RECORD_SWEEP_MS);
    this.sourceRateSweepTimer.unref?.();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
    this.onUpgrade = this.handleUpgrade.bind(this);
    this.server.on('upgrade', this.onUpgrade);
  }

  handleUpgrade(request, socket, head) {
    const transportSocket = socket?.write ? socket : request.socket;
    if (this.closed) return rejectUpgrade(transportSocket, 503);
    if (new URL(request.url, 'http://127.0.0.1').pathname !== this.path) return rejectUpgrade(transportSocket, 404);
    const source = directSourceKey(request, transportSocket);
    if (!this.consumeSourceToken(source)) return rejectUpgrade(transportSocket, 429);
    if (this.connections.size >= this.maxConnections) return rejectUpgrade(transportSocket, 503);
    if ((this.unauthenticatedBySource.get(source) || 0) >= this.maxUnauthenticatedConnectionsPerSource) return rejectUpgrade(transportSocket, 503);
    const parsed = parseAuthorization(request.headers.authorization);
    if (!parsed.ok) return rejectUpgrade(transportSocket, 401);
    this.wss.handleUpgrade(request, transportSocket, head, (ws) => {
      const connection = new WsConnection(ws, this.authenticationTimeoutMs);
      this.connections.add(connection);
      this.incrementUnauthenticatedSource(source);
      const releaseUnauthenticatedSource = once(() => this.decrementUnauthenticatedSource(source));
      connection.on('authenticated', releaseUnauthenticatedSource);
      connection.on('timeout', () => {
        releaseUnauthenticatedSource();
        this.connections.delete(connection);
      });
      connection.on('close', () => {
        releaseUnauthenticatedSource();
        this.connections.delete(connection);
      });
      this.adapter.accept(connection, { credential: parsed.credential });
    });
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.server.off('upgrade', this.onUpgrade);
    for (const connection of this.connections) connection.close();
    this.connections.clear();
    this.unauthenticatedBySource.clear();
    this.sourceRateLimits.clear();
    clearInterval(this.sourceRateSweepTimer);
    this.wss.close();
  }

  incrementUnauthenticatedSource(source) {
    this.unauthenticatedBySource.set(source, (this.unauthenticatedBySource.get(source) || 0) + 1);
  }

  decrementUnauthenticatedSource(source) {
    const current = this.unauthenticatedBySource.get(source) || 0;
    if (current <= 1) this.unauthenticatedBySource.delete(source);
    else this.unauthenticatedBySource.set(source, current - 1);
    this.sourceRateLimits.get(source)?.touch(this.now());
  }

  consumeSourceToken(source) {
    const now = this.now();
    let record = this.sourceRateLimits.get(source);
    if (!record) {
      this.sweepSourceRateLimits(now);
      if (this.sourceRateLimits.size >= MAX_SOURCE_RECORDS) return false;
      record = new SourceRateLimitRecord(now);
      this.sourceRateLimits.set(source, record);
    }
    return record.consume(now);
  }

  sweepSourceRateLimits(now = this.now()) {
    for (const [source, record] of this.sourceRateLimits) {
      if ((this.unauthenticatedBySource.get(source) || 0) === 0 && now - record.lastSeenMs >= SOURCE_RECORD_IDLE_MS) {
        this.sourceRateLimits.delete(source);
      }
    }
  }
}

export function parseAuthorization(header) {
  if (Array.isArray(header)) return { ok: false };
  if (typeof header !== 'string') return { ok: false };
  if (header.includes(',')) return { ok: false };
  const match = header.match(/^\s*Bearer\s+([^\s]+)\s*$/i);
  if (!match || !match[1]?.trim()) return { ok: false };
  return { ok: true, credential: match[1] };
}

class WsConnection extends EventEmitter {
  constructor(ws, authenticationTimeoutMs) {
    super();
    this.ws = ws;
    this.authenticated = false;
    this.authenticationTimer = setTimeout(() => {
      this.emit('timeout');
      if (typeof this.ws.terminate === 'function') this.ws.terminate();
      else this.close();
    }, authenticationTimeoutMs);
    this.authenticationTimer.unref?.();
    ws.on('message', (message) => this.emit('message', normalizeMessage(message)));
    ws.on('close', () => this.handleClose());
    ws.on('error', () => this.handleClose());
  }

  send(message) {
    if (this.ws.readyState === 1) this.ws.send(message);
  }

  isOpen() {
    return this.ws.readyState === 1;
  }

  markAuthenticated() {
    if (this.authenticated) return;
    this.authenticated = true;
    clearTimeout(this.authenticationTimer);
    this.emit('authenticated');
  }

  close() {
    clearTimeout(this.authenticationTimer);
    this.ws.close();
  }

  handleClose() {
    clearTimeout(this.authenticationTimer);
    this.emit('close');
  }
}

function requireBoundedPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_UNAUTHENTICATED_CONNECTIONS_PER_SOURCE}`);
  }
  return value;
}

function directSourceKey(request, socket) {
  const address = request?.socket?.remoteAddress ?? socket?.remoteAddress;
  if (typeof address !== 'string' || address.length === 0 || address.length > 128) return UNKNOWN_DIRECT_SOURCE;
  const normalized = address.toLowerCase();
  const ipv4Mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Mapped && isIP(ipv4Mapped[1]) === 4) return ipv4Mapped[1];
  return isIP(normalized) ? normalized : UNKNOWN_DIRECT_SOURCE;
}

function once(callback) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}

class SourceRateLimitRecord {
  constructor(now) {
    this.tokens = DEFAULT_SOURCE_RATE_BURST;
    this.lastRefillMs = now;
    this.lastSeenMs = now;
  }

  consume(now) {
    const elapsed = Math.max(0, now - this.lastRefillMs);
    this.tokens = Math.min(DEFAULT_SOURCE_RATE_BURST, this.tokens + (elapsed / SOURCE_RATE_REFILL_MS));
    this.lastRefillMs = now;
    this.lastSeenMs = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  touch(now) {
    this.lastSeenMs = now;
  }
}

function rejectUpgrade(socket, statusCode) {
  const label = statusCode === 404 ? 'Not Found' : statusCode === 429 ? 'Too Many Requests' : statusCode === 503 ? 'Service Unavailable' : 'Unauthorized';
  socket.write(`HTTP/1.1 ${statusCode} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function normalizeMessage(message) {
  if (typeof message === 'string') return message;
  if (Buffer.isBuffer(message)) return message.toString('utf8');
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString('utf8');
  if (ArrayBuffer.isView(message)) return Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString('utf8');
  return String(message);
}
