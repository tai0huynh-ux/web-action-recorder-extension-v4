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
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
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
  assert.ok(run.args.includes('WAR_MANAGED_DEVICE_ID=managed-device-1'));
  assert.ok(run.args.includes('WAR_BROWSER_NO_SANDBOX=1'));
  assert.ok(run.args.includes(`WAR_CONTROLLER_SESSION_CREDENTIAL=${'c'.repeat(43)}`));
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
