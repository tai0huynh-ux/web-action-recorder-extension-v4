import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildWindowsNativeHostShim,
  createNativeHostManifest,
  createShimConfig,
  deleteRegistryKey,
  findCsc,
  nativeMessagingRegistryKey,
  sanitizeCompilerOutput
} from '../integration/windowsNativeHostShim.js';

test('Windows native host manifest uses an exe and exact allowed origin', () => {
  const manifest = createNativeHostManifest({
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    executablePath: 'C:\\Temp\\war-native-host-shim.exe'
  });
  assert.equal(manifest.path.endsWith('.exe'), true);
  assert.equal(manifest.path.includes('.cmd'), false);
  assert.equal(manifest.path.includes('.bat'), false);
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/']);
});

test('Windows native host helper resolves Edge registry key', () => {
  assert.equal(
    nativeMessagingRegistryKey('edge'),
    'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.web_action_recorder.native_bridge'
  );
});

test('Windows native host shim config is deterministic and rejects injected newlines', () => {
  const config = createShimConfig({
    nodePath: 'C:\\Node\\node.exe',
    hostScriptPath: 'C:\\Repo\\native-host\\host.js',
    socketPath: '\\\\.\\pipe\\war-e2e'
  });
  assert.deepEqual(config.split('\n').slice(0, 3), [
    'C:\\Node\\node.exe',
    'C:\\Repo\\native-host\\host.js',
    '\\\\.\\pipe\\war-e2e'
  ]);
  assert.throws(() => createShimConfig({
    nodePath: 'C:\\Node\\node.exe\nbad',
    hostScriptPath: 'C:\\Repo\\native-host\\host.js',
    socketPath: '\\\\.\\pipe\\war-e2e'
  }), /newlines/);
});

test('Windows native host compiler diagnostics are sanitized', () => {
  const sanitized = sanitizeCompilerOutput(`${os.homedir()}\\secret\\file.cs: error`);
  assert.equal(sanitized.includes(os.homedir()), false);
  assert.equal(sanitized.includes('<home>'), true);
});

test('Windows native host cleanup is idempotent for missing test key', async () => {
  await deleteRegistryKey('HKCU\\Software\\OpenAI\\WARMissingNativeHostTestKey');
  await deleteRegistryKey('HKCU\\Software\\OpenAI\\WARMissingNativeHostTestKey');
});

test('Windows native host shim compiles to a temp MZ executable when csc is available', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only compile test');
  const cscPath = findCsc();
  if (!cscPath) return t.skip('No Windows C# compiler available');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'war-shim-unit-'));
  try {
    const built = await buildWindowsNativeHostShim({
      outputDir: root,
      hostScriptPath: path.resolve('native-host/host.js'),
      socketPath: '\\\\.\\pipe\\war-unit-test',
      cscPath
    });
    const stat = await fs.stat(built.exePath);
    assert.equal(path.dirname(built.exePath), root);
    assert.equal(path.extname(built.exePath).toLowerCase(), '.exe');
    assert.ok(stat.size > 0);
    assert.equal((await fs.readFile(built.exePath)).subarray(0, 2).toString('ascii'), 'MZ');
    assert.equal((await fs.readFile(built.configPath, 'utf8')).includes('native-host\\host.js'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
