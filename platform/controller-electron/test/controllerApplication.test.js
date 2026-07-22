import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerCore, hashSecret } from '../../controller-core/src/controllerCore.js';
import { createMemoryStore } from '../../../companion/store.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';
import { ControllerApplicationService, DISPATCH_DEADLINE_SECONDS } from '../src/controllerApplication.js';
import { createWorkflowContentHash } from '../../workflow-core/src/workflowMetadata.js';

test('application dispatch persists a command and delivers it through WSS without leaking main-owned fields', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision({ requiredInputs: [{ name: 'url', index: 0, required: true, sensitive: false, type: 'string' }] }));
  const transport = fakeTransport();
  const app = application(core, transport);
  const result = await app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: { url: 'https://example.test' }, deadlineSeconds: 60 });
  assert.equal(result.ok, true);
  assert.equal(result.data.transport.delivered, true);
  assert.equal(result.data.job.deviceId, 'dev-a');
  assert.equal(Object.hasOwn(result.data.job, 'inputs'), false);
  assert.equal(Object.hasOwn(result.data.job, 'leaseId'), false);
  assert.equal(Object.hasOwn(result.data.job, 'dispatchMetadata'), false);
  assert.equal(transport.dispatches.length, 1);
  assert.equal(core.store.snapshot().commands.length, 1);
});

test('application dispatch validates workflow inputs and deadline bounds', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision({
    requiredInputs: [
      { name: 'url', index: 0, required: true, sensitive: false, type: 'string' },
      { name: 'count', index: 1, required: false, sensitive: false, type: 'integer' },
    ]
  }));
  const app = application(core, fakeTransport());
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: {} }), code('MISSING_WORKFLOW_INPUT'));
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: { url: 'x', extra: true } }), code('UNKNOWN_WORKFLOW_INPUT'));
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: { url: 'x', count: 1.5 } }), code('WORKFLOW_INPUT_TYPE_MISMATCH'));
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: { url: 'x' }, deadlineSeconds: DISPATCH_DEADLINE_SECONDS.min - 1 }), code('DEADLINE_SECONDS_OUT_OF_RANGE'));
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: { url: 'x' }, deadlineSeconds: DISPATCH_DEADLINE_SECONDS.max + 1 }), code('DEADLINE_SECONDS_OUT_OF_RANGE'));
});

test('application dispatch rejects dangerous, sensitive, oversized, offline, revoked, and missing targets', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision());
  const app = application(core, fakeTransport());
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: JSON.parse('{"__proto__":{"polluted":true}}') }), code('DANGEROUS_WORKFLOW_INPUT'));
  await core.workflows.putRevision(revision({ workflowId: 'wf-sensitive', contentHash: 'b'.repeat(64), requiredInputs: [{ name: 'secret', index: 0, required: true, sensitive: true }] }));
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-sensitive', revision: 1, inputs: { secret: 'x' } }), code('SENSITIVE_INPUT_UNSUPPORTED'));
  await core.workflows.putRevision(revision({ workflowId: 'wf-large', contentHash: 'c'.repeat(64), requiredInputs: [{ name: 'value', index: 0, required: false, sensitive: false }] }));
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-large', revision: 1, inputs: { value: 'x'.repeat(70 * 1024) } }), code('WORKFLOW_INPUT_TOO_LARGE'));
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'missing', workflowId: 'wf-1', revision: 1, inputs: {} }), code('DEVICE_NOT_FOUND'));
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'missing', revision: 1, inputs: {} }), code('WORKFLOW_NOT_FOUND'));
  await core.devices.revoke('dev-a');
  await assert.rejects(() => app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: {} }), code('DEVICE_REVOKED'));
});

test('transport failure preserves persisted dispatch for reconnect replay without duplicate command', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision());
  const transport = fakeTransport({ failDispatch: true });
  const app = application(core, transport);
  const result = await app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: {} });
  assert.equal(result.data.transport.delivered, false);
  assert.equal(result.data.transport.warningCode, 'WSS_SEND_FAILED');
  const commands = core.store.snapshot().commands;
  assert.equal(commands.length, 1);
  assert.equal(commands[0].status, 'leased');
  assert.equal((await core.sessions.replayNonTerminal('dev-a', 1))[0].jobId, commands[0].id);
});

