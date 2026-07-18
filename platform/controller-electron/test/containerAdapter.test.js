import test from 'node:test';
import assert from 'node:assert/strict';
import { createDockerContainerAdapter } from '../src/containerAdapter.js';

test('managed Docker adapter creates non-privileged Agent containers without exposing Docker socket', async () => {
  const calls = [];
  const adapter = createDockerContainerAdapter({
    config: {
      wss: { enabled: true, host: '192.0.2.10', port: 47651 },
      containers: { enabled: true, runtime: 'local-docker', timeoutMs: 1000, hostLabel: 'local-docker' },
    },
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === 'port') return { stdout: '127.0.0.1:49000\n', stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  const result = await adapter.create({
    id: 'container-1',
    name: 'Agent One',
    image: 'war-browser-agent:phase1',
    deviceId: 'managed-device-1',
    runtime: { dockerName: 'war-agent-one' },
    provisioning: { credential: 'c'.repeat(43) },
  });

  const run = calls.find((call) => call.args[0] === 'run');
  assert.equal(run.file, 'docker');
  assert.equal(run.args.includes('--privileged'), false);
  assert.equal(run.args.some((arg) => String(arg).includes('/var/run/docker.sock')), false);
  assert.equal(run.args.some((arg) => String(arg).includes('managed-device-1')), false);
  assert.equal(run.args.some((arg) => String(arg).includes('c'.repeat(20))), false);
  assert.deepEqual(run.args.filter((arg, index) => run.args[index - 1] === '-e'), [
    'WAR_MANAGED_DEVICE_ID',
    'WAR_CONTROLLER_SESSION_CREDENTIAL',
    'WAR_CONTROLLER_WSS_URL',
    'WAR_BROWSER_NO_SANDBOX',
  ]);
  assert.equal(run.options.env.WAR_MANAGED_DEVICE_ID, 'managed-device-1');
  assert.equal(run.options.env.WAR_CONTROLLER_SESSION_CREDENTIAL, 'c'.repeat(43));
  assert.equal(JSON.stringify(result).includes('cccc'), false);
  assert.equal(result.runtime.privileged, false);
  assert.equal(result.runtime.controlPort, 49000);
});

test('managed Docker adapter uses bounded SSH Docker commands', async () => {
  const calls = [];
  const adapter = createDockerContainerAdapter({
    config: {
      wss: { enabled: true, host: '192.0.2.10', port: 47651 },
      containers: { enabled: true, runtime: 'ssh-docker', sshTarget: 'root@192.0.2.20', timeoutMs: 1000, hostLabel: 'ssh-docker' },
    },
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: 'running\n', stderr: '' };
    },
  });

  await adapter.status({ id: 'container-1', runtime: { dockerName: 'war-agent-one' } });

  assert.equal(calls[0].file, 'ssh');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-F', 'NUL', 'root@192.0.2.20', '--']);
  assert.ok(calls[0].args[4].includes("'docker' 'inspect'"));
  assert.equal(calls[0].args[4].includes(';'), false);
});

test('managed SSH Docker creation sends credentials through stdin instead of argv', async () => {
  const execCalls = [];
  const spawnCalls = [];
  const adapter = createDockerContainerAdapter({
    config: {
      wss: { enabled: true, host: '192.0.2.10', port: 47651 },
      containers: { enabled: true, runtime: 'ssh-docker', sshTarget: 'root@192.0.2.20', timeoutMs: 1000, hostLabel: 'ssh-docker' },
    },
    execFileImpl: async (file, args) => {
      execCalls.push({ file, args });
      if (args[4]?.includes("'docker' 'port'")) return { stdout: '127.0.0.1:49000\n', stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
    spawnImpl: (file, args, options) => {
      const child = fakeChildProcess();
      spawnCalls.push({ file, args, options, child });
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
  });

  await adapter.create({
    id: 'container-1',
    image: 'war-browser-agent:phase1',
    deviceId: 'managed-device-1',
    runtime: { dockerName: 'war-agent-one' },
    provisioning: { credential: 'c'.repeat(43) },
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].file, 'ssh');
  assert.equal(spawnCalls[0].args.join(' ').includes('managed-device-1'), false);
  assert.equal(spawnCalls[0].args.join(' ').includes('c'.repeat(20)), false);
  assert.ok(spawnCalls[0].args.at(-1).includes("'--env-file' '/dev/stdin'"));
  assert.match(spawnCalls[0].child.input, /^WAR_MANAGED_DEVICE_ID=managed-device-1$/m);
  assert.match(spawnCalls[0].child.input, /^WAR_CONTROLLER_SESSION_CREDENTIAL=c{43}$/m);
  assert.equal(execCalls.some((call) => call.args.join(' ').includes('c'.repeat(20))), false);
});

test('managed Docker deletion propagates runtime cleanup failure', async () => {
  const adapter = createDockerContainerAdapter({
    config: {
      wss: { enabled: true, host: '127.0.0.1', port: 47651 },
      containers: { enabled: true, runtime: 'local-docker', timeoutMs: 1000, hostLabel: 'local-docker' },
    },
    execFileImpl: async (_file, args) => {
      if (args[0] === 'rm') throw new Error('runtime cleanup failed');
      return { stdout: '', stderr: '' };
    },
  });

  await assert.rejects(() => adapter.delete({ id: 'container-1', runtime: { dockerName: 'war-agent-one' } }), /cleanup failed/);
});

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
