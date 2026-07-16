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

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
    this.emit('close');
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

function agentHello() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'hello-a',
    type: 'agent.hello',
    sentAt: '2026-07-16T00:00:00.000Z',
    deviceId: 'dev-a',
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      device: device(),
      supportedMessageTypes: ['agent.hello', 'agent.presence', 'agent.execution.event'],
      sessionNonce: 'nonce-a',
      sentAt: '2026-07-16T00:00:00.000Z'
    }
  };
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