test('application runtime status reports the actual bound WSS port', async () => {
  const core = await connectedCore();
  const app = new ControllerApplicationService({
    core,
    wssRuntime: { server: { address: () => ({ port: 49152 }) }, adapter: {} },
    config: {
      dataPath: 'data',
      degraded: false,
      errors: [],
      wss: { enabled: true, requested: true, status: 'enabled', host: '127.0.0.1', port: 0, tls: {} }
    }
  });
  const status = app.getRuntimeStatus().data;
  assert.equal(status.enabled, true);
  assert.equal(status.status, 'running');
  assert.equal(status.port, 49152);
});

test('application exposes only a probed configured Docker host and owns container defaults', async () => {
  const core = await connectedCore();
  const adapter = fakeContainerAdapter();
  const config = managedRuntimeConfig();
  const app = new ControllerApplicationService({ core, containerAdapter: adapter, config, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });

  const hosts = await app.listContainerHosts();
  assert.deepEqual(hosts.data, {
    status: 'connected',
    hosts: [{ id: 'configured-docker-host', label: 'Reviewed Linux host', runtime: 'ssh-docker', connected: true }],
  });

  const added = await app.addContainer({ name: 'Agent One', host: 'configured-docker-host', runtime: { ipv4Enabled: true } });
  assert.equal(added.data.container.host, 'configured-docker-host');
  assert.equal(added.data.container.image, 'war-browser-agent:reviewed');
  assert.match(added.data.container.runtime.dockerName, /^war-Agent-One-[0-9a-f]{8}$/);
  await assert.rejects(
    () => app.addContainer({ name: 'Wrong Host', host: 'renderer-selected-host' }),
    (error) => error.code === 'INVALID_CONTAINER_HOST',
  );
});

test('application re-probes the selected Docker host before provisioning a container', async () => {
  const core = await connectedCore();
  const adapter = fakeContainerAdapter();
  adapter.probe = async () => { throw new Error('host offline'); };
  const app = new ControllerApplicationService({ core, containerAdapter: adapter, config: managedRuntimeConfig(), now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });

  await assert.rejects(
    () => app.addContainer({ name: 'Agent Offline', host: 'configured-docker-host' }),
    (error) => error.code === 'CONTAINER_HOST_UNAVAILABLE',
  );
  assert.deepEqual(core.containers.listContainers().containers, []);
});

test('application manages container lifecycle through a bounded adapter', async () => {
  const core = await connectedCore();
  const adapter = fakeContainerAdapter();
  const app = new ControllerApplicationService({ core, containerAdapter: adapter, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });

  const added = await app.addContainer({ name: 'Agent One', image: 'war-browser-agent:test', runtime: { dockerName: 'agent-one' } });
  const containerId = added.data.container.id;
  await app.startContainer({ containerId });
  await app.refreshContainer({ containerId });
  await app.restartContainer({ containerId });
  await app.stopContainer({ containerId });
  const network = await app.updateContainerNetwork({ containerId, ipv4Enabled: true, ipv6Enabled: true, ipv6Suffix: 'a8bb:ccff:fedd:eeff' });
  const duplicate = await app.duplicateContainer({ containerId, name: 'Agent Two' });
  const managedDeviceId = added.data.container.deviceId;
  const trashed = await app.deleteContainer({ containerId });

  assert.equal(added.data.operation.ok, true);
  assert.equal(core.containers.getContainer(containerId).status, 'deleted');
  assert.equal(core.pairing.listPairedAgents().find((item) => item.deviceId === managedDeviceId)?.revokedAt || null, null);
  assert.equal(Boolean(core.devices.getDevice(managedDeviceId).revoked), false);
  assert.equal(duplicate.data.container.name, 'Agent Two');
  assert.equal(duplicate.data.operation.ok, true);
  assert.notEqual(duplicate.data.container.runtime.dockerName, added.data.container.runtime.dockerName);
  assert.equal(network.data.container.runtime.ipv6Address, '2001:db8:1:2:a8bb:ccff:fedd:eeff');
  assert.notEqual(duplicate.data.container.runtime.ipv6Suffix, network.data.container.runtime.ipv6Suffix);
  assert.match(duplicate.data.container.runtime.ipv6Suffix, /^[0-9a-f]{1,4}:[0-9a-f]{1,2}ff:fe[0-9a-f]{1,2}:[0-9a-f]{1,4}$/);
  assert.equal(trashed.data.operation.ok, true);
  const restored = await app.restoreContainer({ containerId });
  assert.equal(restored.data.container.status, 'stopped');
  await app.deleteContainer({ containerId });
  const purged = await app.purgeContainer({ containerId });
  assert.equal(purged.data.purged.id, containerId);
  assert.ok(core.pairing.listPairedAgents().find((item) => item.deviceId === managedDeviceId)?.revokedAt);
  assert.equal(core.devices.getDevice(managedDeviceId).revoked, true);
  assert.deepEqual(adapter.calls.map((item) => item.action), ['create', 'start', 'status', 'restart', 'stop', 'updateNetwork', 'create', 'delete']);
});

