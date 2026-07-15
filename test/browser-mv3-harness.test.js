import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLaunchArgs,
  near,
  parseBrowserArgs,
  selectBrowser
} from './browser-mv3-harness.js';

test('browser harness parses browser argument and env override', () => {
  assert.deepEqual(parseBrowserArgs(['--browser=edge'], {}), { requested: 'edge', overridePath: '' });
  assert.deepEqual(parseBrowserArgs([], { WAR_BROWSER: 'chrome', WAR_BROWSER_PATH: 'C:\\Browser\\chrome.exe' }), {
    requested: 'chrome',
    overridePath: 'C:\\Browser\\chrome.exe'
  });
});

test('browser harness selectBrowser honors explicit executable override', () => {
  const selected = selectBrowser({ requested: 'edge', overridePath: 'C:\\Edge\\msedge.exe' }, (candidate) => candidate === 'C:\\Edge\\msedge.exe');
  assert.equal(selected.name, 'edge');
  assert.equal(selected.path, 'C:\\Edge\\msedge.exe');
});

test('browser harness selectBrowser filters installed candidates by requested browser', () => {
  const selected = selectBrowser({ requested: 'edge', overridePath: '' }, (candidate) => candidate.includes('Microsoft\\Edge'));
  assert.equal(selected.name, 'Edge');
  assert.equal(selected.key, 'edge');
});

test('browser harness launch args include extension loading flags', () => {
  const args = buildLaunchArgs({
    userDataDir: 'C:\\Temp\\profile',
    port: 9222,
    extensionPath: 'C:\\Temp\\extension',
    startUrl: 'about:blank'
  });
  assert.ok(args.includes('--user-data-dir=C:\\Temp\\profile'));
  assert.ok(args.includes('--remote-debugging-port=9222'));
  assert.ok(args.includes('--disable-extensions-except=C:\\Temp\\extension'));
  assert.ok(args.includes('--load-extension=C:\\Temp\\extension'));
  assert.ok(args.includes('--no-first-run'));
  assert.equal(args.at(-1), 'about:blank');
});

test('browser harness near applies positional tolerance', () => {
  assert.equal(near({ x: 100.5, y: 199.5 }, { x: 100, y: 200 }, 1), true);
  assert.equal(near({ x: 103, y: 200 }, { x: 100, y: 200 }, 1), false);
  assert.equal(near(null, { x: 100, y: 200 }, 1), false);
});
