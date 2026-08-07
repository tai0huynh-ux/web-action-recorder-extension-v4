import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createDockerContainerAdapter } from '../src/containerAdapter.js';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const OLD_IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const PRIMARY_DOCKER_ID = '1'.repeat(64);
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
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedVolumeInspection())}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      if (args[0] === 'run') return { stdout: `${PRIMARY_DOCKER_ID}\n`, stderr: '' };
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

test('managed Docker adapter rejects an unsafe Controller destination at the WSS URL sink', () => {
  const base = managedConfig('ssh-docker');
  const adapter = createDockerContainerAdapter({
    config: { ...base, containers: { ...base.containers, controllerHost: '127.0.0.1@attacker.example' } },
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
  });

  assert.throws(() => adapter.controllerWssUrl(), /Controller host is invalid/);
});

test('managed Docker create pins the inspected image digest for credential write and container launch', async () => {
  const execCalls = [];
  const spawnCalls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      execCalls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedVolumeInspection())}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error(`No such network: ${args.at(-1)}`), { stderr: `No such network: ${args.at(-1)}` });
      if (args[0] === 'run') return { stdout: `${PRIMARY_DOCKER_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(managedIpv4Inspection())}\n`, stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
    spawnImpl: fakeSpawn(spawnCalls),
  });

  await adapter.create(container());

  const launch = execCalls.find((args) => args[0] === 'run' && args.includes('--name'));
  const helper = spawnCalls[0].args;
  assert.ok(helper.includes(IMAGE_ID), 'credential helper must use the inspected digest, not the mutable tag');
  assert.equal(helper.includes('no-new-privileges:true'), true);
  assert.equal(helper.includes('--network') && helper.includes('none'), true);
  assert.equal(helper.includes('--read-only'), true);
  assert.equal(helper.includes('--cap-drop') && helper.includes('ALL'), true);
  assert.ok(launch.includes(IMAGE_ID), 'container launch must use the inspected digest, not the mutable tag');
  assert.equal(launch.includes('no-new-privileges:true'), false, 'Chromium launch must preserve the reviewed AppArmor userns transition');
});

test('managed Docker rejects a generic managed-by network collision without capability labels', async () => {
  const calls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedVolumeInspection())}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify({ Id: dockerIdFor(args.at(-1)), Name: args.at(-1), Driver: 'bridge', EnableIPv4: true, EnableIPv6: false, Labels: { 'managed-by': 'war-controller' } })}\n`, stderr: '' };
      if (args[0] === 'run') return { stdout: `${PRIMARY_DOCKER_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(managedIpv4Inspection())}\n`, stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
    spawnImpl: fakeSpawn([]),
  });

  await assert.rejects(() => adapter.create(container()), /network ownership policy failed/);
  assert.equal(calls.some((args) => args[0] === 'run'), false, 'a generic managed-by collision must never be attached');
  assert.equal(calls.some((args) => args[0] === 'network' && args[1] === 'rm'), false, 'a generic managed-by collision must never be removed');
});

test('managed Docker create pins its captured Docker ID and never deletes a swapped name', async () => {
  const calls = [];
  const capturedId = dockerIdFor('created-candidate-a');
  const swappedId = dockerIdFor('foreign-candidate-b');
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedVolumeInspection())}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedNetworkInspection(args.at(-1)))}\n`, stderr: '' };
      if (args[0] === 'run') return { stdout: `${capturedId}\n`, stderr: '' };
      if (args[0] === 'inspect') {
        const id = args.at(-1) === capturedId ? capturedId : swappedId;
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: id }))}\n`, stderr: '' };
      }
      return { stdout: 'ok\n', stderr: '' };
    },
    spawnImpl: fakeSpawn([]),
  });

  const outcome = await adapter.create(container()).then(
    () => ({ rejected: false, removedIds: calls.filter((args) => args[0] === 'rm').map((args) => args[2]) }),
    () => ({ rejected: true, removedIds: calls.filter((args) => args[0] === 'rm').map((args) => args[2]) }),
  );

  assert.deepEqual(outcome, { rejected: true, removedIds: [capturedId] }, 'cleanup must stay pinned to the candidate captured before the name swap');
  assert.equal(outcome.removedIds.includes(swappedId), false, 'the replacement at the mutable name must never be removed');
});

test('managed Docker reconcile keeps a swapped replacement out of rollback cleanup after an IPv6 wait failure', async () => {
  const name = 'war-agent-one';
  const canonicalId = dockerIdFor('canonical-a');
  const launchedId = dockerIdFor('replacement-b');
  const foreignId = dockerIdFor('foreign-c');
  const displacedName = 'war-agent-one-network-backup-105e07ab';
  const calls = [];
  const desiredIpv6 = '2001:db8:9:9:a8bb:ccff:fedd:eeff';
  const oldIpv6 = '2001:db8:1:2:a8bb:ccff:fedd:eeff';
  let desiredNetwork = '';
  let launched = false;
  let postLaunchInspections = 0;
  const adapter = createDockerContainerAdapter({
    config: { ...managedConfig('local-docker'), containers: { ...managedConfig('local-docker').containers, ipv6Driver: 'macvlan', ipv6Interface: 'eth0' } },
    execFileImpl: async (file, args) => {
      calls.push([file, ...args]);
      if (file === 'ip') return { stdout: JSON.stringify([{ ifname: 'eth0', addr_info: [{ family: 'inet6', scope: 'global', prefixlen: 64, local: '2001:db8:9:9::10' }] }]), stderr: '' };
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: '', stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      if (args[0] === 'network' && args[1] === 'create') {
        if (args.includes('macvlan')) desiredNetwork = args.at(-1);
        return { stdout: 'ok\n', stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: 'true\n', stderr: '' };
      if (args[0] === 'run') {
        launched = true;
        return { stdout: `${launchedId}\n`, stderr: '' };
      }
      if (args[0] === 'inspect') {
        const target = args.at(-1);
        if (!launched || target === displacedName) {
          return { stdout: `${JSON.stringify(managedIpv4Inspection({
            Id: canonicalId,
            State: { Running: true, Status: 'running' },
            NetworkSettings: { Networks: {
              [ipv4NetworkName()]: { IPAddress: '172.30.0.2', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
              'war-managed-ipv6-stale': { GlobalIPv6Address: oldIpv6, GlobalIPv6PrefixLen: 64, MacAddress: 'aa:bb:cc:dd:ee:ff' },
            } },
          }))}\n`, stderr: '' };
        }
        if (target === launchedId) {
          return { stdout: `${JSON.stringify(managedIpv4Inspection({
            Id: launchedId,
            State: { Running: true, Status: 'running' },
            NetworkSettings: { Networks: {
              [ipv4NetworkName()]: { IPAddress: '172.30.0.2', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
              [desiredNetwork]: { GlobalIPv6Address: desiredIpv6, GlobalIPv6PrefixLen: 64, MacAddress: 'aa:bb:cc:dd:ee:ff' },
            } },
          }))}\n`, stderr: '' };
        }
        postLaunchInspections += 1;
        const isCapturedReplacement = postLaunchInspections === 1;
        return { stdout: `${JSON.stringify(managedIpv4Inspection({
          Id: isCapturedReplacement ? launchedId : foreignId,
          State: { Running: true, Status: 'running' },
          NetworkSettings: { Networks: {
            [ipv4NetworkName()]: { IPAddress: '172.30.0.2', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
            [desiredNetwork]: { GlobalIPv6Address: isCapturedReplacement ? desiredIpv6 : '2001:db8:9:9::dead', GlobalIPv6PrefixLen: 64, MacAddress: 'aa:bb:cc:dd:ee:ff' },
          } },
        }))}\n`, stderr: '' };
      }
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 0; };
  try {
    const outcome = await adapter.repair(container({ runtime: {
      ipv4Enabled: true,
      ipv4Network: ipv4NetworkName(),
      ipv6Enabled: true,
      ipv6Driver: 'macvlan',
      ipv6Interface: 'eth0',
      ipv6Prefix: '2001:db8:1:2::/64',
      ipv6Address: oldIpv6,
      ipv6Network: 'war-managed-ipv6-stale',
      ipv6Suffix: 'a8bb:ccff:fedd:eeff',
    } })).then(
      () => ({ rejected: false }),
      () => ({ rejected: true }),
    );
    const removedIds = calls.filter((call) => call[1] === 'rm').map((call) => call[3]);
    const rollback = calls.some((call) => call[1] === 'rename' && call[2] === canonicalId && call[3] === name);

    assert.deepEqual({
      rejected: outcome.rejected,
      foreignRemovalIds: removedIds.filter((id) => id === foreignId),
      rollback,
    }, {
      rejected: true,
      foreignRemovalIds: [],
      rollback: true,
    }, 'rollback cleanup must not remove a foreign replacement that reused the primary name');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('managed Docker create refuses an unlabeled colliding data volume before credential write or cleanup', async () => {
  const volume = 'war-agent-one-data';
  const calls = [];
  const spawnCalls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify({ Driver: 'bridge', EnableIPv4: true, EnableIPv6: false, Labels: { 'managed-by': 'war-controller' } })}\n`, stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify({ Name: volume, Labels: {} })}\n`, stderr: '' };
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(managedIpv4Inspection())}\n`, stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
    spawnImpl: fakeSpawn(spawnCalls),
  });

  const outcome = await adapter.create(container()).then(
    () => ({ rejected: false, credentialWrites: spawnCalls.length, removedVolume: calls.some((args) => args[0] === 'volume' && args[1] === 'rm') }),
    () => ({ rejected: true, credentialWrites: spawnCalls.length, removedVolume: calls.some((args) => args[0] === 'volume' && args[1] === 'rm') }),
  );

  assert.deepEqual(outcome, { rejected: true, credentialWrites: 0, removedVolume: false }, 'an unowned volume collision must not receive a credential or cleanup mutation');
});

