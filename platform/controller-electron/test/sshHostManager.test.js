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

const IMAGE_PIN = `sha256:${'a'.repeat(64)}`;
const READY_PROBE = 'ssh=1\ndocker=1\nimage=1\nimagePin=1\nimageCurrent=1\napparmor=1\nseccomp=1\nca=1\ndone=1\n';
const STALE_IMAGE_PROBE = 'ssh=1\ndocker=1\nimage=1\nimagePin=0\nimageCurrent=0\napparmor=1\nseccomp=1\nca=1\ndone=1\n';
const FORBIDDEN_HOST_MUTATIONS = /(?:^|[\s;])(git|apt-get|systemctl|apparmor_parser)(?:[\s;]|$)|docker\s+build/;

function config() {
  return {
    wss: { enabled: true, host: '192.168.1.20', port: 9443 },
    containers: { enabled: true, runtime: 'ssh-docker', image: IMAGE_PIN, imagePin: IMAGE_PIN },
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
      return { stdout: READY_PROBE, stderr: '' };
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
  assert.equal(calls[0].args[10], '--');
  assert.equal(calls[0].args[11], 'root@192.168.1.201');
  assert.equal(calls[0].args.indexOf('--'), calls[0].args.indexOf('root@192.168.1.201') - 1, 'SSH option terminator must precede the destination');
  assert.equal(calls[0].options.maxBuffer, 64 * 1024);
  assert.match(calls[0].args.at(-1), /b6182de92e8ed7cf31350969042be50352136b3d1e5dccaf6d02aebfbcf2be08/);
  assert.match(calls[0].args.at(-1), /war-browser-agent\/\/cloakbrowser-launcher/);
  assert.match(calls[0].args.at(-1), /war-browser-agent\/\/cloakbrowser-launcher\/\/war-native-host/);
  assert.match(calls[0].args.at(-1), /\/sys\/kernel\/security\/apparmor\/profiles/);
  assert.match(calls[0].args.at(-1), /war-browser-agent \(enforce\)/);
  assert.match(calls[0].args.at(-1), /6b0e60321eb4b9d774eb4eee0baa7b03d0c6b6141a593b5312e42356cf510c67/);
  assert.match(calls[0].args.at(-1), /com\.web-action-recorder\.browser-engine/);
  assert.match(calls[0].args.at(-1), /146\.0\.7680\.177\.5/);
  assert.match(calls[0].args.at(-1), /4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e/);
  assert.equal(calls[0].args.at(-1).includes('source='), false);
  assert.equal(calls[0].args.at(-1).includes('WAR_SOURCE'), false);
  assert.doesNotMatch(calls[0].args.at(-1), FORBIDDEN_HOST_MUTATIONS);
  assert.equal(JSON.stringify(store.snapshot()).includes('private-key-contents'), false);
  assert.equal(store.snapshot().containerHosts.length, 1);
});

test('SSH host manager rejects unsafe Controller destinations before probing', async () => {
  let calls = 0;
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore(),
    fsImpl: fakeFs(),
    execFileImpl: async () => { calls += 1; return { stdout: '', stderr: '' }; },
  });
  await manager.load();

  for (const controllerHost of ['127.0.0.1@attacker.example', 'controller.example/path', 'controller.example?token=x', '2001:db8::20']) {
    await assert.rejects(() => manager.addHost({
      name: 'Reviewed Linux',
      target: 'root@192.168.1.201',
      identityFile: 'C:/Users/test/.ssh/id_ed25519',
      controllerHost,
    }), /Controller host is invalid/);
  }
  assert.equal(calls, 0);
});

test('SSH host repair is a single read-only immutable-prerequisite attestation', async () => {
  const calls = [];
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] }),
    fsImpl: fakeFs(),
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: READY_PROBE, stderr: '' };
    },
    createAdapter: ({ config: adapterConfig }) => ({ config: adapterConfig }),
  });
  await manager.load();

  const result = await manager.repairHost('ssh-existing');

  assert.equal(result.connected, true);
  assert.equal(calls.length, 1, 'repair must execute exactly one attestation probe');
  const probe = calls[0].args.at(-1);
  assert.match(probe, /test -f \/etc\/apparmor\.d\/war-browser-agent/);
  assert.equal(probe.includes('/etc/apparmor.d/containers/war-browser-agent'), false);
  assert.equal(probe.includes('id_ed25519'), false);
  assert.equal(probe.includes('source='), false);
  assert.doesNotMatch(probe, FORBIDDEN_HOST_MUTATIONS);
});

