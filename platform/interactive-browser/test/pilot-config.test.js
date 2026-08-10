import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChromeCommand,
  buildSunshineCommand,
  buildSunshineConfig,
  normalizeConfig,
} from '../pilot-config.mjs';

test('normalizes safe 720p30 LAN defaults', () => {
  const config = normalizeConfig({});
  assert.equal(config.display, ':99');
  assert.equal(config.sunshineAddressFamily, 'ipv4');
  assert.equal(config.hostBindAddress, '192.168.1.201');
  assert.equal(config.privateIpv4Ingress, true);
  assert.equal(config.browserIpv6OnlyEgress, true);
  assert.deepEqual([config.width, config.height, config.fps], [1280, 720, 30]);
});

test('rejects malformed display and Sunshine families incompatible with the private ingress bridge', () => {
  assert.throws(() => normalizeConfig({ display: 'wayland-0' }), /display/);
  assert.throws(() => normalizeConfig({ sunshineAddressFamily: 'both', privateIpv4Ingress: true }), /must be "ipv4"/);
  assert.throws(() => normalizeConfig({ sunshineAddressFamily: 'ipv6' }), /Sunshine 0\.23/);
  assert.throws(() => normalizeConfig({ hostBindAddress: '0.0.0.0' }), /private LAN/);
  assert.equal(normalizeConfig({ sunshineAddressFamily: 'ipv4', privateIpv4Ingress: true }).sunshineAddressFamily, 'ipv4');
});

test('constructs direct Chrome command without automation flags', () => {
  const command = buildChromeCommand({ profileDir: '/tmp/pilot' });
  assert.equal(command[0], '/usr/bin/google-chrome');
  assert.ok(command.includes('--user-data-dir=/tmp/pilot'));
  assert.ok(!command.some((arg) => /playwright|webdriver|remote-debugging|headless|cdp/i.test(arg)));
});

test('constructs Sunshine config command and H.264-friendly config', () => {
  const config = { sunshineConfig: '/tmp/sunshine.conf' };
  assert.deepEqual(buildSunshineCommand(config), ['/usr/bin/sunshine', '/tmp/sunshine.conf']);
  const text = buildSunshineConfig(config);
  assert.match(text, /address_family = ipv4/);
  assert.match(text, /hevc_mode = 0/);
  assert.match(text, /resolutions = \[1280x720\]/);
  assert.match(text, /fps = \[30\]/);
  assert.doesNotMatch(text, /^address\s*=/m);
  assert.doesNotMatch(text, /^resolution\s*=/m);
});
