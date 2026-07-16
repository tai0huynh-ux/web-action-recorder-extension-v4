import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.web_action_recorder.native_bridge';
export const SHIM_SOURCE = new URL('./windows-native-host-shim.cs', import.meta.url);

export function nativeMessagingRegistryKey(browserKey, hostName = HOST_NAME) {
  if (browserKey === 'edge') return `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`;
  if (browserKey === 'chromium') return `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${hostName}`;
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
}

export function createNativeHostManifest({ extensionId, executablePath, hostName = HOST_NAME }) {
  if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('Extension id must be a 32-character browser extension id.');
  if (!path.isAbsolute(executablePath)) throw new Error('Native host executable path must be absolute.');
  if (path.extname(executablePath).toLowerCase() !== '.exe') throw new Error('Native host manifest must point to a .exe.');
  return {
    name: hostName,
    description: 'Web Action Recorder E2E native bridge',
    path: executablePath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
}

export function createShimConfig({ nodePath, hostScriptPath, socketPath }) {
  for (const [label, value] of Object.entries({ nodePath, hostScriptPath, socketPath })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
    if (/[\r\n]/.test(value)) throw new Error(`${label} must not contain newlines.`);
  }
  if (!path.isAbsolute(nodePath)) throw new Error('nodePath must be absolute.');
  if (!path.isAbsolute(hostScriptPath)) throw new Error('hostScriptPath must be absolute.');
  return `${nodePath}\n${hostScriptPath}\n${socketPath}\n`;
}

export async function buildWindowsNativeHostShim({ outputDir, nodePath = process.execPath, hostScriptPath, socketPath, cscPath = findCsc() }) {
  if (process.platform !== 'win32') throw new Error('Windows native host shim is only built on Windows.');
  if (!cscPath) throw new Error('No Windows C# compiler was found.');
  await fs.mkdir(outputDir, { recursive: true });
  const exePath = path.join(outputDir, 'war-native-host-shim.exe');
  const configPath = path.join(outputDir, 'war-native-host-shim.config');
  const source = fileURLToPath(SHIM_SOURCE);
  const result = await execFileP(cscPath, ['/nologo', '/target:exe', `/out:${exePath}`, source]).catch((error) => {
    const detail = sanitizeCompilerOutput(`${error.stdout || ''}\n${error.stderr || ''}`.trim());
    throw new Error(`Native host shim compile failed${detail ? `: ${detail}` : ''}`);
  });
  await fs.writeFile(configPath, createShimConfig({ nodePath, hostScriptPath, socketPath }), 'utf8');
  await verifyWindowsExecutable(exePath);
  return { exePath, configPath, compiler: cscPath, compilerOutput: sanitizeCompilerOutput(`${result.stdout || ''}\n${result.stderr || ''}`.trim()) };
}

export async function installWindowsNativeHost({ root, extensionId, socketPath, browserKey, hostName = HOST_NAME }) {
  const shimDir = path.join(root, 'native-host-shim');
  const hostScriptPath = path.resolve('native-host/host.js');
  const built = await buildWindowsNativeHostShim({ outputDir: shimDir, hostScriptPath, socketPath });
  const manifest = createNativeHostManifest({ extensionId, executablePath: built.exePath, hostName });
  const manifestPath = path.join(shimDir, `${hostName}.json`);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const registryKey = nativeMessagingRegistryKey(browserKey, hostName);
  await execFileP('reg', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
  const registryValue = await readRegistryDefaultValue(registryKey);
  if (registryValue !== manifestPath) throw new Error('Native host registry default value does not match manifest path.');
  return { ...built, manifest, manifestPath, registryKey, registryValue };
}

export async function deleteRegistryKey(registryKey) {
  if (process.platform !== 'win32' || !registryKey) return;
  await execFileP('reg', ['delete', registryKey, '/f']).catch(() => {});
}

export async function verifyWindowsExecutable(exePath) {
  const stat = await fs.stat(exePath);
  if (stat.size <= 0) throw new Error('Generated native host executable is empty.');
  const handle = await fs.open(exePath, 'r');
  try {
    const buffer = Buffer.alloc(2);
    await handle.read(buffer, 0, 2, 0);
    if (buffer.toString('ascii') !== 'MZ') throw new Error('Generated native host executable is not an MZ binary.');
  } finally {
    await handle.close();
  }
}

export function findCsc() {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v3.5', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v3.5', 'csc.exe')
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate)) || '';
}

export async function readRegistryDefaultValue(registryKey) {
  const result = await execFileP('reg', ['query', registryKey, '/ve']);
  const lines = String(result.stdout || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*\(Default\)\s+REG_SZ\s+(.+?)\s*$/i);
    if (match) return match[1];
  }
  return '';
}

export function sanitizeCompilerOutput(output) {
  return String(output || '').replaceAll(os.homedir(), '<home>').slice(0, 4000);
}

function execFileP(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}
