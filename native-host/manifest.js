import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const DEFAULT_NATIVE_HOST_NAME = 'com.web_action_recorder.native_bridge';

export function validateExtensionId(extensionId) {
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error('WAR_EXTENSION_ID must be a 32-character Chrome extension id.');
  }
}

export function createNativeHostManifest({
  extensionId,
  hostPath,
  name = DEFAULT_NATIVE_HOST_NAME,
  description = 'Web Action Recorder native bridge'
}) {
  validateExtensionId(extensionId);
  if (!path.isAbsolute(hostPath)) throw new Error('WAR_NATIVE_HOST_PATH must be absolute.');
  return {
    name,
    description,
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
}

export function resolveManifestPath({ browser = 'chrome', scope = 'user', name = DEFAULT_NATIVE_HOST_NAME, home = os.homedir() } = {}) {
  const fileName = `${name}.json`;
  if (process.platform === 'win32') return path.join(os.tmpdir(), fileName);
  if (scope === 'system') {
    if (browser === 'chromium') return path.join('/etc/chromium/native-messaging-hosts', fileName);
    return path.join('/etc/opt/chrome/native-messaging-hosts', fileName);
  }
  if (browser === 'chromium') return path.join(home, '.config', 'chromium', 'NativeMessagingHosts', fileName);
  return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', fileName);
}

export function nativeMessagingRegistryKey({ browser = 'chrome', name = DEFAULT_NATIVE_HOST_NAME } = {}) {
  if (browser === 'edge') return `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${name}`;
  if (browser === 'chromium') return `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${name}`;
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${name}`;
}

export function installWindowsManifest({ browser = 'chrome', manifestPath, name = DEFAULT_NATIVE_HOST_NAME }) {
  if (process.platform !== 'win32') throw new Error('Windows registry install is only available on Windows.');
  if (!path.isAbsolute(manifestPath)) throw new Error('manifestPath must be absolute.');
  const key = nativeMessagingRegistryKey({ browser, name });
  execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'pipe' });
  return { key, manifestPath };
}

export function uninstallWindowsManifest({ browser = 'chrome', manifestPath, name = DEFAULT_NATIVE_HOST_NAME }) {
  if (process.platform !== 'win32') throw new Error('Windows registry uninstall is only available on Windows.');
  const key = nativeMessagingRegistryKey({ browser, name });
  if (manifestPath && fs.existsSync(manifestPath)) uninstallManifest(manifestPath, name);
  try {
    execFileSync('reg', ['delete', key, '/f'], { stdio: 'pipe' });
    return { key, removed: true };
  } catch {
    return { key, removed: false };
  }
}

export function writeManifestAtomic(targetPath, manifest) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, targetPath);
}

export function uninstallManifest(targetPath, expectedName = DEFAULT_NATIVE_HOST_NAME) {
  if (!fs.existsSync(targetPath)) return false;
  const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  if (parsed?.name !== expectedName) throw new Error('Refusing to remove a manifest not owned by this project.');
  fs.rmSync(targetPath);
  return true;
}