test('managed Docker delete leaves foreign data-volume and network collisions untouched', async () => {
  const volume = 'war-agent-one-data';
  const collisionNetwork = ipv4NetworkName();
  const calls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(managedIpv4Inspection())}\n`, stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify({ Name: volume, Labels: {} })}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify({ Name: collisionNetwork, Labels: { 'managed-by': 'someone-else' } })}\n`, stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  await adapter.delete(container()).catch(() => {});

  const collisionMutations = calls
    .filter((args) => (args[0] === 'volume' && args[1] === 'rm' && args[3] === volume)
      || (args[0] === 'network' && args[1] === 'rm' && args[2] === collisionNetwork))
    .map((args) => args.join(' '));

  assert.deepEqual(collisionMutations, [], 'foreign data-volume and network collisions must not be removed');
});

test('managed Docker delete preserves unlabeled legacy data and generic managed network while removing the pinned canonical container', async () => {
  const volume = 'war-agent-one-data';
  const legacyNetwork = ipv4NetworkName();
  const calls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(managedIpv4Inspection())}\n`, stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify({ Name: volume, Labels: null })}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify({ Id: dockerIdFor(`legacy:${legacyNetwork}`), Name: legacyNetwork, Labels: { 'managed-by': 'war-controller' } })}\n`, stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  const outcome = await adapter.delete(container()).then(
    (result) => ({ deleted: result.status === 'deleted' }),
    () => ({ deleted: false }),
  );
  const mutations = calls.filter((args) => args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm') || (args[0] === 'network' && args[1] === 'rm'));

  assert.deepEqual(outcome, { deleted: true }, 'legacy resources must not block canonical container deletion');
  assert.deepEqual(mutations, [['rm', '-f', PRIMARY_DOCKER_ID]], 'legacy data volume and network must remain untouched');
});

test('managed Docker adapter rejects unsafe measured runtime state', async () => {
  const spawnCalls = [];
  let inspections = 0;
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedVolumeInspection())}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      if (args[0] === 'run') return { stdout: `${PRIMARY_DOCKER_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') {
        inspections += 1;
        return { stdout: `${JSON.stringify(managedIpv4Inspection(inspections === 3 ? { HostConfig: { Privileged: true } } : {}))}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    spawnImpl: fakeSpawn(spawnCalls),
  });

  await assert.rejects(() => adapter.create(container()), /security policy failed/);
});

test('managed Docker adapter rejects altered measured seccomp policy', async () => {
  let inspections = 0;
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedVolumeInspection())}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      if (args[0] === 'run') return { stdout: `${PRIMARY_DOCKER_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') {
        inspections += 1;
        return { stdout: `${JSON.stringify(managedIpv4Inspection(inspections === 3 ? { HostConfig: { SecurityOpt: ['apparmor=war-browser-agent', 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'] } } : {}))}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    spawnImpl: fakeSpawn([]),
  });

  await assert.rejects(() => adapter.create(container()), /security policy failed/);
});

test('managed Docker restart recreates a stale image container while preserving its data volume and security policy', async () => {
  const calls = [];
  const recreatedId = dockerIdFor('stale-image-replacement');
  let recreated = false;
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedNetworkInspection(args.at(-1)))}\n`, stderr: '' };
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: String(args[2]).includes('State.Status') ? 'running\n' : 'true\n', stderr: '' };
      if (args[0] === 'inspect') {
        const id = args.at(-1)?.includes('network-backup') ? PRIMARY_DOCKER_ID : recreated ? recreatedId : PRIMARY_DOCKER_ID;
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: id, Image: recreated ? IMAGE_ID : OLD_IMAGE_ID }))}\n`, stderr: '' };
      }
      if (args[0] === 'run') {
        recreated = true;
        return { stdout: `${recreatedId}\n`, stderr: '' };
      }
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
  assert.equal(calls.some((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === PRIMARY_DOCKER_ID), true);
  assert.equal(result.status, 'running');
});

test('managed Docker repair restores the secure runtime without deleting the data volume', async () => {
  const calls = [];
  let inspected = 0;
  const replacementId = dockerIdFor('repair-runtime-replacement');
  let recreated = false;
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedNetworkInspection(args.at(-1)))}\n`, stderr: '' };
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: String(args[2]).includes('State.Status') ? 'running\n' : 'true\n', stderr: '' };
      if (args[0] === 'inspect') {
        const target = args.at(-1);
        const id = target?.includes('network-backup') ? PRIMARY_DOCKER_ID : recreated ? replacementId : PRIMARY_DOCKER_ID;
        if (!recreated && target === 'war-agent-one') inspected += 1;
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: id, ...(!recreated && inspected >= 2 ? { HostConfig: { Privileged: true } } : {}) }))}\n`, stderr: '' };
      }
      if (args[0] === 'run') {
        recreated = true;
        return { stdout: `${replacementId}\n`, stderr: '' };
      }
      return { stdout: 'ok\n', stderr: '' };
    },
  });
  const result = await adapter.repair(container());
  const run = calls.find((args) => args[0] === 'run' && args.includes('--name'));
  assert.equal(result.status, 'running');
  assert.ok(run.includes('war-agent-one-data:/data'));
  assert.equal(calls.some((args) => args[0] === 'volume' && args[1] === 'rm'), false);
});

test('managed Docker repair recreates a running container whose Controller WSS endpoint drifted while preserving its data volume', async () => {
  const calls = [];
  let recreated = false;
  const replacementId = dockerIdFor('wss-drift-replacement');
  const expectedWssUrl = 'wss://192.168.1.206:47651/v1/agent-session';
  const adapter = createDockerContainerAdapter({
    config: {
      ...managedConfig('local-docker'),
      wss: { enabled: true, host: '192.168.1.206', port: 47651 },
    },
    execFileImpl: async (_file, args, options) => {
      calls.push({ args: [...args], options });
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedNetworkInspection(args.at(-1)))}\n`, stderr: '' };
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: String(args[2]).includes('State.Status') ? 'running\n' : 'true\n', stderr: '' };
      if (args[0] === 'inspect') {
        const env = recreated ? [`WAR_CONTROLLER_WSS_URL=${expectedWssUrl}`] : ['WAR_CONTROLLER_WSS_URL=wss://192.168.1.207:9443/v1/agent-session'];
        const id = args.at(-1)?.includes('network-backup') ? PRIMARY_DOCKER_ID : recreated ? replacementId : PRIMARY_DOCKER_ID;
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: id, Config: { Env: env } }))}\n`, stderr: '' };
      }
      if (args[0] === 'run') {
        recreated = true;
        return { stdout: `${replacementId}\n`, stderr: '' };
      }
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  const result = await adapter.repair(container());

  const run = calls.find((call) => call.args[0] === 'run' && call.args.includes('--name'));
  assert.equal(result.status, 'running');
  assert.ok(run, 'endpoint drift must recreate the managed container definition');
  assert.ok(run.args.includes('war-agent-one-data:/data'), 'recreate must retain the named credential volume');
  assert.equal(run.options.env.WAR_CONTROLLER_WSS_URL, expectedWssUrl);
  assert.equal(calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'rm'), false);
});

