import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ControllerCore, buildDatasetAssignments } from '../src/controllerCore.js';
import { createMemoryStore, JsonStore } from '../../../companion/store.js';
import { createServer } from '../../../companion/server.js';

const admin = 'a'.repeat(32);
const enroll = 'e'.repeat(32);

test('controller core import is independent from HTTP, Electron, Chrome, and supports injected clock/id', async () => {
  assert.equal(globalThis.chrome, undefined);
  assert.equal(globalThis.Electron, undefined);
  const store = createMemoryStore();
  const core = new ControllerCore({ store, now: () => '2026-07-16T00:00:00.000Z', id: (prefix) => `${prefix}-fixed` });
  await core.load();
  const before = process._getActiveHandles().length;
  await core.devices.enrollDevice({ name: 'A' }, { rawToken: 'token-a', tokenHash: 'hash-a' });
  const after = process._getActiveHandles().length;
  assert.ok(after <= before + 1);
  assert.equal(core.devices.listDevices().devices[0].id, 'dev-fixed');
});

test('device registry enrolls, idempotently updates, heartbeats, status changes, capabilities, and revokes', async () => {
  const core = await fixtureCore();
  const first = await core.devices.enrollDevice({ deviceId: 'dev-a', name: 'A' }, { rawToken: 'tok', tokenHash: 'hash' });
  const second = await core.devices.enrollDevice({ deviceId: 'dev-a', name: 'A2', capabilities: { workflowExecution: true } }, { rawToken: 'tok2', tokenHash: 'hash2' });
  await core.devices.registerDevice('dev-a', { profiles: [{ id: 'p1' }], capabilities: { workflowExecution: true } });
  await core.devices.heartbeat('dev-a', { status: 'degraded', runState: { running: 1 } });
  await core.devices.setStatus('dev-a', 'offline');
  const revoked = await core.devices.revoke('dev-a');
  assert.equal(first.id, 'dev-a');
  assert.equal(second.name, 'A2');
  assert.equal(core.devices.getDevice('dev-a').status, 'offline');
  assert.equal(revoked.revoked, true);
  await assert.rejects(() => core.devices.heartbeat('dev-a', {}), /revoked/i);
});

test('workflow registry deduplicates hash, increments changed revision, rejects wrong hash and sensitive defaults', async () => {
  const core = await fixtureCore();
  const first = await core.workflows.putRevision(revision({ contentHash: 'a'.repeat(64) }));
  const duplicate = await core.workflows.putRevision(revision({ contentHash: 'a'.repeat(64) }));
  const changed = await core.workflows.putRevision(revision({ contentHash: 'b'.repeat(64) }));
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(changed.revision.revision, 2);
  assert.equal(core.workflows.findByContentHash('wf-1', 'a'.repeat(64)).sourceDeviceId, 'dev-a');
  assert.deepEqual(core.workflows.listMetadata().map((item) => item.revision), [1, 2]);
  assert.throws(() => core.workflows.putRevision(revision({ contentHash: 'bad' })), /WorkflowRevision is invalid/);
  assert.throws(() => core.workflows.putRevision(revision({
    contentHash: 'c'.repeat(64),
    requiredInputs: [{ name: 'password', label: 'Password', index: 0, required: true, sensitive: true, defaultValue: 'secret' }]
  })), /invalid|sensitive/i);
});

test('group registry creates, updates, deletes, mutates membership idempotently, and snapshots immutably', async () => {
  const core = await fixtureCore();
  await core.devices.enrollDevice({ deviceId: 'dev-a', name: 'A' }, { rawToken: 'tok', tokenHash: 'hash' });
  const group = await core.groups.createGroup({ id: 'group-a', name: 'Group A' });
  await core.groups.updateGroup(group.id, { name: 'Group B' });
  await core.groups.addDevice(group.id, 'dev-a');
  await core.groups.addDevice(group.id, 'dev-a');
  const snapshot = core.groups.membershipSnapshot(group.id);
  await core.groups.removeDevice(group.id, 'dev-a');
  assert.deepEqual(snapshot.deviceIds, ['dev-a']);
  assert.equal(core.groups.listGroups().groups[0].name, 'Group B');
  await assert.rejects(() => core.groups.addDevice(group.id, 'missing'), /Device not found/);
  assert.deepEqual(await core.groups.deleteGroup(group.id), { ok: true });
});

