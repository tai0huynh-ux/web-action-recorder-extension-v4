import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_CHANNELS,
  IPC_CHANNELS,
  MAX_IPC_PAYLOAD_BYTES,
  MAX_LIST_LIMIT,
  REQUEST_CHANNELS,
  validateIpcPayload,
} from '../src/ipcContract.js';

const allChannels = flattenChannels(IPC_CHANNELS);

test('all channels are unique', () => {
  assert.equal(new Set(allChannels).size, allChannels.length);
});

test('all channels use the war controller v1 namespace', () => {
  for (const channel of allChannels) {
    assert.equal(channel.startsWith('war-controller:v1:'), true);
  }
});

test('generic RPC channels are not exposed', () => {
  const genericTerms = ['controller:invoke', 'rpc', 'callMethod', 'executeService'];
  for (const channel of allChannels) {
    assert.equal(genericTerms.some((term) => channel.includes(term)), false);
  }
});

test('request and event channels do not overlap', () => {
  const eventChannels = new Set(EVENT_CHANNELS);
  assert.equal(REQUEST_CHANNELS.some((channel) => eventChannels.has(channel)), false);
});

test('contract and channel collections are immutable', () => {
  assert.equal(Object.isFrozen(IPC_CHANNELS), true);
  assert.equal(Object.isFrozen(IPC_CHANNELS.jobs), true);
  assert.equal(Object.isFrozen(REQUEST_CHANNELS), true);
  assert.equal(Object.isFrozen(EVENT_CHANNELS), true);
  assert.throws(() => {
    IPC_CHANNELS.jobs.dispatch = 'rpc';
  }, TypeError);
  assert.throws(() => {
    REQUEST_CHANNELS.push('rpc');
  }, TypeError);
});

test('unknown channel is rejected', () => {
  assertErrorCode(() => validateIpcPayload('war-controller:v1:unknown', {}), 'ERR_IPC_UNKNOWN_CHANNEL');
});

test('unknown property is rejected', () => {
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.devices.get, { deviceId: 'device-1', extra: true }),
    'ERR_IPC_UNKNOWN_PROPERTY',
  );
});

test('payload over 256 KiB is rejected', () => {
  const oversized = { deviceId: 'device-1', workflowId: 'workflow-1', revision: 1, inputs: { value: 'x'.repeat(MAX_IPC_PAYLOAD_BYTES) } };
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.jobs.dispatch, oversized),
    'ERR_IPC_PAYLOAD_TOO_LARGE',
  );
});

test('list limit accepts 1 and 200', () => {
  assert.deepEqual(validateIpcPayload(IPC_CHANNELS.jobs.list, { limit: 1 }), { limit: 1 });
  assert.deepEqual(validateIpcPayload(IPC_CHANNELS.jobs.list, { limit: MAX_LIST_LIMIT }), { limit: 200 });
});

test('list limit rejects 0, 201, decimals, and strings', () => {
  for (const limit of [0, 201, 1.5, '1']) {
    assertErrorCode(
      () => validateIpcPayload(IPC_CHANNELS.jobs.list, { limit }),
      'ERR_IPC_INVALID_LIMIT',
    );
  }
});

test('empty ID is rejected', () => {
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.devices.get, { deviceId: '' }),
    'ERR_IPC_INVALID_ID',
  );
});

test('top-level dangerous key is rejected', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"limit":1}');
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.devices.list, payload),
    'ERR_IPC_DANGEROUS_KEY',
  );
});

test('nested dangerous key is rejected', () => {
  const payload = JSON.parse('{"deviceId":"device-1","workflowId":"workflow-1","revision":1,"inputs":{"constructor":{"polluted":true}}}');
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.jobs.dispatch, payload),
    'ERR_IPC_DANGEROUS_KEY',
  );
});

test('valid dispatch payload is accepted as a sanitized clone', () => {
  const payload = {
    deviceId: 'device-1',
    workflowId: 'workflow-1',
    revision: 1,
    inputs: { url: 'https://example.test' },
    deadlineSeconds: 300,
  };
  const validated = validateIpcPayload(IPC_CHANNELS.jobs.dispatch, payload);
  assert.deepEqual(validated, payload);
  assert.notEqual(validated, payload);
  assert.notEqual(validated.inputs, payload.inputs);
});

test('pairing request and confirmation payloads are narrow and sanitized', () => {
  const device = { deviceId: 'dev-a', displayName: 'Agent A' };
  const request = validateIpcPayload(IPC_CHANNELS.pairings.request, { device, displayName: 'Agent A', requestId: 'pair-a' });
  assert.deepEqual(request, { device, displayName: 'Agent A', requestId: 'pair-a' });
  assert.notEqual(request.device, device);
  assert.deepEqual(validateIpcPayload(IPC_CHANNELS.pairings.confirm, { requestId: 'pair-a', code: 'code-a' }), { requestId: 'pair-a', code: 'code-a' });
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.pairings.confirm, { pairingId: 'pair-a', code: 'code-a' }),
    'ERR_IPC_UNKNOWN_PROPERTY',
  );
});

