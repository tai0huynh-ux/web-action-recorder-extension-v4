#!/usr/bin/env node
import {
  createNativeHostManifest,
  DEFAULT_NATIVE_HOST_NAME,
  resolveManifestPath,
  uninstallManifest,
  writeManifestAtomic
} from './manifest.js';

export function main(argv = process.argv.slice(2), env = process.env) {
  const uninstall = argv.includes('--uninstall');
  const browser = readArg(argv, '--browser') || env.WAR_NATIVE_BROWSER || 'chrome';
  const scope = readArg(argv, '--scope') || env.WAR_NATIVE_SCOPE || 'user';
  const name = env.WAR_NATIVE_HOST_NAME || DEFAULT_NATIVE_HOST_NAME;
  const targetPath = resolveManifestPath({ browser, scope, name });
  if (uninstall) {
    const removed = uninstallManifest(targetPath, name);
    console.error(JSON.stringify({ level: 'info', component: 'native-host-installer', event: 'uninstall', removed, targetPath }));
    return { removed, targetPath };
  }
  const manifest = createNativeHostManifest({
    extensionId: env.WAR_EXTENSION_ID,
    hostPath: env.WAR_NATIVE_HOST_PATH,
    name
  });
  writeManifestAtomic(targetPath, manifest);
  console.error(JSON.stringify({ level: 'info', component: 'native-host-installer', event: 'install', targetPath }));
  return { targetPath, manifest };
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
