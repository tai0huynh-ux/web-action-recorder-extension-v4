import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { copyFiles, ensureDir, execFileP, packageVersion, RELEASE_CHANNEL, rmDir, rootPath, writeJson } from './release-utils.mjs';
import { controllerFiles } from './release-files.mjs';
import { createTrustedWindowsReleaseEnvironment } from './trusted-windows-release-env.mjs';

const ELECTRON_ARCHIVE_NAME = 'electron-v43.1.1-win32-x64.zip';
const ELECTRON_ARCHIVE_SHA256 = 'b4e9995cd3f65785eb8818276aa9020f3165ab11da41b3c762616d4a0ad8c7ad';
const mode = process.argv.includes('--dist') ? 'dist' : 'dir';
const stage = rootPath('dist', 'release-work', 'controller-electron-app');
const rootPackage = JSON.parse(await fsp.readFile(rootPath('package.json'), 'utf8'));
const verifiedElectronSha256Dist = await prepareCachedElectron(rootPackage.devDependencies.electron);
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

async function prepareCachedElectron(pinnedElectronVersion) {
  if (process.platform !== 'win32') return null;
  const electronCacheRoot = process.env.ELECTRON_CACHE
    ? path.resolve(process.env.ELECTRON_CACHE)
    : process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'electron', 'Cache')
      : null;
  if (!electronCacheRoot) return null;

  try {
    const realCacheRoot = await fsp.realpath(electronCacheRoot);
    const cacheArchive = path.resolve(realCacheRoot, ELECTRON_ARCHIVE_NAME);
    if (!isWithin(realCacheRoot, cacheArchive)) return null;

    const realCacheArchive = await fsp.realpath(cacheArchive);
    if (!isWithin(realCacheRoot, realCacheArchive)) return null;

    const cacheArchiveStat = await fsp.lstat(cacheArchive);
    if (!cacheArchiveStat.isFile() || cacheArchiveStat.isSymbolicLink()) return null;

    const cacheStage = rootPath('dist', 'release-work', 'controller-electron-cache');
    const stagedArchive = path.join(cacheStage, ELECTRON_ARCHIVE_NAME);
    await rmDir(cacheStage);
    await ensureDir(cacheStage);
    await fsp.copyFile(cacheArchive, stagedArchive);

    const archiveHash = createHash('sha256');
    for await (const chunk of fs.createReadStream(stagedArchive)) archiveHash.update(chunk);
    const archiveChecksum = archiveHash.digest('hex');
    if (archiveChecksum !== ELECTRON_ARCHIVE_SHA256) return null;

    const extractedDist = rootPath('dist', 'release-work', 'controller-electron-dist');
    await rmDir(extractedDist);
    await ensureDir(extractedDist);
    const { createTrustedTarExtractor } = await import('./trusted-windows-tar.mjs');
    const extractTrustedTar = createTrustedTarExtractor({ execFileP });
    await extractTrustedTar({ archivePath: stagedArchive, destinationPath: extractedDist });

    const extractedVersion = await fsp.readFile(path.join(extractedDist, 'version'), 'utf8');
    const electronExeStat = await fsp.lstat(path.join(extractedDist, 'electron.exe'));
    if (
      extractedVersion.trim() !== pinnedElectronVersion ||
      !electronExeStat.isFile() ||
      electronExeStat.isSymbolicLink()
    ) return null;

    return extractedDist;
  } catch {
    return null;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const env = { ...process.env, WAR_RELEASE_CHANNEL: RELEASE_CHANNEL };
if (env.WAR_WINDOWS_SIGN_CERT_PATH && !env.CSC_LINK) env.CSC_LINK = env.WAR_WINDOWS_SIGN_CERT_PATH;
if (env.WAR_WINDOWS_SIGN_CERT_PASSWORD && !env.CSC_KEY_PASSWORD) env.CSC_KEY_PASSWORD = env.WAR_WINDOWS_SIGN_CERT_PASSWORD;
const config = rootPath('platform', 'controller-electron', 'release', 'electron-builder.config.cjs');
const args = [
  '--projectDir', stage,
  '--config', config,
  '--win',
  '--x64',
  '--publish=never'
];
if (mode === 'dir') args.push('--dir');
if (verifiedElectronSha256Dist) {
  args.push(`--config.electronDist=${verifiedElectronSha256Dist}`);
}
const electronBuilderCli = rootPath('node_modules', 'electron-builder', 'cli.js');
const trustedWindowsReleaseEnv = await createTrustedWindowsReleaseEnvironment({ environment: env });
await execFileP(process.execPath, [electronBuilderCli, ...args], { env: trustedWindowsReleaseEnv });
console.log(`controllerElectron=${rootPath('dist', 'release', 'controller-electron')}`);
console.log(`version=${await packageVersion()}`);
