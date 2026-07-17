import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, serializeConfig } from '../src/config.js';

test('default bind is loopback', () => {
  const config = loadConfig({}, process.cwd());
  assert.equal(config.host, '127.0.0.1');
});

test('non-loopback is rejected without opt-in', () => {
  assert.throws(() => loadConfig({ WAR_AGENT_HOST: '0.0.0.0' }, process.cwd()), /ALLOW_REMOTE/);
});

test('short token is rejected for remote bind', () => {
  assert.throws(() => loadConfig({
    WAR_AGENT_HOST: '0.0.0.0',
    WAR_AGENT_ALLOW_REMOTE: '1',
    WAR_AGENT_TOKEN: 'short',
    WAR_AGENT_ALLOW: '10.0.0.5'
  }, process.cwd()), /at least 24/);
});

test('remote bind is valid with all required guards', () => {
  const config = loadConfig({
    WAR_AGENT_HOST: '0.0.0.0',
    WAR_AGENT_ALLOW_REMOTE: '1',
    WAR_AGENT_TOKEN: '123456789012345678901234',
    WAR_AGENT_ALLOW: '10.0.0.5'
  }, process.cwd());
  assert.equal(config.host, '0.0.0.0');
});

test('bad port range is rejected', () => {
  assert.throws(() => loadConfig({ WAR_AGENT_PORT: '70000' }, process.cwd()), /WAR_AGENT_PORT/);
});

test('serialized config does not expose secret', () => {
  const config = loadConfig({ WAR_AGENT_TOKEN: '123456789012345678901234' }, process.cwd());
  assert.doesNotMatch(JSON.stringify(serializeConfig(config)), /123456789012345678901234/);
});

test('serialized controller session config redacts credential and URL query credentials', () => {
  const credential = 'synthetic-controller-credential-12345';
  const config = loadConfig({
    WAR_CONTROLLER_WSS_URL: `wss://controller.example/agent?credential=${credential}&device=agent-a`,
    WAR_CONTROLLER_SESSION_CREDENTIAL: credential
  }, process.cwd());
  const encoded = JSON.stringify(serializeConfig(config));
  assert.equal(encoded.includes(credential), false);
  assert.match(encoded, /device=agent-a/);
});

test('managed device id is accepted and serialized without controller credential leakage', () => {
  const credential = 'synthetic-controller-credential-12345';
  const config = loadConfig({
    WAR_MANAGED_DEVICE_ID: 'managed-device-1',
    WAR_CONTROLLER_WSS_URL: 'wss://controller.example/v1/agent-session',
    WAR_CONTROLLER_SESSION_CREDENTIAL: credential
  }, process.cwd());
  const encoded = JSON.stringify(serializeConfig(config));
  assert.equal(config.managedDeviceId, 'managed-device-1');
  assert.equal(encoded.includes(credential), false);
});
