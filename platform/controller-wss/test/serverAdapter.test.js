import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';
import { ControllerCore, hashSecret } from '../../controller-core/src/controllerCore.js';
import { createMemoryStore } from '../../../companion/store.js';
import { ControllerWssServerAdapter } from '../src/serverAdapter.js';
import { ControllerWssRuntimeServer, parseAuthorization } from '../src/wssServer.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';
import { createWorkflowContentHash } from '../../workflow-core/src/workflowMetadata.js';

test('controller WSS adapter authenticates AgentHello and rejects oversized or wrong-version envelopes', async () => {
  const core = await pairedCore();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions, maxPayloadBytes: 4096 });
  const ok = await adapter.handleMessage(JSON.stringify(agentHello()), {}, 'cred-a', () => {});
  assert.equal(ok.payload.ok, true);
  const tooLarge = await adapter.handleMessage('x'.repeat(5000), {}, 'cred-a', () => {});
  assert.equal(tooLarge.payload.error.code, 'payload_too_large');
  const wrong = await adapter.handleMessage(JSON.stringify({ ...agentHello(), protocolVersion: 'war-control.v1' }), {}, 'cred-a', () => {});
  assert.equal(wrong.payload.ok, false);
});

test('controller WSS adapter cleans socket listeners on shutdown', async () => {
  const core = await pairedCore();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions });
  const connection = new FakeConnection();
  adapter.accept(connection, { credential: 'cred-a' });
  connection.emit('message', JSON.stringify(agentHello()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.connections.size, 1);
  adapter.shutdown();
  assert.equal(adapter.connections.size, 0);
  assert.equal(connection.closed, true);
});

test('controller WSS adapter registers only authenticated active connections', async () => {
  const core = await pairedCore();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions });
  const unauthenticated = new FakeConnection();
  adapter.accept(unauthenticated, { credential: 'cred-a' });
  assert.throws(() => adapter.sendDispatch('dev-a', 1, dispatchPayload()), /offline/i);

  unauthenticated.emit('message', JSON.stringify(agentHello()));
  await tick();
  const session = core.sessions.getPublicSession('dev-a');
  const result = adapter.sendDispatch('dev-a', session.generation, dispatchPayload());
  assert.equal(unauthenticated.authenticated, true);
  assert.deepEqual(result, { delivered: true, deviceId: 'dev-a', generation: session.generation });
  assert.equal(JSON.parse(unauthenticated.sent.at(-1)).type, 'execution.dispatch');
});

test('controller WSS adapter closes a connection after pre-authentication failure', async () => {
  const core = await pairedCore();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions });
  const connection = new FakeConnection();
  adapter.accept(connection, { credential: 'wrong-credential' });

  connection.emit('message', JSON.stringify(agentHello()));
  await tick();

  assert.equal(connection.closed, true);
  assert.equal(connection.authenticated, false);
});

test('controller WSS adapter replaces same-device connections and ignores stale close', async () => {
  const core = await pairedCore();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions });
  const first = new FakeConnection();
  adapter.accept(first, { credential: 'cred-a' });
  first.emit('message', JSON.stringify(agentHello()));
  await tick();
  const firstSession = core.sessions.getPublicSession('dev-a');

  const second = new FakeConnection();
  adapter.accept(second, { credential: 'cred-a' });
  second.emit('message', JSON.stringify(agentHello('nonce-b')));
  await tick();
  const secondSession = core.sessions.getPublicSession('dev-a');
  assert.equal(secondSession.generation, firstSession.generation + 1);
  assert.equal(first.closed, true);

  first.emit('close');
  adapter.sendDispatch('dev-a', secondSession.generation, dispatchPayload({ jobId: 'job-new' }));
  assert.equal(JSON.parse(second.sent.at(-1)).payload.jobId, 'job-new');
});

test('controller WSS adapter marks closed active connection offline', async () => {
  const core = await pairedCore();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions });
  const connection = new FakeConnection();
  adapter.accept(connection, { credential: 'cred-a' });
  connection.emit('message', JSON.stringify(agentHello()));
  await tick();

  const online = core.sessions.getPublicSession('dev-a');
  assert.equal(online.status, 'online');
  connection.emit('close');
  const offline = core.sessions.getPublicSession('dev-a');

  assert.equal(offline.status, 'offline');
  assert.equal(core.devices.getDevice('dev-a').status, 'offline');
  assert.equal(codeOf(() => adapter.sendDispatch('dev-a', online.generation, dispatchPayload())), 'SESSION_OFFLINE');
});

