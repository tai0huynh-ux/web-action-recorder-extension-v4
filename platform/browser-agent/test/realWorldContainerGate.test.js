import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as realWorldGate from '../integration/realWorldContainerGate.js';

test('prepares a bind-mounted data directory for the explicit container user without replacing seeded state', async () => {
  assert.equal(typeof realWorldGate.prepareContainerDataDir, 'function', 'real-world gate must expose its data-dir preparation helper');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'war-real-world-data-dir-'));
  const dataDir = path.join(root, 'data');
  const seededFiles = new Map([
    ['device/identity.json', '{"deviceId":"seeded-device"}\n'],
    ['workflows/registry.json', '{"workflowId":"seeded-workflow","revision":3}\n'],
  ]);
  const calls = { chown: [], chmod: [] };
  const fsOps = {
    ...fs,
    chown: async (target, uid, gid) => calls.chown.push({ target, uid, gid }),
    chmod: async (target, mode) => calls.chmod.push({ target, mode }),
  };

  await fs.mkdir(path.join(dataDir, 'device'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'workflows'), { recursive: true });
  for (const [relativePath, contents] of seededFiles) {
    await fs.writeFile(path.join(dataDir, relativePath), contents);
  }

  await realWorldGate.prepareContainerDataDir(dataDir, {
    uid: 1000,
    gid: 1000,
    fsOps,
  });

  const relativePreparedPath = (target) => (path.relative(dataDir, target) || '.').replaceAll(path.sep, '/');
  const preparedPaths = new Set(calls.chown.map(({ target }) => relativePreparedPath(target)));
  for (const relativePath of ['.', 'device', 'workflows', 'device/identity.json', 'workflows/registry.json']) {
    assert.equal(preparedPaths.has(relativePath), true, `${relativePath} must be prepared for the container user`);
  }
  assert(calls.chown.length >= 5, 'ownership must be applied recursively before Docker launch');
  assert(calls.chown.every(({ uid, gid }) => uid === 1000 && gid === 1000), 'all prepared paths must use the explicit container UID/GID');

  const writableModes = calls.chmod.filter(({ target }) => preparedPaths.has(relativePreparedPath(target)));
  assert(writableModes.length >= 3, 'bind-mounted data directories must receive writable modes');
  assert(writableModes.every(({ mode }) => (mode & 0o200) !== 0), 'prepared directories must be writable by their owner');

  for (const [relativePath, contents] of seededFiles) {
    assert.equal(await fs.readFile(path.join(dataDir, relativePath), 'utf8'), contents, `${relativePath} must remain intact`);
  }
});