test('SSH host readiness reports a stale Browser Agent image without rebuilding it', async () => {
  const calls = [];
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key', image: IMAGE_PIN, imagePin: IMAGE_PIN }] }),
    fsImpl: fakeFs(),
    execFileImpl: async (_file, args) => {
      calls.push(args.at(-1));
      return { stdout: STALE_IMAGE_PROBE, stderr: '' };
    },
  });
  await manager.load();

  const result = await manager.ensureReady('ssh-existing');

  assert.equal(result.connected, false);
  assert.equal(result.status, 'repair-required');
  assert.equal(result.diagnostics.imageCurrent, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /org\.opencontainers\.image\.revision/);
  assert.match(calls[0], /com\.web-action-recorder\.remote-control/);
  assert.match(calls[0], /com\.web-action-recorder\.browser-engine/);
  assert.match(calls[0], /com\.web-action-recorder\.browser-binary-version/);
  assert.doesNotMatch(calls[0], FORBIDDEN_HOST_MUTATIONS);
});

test('SSH host repair reports stable provisioning requirements without mutating the host', async () => {
  const calls = [];
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] }),
    fsImpl: fakeFs(),
    execFileImpl: async (_file, args) => {
      calls.push(args.at(-1));
      return { stdout: 'ssh=1\ndocker=1\nimage=0\nimageCurrent=0\napparmor=0\nseccomp=0\nca=1\ndone=1\n', stderr: '' };
    },
  });
  await manager.load();

  await assert.rejects(() => manager.repairHost('ssh-existing'), (error) => {
    assert.equal(error.code, 'HOST_PROVISIONING_REQUIRED');
    assert.deepEqual(error.details, { failedChecks: ['image', 'imagePin', 'apparmor', 'seccomp'] });
    return true;
  });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], FORBIDDEN_HOST_MUTATIONS);
});

test('SSH host readiness failure performs only the bounded read-only probe', async () => {
  const calls = [];
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] }),
    fsImpl: fakeFs(),
    execFileImpl: async (_file, args) => {
      calls.push(args.at(-1));
      return { stdout: STALE_IMAGE_PROBE, stderr: '' };
    },
  });
  await manager.load();

  const result = await manager.ensureReady('ssh-existing');

  assert.equal(result.connected, false);
  assert.equal(calls.length, 1, 'ensureReady must perform exactly one probe');
  assert.doesNotMatch(calls[0], FORBIDDEN_HOST_MUTATIONS, 'ensureReady must not mutate the Linux host');
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
      return { stdout: READY_PROBE, stderr: '' };
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

test('explicit SSH host attestations are deduplicated while readiness remains a separate probe', async () => {
  let releaseAttestation;
  let markAttestationStarted;
  const attestationGate = new Promise((resolve) => { releaseAttestation = resolve; });
  const attestationStarted = new Promise((resolve) => { markAttestationStarted = resolve; });
  let probeCalls = 0;
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] }),
    fsImpl: fakeFs(),
    now: () => '2026-08-06T00:00:00.000Z',
    execFileImpl: async () => {
      probeCalls += 1;
      if (probeCalls === 1) {
        markAttestationStarted();
        await attestationGate;
      }
      return { stdout: READY_PROBE, stderr: '' };
    },
  });
  await manager.load();

  const firstRepair = manager.repairHost('ssh-existing');
  await attestationStarted;
  const secondRepair = manager.repairHost('ssh-existing');
  const ensured = manager.ensureReady('ssh-existing');
  releaseAttestation();
  const [firstRepairedHost, secondRepairedHost, ensuredHost] = await Promise.all([firstRepair, secondRepair, ensured]);

  assert.equal(probeCalls, 2, 'two repair callers share one probe while readiness uses its own probe');
  assert.deepEqual(firstRepairedHost, secondRepairedHost);
  assert.equal(firstRepairedHost.connected, true);
  assert.equal(ensuredHost.connected, true);
  assert.equal(ensuredHost.id, 'ssh-existing');
});