test('controller WSS adapter rejects stale, offline, closed, and failed sends', async () => {
  const core = await pairedCore();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions });
  const connection = new FakeConnection();
  adapter.accept(connection, { credential: 'cred-a' });
  connection.emit('message', JSON.stringify(agentHello()));
  await tick();
  const session = core.sessions.getPublicSession('dev-a');
  assert.equal(codeOf(() => adapter.sendDispatch('dev-a', session.generation + 1, dispatchPayload())), 'SESSION_STALE');
  connection.open = false;
  assert.equal(codeOf(() => adapter.sendDispatch('dev-a', session.generation, dispatchPayload())), 'SESSION_OFFLINE');
  connection.open = true;
  connection.failSend = true;
  assert.equal(codeOf(() => adapter.sendDispatch('dev-a', session.generation, dispatchPayload())), 'WSS_SEND_FAILED');
  adapter.shutdown();
  assert.equal(codeOf(() => adapter.sendDispatch('dev-a', session.generation, dispatchPayload())), 'SESSION_OFFLINE');
});

test('controller WSS adapter emits execution invalidation after persisted result', async () => {
  const core = await pairedCore();
  await core.workflows.putRevision(revision());
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions });
  const state = {};
  await adapter.handleMessage(JSON.stringify(agentHello()), state, 'cred-a', () => {});
  const session = core.sessions.getPublicSession('dev-a');
  const { dispatch } = await core.sessions.dispatch({
    deviceId: 'dev-a',
    generation: session.generation,
    workflowId: 'wf-a',
    workflowRevision: 1,
    workflowContentHash: revision().contentHash,
    inputs: {},
    deadline: '2026-07-16T00:05:00.000Z',
    idempotencyKey: 'dispatch-a'
  });
  const events = [];
  adapter.on('execution', (event) => events.push(event));
  const response = await adapter.handleMessage(JSON.stringify(executionResult(session, dispatch.jobId)), state, 'cred-a', () => {});
  assert.equal(response.payload.ok, true);
  assert.deepEqual(events, [{ jobId: dispatch.jobId, deviceId: 'dev-a', eventType: 'job_succeeded' }]);
});

test('controller WSS origin request resolves only authenticated matching Agent responses', async () => {
  const core = await pairedCore();
  const adapter = new ControllerWssServerAdapter({ sessionManager: core.sessions, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });
  const connection = new FakeConnection();
  const state = { connection };
  await adapter.handleMessage(JSON.stringify(agentHello()), state, 'cred-a', () => {});
  const session = core.sessions.getPublicSession('dev-a');

  const request = adapter.requestOriginInventory('dev-a', session.generation);
  const sent = JSON.parse(connection.sent.at(-1));
  assert.equal(sent.type, 'origin.inventory.request');

  const unauthenticated = await adapter.handleMessage(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'spoof-a',
    type: 'origin.inventory.response',
    sentAt: '2026-07-16T00:00:00.000Z',
    correlationId: sent.messageId,
    payload: { workflows: [] }
  }), {}, 'cred-a', () => {});
  assert.equal(unauthenticated.payload.error.code, 'unauthenticated');

  const ack = await adapter.handleMessage(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'response-a',
    type: 'origin.inventory.response',
    sentAt: '2026-07-16T00:00:00.000Z',
    correlationId: sent.messageId,
    deviceId: 'dev-a',
    sessionId: session.sessionId,
    payload: { workflows: [{ workflowId: 'wf-origin', revision: 1, contentHash: 'b'.repeat(64), name: 'Origin', updatedAt: '2026-07-16T00:00:00.000Z' }] }
  }), state, 'cred-a', () => {});
  const response = await request;
  assert.equal(ack, null);
  assert.equal(response.payload.workflows[0].workflowId, 'wf-origin');
});

test('authorization parser accepts one Bearer credential and rejects malformed headers', () => {
  assert.deepEqual(parseAuthorization('Bearer credential-a'), { ok: true, credential: 'credential-a' });
  assert.deepEqual(parseAuthorization('bearer credential-a'), { ok: true, credential: 'credential-a' });
  assert.equal(parseAuthorization(undefined).ok, false);
  assert.equal(parseAuthorization('Basic credential-a').ok, false);
  assert.equal(parseAuthorization('Bearer    ').ok, false);
  assert.equal(parseAuthorization('Bearer one, Bearer two').ok, false);
  assert.equal(parseAuthorization(['Bearer one', 'Bearer two']).ok, false);
});

test('runtime WSS wrapper accepts configured path with Authorization and rejects other upgrades', async () => {
  const server = http.createServer();
  const accepted = [];
  const adapter = {
    accept(connection, context) {
      accepted.push(context);
      connection.close();
    }
  };
  const runtime = new ControllerWssRuntimeServer({ server, adapter, path: '/v1/agent-session' });
  await listen(server);
  try {
    const { port } = server.address();
    await assert.rejects(() => connect(`ws://127.0.0.1:${port}/wrong`, { Authorization: 'Bearer credential-a' }));
    await assert.rejects(() => connect(`ws://127.0.0.1:${port}/v1/agent-session`));
    await connect(`ws://127.0.0.1:${port}/v1/agent-session`, { Authorization: 'Bearer credential-a' });
    assert.deepEqual(accepted, [{ credential: 'credential-a' }]);
  } finally {
    runtime.shutdown();
    await close(server);
  }
});

