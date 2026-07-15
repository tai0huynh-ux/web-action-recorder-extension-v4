import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeWorkflowMetadata,
  createWorkflowContentHash,
  createWorkflowRevisionFromExtensionProfile,
  createWorkflowRevisionMetadata,
  extensionProfileFromWorkflowRevision,
  inferInputDefinitions
} from '../src/workflowMetadata.js';

test('content hash is deterministic for logically identical metadata with different key order', () => {
  const first = {
    workflowId: 'wf-1',
    revision: 1,
    name: 'Login',
    schemaVersion: 'war-workflow.v1',
    requiredInputs: ['email', 'password'],
    steps: [{ id: 'a', type: 'log', config: { message: 'hello', level: 'info' } }],
    createdAt: '2026-07-14T01:00:00.000Z',
    updatedAt: '2026-07-14T02:00:00.000Z',
    sourceDeviceId: 'dev-a'
  };
  const second = {
    sourceDeviceId: 'dev-b',
    updatedAt: '2026-07-14T03:00:00.000Z',
    createdAt: '2026-07-14T00:00:00.000Z',
    steps: [{ type: 'log', config: { level: 'info', message: 'hello' }, id: 'a' }],
    requiredInputs: ['email', 'password'],
    schemaVersion: 'war-workflow.v1',
    name: 'Login',
    revision: 9,
    workflowId: 'wf-1'
  };

  assert.equal(createWorkflowContentHash(first), createWorkflowContentHash(second));
  assert.deepEqual(canonicalizeWorkflowMetadata(first), canonicalizeWorkflowMetadata(second));
});

test('content hash changes when workflow content changes', () => {
  const base = { workflowId: 'wf-1', name: 'A', schemaVersion: 'war-workflow.v1', steps: [{ id: 'a', type: 'log' }] };
  const changed = { ...base, steps: [{ id: 'a', type: 'click' }] };
  assert.notEqual(createWorkflowContentHash(base), createWorkflowContentHash(changed));
});

test('revision metadata includes required fields and stable content hash', () => {
  const metadata = createWorkflowRevisionMetadata({
    workflowId: 'wf-1',
    revision: 3,
    name: 'Login',
    schemaVersion: 'war-workflow.v1',
    createdAt: '2026-07-14T01:00:00.000Z',
    updatedAt: '2026-07-14T02:00:00.000Z',
    sourceDeviceId: 'dev-a',
    requiredInputs: ['email'],
    steps: [{ id: 'a', type: 'log' }]
  });

  assert.equal(metadata.workflowId, 'wf-1');
  assert.equal(metadata.revision, 3);
  assert.equal(metadata.name, 'Login');
  assert.equal(metadata.schemaVersion, 'war-workflow.v1');
  assert.equal(metadata.createdAt, '2026-07-14T01:00:00.000Z');
  assert.equal(metadata.updatedAt, '2026-07-14T02:00:00.000Z');
  assert.equal(metadata.sourceDeviceId, 'dev-a');
  assert.deepEqual(metadata.requiredInputs, ['email']);
  assert.match(metadata.contentHash, /^[a-f0-9]{64}$/);
});

