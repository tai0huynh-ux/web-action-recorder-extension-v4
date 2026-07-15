import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSupervisor } from '../src/browserSupervisor.js';

test('start is idempotent', async () => {
  const controller = fakeController();
  const supervisor = new BrowserSupervisor({ controller });
  await supervisor.start();
  await supervisor.start();
  assert.equal(controller.starts, 1);
});

test('stop is idempotent', async () => {
  const controller = fakeController();
  const supervisor = new BrowserSupervisor({ controller });
  await supervisor.start();
  await supervisor.stop();
  await supervisor.stop();
  assert.equal(controller.stops, 1);
});

test('restart does not overlap', async () => {
  const controller = fakeController();
  const supervisor = new BrowserSupervisor({ controller });
  await supervisor.start();
  await Promise.all([supervisor.restart(), supervisor.restart()]);
  assert.equal(controller.starts, 2);
  assert.equal(controller.stops, 1);
});

test('crash applies restart backoff path', async () => {
  const controller = fakeController();
  const supervisor = new BrowserSupervisor({ controller, maxRestarts: 3 });
  await supervisor.handleCrash('test');
  assert.equal(controller.starts, 1);
  assert.equal(supervisor.state, 'running');
});

test('restart budget exhaustion moves degraded', async () => {
  const controller = fakeController();
  const supervisor = new BrowserSupervisor({ controller, maxRestarts: 1, restartWindowMs: 60000 });
  await supervisor.handleCrash('first');
  await supervisor.handleCrash('second');
  assert.equal(supervisor.state, 'degraded');
});

test('SIGTERM cleanup can call stop handler path', async () => {
  const controller = fakeController();
  const supervisor = new BrowserSupervisor({ controller });
  await supervisor.start();
  await supervisor.stop();
  assert.equal(supervisor.state, 'stopped');
});

function fakeController() {
  return {
    starts: 0,
    stops: 0,
    extensionStatus: { loaded: true },
    async start() {
      this.starts += 1;
    },
    async stop() {
      this.stops += 1;
    },
    async getState() {
      return { tabs: [], extension: this.extensionStatus };
    }
  };
}
