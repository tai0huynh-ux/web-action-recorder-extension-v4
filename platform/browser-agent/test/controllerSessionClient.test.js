import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import crypto from 'node:crypto';
import { ControllerSessionClient, buildDeviceDescriptor, createWebSocketConnector } from '../src/controllerSessionClient.js';

test('real WebSocket connector sends Authorization header during opening handshake', async () => {
  let authorization;
  let sawUpgrade = false;
  const server = http.createServer();
  const sockets = new Set();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    sawUpgrade = true;
    authorization = request.headers.authorization;
    const accept = crypto
      .createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n'));
    setImmediate(() => socket.destroy());
  });
  await listen(server);
  try {
    const { port } = server.address();
    createWebSocketConnector(`ws://127.0.0.1:${port}/session`, {
      headers: { Authorization: 'Bearer test-controller-credential' }
    });
    await waitFor(() => sawUpgrade);
    assert.equal(authorization, 'Bearer test-controller-credential');
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(server);
  }
});

test('outbound controller session requires wss and keeps credential out of URL', () => {
  assert.throws(() => new ControllerSessionClient({ url: 'ws://controller', credential: 'secret' }), /wss/);
  assert.throws(() => new ControllerSessionClient({ url: 'wss://controller?token=secret', credential: 'secret' }), /URL/);
});

test('controller restart triggers deterministic reconnect with jitter and no zero delay', () => {
  const scheduler = fakeScheduler();
  const sockets = [];
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduler,
    random: () => 0,
    minReconnectMs: 500,
    maxReconnectMs: 2000
  });
  client.start();
  sockets[0].emit('close');
  assert.equal(scheduler.timers[0].ms, 500);
  scheduler.runNext();
  sockets[1].emit('open');
  assert.equal(JSON.parse(sockets[1].sent[0]).type, 'agent.hello');
  sockets[1].emit('close');
  assert.equal(scheduler.timers[0].ms, 500);
});

test('device descriptor advertises clipboard text and a safely supplied browser version', () => {
  const descriptor = buildDeviceDescriptor({ deviceId: 'dev-a', browserVersion: 'CloakBrowser 146.0.7680.177.5' }, '0.5.5', () => '2026-07-16T00:00:00.000Z');
  assert.equal(descriptor.capabilities.clipboardText, true);
  assert.equal(descriptor.browserVersion, 'CloakBrowser 146.0.7680.177.5');
});

test('transient remote-control responses are never queued while the session is offline', () => {
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => new FakeSocket(),
    scheduler: fakeScheduler(),
  });
  assert.throws(() => client.sendRemoteControlResponse({ messageId: 'clipboard-request' }, {
    ok: true,
    result: { type: 'clipboard.copySelection', result: { copied: true, text: 'secret', bytes: 6 } }
  }, { transient: true }), /transient/);
  assert.equal(client.queue.length, 0);
});

test('error and close from one socket schedule only one reconnect timer', () => {
  const scheduler = fakeScheduler();
  const sockets = [];
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduler,
    random: () => 0
  });
  client.start();
  sockets[0].emit('error', new Error('network dropped'));
  sockets[0].emit('close');
  assert.equal(scheduler.timers.length, 1);
});

test('late stale socket error does not move the active socket back to reconnecting', () => {
  const scheduler = fakeScheduler();
  const sockets = [];
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduler,
    random: () => 0
  });
  client.start();
  sockets[0].emit('close');
  scheduler.runNext();
  sockets[1].emit('open');
  sockets[0].emit('error', new Error('late old socket error'));
  assert.equal(client.status, 'online');
  assert.equal(scheduler.timers.length, 1);
});

test('timed-out outbound connect is retired before one prompt reconnect can authenticate', () => {
  const scheduler = fakeScheduler();
  const sockets = [];
  const remoteControls = [];
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduler,
    random: () => 0,
    minReconnectMs: 500,
    maxReconnectMs: 2000,
    connectTimeoutMs: 5000
  });
  client.on('remoteControl', (request) => remoteControls.push(request));

  client.start();
  assert.equal(scheduler.timers.length, 1);
  assert.equal(scheduler.timers[0].ms, 5000);

  scheduler.runNext();
  assert.equal(sockets[0].closed, true);
  assert.equal(client.status, 'reconnecting');
  assert.equal(scheduler.timers.length, 1);
  assert.equal(scheduler.timers[0].ms, 500);

  // Timed-out sockets must be unable to win the reconnect race.
  sockets[0].emit('open');
  sockets[0].emit('error', new Error('late timed-out socket error'));
  sockets[0].emit('close');
  assert.equal(client.status, 'reconnecting');
  assert.equal(sockets[0].sent.length, 0);
  assert.equal(scheduler.timers.length, 1);

  scheduler.runNext();
  sockets[1].emit('open');
  assert.equal(client.status, 'online');
  assert.deepEqual(sockets[1].sent.map((message) => JSON.parse(message).type), ['agent.hello']);
  const session = authenticate(sockets[1]);

  sockets[0].emit('message', JSON.stringify(controllerRequest({
    type: 'remote.control.request',
    messageId: 'late-timed-out-request',
    session,
    deadline: '2026-07-16T00:00:10.000Z',
    idempotencyKey: 'late-timed-out-request',
    payload: { command: 'input.shortcut', payload: { keys: 'CTRL+T' } }
  })));
  assert.deepEqual(remoteControls, []);
  assert.equal(scheduler.timers.length, 1);
});

