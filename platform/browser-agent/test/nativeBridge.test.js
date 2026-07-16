import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { WorkflowRegistry } from '../src/workflowRegistry.js';
import { LocalSocketServer, prepareSocketPath } from '../src/localSocketServer.js';
import { NativeBridgeHandler } from '../src/nativeBridgeHandler.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';
import { sendLocalSocketRequest } from '../../../native-host/host.js';

test('workflow registry creates new revision and deduplicates contentHash', () => {
  const registry = new WorkflowRegistry({ filePath: tempFile('registry.json') });
  const first = registry.putRevision(revisionFixture({ contentHash: 'a'.repeat(64) }));
  const duplicate = registry.putRevision(revisionFixture({ contentHash: 'a'.repeat(64) }));
  const changed = registry.putRevision(revisionFixture({ contentHash: 'b'.repeat(64) }));
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(changed.revision.revision, 2);
  assert.equal(registry.listMetadata().length, 2);
});

test('workflow registry recovers corrupt file', () => {
  const filePath = tempFile('registry.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{bad');
  const registry = new WorkflowRegistry({ filePath });
  assert.deepEqual(registry.listMetadata(), []);
  assert.equal(fs.existsSync(filePath), false);
});

test('local socket server rejects symlink runtime directory and sets socket mode 0600', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-agent-socket-'));
  const socketPath = process.platform === 'win32' ? tempSocketPath() : path.join(dir, 'bridge.sock');
  const server = new LocalSocketServer({ socketPath, handler: async () => ({ ok: true }) });
  await server.start();
  const mode = process.platform === 'win32' ? 0o600 : fs.statSync(socketPath).mode & 0o777;
  await server.stop();
  assert.equal(mode, 0o600);
  const target = path.join(dir, 'real');
  fs.mkdirSync(target);
  const link = path.join(dir, 'link');
  fs.symlinkSync(target, link, 'dir');
  assert.throws(() => prepareSocketPath(path.join(link, 'bridge.sock')), /symlink/);
});

test('local socket server handles valid request and payload limit', async () => {
  const socketPath = tempSocketPath();
  const server = new LocalSocketServer({
    socketPath,
    maxPayloadBytes: 64,
    handler: async (message) => ({ ok: true, echo: message.messageId })
  });
  await server.start();
  const ok = await sendLine(socketPath, { messageId: 'msg-1' });
  const tooLarge = await sendRaw(socketPath, `${'x'.repeat(100)}\n`);
  await server.stop();
  assert.equal(ok.echo, 'msg-1');
  assert.equal(tooLarge.payload.error.code, 'payload_too_large');
});

test('native bridge handler supports health, workflow upload, list, and get', async () => {
  const registry = new WorkflowRegistry({ filePath: tempFile('registry.json') });
  const handler = new NativeBridgeHandler({
    identity: { deviceId: 'device-1' },
    registry,
    version: '0.1.0',
    supervisor: { getState: () => ({ browserState: 'running', extensionLoaded: true }) }
  });
  const health = await handler.handle(envelope('bridge.health', {}));
  const upload = await handler.handle(envelope('workflow.upload', { revision: revisionFixture({ contentHash: 'c'.repeat(64) }) }));
  const list = await handler.handle(envelope('workflow.list', {}));
  const get = await handler.handle(envelope('workflow.get', { workflowId: 'wf-1', revision: 1 }));
  assert.equal(health.payload.ok, true);
  assert.equal(upload.payload.created, true);
  assert.equal(list.payload.workflows.length, 1);
  assert.equal(get.payload.revision.contentHash, 'c'.repeat(64));
});

test('native host socket client completes workflow upload and execution event round trip', async () => {
  const registry = new WorkflowRegistry({ filePath: tempFile('registry.json') });
  const handler = new NativeBridgeHandler({
    identity: { deviceId: 'device-1' },
    registry,
    version: '0.1.0',
    supervisor: { getState: () => ({ browserState: 'running', extensionLoaded: true }) }
  });
  const socketPath = tempSocketPath();
  const server = new LocalSocketServer({
    socketPath,
    handler: (message) => handler.handle(message)
  });
  await server.start();
  const upload = await sendLocalSocketRequest({
    socketPath,
    timeoutMs: 1000,
    message: envelope('workflow.upload', { revision: revisionFixture({ contentHash: 'd'.repeat(64) }) })
  });
  const event = await sendLocalSocketRequest({
    socketPath,
    timeoutMs: 1000,
    message: {
      ...envelope('execution.event', {
        eventType: 'job_started',
        jobId: 'job-1',
        sentAt: '2026-07-16T00:00:00.000Z'
      }),
      jobId: 'job-1',
      idempotencyKey: 'job-1-started'
    }
  });
  await server.stop();
  assert.equal(upload.payload.ok, true);
  assert.equal(upload.payload.workflowId, 'wf-1');
  assert.equal(event.payload.accepted, true);
});

