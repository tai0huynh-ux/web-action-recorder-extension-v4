import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createControllerSettingsStore, normalizeSettings } from '../src/settingsStore.js';

test('settings default to Vietnamese and bounded workspace layout', () => {
  assert.deepEqual(normalizeSettings({}), {
    locale: 'vi',
    workspace: { leftWidth: 280, centerWidth: 420, graphCollapsed: false },
  });
  assert.deepEqual(normalizeSettings({ locale: 'fr', workspace: { leftWidth: 1, centerWidth: 999, graphCollapsed: true } }), {
    locale: 'vi',
    workspace: { leftWidth: 220, centerWidth: 600, graphCollapsed: true },
  });
});

test('settings persist locale and panel layout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'war-settings-test-'));
  const filePath = path.join(root, 'controller-settings.json');
  const store = createControllerSettingsStore({ fs: await import('node:fs'), path, filePath });
  assert.equal((await store.get()).locale, 'vi');
  const saved = await store.update({ locale: 'en', workspace: { leftWidth: 320, centerWidth: 500, graphCollapsed: true } });
  assert.equal(saved.locale, 'en');
  assert.deepEqual(await store.get(), saved);
  await fs.rm(root, { recursive: true, force: true });
});

test('settings retain validated SSH host metadata without accepting unsafe fields', () => {
  const value = normalizeSettings({
    containerHosts: [{
      id: 'ssh-host-1',
      name: 'Reviewed Linux',
      target: 'root@192.168.1.201',
      identityFile: 'C:/Users/test/.ssh/id_ed25519',
      controllerCaPath: '/etc/war/controller-ca.pem',
      seccompProfilePath: '/etc/war/security/chromium-userns-seccomp.json',
      extra: 'discarded',
    }],
  });

  assert.equal(value.containerHosts.length, 1);
  assert.equal(value.containerHosts[0].target, 'root@192.168.1.201');
  assert.equal(Object.hasOwn(value.containerHosts[0], 'extra'), false);
});
