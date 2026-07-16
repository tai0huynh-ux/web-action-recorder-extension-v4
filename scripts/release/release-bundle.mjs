import fs from 'node:fs';
import path from 'node:path';
import { DIST, RELEASE_CHANNEL, ensureDir, execFileP, gitCommit, listFiles, packageVersion, rootPath, sha256, writeJson, writeText } from './release-utils.mjs';

const skipBuild = process.argv.includes('--manifest-only');
if (!skipBuild) {
  await execFileP('npm.cmd', ['run', 'package:controller-electron']);
  await execFileP('npm.cmd', ['run', 'dist:controller-electron']);
  await execFileP('npm.cmd', ['run', 'package:browser-agent']);
  await execFileP('npm.cmd', ['run', 'package:extension']);
}

const version = await packageVersion();
const commit = await gitCommit();
const artifacts = [];
for (const file of await listFiles(DIST)) {
  const rel = path.relative(DIST, file).replaceAll(path.sep, '/');
  if (rel.startsWith('release-work/') || rel === 'release-manifest.json' || rel === 'SHA256SUMS.txt') continue;
  if (rel.endsWith('.blockmap') || rel.endsWith('builder-debug.yml') || rel.endsWith('builder-effective-config.yaml')) continue;
  const stat = fs.statSync(file);
  artifacts.push({
    name: rel,
    size: stat.size,
    sha256: await sha256(file),
    signed: await isSigned(file),
    signatureVerification: await signatureStatus(file)
  });
}

const manifest = {
  schemaVersion: 1,
  productVersion: version,
  gitCommit: commit,
  buildTimestampUtc: new Date().toISOString(),
  releaseChannel: RELEASE_CHANNEL,
  operatingSystem: 'windows',
  architecture: 'x64',
  electronVersion: '43.1.1',
  nodeVersion: process.version,
  artifacts,
  signed: artifacts.some((artifact) => artifact.signed),
  signing: {
    pipeline: 'electron-builder Windows signing via CSC_LINK/WIN_CSC_LINK or WAR_WINDOWS_SIGN_CERT_PATH',
    certificateSupplied: Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.WAR_WINDOWS_SIGN_CERT_PATH),
    productionSignature: artifacts.some((artifact) => artifact.signatureVerification === 'Valid') ? 'VALID' : 'NOT_RUN_NO_CERTIFICATE'
  },
  testSummary: {
    releaseIntegrity: 'run npm.cmd run test:release:integrity',
    packagedSmoke: 'run npm.cmd run test:controller-electron:packaged',
    releaseGate: 'run npm.cmd run test:release:gate'
  },
  knownLimitations: [
    'Unsigned development packages are not production-signed releases.',
    'Auto-update is intentionally out of scope.',
    'Browser Agent and MV3 Extension are distributed as sidecar packages.'
  ]
};
await ensureDir(DIST);
await writeJson(rootPath('dist', 'release', 'release-manifest.json'), manifest);
await writeText(rootPath('dist', 'release', 'SHA256SUMS.txt'), artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join('\n') + '\n');
console.log(`manifest=${rootPath('dist', 'release', 'release-manifest.json')}`);

async function signatureStatus(file) {
  if (process.platform !== 'win32' || !/\.(exe|msi)$/i.test(file)) return 'NOT_APPLICABLE';
  try {
    const script = `$s=Get-AuthenticodeSignature -LiteralPath ${JSON.stringify(file)}; [pscustomobject]@{Status=$s.Status.ToString(); StatusMessage=$s.StatusMessage} | ConvertTo-Json -Compress`;
    const result = await execFileP('powershell', ['-NoProfile', '-Command', script]);
    return JSON.parse(result.stdout).Status || 'Unknown';
  } catch {
    return 'NOT_VERIFIED';
  }
}

async function isSigned(file) {
  return (await signatureStatus(file)) === 'Valid';
}
