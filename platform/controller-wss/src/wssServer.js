import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

const DEFAULT_PATH = '/v1/agent-session';

export class ControllerWssRuntimeServer {
  constructor({
    server,
    adapter,
    path = DEFAULT_PATH,
    maxPayloadBytes = 1024 * 1024
  } = {}) {
    if (!server) throw new Error('Controller WSS runtime requires an HTTP or HTTPS server');
    if (!adapter) throw new Error('Controller WSS runtime requires an adapter');
    this.server = server;
    this.adapter = adapter;
    this.path = path;
    this.closed = false;
    this.connections = new Set();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
    this.onUpgrade = this.handleUpgrade.bind(this);
    this.server.on('upgrade', this.onUpgrade);
  }

  handleUpgrade(request, socket, head) {
    if (this.closed) return rejectUpgrade(socket, 503);
    if (new URL(request.url, 'http://127.0.0.1').pathname !== this.path) return rejectUpgrade(socket, 404);
    const parsed = parseAuthorization(request.headers.authorization);
    if (!parsed.ok) return rejectUpgrade(socket, 401);
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      const connection = new WsConnection(ws);
      this.connections.add(connection);
      connection.on('close', () => this.connections.delete(connection));
      this.adapter.accept(connection, { credential: parsed.credential });
    });
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.server.off('upgrade', this.onUpgrade);
    for (const connection of this.connections) connection.close();
    this.connections.clear();
    this.wss.close();
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
  constructor(ws) {
    super();
    this.ws = ws;
    ws.on('message', (message) => this.emit('message', normalizeMessage(message)));
    ws.on('close', () => this.emit('close'));
    ws.on('error', () => this.emit('close'));
  }

  send(message) {
    if (this.ws.readyState === 1) this.ws.send(message);
  }

  isOpen() {
    return this.ws.readyState === 1;
  }

  close() {
    this.ws.close();
  }
}

function rejectUpgrade(socket, statusCode) {
  const label = statusCode === 404 ? 'Not Found' : 'Unauthorized';
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