test('managed Docker repair recovers a deterministic interrupted network backup without deleting its data volume', async () => {
  const calls = [];
  const backupName = 'war-agent-one-network-backup-105e07ab';
  const backupDockerId = dockerIdFor(backupName);
  let primaryPresent = false;
  let backupPresent = true;
  let primaryDockerId = PRIMARY_DOCKER_ID;
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedNetworkInspection(args.at(-1)))}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: `${backupName}\n`, stderr: '' };
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: 'running\n', stderr: '' };
      if (args[0] === 'inspect') {
        const name = args.at(-1);
        if (name === 'war-agent-one' && !primaryPresent) throw Object.assign(new Error('No such container: war-agent-one'), { stderr: 'No such container: war-agent-one' });
        if (name === backupName && !backupPresent) throw Object.assign(new Error(`No such container: ${backupName}`), { stderr: `No such container: ${backupName}` });
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: name === 'war-agent-one' ? primaryDockerId : backupDockerId }))}\n`, stderr: '' };
      }
      if (args[0] === 'rename' && args[1] === backupDockerId && args[2] === 'war-agent-one') {
        backupPresent = false;
        primaryPresent = true;
        primaryDockerId = backupDockerId;
      }
      if (args[0] === 'run') primaryPresent = true;
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  const result = await adapter.repair(container());

  assert.equal(result.status, 'running');
  assert.ok(calls.some((args) => args.includes(backupName)), 'repair must inspect or recover the deterministic backup');
  assert.equal(calls.some((args) => args[0] === 'volume' && args[1] === 'rm'), false);
});

test('managed Docker repair retains a validated backup until an invalid primary has safely converged', async () => {
  const calls = [];
  const backupName = 'war-agent-one-network-backup-105e07ab';
  const backupDockerId = dockerIdFor(backupName);
  const replacementId = dockerIdFor('invalid-primary-replacement');
  let replacementLaunched = false;
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedNetworkInspection(args.at(-1)))}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: `${backupName}\n`, stderr: '' };
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: 'running\n', stderr: '' };
      if (args[0] === 'inspect') {
        const target = args.at(-1);
        const id = target === replacementId || (target === 'war-agent-one' && replacementLaunched) ? replacementId : target === backupName ? backupDockerId : PRIMARY_DOCKER_ID;
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: id, Image: target === 'war-agent-one' ? OLD_IMAGE_ID : IMAGE_ID }))}\n`, stderr: '' };
      }
      if (args[0] === 'run') {
        replacementLaunched = true;
        return { stdout: `${replacementId}\n`, stderr: '' };
      }
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  await assert.rejects(() => adapter.repair(container()), /security policy failed/);

  assert.equal(calls.some((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === backupName), false, 'rollback material must survive until replacement validation succeeds');
});

test('interrupted backup promotion rolls the primary container back when promotion fails', async () => {
  const calls = [];
  const backupName = 'war-agent-one-network-backup-105e07ab';
  const backupDockerId = dockerIdFor(backupName);
  let primaryPresent = true;
  let primaryRemoved = false;
  let stashedPrimaryName = null;
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedNetworkInspection(args.at(-1)))}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: `${backupName}\n`, stderr: '' };
      if (args[0] === 'inspect') {
        const name = args.at(-1);
        if (name === 'war-agent-one' && !primaryPresent) throw Object.assign(new Error('No such container: war-agent-one'), { stderr: 'No such container: war-agent-one' });
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: name === 'war-agent-one' ? PRIMARY_DOCKER_ID : backupDockerId, Image: name === 'war-agent-one' ? OLD_IMAGE_ID : IMAGE_ID }))}\n`, stderr: '' };
      }
      if (args[0] === 'rm' && args[1] === '-f' && args[2] === 'war-agent-one') {
        primaryPresent = false;
        primaryRemoved = true;
        return { stdout: 'ok\n', stderr: '' };
      }
      if (args[0] === 'rename' && args[1] === PRIMARY_DOCKER_ID && args[2] !== 'war-agent-one') {
        primaryPresent = false;
        stashedPrimaryName = args[2];
        return { stdout: 'ok\n', stderr: '' };
      }
      if (args[0] === 'run') {
        primaryPresent = true;
        return { stdout: 'ok\n', stderr: '' };
      }
      if (args[0] === 'rename' && args[1] === backupDockerId && args[2] === 'war-agent-one') {
        throw new Error('injected backup promotion failure');
      }
      if (args[0] === 'rename' && args[1] === PRIMARY_DOCKER_ID && args[2] === 'war-agent-one') {
        primaryPresent = true;
        return { stdout: 'ok\n', stderr: '' };
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });

  await assert.rejects(() => adapter.repair(container()), /injected backup promotion failure/);

  const stashIndex = calls.findIndex((args) => args[0] === 'rename' && args[1] === PRIMARY_DOCKER_ID && args[2] === stashedPrimaryName);
  const promotionIndex = calls.findIndex((args) => args[0] === 'rename' && args[1] === backupDockerId && args[2] === 'war-agent-one');
  const rollbackIndex = calls.findIndex((args) => args[0] === 'rename' && args[1] === PRIMARY_DOCKER_ID && args[2] === 'war-agent-one');
  assert.equal(primaryRemoved, false, 'primary must not be destructively removed before promotion');
  assert.ok(stashIndex >= 0 && stashIndex < promotionIndex, 'primary must be retained before backup promotion');
  assert.ok(rollbackIndex > promotionIndex, 'promotion failure must restore the retained primary');
  assert.equal(primaryPresent, true, 'primary must remain available after rollback');
});

test('recovery of a primary-to-hold interruption removes the duplicate running identity', async () => {
  const name = 'war-agent-one';
  const backupName = 'war-agent-one-network-backup-105e07ab';
  const holdName = recoveryHoldName(name);
  const calls = [];
  const state = { primary: false, backup: true, hold: true };
  const adapter = createRecoveryStateAdapter({ calls, state, name, backupName, holdName });

  const result = await adapter.repair(container());

  assert.equal(result.status, 'running');
  assert.deepEqual(runningIdentityNames(state, name, backupName, holdName), [name]);
  assert.equal(state.hold, false, 'the retained primary must be cleaned after the promoted candidate converges');
});

test('recovery validates a canonical candidate before cleaning backup and hold state', async () => {
  const name = 'war-agent-one';
  const backupName = 'war-agent-one-network-backup-105e07ab';
  const holdName = recoveryHoldName(name);
  const calls = [];
  const state = { primary: true, backup: true, hold: true };
  const adapter = createRecoveryStateAdapter({ calls, state, name, backupName, holdName });

  const result = await adapter.repair(container());

  const validationIndex = calls.findIndex((args, index) => args[0] === 'inspect' && args.at(-1) === name && index > calls.findIndex((entry) => entry[0] === 'image'));
  const cleanupIndexes = calls.map((args, index) => (args[0] === 'rm' && args[1] === '-f' && [dockerIdFor(backupName), dockerIdFor(holdName)].includes(args[2]) ? index : -1)).filter((index) => index >= 0);
  assert.equal(result.status, 'running');
  assert.equal(state.backup, false, 'validated backup must be cleaned after convergence');
  assert.equal(state.hold, false, 'validated retained primary must be cleaned after convergence');
  assert.equal(cleanupIndexes.length, 2, 'both recovery artifacts must be cleaned');
  assert.ok(cleanupIndexes.every((index) => index > validationIndex), 'candidate validation must precede recovery cleanup');
  assert.deepEqual(runningIdentityNames(state, name, backupName, holdName), [name]);
});

test('recovery restores a digest-pinned backup by captured Docker ID after the approved tag moves', async () => {
  const name = 'war-agent-one';
  const backupName = 'war-agent-one-network-backup-105e07ab';
  const holdName = recoveryHoldName(name);
  const calls = [];
  const state = { primary: false, backup: true, hold: false };
  const adapter = createRecoveryStateAdapter({ calls, state, name, backupName, holdName, imageId: OLD_IMAGE_ID });

  const currentTagId = await adapter.imageId(container().image);
  await adapter.recoverInterruptedBackup(container());

  assert.equal(currentTagId, IMAGE_ID, 'the approved mutable tag now resolves to a newer image');
  assert.deepEqual(runningIdentityNames(state, name, backupName, holdName), [name]);
  assert.ok(calls.some((args) => args[0] === 'rename' && args[1] === dockerIdFor(backupName) && args[2] === name), 'recovery must promote the captured Docker ID, never the mutable backup name');
});

test('recovery rejects a foreign deterministic hold without destructive Docker commands', async () => {
  const name = 'war-agent-one';
  const holdName = recoveryHoldName(name);
  const calls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify({ Driver: 'bridge', EnableIPv4: true, EnableIPv6: false, Labels: { 'managed-by': 'war-controller' } })}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: String(args.find((value) => String(value).startsWith('name='))).includes(holdName) ? `${holdName}\n` : '', stderr: '' };
      if (args[0] === 'inspect' && args.at(-1) === name) return { stdout: `${JSON.stringify(managedIpv4Inspection())}\n`, stderr: '' };
      if (args[0] === 'inspect' && args.at(-1) === holdName) {
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Config: { Labels: { 'managed-by': 'foreign-controller' } } }))}\n`, stderr: '' };
      }
      if (args[0] === 'rm' || args[0] === 'stop' || args[0] === 'rename') return { stdout: 'ok\n', stderr: '' };
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });

  const outcome = await adapter.repair(container()).then(
    () => ({ trustedRejection: false, destructive: calls.filter((args) => ['rm', 'stop', 'rename'].includes(args[0])) }),
    (error) => ({ trustedRejection: /RECOVERY_ARTIFACT_UNTRUSTED/.test(error.message), destructive: calls.filter((args) => ['rm', 'stop', 'rename'].includes(args[0])) }),
  );

  assert.deepEqual(outcome, { trustedRejection: true, destructive: [] }, 'a foreign hold must never be stopped, renamed, or removed');
});

