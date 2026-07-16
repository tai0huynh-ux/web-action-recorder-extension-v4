import test from 'node:test';
import assert from 'node:assert/strict';
import { createElectronControllerRuntime } from '../src/electronRuntime.js';

test('electron runtime starts in order and shuts down idempotently', async () => {
  const calls = [];
  const deps = fakeRuntimeDeps(calls);
  const runtime = createElectronControllerRuntime(deps);
  await runtime.start();
  assert.deepEqual(calls.slice(0, 6), ['enableSandbox', 'registerSchemesAsPrivileged', 'requestSingleInstanceLock', 'whenReady', 'protocol.handle', 'store.new']);
  assert.equal(deps.ipcMain.handlers.size > 0, true);
  assert.equal(deps.BrowserWindow.instances.length, 1);
  assert.equal(deps.BrowserWindow.instances[0].loadedUrl, 'war-controller://app/');
  await runtime.shutdown();
  await runtime.shutdown();
  assert.equal(deps.ipcMain.handlers.size, 0);
  assert.equal(calls.includes('window.close'), true);
});

test('electron runtime quits on single-instance failure without creating core or window', async () => {
  const calls = [];
  const deps = fakeRuntimeDeps(calls, { singleInstance: false });
  const runtime = createElectronControllerRuntime(deps);
  await runtime.start();
  assert.equal(calls.includes('app.quit'), true);
  assert.equal(deps.BrowserWindow.instances.length, 0);
});

test('electron runtime does not auto-start on import or factory creation', () => {
  const calls = [];
  createElectronControllerRuntime(fakeRuntimeDeps(calls));
  assert.deepEqual(calls, []);
});

test('electron runtime surfaces degraded WSS config without starting WSS runtime', async () => {
  const calls = [];
  const deps = fakeRuntimeDeps(calls, { env: { WAR_CONTROLLER_WSS_ENABLED: '1' } });
  const runtime = createElectronControllerRuntime(deps);
  await runtime.start();
  assert.equal(runtime.config.degraded, true);
  assert.equal(calls.includes('wss.new'), false);
  await runtime.shutdown();
});

function fakeRuntimeDeps(calls, options = {}) {
  class FakeStore {
    constructor(file) {
      this.file = file;
      calls.push('store.new');
    }
  }
  class FakeCore {
    constructor({ store }) {
      this.store = store;
      this.sessions = { shutdown: () => calls.push('sessions.shutdown') };
      calls.push('core.new');
    }
    async load() {
      calls.push('core.load');
    }
  }
  class FakeApplication {
    constructor() {
      calls.push('application.new');
    }
    on() {}
    off() {}
  }
  class FakeWindow {
    static instances = [];
    constructor() {
      this.webContents = {
        setWindowOpenHandler: () => calls.push('windowOpenHandler'),
        on: () => {},
      };
      FakeWindow.instances.push(this);
      calls.push('window.new');
    }
    async loadURL(url) {
      this.loadedUrl = url;
      calls.push('window.loadURL');
    }
    once() {}
    isDestroyed() { return false; }
    close() { calls.push('window.close'); }
  }
  FakeWindow.instances = [];

  const ipcMain = {
    handlers: new Map(),
    handle(channel, handler) { this.handlers.set(channel, handler); },
    removeHandler(channel) { this.handlers.delete(channel); },
  };

  return {
    app: {
      enableSandbox: () => calls.push('enableSandbox'),
      requestSingleInstanceLock: () => {
        calls.push('requestSingleInstanceLock');
        return options.singleInstance !== false;
      },
      whenReady: async () => calls.push('whenReady'),
      getPath: () => 'C:/userData',
      on: () => {},
      quit: () => calls.push('app.quit'),
    },
    BrowserWindow: FakeWindow,
    dialog: {},
    ipcMain,
    protocol: {
      registerSchemesAsPrivileged: () => calls.push('registerSchemesAsPrivileged'),
      handle: () => calls.push('protocol.handle'),
    },
    session: {
      defaultSession: { setPermissionRequestHandler: () => calls.push('permissionHandler') },
    },
    fs: {
      constants: { R_OK: 4 },
      accessSync: () => { throw new Error('missing'); },
      promises: { readFile: async () => '' },
    },
    JsonStore: FakeStore,
    ControllerCore: FakeCore,
    ControllerApplicationService: FakeApplication,
    ControllerWssServerAdapter: class { constructor() { calls.push('adapter.new'); } },
    ControllerWssRuntimeServer: class { constructor() { calls.push('wss.new'); } shutdown() { calls.push('wss.shutdown'); } },
    env: options.env || {},
  };
}
