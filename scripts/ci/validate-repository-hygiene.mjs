import { spawnSync } from 'node:child_process';

const tracked = listTrackedFiles();
const findings = [];

const forbidden = [
  ['INSTALLED_DEPENDENCY', /(^|\/)node_modules\//i],
  ['PILOT_ARTIFACT', /^artifacts\/physical-lan-pilot\//i],
  ['GENERATED_OUTPUT', /^(dist|release)\//i],
  ['GENERATED_OUTPUT', /\.(?:exe|msi|msix|appx|blockmap|zip|7z|tar\.gz|tgz|deb|rpm|appimage|dmg)$/i],
  ['BROWSER_PROFILE', /(^|\/)(?:browser-profiles?|chrome-profile|chromium-profile|edge-profile|user-data-dir)(\/|$)/i],
  ['RUNTIME_STATE', /\.(?:log|sqlite|sqlite3|db|pid|sock)$/i],
  ['SECRET_RISK', /\.(?:pem|key|p12|pfx|ppk|jks|keystore)$/i],
  ['SECRET_RISK', /(^|\/)(?:id_rsa|id_ed25519|credentials?\.json|secrets?\.json|tokens?\.json|vnc-passwd|\.env(?:\.(?!example$)[^/]+)?|\.npmrc|\.netrc)$/i]
];

for (const file of tracked) {
  for (const [category, pattern] of forbidden) {
    if (pattern.test(file)) findings.push({ category, path: file });
  }
}

if (findings.length) {
  for (const finding of findings) console.error(`${finding.category}: ${finding.path}`);
  process.exit(1);
}

const classified = [
  { category: 'RELEASE_INPUT', path: 'build/icon.svg' },
  { category: 'TEST_FIXTURE', path: 'profiles/sample-profile.json' }
].filter(({ path }) => tracked.includes(path));

console.log(JSON.stringify({ result: 'PASS', classified }, null, 2));

function listTrackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error('UNKNOWN: git-index');
    process.exit(1);
  }
  return result.stdout.split('\0').filter(Boolean).map((file) => file.replaceAll('\\', '/'));
}
