import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerCore, hashSecret } from '../../controller-core/src/controllerCore.js';
import { createMemoryStore } from '../../../companion/store.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';
import { ControllerApplicationService, DISPATCH_DEADLINE_SECONDS } from '../src/controllerApplication.js';
import { createWorkflowContentHash } from '../../workflow-core/src/workflowMetadata.js';
import { normalizeIpv6Eui64Suffix } from '../../controller-core/src/networkConfig.js';

const IMAGE_PIN = `sha256:${'a'.repeat(64)}`;

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

test('application projects one configured human-only Moonlight device without registering a managed Agent', async () => {
  const core = await connectedCore();
  const app = new ControllerApplicationService({
    core,
    config: {
      dataPath: 'data',
      degraded: false,
      errors: [],
      wss: { enabled: false, requested: false, status: 'disabled', host: '127.0.0.1', port: 0, tls: {} },
      containers: { enabled: false, runtime: 'disabled' },
      interactive: {
        enabled: true,
        errors: [],
        deviceId: 'interactive-chrome-pilot',
        displayName: 'Chrome realtime',
        host: '192.168.1.201',
        port: 47989,
        app: 'Desktop',
      },
    },
  });
  const listed = app.listDevices().data.devices;
  const interactive = listed.find((device) => device.id === 'interactive-chrome-pilot');
  assert.equal(interactive.status, 'configured');
  assert.equal(interactive.mode, 'interactive');
  assert.equal(interactive.connectionDescriptor.host, '192.168.1.201');
  assert.equal(interactive.capabilities.humanRealtimeControl, true);
  assert.equal(app.getDevice({ deviceId: interactive.id }).data.connectionDescriptor.app, 'Desktop');
  assert.equal(app.getBootstrapState().data.deviceCount, core.devices.listDevices().devices.length + 1);
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
  assert.equal(added.data.container.image, IMAGE_PIN);
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

test('application attests the host image before pairing provisioning and aborts with no helper work on failure', async () => {
  const core = await connectedCore();
  const adapter = fakeContainerAdapter();
  const calls = [];
  adapter.attestImage = async () => { calls.push('attest'); throw new Error('immutable image attestation failed'); };
  const provisionManagedAgent = core.pairing.provisionManagedAgent.bind(core.pairing);
  core.pairing.provisionManagedAgent = async (...args) => { calls.push('provision'); return provisionManagedAgent(...args); };
  const app = new ControllerApplicationService({ core, containerAdapter: adapter, config: managedRuntimeConfig(), now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });

  await assert.rejects(() => app.addContainer({ name: 'Untrusted image', host: 'configured-docker-host' }), /immutable image attestation failed/);
  assert.deepEqual(calls, ['attest']);
  assert.deepEqual(adapter.calls.filter((call) => call.action === 'create'), []);
});

test('application validates the managed host image before create, duplicate, start, and restart', async () => {
  const core = await connectedCore();
  const adapter = fakeContainerAdapter();
  const ensured = [];
  const host = { id: 'ssh-host-1', image: IMAGE_PIN, imagePin: IMAGE_PIN };
  const containerHostManager = {
    getHost: (hostId) => hostId === host.id ? host : null,
    firstHostId: () => host.id,
    getAdapter: (hostId) => hostId === host.id ? adapter : null,
    ensureReady: async (hostId) => { ensured.push(hostId); return { id: hostId, connected: true }; },
  };
  const app = new ControllerApplicationService({ core, containerHostManager, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });

  const added = await app.addContainer({ name: 'Agent One', host: host.id, runtime: { dockerName: 'agent-one' } });
  await app.duplicateContainer({ containerId: added.data.container.id, name: 'Agent Two' });
  await app.startContainer({ containerId: added.data.container.id });
  await app.restartContainer({ containerId: added.data.container.id });

  assert.deepEqual(ensured, [host.id, host.id, host.id, host.id]);
  assert.deepEqual(adapter.calls.map((item) => item.action), ['probe', 'create', 'create', 'start', 'restart']);
});

test('application pins legacy persisted container images before refresh and start adapter calls', async () => {
  const core = await connectedCore();
  const imagePin = `sha256:${'a'.repeat(64)}`;
  const config = managedRuntimeConfig();
  config.containers.imagePin = imagePin;
  const calls = [];
  const adapter = {
    async status(container) {
      calls.push({ action: 'status', id: container.id, image: container.image });
      return { status: 'stopped', runtime: container.runtime };
    },
    async start(container) {
      calls.push({ action: 'start', id: container.id, image: container.image });
      return { status: 'running', runtime: container.runtime };
    },
  };
  const legacy = await core.containers.createContainer({
    name: 'Legacy tagged agent',
    host: 'configured-docker-host',
    image: 'war-browser-agent:phase1',
    deviceId: 'dev-a',
    runtime: { dockerName: 'legacy-tagged-agent' },
  });
  await core.containers.updateStatus(legacy.id, 'stopped', { desiredState: 'stopped' });
  const app = new ControllerApplicationService({ core, containerAdapter: adapter, config });

  await app.refreshContainer({ containerId: legacy.id });
  await app.startContainer({ containerId: legacy.id });

  assert.equal(core.containers.getContainer(legacy.id).image, 'war-browser-agent:phase1');
  assert.deepEqual(calls, [
    { action: 'status', id: legacy.id, image: imagePin },
    { action: 'start', id: legacy.id, image: imagePin },
  ]);
});

test('startup reconciliation honors each container persisted desired state', async () => {
  const core = await connectedCore();
  const calls = [];
  const adapter = {
    async status(container) { calls.push(['status', container.id]); return { status: 'stopped', runtime: { dockerName: container.runtime.dockerName } }; },
    async start(container) { calls.push(['start', container.id]); return { status: 'running', runtime: { dockerName: container.runtime.dockerName } }; },
  };
  const created = await core.containers.createContainer({ name: 'Persisted running', deviceId: 'dev-a', runtime: { dockerName: 'persisted-running' } });
  await core.containers.updateStatus(created.id, 'stopped', { desiredState: 'running' });
  const app = new ControllerApplicationService({ core, containerAdapter: adapter });
  const result = await app.reconcileManagedState();
  assert.equal(result.containers[0].ok, true);
  assert.deepEqual(calls, [['status', created.id], ['start', created.id]]);
  assert.equal(core.containers.getContainer(created.id).status, 'running');
  assert.equal(core.containers.getContainer(created.id).desiredState, 'running');
});

test('startup reconciliation repairs managed definition drift before restoring a desired-running container', async () => {
  const core = await connectedCore();
  const calls = [];
  const adapter = {
    async repair(container) {
      calls.push(['repair', container.id]);
      assert.equal(container.image, IMAGE_PIN);
      return { status: 'stopped', runtime: { dockerName: container.runtime.dockerName } };
    },
    async status(container) {
      calls.push(['status', container.id]);
      return { status: 'stopped', runtime: { dockerName: container.runtime.dockerName } };
    },
    async start(container) {
      calls.push(['start', container.id]);
      return { status: 'running', runtime: { dockerName: container.runtime.dockerName } };
    },
  };
  const created = await core.containers.createContainer({ name: 'Definition drift', image: IMAGE_PIN, deviceId: 'dev-a', runtime: { dockerName: 'definition-drift' } });
  await core.containers.updateStatus(created.id, 'running', { desiredState: 'running' });
  const app = new ControllerApplicationService({ core, containerAdapter: adapter });

  const result = await app.reconcileManagedState();

  const repairIndex = calls.findIndex(([action]) => action === 'repair');
  const statusIndex = calls.findIndex(([action]) => action === 'status');
  assert.equal(result.containers[0].ok, true);
  assert.equal(repairIndex >= 0, true, 'reconciliation must repair managed definition drift');
  assert.equal(statusIndex < 0 || repairIndex < statusIndex, true, 'reconciliation must not status-check before repairing definition drift');
  assert.equal(calls.filter(([action]) => action === 'start').length, 1);
  assert.equal(core.containers.getContainer(created.id).status, 'running');
  assert.equal(core.containers.getContainer(created.id).desiredState, 'running');
});

test('startup reconciliation marks a desired-running container failed when its saved host is unavailable', async () => {
  const core = await connectedCore();
  const hostId = 'ssh-unavailable';
  const secret = 'top-secret-session-token';
  const container = await core.containers.createContainer({ name: 'Unavailable host', host: hostId, deviceId: 'dev-a', runtime: { dockerName: 'unavailable-host' } });
  await core.containers.updateStatus(container.id, 'running', { desiredState: 'running' });
  const app = new ControllerApplicationService({
    core,
    containerHostManager: {
      configuredHostIds: () => [hostId],
      ensureReady: async () => ({ connected: false, diagnostics: { error: `credential=${secret} ${'x'.repeat(600)}` } }),
    },
  });
  const invalidations = [];
  app.on('invalidation', (event) => invalidations.push(event));

  const result = await app.reconcileManagedState();
  const persisted = core.containers.getContainer(container.id);

  assert.equal(result.containers[0].ok, false);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.desiredState, 'running');
  assert.equal(persisted.lastError.length <= 500, true);
  assert.equal(persisted.lastError.includes(secret), false);
  assert.ok(invalidations.some((event) => event.domain === 'containers' && event.containerId === container.id));
});

test('startup reconciliation keeps a remotely running container intact when local WSS prerequisites are absent', async () => {
  const core = await connectedCore();
  const calls = [];
  const container = await core.containers.createContainer({ name: 'Remote Browser Agent', deviceId: 'dev-a', runtime: { dockerName: 'remote-browser-agent' } });
  await core.containers.updateStatus(container.id, 'running', { desiredState: 'running' });
  const app = new ControllerApplicationService({
    core,
    config: {
      degraded: true,
      errors: ['WSS TLS certificate is required'],
      wss: { enabled: false, requested: true, status: 'degraded', host: '192.168.1.20', port: 47651, tls: {} },
      containers: { enabled: true, runtime: 'ssh-docker' },
    },
    containerAdapter: {
      async repair() {
        calls.push('repair');
        throw new Error('CONTROLLER_WSS_NOT_CONFIGURED');
      },
    },
  });

  await app.reconcileManagedState();
  const persisted = core.containers.getContainer(container.id);

  assert.equal(persisted.status, 'running');
  assert.equal(persisted.desiredState, 'running');
  assert.deepEqual(calls, [], 'startup must defer remote reconciliation until local WSS is available instead of changing persisted container state');
});

test('startup reconciliation defers legacy remote containers when both effective WSS and container runtime are disabled', async () => {
  const result = await reconcileRemoteContainerWithUnavailableLocalWss({
    degraded: false,
    wss: { enabled: false, requested: false, status: 'disabled', host: '127.0.0.1', port: 0, tls: {} },
    containers: { enabled: false, runtime: 'disabled' },
  });

  assert.equal(result.persisted.status, 'running');
  assert.equal(result.persisted.desiredState, 'running');
  assert.deepEqual(result.calls, [], 'disabled local prerequisites must not probe or mutate an existing remote container');
});

test('startup reconciliation defers remote containers when the persisted runtime profile is invalid', async () => {
  const result = await reconcileRemoteContainerWithUnavailableLocalWss({
    degraded: true,
    runtimeProfileStatus: 'invalid',
    errors: ['Controller runtime profile is corrupt'],
    wss: { enabled: false, requested: false, status: 'disabled', host: '127.0.0.1', port: 0, tls: {} },
    containers: { enabled: false, runtime: 'disabled' },
  });

  assert.equal(result.persisted.status, 'running');
  assert.equal(result.persisted.desiredState, 'running');
  assert.deepEqual(result.calls, [], 'an invalid persisted profile must block host probes and Docker reconciliation');
});

test('reconciliation redacts sensitive persisted and runtime-visible errors without stack or cause leakage', async () => {
  const sensitiveMessage = 'secret=secret-equals secret:secret-colon authorization=authorization-equals authorization:authorization-colon identity=identity-equals identity:identity-colon Bearer bearer-token';
  const rawSecrets = ['secret-equals', 'secret-colon', 'authorization-equals', 'authorization-colon', 'identity-equals', 'identity-colon', 'bearer-token', 'stack-secret', 'cause-secret'];
  const persistedCore = await connectedCore();
  const persistedContainer = await persistedCore.containers.createContainer({ name: 'Sensitive error', deviceId: 'dev-a', runtime: { dockerName: 'sensitive-error' } });
  const persistedError = new Error(sensitiveMessage);
  persistedError.stack = `Error: ${sensitiveMessage}\nstack-secret`;
  persistedError.cause = new Error('cause-secret');
  const persistedApp = new ControllerApplicationService({
    core: persistedCore,
    containerAdapter: { async repair() { throw persistedError; } },
  });

  await persistedApp.reconcileManagedState();

  const persisted = persistedCore.containers.getContainer(persistedContainer.id);
  const diagnostics = await persistedApp.getDiagnostics();
  const diagnosticContainer = diagnostics.data.containers.find((item) => item.id === persistedContainer.id);
  assertRedactedContainerError(persisted.lastError, rawSecrets);
  assertRedactedContainerError(diagnosticContainer.lastError, rawSecrets);

  const runtimeCore = await connectedCore();
  const runtimeError = new Error(sensitiveMessage);
  runtimeError.stack = `Error: ${sensitiveMessage}\nstack-secret`;
  runtimeError.cause = new Error('cause-secret');
  runtimeCore.containers.listContainers = () => { throw runtimeError; };
  const runtimeApp = new ControllerApplicationService({ core: runtimeCore });

  await assert.rejects(() => runtimeApp.reconcileManagedState(), /secret=/);

  const runtimeErrorStatus = runtimeApp.getRuntimeStatus().data.reconciliation;
  assert.equal(runtimeErrorStatus.status, 'failed');
  assertRedactedContainerError(runtimeErrorStatus.error, rawSecrets);
});

test('repairing a managed host reconciles a persisted desired-running container that Docker reports stopped', async () => {
  const core = await connectedCore();
  const calls = [];
  const hostId = 'ssh-repaired';
  const adapter = {
    async status(container) { calls.push(['status', container.id]); return { status: 'stopped', runtime: { dockerName: container.runtime.dockerName } }; },
    async start(container) { calls.push(['start', container.id]); return { status: 'running', runtime: { dockerName: container.runtime.dockerName } }; },
  };
  const containerHostManager = {
    async repairHost(id) { calls.push(['repairHost', id]); return { id, connected: true }; },
    async ensureReady(id) { calls.push(['ensureReady', id]); return { id, connected: true }; },
    getAdapter: (id) => id === hostId ? adapter : null,
    getHost: (id) => id === hostId ? { id, image: IMAGE_PIN, imagePin: IMAGE_PIN } : null,
    configuredHostIds: () => [hostId],
  };
  const created = await core.containers.createContainer({ name: 'Recovered running', host: hostId, deviceId: 'dev-a', runtime: { dockerName: 'recovered-running' } });
  await core.containers.updateStatus(created.id, 'stopped', { desiredState: 'running' });
  const app = new ControllerApplicationService({ core, containerHostManager });

  await app.repairContainerHost({ hostId });

  assert.deepEqual(calls, [['repairHost', hostId], ['ensureReady', hostId], ['status', created.id], ['start', created.id]]);
  assert.equal(core.containers.getContainer(created.id).status, 'running');
  assert.equal(core.containers.getContainer(created.id).desiredState, 'running');
});

test('repairing a desired-running container starts it when runtime repair leaves it stopped', async () => {
  const core = await connectedCore();
  const calls = [];
  const adapter = {
    async repair(container) { calls.push(['repair', container.id]); return { status: 'stopped', runtime: { dockerName: container.runtime.dockerName } }; },
    async start(container) { calls.push(['start', container.id]); return { status: 'running', runtime: { dockerName: container.runtime.dockerName } }; },
  };
  const container = await core.containers.createContainer({ name: 'Repair start', deviceId: 'dev-a', runtime: { dockerName: 'repair-start' } });
  await core.containers.updateStatus(container.id, 'stopped', { desiredState: 'running' });
  const app = new ControllerApplicationService({ core, containerAdapter: adapter });

  const result = await app.repairContainer({ containerId: container.id });

  assert.deepEqual(calls, [['repair', container.id], ['start', container.id]]);
  assert.equal(result.data.container.status, 'running');
  assert.equal(result.data.container.desiredState, 'running');
});

test('container adapter failure results are redacted before persistence and response', async () => {
  const core = await connectedCore();
  const secret = 'synthetic-adapter-result-secret';
  const adapter = {
    async repair() {
      return { ok: false, error: `credential=${secret}` };
    },
  };
  const container = await core.containers.createContainer({ name: 'Unsafe adapter error', deviceId: 'dev-a', runtime: { dockerName: 'unsafe-adapter-error' } });
  const app = new ControllerApplicationService({ core, containerAdapter: adapter });

  const result = await app.repairContainer({ containerId: container.id });
  const encoded = JSON.stringify(result);

  assert.equal(result.data.container.status, 'failed');
  assert.equal(encoded.includes(secret), false);
  assert.match(result.data.container.lastError, /<redacted>/);
});

test('diagnostics and global repair restore a desired-running container reported as stopped', async () => {
  const core = await connectedCore();
  const calls = [];
  const adapter = {
    async start(container) { calls.push(['start', container.id]); return { status: 'running', runtime: { dockerName: container.runtime.dockerName } }; },
  };
  const container = await core.containers.createContainer({ name: 'Diagnostic start', deviceId: 'dev-a', runtime: { dockerName: 'diagnostic-start' } });
  await core.containers.updateStatus(container.id, 'stopped', { desiredState: 'running' });
  const app = new ControllerApplicationService({ core, containerAdapter: adapter });

  const diagnostics = await app.getDiagnostics();
  const repaired = await app.repairDiagnostics();

  assert.ok(diagnostics.data.checks.some((check) => check.targetId === `container:${container.id}` && check.fixable === true && check.action === 'reconnect-container'));
  assert.deepEqual(calls, [['start', container.id]]);
  assert.equal(core.containers.getContainer(container.id).status, 'running');
  assert.ok(repaired.data.repairs.some((repair) => repair.targetId === `container:${container.id}`));
});

test('scan imports only validated managed containers and reuses their credential without returning it', async () => {
  const core = await connectedCore();
  const adapter = {
    async scanManagedContainers() {
      return {
        containers: [{
          containerId: 'container-imported-1',
          name: 'Imported Chromium 1',
          dockerName: 'war-imported-1',
          deviceId: 'managed-imported-1',
          credential: 'c'.repeat(43),
          image: IMAGE_PIN,
          runtime: { dockerName: 'war-imported-1', ipv4Enabled: true },
          status: 'running',
        }],
        rejected: [{ dockerName: 'unsafe', reason: 'security policy failed' }],
      };
    },
  };
  const hostManager = {
    configuredHostIds: () => ['ssh-host-1'],
    ensureReady: async () => ({ connected: true }),
    getAdapter: () => adapter,
  };
  const app = new ControllerApplicationService({ core, containerHostManager: hostManager });
  const result = await app.scanContainerHost({ hostId: 'ssh-host-1' });
  assert.equal(result.data.imported.length, 1);
  assert.equal(result.data.rejected.length, 1);
  assert.equal(JSON.stringify(result.data).includes('cccc'), false);
  assert.equal(core.containers.getContainer('container-imported-1').name, 'Imported Chromium 1');
  assert.equal(core.containers.getContainer('container-imported-1').desiredState, 'running');
});

test('application manages container lifecycle through a bounded adapter', async () => {
  const core = await connectedCore();
  const adapter = fakeContainerAdapter();
  const app = new ControllerApplicationService({ core, containerAdapter: adapter, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });

  const added = await app.addContainer({ name: 'Agent One', image: IMAGE_PIN, runtime: { dockerName: 'agent-one' } });
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
  assert.doesNotThrow(() => normalizeIpv6Eui64Suffix(duplicate.data.container.runtime.ipv6Suffix));
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

test('network update passes persisted IPv6 identity through while changing preferences and suffix', async () => {
  const core = await connectedCore();
  let received;
  const adapter = {
    async updateNetwork(container) {
      received = structuredClone(container);
      return { status: container.status, runtime: { ...container.runtime } };
    },
  };
  const app = new ControllerApplicationService({ core, containerAdapter: adapter });
  const container = await core.containers.createContainer({
    name: 'Legacy IPv6',
    deviceId: 'dev-a',
    runtime: {
      dockerName: 'legacy-ipv6',
      ipv4Enabled: true,
      ipv6Enabled: true,
      ipv6Suffix: 'abcd:ef01:2345:6789',
      ipv6Network: 'war-managed-ipv6-123456789abc',
      ipv6Prefix: '2001:db8:1:2::/64',
      ipv6Address: '2001:db8:1:2:abcd:ef01:2345:6789',
    },
  });

  await app.updateContainerNetwork({ containerId: container.id, ipv4Enabled: false, ipv6Enabled: true, ipv6Suffix: '1234:5678:9abc:def0' });

  assert.equal(received.runtime.ipv4Enabled, false);
  assert.equal(received.runtime.ipv6Enabled, true);
  assert.equal(received.runtime.ipv6Suffix, '1234:5678:9abc:def0');
  assert.equal(received.runtime.ipv6Network, 'war-managed-ipv6-123456789abc');
  assert.equal(received.runtime.ipv6Prefix, '2001:db8:1:2::/64');
  assert.equal(received.runtime.ipv6Address, '2001:db8:1:2:abcd:ef01:2345:6789');
});

test('managed container restart makes its prior Agent session non-actionable until a fresh hello', async () => {
  const core = await connectedCore();
  const transport = fakeTransport();
  let releaseRestart;
  let notifyRestart;
  const restartStarted = new Promise((resolve) => { notifyRestart = resolve; });
  const adapter = {
    async restart() {
      notifyRestart();
      await new Promise((resolve) => { releaseRestart = resolve; });
      return { status: 'running' };
    },
  };
  const container = await core.containers.createContainer({
    name: 'Restarting Agent',
    deviceId: 'dev-a',
    runtime: { dockerName: 'restarting-agent' },
  });
  await core.containers.updateStatus(container.id, 'running', { desiredState: 'running' });
  const app = new ControllerApplicationService({ core, containerAdapter: adapter, wssTransport: transport, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });
  const priorGeneration = core.sessions.getPublicSession('dev-a').generation;

  const restart = app.restartContainer({ containerId: container.id });
  await restartStarted;

  assert.equal(core.containers.getContainer(container.id).status, 'restarting');
  assert.equal(core.sessions.getPublicSession('dev-a').status, 'offline');
  assert.equal(core.devices.getDevice('dev-a').status, 'offline');
  const duringRestart = await app.remoteControl({ deviceIds: ['dev-a'], command: 'input.stopAll', payload: {} });
  assert.equal(duringRestart.data.targets[0].ok, false);
  assert.equal(transport.remoteRequests.length, 0);

  releaseRestart();
  await restart;
  assert.equal(core.sessions.getPublicSession('dev-a').status, 'offline');
  await core.sessions.authenticateHello(agentHello(), { credential: 'cred-a' });
  const replacement = core.sessions.getPublicSession('dev-a');
  assert.equal(replacement.status, 'online');
  assert.ok(replacement.generation > priorGeneration);

  const afterHello = await app.remoteControl({ deviceIds: ['dev-a'], command: 'input.stopAll', payload: {} });
  assert.equal(afterHello.data.targets[0].ok, true);
  assert.equal(transport.remoteRequests.length, 1);
  assert.equal(transport.remoteRequests[0].generation, replacement.generation);
});

test('trashing an already-revoked failed managed container remains recoverable', async () => {
  const core = await connectedCore();
  const adapter = fakeContainerAdapter();
  adapter.create = async function create(container) {
    this.calls.push({ action: 'create', id: container.id });
    throw new Error('create failed');
  };
  const app = new ControllerApplicationService({ core, containerAdapter: adapter, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });
  const added = await app.addContainer({ name: 'Failed Agent', image: IMAGE_PIN, runtime: { dockerName: 'failed-agent' } });

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
  const added = await app.addContainer({ name: 'Agent One', image: IMAGE_PIN, runtime: { dockerName: 'agent-one' } });
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
  const added = await app.addContainer({ name: 'Never Provisioned', image: IMAGE_PIN, runtime: { dockerName: 'never-provisioned' } });

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

test('application binds synchronized browser-space input to each device target without changing shared timing', async () => {
  const core = await connectedCore();
  await pairSecondDevice(core);
  const transport = fakeTransport();
  const app = application(core, transport);

  const control = await app.remoteControl({
    deviceIds: ['dev-a', 'dev-b'],
    command: 'input.shortcut',
    payload: { keys: 'CTRL+L', space: 'browser' },
    targetIds: { 'dev-a': 'tab-a', 'dev-b': 'tab-b' },
    synchronized: true,
  });

  assert.equal(control.data.targets.every((item) => item.ok), true);
  assert.deepEqual(transport.remoteRequests.map((request) => request.payload.payload.targetId), ['tab-a', 'tab-b']);
  assert.equal(transport.remoteRequests[0].payload.syncAt, transport.remoteRequests[1].payload.syncAt);
  await assert.rejects(
    () => app.remoteControl({ deviceIds: ['dev-a'], command: 'input.shortcut', payload: { keys: 'CTRL+L', space: 'browser' } }),
    code('REMOTE_BROWSER_TARGET_REQUIRED'),
  );
});

test('remote control allowlist forwards Chrome-like tab and internal-page commands but blocks clipboard export', async () => {
  const core = await connectedCore();
  const transport = fakeTransport();
  const app = application(core, transport);
  const commands = [
    ['browser.restart', {}],
    ['tab.new', { url: 'https://example.test/new' }],
    ['tab.back', { targetId: 'tab-1' }],
    ['tab.forward', { targetId: 'tab-1' }],
    ['tab.reload', { targetId: 'tab-1' }],
    ['tab.home', { targetId: 'tab-1' }],
    ['browser.openInternalPage', { page: 'settings' }],
    ['browser.openInternalPage', { page: 'extensions' }],
    ['page.focus', { targetId: 'tab-1', target: { selectorType: 'css', selector: '#search', strict: true } }],
    ['page.press', { targetId: 'tab-1', target: { selectorType: 'css', selector: '#search', strict: true }, key: 'Enter' }],
  ];

  for (const [command, payload] of commands) {
    const result = await app.remoteControl({ deviceIds: ['dev-a'], command, payload, synchronized: false });
    assert.equal(result.data.targets[0].ok, true);
  }

  assert.deepEqual(transport.remoteRequests.map((request) => [request.payload.command, request.payload.payload]), commands);
  await assert.rejects(
    () => app.remoteControl({ deviceIds: ['dev-a'], command: 'clipboard.copySelection', payload: {}, synchronized: false }),
    code('REMOTE_COMMAND_NOT_ALLOWED'),
  );
});

test('dedicated remote clipboard methods keep text out of generic control and enforce the 64 KiB boundary', async () => {
  const core = await connectedCore();
  const transport = fakeTransport();
  const secret = 'synthetic clipboard secret';
  transport.requestRemoteControl = async (deviceId, generation, payload) => {
    transport.remoteRequests.push({ deviceId, generation, payload: structuredClone(payload) });
    if (payload.command === 'clipboard.copySelection') {
      return {
        payload: {
          ok: true,
          result: {
            type: 'clipboard.copySelection',
            result: { copied: true, bytes: Buffer.byteLength(secret), text: secret },
          },
        },
      };
    }
    return { payload: { ok: true, result: { type: payload.command, result: { pasted: true } } } };
  };
  const app = application(core, transport);

  const copied = await app.remoteClipboardCopy({ deviceId: 'dev-a' });
  assert.equal(copied.data.text, secret);
  assert.equal(copied.data.bytes, Buffer.byteLength(secret));

  const pasted = await app.remoteClipboardPaste({ deviceIds: ['dev-a'], synchronized: false, text: secret });
  assert.equal(pasted.data.pasted, true);
  assert.equal(pasted.data.bytes, Buffer.byteLength(secret));
  assert.deepEqual(transport.remoteRequests.map((request) => request.payload.command), ['clipboard.copySelection', 'clipboard.pasteText']);
  await assert.rejects(
    () => app.remoteClipboardPaste({ deviceIds: ['dev-a'], text: 'x'.repeat(64 * 1024 + 1) }),
    code('REMOTE_CLIPBOARD_TOO_LARGE'),
  );
});

test('remote clipboard paste fails closed when an outer-success response has an invalid nested dispatch', async (t) => {
  const secret = 'synthetic clipboard secret';
  const cases = [
    { name: 'wrong command type', dispatch: { type: 'clipboard.copySelection', result: { pasted: true, bytes: Buffer.byteLength(secret) } } },
    { name: 'paste not confirmed', dispatch: { type: 'clipboard.pasteText', result: { pasted: false, bytes: Buffer.byteLength(secret) } } },
    { name: 'mismatched byte count', dispatch: { type: 'clipboard.pasteText', result: { pasted: true, bytes: Buffer.byteLength(secret) + 1 } } },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const core = await connectedCore();
      const transport = fakeTransport();
      transport.requestRemoteControl = async () => ({ payload: { ok: true, result: scenario.dispatch } });
      const app = application(core, transport);

      const result = await app.remoteClipboardPaste({ deviceIds: ['dev-a'], text: secret });

      assert.equal(result.data.pasted, false, 'a malformed nested success must not mark the aggregate paste as successful');
      assert.deepEqual(result.data.targets, [{
        deviceId: 'dev-a',
        ok: false,
        error: { code: 'REMOTE_CLIPBOARD_PASTE_FAILED', message: 'Remote clipboard paste failed' },
      }]);
    });
  }
});

test('remote control does not forward Agent-provided error text or codes', async () => {
  const core = await connectedCore();
  const secret = 'synthetic-remote-agent-secret';
  const transport = fakeTransport();
  transport.requestRemoteControl = async () => ({
    payload: {
      ok: false,
      error: { code: `SECRET_${secret}`, message: `credential=${secret}` },
    },
  });
  const app = application(core, transport);

  const result = await app.remoteControl({
    deviceIds: ['dev-a'],
    command: 'input.stopAll',
    payload: {},
    synchronized: false,
  });
  const target = result.data.targets[0];
  const encoded = JSON.stringify(target);

  assert.equal(target.ok, false);
  assert.equal(target.error.code, 'REMOTE_CONTROL_FAILED');
  assert.equal(target.error.message, 'Remote command failed');
  assert.equal(encoded.includes(secret), false);
});

test('remote capture starts one automatic managed Agent upgrade and succeeds after reconnect', async () => {
  const core = await connectedCore();
  await core.devices.registerDevice('dev-a', { capabilities: { ...core.devices.getDevice('dev-a').capabilities, remoteVideo: false } });
  await core.containers.createContainer({ name: 'Chromium 1', host: 'ssh-host-1', image: IMAGE_PIN, deviceId: 'dev-a', runtime: { dockerName: 'war-chromium-1' } });
  let ensureCalls = 0;
  let restartCalls = 0;
  const adapter = {
    async restart(container) {
      restartCalls += 1;
      return { status: 'running', runtime: structuredClone(container.runtime) };
    },
  };
  const containerHostManager = {
    ensureReady: async () => { ensureCalls += 1; return { connected: true }; },
    getAdapter: () => adapter,
    getHost: () => ({ id: 'ssh-host-1', image: IMAGE_PIN, imagePin: IMAGE_PIN }),
  };
  const transport = fakeTransport();
  const app = new ControllerApplicationService({ core, containerHostManager, wssTransport: transport, now: () => '2026-07-16T00:00:00.000Z', id: sequenceId() });

  const first = await app.remoteCapture({ deviceId: 'dev-a', quality: 45 });
  const second = await app.remoteCapture({ deviceId: 'dev-a', quality: 45 });
  assert.equal(first.data.status, 'updating');
  assert.equal(second.data.status, 'updating');

  const upgrade = app.remoteReadiness.get('dev-a').promise;
  await core.sessions.authenticateHello(agentHello(), { credential: 'cred-a' });
  await upgrade;
  const capture = await app.remoteCapture({ deviceId: 'dev-a', quality: 45 });

  assert.equal(ensureCalls, 1);
  assert.equal(restartCalls, 1);
  assert.equal(capture.data.frame.mimeType, 'image/jpeg');
  assert.equal(transport.remoteRequests.length, 1);
});

test('remote capture rejects an unsupported non-managed Agent without waiting for transport timeout', async () => {
  const core = await connectedCore();
  await core.devices.registerDevice('dev-a', { capabilities: { ...core.devices.getDevice('dev-a').capabilities, remoteVideo: false } });
  const transport = fakeTransport();
  const app = application(core, transport);

  await assert.rejects(() => app.remoteCapture({ deviceId: 'dev-a', quality: 45 }), code('REMOTE_AGENT_UPDATE_REQUIRED'));
  assert.equal(transport.remoteRequests.length, 0);
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

function assertRedactedContainerError(value, rawSecrets) {
  assert.equal(typeof value, 'string');
  assert.equal(value.length <= 500, true);
  for (const secret of rawSecrets) assert.equal(value.includes(secret), false, `error leaks ${secret}`);
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
      image: IMAGE_PIN,
      imagePin: IMAGE_PIN,
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

async function reconcileRemoteContainerWithUnavailableLocalWss(config) {
  const core = await connectedCore();
  const calls = [];
  const hostId = 'ssh-legacy-remote';
  const container = await core.containers.createContainer({ name: 'Legacy remote browser', host: hostId, deviceId: 'dev-a', runtime: { dockerName: 'legacy-remote-browser' } });
  await core.containers.updateStatus(container.id, 'running', { desiredState: 'running' });
  const app = new ControllerApplicationService({
    core,
    config,
    containerHostManager: {
      configuredHostIds: () => [hostId],
      async ensureReady() { calls.push('ensureReady'); return { connected: true }; },
      getAdapter: () => ({
        async repair() {
          calls.push('repair');
          throw new Error('CONTROLLER_WSS_NOT_CONFIGURED');
        },
      }),
    },
  });

  await app.reconcileManagedState();
  return { calls, persisted: core.containers.getContainer(container.id) };
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
      remoteVideo: true,
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
