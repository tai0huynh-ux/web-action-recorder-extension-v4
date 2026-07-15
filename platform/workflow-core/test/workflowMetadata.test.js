import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeWorkflowMetadata,
  createWorkflowContentHash,
  createWorkflowRevisionMetadata
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
