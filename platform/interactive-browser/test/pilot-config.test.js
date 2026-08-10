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
  assert.equal(config.sunshineAddressFamily, 'both');
  assert.equal(config.hostBindAddress, '192.168.1.201');
  assert.equal(config.containerIpv6Only, true);
  assert.deepEqual([config.width, config.height, config.fps], [1280, 720, 30]);
});

test('rejects malformed display and Sunshine families incompatible with an IPv6-only container', () => {
  assert.throws(() => normalizeConfig({ display: 'wayland-0' }), /display/);
  assert.throws(() => normalizeConfig({ sunshineAddressFamily: 'ipv4', containerIpv6Only: true }), /must be "both"/);
  assert.throws(() => normalizeConfig({ sunshineAddressFamily: 'ipv6' }), /Sunshine 0\.23/);
  assert.throws(() => normalizeConfig({ hostBindAddress: '0.0.0.0' }), /private LAN/);
  assert.equal(normalizeConfig({ sunshineAddressFamily: 'both', containerIpv6Only: true }).sunshineAddressFamily, 'both');
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
  assert.match(text, /address_family = both/);
  assert.match(text, /hevc_mode = 0/);
  assert.match(text, /resolutions = \[1280x720\]/);
  assert.match(text, /fps = \[30\]/);
  assert.doesNotMatch(text, /^address\s*=/m);
  assert.doesNotMatch(text, /^resolution\s*=/m);
});
