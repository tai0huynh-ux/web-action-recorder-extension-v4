import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();
const workflowDir = path.join(root, '.github', 'workflows');
const required = ['ci.yml', 'windows-release-gate.yml', 'container-real-world-gate.yml'];
const shaRe = /^[a-f0-9]{40}$/;
const findings = [];

for (const file of required) {
  const fullPath = path.join(workflowDir, file);
  assert(fs.existsSync(fullPath), `${file} is missing`);
  const text = fs.readFileSync(fullPath, 'utf8');
  const doc = yaml.load(text);
  assert(doc && typeof doc === 'object', `${file} did not parse as a YAML mapping`);
  assert(!text.includes('pull_request_target'), `${file} must not use pull_request_target`);
  assert(!/BEGIN PRIVATE KEY|Authorization:\s*Bearer|ghp_|github_pat_|password\s*[:=]/i.test(text), `${file} contains plaintext secret-like text`);
  assert(doc.permissions?.contents === 'read', `${file} must use contents: read`);
  assert(!JSON.stringify(doc.permissions).includes('write'), `${file} must not request write permissions`);
  assertPinnedActions(doc, file);
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
assert(workflowRuns(container, 'npm run test:container-real-world'), 'container workflow must run the real-world gate');

if (findings.length) {
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ result: 'PASS', workflows: required }, null, 2));

function assertPinnedActions(doc, file) {
  for (const step of allSteps(doc)) {
    if (!step.uses) continue;
    const [, ref = ''] = String(step.uses).split('@');
    assert(shaRe.test(ref), `${file} action is not pinned to an immutable SHA: ${step.uses}`);
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
