import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BrowserController, browserEnvironment, recoverStaleChromiumProfileLocks } from '../src/browserController.js';

test('Chromium child environment excludes credential-like values', () => {
  assert.deepEqual(browserEnvironment({
    PATH: '/usr/bin',
    DISPLAY: ':99',
    WAR_CONTROLLER_SESSION_CREDENTIAL: 'credential-value',
    API_TOKEN: 'token-value',
    LICENSE_KEY: 'license-value',
    NODE_EXTRA_CA_CERTS: '/run/war/controller-ca.pem',
  }), {
    PATH: '/usr/bin',
    DISPLAY: ':99',
    NODE_EXTRA_CA_CERTS: '/run/war/controller-ca.pem',
  });
});

test('stale Chromium profile locks from a replaced container are removed before launch', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-profile-locks-'));
  fs.symlinkSync('old-container-36', path.join(profileDir, 'SingletonLock'));
  fs.symlinkSync('cookie-value', path.join(profileDir, 'SingletonCookie'));
  fs.symlinkSync('/tmp/old-chromium/SingletonSocket', path.join(profileDir, 'SingletonSocket'));

  const recovered = recoverStaleChromiumProfileLocks(profileDir, { hostname: 'new-container' });

  assert.deepEqual(recovered, ['SingletonCookie', 'SingletonLock', 'SingletonSocket']);
  for (const name of recovered) assert.equal(fs.existsSync(path.join(profileDir, name)), false);
});

test('stale Chromium profile lock from a dead process is removed', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-profile-locks-'));
  fs.symlinkSync('current-container-36', path.join(profileDir, 'SingletonLock'));

  const recovered = recoverStaleChromiumProfileLocks(profileDir, {
    hostname: 'current-container',
    processExists: () => false,
  });

  assert.deepEqual(recovered, ['SingletonLock']);
});

test('active Chromium profile owner is preserved and reported', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-profile-locks-'));
  fs.symlinkSync('current-container-36', path.join(profileDir, 'SingletonLock'));

  assert.throws(() => recoverStaleChromiumProfileLocks(profileDir, {
    hostname: 'current-container',
    processExists: () => true,
    readProcessCommand: () => `/usr/lib/chromium/chromium --user-data-dir=${profileDir}`,
  }), (error) => error.code === 'browser_profile_in_use');
  assert.equal(fs.lstatSync(path.join(profileDir, 'SingletonLock')).isSymbolicLink(), true);
});

test('two tabs with the same URL get different target IDs', async () => {
  const controller = fakeController();
  const first = fakePage('https://fixture.local/same');
  const second = fakePage('https://fixture.local/same');
  controller.context._pages.push(first, second);
  controller.registerPage(first);
  controller.registerPage(second);
  const tabs = await controller.listTabs();
  assert.equal(tabs.length, 2);
  assert.notEqual(tabs[0].targetId, tabs[1].targetId);
});

test('target ID is stable after navigate', async () => {
  const controller = fakeController();
  const page = fakePage('https://fixture.local/a');
  controller.context._pages.push(page);
  const targetId = controller.registerPage(page);
  page._url = 'https://fixture.local/b';
  const tabs = await controller.listTabs();
  assert.equal(tabs[0].targetId, targetId);
});

test('browser state reports the default pinned CloakBrowser engine metadata', async () => {
  const controller = fakeController();

  const state = await controller.getState();

  assert.deepEqual(state.engine, {
    name: 'cloakbrowser',
    version: '0.5.5',
    pinnedVersion: '146.0.7680.177.5',
  });
});

test('tab back, forward, reload, and home invoke the exact active Chromium page operation', async () => {
  const controller = fakeController();
  const calls = [];
  const page = fakePage('https://fixture.local/current', {
    goBack: async () => { calls.push(['back']); page._url = 'https://fixture.local/back'; },
    goForward: async () => { calls.push(['forward']); page._url = 'https://fixture.local/forward'; },
    reload: async () => { calls.push(['reload']); },
    goto: async (url) => { calls.push(['home', url]); page._url = url; },
  });
  controller.context._pages.push(page);
  const targetId = controller.registerPage(page);

  await controller.backTab(targetId);
  await controller.forwardTab(targetId);
  await controller.reloadTab(targetId);
  const home = await controller.homeTab(targetId);

  assert.deepEqual(calls, [
    ['back'],
    ['forward'],
    ['reload'],
    ['home', 'chrome://newtab/'],
  ]);
  assert.equal(home.url, 'chrome://newtab/');
});

