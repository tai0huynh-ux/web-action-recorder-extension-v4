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
      WAR_CONTAINER_SSH_TARGET: 'root@192.0.2.20',
      WAR_CONTAINER_SSH_IDENTITY_FILE: identity,
      WAR_CONTAINER_CONTROLLER_CA_PATH: ca,
      WAR_CONTAINER_SECCOMP_PROFILE_PATH: '/etc/war/security/chromium-userns-seccomp.json',
    },
  });
  const dto = toPublicRuntimeConfig(config);
  assert.equal(dto.containers.enabled, true);
  assert.equal(dto.containers.sshIdentityConfigured, true);
  assert.equal(dto.containers.controllerCa, 'ca.pem');
  assert.equal(dto.containers.seccompProfile, 'chromium-userns-seccomp.json');
  assert.equal(JSON.stringify(dto).includes('root@192.0.2.20'), false);
  assert.equal(JSON.stringify(dto).includes('id_ed25519'), false);
  assert.equal(JSON.stringify(dto).includes(dir), false);
});

function fakeApp(userData) {
  return { getPath: () => userData };
}
