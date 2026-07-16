import path from 'node:path';
import { copyFiles, deterministicZip, ensureDir, packageVersion, RELEASE_CHANNEL, rmDir, rootPath } from './release-utils.mjs';
import { extensionFiles } from './release-files.mjs';

const version = await packageVersion();
const outDir = rootPath('dist', 'release', 'extension');
const stage = rootPath('dist', 'release-work', 'mv3-extension');
await rmDir(stage);
await ensureDir(outDir);
await copyFiles(extensionFiles, stage);
await deterministicZip(stage, path.join(outDir, `WAR-MV3-Extension-${RELEASE_CHANNEL}-${version}.zip`));
console.log(`extension=${path.join(outDir, `WAR-MV3-Extension-${RELEASE_CHANNEL}-${version}.zip`)}`);