test('agent restart sends fresh hello, receives replay dispatch, and shutdown clears timers/listeners', () => {
  const scheduler = fakeScheduler();
  const socket = new FakeSocket();
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => socket,
    scheduler,
    now: () => '2026-07-16T00:00:00.000Z'
  });
  const dispatches = [];
  client.on('dispatch', (item) => dispatches.push(item));
  client.start();
  socket.emit('open');
  assert.equal(JSON.parse(socket.sent[0]).type, 'agent.hello');
  socket.emit('message', JSON.stringify(controllerResponse({
    correlationId: JSON.parse(socket.sent[0]).messageId,
    replay: [{ jobId: 'job-1' }]
  })));
  assert.deepEqual(dispatches, [{ jobId: 'job-1' }]);
  assert.ok(scheduler.timers.length > 0);
  client.gracefulShutdown();
  assert.equal(scheduler.timers.length, 0);
  assert.equal(client.pending.size, 0);
  assert.equal(socket.closed, true);
});

test('controller session tracks session, emits cancel, and sends execution events with session id', () => {
  const scheduler = fakeScheduler();
  const socket = new FakeSocket();
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => socket,
    scheduler,
    now: () => '2026-07-16T00:00:00.000Z'
  });
  const cancels = [];
  client.on('cancel', (item) => cancels.push(item));
  client.start();
  socket.emit('open');
  const session = authenticate(socket);
  socket.emit('message', JSON.stringify(controllerRequest({
    type: 'execution.cancel',
    messageId: 'cancel-a',
    session,
    deadline: '2026-07-16T00:00:10.000Z',
    idempotencyKey: 'cancel-a',
    payload: { jobId: 'job-1' }
  })));
  client.sendExecutionEvent({ jobId: 'job-1', eventType: 'job_started', idempotencyKey: 'job-1-started' });
  const sent = JSON.parse(socket.sent.at(-1));
  assert.deepEqual(cancels, [{ jobId: 'job-1' }]);
  assert.equal(sent.type, 'execution.event');
  assert.equal(sent.sessionId, 'session-1');
  assert.equal(sent.payload.eventType, 'job_started');
});

test('terminal execution send waits for correlated Controller acknowledgement', async () => {
  const scheduler = fakeScheduler();
  const socket = new FakeSocket();
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => socket,
    scheduler,
    now: () => '2026-07-16T00:00:00.000Z'
  });
  const authenticated = [];
  client.on('authenticated', (session) => authenticated.push(session));
  client.start();
  socket.emit('open');
  const session = authenticate(socket);
  const pending = client.sendExecutionEvent({ jobId: 'job-1', eventType: 'job_succeeded', result: { ok: true } });
  const sent = JSON.parse(socket.sent.at(-1));
  assert.equal(client.pending.size, 1);
  socket.emit('message', JSON.stringify(controllerResponse({ correlationId: sent.messageId, session })));
  const response = await pending;
  assert.equal(response.payload.ok, true);
  assert.equal(client.pending.size, 0);
  assert.equal(authenticated.length, 1);
});

test('replayed terminal envelope receives a fresh transport timestamp and deadline', () => {
  const socket = new FakeSocket();
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => socket,
    scheduler: fakeScheduler(),
    now: () => '2026-07-16T01:00:00.000Z'
  });
  client.start();
  socket.emit('open');
  client.sendExecutionEnvelope({
    type: 'execution.result',
    sentAt: '2026-07-16T00:00:00.000Z',
    deadline: '2026-07-16T00:00:30.000Z',
    jobId: 'job-1',
    idempotencyKey: 'job-1-succeeded',
    payload: { jobId: 'job-1', eventType: 'job_succeeded', sentAt: '2026-07-16T00:00:00.000Z', result: { ok: true } }
  });
  const sent = JSON.parse(socket.sent.at(-1));
  assert.equal(sent.sentAt, '2026-07-16T01:00:00.000Z');
  assert.equal(sent.deadline, '2026-07-16T01:00:30.000Z');
  assert.equal(sent.payload.sentAt, '2026-07-16T00:00:00.000Z');
});

