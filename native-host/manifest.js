import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  if (scope === 'system') {
    if (browser === 'chromium') return path.join('/etc/chromium/native-messaging-hosts', fileName);
    return path.join('/etc/opt/chrome/native-messaging-hosts', fileName);
  }
  if (browser === 'chromium') return path.join(home, '.config', 'chromium', 'NativeMessagingHosts', fileName);
  return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', fileName);
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
