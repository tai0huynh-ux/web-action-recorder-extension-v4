import test from 'node:test';
import assert from 'node:assert/strict';
import { SshContainerHostManager } from '../src/sshHostManager.js';

function fakeFs() {
  return {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true }),
  };
}

function settingsStore(initial = {}) {
  let value = structuredClone(initial);
  return {
    async get() { return structuredClone(value); },
    async update(patch) { value = { ...value, ...structuredClone(patch) }; return structuredClone(value); },
    snapshot() { return structuredClone(value); },
  };
}

function config() {
  return {
    wss: { enabled: true, host: '192.168.1.20', port: 9443 },
    containers: { enabled: false, image: 'war-browser-agent:phase1' },
  };
}

test('SSH host manager stores only host metadata and probes bounded prerequisites', async () => {
  const calls = [];
  const store = settingsStore();
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: store,
    fsImpl: fakeFs(),
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: 'ssh=1\ndocker=1\nimage=1\nsource=1\napparmor=1\nseccomp=1\nca=1\ndone=1\n', stderr: '' };
    },
    createAdapter: ({ config: adapterConfig }) => ({ config: adapterConfig }),
  });

  await manager.load();
  const host = await manager.addHost({
    name: 'Reviewed Linux',
    target: 'root@192.168.1.201',
    identityFile: 'C:/Users/test/.ssh/id_ed25519',
    controllerHost: '192.168.1.20',
  });

  assert.equal(host.connected, true);
  assert.equal(host.diagnostics.ready, true);
  assert.equal(host.diagnostics.ca, true);
  assert.equal(calls[0].file, 'ssh');
  assert.deepEqual(calls[0].args.slice(0, 8), ['-F', 'NUL', '-i', 'C:/Users/test/.ssh/id_ed25519', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes']);
  assert.equal(calls[0].args[8], '-o');
  assert.equal(calls[0].args[9], 'ConnectTimeout=10');
  assert.equal(calls[0].options.maxBuffer, 64 * 1024);
  assert.match(calls[0].args.at(-1), /0d28cf5e412992d3cb1bc8759bb6cf9cf1602e9aee54ebef52046f3f9b9b710d/);
  assert.match(calls[0].args.at(-1), /e11ad80b10af89cdade31962005da51dae8cd8828c0d9c02dadf67008aa5181d/);
  assert.equal(JSON.stringify(store.snapshot()).includes('private-key-contents'), false);
  assert.equal(store.snapshot().containerHosts.length, 1);
});

test('SSH host manager repair uses a fixed bounded script and rechecks readiness', async () => {
  const calls = [];
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] }),
    fsImpl: fakeFs(),
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      if (calls.length === 1) return { stdout: 'repair=1\n', stderr: '' };
      return { stdout: 'ssh=1\ndocker=1\nimage=1\nsource=1\napparmor=1\nseccomp=1\nca=1\ndone=1\n', stderr: '' };
    },
    createAdapter: ({ config: adapterConfig }) => ({ config: adapterConfig }),
  });
  await manager.load();

  const result = await manager.repairHost('ssh-existing');

  assert.equal(result.connected, true);
  assert.match(calls[0].args.at(-1), /apparmor_parser -r -W/);
  assert.match(calls[0].args.at(-1), /docker build/);
  assert.equal(calls[0].args.at(-1).includes('id_ed25519'), false);
});

test('SSH host manager reports unreadable key without invoking SSH', async () => {
  let calls = 0;
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-bad', name: 'Bad', target: 'root@192.168.1.201', identityFile: 'C:/missing' }] }),
    fsImpl: { existsSync: () => false, statSync: () => ({ isFile: () => true }) },
    execFileImpl: async () => { calls += 1; return { stdout: '', stderr: '' }; },
  });
  await manager.load();

  const result = await manager.checkHost('ssh-bad');

  assert.equal(result.connected, false);
  assert.match(result.diagnostics.error, /identity file/i);
  assert.equal(calls, 0);
});
