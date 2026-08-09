import path from 'node:path';
import fs from 'node:fs/promises';

const WINDOWS_SYSTEM_ROOT_AUTHORITY = String.raw`\\?\GLOBALROOT\SystemRoot`;
const windowsPath = path.win32;
const BLOCKED_KEYS = new Set([
  'path',
  'systemroot',
  'windir',
  'comspec',
  'pathext',
  'node_options',
  'node_path'
]);

export async function createTrustedWindowsReleaseEnvironment({
  environment = process.env,
  fsApi = fs,
  platform = process.platform,
  execPath = process.execPath
} = {}) {
  const trustedEnvironment = { ...environment };
  if (platform !== 'win32') return trustedEnvironment;

  const systemRootStat = await fsApi.lstat(WINDOWS_SYSTEM_ROOT_AUTHORITY);
  if (!systemRootStat.isDirectory() || systemRootStat.isSymbolicLink()) {
    throw new Error('SystemRoot must be a real directory');
  }
  const systemRoot = await fsApi.realpath(WINDOWS_SYSTEM_ROOT_AUTHORITY);
  if (!windowsPath.isAbsolute(systemRoot)) {
    throw new Error('SystemRoot must resolve to an absolute path');
  }

  const nodeDirectory = windowsPath.dirname(execPath);
  if (!windowsPath.isAbsolute(nodeDirectory)) {
    throw new Error('Node executable directory must be absolute');
  }
  const system32 = windowsPath.join(systemRoot, 'System32');
  const powershell = windowsPath.join(system32, 'WindowsPowerShell', 'v1.0');

  for (const key of Object.keys(trustedEnvironment)) {
    if (BLOCKED_KEYS.has(key.toLowerCase())) delete trustedEnvironment[key];
  }

  trustedEnvironment.PATH = [nodeDirectory, systemRoot, system32, powershell].join(';');
  trustedEnvironment.SystemRoot = systemRoot;
  trustedEnvironment.WINDIR = systemRoot;
  trustedEnvironment.ComSpec = windowsPath.join(system32, 'cmd.exe');
  trustedEnvironment.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  return trustedEnvironment;
}