test('native bridge queues controller dispatch and cancel for extension polling', async () => {
  const registry = new WorkflowRegistry({ filePath: tempFile('registry.json') });
  registry.putRevision(revisionFixture({ contentHash: 'e'.repeat(64), profilePayload: { id: 'wf-1', name: 'Workflow', steps: [{ id: 's1', type: 'log', message: 'ok' }] } }));
  const handler = new NativeBridgeHandler({
    identity: { deviceId: 'device-1' },
    registry,
    version: '0.1.0',
    supervisor: { getState: () => ({ browserState: 'running', extensionLoaded: true }) },
    now: () => '2026-07-16T00:00:00.000Z'
  });
  const queued = handler.enqueueDispatch({
    jobId: 'job-1',
    workflowId: 'wf-1',
    workflowRevision: 1,
    workflowContentHash: 'e'.repeat(64),
    inputs: {},
    deadline: '2026-07-16T00:05:00.000Z',
    idempotencyKey: 'dispatch-1'
  });
  handler.enqueueCancel({ jobId: 'job-1', deadline: '2026-07-16T00:05:00.000Z', idempotencyKey: 'cancel-1' });
  const cancel = await handler.handle(envelope('bridge.health.request', {}));
  const dispatch = await handler.handle(envelope('bridge.health.request', {}));
  const empty = await handler.handle(envelope('bridge.health.request', {}));
  assert.deepEqual(queued, { queued: true });
  assert.equal(cancel.type, 'execution.cancel');
  assert.equal(cancel.payload.jobId, 'job-1');
  assert.equal(dispatch.type, 'execution.dispatch');
  assert.equal(dispatch.payload.profilePayload.steps[0].message, 'ok');
  assert.equal(empty.payload.pending, 0);
});

test('native bridge forwards extension execution envelopes and deduplicates completed jobs', async () => {
  const forwarded = [];
  const registry = new WorkflowRegistry({ filePath: tempFile('registry.json') });
  registry.putRevision(revisionFixture({ contentHash: 'f'.repeat(64) }));
  const handler = new NativeBridgeHandler({
    identity: { deviceId: 'device-1' },
    registry,
    version: '0.1.0',
    supervisor: { getState: () => ({ browserState: 'running', extensionLoaded: true }) },
    onExecutionEnvelope: (envelope) => forwarded.push(envelope),
    now: () => '2026-07-16T00:00:00.000Z'
  });
  handler.enqueueDispatch({
    jobId: 'job-1',
    workflowId: 'wf-1',
    workflowRevision: 1,
    workflowContentHash: 'f'.repeat(64),
    inputs: {},
    deadline: '2026-07-16T00:05:00.000Z',
    idempotencyKey: 'dispatch-1'
  });
  const result = await handler.handle({
    ...envelope('execution.result', {
      eventType: 'job_succeeded',
      jobId: 'job-1',
      sentAt: '2026-07-16T00:00:00.000Z',
      result: { ok: true }
    }),
    jobId: 'job-1',
    idempotencyKey: 'job-1-succeeded'
  });
  const duplicate = handler.enqueueDispatch({
    jobId: 'job-1',
    workflowId: 'wf-1',
    workflowRevision: 1,
    workflowContentHash: 'f'.repeat(64),
    inputs: {},
    deadline: '2026-07-16T00:05:00.000Z',
    idempotencyKey: 'dispatch-1'
  });
  assert.equal(result.payload.accepted, true);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(duplicate, { queued: false, duplicate: true });
});

function revisionFixture(overrides = {}) {
  return {
    workflowId: 'wf-1',
    revision: 1,
    schemaVersion: 'war-workflow-revision.v2',
    contentHash: '0'.repeat(64),
    name: 'Workflow',
    description: '',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    sourceDeviceId: 'device-1',
    requiredInputs: [],
    profilePayload: { id: 'wf-1', name: 'Workflow', steps: [] },
    ...overrides
  };
}

function envelope(type, payload) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `msg-${type}`,
    type,
    sentAt: '2026-07-16T00:00:00.000Z',
    correlationId: `corr-${type}`,
    deadline: '2026-07-16T00:05:00.000Z',
    payload
  };
}

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-agent-'));
  return path.join(dir, name);
}

function tempSocketPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\war-agent-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return tempFile('bridge.sock');
}

async function sendLine(socketPath, value) {
  return sendRaw(socketPath, `${JSON.stringify(value)}\n`);
}

async function sendRaw(socketPath, raw) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');
  await once(socket, 'connect');
  socket.write(raw);
  const [chunk] = await once(socket, 'data');
  socket.destroy();
  return JSON.parse(chunk);
}