test('an explicit SSH host attestation still runs when an in-flight readiness probe succeeds', async () => {
  let releaseProbe;
  let markProbeStarted;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const probeStarted = new Promise((resolve) => { markProbeStarted = resolve; });
  let probeCalls = 0;
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key' }] }),
    fsImpl: fakeFs(),
    now: () => '2026-08-06T00:00:00.000Z',
    execFileImpl: async () => {
      probeCalls += 1;
      if (probeCalls === 1) {
        markProbeStarted();
        await probeGate;
      }
      return { stdout: READY_PROBE, stderr: '' };
    },
  });
  await manager.load();

  const ensured = manager.ensureReady('ssh-existing');
  await probeStarted;
  const repaired = manager.repairHost('ssh-existing');
  releaseProbe();
  const [ensuredHost, repairedHost] = await Promise.all([ensured, repaired]);

  assert.equal(probeCalls, 2);
  assert.deepEqual(ensuredHost, repairedHost);
  assert.equal(repairedHost.connected, true);
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
    execFileImpl: async () => ({ stdout: READY_PROBE, stderr: '' }),
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
    name: 'Linux cÅ©',
    target: 'root@192.168.1.201',
    identityFile: 'C:/key',
    controllerHost: '192.168.1.20',
    controllerCaPath: '/opt/war/controller-ca.pem',
    image: IMAGE_PIN,
  }] });
  const manager = new SshContainerHostManager({
    config: config(),
    settingsStore: store,
    fsImpl: fakeFs(),
    execFileImpl: async () => ({ stdout: READY_PROBE, stderr: '' }),
  });
  await manager.load();

  const updated = await manager.updateHost('ssh-existing', {
    name: 'Linux phÃ²ng lÃ m viá»‡c',
    target: 'root@192.168.1.202',
    identityFile: '',
    controllerHost: '192.168.1.21',
    controllerCaPath: '/opt/war/controller-ca-new.pem',
    image: IMAGE_PIN,
  });

  assert.equal(updated.id, 'ssh-existing');
  assert.equal(updated.target, 'root@192.168.1.202');
  assert.equal(store.snapshot().containerHosts[0].identityFile, 'C:/key');
  assert.equal(store.snapshot().containerHosts[0].name, 'Linux phÃ²ng lÃ m viá»‡c');
});

test('SSH settings or payload image tags cannot override the main-process pin, and a missing pin makes no SSH call', async () => {
  let sshCalls = 0;
  const manager = new SshContainerHostManager({
    config: { ...config(), containers: { enabled: true, runtime: 'ssh-docker', imagePin: IMAGE_PIN } },
    settingsStore: settingsStore({ containerHosts: [{ id: 'ssh-existing', name: 'Linux', target: 'root@192.168.1.201', identityFile: 'C:/key', image: 'attacker/retag:latest' }] }),
    fsImpl: fakeFs(),
    execFileImpl: async () => { sshCalls += 1; return { stdout: READY_PROBE, stderr: '' }; },
  });
  await manager.load();

  assert.equal(manager.getHost('ssh-existing').imagePin, IMAGE_PIN, 'persisted host metadata must not authorize an image tag');
  await assert.rejects(() => manager.addHost({
    name: 'Replacement', target: 'root@192.168.1.202', identityFile: 'C:/key', controllerHost: '192.168.1.20', image: 'attacker/retag:latest',
  }), /immutable.*image.*pin/i);
  assert.equal(sshCalls, 0, 'a host without the trusted main-process pin must fail before SSH');
});

test('SSH host manager reuses the persisted host when launcher configuration names the same target', async () => {
  const persisted = {
    id: 'ssh-5ed76225293e7e07',
    name: 'Saved Linux host',
    target: 'root@192.168.1.201',
    identityFile: 'C:/Users/test/.ssh/id_ed25519',
    controllerHost: '192.168.1.20',
    controllerCaPath: '/opt/war/controller-ca.pem',
    image: `sha256:${'b'.repeat(64)}`,
  };
  const manager = new SshContainerHostManager({
    config: {
      ...config(),
      containers: {
        ...config().containers,
        hostId: 'configured-docker-host',
        sshTarget: persisted.target,
        sshIdentityFile: 'C:/launcher/id_ed25519',
        controllerHost: '192.168.1.20',
        controllerCaPath: '/etc/war/controller-ca.pem',
      },
    },
    settingsStore: settingsStore({ containerHosts: [persisted] }),
  });

  const loaded = await manager.load();
  const effective = manager.getHost(persisted.id);

  assert.equal(loaded.hosts.length, 1, 'the same SSH target must produce one effective host');
  assert.equal(loaded.hosts[0].id, persisted.id, 'the stable persisted ID must remain selected');
  assert.deepEqual(manager.configuredHostIds(), [persisted.id]);
  assert.equal(effective.imagePin, IMAGE_PIN, 'the launcher immutable image pin must win');
  assert.equal(effective.name, persisted.name);
  assert.equal(effective.identityFile, persisted.identityFile);
  assert.equal(effective.controllerHost, persisted.controllerHost);
  assert.equal(effective.controllerCaPath, persisted.controllerCaPath);
});
