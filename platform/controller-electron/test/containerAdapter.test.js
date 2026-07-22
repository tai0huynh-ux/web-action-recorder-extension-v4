import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createDockerContainerAdapter } from '../src/containerAdapter.js';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const OLD_IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const APPROVED_SECCOMP_OPTION = `seccomp=${JSON.stringify(JSON.parse(fs.readFileSync(new URL('../../container/security/chromium-userns-seccomp.json', import.meta.url), 'utf8')))}`;

test('managed Docker adapter probes the bounded Docker server version', async () => {
  const calls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: '28.3.2\n', stderr: '' };
    },
  });

  assert.deepEqual(await adapter.probe(), { connected: true });
  assert.deepEqual(calls[0].args, ['version', '--format', '{{.Server.Version}}']);
  assert.equal(calls[0].options.timeout, 1000);
});

test('managed Docker adapter isolates credentials and verifies the approved runtime', async () => {
  const execCalls = [];
  const spawnCalls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (file, args, options) => {
      execCalls.push({ file, args, options });
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(managedIpv4Inspection())}\n`, stderr: '' };
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
  assert.equal(result.runtime.networkMode, ipv4NetworkName());
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
      if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(managedIpv4Inspection({ HostConfig: { Privileged: true } }))}\n`, stderr: '' };
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
      if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(managedIpv4Inspection({ HostConfig: { SecurityOpt: ['apparmor=war-browser-agent', 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'] } }))}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    },
    spawnImpl: fakeSpawn([]),
  });

  await assert.rejects(() => adapter.create(container()), /security policy failed/);
});

test('managed Docker restart recreates a stale image container while preserving its data volume and security policy', async () => {
  const calls = [];
  let recreated = false;
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') {
        return { stdout: `${JSON.stringify({ Driver: 'bridge', EnableIPv4: true, EnableIPv6: false, Labels: { 'managed-by': 'war-controller' } })}\n`, stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: 'true\n', stderr: '' };
      if (args[0] === 'inspect') {
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Image: recreated ? IMAGE_ID : OLD_IMAGE_ID }))}\n`, stderr: '' };
      }
      if (args[0] === 'run') recreated = true;
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  const result = await adapter.restart(container());

  const run = calls.find((args) => args[0] === 'run');
  assert.ok(run);
  assert.ok(run.includes('war-agent-one-data:/data'));
  assert.ok(run.includes('apparmor=war-browser-agent'));
  assert.ok(run.includes('seccomp=C:/war/security/chromium-userns-seccomp.json'));
  assert.equal(run.includes('--privileged'), false);
  assert.equal(calls.some((args) => args[0] === 'rename'), true);
  assert.equal(calls.some((args) => args[0] === 'rm' && args[1] === '-f' && args[2]?.includes('network-backup')), true);
  assert.equal(result.status, 'running');
});

test('managed Docker adapter creates an IPv6 network with a stable suffix and keeps IPv4 toggle explicit', async () => {
  const execCalls = [];
  let ipv4NetworkNameSeen = '';
  let ipv6NetworkName = '';
  const adapter = createDockerContainerAdapter({
    config: {
      ...managedConfig('local-docker'),
      containers: { ...managedConfig('local-docker').containers, ipv6Interface: 'eth0', ipv6Driver: 'macvlan' },
    },
    execFileImpl: async (file, args) => {
      execCalls.push({ file, args });
      if (file === 'ip') return { stdout: JSON.stringify([{ addr_info: [{ family: 'inet6', scope: 'global', prefixlen: 64, local: '2001:db8:1:2::10' }] }]), stderr: '' };
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error('No such network'), { stderr: 'Error: No such network' });
      if (args[0] === 'network' && args[1] === 'create') {
        if (args.includes('macvlan')) ipv6NetworkName = args.at(-1);
        else ipv4NetworkNameSeen = args.at(-1);
        return { stdout: `${args.at(-1)}\n`, stderr: '' };
      }
      if (args[0] === 'inspect') {
        return { stdout: `${JSON.stringify(safeInspection({ NetworkSettings: { Networks: {
          [ipv4NetworkNameSeen]: { IPAddress: '172.30.0.2', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
          [ipv6NetworkName]: { GlobalIPv6Address: '2001:db8:1:2:a8bb:ccff:fedd:eeff', GlobalIPv6PrefixLen: 64 },
        } }, HostConfig: { NetworkMode: ipv4NetworkNameSeen } }))}\n`, stderr: '' };
      }
      return { stdout: 'ok\n', stderr: '' };
    },
    spawnImpl: fakeSpawn([]),
  });

  const result = await adapter.create(container({
    credential: 'c'.repeat(43),
    runtime: { ipv4Enabled: true, ipv6Enabled: true, ipv6Suffix: 'a8bb:ccff:fedd:eeff' },
  }));
  const run = execCalls.find((call) => call.args[0] === 'run' && call.args.includes('--name'));
  const networkCreate = execCalls.find((call) => call.args[0] === 'network' && call.args[1] === 'create' && call.args.includes('macvlan'));
  assert.equal(result.runtime.ipv6Address, '2001:db8:1:2:a8bb:ccff:fedd:eeff');
  assert.equal(result.runtime.ipv6Prefix, '2001:db8:1:2::/64');
  assert.ok(run.args.some((arg) => arg === `name=${ipv4NetworkNameSeen}`));
  assert.ok(run.args.some((arg) => arg === `name=${ipv6NetworkName},ip6=2001:db8:1:2:a8bb:ccff:fedd:eeff,mac-address=aa:bb:cc:dd:ee:ff`));
  assert.equal(networkCreate.args.includes('--ipv4=false'), true);
  assert.equal(networkCreate.args.includes('--driver'), true);
  assert.equal(networkCreate.args.includes('macvlan'), true);
  assert.equal(networkCreate.args.includes('--opt') && networkCreate.args.includes('parent=eth0'), true);
  assert.equal(networkCreate.args.includes('--ipv6'), true);
  assert.equal(networkCreate.args.includes('--subnet') && networkCreate.args.includes('2001:db8:1:2::/64'), true);
});

test('managed Docker adapter uses bounded SSH Docker commands', async () => {
  const calls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('ssh-docker'),
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      if (args.at(-1)?.includes("'{{.State.Status}}'")) return { stdout: 'running\n', stderr: '' };
      return { stdout: `${JSON.stringify(safeInspection(remoteSecurityOptions()))}\n`, stderr: '' };
    },
  });

  await adapter.status({ id: 'container-1', runtime: { dockerName: 'war-agent-one' } });

  assert.equal(calls[0].file, 'ssh');
  assert.deepEqual(calls[0].args.slice(0, -1), [
    '-F', 'NUL',
    '-i', 'C:/Users/operator/.ssh/id_ed25519',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    'operator@agent.example',
    '--',
  ]);
  assert.ok(calls[0].args.at(-1).includes("'docker' 'inspect'"));
  assert.equal(calls[0].args.at(-1).includes(';'), false);
});

test('managed SSH Docker creation streams the credential separately from safe environment', async () => {
  const execCalls = [];
  const spawnCalls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('ssh-docker'),
    execFileImpl: async (file, args) => {
      execCalls.push({ file, args });
      if (args.at(-1)?.includes("'image' 'inspect'")) return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args.at(-1)?.includes("'network' 'inspect'")) throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      if (args.at(-1)?.includes("'inspect' '--format' '{{json .}}'")) return { stdout: `${JSON.stringify(managedIpv4Inspection(remoteSecurityOptions()))}\n`, stderr: '' };
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
      sshIdentityFile: runtime === 'ssh-docker' ? 'C:/Users/operator/.ssh/id_ed25519' : undefined,
      timeoutMs: 1000,
      hostLabel: runtime,
      seccompProfilePath: runtime === 'ssh-docker'
        ? '/etc/war/security/chromium-userns-seccomp.json'
        : 'C:/war/security/chromium-userns-seccomp.json',
    },
  };
}

function container({ credential = 'c'.repeat(43), image = 'war-browser-agent:phase1', runtime = {} } = {}) {
  return {
    id: 'container-1',
    name: 'Agent One',
    image,
    deviceId: 'managed-device-1',
    runtime: { dockerName: 'war-agent-one', ...runtime },
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
    NetworkSettings: {
      Networks: { bridge: { GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 } },
      ...(overrides.NetworkSettings || {}),
    },
  };
}

function remoteSecurityOptions() {
  return { HostConfig: { SecurityOpt: ['apparmor=war-browser-agent', APPROVED_SECCOMP_OPTION] } };
}

function ipv4NetworkName() {
  return `war-managed-ipv4-${crypto.createHash('sha256').update('war-agent-one').digest('hex').slice(0, 12)}`;
}

function managedIpv4Inspection(overrides = {}) {
  return safeInspection({
    ...overrides,
    HostConfig: { NetworkMode: ipv4NetworkName(), ...(overrides.HostConfig || {}) },
    NetworkSettings: { Networks: { [ipv4NetworkName()]: { IPAddress: '172.30.0.2', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 } }, ...(overrides.NetworkSettings || {}) },
  });
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
