import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControllerCore, hashSecret } from '../src/controllerCore.js';
import { createMemoryStore, JsonStore } from '../../../companion/store.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';
import { createWorkflowContentHash } from '../../workflow-core/src/workflowMetadata.js';

test('pair success binds credential to authoritative device identity without storing plaintext token', async () => {
  const core = await fixtureCore();
  const request = await core.pairing.requestPairing({ device: device(), displayName: 'Agent A', requestId: 'pair-a' });
  const accepted = await core.pairing.confirmPairing(request.requestId, request.code);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.deviceId, 'dev-a');
  assert.equal(core.devices.getDevice('dev-a').name, 'Agent A');
  const state = core.store.snapshot();
  assert.equal(state.pendingPairings[0].tokenHash, hashSecret(request.code));
  assert.equal(JSON.stringify(state).includes(request.code), false);
  assert.equal(JSON.stringify(state).includes(accepted.credential), false);
  assert.equal(state.pairedAgents[0].credentialHash, hashSecret(accepted.credential));
});

test('pair expiry is cleaned up and cannot be confirmed', async () => {
  const clock = fakeClock('2026-07-16T00:00:00.000Z');
  const core = await fixtureCore(clock);
  const request = await core.pairing.requestPairing({ device: device(), requestId: 'pair-expire' });
  clock.advance(6 * 60 * 1000);
  await assert.rejects(() => core.pairing.confirmPairing(request.requestId, request.code), /expired/i);
  assert.equal(core.store.snapshot().pendingPairings.some((item) => item.status === 'pending'), false);
});

test('pair rejection and replay are refused', async () => {
  const core = await fixtureCore();
  const request = await core.pairing.requestPairing({ device: device(), requestId: 'pair-reject' });
  const rejected = await core.pairing.rejectPairing(request.requestId);
  assert.equal(rejected.accepted, false);
  await assert.rejects(() => core.pairing.confirmPairing(request.requestId, request.code), /already used/i);

  const replay = await core.pairing.requestPairing({ device: device({ deviceId: 'dev-replay' }), requestId: 'pair-replay' });
  await core.pairing.confirmPairing(replay.requestId, replay.code);
  await assert.rejects(() => core.pairing.confirmPairing(replay.requestId, replay.code), /already used/i);
});

test('pair revoke and re-pair rotates credential', async () => {
  const core = await fixtureCore();
  const first = await core.pairing.requestPairing({ device: device(), requestId: 'pair-one' });
  const accepted = await core.pairing.confirmPairing(first.requestId, first.code);
  await core.pairing.revoke('dev-a');
  assert.throws(() => core.pairing.verifyCredential('dev-a', accepted.credential), /rejected|revoked/i);
  const second = await core.pairing.requestPairing({ device: device(), requestId: 'pair-two' });
  const repaired = await core.pairing.confirmPairing(second.requestId, second.code);
  assert.notEqual(repaired.credential, accepted.credential);
  assert.equal(core.pairing.verifyCredential('dev-a', repaired.credential), true);
});

test('pending pairing collection is bounded and audit redacts token-shaped fields', async () => {
  const core = await fixtureCore();
  core.pairing.maxPending = 1;
  await core.pairing.requestPairing({ device: device({ deviceId: 'dev-one' }), requestId: 'pair-one' });
  await assert.rejects(() => core.pairing.requestPairing({ device: device({ deviceId: 'dev-two' }), requestId: 'pair-two' }), /limit/i);
  core.audit.append(core.store.snapshot(), 'pairing.test', { token: 'visible-token' });
  assert.equal(JSON.stringify(core.store.snapshot().auditEvents).includes('visible-token'), false);
});

test('two agents connect independently and duplicate connection replaces the old generation', async () => {
  const core = await pairedCore();
  const first = await core.sessions.authenticateHello(agentHello('dev-a'), { credential: 'cred-a' });
  const second = await pairAndConnect(core, 'dev-b', 'cred-b');
  const replaced = [];
  core.sessions.attachClose('dev-a', first.generation, (reason) => replaced.push(reason));
  const next = await core.sessions.authenticateHello(agentHello('dev-a', 'nonce-new'), { credential: 'cred-a' });
  assert.equal(second.deviceId, 'dev-b');
  assert.equal(next.generation, first.generation + 1);
  assert.equal(replaced[0].code, 'replaced');
});