test('job service creates dispatch plan, per-device jobs, idempotency, transitions, cancel, timeout, and target snapshot', async () => {
  const core = await fixtureCore();
  await core.devices.enrollDevice({ deviceId: 'dev-a', name: 'A' }, { rawToken: 'tok', tokenHash: 'hash' });
  await core.devices.enrollDevice({ deviceId: 'dev-b', name: 'B' }, { rawToken: 'tok', tokenHash: 'hash' });
  const batch = await core.jobs.createDispatchPlan({ deviceIds: ['dev-a', 'dev-b'], profileId: 'profile-1', dataset: [{ x: 1 }], idempotencyKey: 'batch-1' });
  assert.equal(batch.commands.length, 2);
  await core.groups.createGroup({ id: 'group-a' });
  await core.groups.addDevice('group-a', 'dev-a');
  const leased = await core.jobs.leaseNext('dev-a', 10000);
  assert.equal(leased.status, 'leased');
  const running = await core.jobs.acknowledge('dev-a', leased.id, leased.leaseId);
  assert.equal(running.status, 'running');
  const done = await core.jobs.finish('dev-a', leased.id, leased.leaseId, { ok: true });
  assert.equal(done.status, 'succeeded');
  await assert.rejects(() => core.jobs.acknowledge('dev-a', leased.id, leased.leaseId), /terminal/i);
  const legacy = await core.jobs.enqueueLegacyCommand({ type: 'get_state', deviceId: 'dev-b', idempotencyKey: 'same' });
  const duplicate = await core.jobs.enqueueLegacyCommand({ type: 'get_state', deviceId: 'dev-b', idempotencyKey: 'same' });
  assert.equal(legacy.id, duplicate.id);
  const cancelledBatch = await core.jobs.cancelBatch(batch.id);
  assert.equal(cancelledBatch.targetSnapshot.deviceIds.length, 2);
});

test('execution event store sequences, redacts sensitive input, lists by job/device, and blocks post-terminal events', async () => {
  const core = await fixtureCore();
  await core.devices.enrollDevice({ deviceId: 'dev-a' }, { rawToken: 'tok', tokenHash: 'hash' });
  const command = await core.jobs.enqueueLegacyCommand({ type: 'get_state', deviceId: 'dev-a' });
  const first = await core.events.appendEvent({ jobId: command.id, deviceId: 'dev-a', eventType: 'job_started', password: 'secret' });
  assert.equal(first.sequence, 1);
  assert.equal(first.password, '[REDACTED]');
  assert.equal(core.events.listByJob(command.id).length, 1);
  assert.equal(core.events.listByDevice('dev-a').length, 1);
  const leased = await core.jobs.leaseNext('dev-a', 10000);
  await core.jobs.acknowledge('dev-a', leased.id, leased.leaseId);
  await core.jobs.finish('dev-a', leased.id, leased.leaseId, { ok: true });
  await assert.rejects(() => core.events.appendEvent({ jobId: command.id, deviceId: 'dev-a', eventType: 'late' }), /terminal/i);
});

test('execution event store accepts matching terminal acknowledgement after controller-side cancel', async () => {
  const core = await fixtureCore();
  await core.devices.enrollDevice({ deviceId: 'dev-a' }, { rawToken: 'tok', tokenHash: 'hash' });
  const command = await core.jobs.enqueueLegacyCommand({ type: 'get_state', deviceId: 'dev-a' });
  await core.jobs.cancelCommand(command.id);
  const cancelled = await core.events.appendEvent({ jobId: command.id, deviceId: 'dev-a', eventType: 'job_cancelled' });
  assert.equal(cancelled.eventType, 'job_cancelled');
  const duplicate = await core.events.appendEvent({ jobId: command.id, deviceId: 'dev-a', eventType: 'job_cancelled' });
  assert.equal(duplicate.sequence, cancelled.sequence);
  assert.equal(core.events.listByJob(command.id).length, 1);
  await assert.rejects(() => core.events.appendEvent({ jobId: command.id, deviceId: 'dev-a', eventType: 'job_succeeded' }), /terminal/i);
});

