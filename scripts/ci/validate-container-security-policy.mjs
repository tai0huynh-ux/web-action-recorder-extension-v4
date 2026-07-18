import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const profilePath = path.join(root, 'platform', 'container', 'security', 'war-browser-agent.apparmor');
const workflowPath = path.join(root, '.github', 'workflows', 'container-real-world-gate.yml');
const adapterPath = path.join(root, 'platform', 'controller-electron', 'src', 'containerAdapter.js');
const gatePath = path.join(root, 'platform', 'browser-agent', 'integration', 'realWorldContainerGate.js');
const probePath = path.join(root, 'scripts', 'ci', 'probe-chromium-sandbox-host.mjs');
const dockerfilePath = path.join(root, 'platform', 'browser-agent', 'Dockerfile');
const findings = [];

const profile = fs.readFileSync(profilePath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const runtimes = [adapterPath, gatePath, probePath].map((file) => fs.readFileSync(file, 'utf8'));
const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

assert((profile.match(/^\s*userns,\s*$/gm) || []).length === 1, 'AppArmor profile must contain exactly one userns rule');
assert(profile.includes('/usr/lib/chromium/chromium cx -> chromium,'), 'AppArmor userns transition must target the exact Chromium binary');
assert(profile.includes('profile chromium flags=(default_allow)'), 'Chromium child profile must use the reviewed default_allow boundary');
assert(!/\/\*\*.*(?:p|c)x\b/.test(profile), 'AppArmor profile must not grant wildcard executable transitions');
assert(!/flags=\([^)]*unconfined/.test(profile), 'AppArmor profile must not use an unconfined flag');
assert(workflow.includes('sudo install -o root -g root -m 0644'), 'workflow must install the AppArmor profile as root-owned mode 0644');
assert(workflow.includes('sudo apparmor_parser -r -W'), 'workflow must load the reviewed AppArmor profile');
assert(workflow.includes('sudo apparmor_parser -R'), 'workflow must unload the temporary AppArmor profile');
for (const runtime of runtimes) {
  assert(runtime.includes("apparmor=war-browser-agent"), 'runtime must select the reviewed AppArmor profile');
  assert(!runtime.includes('apparmor=unconfined'), 'runtime must not disable AppArmor');
  assert(!runtime.includes('no-new-privileges:true'), 'exact AppArmor userns transition must not be blocked by no-new-privileges');
}
assert(!/^\s*chromium-sandbox\s*\\?\s*$/m.test(dockerfile), 'userns-only image must not install the Chromium SUID helper package');
assert(dockerfile.includes('test ! -e /usr/lib/chromium/chrome-sandbox'), 'image build must verify the Chromium SUID helper is absent');
assert(dockerfile.includes('-exec chmod a-s {} +'), 'userns-only image must strip all SUID and SGID file bits');

if (findings.length) {
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ result: 'PASS', profile: 'war-browser-agent', chromiumPath: '/usr/lib/chromium/chromium' }, null, 2));

function assert(condition, message) {
  if (!condition) findings.push(message);
}