test('presence transition and heartbeat timeout update device state', async () => {
  const clock = fakeClock('2026-07-16T00:00:00.000Z');
  const core = await pairedCore(clock);
  const session = await core.sessions.authenticateHello(agentHello('dev-a'), { credential: 'cred-a' });
  await core.sessions.handlePresence(presence(session, 'degraded'));
  assert.equal(core.devices.getDevice('dev-a').status, 'degraded');
  clock.advance(31000);
  await core.sessions.expireHeartbeats();
  assert.equal(core.devices.getDevice('dev-a').status, 'offline');
});

test('workflow metadata reconciliation and two independent jobs dispatch through core services', async () => {
  const core = await pairedCore();
  const session = await core.sessions.authenticateHello(agentHello('dev-a'), { credential: 'cred-a' });
  await core.sessions.reconcileWorkflows('dev-a', session.generation, [revision()]);
  const one = await core.sessions.dispatch(dispatchArgs(session, { idempotencyKey: 'dispatch-one', inputs: { a: 1 } }));
  const two = await core.sessions.dispatch(dispatchArgs(session, { idempotencyKey: 'dispatch-two', inputs: { a: 2 } }));
  assert.notEqual(one.dispatch.jobId, two.dispatch.jobId);
  assert.equal(core.workflows.listMetadata().length, 1);
});

test('duplicate dispatch is idempotent, cancel works, and non-terminal job replays after reconnect', async () => {
  const core = await pairedCore();
  const session = await core.sessions.authenticateHello(agentHello('dev-a'), { credential: 'cred-a' });
  await core.sessions.reconcileWorkflows('dev-a', session.generation, [revision()]);
  const first = await core.sessions.dispatch(dispatchArgs(session, { idempotencyKey: 'same-dispatch' }));
  const duplicate = await core.sessions.dispatch(dispatchArgs(session, { idempotencyKey: 'same-dispatch' }));
  assert.equal(first.dispatch.jobId, duplicate.dispatch.jobId);
  assert.deepEqual((await core.sessions.replayNonTerminal('dev-a', session.generation)).map((item) => item.jobId), [first.dispatch.jobId]);
  const cancel = await core.sessions.cancel({ deviceId: 'dev-a', generation: session.generation, jobId: first.dispatch.jobId, idempotencyKey: 'cancel-one' });
  assert.equal(cancel.ok, true);
});

