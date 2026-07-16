import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import crypto from 'node:crypto';
import { ControllerSessionClient, createWebSocketConnector } from '../src/controllerSessionClient.js';

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
  socket.emit('message', JSON.stringify({ correlationId: 'hello', payload: { replay: [{ jobId: 'job-1' }] } }));
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
  socket.emit('message', JSON.stringify({ payload: { session: { sessionId: 'session-1', generation: 1, deviceId: 'dev-a' } } }));
  socket.emit('message', JSON.stringify({ type: 'execution.cancel', payload: { jobId: 'job-1' } }));
  client.sendExecutionEvent({ jobId: 'job-1', eventType: 'job_started', idempotencyKey: 'job-1-started' });
  const sent = JSON.parse(socket.sent.at(-1));
  assert.deepEqual(cancels, [{ jobId: 'job-1' }]);
  assert.equal(sent.type, 'execution.event');
  assert.equal(sent.sessionId, 'session-1');
  assert.equal(sent.payload.eventType, 'job_started');
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