test('workflow profile converts to revision with profile payload', () => {
  const revision = createWorkflowRevisionFromExtensionProfile(sampleProfile(), revisionOptions());
  assert.equal(revision.workflowId, 'profile-1');
  assert.equal(revision.revision, 2);
  assert.equal(revision.schemaVersion, 'war-workflow-revision.v2');
  assert.equal(revision.sourceDeviceId, 'dev-a');
  assert.match(revision.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(revision.profilePayload.id, 'profile-1');
});

test('revision converts back to extension profile payload', () => {
  const revision = createWorkflowRevisionFromExtensionProfile(sampleProfile(), revisionOptions());
  const profile = extensionProfileFromWorkflowRevision(revision);
  assert.equal(profile.id, 'profile-1');
  assert.equal(profile.name, 'Checkout');
  assert.equal(profile.steps.length, 3);
});

test('workflow round-trip preserves graph semantics', () => {
  const original = createWorkflowRevisionFromExtensionProfile(sampleProfile(), revisionOptions()).profilePayload;
  const restored = extensionProfileFromWorkflowRevision(createWorkflowRevisionFromExtensionProfile(original, revisionOptions()));
  assert.deepEqual(restored.steps.map((step) => ({ id: step.id, next: step.next, ifSteps: step.ifSteps, elseSteps: step.elseSteps })), [
    { id: 's1', next: 's2', ifSteps: [], elseSteps: [] },
    { id: 's2', next: 's3', ifSteps: [], elseSteps: [] },
    { id: 's3', next: null, ifSteps: [], elseSteps: [] }
  ]);
});

test('workflow revision content hash is deterministic', () => {
  const first = createWorkflowRevisionFromExtensionProfile(sampleProfile(), revisionOptions());
  const second = createWorkflowRevisionFromExtensionProfile({ ...sampleProfile(), updatedAt: '2026-07-14T03:00:00.000Z' }, revisionOptions({ updatedAt: '2026-07-14T03:00:00.000Z' }));
  assert.equal(first.contentHash, second.contentHash);
});

test('runtime-only state is removed from profile payload', () => {
  const revision = createWorkflowRevisionFromExtensionProfile(sampleProfile(), revisionOptions());
  assert.equal('runState' in revision.profilePayload, false);
  assert.equal('isRoot' in revision.profilePayload.steps[0], false);
  assert.equal('leaseId' in revision.profilePayload.steps[0], false);
});

test('secret plaintext is removed from workflow revision payload', () => {
  const revision = createWorkflowRevisionFromExtensionProfile(sampleProfile(), revisionOptions());
  const passwordStep = revision.profilePayload.steps.find((step) => step.id === 's2');
  assert.equal(passwordStep.text, undefined);
  assert.equal(passwordStep.requiresSecretPrompt, true);
  assert.equal(JSON.stringify(revision), JSON.stringify(revision).replace('super-secret-password', ''));
});

test('input definitions are inferred from templates and sensitive prompts', () => {
  const definitions = inferInputDefinitions(createWorkflowRevisionFromExtensionProfile(sampleProfile(), revisionOptions()).profilePayload);
  assert.deepEqual(definitions.map((item) => ({ name: item.name, index: item.index, sensitive: item.sensitive })), [
    { name: 'account', index: 0, sensitive: false },
    { name: 'nhap_mat_khau', index: 1, sensitive: true },
    { name: 'otp_code', index: 2, sensitive: true }
  ]);
});

function sampleProfile() {
  return {
    id: 'profile-1',
    name: 'Checkout',
    description: 'Profile for contract tests',
    schemaVersion: 1,
    enabled: true,
    allowHighRisk: false,
    runState: { running: true },
    steps: [
      {
        id: 's1',
        name: 'Type account',
        type: 'type',
        selector: '#account',
        text: '{{account}}',
        next: 's2',
        ifSteps: [],
        elseSteps: [],
        isRoot: true,
        leaseId: 'lease-a'
      },
      {
        id: 's2',
        name: 'Nhap mat khau',
        type: 'type',
        selector: '#password',
        text: 'super-secret-password',
        requiresSecretPrompt: true,
        next: 's3',
        ifSteps: [],
        elseSteps: []
      },
      {
        id: 's3',
        name: 'OTP condition',
        type: 'condition',
        condition: { kind: 'text', operator: 'contains', selector: '#otp', value: '{{otp_code}}' },
        next: null,
        ifSteps: [],
        elseSteps: []
      }
    ]
  };
}

function revisionOptions(overrides = {}) {
  return {
    revision: 2,
    sourceDeviceId: 'dev-a',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T01:00:00.000Z',
    now: '2026-07-14T01:00:00.000Z',
    ...overrides
  };
}
