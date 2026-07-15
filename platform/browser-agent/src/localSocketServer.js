import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export class LocalSocketServer {
  constructor({ socketPath, maxPayloadBytes = 1024 * 1024, idleTimeoutMs = 30000, maxConnections = 8, handler, log = () => {} }) {
    this.socketPath = socketPath;
    this.maxPayloadBytes = maxPayloadBytes;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxConnections = maxConnections;
    this.handler = handler;
    this.log = log;
    this.connections = new Set();
    this.server = net.createServer((socket) => this.accept(socket));
  }

  async start() {
    if (!isWindowsPipe(this.socketPath)) prepareSocketPath(this.socketPath);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        if (!isWindowsPipe(this.socketPath)) fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
    return this;
  }

  async stop() {
    for (const socket of this.connections) socket.destroy();
    await new Promise((resolve) => this.server.close(() => resolve()));
    if (!isWindowsPipe(this.socketPath) && fs.existsSync(this.socketPath)) fs.rmSync(this.socketPath);
  }

  accept(socket) {
    if (this.connections.size >= this.maxConnections) {
      socket.end(`${JSON.stringify(errorResponse('connection_limit', 'Connection limit exceeded.'))}\n`);
      return;
    }
    this.connections.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(this.idleTimeoutMs, () => socket.destroy());
    let raw = '';
    socket.on('data', async (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > this.maxPayloadBytes) {
        socket.end(`${JSON.stringify(errorResponse('payload_too_large', 'Socket payload is too large.'))}\n`);
        return;
      }
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      const line = raw.slice(0, newline);
      raw = raw.slice(newline + 1);
      try {
        const response = await this.handler(JSON.parse(line));
        socket.end(`${JSON.stringify(response)}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify(errorResponse('handler_failed', error.message))}\n`);
      }
    });
    socket.on('close', () => this.connections.delete(socket));
  }
}

function isWindowsPipe(socketPath) {
  return process.platform === 'win32' && String(socketPath).startsWith('\\\\.\\pipe\\');
}

export function prepareSocketPath(socketPath) {
  const dir = path.dirname(socketPath);
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error('Refusing to use symlink runtime directory.');
    if (!stat.isDirectory()) throw new Error('Runtime socket parent is not a directory.');
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(dir, 0o700);
  if (!fs.existsSync(socketPath)) return;
  const stat = fs.lstatSync(socketPath);
  if (stat.isSymbolicLink()) throw new Error('Refusing to replace symlink socket path.');
  if (!stat.isSocket()) throw new Error('Refusing to replace non-socket path.');
  fs.rmSync(socketPath);
}

function errorResponse(code, message) {
  return {
    protocolVersion: 'war-control.v2',
    messageId: `socket-error-${Date.now()}`,
    type: 'native.bridge.response',
    sentAt: new Date().toISOString(),
    payload: { ok: false, error: { code, message } }
  };
}
