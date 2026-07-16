#!/usr/bin/env node
import {
  createNativeHostManifest,
  DEFAULT_NATIVE_HOST_NAME,
  installWindowsManifest,
  resolveManifestPath,
  uninstallManifest,
  uninstallWindowsManifest,
  writeManifestAtomic
} from './manifest.js';

export function main(argv = process.argv.slice(2), env = process.env) {
  const uninstall = argv.includes('--uninstall');
  const browser = readArg(argv, '--browser') || env.WAR_NATIVE_BROWSER || 'chrome';
  const scope = readArg(argv, '--scope') || env.WAR_NATIVE_SCOPE || 'user';
  const name = env.WAR_NATIVE_HOST_NAME || DEFAULT_NATIVE_HOST_NAME;
  const targetPath = readArg(argv, '--manifest-path') || env.WAR_NATIVE_MANIFEST_PATH || resolveManifestPath({ browser, scope, name });
  if (uninstall) {
    const result = process.platform === 'win32'
      ? uninstallWindowsManifest({ browser, manifestPath: targetPath, name })
      : { removed: uninstallManifest(targetPath, name), targetPath };
    console.error(JSON.stringify({ level: 'info', component: 'native-host-installer', event: 'uninstall', targetPath, ...result }));
    return { ...result, targetPath };
  }
  const manifest = createNativeHostManifest({
    extensionId: env.WAR_EXTENSION_ID,
    hostPath: env.WAR_NATIVE_HOST_PATH,
    name
  });
  writeManifestAtomic(targetPath, manifest);
  const windows = process.platform === 'win32' ? installWindowsManifest({ browser, manifestPath: targetPath, name }) : null;
  console.error(JSON.stringify({ level: 'info', component: 'native-host-installer', event: 'install', targetPath, registryKey: windows?.key }));
  return { targetPath, manifest, registryKey: windows?.key };
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', component: 'native-host-installer', event: 'failed', message: error.message }));
    process.exit(1);
  }
}