test('non-terminal dispatch replays after ControllerCore process restart from persistent store', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'war-controller-replay-'));
  const storePath = path.join(dir, 'controller-state.json');
  const clock = fakeClock('2026-07-16T00:00:00.000Z');
  try {
    let core = new ControllerCore({ store: new JsonStore(storePath), now: clock.now, id: sequenceId() });
    await core.load();
    await core.pairing.requestPairing({ device: device(), requestId: 'pair-a' });
    await core.store.update((state) => {
      state.pendingPairings[0].tokenHash = hashSecret('code-a');
    });
    await core.pairing.confirmPairing('pair-a', 'code-a');
    await core.store.update((state) => {
      state.pairedAgents[0].credentialHash = hashSecret('cred-a');
    });
    const firstSession = await core.sessions.authenticateHello(agentHello('dev-a'), { credential: 'cred-a' });
    await core.sessions.reconcileWorkflows('dev-a', firstSession.generation, [revision()]);
    const first = await core.sessions.dispatch(dispatchArgs(firstSession, { idempotencyKey: 'restart-dispatch' }));
    const jobId = first.dispatch.jobId;
    const leaseId = first.dispatch.leaseId;
    const idempotencyKey = first.dispatch.idempotencyKey;
    core.sessions.shutdown();
    core = null;

    const restarted = new ControllerCore({ store: new JsonStore(storePath), now: clock.now, id: sequenceId() });
    await restarted.load();
    const nextSession = await restarted.sessions.authenticateHello(agentHello('dev-a', 'nonce-after-restart'), { credential: 'cred-a' });
    const replay = await restarted.sessions.replayNonTerminal('dev-a', nextSession.generation);
    assert.equal(replay.length, 1);
    assert.equal(replay[0].jobId, jobId);
    assert.equal(replay[0].leaseId, leaseId);
    assert.equal(replay[0].idempotencyKey, idempotencyKey);
    const duplicate = await restarted.sessions.dispatch(dispatchArgs(nextSession, { idempotencyKey: 'restart-dispatch' }));
    assert.equal(duplicate.dispatch.jobId, jobId);
    assert.equal(duplicate.dispatch.leaseId, leaseId);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('expired undelivered dispatch lease replays with the same job id and a fresh lease', async () => {
  const clock = fakeClock('2026-07-16T00:00:00.000Z');
  const core = await pairedCore(clock);
  const session = await core.sessions.authenticateHello(agentHello('dev-a'), { credential: 'cred-a' });
  await core.sessions.reconcileWorkflows('dev-a', session.generation, [revision()]);
  const first = await core.sessions.dispatch(dispatchArgs(session, { idempotencyKey: 'expired-dispatch' }));
  const jobId = first.dispatch.jobId;
  const firstLeaseId = first.dispatch.leaseId;
  await core.store.update((state) => {
    const command = state.commands.find((item) => item.id === jobId);
    command.leaseUntil = '2026-07-16T00:00:01.000Z';
    command.dispatchMetadata.deadline = '2026-07-16T00:00:01.000Z';
  });
  clock.advance(2000);

  const replay = await core.sessions.replayNonTerminal('dev-a', session.generation);
  const command = core.jobs.getCommand(jobId);
  assert.equal(replay.length, 1);
  assert.equal(replay[0].jobId, jobId);
  assert.notEqual(replay[0].leaseId, firstLeaseId);
  assert.equal(command.status, 'leased');
  assert.equal(command.dispatchMetadata.leaseId, replay[0].leaseId);
  assert.equal(command.dispatchMetadata.deadline, command.leaseUntil);
});

test('disconnect during started execution fails job and prevents reconnect replay', async () => {
  const core = await pairedCore();
  const session = await core.sessions.authenticateHello(agentHello('dev-a'), { credential: 'cred-a' });
  await core.sessions.reconcileWorkflows('dev-a', session.generation, [revision()]);
  const first = await core.sessions.dispatch(dispatchArgs(session, { idempotencyKey: 'disconnect-running' }));
  const jobId = first.dispatch.jobId;
  await core.sessions.receiveExecutionEvent(executionEvent(session, jobId, 'job_started'));
  assert.equal(core.jobs.getCommand(jobId).status, 'running');
  await core.sessions.disconnect('dev-a', session.generation, 'offline');
  assert.equal(core.jobs.getCommand(jobId).status, 'failed');
  const nextSession = await core.sessions.authenticateHello(agentHello('dev-a', 'after-disconnect'), { credential: 'cred-a' });
  assert.deepEqual(await core.sessions.replayNonTerminal('dev-a', nextSession.generation), []);
});

test('terminal result is idempotent and stale session event is rejected', async () => {
  const core = await pairedCore();
  const session = await core.sessions.authenticateHello(agentHello('dev-a'), { credential: 'cred-a' });
  await core.sessions.reconcileWorkflows('dev-a', session.generation, [revision()]);
  const first = await core.sessions.dispatch(dispatchArgs(session, { idempotencyKey: 'terminal-one' }));
  const resultEnvelope = executionResult(session, first.dispatch.jobId);
  await core.sessions.receiveExecutionEvent(resultEnvelope);
  await assert.rejects(() => core.sessions.receiveExecutionEvent(executionResult({ ...session, sessionId: 'old-session' }, first.dispatch.jobId)), /stale/i);
});

test('wrong protocol version and malformed envelope are rejected by session validation', async () => {
  const core = await pairedCore();
  await assert.rejects(() => core.sessions.authenticateHello({ ...agentHello('dev-a'), protocolVersion: 'war-control.v1' }, { credential: 'cred-a' }), /Invalid AgentHello|Protocol/);
  await assert.rejects(() => core.sessions.authenticateHello({ protocolVersion: PROTOCOL_VERSION, type: 'agent.hello', payload: {} }, { credential: 'cred-a' }), /Invalid AgentHello/);
});

test('secret digest comparison uses timingSafeEqual and handles malformed credentials safely', async () => {
  const core = await pairedCore();
  assert.throws(() => core.pairing.verifyCredential('dev-a', ''), /rejected/i);
  assert.throws(() => core.pairing.verifyCredential('dev-a', null), /rejected/i);
  await core.store.update((state) => {
    state.pairedAgents[0].credentialHash = 'malformed-hash';
  });
  assert.throws(() => core.pairing.verifyCredential('dev-a', 'cred-a'), /rejected/i);
  const source = await fs.readFile(new URL('../src/pairingService.js', import.meta.url), 'utf8');
  assert.match(source, /timingSafeEqual/);
});

async function fixtureCore(clock = fakeClock()) {
  const store = createMemoryStore();
  const core = new ControllerCore({ store, now: clock.now, id: sequenceId() });
  await core.load();
  return core;
}

async function pairedCore(clock = fakeClock()) {
  const core = await fixtureCore(clock);
  await core.pairing.requestPairing({ device: device(), requestId: 'pair-a' });
  await core.store.update((state) => {
    state.pendingPairings[0].tokenHash = hashSecret('code-a');
  });
  await core.pairing.confirmPairing('pair-a', 'code-a');
  await core.store.update((state) => {
    state.pairedAgents[0].credentialHash = hashSecret('cred-a');
  });
  return core;
}

async function pairAndConnect(core, deviceId, credential) {
  await core.pairing.requestPairing({ device: device({ deviceId }), requestId: `pair-${deviceId}` });
  await core.store.update((state) => {
    state.pendingPairings.find((item) => item.requestId === `pair-${deviceId}`).tokenHash = hashSecret(`code-${deviceId}`);
  });
  await core.pairing.confirmPairing(`pair-${deviceId}`, `code-${deviceId}`);
  await core.store.update((state) => {
    state.pairedAgents.find((item) => item.deviceId === deviceId).credentialHash = hashSecret(credential);
  });
  return core.sessions.authenticateHello(agentHello(deviceId), { credential });
}

function fakeClock(start = '2026-07-16T00:00:00.000Z') {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms).toISOString(),
    advance: (delta) => { ms += delta; }
  };
}

