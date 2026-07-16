import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ControllerSessionClient } from '../src/controllerSessionClient.js';

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
