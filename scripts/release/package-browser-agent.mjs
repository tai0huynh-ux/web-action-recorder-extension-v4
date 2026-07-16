import path from 'node:path';
import { copyFileTo, copyFiles, deterministicZip, ensureDir, packageVersion, RELEASE_CHANNEL, rmDir, rootPath, writeJson, writeText } from './release-utils.mjs';
import { browserAgentFiles } from './release-files.mjs';

const version = await packageVersion();
const outDir = rootPath('dist', 'release', 'browser-agent');
const stage = rootPath('dist', 'release-work', 'browser-agent');
await rmDir(stage);
await ensureDir(outDir);
await copyFiles(browserAgentFiles, stage);
await copyNodeModule('ws');
await copyNodeModule('playwright-core');
await writeJson(path.join(stage, 'package.json'), {
  name: 'war-browser-agent-bundle',
  version,
  type: 'module',
  private: true,
  scripts: {
    start: 'node platform/browser-agent/src/agent.js',
    'native-host:install': 'node native-host/install.js',
    'native-host:uninstall': 'node native-host/install.js --uninstall'
  },
  dependencies: {
    'playwright-core': '1.61.1',
    ws: '8.21.1'
  }
});
await writeText(path.join(stage, 'RELEASE_STARTUP.md'), [
  '# WAR Browser Agent Bundle',
  '',
  'Run with external configuration only. Do not store credentials in this bundle.',
  '',
  '```powershell',
  '$env:WAR_AGENT_DATA_DIR="C:\\\\path\\\\to\\\\agent-data"',
  '$env:WAR_CONTROLLER_WSS_URL="wss://127.0.0.1:PORT/v1/agent-session"',
  '$env:WAR_CONTROLLER_CREDENTIAL="<credential from Controller pairing>"',
  'npm.cmd run start',
  '```',
  '',
  'Native Messaging install on Windows uses:',
  '',
  '```powershell',
  '$env:WAR_EXTENSION_ID="<32-char extension id>"',
  '$env:WAR_NATIVE_HOST_PATH="<absolute path to node-native-host wrapper or executable>"',
  '$env:WAR_NATIVE_MANIFEST_PATH="<absolute manifest path>"',
  'npm.cmd run native-host:install -- --browser edge',
  '```',
  ''
].join('\n'));
const zipPath = path.join(outDir, `WAR-Browser-Agent-${RELEASE_CHANNEL}-${version}-windows-x64.zip`);
await deterministicZip(stage, zipPath);
console.log(`browserAgent=${zipPath}`);

async function copyNodeModule(name) {
  const moduleRoot = rootPath('node_modules', name);
  const files = await import('./release-utils.mjs').then((mod) => mod.listFiles(moduleRoot));
  for (const file of files) {
    const rel = path.relative(rootPath(), file);
    if (rel.includes(`${path.sep}test${path.sep}`) || rel.includes(`${path.sep}tests${path.sep}`)) continue;
    await copyFileTo(file, path.join(stage, rel));
  }
}