test('trashing an already-revoked failed managed container remains recoverable', async () => {
  const core = await connectedCore();
  const adapter = fakeContainerAdapter();
  adapter.create = async function create(container) {
    this.calls.push({ action: 'create', id: container.id });
    throw new Error('create failed');
  };
  const app = new ControllerApplicationService({ core, containerAdapter: adapter, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });
  const added = await app.addContainer({ name: 'Failed Agent', image: 'war-browser-agent:test', runtime: { dockerName: 'failed-agent' } });

  const deleted = await app.deleteContainer({ containerId: added.data.container.id });

  assert.equal(deleted.data.container.status, 'deleted');
  assert.deepEqual(adapter.calls.map((item) => item.action), ['create']);
  const restored = await app.restoreContainer({ containerId: added.data.container.id });
  assert.equal(restored.data.container.status, 'failed');
});

test('managed container permanent deletion failure keeps the item in trash', async () => {
  const core = await connectedCore();
  const adapter = fakeContainerAdapter();
  adapter.delete = async function deleteContainer(container) {
    this.calls.push({ action: 'delete', id: container.id });
    throw new Error('runtime cleanup failed');
  };
  const app = new ControllerApplicationService({ core, containerAdapter: adapter, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });
  const added = await app.addContainer({ name: 'Agent One', image: 'war-browser-agent:test', runtime: { dockerName: 'agent-one' } });
  const managedDeviceId = added.data.container.deviceId;

  await app.deleteContainer({ containerId: added.data.container.id });
  const deleted = await app.purgeContainer({ containerId: added.data.container.id });

  assert.equal(deleted.data.operation.ok, false);
  assert.equal(deleted.data.container.status, 'deleted');
  assert.equal(deleted.data.container.desiredState, 'deleted');
  assert.ok(core.pairing.listPairedAgents().find((item) => item.deviceId === managedDeviceId)?.revokedAt);
  assert.equal(core.devices.getDevice(managedDeviceId).revoked, true);
});

test('failed container without a proven runtime can be purged locally from trash', async () => {
  const core = await connectedCore();
  const app = new ControllerApplicationService({ core, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });
  const added = await app.addContainer({ name: 'Never Provisioned', image: 'war-browser-agent:test', runtime: { dockerName: 'never-provisioned' } });

  assert.equal(added.data.container.status, 'failed');
  const trashed = await app.deleteContainer({ containerId: added.data.container.id });
  const deleted = await app.purgeContainer({ containerId: added.data.container.id });

  assert.equal(trashed.data.operation.ok, true);
  assert.equal(deleted.data.operation.localOnly, true);
  assert.equal(deleted.data.container, null);
});

test('application blocks trashing a Linux host until its active containers are trashed', async () => {
  const core = await connectedCore();
  const container = await core.containers.createContainer({ name: 'Agent One', host: 'ssh-host-1' });
  const hostCalls = [];
  const containerHostManager = {
    listTrashedHosts: () => ({ hosts: [{ id: 'ssh-trash', name: 'Old Linux' }] }),
    trashHost: async (hostId) => { hostCalls.push(hostId); return { id: hostId, name: 'Linux' }; },
  };
  const app = new ControllerApplicationService({ core, containerHostManager, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });

  assert.equal(app.listContainerTrash().data.hosts.length, 1);
  await assert.rejects(() => app.trashContainerHost({ hostId: 'ssh-host-1' }), (error) => error.code === 'CONTAINER_HOST_IN_USE');
  assert.equal(hostCalls.length, 0);
  await core.containers.deleteContainer(container.id);
  const trashed = await app.trashContainerHost({ hostId: 'ssh-host-1' });
  assert.equal(trashed.data.id, 'ssh-host-1');
  assert.deepEqual(hostCalls, ['ssh-host-1']);
});