test('controller session handles origin sync requests and sends correlated responses', () => {
  const scheduler = fakeScheduler();
  const socket = new FakeSocket();
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => socket,
    scheduler,
    now: () => '2026-07-16T00:00:00.000Z'
  });
  const requests = [];
  client.on('originInventoryRequest', (request) => requests.push(request));
  client.start();
  socket.emit('open');
  const session = authenticate(socket);
  socket.emit('message', JSON.stringify(controllerRequest({
    type: 'origin.inventory.request',
    messageId: 'origin-request-a',
    session,
    payload: { entityTypes: ['workflows'] }
  })));

  client.sendOriginResponse(requests[0], { workflows: [], counts: { workflows: 0 } });

  const sent = JSON.parse(socket.sent.at(-1));
  assert.equal(requests.length, 1);
  assert.equal(sent.type, 'origin.inventory.response');
  assert.equal(sent.correlationId, 'origin-request-a');
  assert.equal(sent.sessionId, 'session-1');
});

test('controller session receives remote control and returns a correlated response', () => {
  const socket = new FakeSocket();
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => socket,
    scheduler: fakeScheduler(),
    now: () => '2026-07-16T00:00:00.000Z'
  });
  const requests = [];
  client.on('remoteControl', (request) => requests.push(request));
  client.start();
  socket.emit('open');
  const session = authenticate(socket);
  socket.emit('message', JSON.stringify(controllerRequest({
    type: 'remote.control.request',
    messageId: 'remote-request-a',
    session,
    deadline: '2026-07-16T00:00:10.000Z',
    idempotencyKey: 'remote-a',
    payload: { command: 'input.shortcut', payload: { keys: 'CTRL+T' } }
  })));

  client.sendRemoteControlResponse(requests[0], { ok: true, requestId: 'remote-a', result: { executed: true } });

  const sent = JSON.parse(socket.sent.at(-1));
  assert.equal(requests.length, 1);
  assert.equal(sent.type, 'remote.control.response');
  assert.equal(sent.correlationId, 'remote-request-a');
  assert.equal(sent.sessionId, 'session-1');
});

test('controller session emits remote control only for a valid current-session request', () => {
  const socket = new FakeSocket();
  const client = new ControllerSessionClient({
    url: 'wss://controller.example/session',
    credential: 'secret',
    identity: { deviceId: 'dev-a' },
    connector: () => socket,
    scheduler: fakeScheduler(),
    now: () => '2026-07-16T00:00:00.000Z'
  });
  const requests = [];
  client.on('remoteControl', (request) => requests.push(request));
  client.start();
  socket.emit('open');
  client.setSession({ sessionId: 'session-a', generation: 1, deviceId: 'dev-a' });

  const valid = (overrides = {}) => ({
    protocolVersion: 'war-control.v2',
    messageId: 'remote-valid',
    type: 'remote.control.request',
    sentAt: '2026-07-16T00:00:00.000Z',
    deadline: '2026-07-16T00:00:10.000Z',
    idempotencyKey: 'remote-valid',
    deviceId: 'dev-a',
    sessionId: 'session-a',
    payload: { command: 'input.shortcut', payload: { keys: 'CTRL+T' } },
    ...overrides
  });
  socket.emit('message', JSON.stringify(valid({ messageId: 'remote-wrong-device', deviceId: 'dev-b' })));
  socket.emit('message', JSON.stringify(valid({ messageId: 'remote-wrong-session', sessionId: 'session-b' })));
  socket.emit('message', JSON.stringify(valid({ messageId: 'remote-expired', deadline: '2026-07-15T23:59:59.000Z' })));
  socket.emit('message', JSON.stringify({ type: 'remote.control.request', payload: {} }));
  socket.emit('message', JSON.stringify(valid()));

  assert.deepEqual(requests.map((request) => request.messageId), ['remote-valid']);
});

class FakeSocket extends EventEmitter {
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

function fakeScheduler() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    runNext() {
      const timer = timers.shift();
      timer?.fn();
    }
  };
}

function authenticate(socket, session = fixtureSession()) {
  const hello = JSON.parse(socket.sent.at(-1));
  socket.emit('message', JSON.stringify(controllerResponse({ correlationId: hello.messageId, session })));
  return session;
}

function fixtureSession() {
  return { sessionId: 'session-1', generation: 1, deviceId: 'dev-a' };
}

function controllerResponse({ correlationId, session = fixtureSession(), replay = [] } = {}) {
  return {
    protocolVersion: 'war-control.v2',
    messageId: `controller-response-${correlationId}`,
    type: 'native.bridge.response',
    sentAt: '2026-07-16T00:00:00.000Z',
    correlationId,
    deviceId: session.deviceId,
    sessionId: session.sessionId,
    payload: { ok: true, session, replay }
  };
}

function controllerRequest({ type, messageId, session = fixtureSession(), deadline, idempotencyKey, payload } = {}) {
  return {
    protocolVersion: 'war-control.v2',
    messageId,
    type,
    sentAt: '2026-07-16T00:00:00.000Z',
    deviceId: session.deviceId,
    sessionId: session.sessionId,
    ...(deadline ? { deadline } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    payload
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error('Timed out waiting for WebSocket upgrade');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
