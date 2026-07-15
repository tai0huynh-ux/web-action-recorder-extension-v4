#!/usr/bin/env node
import net from 'node:net';
import { NativeMessageFramer, encodeNativeMessage } from './framing.js';
import { validateNativeBridgeEnvelope } from '../platform/protocol/src/protocolV2.js';

const DEFAULT_SOCKET_PATH = process.env.WAR_AGENT_SOCKET_PATH || '/run/war/browser-agent/native-bridge.sock';
const DEFAULT_TIMEOUT_MS = Number(process.env.WAR_NATIVE_REQUEST_TIMEOUT_MS || 10000);
const DEFAULT_MAX_PENDING = Number(process.env.WAR_NATIVE_MAX_PENDING || 64);
const DEFAULT_MAX_QUEUE = Number(process.env.WAR_NATIVE_MAX_QUEUE || 128);

export class NativeHostBridge {
  constructor({ socketPath = DEFAULT_SOCKET_PATH, stdout = process.stdout, stderr = process.stderr, timeoutMs = DEFAULT_TIMEOUT_MS, maxPending = DEFAULT_MAX_PENDING, maxQueue = DEFAULT_MAX_QUEUE } = {}) {
    this.socketPath = socketPath;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.maxQueue = maxQueue;
    this.pending = 0;
    this.queue = [];
    this.closed = false;
  }

  async handleMessage(message) {
    if (this.closed) return;
    if (this.pending >= this.maxPending || this.queue.length >= this.maxQueue) {
      return this.writeResponse(errorEnvelope(message, 'native_host_busy', 'Native host queue is full.'));
    }
    this.queue.push(message);
    this.pump();
  }

  async pump() {
    while (!this.closed && this.pending < this.maxPending && this.queue.length) {
      const message = this.queue.shift();
      this.pending += 1;
      this.forward(message)
        .then((response) => this.writeResponse(response))
        .catch((error) => this.writeResponse(errorEnvelope(message, 'agent_unavailable', error.message)))
        .finally(() => {
          this.pending -= 1;
          this.pump();
        });
    }
  }

  forward(message) {
    const validation = validateNativeBridgeEnvelope(message);
    if (!validation.ok) return Promise.resolve(errorEnvelope(message, 'invalid_envelope', 'NativeBridgeEnvelope is invalid.', validation.errors));
    return sendLocalSocketRequest({ socketPath: this.socketPath, message, timeoutMs: this.timeoutMs });
  }

  writeResponse(response) {
    this.stdout.write(encodeNativeMessage(response));
  }

  log(level, event, fields = {}) {
    this.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, component: 'native-host', event, ...fields })}\n`);
  }

  shutdown() {
    this.closed = true;
    this.queue = [];
  }
}

export function sendLocalSocketRequest({ socketPath, message, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let raw = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Agent socket request timed out.'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => {
      raw += chunk;
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      const line = raw.slice(0, newline);
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`Invalid Agent response JSON: ${error.message}`));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      if (!raw.includes('\n')) reject(new Error('Agent socket closed without a response.'));
    });
  });
}

export function errorEnvelope(request, code, message, details) {
  return {
    protocolVersion: request?.protocolVersion || 'war-control.v2',
    messageId: `native-error-${Date.now()}`,
    type: 'native.bridge.response',
    sentAt: new Date().toISOString(),
    correlationId: request?.correlationId || request?.messageId,
    payload: { ok: false, error: { code, message, ...(details ? { details } : {}) } }
  };
}

export function runNativeHost({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const bridge = new NativeHostBridge({ stdout, stderr });
  const framer = new NativeMessageFramer({
    onMessage: (message) => bridge.handleMessage(message),
    onError: (error) => bridge.writeResponse(errorEnvelope({}, 'invalid_native_frame', error.message))
  });
  stdin.on('data', (chunk) => framer.push(chunk));
  stdin.on('end', () => {
    framer.end();
    bridge.shutdown();
  });
  process.on('SIGTERM', () => {
    bridge.shutdown();
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) runNativeHost();
