import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();
const workflowDir = path.join(root, '.github', 'workflows');
const required = ['ci.yml', 'windows-release-gate.yml', 'container-real-world-gate.yml'];
const shaRe = /^[a-f0-9]{40}$/;
const approvedActions = new Map([
  ['actions/checkout', { sha: '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0', version: 'v7.0.0' }],
  ['actions/setup-node', { sha: '820762786026740c76f36085b0efc47a31fe5020', version: 'v7.0.0' }],
  ['actions/upload-artifact', { sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', version: 'v7.0.1' }]
]);
const findings = [];

for (const file of required) {
  const fullPath = path.join(workflowDir, file);
  assert(fs.existsSync(fullPath), `${file} is missing`);
  const text = fs.readFileSync(fullPath, 'utf8');
  const doc = yaml.load(text);
  assert(doc && typeof doc === 'object', `${file} did not parse as a YAML mapping`);
  assert(!text.includes('pull_request_target'), `${file} must not use pull_request_target`);
  assert(!text.includes('ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION'), `${file} must not allow insecure action runtimes`);
  assert(!/BEGIN PRIVATE KEY|Authorization:\s*Bearer|ghp_|github_pat_|password\s*[:=]/i.test(text), `${file} contains plaintext secret-like text`);
  assert(doc.permissions?.contents === 'read', `${file} must use contents: read`);
  assert(!JSON.stringify(doc.permissions).includes('write'), `${file} must not request write permissions`);
  assert(doc.env?.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 === 'true', `${file} must force JavaScript actions onto Node 24 during verification`);
  assertPinnedActions(doc, file);
  assertActionComments(text, file);
  assertActionPolicy(doc, file);
}

const ci = yaml.load(fs.readFileSync(path.join(workflowDir, 'ci.yml'), 'utf8'));
assert(hasTrigger(ci, 'pull_request'), 'ci.yml must run on pull_request');
assert(hasTrigger(ci, 'push'), 'ci.yml must run on push');
assert(hasTrigger(ci, 'workflow_dispatch'), 'ci.yml must run on workflow_dispatch');
for (const command of ['npm.cmd ci', 'npm.cmd run check', 'npm.cmd run test:all', 'npm.cmd audit']) {
  assert(workflowRuns(ci, command), `ci.yml missing ${command}`);
}
assert(!workflowRuns(ci, 'release:bundle'), 'ci.yml must not build release artifacts');

const release = yaml.load(fs.readFileSync(path.join(workflowDir, 'windows-release-gate.yml'), 'utf8'));
assert(hasTrigger(release, 'workflow_dispatch'), 'windows-release-gate.yml must be manual');
for (const command of [
  'npm.cmd ci',
  'npm.cmd run release:bundle',
  'npm.cmd run test:release:integrity',
  'npm.cmd run test:controller-electron:packaged',
  'npm.cmd run test:release:gate',
  'npm.cmd run check',
  'npm.cmd run test:all',
  'npm.cmd audit'
]) {
  assert(workflowRuns(release, command), `windows-release-gate.yml missing ${command}`);
}
assert(!/gh\s+release\s+create|softprops\/action-gh-release|actions\/create-release/i.test(JSON.stringify(release)), 'release workflow must not publish by default');
assert(release.on?.workflow_dispatch?.inputs?.publish_prerelease?.default === false, 'publish_prerelease must default false');

const container = yaml.load(fs.readFileSync(path.join(workflowDir, 'container-real-world-gate.yml'), 'utf8'));
assert(hasTrigger(container, 'workflow_dispatch'), 'container-real-world-gate.yml must be manual');
assert(workflowRuns(container, 'npm run container:browser-agent:build'), 'container workflow must build the Docker image');
assert(workflowRuns(container, 'npm run probe:chromium-sandbox-host'), 'container workflow must probe the sandbox host');
assert(workflowRuns(container, 'npm run test:container-real-world'), 'container workflow must run the real-world gate');
assert(JSON.stringify(container).includes('apparmor_parser -r -W'), 'container workflow must load the reviewed AppArmor profile');
assert(JSON.stringify(container).includes('apparmor_parser -R'), 'container workflow must unload the reviewed AppArmor profile');
const sandboxJob = container.jobs?.controlled_search_copy;
assert(sandboxJob?.['runs-on'] === 'ubuntu-24.04', 'container sandbox job must use the standard ubuntu-24.04 VM');
assert(!Object.hasOwn(sandboxJob || {}, 'container'), 'container sandbox job must not run inside an outer job container');
assert(!Object.hasOwn(sandboxJob || {}, 'services'), 'container sandbox job must not use Docker-in-Docker services');

if (findings.length) {
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ result: 'PASS', workflows: required }, null, 2));

function assertPinnedActions(doc, file) {
  for (const step of allSteps(doc)) {
    if (!step.uses) continue;
    const [action, ref = ''] = String(step.uses).split('@');
    assert(shaRe.test(ref), `${file} action is not pinned to an immutable SHA: ${step.uses}`);
    const approved = approvedActions.get(action);
    assert(Boolean(approved), `${file} uses an unreviewed external action: ${action}`);
    if (approved) assert(ref === approved.sha, `${file} ${action} is not pinned to approved ${approved.version}`);
  }
}

function assertActionComments(text, file) {
  for (const [action, approved] of approvedActions) {
    if (!text.includes(`${action}@`)) continue;
    assert(text.includes(`uses: ${action}@${approved.sha} # ${approved.version}`), `${file} ${action} must retain its reviewed version comment`);
  }
}

function assertActionPolicy(doc, file) {
  for (const step of allSteps(doc)) {
    const action = String(step.uses || '').split('@')[0];
    if (action === 'actions/checkout') assert(step.with?.['persist-credentials'] === false, `${file} checkout must disable persisted credentials`);
    if (action === 'actions/setup-node') {
      assert(step.with?.['node-version'] === '22.12.0', `${file} must preserve the supported Node test runtime`);
      assert(step.with?.cache === 'npm', `${file} setup-node must cache npm data only`);
      assert(step.with?.['cache-dependency-path'] === 'package-lock.json', `${file} setup-node cache must follow package-lock.json`);
    }
    if (action === 'actions/upload-artifact') assert(step.with?.['include-hidden-files'] === false, `${file} artifact upload must exclude hidden files`);
  }
}

function allSteps(doc) {
  return Object.values(doc.jobs || {}).flatMap((job) => Array.isArray(job.steps) ? job.steps : []);
}

function workflowRuns(doc, command) {
  return allSteps(doc).some((step) => String(step.run || '').trim() === command);
}

function hasTrigger(doc, name) {
  const triggers = doc.on || {};
  if (typeof triggers === 'string') return triggers === name;
  if (Array.isArray(triggers)) return triggers.includes(name);
  return Object.hasOwn(triggers, name);
}

function assert(condition, message) {
  if (!condition) findings.push(message);
}
