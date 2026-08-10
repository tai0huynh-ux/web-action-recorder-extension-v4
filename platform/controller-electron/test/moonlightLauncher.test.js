import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildMoonlightArguments,
  launchMoonlight,
  normalizeMoonlightDescriptor,
  resolveMoonlightExecutable,
} from '../src/moonlightLauncher.js';

test('accepts only a private LAN Moonlight endpoint', () => {
  assert.deepEqual(normalizeMoonlightDescriptor({ host: '192.168.1.201' }), {
    host: '192.168.1.201', port: 47989, app: 'Desktop', protocol: 'moonlight',
  });
  assert.throws(() => normalizeMoonlightDescriptor({ host: '8.8.8.8' }), /private LAN/);
  assert.throws(() => normalizeMoonlightDescriptor({ host: '2001:db8::1' }), /private LAN/);
  assert.throws(() => normalizeMoonlightDescriptor({ host: '192.168.1.201', port: 48010 }), /47989/);
});

test('builds native pair and realtime stream arguments', () => {
  assert.deepEqual(buildMoonlightArguments('pair', { host: '192.168.1.201' }), ['pair', '192.168.1.201']);
  const args = buildMoonlightArguments('stream', { host: '192.168.1.201', app: 'Desktop' });
  assert.deepEqual(args.slice(0, 3), ['stream', '192.168.1.201', 'Desktop']);
  assert.ok(args.includes('--absolute-mouse'));
  assert.ok(args.includes('--capture-system-keys'));
  assert.ok(args.includes('always'));
  assert.ok(args.includes('H.264'));
});

test('launches the installed Moonlight executable without a command shell', () => {
  const executable = 'C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe';
  const calls = [];
  const child = { pid: 321, unref() { calls.push('unref'); } };
  const result = launchMoonlight({
    action: 'stream',
    descriptor: { host: '192.168.1.201', app: 'Desktop' },
    env: { WAR_MOONLIGHT_EXE: executable },
    fs: { existsSync: (candidate) => candidate === executable, constants: { F_OK: 0 }, accessSync() {} },
    path: path.win32,
    spawn: (...args) => { calls.push(args); return child; },
  });
  assert.equal(result.status, 'opened');
  assert.equal(result.pid, 321);
  assert.equal(calls[0][0], executable);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[1], 'unref');
});

test('fails closed when Moonlight is absent', () => {
  assert.throws(() => resolveMoonlightExecutable({
    env: {}, fs: { existsSync: () => false, constants: { F_OK: 0 }, accessSync() { throw new Error('missing'); } }, path: path.win32,
  }), /not installed/);
});
