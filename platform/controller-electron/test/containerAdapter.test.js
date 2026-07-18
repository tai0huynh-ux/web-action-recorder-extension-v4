import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDockerContainerAdapter } from '../src/containerAdapter.js';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const APPROVED_SECCOMP_OPTION = `seccomp=${JSON.stringify(JSON.parse(fs.readFileSync(new URL('../../container/security/chromium-userns-seccomp.json', import.meta.url), 'utf8')))}`;

test('managed Docker adapter isolates credentials and verifies the approved runtime', async () => {
  const execCalls = [];
  const spawnCalls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (file, args, options) => {
      execCalls.push({ file, args, options });
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(safeInspection())}\n`, stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
    spawnImpl: fakeSpawn(spawnCalls),
  });

  const credential = 'c'.repeat(43);
  const result = await adapter.create(container({ credential }));

  const credentialWrite = spawnCalls[0];
  assert.equal(credentialWrite.file, 'docker');
  assert.ok(credentialWrite.args.includes('--entrypoint'));
  assert.equal(credentialWrite.args.join(' ').includes(credential), false);
  assert.equal(credentialWrite.child.input, `${credential}\n`);

  const run = execCalls.find((call) => call.args[0] === 'run');
  assert.equal(run.file, 'docker');
  assert.equal(run.args.includes('--privileged'), false);
  assert.equal(run.args.includes('--user') && run.args.includes('war'), true);
  assert.equal(run.args.includes('no-new-privileges:true'), false);
  assert.equal(run.args.includes('apparmor=war-browser-agent'), true);
  assert.equal(run.args.includes('seccomp=C:/war/security/chromium-userns-seccomp.json'), true);
  assert.equal(run.args.includes('--memory') && run.args.includes('2g'), true);
  assert.equal(run.args.includes('--cpus') && run.args.includes('2'), true);
  assert.equal(run.args.includes('--pids-limit') && run.args.includes('512'), true);
  assert.equal(run.args.some((arg) => String(arg).includes('/var/run/docker.sock')), false);
  assert.equal(run.args.some((arg) => String(arg).includes(credential)), false);
  assert.deepEqual(run.args.filter((arg, index) => run.args[index - 1] === '-e'), [
    'WAR_MANAGED_DEVICE_ID',
    'WAR_CONTROLLER_SESSION_CREDENTIAL_FILE',
    'WAR_CONTROLLER_WSS_URL',
  ]);
  assert.equal(run.options.env.WAR_CONTROLLER_SESSION_CREDENTIAL, undefined);
  assert.equal(run.options.env.WAR_CONTROLLER_SESSION_CREDENTIAL_FILE, '/data/device/controller-session.credential');
  assert.equal(run.options.env.WAR_BROWSER_NO_SANDBOX, undefined);
  assert.equal(JSON.stringify(result).includes('cccc'), false);
  assert.equal(result.runtime.privileged, false);
  assert.equal(result.runtime.nonRootUser, 'war');
  assert.equal(result.runtime.networkMode, 'bridge');
  assert.equal(result.runtime.controlPort, 49000);
});

test('managed Docker adapter rejects renderer-selected images', async () => {
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
  });

  await assert.rejects(() => adapter.create(container({ image: 'unreviewed/image:latest' })), /not approved/);
});

test('managed Docker adapter rejects unsafe measured runtime state', async () => {
  const spawnCalls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(safeInspection({ HostConfig: { Privileged: true } }))}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    },
    spawnImpl: fakeSpawn(spawnCalls),
  });

  await assert.rejects(() => adapter.create(container()), /security policy failed/);
});

test('managed Docker adapter rejects altered measured seccomp policy', async () => {
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(safeInspection({ HostConfig: { SecurityOpt: ['apparmor=war-browser-agent', 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'] } }))}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    },
    spawnImpl: fakeSpawn([]),
  });

  await assert.rejects(() => adapter.create(container()), /security policy failed/);
});

test('managed Docker adapter uses bounded SSH Docker commands', async () => {
  const calls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('ssh-docker'),
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      if (args[4]?.includes("'{{.State.Status}}'")) return { stdout: 'running\n', stderr: '' };
      return { stdout: `${JSON.stringify(safeInspection(remoteSecurityOptions()))}\n`, stderr: '' };
    },
  });

  await adapter.status({ id: 'container-1', runtime: { dockerName: 'war-agent-one' } });

  assert.equal(calls[0].file, 'ssh');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-F', 'NUL', 'operator@agent.example', '--']);
  assert.ok(calls[0].args[4].includes("'docker' 'inspect'"));
  assert.equal(calls[0].args[4].includes(';'), false);
});

test('managed SSH Docker creation streams the credential separately from safe environment', async () => {
  const execCalls = [];
  const spawnCalls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('ssh-docker'),
    execFileImpl: async (file, args) => {
      execCalls.push({ file, args });
      if (args[4]?.includes("'image' 'inspect'")) return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[4]?.includes("'inspect' '--format' '{{json .}}'")) return { stdout: `${JSON.stringify(safeInspection(remoteSecurityOptions()))}\n`, stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
    spawnImpl: fakeSpawn(spawnCalls),
  });

  const credential = 'c'.repeat(43);
  await adapter.create(container({ credential }));

  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[0].child.input, `${credential}\n`);
  assert.ok(spawnCalls[0].args.at(-1).includes("'--entrypoint' '/bin/sh'"));
  assert.equal(spawnCalls[1].child.input.includes(credential), false);
  assert.match(spawnCalls[1].child.input, /^WAR_MANAGED_DEVICE_ID=managed-device-1$/m);
  assert.match(spawnCalls[1].child.input, /^WAR_CONTROLLER_SESSION_CREDENTIAL_FILE=\/data\/device\/controller-session\.credential$/m);
  assert.equal(spawnCalls.flatMap((call) => call.args).join(' ').includes(credential), false);
  assert.equal(execCalls.some((call) => call.args.join(' ').includes(credential)), false);
});

test('managed Docker deletion propagates runtime cleanup failure', async () => {
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      if (args[0] === 'rm') throw new Error('runtime cleanup failed');
      return { stdout: '', stderr: '' };
    },
  });

  await assert.rejects(() => adapter.delete({ id: 'container-1', runtime: { dockerName: 'war-agent-one' } }), /cleanup failed/);
});

function managedConfig(runtime) {
  return {
    wss: { enabled: true, host: 'controller.example', port: 47651 },
    containers: {
      enabled: true,
      runtime,
      image: 'war-browser-agent:phase1',
      sshTarget: runtime === 'ssh-docker' ? 'operator@agent.example' : undefined,
      timeoutMs: 1000,
      hostLabel: runtime,
      seccompProfilePath: runtime === 'ssh-docker'
        ? '/etc/war/security/chromium-userns-seccomp.json'
        : 'C:/war/security/chromium-userns-seccomp.json',
    },
  };
}

function container({ credential = 'c'.repeat(43), image = 'war-browser-agent:phase1' } = {}) {
  return {
    id: 'container-1',
    name: 'Agent One',
    image,
    deviceId: 'managed-device-1',
    runtime: { dockerName: 'war-agent-one' },
    provisioning: { credential },
  };
}

function safeInspection(overrides = {}) {
  const base = {
    Image: IMAGE_ID,
    Config: {
      User: 'war',
      Image: 'war-browser-agent:phase1',
      Labels: { 'managed-by': 'war-controller' },
    },
    HostConfig: {
      Privileged: false,
      NetworkMode: 'bridge',
      Memory: 2 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      PidsLimit: 512,
      SecurityOpt: ['apparmor=war-browser-agent', APPROVED_SECCOMP_OPTION],
      Binds: ['war-agent-one-data:/data'],
      PortBindings: { '3766/tcp': [{ HostIp: '127.0.0.1', HostPort: '49000' }] },
    },
  };
  return {
    ...base,
    ...overrides,
    Config: { ...base.Config, ...(overrides.Config || {}) },
    HostConfig: { ...base.HostConfig, ...(overrides.HostConfig || {}) },
  };
}

function remoteSecurityOptions() {
  return { HostConfig: { SecurityOpt: ['apparmor=war-browser-agent', APPROVED_SECCOMP_OPTION] } };
}

function fakeSpawn(calls) {
  return (file, args, options) => {
    const child = fakeChildProcess();
    calls.push({ file, args, options, child });
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
}

function fakeChildProcess() {
  const listeners = new Map();
  const stream = () => ({ on() {} });
  const child = {
    stdout: stream(),
    stderr: stream(),
    stdin: { on() {}, end(value) { child.input = value; } },
    on(event, handler) { listeners.set(event, handler); },
    emit(event, value) { listeners.get(event)?.(value); },
    kill() {},
    input: '',
  };
  return child;
}
