import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControllerRuntimeProfileStore } from '../src/runtimeProfileStore.js';

const PROFILE = Object.freeze({
  schemaVersion: 1,
  wss: {
    enabled: true,
    host: '192.168.1.20',
    port: 47651,
    lanBindingApproved: true,
    certificatePath: 'C:/tls/controller.crt',
    privateKeyPath: 'C:/tls/controller.key',
  },
});

test('runtime profile persists only validated WSS metadata without TLS contents', async () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'war-runtime-profile-')), 'controller-runtime.json');
  const store = createControllerRuntimeProfileStore({ fs, path, filePath });

  await store.save(PROFILE);
  const loaded = await store.load();
  const stored = fs.readFileSync(filePath, 'utf8');

  assert.equal(loaded.status, 'loaded');
  assert.deepEqual(loaded.profile, PROFILE);
  assert.equal(stored.includes('-----BEGIN'), false);
  assert.equal(stored.includes('private-key-contents'), false);
});

test('runtime profile rejects corrupt JSON and unknown schema visibly', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'war-runtime-profile-'));
  const filePath = path.join(directory, 'controller-runtime.json');
  const store = createControllerRuntimeProfileStore({ fs, path, filePath });

  fs.writeFileSync(filePath, '{not-json');
  const corrupt = await store.load();
  assert.equal(corrupt.status, 'invalid');
  assert.match(corrupt.error, /runtime profile/i);

  fs.writeFileSync(filePath, JSON.stringify({ ...PROFILE, schemaVersion: 2 }));
  const unknownSchema = await store.load();
  assert.equal(unknownSchema.status, 'invalid');
  assert.match(unknownSchema.error, /schema/i);
});
