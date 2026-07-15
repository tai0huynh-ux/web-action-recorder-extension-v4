import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlDispatcher } from '../src/controlDispatcher.js';

test('accepts valid envelope', async () => {
  const fake = makeFake();
  const dispatcher = makeDispatcher(fake);
  const result = await dispatcher.dispatch(envelope('browser.getState'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.browserState, 'running');
});

test('rejects wrong protocol', async () => {
  const dispatcher = makeDispatcher(makeFake());
  await assert.rejects(() => dispatcher.dispatch({ ...envelope('browser.getState'), protocol: 'bad' }), /Control envelope is invalid/);
});

test('rejects command past deadline', async () => {
  const dispatcher = makeDispatcher(makeFake(), () => Date.parse('2026-07-14T00:00:10.000Z'));
  await assert.rejects(() => dispatcher.dispatch(envelope('browser.getState', {}, { timestamp: '2026-07-14T00:00:00.000Z', deadlineMs: 1 })), /deadline/);
});

test('rejects unsupported type', async () => {
  const dispatcher = makeDispatcher(makeFake());
  await assert.rejects(() => dispatcher.dispatch(envelope('cdp.send')), /Unsupported command/);
});

test('duplicate mutating idempotency key does not run twice', async () => {
  const fake = makeFake();
  const dispatcher = makeDispatcher(fake);
  const request = envelope('tab.open', { url: 'https://example.com' }, { idempotencyKey: 'dup' });
  await dispatcher.dispatch(request);
  await dispatcher.dispatch(request);
  assert.equal(fake.openCount, 1);
});

test('URL scheme is blocked', async () => {
  const dispatcher = makeDispatcher(makeFake());
  await assert.rejects(() => dispatcher.dispatch(envelope('tab.open', { url: 'javascript:alert(1)' })), /Only http/);
});

test('URL credentials are blocked', async () => {
  const dispatcher = makeDispatcher(makeFake());
  await assert.rejects(() => dispatcher.dispatch(envelope('tab.open', { url: 'https://u:p@example.com' })), /credentials/);
});

function makeDispatcher(fake, now = () => Date.parse('2026-07-14T00:00:00.000Z')) {
  return new ControlDispatcher({ supervisor: fake.supervisor, controller: fake.controller, deviceId: 'device-1', now });
}

function envelope(type, payload = {}, overrides = {}) {
  return {
    protocol: 'war-control.v1',
    messageId: 'msg-1',
    type,
    deviceId: 'device-1',
    timestamp: '2026-07-14T00:00:00.000Z',
    deadlineMs: 60000,
    idempotencyKey: `${type}-key`,
    payload,
    ...overrides
  };
}

function makeFake() {
  const fake = { openCount: 0 };
  fake.supervisor = {
    getBrowserState: async () => ({ browserState: 'running' }),
    start: async () => ({ browserState: 'running' }),
    stop: async () => ({ browserState: 'stopped' }),
    restart: async () => ({ browserState: 'running' })
  };
  fake.controller = {
    listTabs: async () => [],
    openTab: async () => {
      fake.openCount += 1;
      return { targetId: 't1' };
    },
    activateTab: async () => ({ targetId: 't1' }),
    navigateTab: async () => ({ targetId: 't1' }),
    closeTab: async () => ({ closed: true })
  };
  return fake;
}
