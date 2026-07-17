import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createExecutionJobFromCompanionCommand, mapCompanionStatusToExecutionJobStatus } from '../src/companionStatusAdapter.js';
import {
  DEVICE_CAPABILITY_KEYS,
  EXECUTION_JOB_STATUSES,
  PROTOCOL_VERSION,
  validateAgentEnvelope,
  validateControllerEnvelope,
  validateEnvelope,
  validateNativeBridgeEnvelope
} from '../src/protocolV2.js';
import { validateSchemaValue } from '../src/schemaValidator.js';

const schemaBase = new URL('../schemas/', import.meta.url);

test('control envelope schema accepts a minimal valid envelope and rejects missing required fields', async () => {
  const schema = await readSchema('war-control-envelope.v1.schema.json');
  const valid = {
    protocol: 'war-control.v1',
    messageId: 'msg-1',
    type: 'command.dispatch',
    deviceId: 'dev-a',
    timestamp: '2026-07-14T00:00:00.000Z',
    deadlineMs: 30000,
    idempotencyKey: 'idem-1',
    payload: {}
  };

  assert.equal(validateSchemaValue(schema, valid).ok, true);
  const invalid = { ...valid };
  delete invalid.payload;
  assert.equal(validateSchemaValue(schema, invalid).ok, false);
});

test('command status schema locks allowed command states', async () => {
  const schema = await readSchema('command-status.v1.schema.json');
  for (const status of ['accepted', 'running', 'succeeded', 'failed', 'cancelled']) {
    assert.equal(validateSchemaValue(schema, { status }).ok, true);
  }
  assert.equal(validateSchemaValue(schema, { status: 'paused' }).ok, false);
});

test('workflow revision metadata schema validates required metadata contract', async () => {
  const schema = await readSchema('workflow-revision-metadata.v1.schema.json');
  const valid = {
    workflowId: 'wf-1',
    revision: 1,
    contentHash: 'a'.repeat(64),
    name: 'Login',
    schemaVersion: 'war-workflow.v1',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T01:00:00.000Z',
    sourceDeviceId: 'dev-a',
    requiredInputs: ['email']
  };

  assert.equal(validateSchemaValue(schema, valid).ok, true);
  assert.equal(validateSchemaValue(schema, { ...valid, contentHash: 'bad' }).ok, false);
});

test('valid AgentEnvelope carries AgentHello contract', () => {
  assert.equal(validateAgentEnvelope(agentEnvelope()).ok, true);
});

test('valid ControllerEnvelope carries DispatchPlan contract', () => {
  assert.equal(validateControllerEnvelope(controllerEnvelope()).ok, true);
});

test('valid NativeBridgeEnvelope carries bridge request contract', () => {
  assert.equal(validateNativeBridgeEnvelope(nativeBridgeEnvelope()).ok, true);
});

test('unknown message type is rejected', () => {
  const result = validateAgentEnvelope({ ...agentEnvelope(), type: 'agent.unknown' });
  assert.equal(result.ok, false);
  assert.match(result.errors.map((item) => item.message).join('\n'), /Unknown message type/);
});

test('wrong protocol version is rejected', () => {
  const result = validateAgentEnvelope({ ...agentEnvelope(), protocolVersion: 'war-control.v1' });
  assert.equal(result.ok, false);
  assert.match(result.errors.map((item) => item.path).join('\n'), /\$\.protocolVersion/);
});

