import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerCore, hashSecret } from '../../controller-core/src/controllerCore.js';
import { createMemoryStore } from '../../../companion/store.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';
import { ControllerApplicationService, DISPATCH_DEADLINE_SECONDS } from '../src/controllerApplication.js';

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

function application(core, transport) {
  return new ControllerApplicationService({
    core,
    wssTransport: transport,
    now: () => '2026-07-16T00:00:00.000Z',
    id: sequenceId()
  });
}

function fakeTransport({ failDispatch = false, failCancel = false } = {}) {
  return {
    dispatches: [],
    cancels: [],
    sendDispatch(deviceId, generation, dispatch) {
      if (failDispatch) throw Object.assign(new Error('send failed'), { code: 'WSS_SEND_FAILED' });
      this.dispatches.push({ deviceId, generation, dispatch });
      return { delivered: true, deviceId, generation };
    },
    sendCancel(deviceId, generation, cancel) {
      if (failCancel) throw Object.assign(new Error('send failed'), { code: 'WSS_SEND_FAILED' });
      this.cancels.push({ deviceId, generation, cancel });
      return { delivered: true, deviceId, generation };
    }
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
  return {
    workflowId: 'wf-1',
    revision: 1,
    schemaVersion: 'war-workflow-revision.v2',
    contentHash: 'a'.repeat(64),
    name: 'Workflow',
    description: '',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    sourceDeviceId: 'dev-a',
    requiredInputs: [],
    profilePayload: { id: 'wf-1', steps: [] },
    ...overrides
  };
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

function sequenceId() {
  let i = 0;
  return (prefix) => `${prefix}-${++i}`;
}

function code(expected) {
  return (error) => error?.code === expected;
}
