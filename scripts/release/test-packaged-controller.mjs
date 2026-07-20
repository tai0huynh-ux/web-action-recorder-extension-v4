import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileP, rootPath, writeJson } from './release-utils.mjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'war-packaged-controller-'));
const unpacked = await runControllerSmoke(findPackagedExe(), 'unpacked');
const installed = await runInstalledSmoke();
await writeJson(rootPath('artifacts', 'release-packaging', `packaged-controller-smoke-${Date.now()}.json`), {
  timestamp: new Date().toISOString(),
  unpacked,
  installed,
  tempCleaned: false
});
await fsp.rm(temp, { recursive: true, force: true });
console.log(`packagedSmoke=${temp}`);

function findPackagedExe() {
  const dir = rootPath('dist', 'release', 'controller-electron', 'win-unpacked');
  const candidate = path.join(dir, 'WAR Controller.exe');
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Packaged executable not found at ${candidate}. Run npm.cmd run package:controller-electron first.`);
}

async function runInstalledSmoke() {
  const installer = findInstaller();
  const installDir = path.join(temp, 'installed');
  await runProcess(installer, ['/S', `/D=${installDir}`], 120000);
  const exe = path.join(installDir, 'WAR Controller.exe');
  if (!fs.existsSync(exe)) throw new Error('installed executable missing after NSIS install');
  const smoke = await runControllerSmoke(exe, 'installed');
  const uninstaller = path.join(installDir, 'Uninstall WAR Controller.exe');
  if (!fs.existsSync(uninstaller)) throw new Error('uninstaller missing after NSIS install');
  await runProcess(uninstaller, ['/S'], 120000);
  await waitForRemoved(exe, 15000);
  smoke.uninstallRemovedExecutable = !fs.existsSync(exe);
  if (!smoke.uninstallRemovedExecutable) throw new Error('uninstall did not remove installed executable');
  return smoke;
}

async function runControllerSmoke(exe, label) {
  const smokeRoot = path.join(temp, label);
  await fsp.mkdir(smokeRoot, { recursive: true });
  const smokeOutput = path.join(smokeRoot, 'packaged-smoke.json');
  const certs = await createCertificates(smokeRoot);
  const env = {
    ...process.env,
    WAR_CONTROLLER_PACKAGED_SMOKE_OUTPUT: smokeOutput,
    WAR_CONTROLLER_PACKAGED_SMOKE_USER_DATA_PATH: path.join(smokeRoot, 'electron-user-data'),
    WAR_CONTROLLER_ELECTRON_DATA_PATH: path.join(smokeRoot, 'state'),
    WAR_CONTROLLER_WSS_ENABLED: '1',
    WAR_CONTROLLER_WSS_HOST: '127.0.0.1',
    WAR_CONTROLLER_TLS_CERT_PATH: certs.cert,
    WAR_CONTROLLER_TLS_KEY_PATH: certs.key
  };
  await runProcess(exe, [], packagedSmokeTimeoutMs(), env);
  const smoke = JSON.parse(await fsp.readFile(smokeOutput, 'utf8'));
  const failed = smoke.results.filter((item) => !item.pass);
  if (failed.length) throw new Error(`${label} packaged smoke failed: ${failed.map((item) => item.name).join(', ')}`);
  return {
    label,
    executable: path.basename(exe),
    tests: smoke.results.map(({ name, pass, durationMs, data, error }) => ({ name, pass, durationMs, data, error }))
  };
}

function findInstaller() {
  const dir = rootPath('dist', 'release', 'controller-electron');
  const installer = fs.readdirSync(dir).find((name) => /^WAR-Controller-Setup-.*\.exe$/i.test(name));
  if (!installer) throw new Error(`NSIS installer not found in ${dir}. Run npm.cmd run dist:controller-electron first.`);
  return path.join(dir, installer);
}

function runExe(file, env) {
  return runProcess(file, [], packagedSmokeTimeoutMs(), env);
}

function packagedSmokeTimeoutMs() {
  const value = Number(process.env.WAR_CONTROLLER_PACKAGED_SMOKE_TIMEOUT_MS);
  if (Number.isFinite(value) && value >= 30000 && value <= 300000) return value;
  return 120000;
}

function runProcess(file, args = [], timeoutMs = 30000, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd: os.tmpdir(), stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(file)} timed out`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`packaged executable exited ${code}`));
    });
  });
}

async function waitForRemoved(file, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function createCertificates(root) {
  const key = path.join(root, 'server.key');
  const cert = path.join(root, 'server.crt');
  const server = https.createServer();
  server.close();
  const cnf = path.join(root, 'openssl.cnf');
  await fsp.writeFile(cnf, '[req]\ndistinguished_name=req_distinguished_name\n[req_distinguished_name]\n');
  const ext = path.join(root, 'server.ext');
  await fsp.writeFile(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  const env = { ...process.env, OPENSSL_CONF: cnf };
  await execFileP('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-sha256', '-extensions', 'v3_req', '-config', cnf, '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { env }).catch(async () => {
    await execFileP('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { env });
  });
  return { key, cert };
}