test('unknown top-level property is rejected', () => {
  const result = validateAgentEnvelope({ ...agentEnvelope(), unexpected: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.map((item) => item.path).join('\n'), /\$\.unexpected/);
});

test('oversized string is rejected', () => {
  const result = validateAgentEnvelope({ ...agentEnvelope(), messageId: 'x'.repeat(4097) });
  assert.equal(result.ok, false);
  assert.match(result.errors.map((item) => item.message).join('\n'), /String exceeds/);
});

test('oversized array is rejected', () => {
  const payload = { ...agentEnvelope().payload, supportedMessageTypes: Array.from({ length: 257 }, () => 'agent.hello') };
  const result = validateAgentEnvelope({ ...agentEnvelope(), payload });
  assert.equal(result.ok, false);
  assert.match(result.errors.map((item) => item.message).join('\n'), /Array exceeds/);
});

test('invalid ISO timestamp is rejected', () => {
  const result = validateAgentEnvelope({ ...agentEnvelope(), sentAt: '2026-07-14 00:00:00' });
  assert.equal(result.ok, false);
  assert.match(result.errors.map((item) => item.path).join('\n'), /\$\.sentAt/);
});

test('missing deadline is rejected for mutating command', () => {
  const envelope = controllerEnvelope();
  delete envelope.deadline;
  const result = validateControllerEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.match(result.errors.map((item) => item.path).join('\n'), /\$\.deadline/);
});

test('missing idempotency key is rejected for dispatch', () => {
  const envelope = controllerEnvelope();
  delete envelope.idempotencyKey;
  const result = validateControllerEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.match(result.errors.map((item) => item.path).join('\n'), /\$\.idempotencyKey/);
});

test('origin synchronization envelopes validate bounded inventory and workflow payloads', () => {
  const inventory = {
    ...agentEnvelope(),
    type: 'origin.inventory.response',
    payload: {
      workflows: [{
        workflowId: 'wf-origin',
        revision: 1,
        contentHash: 'b'.repeat(64),
        name: 'Origin',
        updatedAt: '2026-07-14T00:00:00.000Z'
      }]
    }
  };
  assert.equal(validateAgentEnvelope(inventory).ok, false);
  assert.equal(validateEnvelope(inventory).ok, true);
  assert.equal(validateEnvelope({ ...inventory, payload: { workflows: [{ ...inventory.payload.workflows[0], contentHash: 'bad' }] } }).ok, false);
  assert.equal(validateEnvelope({ ...inventory, type: 'origin.workflow.get', payload: { workflowId: 'wf-origin', revision: 1 } }).ok, true);
  assert.equal(validateEnvelope({ ...inventory, type: 'origin.workflow.response', payload: { workflow: workflowRevision() } }).ok, true);
  assert.equal(validateEnvelope({ ...inventory, type: 'origin.workflow.response', payload: { error: { code: 'WORKFLOW_NOT_FOUND', message: 'missing' } } }).ok, true);
});

test('companion status compatibility mapping normalizes leased commands', () => {
  assert.equal(mapCompanionStatusToExecutionJobStatus('leased'), 'dispatched');
  const job = createExecutionJobFromCompanionCommand({
    id: 'cmd-1',
    batchId: 'batch-1',
    deviceId: 'dev-a',
    profileId: 'wf-1',
    status: 'leased',
    attempt: 1,
    leaseUntil: '2026-07-14T00:01:00.000Z',
    notBefore: '2026-07-14T00:00:00.000Z'
  });
  assert.equal(job.status, 'dispatched');
  assert.equal(job.workflowRevision, 1);
});

test('unified execution status enum consistency', () => {
  assert.deepEqual(EXECUTION_JOB_STATUSES, [
    'queued',
    'dispatched',
    'acknowledged',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'timed_out'
  ]);
  assert.throws(() => mapCompanionStatusToExecutionJobStatus('paused'), /Unsupported companion status/);
});

async function readSchema(fileName) {
  return JSON.parse(await readFile(new URL(fileName, schemaBase), 'utf8'));
}

function agentEnvelope() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'msg-agent-1',
    type: 'agent.hello',
    sentAt: '2026-07-14T00:00:00.000Z',
    deviceId: 'dev-a',
    sessionId: 'session-a',
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      device: deviceDescriptor(),
      supportedMessageTypes: ['agent.hello', 'agent.presence', 'agent.execution.event'],
      sessionNonce: 'nonce-a',
      sentAt: '2026-07-14T00:00:00.000Z'
    }
  };
}

function controllerEnvelope() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'msg-controller-1',
    type: 'controller.dispatch.create',
    sentAt: '2026-07-14T00:00:00.000Z',
    correlationId: 'corr-1',
    deadline: '2026-07-14T00:05:00.000Z',
    idempotencyKey: 'idem-1',
    payload: {
      dispatchPlanId: 'dispatch-1',
      createdAt: '2026-07-14T00:00:00.000Z',
      assignments: [
        {
          deviceIds: ['dev-a'],
          groupIds: [],
          allDevices: false,
          workflowId: 'wf-1',
          workflowRevision: 1,
          workflowContentHash: 'a'.repeat(64),
          inputMapping: { account: 'field-0' }
        }
      ],
      targetSnapshot: { deviceIds: ['dev-a'] },
      executionPolicy: { maxAttempts: 1 },
      inputBatchMetadata: { fieldCount: 1 }
    }
  };
}

function nativeBridgeEnvelope() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: 'msg-native-1',
    type: 'native.bridge.request',
    sentAt: '2026-07-14T00:00:00.000Z',
    correlationId: 'corr-native-1',
    deviceId: 'dev-a',
    deadline: '2026-07-14T00:05:00.000Z',
    payload: { operation: 'x11.key', parameters: { key: 'Enter' } }
  };
}

function deviceDescriptor() {
  return {
    deviceId: 'dev-a',
    displayName: 'Browser Agent A',
    hostName: 'host-a',
    platform: 'linux',
    architecture: 'x64',
    agentVersion: '0.1.0',
    extensionVersion: '0.1.0',
    browserVersion: 'Chromium 126',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: Object.fromEntries(DEVICE_CAPABILITY_KEYS.map((key) => [key, key !== 'remoteVideo' && key !== 'clipboardText'])),
    labels: ['lab'],
    groupIds: ['group-a'],
    status: 'online',
    lastSeenAt: '2026-07-14T00:00:00.000Z'
  };
}

function workflowRevision() {
  return {
    workflowId: 'wf-origin',
    revision: 1,
    schemaVersion: 'war-workflow-revision.v2',
    contentHash: 'b'.repeat(64),
    name: 'Origin',
    description: '',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    sourceDeviceId: 'dev-a',
    requiredInputs: [],
    profilePayload: { id: 'wf-origin', steps: [] }
  };
}