test('activate updates exactly one active tab', async () => {
  const controller = fakeController();
  const first = fakePage('https://fixture.local/a');
  const second = fakePage('https://fixture.local/b');
  controller.context._pages.push(first, second);
  const firstId = controller.registerPage(first);
  const secondId = controller.registerPage(second);
  controller.activeTargetId = firstId;
  await controller.activateTab(secondId);
  const tabs = await controller.listTabs();
  assert.equal(tabs.filter((tab) => tab.active).length, 1);
  assert.equal(tabs.find((tab) => tab.active).targetId, secondId);
});

test('closing active tab chooses fallback', async () => {
  const controller = fakeController();
  const first = fakePage('https://fixture.local/a');
  const second = fakePage('https://fixture.local/b');
  controller.context._pages.push(first, second);
  const firstId = controller.registerPage(first);
  const secondId = controller.registerPage(second);
  controller.activeTargetId = secondId;
  await controller.closeTab(secondId);
  const tabs = await controller.listTabs();
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].targetId, firstId);
  assert.equal(tabs[0].active, true);
});

test('closing last tab keeps a real Chromium new-tab page', async () => {
  const controller = fakeController();
  const page = fakePage('https://fixture.local/a');
  controller.context._pages.push(page);
  const targetId = controller.registerPage(page);
  const result = await controller.closeTab(targetId);
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'last_tab_kept_blank');
  assert.equal(page.url(), 'chrome://newtab/');
  assert.equal(page._setContentCalls, 0);
});

test('a Chromium-created tab becomes the active remote-control target', async () => {
  const controller = fakeController();
  const first = fakePage('https://fixture.local/a');
  const second = fakePage('chrome://new-tab-page/');
  controller.context._pages.push(first, second);
  const firstId = controller.registerPage(first);
  controller.activeTargetId = firstId;

  const secondId = controller.registerPage(second, { activate: true });
  const tabs = await controller.listTabs();

  assert.equal(tabs.find((tab) => tab.active)?.targetId, secondId);
  assert.equal(tabs.filter((tab) => tab.active).length, 1);
});

test('blank Chromium page is promoted to a real new-tab page', async () => {
  const controller = fakeController();
  const page = fakePage('about:blank');

  const applied = await controller.ensureDefaultNewTab(page);

  assert.equal(applied, true);
  assert.equal(page.url(), 'chrome://newtab/');
  assert.equal(page._setContentCalls, 0);
});

test('existing website is never replaced by the default new-tab page', async () => {
  const controller = fakeController();
  const page = fakePage('https://fixture.local/restored');

  const applied = await controller.ensureDefaultNewTab(page);

  assert.equal(applied, false);
  assert.equal(page._setContentCalls, 0);
  assert.equal(page.url(), 'https://fixture.local/restored');
});

test('normal navigation still works after the default new-tab page', async () => {
  const controller = fakeController();
  const page = fakePage('about:blank');
  controller.context._pages.push(page);
  const targetId = controller.registerPage(page);
  await controller.ensureDefaultNewTab(page);

  const result = await controller.navigateTab(targetId, 'https://fixture.local/next');

  assert.equal(result.url, 'https://fixture.local/next');
  assert.equal(page.url(), 'https://fixture.local/next');
  assert.equal(page._setContentCalls, 0);
});

test('an unexpected BrowserContext close emits one context_closed signal and clears its stale handle', () => {
  const controller = fakeController();
  const context = new EventEmitter();
  const signals = [];
  controller.context = context;
  controller.on('context_closed', (signal) => signals.push(signal));

  context.emit('close');
  context.emit('close');

  assert.equal(controller.context, null);
  assert.equal(signals.length, 1);
});

test('extension detection works when service worker is asleep but extension page loads', async () => {
  const extensionDir = tempExtension();
  const controller = fakeController({ extensionDir });
  controller.extensionStatus.extensionId = 'abc123';
  controller.context._newPage = async () => fakePage('about:blank', {
    goto: async function goto(url) {
      this._url = url;
    }
  });
  const status = await controller.refreshExtensionStatus();
  assert.equal(status.loaded, true);
  assert.equal(status.extensionId, 'edoicfpldmlabgdalemfgflpldiijdmm');
});