test('application updates a selected Linux host through the bounded manager', async () => {
  const core = await connectedCore();
  const calls = [];
  const containerHostManager = {
    updateHost: async (hostId, payload) => {
      calls.push({ hostId, payload });
      return { id: hostId, name: payload.name, target: payload.target, connected: true };
    },
  };
  const app = new ControllerApplicationService({ core, containerHostManager });

  const result = await app.updateContainerHost({ hostId: 'ssh-host-1', name: 'Linux mới', target: 'root@192.168.1.202' });

  assert.equal(result.data.id, 'ssh-host-1');
  assert.deepEqual(calls, [{ hostId: 'ssh-host-1', payload: { name: 'Linux mới', target: 'root@192.168.1.202' } }]);
});

test('application cancel uses controller-side state and reports transport separately without acknowledgement', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision());
  const transport = fakeTransport();
  const app = application(core, transport);
  const dispatch = await app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: {} });
  const first = await app.cancelJob({ jobId: dispatch.data.job.id });
  const second = await app.cancelJob({ jobId: dispatch.data.job.id });
  assert.equal(first.data.job.status, 'cancelled');
  assert.equal(second.data.job.status, 'cancelled');
  assert.deepEqual(first.data.transport, { delivered: true, acknowledged: false });
  assert.equal(transport.cancels.length, 2);
});

test('application revoke closes the active session and rejects the revoked credential', async () => {
  const closed = [];
  const core = await connectedCore();
  const session = core.sessions.getPublicSession('dev-a');
  core.sessions.attachClose('dev-a', session.generation, (reason) => closed.push(reason));
  const app = application(core, fakeTransport());

  const revoked = await app.revokeAgent({ deviceId: 'dev-a' });

  assert.equal(revoked.ok, true);
  assert.equal(core.devices.getDevice('dev-a').revoked, true);
  assert.equal(core.devices.getDevice('dev-a').status, 'offline');
  assert.equal(core.sessions.getPublicSession('dev-a').status, 'offline');
  assert.equal(closed[0].code, 'revoked');
  await assert.rejects(() => core.sessions.authenticateHello(agentHello(), { credential: 'cred-a' }), code('AUTH_DENIED'));
});

test('application reconnect closes the current Agent session without rotating its credential', async () => {
  const closed = [];
  const core = await connectedCore();
  const session = core.sessions.getPublicSession('dev-a');
  core.sessions.attachClose('dev-a', session.generation, (reason) => closed.push(reason));
  const app = application(core, fakeTransport());

  const reconnect = await app.reconnectAgent({ deviceId: 'dev-a' });

  assert.equal(reconnect.data.status, 'reconnecting');
  assert.equal(closed[0].code, 'reconnect');
  assert.notEqual(core.devices.getDevice('dev-a').revoked, true);
  const next = await core.sessions.authenticateHello(agentHello(), { credential: 'cred-a' });
  assert.equal(next.generation, session.generation + 1);
});

test('application diagnostics report WSS and Agent state and reload existing TLS material', async () => {
  const core = await connectedCore();
  const reads = [];
  const secureContexts = [];
  const config = managedRuntimeConfig();
  config.wss.tls = { certPath: 'C:/tls/controller.crt', keyPath: 'C:/tls/controller.key' };
  const app = new ControllerApplicationService({
    core,
    config,
    wssRuntime: {
      server: {
        address: () => ({ port: 47651 }),
        setSecureContext: (value) => secureContexts.push(value),
      },
    },
    fs: { promises: { readFile: async (file) => { reads.push(file); return Buffer.from('existing-tls-material'); } } },
    now: () => '2026-07-16T00:00:00.000Z',
  });

  const diagnostics = await app.getDiagnostics();
  const repaired = await app.repairDiagnostics({ targetId: 'wss' });

  assert.ok(diagnostics.data.checks.some((item) => item.code === 'WSS_READY'));
  assert.ok(diagnostics.data.checks.some((item) => item.code === 'AGENT_ONLINE'));
  assert.deepEqual(reads, ['C:/tls/controller.crt', 'C:/tls/controller.key']);
  assert.equal(secureContexts.length, 1);
  assert.equal(repaired.data.failures.length, 0);
  assert.equal(repaired.data.repairs[0].refreshed, true);
});