test('runtime WSS wrapper caps connections and closes clients that miss the hello deadline', async () => {
  const server = http.createServer();
  const adapter = { accept() {} };
  const runtime = new ControllerWssRuntimeServer({ server, adapter, maxConnections: 1, authenticationTimeoutMs: 100 });
  await listen(server);
  try {
    const { port } = server.address();
    const first = await connect(`ws://127.0.0.1:${port}/v1/agent-session`, { Authorization: 'Bearer credential-a' });
    await assert.rejects(() => connect(`ws://127.0.0.1:${port}/v1/agent-session`, { Authorization: 'Bearer credential-b' }));
    await waitForClose(first);
    assert.equal(runtime.connections.size, 0);
  } finally {
    runtime.shutdown();
    await close(server);
  }
});

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
    this.open = true;
    this.failSend = false;
    this.authenticated = false;
  }

  send(message) {
    if (this.failSend) throw new Error('send failed');
    this.sent.push(message);
  }

  isOpen() {
    return this.open && !this.closed;
  }

  close() {
    this.closed = true;
    this.open = false;
    this.emit('close');
  }

  markAuthenticated() {
    this.authenticated = true;
  }
}

async function pairedCore() {
  const store = createMemoryStore();
  const core = new ControllerCore({ store, now: () => '2026-07-16T00:00:00.000Z', id: (prefix) => `${prefix}-1` });
  await core.load();
  await core.pairing.requestPairing({ device: device(), requestId: 'pair-a' });
  await core.store.update((state) => {
    state.pendingPairings[0].tokenHash = hashSecret('code-a');
  });
  await core.pairing.confirmPairing('pair-a', 'code-a');
  await core.store.update((state) => {
    state.pairedAgents[0].credentialHash = hashSecret('cred-a');
  });
  return core;
}

function agentHello(nonce = 'nonce-a') {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `hello-a-${nonce}`,
    type: 'agent.hello',
    sentAt: '2026-07-16T00:00:00.000Z',
    deviceId: 'dev-a',
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      device: device(),
      supportedMessageTypes: ['agent.hello', 'agent.presence', 'agent.execution.event'],
      sessionNonce: nonce,
      sentAt: '2026-07-16T00:00:00.000Z'
    }
  };
}

function dispatchPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: 'job-a',
    workflowId: 'wf-a',
    workflowRevision: 1,
    workflowContentHash: revision().contentHash,
    inputs: {},
    deadline: '2026-07-16T00:05:00.000Z',
    idempotencyKey: 'dispatch-a',
    controlPath: 'native_bridge',
    leaseId: 'lease-a',
    ...overrides
  };
}

function executionResult(session, jobId) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `result-${jobId}`,
    type: 'execution.result',
    sentAt: '2026-07-16T00:00:01.000Z',
    deadline: '2026-07-16T00:05:00.000Z',
    idempotencyKey: `result-${jobId}`,
    deviceId: session.deviceId,
    sessionId: session.sessionId,
    jobId,
    payload: { jobId, eventType: 'job_succeeded', sentAt: '2026-07-16T00:00:01.000Z', result: { ok: true }, generation: session.generation }
  };
}

function revision() {
  const value = {
    workflowId: 'wf-a',
    revision: 1,
    schemaVersion: 'war-workflow-revision.v2',
    contentHash: '',
    name: 'Workflow',
    description: '',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    sourceDeviceId: 'dev-a',
    requiredInputs: [],
    profilePayload: { id: 'wf-a', steps: [] }
  };
  value.contentHash = createWorkflowContentHash(value);
  return value;
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sequenceId() {
  let i = 0;
  return (prefix) => `${prefix}-${++i}`;
}

function device() {
  return {
    deviceId: 'dev-a',
    displayName: 'Agent A',
    hostName: 'host-a',
    platform: 'linux',
    architecture: 'x64',
    agentVersion: '0.1.0',
    extensionVersion: '0.1.0',
    browserVersion: '150',
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
    labels: [],
    groupIds: [],
    status: 'online',
    lastSeenAt: '2026-07-16T00:00:00.000Z'
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function connect(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [], { headers });
    socket.on('open', () => resolve(socket));
    socket.on('close', () => resolve(socket));
    socket.on('error', reject);
  });
}

function waitForClose(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', resolve));
}
