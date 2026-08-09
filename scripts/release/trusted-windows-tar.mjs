import path from 'node:path';
import fs from 'node:fs/promises';

const WINDOWS_SYSTEM_ROOT_AUTHORITY = String.raw`\\?\GLOBALROOT\SystemRoot`;
const windowsPath = path.win32;

function isWithin(parent, candidate) {
  const relative = windowsPath.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${windowsPath.sep}`) && relative !== '..' && !windowsPath.isAbsolute(relative));
}

export function createTrustedTarExtractor({
  execFileP,
  fsApi = fs,
  platform = process.platform
}) {
  if (typeof execFileP !== 'function') throw new TypeError('execFileP must be a function');

  return async function extractTrustedTar({ archivePath, destinationPath }) {
    if (platform !== 'win32') throw new Error('Trusted tar extraction is only available on Windows');

    const systemRootStat = await fsApi.lstat(WINDOWS_SYSTEM_ROOT_AUTHORITY);
    if (!systemRootStat.isDirectory() || systemRootStat.isSymbolicLink()) {
      throw new Error('SystemRoot must be a real directory');
    }
    const realSystemRoot = await fsApi.realpath(WINDOWS_SYSTEM_ROOT_AUTHORITY);
    if (!windowsPath.isAbsolute(realSystemRoot)) throw new Error('SystemRoot must resolve to an absolute path');
    const system32Path = windowsPath.join(realSystemRoot, 'System32');
    const system32Stat = await fsApi.lstat(system32Path);
    if (!system32Stat.isDirectory() || system32Stat.isSymbolicLink()) {
      throw new Error('System32 must be a real directory');
    }
    const realSystem32 = await fsApi.realpath(system32Path);
    if (!isWithin(realSystemRoot, realSystem32)) throw new Error('System32 is outside SystemRoot');

    const tarPath = windowsPath.join(realSystem32, 'tar.exe');
    const tarStat = await fsApi.lstat(tarPath);
    if (!tarStat.isFile() || tarStat.isSymbolicLink()) throw new Error('System tar must be a regular file');
    const realTarPath = await fsApi.realpath(tarPath);
    if (!isWithin(realSystem32, realTarPath)) throw new Error('System tar is outside System32');

    await execFileP(realTarPath, ['-xf', archivePath, '-C', destinationPath], {
      env: {
        SystemRoot: realSystemRoot,
        WINDIR: realSystemRoot
      }
    });
  };
}