test('application previews origin inventory with conflict and duplicate decisions', async () => {
  const core = await connectedCore();
  const localRevision = revision();
  await core.workflows.putRevision(localRevision);
  const transport = fakeTransport({
    originInventory: {
      workflows: [
        { workflowId: 'wf-1', revision: 1, contentHash: localRevision.contentHash, name: 'Same', updatedAt: '2026-07-16T00:00:00.000Z' },
        { workflowId: 'wf-1', revision: 2, contentHash: 'b'.repeat(64), name: 'Conflict', updatedAt: '2026-07-16T00:00:00.000Z' },
        { workflowId: 'wf-new', revision: 1, contentHash: 'c'.repeat(64), name: 'New', updatedAt: '2026-07-16T00:00:00.000Z' },
        { workflowId: 'wf-bad', revision: 1, contentHash: 'not-a-hash', name: 'Bad' }
      ]
    }
  });
  const preview = await application(core, transport).previewOriginSync({ deviceId: 'dev-a' });
  assert.equal(preview.data.counts.workflows, 3);
  assert.deepEqual(preview.data.workflows.map((item) => item.action), ['skipIdentical', 'preserveBoth', 'importNew']);
  assert.equal(preview.data.workflows[1].conflict, true);
});

test('application pulls origin workflows through WSS, strips secret-like fields, skips conflicts, and audits result', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision());
  const originWorkflow = revision({
    workflowId: 'wf-origin',
    contentHash: 'd'.repeat(64),
    name: 'Origin',
    sourceDeviceId: 'dev-a',
    profilePayload: { id: 'wf-origin', steps: [], credential: 'must-not-persist', nested: { token: 'must-not-persist', keep: true } }
  });
  const transport = fakeTransport({
    originInventory: {
      workflows: [
        { workflowId: 'wf-1', revision: 2, contentHash: 'b'.repeat(64), name: 'Conflict', updatedAt: '2026-07-16T00:00:00.000Z' },
        { workflowId: 'wf-origin', revision: 1, contentHash: originWorkflow.contentHash, name: 'Origin', updatedAt: '2026-07-16T00:00:00.000Z' }
      ]
    },
    originWorkflows: { 'wf-origin:1': originWorkflow }
  });
  const result = await application(core, transport).pullOriginSync({ deviceId: 'dev-a', conflictPolicy: 'skip' });
  const stored = core.workflows.getRevision('wf-origin', 1);
  const snapshot = core.store.snapshot();

  assert.equal(result.data.imported.length, 1);
  assert.equal(result.data.skipped[0].workflowId, 'wf-1');
  assert.equal(stored.profilePayload.nested.keep, true);
  assert.equal(Object.hasOwn(stored.profilePayload, 'credential'), false);
  assert.equal(Object.hasOwn(stored.profilePayload.nested, 'token'), false);
  assert.equal(stored.contentHash, createWorkflowContentHash(stored));
  assert.notEqual(stored.contentHash, originWorkflow.contentHash);
  assert.equal(snapshot.originSyncResults.length, 1);
  assert.equal(snapshot.auditEvents.at(-1).type, 'origin.sync.completed');
});

test('application previews and dispatches grouped input through the same deterministic mapping', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision({
    requiredInputs: [
      { name: 'url', index: 0, required: true, sensitive: false, type: 'string' },
      { name: 'count', index: 1, required: false, sensitive: false, type: 'integer' },
    ]
  }));
  const transport = fakeTransport();
  const app = application(core, transport);

  const preview = await app.previewGroupedInput({
    workflowId: 'wf-1',
    revision: 1,
    deviceIds: ['dev-a'],
    text: 'https://example.test|3',
    mode: 'table',
    deadlineSeconds: 60,
  });
  const dispatched = await app.dispatchGroupedInput({
    workflowId: 'wf-1',
    revision: 1,
    deviceIds: ['dev-a'],
    text: 'https://example.test|3',
    mode: 'cell',
    deadlineSeconds: 60,
  });

  assert.deepEqual(preview.data.assignments[0].inputs, { url: 'https://example.test', count: 3 });
  assert.equal(dispatched.data.dispatched.length, 1);
  assert.equal(transport.dispatches.length, 1);
  assert.equal(core.store.snapshot().commands.length, 1);
});

