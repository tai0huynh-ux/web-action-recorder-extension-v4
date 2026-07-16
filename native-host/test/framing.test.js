import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { collectNativeMessages, encodeNativeMessage, NativeMessageFramer } from '../framing.js';
import { createNativeHostManifest, resolveManifestPath, uninstallManifest, writeManifestAtomic } from '../manifest.js';
import { resolveDefaultSocketPath, sendLocalSocketRequest } from '../host.js';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('native framing encodes and decodes valid message', async () => {
  const stream = PassThrough.from([encodeNativeMessage({ ok: true })]);
  const result = await collectNativeMessages(stream);
  assert.deepEqual(result.messages, [{ ok: true }]);
  assert.equal(result.errors.length, 0);
});

test('native framing handles partial header and payload', () => {
  const messages = [];
  const errors = [];
  const framer = new NativeMessageFramer({ onMessage: (message) => messages.push(message), onError: (error) => errors.push(error) });
  const frame = encodeNativeMessage({ split: true });
  framer.push(frame.subarray(0, 2));
  framer.push(frame.subarray(2, 7));
  framer.push(frame.subarray(7));
  assert.deepEqual(messages, [{ split: true }]);
  assert.equal(errors.length, 0);
});

test('native framing handles multiple messages in one stream', () => {
  const messages = [];
  const framer = new NativeMessageFramer({ onMessage: (message) => messages.push(message) });
  framer.push(Buffer.concat([encodeNativeMessage({ a: 1 }), encodeNativeMessage({ b: 2 })]));
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
});

test('native framing rejects oversized, zero-length, and invalid JSON without throwing', () => {
  const errors = [];
  const oversized = new NativeMessageFramer({ maxBytes: 4, onError: (error) => errors.push(error.message) });
  oversized.push(encodeNativeMessage({ too: 'large' }));
  const zero = Buffer.alloc(4);
  const invalidHeader = Buffer.alloc(4);
  const invalidPayload = Buffer.from('{bad', 'utf8');
  invalidHeader.writeUInt32LE(invalidPayload.length, 0);
  const invalid = new NativeMessageFramer({ onError: (error) => errors.push(error.message) });
  invalid.push(Buffer.concat([zero, invalidHeader, invalidPayload]));
  assert.match(errors.join('\n'), /exceeds|greater than zero|Invalid native message JSON/);
});

test('native host manifest is configurable and validates extension id', () => {
  const manifest = createNativeHostManifest({
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    hostPath: '/opt/war/native-host/host.js'
  });
  assert.equal(manifest.type, 'stdio');
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']);
  assert.throws(() => createNativeHostManifest({ extensionId: 'bad', hostPath: '/x' }), /extension id/);
});

test('native host manifest install and uninstall are idempotent for owned file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-native-manifest-'));
  const target = resolveManifestPath({ browser: 'chromium', home: dir });
  const manifest = createNativeHostManifest({
    extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hostPath: '/opt/war/native-host/host.js'
  });
  writeManifestAtomic(target, manifest);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).name, manifest.name);
  assert.equal(uninstallManifest(target), true);
  assert.equal(uninstallManifest(target), false);
});

test('native host local socket client sends NDJSON and parses response', async () => {
  const socketPath = tempSocketPath('war-native-host');
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      const request = JSON.parse(chunk.trim());
      socket.end(`${JSON.stringify({ ok: true, correlationId: request.correlationId })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const response = await sendLocalSocketRequest({ socketPath, message: { correlationId: 'corr-1' }, timeoutMs: 1000 });
  server.close();
  assert.deepEqual(response, { ok: true, correlationId: 'corr-1' });
});

test('native host defaults to Browser Agent data socket when WAR_DATA_DIR is set', () => {
  const dataDir = process.platform === 'win32' ? 'C:\\war\\data' : '/data';
  assert.equal(resolveDefaultSocketPath({ WAR_DATA_DIR: dataDir }), path.join(dataDir, 'run', 'native-bridge.sock'));
  assert.equal(resolveDefaultSocketPath({ WAR_AGENT_SOCKET_PATH: '/custom/bridge.sock', WAR_DATA_DIR: dataDir }), '/custom/bridge.sock');
});

function tempSocketPath(name) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  return path.join(dir, 'agent.sock');
}