test('remote frame capture returns a bounded JPEG for the active Chromium viewport', async () => {
  const controller = fakeController();
  const page = fakePage('https://fixture.local/remote', {
    screenshot: async () => Buffer.from('jpeg-frame'),
    viewportSize: () => ({ width: 1280, height: 720 }),
  });
  controller.context._pages.push(page);
  controller.activeTargetId = controller.registerPage(page);

  const frame = await controller.captureRemoteFrame({ quality: 45 });

  assert.equal(frame.mimeType, 'image/jpeg');
  assert.equal(frame.encoding, 'base64');
  assert.equal(frame.data, Buffer.from('jpeg-frame').toString('base64'));
  assert.equal(frame.width, 1280);
  assert.equal(frame.height, 720);
});

test('extension verification never mutates the native messaging manifest or extension settings', async () => {
  const extensionDir = tempExtension();
  const hostPath = path.join(os.tmpdir(), `war-native-host-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const previousHostPath = process.env.WAR_NATIVE_HOST_PATH;
  process.env.WAR_NATIVE_HOST_PATH = hostPath;
  let evaluated = false;
  try {
    const controller = fakeController({ extensionDir });
    controller.context._newPage = async () => fakePage('about:blank', {
      goto: async function goto(url) {
        this._url = url;
      },
      evaluate: async () => {
        evaluated = true;
      }
    });
    const status = await controller.refreshExtensionStatus();
    assert.equal(status.loaded, true);
    assert.equal(evaluated, false);
  } finally {
    if (previousHostPath === undefined) delete process.env.WAR_NATIVE_HOST_PATH;
    else process.env.WAR_NATIVE_HOST_PATH = previousHostPath;
  }
});

test('extension detection reports bad path', async () => {
  const controller = fakeController({ extensionDir: path.join(os.tmpdir(), 'missing-war-extension') });
  const status = await controller.refreshExtensionStatus();
  assert.equal(status.loaded, false);
  assert.match(status.lastError, /manifest/);
});

test('extension detection reports invalid manifest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-bad-extension-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{bad');
  const controller = fakeController({ extensionDir: dir });
  const status = await controller.refreshExtensionStatus();
  assert.equal(status.loaded, false);
  assert.match(status.lastError, /manifest/);
});

function fakeController(overrides = {}) {
  const controller = new BrowserController({
    extensionDir: overrides.extensionDir || tempExtension(),
    paths: { profileDir: '/tmp/profile', downloadsDir: '/tmp/downloads' },
    width: 800,
    height: 600,
    browserEngine: { name: 'cloakbrowser', version: '0.5.5', pinnedVersion: '146.0.7680.177.5', executable: '/opt/war/cloakbrowser/chromium-146.0.7680.177.5/chrome' },
    extensionId: overrides.extensionId || 'edoicfpldmlabgdalemfgflpldiijdmm',
    headless: false,
    locale: 'en-US',
    timezone: 'UTC',
    noSandbox: false
  });
  controller.context = {
    _pages: [],
    pages() {
      return this._pages.filter((page) => !page.isClosed());
    },
    serviceWorkers() {
      return [];
    },
    waitForEvent: async () => undefined,
    newPage() {
      return this._newPage ? this._newPage() : fakePage('about:blank');
    }
  };
  return controller;
}

function fakePage(url, methods = {}) {
  const page = new EventEmitter();
  page._url = url;
  page._closed = false;
  page._content = '';
  page._setContentCalls = 0;
  page.url = () => page._url;
  page.title = async () => 'Fixture';
  page.isClosed = () => page._closed;
  page.bringToFront = async () => {};
  page.goto = methods.goto || (async (nextUrl) => {
    page._url = nextUrl;
  });
  page.goBack = methods.goBack || (async () => undefined);
  page.goForward = methods.goForward || (async () => undefined);
  page.reload = methods.reload || (async () => undefined);
  page.setContent = methods.setContent || (async (content) => {
    page._content = content;
    page._setContentCalls += 1;
  });
  page.evaluate = methods.evaluate || (async () => {});
  page.screenshot = methods.screenshot || (async () => Buffer.from('jpeg'));
  page.viewportSize = methods.viewportSize || (() => ({ width: 800, height: 600 }));
  page.close = async () => {
    page._closed = true;
    page.emit('close');
  };
  return page;
}

function tempExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-extension-'));
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'WAR', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'ui', 'sidepanel.html'), '<!doctype html><title>WAR</title>');
  return dir;
}