function sequenceId() {
  let i = 0;
  return (prefix) => `${prefix}-${++i}`;
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

function agentHello(deviceId = 'dev-a', nonce = 'nonce-a') {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `hello-${deviceId}-${nonce}`,
    type: 'agent.hello',
    sentAt: '2026-07-16T00:00:00.000Z',
    deviceId,
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      device: device({ deviceId }),
      supportedMessageTypes: ['agent.hello', 'agent.presence', 'agent.execution.event'],
      sessionNonce: nonce,
      sentAt: '2026-07-16T00:00:00.000Z'
    }
  };
}

function presence(session, status) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `presence-${status}`,
    type: 'agent.presence',
    sentAt: '2026-07-16T00:00:00.000Z',
    deviceId: session.deviceId,
    sessionId: session.sessionId,
    payload: { deviceId: session.deviceId, status, lastSeenAt: '2026-07-16T00:00:00.000Z', generation: session.generation }
  };
}

function revision() {
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
    profilePayload: { id: 'wf-1', steps: [] }
  };
  value.contentHash = createWorkflowContentHash(value);
  return value;
}

function dispatchArgs(session, overrides = {}) {
  return {
    deviceId: session.deviceId,
    generation: session.generation,
    workflowId: 'wf-1',
    workflowRevision: 1,
    workflowContentHash: revision().contentHash,
    inputs: {},
    deadline: '2026-07-16T00:05:00.000Z',
    idempotencyKey: 'dispatch',
    ...overrides
  };
}

function executionResult(session, jobId) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `result-${jobId}-${session.sessionId}`,
    type: 'execution.result',
    sentAt: '2026-07-16T00:00:01.000Z',
    deadline: '2026-07-16T00:05:00.000Z',
    idempotencyKey: `result-${jobId}`,
    deviceId: session.deviceId,
    sessionId: session.sessionId,
    jobId,
    payload: { jobId, eventType: 'job_succeeded', sentAt: '2026-07-16T00:00:01.000Z', result: { ok: true }, generation: session.generation }
  };
}

function executionEvent(session, jobId, eventType) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `${eventType}-${jobId}-${session.sessionId}`,
    type: 'agent.execution.event',
    sentAt: '2026-07-16T00:00:01.000Z',
    deadline: '2026-07-16T00:05:00.000Z',
    idempotencyKey: `${eventType}-${jobId}`,
    deviceId: session.deviceId,
    sessionId: session.sessionId,
    jobId,
    payload: { jobId, eventType, sentAt: '2026-07-16T00:00:01.000Z', generation: session.generation }
  };
}