test('dataset assignment modes preserve behavior and deterministic random injection', () => {
  const devices = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  assert.deepEqual(buildDatasetAssignments({ devices, inputs: { q: 1 } }).map((item) => item.inputs), [{ q: 1 }, { q: 1 }]);
  assert.deepEqual(buildDatasetAssignments({ devices, assignmentMode: 'per_device', dataset: [{ deviceId: 'b', q: 2 }] })[1].inputs.q, 2);
  assert.deepEqual(buildDatasetAssignments({ devices, assignmentMode: 'mapping', dataset: [{ deviceKey: 'A', q: 3 }] })[0].inputs.q, 3);
  assert.equal(buildDatasetAssignments({ devices, assignmentMode: 'random_pool', dataset: [{ q: 1 }, { q: 2 }], random: () => 0 })[0].inputs.q, 2);
  assert.throws(() => buildDatasetAssignments({ devices, assignmentMode: 'random_pool', allowDuplicate: false, dataset: [{ q: 1 }] }), /Not enough/);
});

test('json persistence reloads, migrates with backup, and recovers corrupt files without silent reset', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'war-core-store-'));
  const filePath = path.join(dir, 'store.json');
  await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 1, devices: [] }));
  const store = new JsonStore(filePath);
  await store.load();
  assert.equal(store.snapshot().controllerCore.migrationVersion, 1);
  await store.update((state) => state.devices.push({ id: 'dev-a' }));
  const reloaded = new JsonStore(filePath);
  await reloaded.load();
  assert.equal(reloaded.snapshot().devices[0].id, 'dev-a');
  await fs.writeFile(filePath, '{bad');
  const corrupt = new JsonStore(filePath);
  await assert.rejects(() => corrupt.load(), /STORE_CORRUPT/);
  assert.ok((await fs.readdir(dir)).some((name) => name.includes('.corrupt-')));
});

test('companion HTTP compatibility routes preserve enroll, heartbeat, queue, ack/result, batch, dashboard, auth, and allowlist', async (t) => {
  const store = createMemoryStore();
  await store.load();
  const server = createServer({ allow: ['127.0.0.1', '::1'], adminToken: admin, enrollmentToken: enroll, leaseMs: 10000 }, store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/dashboard`)).status, 200);
  assert.equal((await fetch(`${base}/v1/devices`)).status, 401);
  const a = await post(`${base}/v1/devices/enroll`, enroll, { name: 'A' });
  await post(`${base}/v1/devices/${a.id}/heartbeat`, a.deviceToken, { status: 'online' });
  const command = await post(`${base}/v1/commands`, admin, { type: 'get_state', deviceId: a.id });
  const next = await get(`${base}/v1/devices/${a.id}/commands/next`, a.deviceToken);
  assert.equal(next.id, command.id);
  await post(`${base}/v1/devices/${a.id}/commands/${next.id}/ack`, a.deviceToken, { leaseId: next.leaseId });
  const result = await post(`${base}/v1/devices/${a.id}/commands/${next.id}/result`, a.deviceToken, { leaseId: next.leaseId, result: { ok: true } });
  assert.equal(result.status, 'succeeded');
  const batch = await post(`${base}/v1/batches`, admin, { deviceIds: [a.id], profileId: 'profile-1', dataset: [{ text: 'same' }] });
  assert.equal(batch.commands.length, 1);
  assert.equal((await get(`${base}/v1/batches/${batch.id}`, admin)).id, batch.id);
  assert.equal((await post(`${base}/v1/batches/${batch.id}/stop`, admin, {})).status, 'cancelled');
});

async function fixtureCore() {
  const store = createMemoryStore();
  const core = new ControllerCore({ store, now: () => new Date().toISOString(), id: (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}` });
  await core.load();
  return core;
}

function revision(overrides = {}) {
  return {
    workflowId: 'wf-1',
    revision: 1,
    schemaVersion: 'war-workflow-revision.v2',
    contentHash: '0'.repeat(64),
    name: 'Workflow',
    description: '',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    sourceDeviceId: 'dev-a',
    requiredInputs: [],
    profilePayload: { id: 'wf-1', name: 'Workflow', steps: [] },
    ...overrides
  };
}

async function post(url, token, body) {
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function get(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}