test('dispatch payload rejects main-owned fields', () => {
  for (const key of ['generation', 'sessionId', 'jobId', 'leaseId', 'workflowContentHash', 'controlPath', 'idempotencyKey', 'deadline']) {
    assertErrorCode(
      () => validateIpcPayload(IPC_CHANNELS.jobs.dispatch, { deviceId: 'device-1', workflowId: 'workflow-1', revision: 1, [key]: 'main-owned' }),
      'ERR_IPC_UNKNOWN_PROPERTY',
    );
  }
});

test('container payload accepts only bounded renderer-owned fields', () => {
  const payload = {
    name: 'Agent One',
    image: 'war-browser-agent:phase1',
    host: '192.0.2.10',
    deviceId: 'dev-a',
    runtime: { dockerName: 'agent-one', privileged: true },
  };
  const validated = validateIpcPayload(IPC_CHANNELS.containers.add, payload);
  assert.deepEqual(validated, payload);
  assert.notEqual(validated.runtime, payload.runtime);

  for (const key of ['command', 'shell', 'dockerSocket', 'credential', 'token', 'password']) {
    assertErrorCode(
      () => validateIpcPayload(IPC_CHANNELS.containers.add, { name: 'Agent One', [key]: 'main-owned' }),
      'ERR_IPC_UNKNOWN_PROPERTY',
    );
  }
});

test('container network payload accepts only explicit IPv4 and IPv6 preferences', () => {
  const payload = { containerId: 'container-1', ipv4Enabled: false, ipv6Enabled: true, ipv6Suffix: 'abcd:ef01:2345:6789' };
  assert.deepEqual(validateIpcPayload(IPC_CHANNELS.containers.updateNetwork, payload), payload);
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.containers.updateNetwork, { ...payload, networkMode: 'host' }),
    'ERR_IPC_UNKNOWN_PROPERTY',
  );
});

test('trash operations accept only exact container and host identifiers', () => {
  assert.deepEqual(validateIpcPayload(IPC_CHANNELS.containers.restore, { containerId: 'container-1' }), { containerId: 'container-1' });
  assert.deepEqual(validateIpcPayload(IPC_CHANNELS.containers.purge, { containerId: 'container-1' }), { containerId: 'container-1' });
  assert.deepEqual(validateIpcPayload(IPC_CHANNELS.containers.hostTrash, { hostId: 'ssh-host-1' }), { hostId: 'ssh-host-1' });
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.containers.hostPurge, { hostId: 'ssh-host-1', force: true }),
    'ERR_IPC_UNKNOWN_PROPERTY',
  );
});

test('validator does not mutate input', () => {
  const payload = { deviceId: 'device-1', workflowId: 'workflow-1', revision: 1, inputs: { count: 1 } };
  const before = JSON.stringify(payload);
  const validated = validateIpcPayload(IPC_CHANNELS.jobs.dispatch, payload);
  validated.inputs.count = 2;
  assert.equal(JSON.stringify(payload), before);
});

test('channel without payload rejects extra data', () => {
  assert.deepEqual(validateIpcPayload(IPC_CHANNELS.system.getBootstrap), {});
  assert.deepEqual(validateIpcPayload(IPC_CHANNELS.system.getBootstrap, null), {});
  assert.deepEqual(validateIpcPayload(IPC_CHANNELS.system.getBootstrap, {}), {});
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.system.getBootstrap, { extra: true }),
    'ERR_IPC_UNEXPECTED_PAYLOAD',
  );
});

test('object channels reject non-object payloads and invalid integers', () => {
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.devices.get, 'device-1'),
    'ERR_IPC_INVALID_PAYLOAD',
  );
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.jobs.dispatch, { deviceId: 'device-1', workflowId: 'workflow-1', revision: 0 }),
    'ERR_IPC_INVALID_INTEGER',
  );
  assertErrorCode(
    () => validateIpcPayload(IPC_CHANNELS.jobs.dispatch, { deviceId: 'device-1', workflowId: 'workflow-1', revision: 1, deadlineSeconds: 1.5 }),
    'ERR_IPC_INVALID_INTEGER',
  );
});

function flattenChannels(value) {
  return Object.values(value).flatMap((entry) => (typeof entry === 'string' ? [entry] : flattenChannels(entry)));
}

function assertErrorCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}
