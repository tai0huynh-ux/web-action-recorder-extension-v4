import net from 'node:net';
import { AgentError } from './errors.js';

const DEFAULT_SOCKET = '/run/war/x11-input.sock';
const MAX_LINE = 8192;

export class X11InputClient {
  constructor({ socketPath = process.env.WAR_X11_INPUT_SOCKET || DEFAULT_SOCKET, timeoutMs = 1000, reconnectLimit = 3 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.reconnectLimit = reconnectLimit;
    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.reconnects = 0;
  }

  async command(type, payload = {}, { priority = false } = {}) {
    const id = String(this.nextId++);
    const packet = { id, type, ...payload };
    const line = `${JSON.stringify(packet)}\n`;
    if (line.length > MAX_LINE) throw new AgentError('invalid_payload', 'X11 input packet is too large');
    await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError('x11_timeout', `X11 input command timed out: ${type}`, 504));
      }, priority ? Math.min(this.timeoutMs, 250) : this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(line, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AgentError('x11_write_failed', error.message, 502));
      });
    });
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.reconnects > this.reconnectLimit) throw new AgentError('x11_reconnect_limit', 'X11 input backend reconnect limit exceeded', 503);
    this.reconnects += 1;
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AgentError('x11_connect_timeout', 'Timed out connecting to X11 input backend', 503));
      }, this.timeoutMs);
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.installHandlers(socket);
        resolve();
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(new AgentError('x11_connect_failed', error.message, 503));
      });
    });
  }

  installHandlers(socket) {
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        this.handleLine(line);
      }
    });
    socket.on('close', () => {
      this.socket = null;
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timer);
        pending.reject(new AgentError('x11_disconnected', 'X11 input backend disconnected', 503));
        this.pending.delete(id);
      }
    });
  }

  handleLine(line) {
    if (line.length > MAX_LINE) {
      this.socket?.destroy();
      return;
    }
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response);
    else pending.reject(new AgentError('x11_command_failed', response.error || 'X11 command failed', 502, response));
  }

  async ping() {
    return this.command('ping');
  }

  async getState() {
    return this.command('getState');
  }

  async releaseAll(options = {}) {
    return this.command('releaseAll', {}, options);
  }

  async focusChromium() {
    return this.command('focusWindow');
  }

  async mouseMove(point) {
    return this.command('mouseMove', pointPayload(point));
  }

  async clickAt(point, button = 'left', count = 1) {
    return this.command('click', { ...pointPayload(point), button, count });
  }

  async click(button = 'left', count = 1) {
    return this.command('click', { button, count });
  }

  async mouseDown(button = 'left') {
    return this.command('mouseDown', { button });
  }

  async mouseUp(button = 'left') {
    return this.command('mouseUp', { button });
  }

  async wheel(deltaY) {
    return this.command('wheel', { deltaY });
  }

  async keyDown(key) {
    return this.command('keyDown', { key });
  }

  async keyUp(key) {
    return this.command('keyUp', { key });
  }

  async typeText(text) {
    return this.command('insertText', { text });
  }

  async shortcut(shortcut) {
    return this.command('shortcut', { shortcut });
  }

  getReconnectCount() {
    return this.reconnects;
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}

export function encodeX11Command(type, payload = {}, id = '1') {
  const line = `${JSON.stringify({ id, type, ...payload })}\n`;
  if (line.length > MAX_LINE) throw new AgentError('invalid_payload', 'X11 input packet is too large');
  return line;
}

export function parseX11Response(line) {
  const response = JSON.parse(line);
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' || typeof response.ok !== 'boolean') {
    throw new AgentError('invalid_response', 'X11 input response is invalid', 502);
  }
  return response;
}

function pointPayload(point) {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}
