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
      return { stdout: 'ssh=1\ndocker=1\nimage=1\nimageCurrent=1\nsource=1\napparmor=1\nseccomp=1\nca=1\ndone=1\n', stderr: '' };
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
      return { stdout: 'ssh=1\ndocker=1\nimage=1\nimageCurrent=1\nsource=1\napparmor=1\nseccomp=1\nca=1\ndone=1\n', stderr: '' };
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

test('SSH host manager automatically rebuilds an existing stale Browser Agent image', async () => {
  const calls = [];
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key', image: 'war-browser-agent:phase1' }] }),
    fsImpl: fakeFs(),
    execFileImpl: async (_file, args) => {
      calls.push(args.at(-1));
      if (calls.length === 1) return { stdout: 'ssh=1\ndocker=1\nimage=1\nimageCurrent=0\nsource=1\napparmor=1\nseccomp=1\nca=1\ndone=1\n', stderr: '' };
      if (calls.length === 2) return { stdout: 'repair=1\n', stderr: '' };
      return { stdout: 'ssh=1\ndocker=1\nimage=1\nimageCurrent=1\nsource=1\napparmor=1\nseccomp=1\nca=1\ndone=1\n', stderr: '' };
    },
  });
  await manager.load();

  const result = await manager.ensureReady('ssh-existing');

  assert.equal(result.connected, true);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /org\.opencontainers\.image\.revision/);
  assert.match(calls[0], /com\.web-action-recorder\.remote-control/);
  assert.match(calls[1], /--build-arg WAR_SOURCE_REVISION=/);
  assert.match(calls[1], /--unshallow/);
});

test('SSH host readiness repairs are deduplicated per host', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let probes = 0;
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] }),
    fsImpl: fakeFs(),
    execFileImpl: async () => {
      probes += 1;
      await gate;
      return { stdout: 'ssh=1\ndocker=1\nimage=1\nimageCurrent=1\nsource=1\napparmor=1\nseccomp=1\nca=1\ndone=1\n', stderr: '' };
    },
  });
  await manager.load();

  const first = manager.ensureReady('ssh-existing');
  const second = manager.ensureReady('ssh-existing');
  assert.equal(probes, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(probes, 1);
  assert.equal(results[0].connected, true);
  assert.deepEqual(results[0], results[1]);
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
  assert.match(result.diagnostics.error, /private key/i);
  assert.equal(calls, 0);
});

test('SSH host repair returns a stable code when the remote command fails', async () => {
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] }),
    fsImpl: fakeFs(),
    execFileImpl: async () => {
      const error = new Error('ssh exited with code 255');
      error.code = 255;
      error.stderr = 'Permission denied (publickey).';
      throw error;
    },
  });
  await manager.load();

  await assert.rejects(() => manager.repairHost('ssh-existing'), (error) => {
    assert.equal(error.code, 'SSH_AUTH_FAILED');
    assert.match(error.message, /authentication failed/i);
    return true;
  });
});

test('SSH host probes turn transient network failures into an actionable diagnostic', async () => {
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] }),
    fsImpl: fakeFs(),
    execFileImpl: async () => {
      const error = new Error('ssh: connect to host: Unknown error');
      error.code = 255;
      error.stderr = 'ssh: connect to host 192.168.1.201 port 22: Unknown error';
      throw error;
    },
  });
  await manager.load();

  const result = await manager.checkHost('ssh-existing');
  assert.equal(result.connected, false);
  assert.equal(result.diagnostics.error, 'The Linux host is unreachable on the network');
});

test('SSH host repair distinguishes a repaired Linux host from missing Controller WSS', async () => {
  const noWssConfig = { ...config(), wss: { enabled: false, host: '127.0.0.1', port: 0 } };
  const manager = new SshContainerHostManager({
    config: noWssConfig,
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] }),
    fsImpl: fakeFs(),
    execFileImpl: async (_file, args) => ({
      stdout: args.at(-1).includes('repair=1')
        ? 'repair=1\n'
        : 'ssh=1\ndocker=1\nimage=1\nimageCurrent=1\nsource=1\napparmor=1\nseccomp=1\nca=1\ndone=1\n',
      stderr: '',
    }),
  });
  await manager.load();

  await assert.rejects(() => manager.repairHost('ssh-existing'), (error) => {
    assert.equal(error.code, 'CONTROLLER_WSS_NOT_CONFIGURED');
    return true;
  });
});

test('SSH host manager moves hosts to persistent trash and restores or purges them', async () => {
  const store = settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] });
  const manager = new SshContainerHostManager({ config: config(), settingsStore: store, fsImpl: fakeFs(), execFileImpl: async () => ({ stdout: '', stderr: '' }), now: () => '2026-07-16T00:00:00.000Z' });
  await manager.load();

  const trashed = await manager.trashHost('ssh-existing');
  assert.equal(trashed.deletedAt, '2026-07-16T00:00:00.000Z');
  assert.equal((await manager.listHosts()).hosts.length, 0);
  assert.equal(manager.listTrashedHosts().hosts.length, 1);
  await manager.restoreHost('ssh-existing');
  assert.equal((await manager.listHosts()).hosts.length, 1);
  await manager.trashHost('ssh-existing');
  const purged = await manager.purgeHost('ssh-existing');
  assert.equal(purged.id, 'ssh-existing');
  assert.equal(manager.listTrashedHosts().hosts.length, 0);
  assert.equal(store.snapshot().purgedContainerHostIds[0], 'ssh-existing');
});

test('SSH host manager updates a selected host in place and keeps its identity', async () => {
  const store = settingsStore({ containerHosts: [{
    id: 'ssh-existing',
    name: 'Linux cũ',
    target: 'root@192.168.1.201',
    identityFile: 'C:/key',
    controllerHost: '192.168.1.20',
    controllerCaPath: '/opt/war/controller-ca.pem',
    image: 'war-browser-agent:phase1',
  }] });
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: store,
    fsImpl: fakeFs(),
    execFileImpl: async () => ({ stdout: 'ssh=1\ndocker=1\nimage=1\nimageCurrent=1\nsource=1\napparmor=1\nseccomp=1\nca=1\ndone=1\n', stderr: '' }),
  });
  await manager.load();

  const updated = await manager.updateHost('ssh-existing', {
    name: 'Linux phòng làm việc',
    target: 'root@192.168.1.202',
    identityFile: '',
    controllerHost: '192.168.1.21',
    controllerCaPath: '/opt/war/controller-ca-new.pem',
    image: 'war-browser-agent:phase1',
  });

  assert.equal(updated.id, 'ssh-existing');
  assert.equal(updated.target, 'root@192.168.1.202');
  assert.equal(store.snapshot().containerHosts[0].identityFile, 'C:/key');
  assert.equal(store.snapshot().containerHosts[0].name, 'Linux phòng làm việc');
});
