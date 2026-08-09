import net from 'node:net';
import { AgentError } from './errors.js';

const DEFAULT_SOCKET = '/run/war/x11-input.sock';
const MAX_LINE = 8192;
const EFFECTFUL_TYPES = new Set(['focusWindow', 'mouseMove', 'click', 'mouseDown', 'mouseUp', 'wheel', 'keyDown', 'keyUp', 'insertText', 'shortcut']);

export class X11InputClient {
  constructor({ socketPath = process.env.WAR_X11_INPUT_SOCKET || DEFAULT_SOCKET, timeoutMs = 1000, reconnectLimit = 3, now = () => Date.now() } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.reconnectLimit = reconnectLimit;
    this.now = now;
    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.reconnects = 0;
    this.connectPromise = null;
    this.protocolReady = false;
    this.protocolPromise = null;
  }

  async command(type, payload = {}, { priority = false, deadlineAt } = {}) {
    const responseTimeoutMs = priority ? Math.min(this.timeoutMs, 250) : this.timeoutMs;
    const sendStartedAt = this.now();
    const effectiveDeadlineAt = deadlineAt === undefined
      ? sendStartedAt + responseTimeoutMs
      : Math.min(deadlineAt, sendStartedAt + responseTimeoutMs);
    if (EFFECTFUL_TYPES.has(type) && effectiveDeadlineAt <= sendStartedAt) {
      throw new AgentError('deadline_exceeded', 'X11 input command deadline has already passed', 408);
    }
    await this.connect(responseTimeoutMs);
    if (EFFECTFUL_TYPES.has(type)) await this.ensureProtocol(effectiveDeadlineAt, responseTimeoutMs);
    return this.writeCommand(type, payload, { deadlineAt: effectiveDeadlineAt, responseTimeoutMs });
  }

  async connect(timeoutMs) {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;
    if (this.reconnects > this.reconnectLimit) throw new AgentError('x11_reconnect_limit', 'X11 input backend reconnect limit exceeded', 503);
    this.reconnects += 1;
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AgentError('x11_connect_timeout', 'Timed out connecting to X11 input backend', 503));
      }, timeoutMs);
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.installHandlers(socket);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new AgentError('x11_connect_failed', 'X11 input backend connection failed', 503, { cause: error.code }));
      });
    }).finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async ensureProtocol(deadlineAt, responseTimeoutMs) {
    if (this.protocolReady) return;
    if (!this.protocolPromise) {
      this.protocolPromise = this.writeCommand('ping', { protocol: 2 }, { deadlineAt, responseTimeoutMs })
        .then((response) => {
          if (response.protocol !== 2) throw new AgentError('invalid_protocol', 'X11 input backend did not confirm protocol 2', 502);
          this.protocolReady = true;
        })
        .finally(() => { this.protocolPromise = null; });
    }
    return this.protocolPromise;
  }

  writeCommand(type, payload, { deadlineAt, responseTimeoutMs }) {
    const id = String(this.nextId++);
    const packet = { id, type, deadlineAt, ...payload };
    const line = encodeX11Command(type, packet, id, { deadlineAt });
    const sentAt = this.now();
    const remainingMs = deadlineAt - sentAt;
    if (remainingMs < 1) return Promise.reject(new AgentError('deadline_exceeded', 'X11 input command deadline has already passed', 408));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError('x11_timeout', `X11 input command timed out: ${type}`, 504));
      }, Math.min(remainingMs, responseTimeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(line, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AgentError('x11_write_failed', 'X11 input command write failed', 502));
      });
    });
  }

  installHandlers(socket) {
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      // Keep the partial response bounded even if a peer never sends a newline.
      if (this.buffer.length > MAX_LINE || Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE) {
        socket.destroy();
        return;
      }
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE) {
          socket.destroy();
          return;
        }
        this.handleLine(line);
      }
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.protocolReady = false;
      this.protocolPromise = null;
      this.buffer = '';
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timer);
        pending.reject(new AgentError('x11_disconnected', 'X11 input backend disconnected', 503));
        this.pending.delete(id);
      }
    });
  }

  handleLine(line) {
    let response;
    try {
      response = parseX11Response(line);
    } catch {
      this.socket?.destroy();
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response);
    else {
      const code = response.error === 'deadline_exceeded' ? 'deadline_exceeded' : 'x11_command_failed';
      pending.reject(new AgentError(code, response.error || 'X11 command failed', code === 'deadline_exceeded' ? 408 : 502, response));
    }
  }

  ping(options = {}) { return this.command('ping', {}, options); }
  getState(options = {}) { return this.command('getState', {}, options); }
  releaseAll(options = {}) { return this.command('releaseAll', {}, options); }
  focusChromium(options = {}) { return this.command('focusWindow', {}, options); }
  mouseMove(point, options = {}) { return this.command('mouseMove', pointPayload(point), options); }
  clickAt(point, button = 'left', count = 1, options = {}) { return this.command('click', { ...pointPayload(point), button, count }, options); }
  click(button = 'left', count = 1, options = {}) { return this.command('click', { button, count }, options); }
  mouseDown(button = 'left', options = {}) { return this.command('mouseDown', { button }, options); }
  mouseUp(button = 'left', options = {}) { return this.command('mouseUp', { button }, options); }
  wheel(deltaY, options = {}) { return this.command('wheel', { deltaY }, options); }
  keyDown(key, options = {}) { return this.command('keyDown', { key }, options); }
  keyUp(key, options = {}) { return this.command('keyUp', { key }, options); }
  typeText(text, options = {}) { return this.command('insertText', { text }, options); }
  shortcut(shortcut, options) { return options ? this.command('shortcut', { shortcut: normalizeX11Shortcut(shortcut) }, options) : this.command('shortcut', { shortcut: normalizeX11Shortcut(shortcut) }); }
  getReconnectCount() { return this.reconnects; }
  close() { this.socket?.destroy(); this.socket = null; this.protocolReady = false; }
}

export function encodeX11Command(type, payload = {}, id = '1', { deadlineAt } = {}) {
  const deadline = deadlineAt ?? payload.deadlineAt ?? (Date.now() + 1000);
  if (!Number.isSafeInteger(deadline) || deadline < 0) throw new AgentError('invalid_payload', 'X11 input deadline is invalid');
  const packet = { ...payload, id, type, deadlineAt: deadline };
  const line = `WAR2 ${deadline || 0} ${JSON.stringify(packet)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE) throw new AgentError('invalid_payload', 'X11 input packet is too large');
  return line;
}

export function parseX11Response(line) {
  const response = JSON.parse(line);
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' || typeof response.ok !== 'boolean') {
    throw new AgentError('invalid_response', 'X11 input response is invalid', 502);
  }
  return response;
}

export function normalizeX11Shortcut(shortcut) {
  const aliases = { CTRL: 'Control_L', CONTROL: 'Control_L', SHIFT: 'Shift_L', ALT: 'Alt_L', META: 'Meta_L', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', UP: 'ArrowUp', DOWN: 'ArrowDown', ESCAPE: 'Escape' };
  return String(shortcut || '').split('+').map((part) => {
    const key = part.trim();
    if (!key) return key;
    const alias = aliases[key.toUpperCase()];
    if (alias) return alias;
    if (key.length === 1 && /[A-Z]/.test(key)) return key.toLowerCase();
    return key;
  }).join('+');
}

function pointPayload(point) {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}
