import path from 'node:path';
import fsp from 'node:fs/promises';
import { copyFiles, ensureDir, execFileP, packageVersion, RELEASE_CHANNEL, rmDir, rootPath, writeJson } from './release-utils.mjs';
import { controllerFiles } from './release-files.mjs';

const mode = process.argv.includes('--dist') ? 'dist' : 'dir';
const stage = rootPath('dist', 'release-work', 'controller-electron-app');
const rootPackage = JSON.parse(await fsp.readFile(rootPath('package.json'), 'utf8'));
await rmDir(stage);
await ensureDir(stage);
await copyFiles(controllerFiles.filter((file) => file !== 'package.json'), stage);
await writeJson(path.join(stage, 'package.json'), {
  name: 'war-controller',
  productName: 'WAR Controller',
  version: rootPackage.version,
  description: rootPackage.description,
  author: rootPackage.author,
  type: 'module',
  main: 'platform/controller-electron/src/main.js',
  dependencies: {
    ws: '8.21.1'
  },
  devDependencies: {}
});

const env = { ...process.env, WAR_RELEASE_CHANNEL: RELEASE_CHANNEL };
if (env.WAR_WINDOWS_SIGN_CERT_PATH && !env.CSC_LINK) env.CSC_LINK = env.WAR_WINDOWS_SIGN_CERT_PATH;
if (env.WAR_WINDOWS_SIGN_CERT_PASSWORD && !env.CSC_KEY_PASSWORD) env.CSC_KEY_PASSWORD = env.WAR_WINDOWS_SIGN_CERT_PASSWORD;
const config = rootPath('platform', 'controller-electron', 'release', 'electron-builder.config.cjs');
const args = [
  'electron-builder',
  '--projectDir', stage,
  '--config', config,
  '--win',
  '--x64',
  '--publish=never'
];
if (mode === 'dir') args.push('--dir');
await execFileP(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { env });
console.log(`controllerElectron=${rootPath('dist', 'release', 'controller-electron')}`);
console.log(`version=${await packageVersion()}`);
