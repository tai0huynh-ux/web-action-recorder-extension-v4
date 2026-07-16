import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DIST, ensureDir, listFiles, readJson, rootPath, sha256, writeJson } from './release-utils.mjs';

const manifestPath = rootPath('dist', 'release', 'release-manifest.json');
if (!fs.existsSync(manifestPath)) throw new Error('release-manifest.json missing. Run npm.cmd run release:bundle first.');
const manifest = await readJson(manifestPath);
const findings = [];

for (const artifact of manifest.artifacts || []) {
  const file = path.join(DIST, artifact.name);
  assert(fs.existsSync(file), `artifact missing: ${artifact.name}`);
  const actual = await sha256(file);
  assert(actual === artifact.sha256, `hash mismatch: ${artifact.name}`);
}

await tamperDetection(manifest);
await secretScan();

const report = {
  timestamp: new Date().toISOString(),
  artifactsChecked: manifest.artifacts.length,
  tamperDetection: 'PASS',
  secretScan: findings.length ? 'FAIL' : 'PASS',
  findings
};
await writeJson(rootPath('artifacts', 'release-packaging', `release-integrity-${Date.now()}.json`), report);
if (findings.length) throw new Error(`release secret scan failed with ${findings.length} finding(s)`);
console.log(JSON.stringify(report, null, 2));

async function tamperDetection(manifest) {
  const artifact = manifest.artifacts?.[0];
  assert(artifact, 'no artifacts in release manifest');
  const source = path.join(DIST, artifact.name);
  const temp = path.join(os.tmpdir(), `war-tamper-${Date.now()}-${path.basename(source)}`);
  await fsp.copyFile(source, temp);
  await fsp.appendFile(temp, Buffer.from([0]));
  const tampered = await sha256(temp);
  await fsp.rm(temp, { force: true });
  assert(tampered !== artifact.sha256, 'tamper detection did not detect modified artifact');
}

async function secretScan() {
  const patterns = [
    [/BEGIN PRIVATE KEY/i, 'private key'],
    [/Authorization:/i, 'authorization header'],
    [/credentialHash/i, 'credential hash'],
    [/tokenHash/i, 'token hash'],
    [/pairing code/i, 'pairing code'],
    [/C:\\Users\\/i, 'windows user path'],
    [/\/Users\//i, 'mac user path'],
    [/\/home\//i, 'home path'],
    [/controller-state\.json/i, 'controller state'],
    [/\.env\b/i, 'env file reference'],
    [/\.pfx\b|\.p12\b|\.pem\b|\.key\b/i, 'certificate/private key filename']
  ];
  for (const file of await listFiles(DIST)) {
    const rel = path.relative(DIST, file).replaceAll(path.sep, '/');
    if (rel.endsWith('builder-debug.yml') || rel.includes('LICENSES.chromium.html')) continue;
    if (!isTextLike(file) || rel === 'release-manifest.json' || rel === 'SHA256SUMS.txt') continue;
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    for (const [pattern, label] of patterns) {
      if (pattern.test(text) && !allowedFinding(rel, label)) findings.push({ file: rel, label });
    }
  }
}

function allowedFinding(rel, label) {
  if (rel.includes('RELEASE_STARTUP.md') && ['authorization header', 'env file reference'].includes(label)) return true;
  if (rel.endsWith('.js') && ['credential hash', 'token hash', 'controller state'].includes(label)) return true;
  return false;
}

function isTextLike(file) {
  return /\.(js|cjs|mjs|json|md|html|css|txt|yml|yaml)$/i.test(file);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