test('application grouped input reports parser, row, mode, and size errors before dispatch', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision({ requiredInputs: [{ name: 'url', index: 0, required: true, sensitive: false, type: 'string' }] }));
  const app = application(core, fakeTransport());
  assert.throws(() => app.previewGroupedInput({ workflowId: 'wf-1', revision: 1, deviceIds: ['dev-a'], text: '"unterminated', mode: 'text' }), code('UNCLOSED_QUOTE'));
  assert.throws(() => app.previewGroupedInput({ workflowId: 'wf-1', revision: 1, deviceIds: ['dev-a'], text: 'x', mode: 'unknown' }), code('INVALID_GROUPED_INPUT_MODE'));
  assert.throws(() => app.previewGroupedInput({ workflowId: 'wf-1', revision: 1, deviceIds: ['dev-a'], text: 'x'.repeat(70 * 1024), mode: 'text' }), code('GROUPED_INPUT_TOO_LARGE'));
  assert.throws(() => app.previewGroupedInput({ workflowId: 'wf-1', revision: 1, deviceIds: ['dev-a'], text: 'x|extra', mode: 'text' }), code('EXTRA_FIELD'));
  assert.throws(() => app.previewGroupedInput({ workflowId: 'wf-1', revision: 1, deviceIds: ['dev-a', 'dev-a'], text: 'x', mode: 'text' }), code('DUPLICATE_GROUPED_DEVICE'));
  assert.equal(core.store.snapshot().commands.length, 0);
});

test('grouped input preserves every job when one transport delivery fails so Controller replay can recover it', async () => {
  const core = await connectedCore();
  await pairSecondDevice(core);
  await core.workflows.putRevision(revision({ requiredInputs: [{ name: 'url', index: 0, required: true, sensitive: false, type: 'string' }] }));
  const transport = fakeTransport({ failDispatchDeviceId: 'dev-b' });
  const result = await application(core, transport).dispatchGroupedInput({
    workflowId: 'wf-1',
    revision: 1,
    deviceIds: ['dev-a', 'dev-b'],
    text: 'https://a.test\nhttps://b.test',
    mode: 'table',
  });

  assert.equal(result.data.dispatched.length, 2);
  assert.deepEqual(result.data.dispatched.map((item) => item.transport.delivered), [true, false]);
  assert.equal(result.data.dispatched[1].transport.warningCode, 'WSS_SEND_FAILED');
  assert.equal(core.store.snapshot().commands.length, 2);
  assert.deepEqual(core.store.snapshot().commands.map((item) => item.deviceId).sort(), ['dev-a', 'dev-b']);
});

test('application grouped input broadcasts one row to multiple devices', async () => {
  const core = await connectedCore();
  await pairSecondDevice(core);
  await core.workflows.putRevision(revision({ requiredInputs: [{ name: 'url', index: 0, required: true, sensitive: false, type: 'string' }] }));
  const preview = await application(core, fakeTransport()).previewGroupedInput({
    workflowId: 'wf-1',
    revision: 1,
    deviceIds: ['dev-a', 'dev-b'],
    text: 'https://example.test',
    mode: 'text',
  });
  assert.deepEqual(preview.data.assignments.map((item) => item.deviceId), ['dev-a', 'dev-b']);
  assert.deepEqual(preview.data.assignments.map((item) => item.inputs.url), ['https://example.test', 'https://example.test']);
});

test('application graph backend loads, previews, saves a new revision, and preserves previous revision', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision({
    profilePayload: {
      id: 'wf-1',
      name: 'Workflow',
      enabled: true,
      steps: [{ id: 'a', name: 'A', type: 'log', message: 'start' }]
    }
  }));
  const app = application(core, fakeTransport());
  const loaded = app.getWorkflowGraph({ workflowId: 'wf-1', revision: 1 });
  const preview = app.previewWorkflowGraph({
    workflowId: 'wf-1',
    revision: 1,
    operations: [
      { type: 'addNode', node: { id: 'b', name: 'B', type: 'log', message: 'done' } },
      { type: 'addEdge', from: 'a', to: 'b', fromPort: 'out' }
    ]
  });
  const saved = await app.saveWorkflowGraph({
    workflowId: 'wf-1',
    revision: 1,
    operations: [
      { type: 'addNode', node: { id: 'b', name: 'B', type: 'log', message: 'done' } },
      { type: 'addEdge', from: 'a', to: 'b', fromPort: 'out' }
    ]
  });

  assert.equal(loaded.data.validation.ok, true);
  assert.deepEqual(preview.data.executionPlan, ['a', 'b']);
  assert.equal(saved.data.saved.revision.revision, 2);
  assert.deepEqual(core.workflows.getRevision('wf-1', 1).profilePayload.steps.map((step) => step.id), ['a']);
  assert.deepEqual(core.workflows.getRevision('wf-1', 2).profilePayload.steps.map((step) => step.id), ['a', 'b']);
});

