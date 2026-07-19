import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveElectronRuntimeConfig, toPublicRuntimeConfig } from '../src/runtimeConfig.js';

test('runtime config defaults to local disabled WSS and userData state', () => {
  const config = resolveElectronRuntimeConfig({ app: fakeApp('C:/Users/a/AppData/Roaming/War') , env: {} });
  assert.equal(config.storePath, path.join('C:/Users/a/AppData/Roaming/War', 'controller-state.json'));
  assert.equal(config.wss.enabled, false);
  assert.equal(config.wss.host, '127.0.0.1');
  assert.equal(config.wss.port, 0);
  assert.equal(config.devTools, false);
});

test('runtime config supports custom state path', () => {
  const config = resolveElectronRuntimeConfig({ app: fakeApp('/ignored'), env: { WAR_CONTROLLER_ELECTRON_DATA_PATH: 'D:/war-data' } });
  assert.equal(config.storePath, path.join('D:/war-data', 'controller-state.json'));
});

test('runtime config accepts valid loopback WSS TLS settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-config-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  fs.writeFileSync(cert, 'cert');
  fs.writeFileSync(key, 'key');
  const config = resolveElectronRuntimeConfig({
    app: fakeApp(dir),
    env: {
      WAR_CONTROLLER_WSS_ENABLED: '1',
      WAR_CONTROLLER_WSS_PORT: '9443',
      WAR_CONTROLLER_TLS_CERT_PATH: cert,
      WAR_CONTROLLER_TLS_KEY_PATH: key,
    },
  });
  assert.equal(config.wss.enabled, true);
  assert.equal(config.wss.port, 9443);
});

test('runtime config degrades invalid WSS options safely', () => {
  const invalidPort = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTROLLER_WSS_PORT: 'abc' } });
  assert.equal(invalidPort.degraded, true);
  assert.equal(invalidPort.wss.enabled, false);

  const missingCert = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTROLLER_WSS_ENABLED: '1', WAR_CONTROLLER_TLS_KEY_PATH: 'C:/key.pem' } });
  assert.equal(missingCert.degraded, true);

  const missingKey = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTROLLER_WSS_ENABLED: '1', WAR_CONTROLLER_TLS_CERT_PATH: 'C:/cert.pem' } });
  assert.equal(missingKey.degraded, true);
});

test('runtime config requires LAN opt-in for non-loopback bind', () => {
  const blocked = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTROLLER_WSS_HOST: '192.168.1.20' } });
  assert.equal(blocked.degraded, true);
  const allowed = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTROLLER_WSS_HOST: '192.168.1.20', WAR_CONTROLLER_ALLOW_LAN: '1' } });
  assert.equal(allowed.degraded, false);
});

test('public runtime config redacts filesystem and TLS details', () => {
  const config = resolveElectronRuntimeConfig({
    app: fakeApp('C:/Users/a/AppData/Roaming/War'),
    env: { WAR_CONTROLLER_TLS_CERT_PATH: 'C:/secret/cert.pem', WAR_CONTROLLER_TLS_KEY_PATH: 'C:/secret/key.pem' },
  });
  const dto = toPublicRuntimeConfig(config);
  assert.equal(dto.dataPath, 'War');
  assert.equal(dto.wss.certificate, 'cert.pem');
  assert.equal(JSON.stringify(dto).includes('key.pem'), false);
  assert.equal(JSON.stringify(dto).includes('C:/secret'), false);
});

test('managed container runtime requires explicit supported Docker configuration', () => {
  const disabled = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: {} });
  assert.equal(disabled.containers.enabled, false);

  const missingSsh = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTAINER_RUNTIME: 'ssh-docker' } });
  assert.equal(missingSsh.degraded, true);
  assert.equal(missingSsh.containers.enabled, false);
});

test('public runtime config redacts managed container paths and target details', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-config-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  const ca = path.join(dir, 'ca.pem');
  const identity = path.join(dir, 'id_ed25519');
  fs.writeFileSync(cert, 'cert');
  fs.writeFileSync(key, 'key');
  fs.writeFileSync(ca, 'ca');
  fs.writeFileSync(identity, 'private-key-placeholder');
  const config = resolveElectronRuntimeConfig({
    app: fakeApp('/data'),
    env: {
      WAR_CONTROLLER_WSS_ENABLED: '1',
      WAR_CONTROLLER_TLS_CERT_PATH: cert,
      WAR_CONTROLLER_TLS_KEY_PATH: key,
      WAR_CONTAINER_RUNTIME: 'ssh-docker',
      WAR_CONTAINER_HOST_LABEL: 'Linux Docker phòng làm việc',
      WAR_CONTAINER_SSH_TARGET: 'root@192.0.2.20',
      WAR_CONTAINER_SSH_IDENTITY_FILE: identity,
      WAR_CONTAINER_CONTROLLER_CA_PATH: ca,
      WAR_CONTAINER_SECCOMP_PROFILE_PATH: '/etc/war/security/chromium-userns-seccomp.json',
      WAR_CONTAINER_IPV6_INTERFACE: 'eth0',
    },
  });
  const dto = toPublicRuntimeConfig(config);
  assert.equal(dto.containers.enabled, true);
  assert.equal(dto.containers.hostId, 'configured-docker-host');
  assert.equal(dto.containers.hostLabel, 'Linux Docker phòng làm việc');
  assert.equal(dto.containers.sshIdentityConfigured, true);
  assert.equal(dto.containers.controllerCa, 'ca.pem');
  assert.equal(dto.containers.seccompProfile, 'chromium-userns-seccomp.json');
  assert.equal(dto.containers.ipv6AutoPrefix, true);
  assert.equal(dto.containers.ipv6InterfaceConfigured, true);
  assert.equal(JSON.stringify(dto).includes('root@192.0.2.20'), false);
  assert.equal(JSON.stringify(dto).includes('id_ed25519'), false);
  assert.equal(JSON.stringify(dto).includes(dir), false);
});

test('runtime config rejects unsafe managed host labels', () => {
  const invalid = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTAINER_HOST_LABEL: 'host\nforged' } });
  assert.equal(invalid.degraded, true);
  assert.match(invalid.errors.join(' '), /host label is invalid/);
});

test('runtime config validates an optional static managed IPv6 /64 prefix', () => {
  const valid = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTAINER_IPV6_PREFIX: '2001:0db8:1234:5678::/64' } });
  assert.equal(valid.containers.ipv6Prefix, '2001:db8:1234:5678::/64');
  const invalid = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTAINER_IPV6_PREFIX: '2001:db8::/48' } });
  assert.equal(invalid.degraded, true);
  assert.match(invalid.errors.join(' '), /\/64/);
});

test('runtime config selects macvlan for on-link IPv6 and rejects invalid drivers', () => {
  const macvlan = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTAINER_IPV6_INTERFACE: 'enp2s0' } });
  assert.equal(macvlan.containers.ipv6Driver, 'macvlan');
  const invalidDriver = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTAINER_IPV6_DRIVER: 'overlay' } });
  assert.equal(invalidDriver.degraded, true);
  assert.match(invalidDriver.errors.join(' '), /driver must be bridge or macvlan/);
  const autoInterface = resolveElectronRuntimeConfig({ app: fakeApp('/data'), env: { WAR_CONTAINER_IPV6_DRIVER: 'macvlan' } });
  assert.equal(autoInterface.degraded, false);
});

function fakeApp(userData) {
  return { getPath: () => userData };
}
