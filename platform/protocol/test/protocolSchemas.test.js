import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

async function readSchema(fileName) {
  return JSON.parse(await readFile(new URL(fileName, schemaBase), 'utf8'));
}