test('application graph backend rejects unsafe node types and dangling edges', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision());
  const app = application(core, fakeTransport());
  await assert.rejects(() => app.saveWorkflowGraph({
    workflowId: 'wf-1',
    revision: 1,
    operations: [{ type: 'addNode', node: { id: 'bad', type: 'javascript', name: 'Bad' } }]
  }), /Loại bước không được hỗ trợ|Unsupported step type/);
  assert.throws(() => app.previewWorkflowGraph({
    workflowId: 'wf-1',
    revision: 1,
    operations: [{ type: 'addEdge', from: 'missing', to: 'also-missing' }]
  }), code('WORKFLOW_GRAPH_NODE_NOT_FOUND'));
});

test('offline cancel keeps controller-side cancellation and returns an offline transport warning', async () => {
  const core = await connectedCore();
  await core.workflows.putRevision(revision());
  const app = application(core, fakeTransport({ failDispatch: true }));
  const dispatch = await app.dispatchWorkflow({ deviceId: 'dev-a', workflowId: 'wf-1', revision: 1, inputs: {} });
  core.sessions.shutdown();
  const cancelled = await app.cancelJob({ jobId: dispatch.data.job.id });
  assert.equal(cancelled.data.job.status, 'cancelled');
  assert.equal(cancelled.data.transport.delivered, false);
  assert.equal(cancelled.data.transport.acknowledged, false);
  assert.equal(cancelled.data.transport.warningCode, 'SESSION_OFFLINE');
});

test('application fans synchronized remote input to selected online Agents and captures a bounded frame', async () => {
  const core = await connectedCore();
  await pairSecondDevice(core);
  const transport = fakeTransport();
  const app = application(core, transport);

  const control = await app.remoteControl({ deviceIds: ['dev-a', 'dev-b'], command: 'input.shortcut', payload: { keys: 'CTRL+T' }, synchronized: true });
  assert.equal(control.data.targets.every((item) => item.ok), true);
  assert.equal(transport.remoteRequests.length, 2);
  assert.equal(transport.remoteRequests[0].payload.syncAt, transport.remoteRequests[1].payload.syncAt);

  const capture = await app.remoteCapture({ deviceId: 'dev-a', quality: 45 });
  assert.equal(capture.data.frame.mimeType, 'image/jpeg');
  assert.equal(capture.data.frame.width, 800);
});

function application(core, transport) {
  return new ControllerApplicationService({
    core,
    wssTransport: transport,
    now: () => '2026-07-16T00:00:00.000Z',
    id: sequenceId()
  });
}

function fakeTransport({ failDispatch = false, failDispatchDeviceId = null, failCancel = false, originInventory = { workflows: [] }, originWorkflows = {} } = {}) {
  return {
    dispatches: [],
    cancels: [],
    originInventoryRequests: [],
    originWorkflowRequests: [],
    remoteRequests: [],
    sendDispatch(deviceId, generation, dispatch) {
      if (failDispatch || deviceId === failDispatchDeviceId) throw Object.assign(new Error('send failed'), { code: 'WSS_SEND_FAILED' });
      this.dispatches.push({ deviceId, generation, dispatch });
      return { delivered: true, deviceId, generation };
    },
    sendCancel(deviceId, generation, cancel) {
      if (failCancel) throw Object.assign(new Error('send failed'), { code: 'WSS_SEND_FAILED' });
      this.cancels.push({ deviceId, generation, cancel });
      return { delivered: true, deviceId, generation };
    },
    async requestOriginInventory(deviceId, generation, payload) {
      this.originInventoryRequests.push({ deviceId, generation, payload });
      return { payload: structuredClone(originInventory) };
    },
    async requestOriginWorkflow(deviceId, generation, payload) {
      this.originWorkflowRequests.push({ deviceId, generation, payload });
      const workflow = originWorkflows[`${payload.workflowId}:${payload.revision}`];
      return workflow ? { payload: { workflow: structuredClone(workflow) } } : { payload: { error: { code: 'WORKFLOW_NOT_FOUND', message: 'missing' } } };
    },
    async requestRemoteControl(deviceId, generation, payload) {
      this.remoteRequests.push({ deviceId, generation, payload: structuredClone(payload) });
      if (payload.command === 'remote.capture') {
        return { payload: { ok: true, frame: { mimeType: 'image/jpeg', encoding: 'base64', data: 'YQ==', width: 800, height: 600, sequence: 1 } } };
      }
      return { payload: { ok: true, result: { executed: true } } };
    }
  };
}

