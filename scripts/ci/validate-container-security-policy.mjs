import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const profilePath = path.join(root, 'platform', 'container', 'security', 'war-browser-agent.apparmor');
const workflowPath = path.join(root, '.github', 'workflows', 'container-real-world-gate.yml');
const adapterPath = path.join(root, 'platform', 'controller-electron', 'src', 'containerAdapter.js');
const gatePath = path.join(root, 'platform', 'browser-agent', 'integration', 'realWorldContainerGate.js');
const probePath = path.join(root, 'scripts', 'ci', 'probe-chromium-sandbox-host.mjs');
const dockerfilePath = path.join(root, 'platform', 'browser-agent', 'Dockerfile');
const seccompPath = path.join(root, 'platform', 'container', 'security', 'chromium-userns-seccomp.json');
const browserControllerPath = path.join(root, 'platform', 'browser-agent', 'src', 'browserController.js');
const findings = [];

const profile = fs.readFileSync(profilePath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const runtimes = [adapterPath, gatePath, probePath].map((file) => fs.readFileSync(file, 'utf8'));
const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
const seccompText = fs.readFileSync(seccompPath, 'utf8');
const seccomp = JSON.parse(seccompText);
const browserController = fs.readFileSync(browserControllerPath, 'utf8');

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
  assert(runtime.includes('seccomp='), 'runtime must select the reviewed seccomp profile');
  assert(runtime.includes("'--memory', '2g'"), 'runtime must bound container memory');
  assert(runtime.includes("'--cpus', '2'"), 'runtime must bound container CPU');
  assert(runtime.includes("'--pids-limit', '512'"), 'runtime must bound container PIDs');
  assert(!runtime.includes('apparmor=unconfined'), 'runtime must not disable AppArmor');
  assert(!runtime.includes('no-new-privileges:true'), 'exact AppArmor userns transition must not be blocked by no-new-privileges');
}
assert(!/^\s*chromium-sandbox\s*\\?\s*$/m.test(dockerfile), 'userns-only image must not install the Chromium SUID helper package');
assert(dockerfile.includes('test ! -e /usr/lib/chromium/chrome-sandbox'), 'image build must verify the Chromium SUID helper is absent');
assert(dockerfile.includes('-exec chmod a-s {} +'), 'userns-only image must strip all SUID and SGID file bits');
assert(crypto.createHash('sha256').update(seccompText).digest('hex') === 'e11ad80b10af89cdade31962005da51dae8cd8828c0d9c02dadf67008aa5181d', 'Chromium seccomp profile hash changed without review');
assert(seccomp.defaultAction === 'SCMP_ACT_ERRNO', 'Chromium seccomp profile must retain the Docker default deny action');
const chromiumRules = seccomp.syscalls.filter((rule) => String(rule.comment || '').startsWith('Allow Chromium'));
const canonicalSeccompHash = crypto.createHash('sha256').update(JSON.stringify(seccomp)).digest('hex');
assert(chromiumRules.length === 4, 'Chromium seccomp profile must add exactly four reviewed rules');
assert(chromiumRules.every((rule) => rule.action === 'SCMP_ACT_ALLOW' && rule.args?.length === 1 && rule.args[0].op === 'SCMP_CMP_MASKED_EQ' && rule.args[0].value === 0x7e020000), 'Chromium seccomp additions must use the reviewed namespace mask');
assert(JSON.stringify(chromiumRules.filter((rule) => rule.names[0] === 'clone').map((rule) => rule.args[0].valueTwo).sort((a, b) => a - b)) === JSON.stringify([0x10000000, 0x20000000, 0x70000000]), 'Chromium clone namespace combinations changed');
assert(chromiumRules.some((rule) => rule.names[0] === 'unshare' && rule.args[0].valueTwo === 0x10000000), 'Chromium user namespace unshare rule is missing');
assert(chromiumRules.every((rule) => ['clone', 'unshare'].includes(rule.names[0])), 'Chromium seccomp additions must not allow unrelated syscalls');
assert(browserController.includes("page.goto('chrome://sandbox/'"), 'Browser Agent must query Chromium sandbox status from chrome://sandbox');
assert(browserController.includes("document.querySelectorAll('#sandbox-status tr')"), 'Browser Agent must read the Chromium-rendered sandbox status table');
assert(browserController.includes("document.querySelector('#evaluation')"), 'Browser Agent must read Chromium overall sandbox evaluation');
assert(runtimes[2].includes('if (!report.classification.supported) process.exitCode = 1'), 'sandbox capability probe must fail CI when authoritative proof is unavailable');
assert(runtimes[2].includes("import playwright from '/app/node_modules/playwright-core/index.js'"), 'sandbox probe must use the CommonJS-compatible Playwright import');
assert(!runtimes[2].includes("import { chromium } from '/app/node_modules/playwright-core/index.js'"), 'sandbox probe must not use an unsupported named import from Playwright CommonJS');
assert(runtimes[0].includes('matchesApprovedSeccompSecurityOption(securityOptions)'), 'managed runtime must verify Docker measured seccomp policy content');
assert(runtimes[0].includes(canonicalSeccompHash), 'managed runtime canonical seccomp hash must match the reviewed policy');
assert(runtimes[1].includes('seccompPolicyMatched'), 'real-world evidence must record only the sanitized seccomp policy match');
assert(!runtimes[1].includes("seccompProfile: securityOptions.find"), 'real-world evidence must not persist the full Docker seccomp JSON');

if (findings.length) {
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ result: 'PASS', profile: 'war-browser-agent', chromiumPath: '/usr/lib/chromium/chromium' }, null, 2));

function assert(condition, message) {
  if (!condition) findings.push(message);
}