test('recovery rethrows an unrelated Docker not-found error before destructive commands', async () => {
  const name = 'war-agent-one';
  const backupName = 'war-agent-one-network-backup-105e07ab';
  const calls = [];
  const unrelatedError = Object.assign(new Error('network unrelated-network not found'), { stderr: 'Error response from daemon: network unrelated-network not found' });
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify({ Driver: 'bridge', EnableIPv4: true, EnableIPv6: false, Labels: { 'managed-by': 'war-controller' } })}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: String(args.find((value) => String(value).startsWith('name='))).includes(backupName) ? `${backupName}\n` : '', stderr: '' };
      if (args[0] === 'inspect' && args.at(-1) === name) throw unrelatedError;
      if (args[0] === 'inspect' && args.at(-1) === backupName) return { stdout: `${JSON.stringify(managedIpv4Inspection())}\n`, stderr: '' };
      if (args[0] === 'rename' || args[0] === 'rm' || args[0] === 'stop') return { stdout: 'ok\n', stderr: '' };
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });

  await assert.rejects(() => adapter.repair(container()), /network unrelated-network not found/);

  assert.equal(calls.some((args) => ['rm', 'stop', 'rename'].includes(args[0])), false, 'an unrelated failure must not trigger recovery mutation');
});

test('recovery accepts the exact primary missing-container signature', async () => {
  const name = 'war-agent-one';
  const backupName = 'war-agent-one-network-backup-105e07ab';
  const calls = [];
  let primaryPresent = false;
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'ps') return { stdout: String(args.find((value) => String(value).startsWith('name='))).includes(backupName) ? `${backupName}\n` : '', stderr: '' };
      if (args[0] === 'inspect' && args.at(-1) === name && !primaryPresent) {
        throw Object.assign(new Error(`No such container: ${name}`), { stderr: `Error: No such container: ${name}` });
      }
      if (args[0] === 'inspect' && [name, backupName].includes(args.at(-1))) return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: dockerIdFor(backupName) }))}\n`, stderr: '' };
      if (args[0] === 'rename' && args[1] === dockerIdFor(backupName) && args[2] === name) {
        primaryPresent = true;
        return { stdout: 'ok\n', stderr: '' };
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });

  await adapter.recoverInterruptedBackup(container());

  assert.ok(calls.some((args) => args[0] === 'rename' && args[1] === dockerIdFor(backupName) && args[2] === name), 'the validated backup must be promoted for an exact primary-missing error');
});

test('recovery rejects an artifact whose immutable Docker ID changes before cleanup', async () => {
  const name = 'war-agent-one';
  const backupName = 'war-agent-one-network-backup-105e07ab';
  const calls = [];
  let backupInspections = 0;
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify({ Driver: 'bridge', EnableIPv4: true, EnableIPv6: false, Labels: { 'managed-by': 'war-controller' } })}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: String(args.find((value) => String(value).startsWith('name='))).includes(backupName) ? `${backupName}\n` : '', stderr: '' };
      if (args[0] === 'inspect' && args.at(-1) === name) return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: dockerIdFor(name) }))}\n`, stderr: '' };
      if (args[0] === 'inspect' && args.at(-1) === backupName) {
        backupInspections += 1;
        const id = backupInspections === 1 ? dockerIdFor(backupName) : dockerIdFor(`${backupName}-replacement`);
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: id }))}\n`, stderr: '' };
      }
      if (args[0] === 'rm' || args[0] === 'stop' || args[0] === 'rename') return { stdout: 'ok\n', stderr: '' };
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });

  const outcome = await adapter.repair(container()).then(
    () => ({ trustedRejection: false, destructive: calls.filter((args) => ['rm', 'stop', 'rename'].includes(args[0])) }),
    (error) => ({ trustedRejection: /RECOVERY_ARTIFACT_UNTRUSTED/.test(error.message), destructive: calls.filter((args) => ['rm', 'stop', 'rename'].includes(args[0])) }),
  );

  assert.deepEqual(outcome, { trustedRejection: true, destructive: [] }, 'an ID-mismatched artifact must remain untouched');
  assert.ok(backupInspections >= 2, 'cleanup must revalidate the artifact identity');
});

test('interrupted stopped IPv6 backup recovery uses the persisted endpoint after Docker clears its live address', async () => {
  const calls = [];
  const backupName = 'war-agent-one-network-backup-105e07ab';
  let primaryPresent = false;
  let backupPresent = true;
  const ipv6Network = 'war-managed-ipv6-recovered';
  const runtime = {
    dockerName: 'war-agent-one',
    ipv4Enabled: true,
    ipv4Network: ipv4NetworkName(),
    ipv6Enabled: true,
    ipv6Suffix: 'a8bb:ccff:fedd:eeff',
    ipv6Driver: 'bridge',
    ipv6Prefix: '2001:db8:1:2::/64',
    ipv6Address: '2001:db8:1:2:a8bb:ccff:fedd:eeff',
    ipv6Network,
  };
  const adapter = createDockerContainerAdapter({
    config: { ...managedConfig('local-docker'), containers: { ...managedConfig('local-docker').containers, ipv6Driver: 'bridge' } },
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'ps') return { stdout: backupPresent && String(args.find((value) => String(value).startsWith('name='))).includes(backupName) ? `${backupName}\n` : '', stderr: '' };
      if (args[0] === 'inspect' && args.at(-1) === 'war-agent-one' && !primaryPresent) throw Object.assign(new Error('No such container: war-agent-one'), { stderr: 'No such container: war-agent-one' });
      if (args[0] === 'inspect' && args.at(-1) === backupName) {
        if (!backupPresent) throw Object.assign(new Error(`No such container: ${backupName}`), { stderr: `No such container: ${backupName}` });
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: dockerIdFor(backupName),
          State: { Running: false, Status: 'exited' },
          NetworkSettings: { Networks: {
            [ipv4NetworkName()]: { IPAddress: '', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
            [ipv6Network]: { GlobalIPv6Address: '', GlobalIPv6PrefixLen: 64 },
          } },
        }))}\n`, stderr: '' };
      }
      if (args[0] === 'inspect' && args.at(-1) === 'war-agent-one') {
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: dockerIdFor(backupName),
          State: { Running: false, Status: 'exited' },
          NetworkSettings: { Networks: {
            [ipv4NetworkName()]: { IPAddress: '', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
            [ipv6Network]: { GlobalIPv6Address: '', GlobalIPv6PrefixLen: 64 },
          } },
        }))}\n`, stderr: '' };
      }
      if (args[0] === 'rename' && args[1] === dockerIdFor(backupName) && args[2] === 'war-agent-one') {
        backupPresent = false;
        primaryPresent = true;
      }
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  await adapter.recoverInterruptedBackup(container({ runtime }));

  assert.ok(calls.some((args) => args[0] === 'rename' && args[1] === dockerIdFor(backupName) && args[2] === 'war-agent-one'));
});

test('managed Docker scan accepts a stopped IPv6 container from its configured IPAM endpoint', async () => {
  const ipv6Network = 'war-managed-ipv6-recovered';
  const ipv6Address = '2001:db8:1:2:a8bb:ccff:fedd:eeff';
  const adapter = createDockerContainerAdapter({
    config: { ...managedConfig('local-docker'), containers: { ...managedConfig('local-docker').containers, ipv6Driver: 'bridge' } },
    execFileImpl: async (_file, args) => {
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: 'war-agent-one\n', stderr: '' };
      if (args[0] === 'run') return { stdout: `${'c'.repeat(43)}\n`, stderr: '' };
      if (args[0] === 'inspect') {
        return { stdout: `${JSON.stringify(managedIpv4Inspection({
          State: { Running: false, Status: 'exited' },
          Config: { Labels: { 'managed-by': 'war-controller', 'war-device-id': 'managed-device-1' } },
          NetworkSettings: { Networks: {
            [ipv4NetworkName()]: { IPAddress: '', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
            [ipv6Network]: { GlobalIPv6Address: '', GlobalIPv6PrefixLen: 64, IPAMConfig: { IPv6Address: ipv6Address } },
          } },
        }))}\n`, stderr: '' };
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });

  const result = await adapter.scanManagedContainers();

  assert.deepEqual(result.rejected, []);
  assert.equal(result.containers.length, 1);
  assert.equal(result.containers[0].status, 'stopped');
  assert.equal(result.containers[0].runtime.ipv6Address, ipv6Address);
  assert.equal(result.containers[0].runtime.ipv6Suffix, 'a8bb:ccff:fedd:eeff');
});

test('managed Docker adapter creates an IPv6 network with a stable suffix and keeps IPv4 toggle explicit', async () => {
  const execCalls = [];
  const createdId = dockerIdFor('ipv6-created-container');
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
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedVolumeInspection())}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') throw Object.assign(new Error('No such network'), { stderr: 'Error: No such network' });
      if (args[0] === 'network' && args[1] === 'create') {
        if (args.includes('macvlan')) ipv6NetworkName = args.at(-1);
        else ipv4NetworkNameSeen = args.at(-1);
        return { stdout: `${args.at(-1)}\n`, stderr: '' };
      }
      if (args[0] === 'run') return { stdout: `${createdId}\n`, stderr: '' };
      if (args[0] === 'inspect') {
        return { stdout: `${JSON.stringify(safeInspection({ Id: createdId, NetworkSettings: { Networks: {
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

test('managed Docker restart refreshes a stopped macvlan IPv6 prefix while preserving the persisted EUI-64 suffix', async () => {
  const calls = [];
  const replacementId = dockerIdFor('macvlan-prefix-replacement');
  const displacedName = 'war-agent-one-network-backup-105e07ab';
  const oldIpv6Network = 'war-managed-ipv6-stale';
  const oldPrefix = '2001:db8:1:2::/64';
  const newPrefix = '2001:db8:9:9::/64';
  const suffix = 'a8bb:ccff:fedd:eeff';
  const address = '2001:db8:9:9:a8bb:ccff:fedd:eeff';
  let newIpv6Network = '';
  let recreated = false;
  const adapter = createDockerContainerAdapter({
    config: { ...managedConfig('local-docker'), containers: { ...managedConfig('local-docker').containers, ipv6Interface: 'eth0', ipv6Driver: 'macvlan' } },
    execFileImpl: async (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === 'ip') return { stdout: JSON.stringify([{ ifname: 'eth0', addr_info: [{ family: 'inet6', scope: 'global', prefixlen: 64, local: '2001:db8:9:9::10' }] }]), stderr: '' };
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: '', stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (args.at(-1) === oldIpv6Network) return { stdout: `${JSON.stringify(managedNetworkInspection(oldIpv6Network, { family: 'ipv6', prefix: oldPrefix, driver: 'macvlan', ipv6Interface: 'eth0' }))}\n`, stderr: '' };
        throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      }
      if (args[0] === 'network' && args[1] === 'create') {
        if (args.includes('macvlan')) newIpv6Network = args.at(-1);
        return { stdout: `${args.at(-1)}\n`, stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: String(args[2]).includes('State.Running') ? 'false\n' : 'exited\n', stderr: '' };
      if (args[0] === 'create') {
        recreated = true;
        return { stdout: `${replacementId}\n`, stderr: '' };
      }
      if (args[0] === 'inspect') {
        const retainedOriginal = args.at(-1) === displacedName;
        const networks = recreated && !retainedOriginal
          ? {
              [ipv4NetworkName()]: { IPAddress: '172.30.0.2', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
              [newIpv6Network]: { GlobalIPv6Address: address, GlobalIPv6PrefixLen: 64, MacAddress: 'aa:bb:cc:dd:ee:ff' },
            }
          : {
              [ipv4NetworkName()]: { IPAddress: '', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
              [oldIpv6Network]: { GlobalIPv6Address: '', GlobalIPv6PrefixLen: 64, MacAddress: 'aa:bb:cc:dd:ee:ff' },
            };
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: retainedOriginal ? PRIMARY_DOCKER_ID : recreated ? replacementId : PRIMARY_DOCKER_ID, State: { Running: false, Status: 'exited' }, NetworkSettings: { Networks: networks } }))}\n`, stderr: '' };
      }
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  const result = await adapter.restart(container({ runtime: {
    ipv4Enabled: true,
    ipv4Network: ipv4NetworkName(),
    ipv6Enabled: true,
    ipv6Driver: 'macvlan',
    ipv6Prefix: oldPrefix,
    ipv6Address: `2001:db8:1:2:${suffix}`,
    ipv6Network: oldIpv6Network,
    ipv6Suffix: suffix,
  } }));

  const create = calls.find((call) => call.args[0] === 'create');
  assert.equal(result.runtime.ipv6Prefix, newPrefix);
  assert.equal(result.runtime.ipv6Address, address);
  assert.equal(result.runtime.ipv6Suffix, suffix);
  assert.ok(create.args.includes(`name=${newIpv6Network},ip6=${address},mac-address=aa:bb:cc:dd:ee:ff`));
});

test('managed Docker repair keeps a verified LAN IPv6 legacy attachment without recreating its Docker pool', async () => {
  const calls = [];
  const legacyIpv6Network = 'war-managed-ipv6-f33ded9b438e';
  const prefix = '2001:ee1:c053:3f00::/64';
  const suffix = 'a8bb:ccff:fedd:eeff';
  const address = `2001:ee1:c053:3f00:${suffix}`;
  const macAddress = 'aa:bb:cc:dd:ee:ff';
  const adapter = createDockerContainerAdapter({
    config: { ...managedConfig('local-docker'), containers: { ...managedConfig('local-docker').containers, ipv6Interface: 'eth0', ipv6Driver: 'macvlan' } },
    execFileImpl: async (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === 'ip') return { stdout: JSON.stringify([{ ifname: 'eth0', addr_info: [{ family: 'inet6', scope: 'global', prefixlen: 64, local: '2001:ee1:c053:3f00::10' }] }]), stderr: '' };
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: '', stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') {
        const target = args.at(-1);
        if (target === ipv4NetworkName()) return { stdout: `${JSON.stringify(managedNetworkInspection(target))}\n`, stderr: '' };
        if (target === legacyIpv6Network) return { stdout: `${JSON.stringify({ Id: dockerIdFor(target), Name: target, Driver: 'macvlan', EnableIPv4: false, EnableIPv6: true, Options: { parent: 'eth0' }, IPAM: { Config: [{ Subnet: prefix }] }, Labels: { 'managed-by': 'war-controller' } })}\n`, stderr: '' };
        throw Object.assign(new Error(`No such network: ${target}`), { stderr: `No such network: ${target}` });
      }
      if (args[0] === 'network' && args[1] === 'create') {
        throw Object.assign(new Error('Pool overlaps with other one on this address space'), { stderr: 'Error response from daemon: Pool overlaps with other one on this address space' });
      }
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: String(args[2]).includes('State.Running') ? 'true\n' : 'running\n', stderr: '' };
      if (args[0] === 'inspect') {
        const networks = {
          [ipv4NetworkName()]: { IPAddress: '172.30.0.2', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
          [legacyIpv6Network]: { GlobalIPv6Address: address, GlobalIPv6PrefixLen: 64, MacAddress: macAddress },
        };
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ State: { Running: true, Status: 'running' }, NetworkSettings: { Networks: networks } }))}\n`, stderr: '' };
      }
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  const result = await adapter.repair(container({ runtime: {
    ipv4Enabled: true,
    ipv4Network: ipv4NetworkName(),
    ipv6Enabled: true,
    ipv6Driver: 'macvlan',
    ipv6Prefix: prefix,
    ipv6Address: address,
    ipv6Network: legacyIpv6Network,
    ipv6Suffix: suffix,
  } }));

  assert.equal(result.status, 'running');
  assert.equal(result.runtime.ipv6Network, legacyIpv6Network);
  assert.equal(result.runtime.ipv6Prefix, prefix);
  assert.equal(result.runtime.ipv6Address, address);
  assert.equal(result.runtime.ipv6MacAddress, macAddress);
  assert.equal(calls.some((call) => call.args[0] === 'network' && call.args[1] === 'create'), false, 'repair must reuse an attached legacy IPv6 network instead of creating an overlapping Docker pool');
  assert.equal(calls.some((call) => call.args[0] === 'network' && call.args[1] === 'rm' && call.args[2] === dockerIdFor(legacyIpv6Network)), false, 'repair must not remove the attached legacy IPv6 network');
});

test('managed Docker startup reuses verified attached legacy IPv4 and IPv6 networks', async () => {
  const calls = [];
  const legacyIpv4Network = ipv4NetworkName();
  const legacyIpv6Network = 'war-managed-ipv6-f33ded9b438e';
  const prefix = '2001:ee1:c053:3f00::/64';
  const suffix = 'a8bb:ccff:fedd:eeff';
  const address = `2001:ee1:c053:3f00:${suffix}`;
  const macAddress = 'aa:bb:cc:dd:ee:ff';
  const adapter = createDockerContainerAdapter({
    config: { ...managedConfig('local-docker'), containers: { ...managedConfig('local-docker').containers, ipv6Interface: 'eth0', ipv6Driver: 'macvlan' } },
    execFileImpl: async (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === 'ip') return { stdout: JSON.stringify([{ ifname: 'eth0', addr_info: [{ family: 'inet6', scope: 'global', prefixlen: 64, local: '2001:ee1:c053:3f00::10' }] }]), stderr: '' };
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: '', stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') {
        const target = args.at(-1);
        if (target === legacyIpv4Network) {
          return { stdout: `${JSON.stringify(legacyIpv4NetworkInspection(target))}\n`, stderr: '' };
        }
        if (target === legacyIpv6Network) {
          return { stdout: `${JSON.stringify({
            Id: dockerIdFor(target), Name: target, Driver: 'macvlan', EnableIPv4: false, EnableIPv6: true,
            Options: { parent: 'eth0' }, IPAM: { Config: [{ Subnet: prefix }] }, Labels: { 'managed-by': 'war-controller' },
          })}\n`, stderr: '' };
        }
        throw Object.assign(new Error(`No such network: ${target}`), { stderr: `No such network: ${target}` });
      }
      if (args[0] === 'network' && ['create', 'rm'].includes(args[1])) {
        throw new Error(`startup must not mutate attached legacy network: ${args.join(' ')}`);
      }
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: 'running\n', stderr: '' };
      if (args[0] === 'inspect') {
        return { stdout: `${JSON.stringify(managedIpv4Inspection({
          State: { Running: true, Status: 'running' },
          NetworkSettings: { Networks: {
            [legacyIpv4Network]: { IPAddress: '172.30.0.2', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
            [legacyIpv6Network]: { GlobalIPv6Address: address, GlobalIPv6PrefixLen: 64, MacAddress: macAddress },
          } },
        }))}\n`, stderr: '' };
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });

  const result = await adapter.repair(container({ runtime: {
    ipv4Enabled: true,
    ipv4Network: legacyIpv4Network,
    ipv6Enabled: true,
    ipv6Driver: 'macvlan',
    ipv6Prefix: prefix,
    ipv6Address: address,
    ipv6Network: legacyIpv6Network,
    ipv6Suffix: suffix,
  } }));

  assert.equal(result.status, 'running');
  assert.equal(result.runtime.ipv4Network, legacyIpv4Network);
  assert.equal(result.runtime.ipv6Network, legacyIpv6Network);
  assert.equal(calls.some((call) => call.args[0] === 'network' && ['create', 'rm'].includes(call.args[1])), false, 'startup must retain both verified attached legacy networks');
  assert.equal(calls.some((call) => call.args[0] === 'stop' || call.args[0] === 'rename' || call.args[0] === 'start'), false, 'startup must leave the canonical running container in place');
});

test('managed Docker startup rejects unsafe legacy IPv4 attachments without mutating networks or the canonical container', async (t) => {
  const legacyIpv4Network = ipv4NetworkName();
  const cases = [
    {
      name: 'shared network with a foreign endpoint',
      inspection: legacyIpv4NetworkInspection(legacyIpv4Network, {
        Containers: {
          [PRIMARY_DOCKER_ID]: legacyIpv4Endpoint('war-agent-one'),
          [dockerIdFor('foreign-container')]: legacyIpv4Endpoint('foreign-container'),
        },
      }),
    },
    {
      name: 'missing legacy IPv4 family label',
      inspection: legacyIpv4NetworkInspection(legacyIpv4Network, { Labels: { 'managed-by': 'war-controller' } }),
    },
    {
      name: 'wrong legacy IPv4 family label',
      inspection: legacyIpv4NetworkInspection(legacyIpv4Network, { Labels: { 'managed-by': 'war-controller', 'war-ipv4-family': 'false' } }),
    },
    {
      name: 'missing IPv4 IPAM subnet',
      inspection: legacyIpv4NetworkInspection(legacyIpv4Network, { IPAM: { Config: [] } }),
    },
    {
      name: 'invalid IPv4 IPAM subnet',
      inspection: legacyIpv4NetworkInspection(legacyIpv4Network, { IPAM: { Config: [{ Subnet: '2001:db8::/64' }] } }),
    },
    {
      name: 'missing explicit local topology flags',
      inspection: legacyIpv4NetworkInspection(legacyIpv4Network, { includeTopology: false }),
    },
    {
      name: 'internal network',
      inspection: legacyIpv4NetworkInspection(legacyIpv4Network, { Internal: true }),
    },
    {
      name: 'ingress network',
      inspection: legacyIpv4NetworkInspection(legacyIpv4Network, { Ingress: true }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const adapter = createDockerContainerAdapter({
        config: managedConfig('local-docker'),
        execFileImpl: async (_file, args) => {
          calls.push([...args]);
          if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
          if (args[0] === 'ps') return { stdout: '', stderr: '' };
          if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(scenario.inspection)}\n`, stderr: '' };
          if (args[0] === 'network' && ['create', 'rm'].includes(args[1])) throw new Error(`unsafe legacy network must not mutate: ${args.join(' ')}`);
          if (args[0] === 'inspect' && args[1] === '-f') return { stdout: 'running\n', stderr: '' };
          if (args[0] === 'inspect') {
            return { stdout: `${JSON.stringify(managedIpv4Inspection({
              State: { Running: true, Status: 'running' },
              NetworkSettings: { Networks: { [legacyIpv4Network]: { IPAddress: '172.30.0.2', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 } } },
            }))}\n`, stderr: '' };
          }
          throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
        },
      });

      await assert.rejects(() => adapter.repair(container({ runtime: { ipv4Enabled: true, ipv4Network: legacyIpv4Network, ipv6Enabled: false } })), /Managed network ownership policy failed/);

      assert.ok(calls.some((args) => args[0] === 'network' && args[1] === 'inspect'), 'startup must inspect the legacy IPv4 network before accepting it');
      assert.equal(calls.some((args) => args[0] === 'network' && ['create', 'rm'].includes(args[1])), false);
      assert.equal(calls.some((args) => ['stop', 'rename', 'start'].includes(args[0])), false);
    });
  }
});

test('managed Docker startup rejects a legacy IPv4 attachment when persisted runtime name is not deterministic', async () => {
  const calls = [];
  const legacyIpv4Network = ipv4NetworkName();
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: '', stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(legacyIpv4NetworkInspection(legacyIpv4Network))}\n`, stderr: '' };
      if (args[0] === 'network' && ['create', 'rm'].includes(args[1])) throw new Error(`runtime mismatch must not mutate: ${args.join(' ')}`);
      if (args[0] === 'inspect') {
        return { stdout: `${JSON.stringify(managedIpv4Inspection({
          State: { Running: true, Status: 'running' },
          NetworkSettings: { Networks: { [legacyIpv4Network]: { IPAddress: '172.30.0.2', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 } } },
        }))}\n`, stderr: '' };
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });

  await assert.rejects(() => adapter.repair(container({ runtime: {
    ipv4Enabled: true,
    ipv4Network: 'war-managed-ipv4-000000000000',
    ipv6Enabled: false,
  } })), /Managed network ownership policy failed/);

  assert.equal(calls.some((args) => args[0] === 'network' && ['create', 'rm'].includes(args[1])), false);
  assert.equal(calls.some((args) => ['stop', 'rename', 'start'].includes(args[0])), false);
});

test('managed Docker create keeps schema-v1 IPv4 ownership strict for a legacy deterministic network', async () => {
  const calls = [];
  const legacyIpv4Network = ipv4NetworkName();
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedVolumeInspection())}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(legacyIpv4NetworkInspection(legacyIpv4Network))}\n`, stderr: '' };
      if (args[0] === 'network' && ['create', 'rm'].includes(args[1])) throw new Error(`new provisioning must not mutate legacy network: ${args.join(' ')}`);
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });

  await assert.rejects(() => adapter.create(container({ runtime: { ipv4Enabled: true, ipv4Network: legacyIpv4Network, ipv6Enabled: false } })), /Managed network ownership policy failed/);

  assert.equal(calls.some((args) => args[0] === 'network' && ['create', 'rm'].includes(args[1])), false);
  assert.equal(calls.some((args) => ['run', 'stop', 'rename'].includes(args[0])), false);
});

test('managed Docker start reuses empty post-reboot legacy endpoints only for the stopped canonical container', async () => {
  const calls = [];
  const legacyIpv4Network = ipv4NetworkName();
  const legacyIpv6Network = 'war-managed-ipv6-f33ded9b438e';
  const prefix = '2001:ee1:c053:3f00::/64';
  const suffix = 'a8bb:ccff:fedd:eeff';
  const address = `2001:ee1:c053:3f00:${suffix}`;
  const state = { running: false };
  const adapter = createPostRebootLegacyStartAdapter({
    calls,
    state,
    legacyIpv4Network,
    legacyIpv6Network,
    prefix,
    address,
    ipv4Inspection: legacyIpv4NetworkInspection(legacyIpv4Network, { Containers: {} }),
  });

  const result = await adapter.start(container({ runtime: {
    ipv4Enabled: true,
    ipv4Network: legacyIpv4Network,
    ipv6Enabled: true,
    ipv6Driver: 'macvlan',
    ipv6Prefix: prefix,
    ipv6Address: address,
    ipv6Network: legacyIpv6Network,
    ipv6Suffix: suffix,
  } }));

  assert.equal(result.status, 'running');
  assert.equal(state.running, true);
  assert.equal(calls.filter((args) => args[0] === 'start' && args[1] === PRIMARY_DOCKER_ID).length, 1);
  assert.equal(calls.some((args) => args[0] === 'network' && ['create', 'rm'].includes(args[1])), false, 'post-reboot start must preserve both attached legacy networks');
});

test('managed Docker start rejects empty or foreign post-reboot legacy IPv4 endpoints outside the stopped canonical exception', async (t) => {
  const legacyIpv4Network = ipv4NetworkName();
  const legacyIpv6Network = 'war-managed-ipv6-f33ded9b438e';
  const prefix = '2001:ee1:c053:3f00::/64';
  const suffix = 'a8bb:ccff:fedd:eeff';
  const address = `2001:ee1:c053:3f00:${suffix}`;
  const runtime = {
    ipv4Enabled: true,
    ipv4Network: legacyIpv4Network,
    ipv6Enabled: true,
    ipv6Driver: 'macvlan',
    ipv6Prefix: prefix,
    ipv6Address: address,
    ipv6Network: legacyIpv6Network,
    ipv6Suffix: suffix,
  };
  const cases = [
    { name: 'running canonical with no Docker network endpoint', running: true, Containers: {} },
    { name: 'stopped canonical with a foreign Docker network endpoint', running: false, Containers: { [dockerIdFor('foreign-container')]: legacyIpv4Endpoint('foreign-container') } },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const adapter = createPostRebootLegacyStartAdapter({
        calls,
        state: { running: scenario.running },
        legacyIpv4Network,
        legacyIpv6Network,
        prefix,
        address,
        ipv4Inspection: legacyIpv4NetworkInspection(legacyIpv4Network, { Containers: scenario.Containers }),
      });

      await assert.rejects(() => adapter.start(container({ runtime })), /Managed network ownership policy failed/);

      assert.equal(calls.some((args) => args[0] === 'network' && ['create', 'rm'].includes(args[1])), false);
      assert.equal(calls.some((args) => ['start', 'stop', 'rename'].includes(args[0])), false);
    });
  }
});

test('managed Docker start waits for a macvlan live endpoint only after starting a stopped container', async () => {
  const calls = [];
  const ipv6Network = 'war-managed-ipv6-5922f5ea271e';
  const suffix = 'a8bb:ccff:fedd:eeff';
  const address = `2001:db8:1:2:${suffix}`;
  let created = false;
  let started = false;
  let inactiveEndpointInspections = 0;
  const adapter = createDockerContainerAdapter({
    config: { ...managedConfig('local-docker'), containers: { ...managedConfig('local-docker').containers, ipv6Interface: 'eth0', ipv6Driver: 'macvlan' } },
    execFileImpl: async (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === 'ip') return { stdout: JSON.stringify([{ ifname: 'eth0', addr_info: [{ family: 'inet6', scope: 'global', prefixlen: 64, local: '2001:db8:1:2::10' }] }]), stderr: '' };
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: '', stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (args.at(-1) === ipv4NetworkName()) return { stdout: `${JSON.stringify(managedNetworkInspection(ipv4NetworkName()))}\n`, stderr: '' };
        return { stdout: `${JSON.stringify(managedNetworkInspection(ipv6Network, { family: 'ipv6', prefix: '2001:db8:1:2::/64', driver: 'macvlan', ipv6Interface: 'eth0' }))}\n`, stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: 'false\n', stderr: '' };
      if (args[0] === 'create') created = true;
      if (args[0] === 'start') started = true;
      if (args[0] === 'inspect') {
        if (created && !started) inactiveEndpointInspections += 1;
        const live = started;
        return { stdout: `${JSON.stringify(managedIpv4Inspection({
          State: { Running: live, Status: live ? 'running' : 'exited' },
          NetworkSettings: { Networks: {
            [ipv4NetworkName()]: { IPAddress: live ? '172.30.0.2' : '', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
            [ipv6Network]: { GlobalIPv6Address: live ? address : '', GlobalIPv6PrefixLen: 64, MacAddress: live ? 'aa:bb:cc:dd:ee:ff' : '', IPAMConfig: { IPv6Address: address } },
          } },
        }))}\n`, stderr: '' };
      }
      return { stdout: 'ok\n', stderr: '' };
    },
  });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 0; };
  try {
    const result = await adapter.start(container({ runtime: {
      ipv4Enabled: true,
      ipv4Network: ipv4NetworkName(),
      ipv6Enabled: true,
      ipv6Driver: 'macvlan',
      ipv6Prefix: '2001:db8:1:2::/64',
      ipv6Address: address,
      ipv6Network,
      ipv6Suffix: suffix,
    } }));

    assert.equal(result.status, 'running');
    assert.equal(inactiveEndpointInspections, 0, 'must not poll an inactive container for a live macvlan endpoint');
    assert.equal(calls.filter((call) => call.args[0] === 'start').length, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
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
      if (args.at(-1)?.includes("'volume' 'inspect'")) return { stdout: `${JSON.stringify(managedVolumeInspection())}\n`, stderr: '' };
      if (args.at(-1)?.includes("'network' 'inspect'")) throw Object.assign(new Error('No such network'), { stderr: 'No such network' });
      if (args.at(-1)?.includes("'run'")) return { stdout: `${PRIMARY_DOCKER_ID}\n`, stderr: '' };
      if (args.at(-1)?.includes("'inspect' '--format' '{{json .}}'")) return { stdout: `${JSON.stringify(managedIpv4Inspection(remoteSecurityOptions()))}\n`, stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
    spawnImpl: fakeSpawn(spawnCalls, {
      stdoutFor: (_file, args) => args.at(-1)?.includes("'--env-file' '/dev/stdin'") ? `${PRIMARY_DOCKER_ID}\n` : '',
    }),
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
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(managedIpv4Inspection())}\n`, stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedVolumeInspection())}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedNetworkInspection(args.at(-1)))}\n`, stderr: '' };
      if (args[0] === 'rm') throw new Error('runtime cleanup failed');
      return { stdout: '', stderr: '' };
    },
  });

  await assert.rejects(() => adapter.delete(container()), /cleanup failed/);
});

test('managed Docker stop accepts an approved immutable image ID after digest-pinned launch', async () => {
  const calls = [];
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'inspect') return { stdout: `${JSON.stringify(managedIpv4Inspection({ Config: { Image: IMAGE_ID }, State: { Running: false, Status: 'exited' } }))}\n`, stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  const result = await adapter.stop(container({ runtime: { ipv4Network: ipv4NetworkName() } }));

  assert.equal(result.status, 'stopped');
  assert.ok(calls.some((args) => args[0] === 'stop' && args[3] === PRIMARY_DOCKER_ID));
});

test('managed Docker stop accepts cleared endpoint addresses while preserving policy checks', async () => {
  const adapter = createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: 'exited\n', stderr: '' };
      if (args[0] === 'inspect') {
        return { stdout: `${JSON.stringify(managedIpv4Inspection({
          State: { Running: false, Status: 'exited' },
          NetworkSettings: { Networks: { [ipv4NetworkName()]: { IPAddress: '', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 } } },
        }))}\n`, stderr: '' };
      }
      return { stdout: 'ok\n', stderr: '' };
    },
  });

  const result = await adapter.stop(container({ runtime: { ipv4Network: ipv4NetworkName() } }));
  assert.equal(result.status, 'stopped');
  assert.equal(result.runtime.nonRootUser, 'war');
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
    Id: PRIMARY_DOCKER_ID,
    Image: IMAGE_ID,
    Config: {
      User: 'war',
      Image: 'war-browser-agent:phase1',
      Labels: {
        'managed-by': 'war-controller',
        'war-container-id': 'container-1',
        'war-container-name': 'Agent One',
        'war-device-id': 'managed-device-1',
      },
      Env: ['WAR_CONTROLLER_WSS_URL=wss://controller.example:47651/v1/agent-session'],
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

function managedIpv4InspectionFor(containerName, overrides = {}) {
  return managedIpv4Inspection({ Id: dockerIdFor(containerName), ...overrides });
}

function legacyIpv4NetworkInspection(name, {
  Labels = { 'managed-by': 'war-controller', 'war-ipv4-family': 'true' },
  Scope = 'local',
  Internal = false,
  Ingress = false,
  includeTopology = true,
  IPAM = { Config: [{ Subnet: '172.30.0.0/16', Gateway: '172.30.0.1' }] },
  Containers = { [PRIMARY_DOCKER_ID]: legacyIpv4Endpoint('war-agent-one') },
} = {}) {
  return {
    Id: dockerIdFor(`network:${name}`),
    Name: name,
    Driver: 'bridge',
    EnableIPv4: true,
    EnableIPv6: false,
    Scope,
    ...(includeTopology ? { Internal, Ingress } : {}),
    IPAM,
    Containers,
    Labels,
  };
}

function legacyIpv4Endpoint(name) {
  return {
    Name: name,
    EndpointID: crypto.createHash('sha256').update(`endpoint:${name}`).digest('hex'),
    IPv4Address: '172.30.0.2/16',
    IPv6Address: '',
  };
}

function legacyIpv6NetworkInspection(name, prefix) {
  return {
    Id: dockerIdFor(`network:${name}`),
    Name: name,
    Driver: 'macvlan',
    EnableIPv4: false,
    EnableIPv6: true,
    Options: { parent: 'eth0' },
    IPAM: { Config: [{ Subnet: prefix }] },
    Labels: { 'managed-by': 'war-controller' },
  };
}

function createPostRebootLegacyStartAdapter({ calls, state, legacyIpv4Network, legacyIpv6Network, prefix, address, ipv4Inspection }) {
  const macAddress = 'aa:bb:cc:dd:ee:ff';
  return createDockerContainerAdapter({
    config: { ...managedConfig('local-docker'), containers: { ...managedConfig('local-docker').containers, ipv6Interface: 'eth0', ipv6Driver: 'macvlan' } },
    execFileImpl: async (file, args) => {
      calls.push([...args]);
      if (file === 'ip') return { stdout: JSON.stringify([{ ifname: 'eth0', addr_info: [{ family: 'inet6', scope: 'global', prefixlen: 64, local: '2001:ee1:c053:3f00::10' }] }]), stderr: '' };
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'ps') return { stdout: '', stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (args.at(-1) === legacyIpv4Network) return { stdout: `${JSON.stringify(ipv4Inspection)}\n`, stderr: '' };
        if (args.at(-1) === legacyIpv6Network) return { stdout: `${JSON.stringify(legacyIpv6NetworkInspection(legacyIpv6Network, prefix))}\n`, stderr: '' };
        throw Object.assign(new Error(`No such network: ${args.at(-1)}`), { stderr: `No such network: ${args.at(-1)}` });
      }
      if (args[0] === 'network' && ['create', 'rm'].includes(args[1])) throw new Error(`post-reboot recovery must not mutate networks: ${args.join(' ')}`);
      if (args[0] === 'start') {
        state.running = true;
        return { stdout: 'ok\n', stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: state.running ? 'true\n' : 'false\n', stderr: '' };
      if (args[0] === 'inspect') {
        const live = state.running;
        return { stdout: `${JSON.stringify(managedIpv4Inspection({
          State: { Running: live, Status: live ? 'running' : 'exited' },
          NetworkSettings: { Networks: {
            [legacyIpv4Network]: { IPAddress: live ? '172.30.0.2' : '', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0 },
            [legacyIpv6Network]: { GlobalIPv6Address: live ? address : '', GlobalIPv6PrefixLen: 64, MacAddress: live ? macAddress : '', IPAMConfig: { IPv6Address: address } },
          } },
        }))}\n`, stderr: '' };
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });
}

function managedVolumeInspection(name = 'war-agent-one-data') {
  return {
    Name: name,
    CreatedAt: '2026-08-06T00:00:00Z',
    Driver: 'local',
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    Labels: {
      'managed-by': 'war-controller',
      'war-container-id': 'container-1',
      'war-container-name': 'Agent One',
      'war-device-id': 'managed-device-1',
      'war-data-volume': 'true',
    },
    Options: {},
    Scope: 'local',
  };
}

function managedNetworkInspection(name, { family = 'ipv4', prefix = 'none', driver = 'bridge', host = 'local-docker', ipv6Interface = null } = {}) {
  const ipv6 = family === 'ipv6';
  return {
    Id: dockerIdFor(`network:${name}`),
    Name: name,
    Driver: driver,
    EnableIPv4: !ipv6,
    EnableIPv6: ipv6,
    ...(ipv6 ? { IPAM: { Config: [{ Subnet: prefix }] } } : {}),
    ...(driver === 'macvlan' ? { Options: { parent: ipv6Interface } } : {}),
    Labels: {
      'managed-by': 'war-controller',
      'war-network-version': '1',
      'war-network-kind': 'container-network',
      'war-network-host': host,
      'war-network-family': family,
      'war-network-prefix': prefix,
      'war-network-driver': driver,
    },
  };
}

function dockerIdFor(containerName) {
  return crypto.createHash('sha256').update(`docker-id:${containerName}`).digest('hex');
}

function recoveryHoldName(containerName) {
  const hash = crypto.createHash('sha256').update(`recovery-hold:${containerName}`).digest('hex').slice(0, 8);
  return `${String(containerName).slice(0, 52)}-recovery-hold-${hash}`;
}

function runningIdentityNames(state, name, backupName, holdName) {
  return [[name, state.primary], [backupName, state.backup], [holdName, state.hold]]
    .filter(([, running]) => running)
    .map(([containerName]) => containerName);
}

function createRecoveryStateAdapter({ calls, state, name, backupName, holdName, imageId = IMAGE_ID }) {
  const ids = {
    primary: dockerIdFor(name),
    backup: dockerIdFor(backupName),
    hold: dockerIdFor(holdName),
  };
  return createDockerContainerAdapter({
    config: managedConfig('local-docker'),
    execFileImpl: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: `${JSON.stringify(managedNetworkInspection(args.at(-1)))}\n`, stderr: '' };
      if (args[0] === 'ps') {
        const filter = args.find((value) => String(value).startsWith('name='));
        if (String(filter).includes(backupName)) return { stdout: state.backup ? `${backupName}\n` : '', stderr: '' };
        if (String(filter).includes(holdName)) return { stdout: state.hold ? `${holdName}\n` : '', stderr: '' };
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'inspect' && args[1] === '-f') return { stdout: 'running\n', stderr: '' };
      if (args[0] === 'inspect') {
        const target = args.at(-1);
        const targetName = target === ids.primary ? name : target === ids.backup ? backupName : target === ids.hold ? holdName : target;
        const present = (targetName === name && state.primary)
          || (targetName === backupName && state.backup)
          || (targetName === holdName && state.hold);
        if (!present) throw Object.assign(new Error(`No such container: ${target}`), { stderr: `No such container: ${target}` });
        const dockerId = targetName === name ? ids.primary : targetName === backupName ? ids.backup : ids.hold;
        return { stdout: `${JSON.stringify(managedIpv4Inspection({ Id: dockerId, Image: imageId, Config: { Image: imageId } }))}\n`, stderr: '' };
      }
      if (args[0] === 'rename' && args[1] === ids.backup && args[2] === name) {
        state.backup = false;
        state.primary = true;
        ids.primary = ids.backup;
        return { stdout: 'ok\n', stderr: '' };
      }
      if (args[0] === 'rm' && args[1] === '-f') {
        if (args[2] === ids.backup) state.backup = false;
        if (args[2] === ids.hold) state.hold = false;
        return { stdout: 'ok\n', stderr: '' };
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  });
}

function fakeSpawn(calls, { stdoutFor = () => '' } = {}) {
  return (file, args, options) => {
    const child = fakeChildProcess();
    calls.push({ file, args, options, child });
    queueMicrotask(() => {
      child.emitStdout(stdoutFor(file, args, options));
      child.emit('close', 0);
    });
    return child;
  };
}

function fakeChildProcess() {
  const listeners = new Map();
  const streamListeners = new Map();
  const stream = (kind) => ({
    on(event, handler) {
      if (event === 'data') streamListeners.set(kind, handler);
    },
  });
  const child = {
    stdout: stream('stdout'),
    stderr: stream('stderr'),
    stdin: { on() {}, end(value) { child.input = value; } },
    on(event, handler) { listeners.set(event, handler); },
    emit(event, value) { listeners.get(event)?.(value); },
    emitStdout(value) { if (value) streamListeners.get('stdout')?.(value); },
    kill() {},
    input: '',
  };
  return child;
}