function fakeContainerAdapter() {
  return {
    calls: [],
    async probe() { this.calls.push({ action: 'probe' }); return { connected: true }; },
    async create(container) { this.calls.push({ action: 'create', id: container.id, container: structuredClone(container) }); return { runtime: { ...container.runtime, dockerName: container.runtime.dockerName || container.id, privileged: false } }; },
    async start(container) { this.calls.push({ action: 'start', id: container.id }); return {}; },
    async stop(container) { this.calls.push({ action: 'stop', id: container.id }); return {}; },
    async restart(container) { this.calls.push({ action: 'restart', id: container.id }); return {}; },
    async status(container) { this.calls.push({ action: 'status', id: container.id }); return { status: 'running', resourceUsage: { cpuPercent: 2, memoryBytes: 1024 } }; },
    async updateNetwork(container) {
      this.calls.push({ action: 'updateNetwork', id: container.id });
      return {
        status: container.status,
        runtime: {
          ...container.runtime,
          ipv6Prefix: '2001:db8:1:2::/64',
          ipv6Address: `2001:db8:1:2:${container.runtime.ipv6Suffix}`,
          ipv6Network: 'war-managed-ipv6-123456789abc',
        },
      };
    },
    async delete(container) { this.calls.push({ action: 'delete', id: container.id }); return {}; },
  };
}

function managedRuntimeConfig() {
  return {
    dataPath: 'data',
    degraded: false,
    errors: [],
    wss: { enabled: true, requested: true, status: 'enabled', host: '127.0.0.1', port: 47651, tls: {} },
    containers: {
      enabled: true,
      runtime: 'ssh-docker',
      hostId: 'configured-docker-host',
      hostDisplayName: 'Reviewed Linux host',
      hostLabel: 'ssh-docker',
      image: 'war-browser-agent:reviewed',
    },
  };
}

async function connectedCore() {
  const core = new ControllerCore({ store: createMemoryStore(), now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });
  await core.load();
  await core.pairing.requestPairing({ device: device(), requestId: 'pair-a' });
  await core.store.update((state) => {
    state.pendingPairings[0].tokenHash = hashSecret('code-a');
  });
  await core.pairing.confirmPairing('pair-a', 'code-a');
  await core.store.update((state) => {
    state.pairedAgents[0].credentialHash = hashSecret('cred-a');
  });
  await core.sessions.authenticateHello(agentHello(), { credential: 'cred-a' });
  return core;
}

function revision(overrides = {}) {
  const value = {
    workflowId: 'wf-1',
    revision: 1,
    schemaVersion: 'war-workflow-revision.v2',
    contentHash: '',
    name: 'Workflow',
    description: '',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    sourceDeviceId: 'dev-a',
    requiredInputs: [],
    profilePayload: { id: 'wf-1', steps: [] },
    ...overrides
  };
  value.contentHash = createWorkflowContentHash(value);
  return value;
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

async function pairSecondDevice(core) {
  await core.pairing.requestPairing({ device: device({ deviceId: 'dev-b', displayName: 'Agent B' }), requestId: 'pair-b' });
  await core.store.update((state) => {
    state.pendingPairings.find((item) => item.requestId === 'pair-b').tokenHash = hashSecret('code-b');
  });
  await core.pairing.confirmPairing('pair-b', 'code-b');
  await core.store.update((state) => {
    state.pairedAgents.find((item) => item.deviceId === 'dev-b').credentialHash = hashSecret('cred-b');
  });
  await core.sessions.authenticateHello(agentHelloFor('dev-b'), { credential: 'cred-b' });
}

function agentHelloFor(deviceId) {
  return {
    ...agentHello(),
    messageId: `hello-${deviceId}`,
    deviceId,
    payload: {
      ...agentHello().payload,
      device: device({ deviceId, displayName: deviceId === 'dev-b' ? 'Agent B' : 'Agent A' }),
      sessionNonce: `nonce-${deviceId}`,
    }
  };
}

function device(overrides = {}) {
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
    lastSeenAt: '2026-07-16T00:00:00.000Z',
    ...overrides
  };
}

function sequenceId() {
  let i = 0;
  return (prefix) => `${prefix}-${++i}`;
}

function code(expected) {
  return (error) => error?.code === expected;
}
