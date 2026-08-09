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
  assert.equal(config.sunshineAddress, '0.0.0.0');
  assert.deepEqual([config.width, config.height, config.fps], [1280, 720, 30]);
});

test('rejects malformed display and non-IPv4 Sunshine address', () => {
  assert.throws(() => normalizeConfig({ display: 'wayland-0' }), /display/);
  assert.throws(() => normalizeConfig({ sunshineAddress: '::' }), /IPv4/);
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
  assert.match(text, /address = 0\.0\.0\.0/);
  assert.match(text, /hevc_mode = 0/);
  assert.match(text, /resolution = \[1280x720\]/);
  assert.match(text, /fps = \[30\]/);
});
