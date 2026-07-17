import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateDeviceIdentity } from '../src/deviceIdentity.js';

test('creates identity on first run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-device-'));
  const identity = loadOrCreateDeviceIdentity(dir, () => new Date('2026-07-14T00:00:00.000Z'));
  assert.equal(identity.schemaVersion, 1);
  assert.match(identity.deviceId, /^[0-9a-f-]{36}$/);
  assert.equal(identity.createdAt, '2026-07-14T00:00:00.000Z');
});

test('reads back same deviceId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-device-'));
  const first = loadOrCreateDeviceIdentity(dir);
  const second = loadOrCreateDeviceIdentity(dir);
  assert.equal(second.deviceId, first.deviceId);
});

test('managed device id is used only for first-run identity provisioning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-device-'));
  const first = loadOrCreateDeviceIdentity(dir, () => new Date('2026-07-14T00:00:00.000Z'), 'managed-device-1');
  const second = loadOrCreateDeviceIdentity(dir, () => new Date('2026-07-15T00:00:00.000Z'), 'managed-device-2');
  assert.equal(first.deviceId, 'managed-device-1');
  assert.equal(second.deviceId, 'managed-device-1');
});

test('corrupt identity file is controlled error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-device-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'identity.json'), '{bad');
  assert.throws(() => loadOrCreateDeviceIdentity(dir), /Device identity could not be read/);
});

test('identity write is atomic enough to leave final schema file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-device-'));
  loadOrCreateDeviceIdentity(dir);
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['identity.json']);
});
