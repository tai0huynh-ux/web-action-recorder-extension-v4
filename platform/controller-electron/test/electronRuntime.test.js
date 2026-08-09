import test from 'node:test';
import assert from 'node:assert/strict';
import { createElectronControllerRuntime } from '../src/electronRuntime.js';

test('electron runtime starts in order and shuts down idempotently', async () => {
  const calls = [];
  const deps = fakeRuntimeDeps(calls);
  const runtime = createElectronControllerRuntime(deps);
  await runtime.start();
  assert.deepEqual(calls.slice(0, 7), ['app.setName:WAR Controller', 'enableSandbox', 'registerSchemesAsPrivileged', 'requestSingleInstanceLock', 'whenReady', 'protocol.handle', 'store.new']);
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

test('electron runtime selects the WAR Controller profile before resolving default user data', async () => {
  const calls = [];
  const deps = fakeRuntimeDeps(calls, { profileByName: true });
  const runtime = createElectronControllerRuntime(deps);

  await runtime.start();

  assert.equal(deps.storeFiles[0].replaceAll('\\', '/'), 'C:/AppData/WAR Controller/controller-state.json');
  assert.ok(calls.indexOf('app.setName:WAR Controller') < calls.indexOf('requestSingleInstanceLock'));
  await runtime.shutdown();
});

test('packaged smoke can isolate its Electron user-data lock', async () => {
  const calls = [];
  const deps = fakeRuntimeDeps(calls, {
    env: {
      WAR_CONTROLLER_PACKAGED_SMOKE_OUTPUT: 'C:/smoke/packaged-smoke.json',
      WAR_CONTROLLER_PACKAGED_SMOKE_USER_DATA_PATH: 'C:/smoke/electron-user-data',
    },
  });
  const runtime = createElectronControllerRuntime(deps);
  await runtime.start();
  assert.ok(calls.includes('app.setPath:userData:C:/smoke/electron-user-data'));
  assert.ok(calls.indexOf('app.setPath:userData:C:/smoke/electron-user-data') < calls.indexOf('requestSingleInstanceLock'));
  await runtime.shutdown();
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

test('electron runtime supplies WSS port selected for a port-zero bind to managed host adapters', async () => {
  const calls = [];
  const adapterConfigs = [];
  const hostManagerConfigs = [];
  const server = {
    once() {},
    listen(_port, _host, callback) { callback(); },
    address: () => ({ port: 47651 }),
    close() {},
  };
  class FakeHostManager {
    constructor({ config, createAdapter }) {
      hostManagerConfigs.push(config);
      this.createAdapter = createAdapter;
    }
    async load() {}
  }
  const deps = fakeRuntimeDeps(calls, {
    env: {
      WAR_CONTROLLER_WSS_ENABLED: '1',
      WAR_CONTROLLER_TLS_CERT_PATH: 'C:/tls/controller.crt',
      WAR_CONTROLLER_TLS_KEY_PATH: 'C:/tls/controller.key',
    },
    fs: {
      constants: { R_OK: 4 },
      accessSync() {},
      promises: { readFile: async () => Buffer.from('tls') },
    },
    https: { createServer: () => server },
    SshContainerHostManager: FakeHostManager,
    createDockerContainerAdapter: ({ config }) => { adapterConfigs.push(config); return null; },
  });
  const runtime = createElectronControllerRuntime(deps);

  await runtime.start();

  assert.equal(runtime.config.wss.port, 47651);
  assert.equal(hostManagerConfigs[0].wss.port, 47651);
  assert.ok(adapterConfigs.every((config) => config.wss.port === 47651));
  await runtime.shutdown();
});

test('electron runtime persists a validated WSS profile and reuses it on a same-profile reopen without launcher environment', async () => {
  const profileStore = fakeRuntimeProfileStore();
  const firstCalls = [];
  const first = createElectronControllerRuntime(fakeRuntimeDeps(firstCalls, {
    env: validLanWssEnv(),
    fs: readableTlsFs(),
    https: fakeHttpsServer(47651),
    runtimeProfileStore: profileStore,
  }));

  await first.start();
  assert.deepEqual(profileStore.saves, [{
    schemaVersion: 1,
    wss: {
      enabled: true,
      host: '192.168.1.20',
      port: 47651,
      lanBindingApproved: true,
      certificatePath: 'C:/tls/controller.crt',
      privateKeyPath: 'C:/tls/controller.key',
    },
  }]);
  await first.shutdown();

  const secondCalls = [];
  const second = createElectronControllerRuntime(fakeRuntimeDeps(secondCalls, {
    env: {},
    fs: readableTlsFs(),
    https: fakeHttpsServer(47651),
    runtimeProfileStore: profileStore,
  }));
  await second.start();

  assert.equal(second.config.wss.enabled, true);
  assert.equal(second.config.wss.host, '192.168.1.20');
  assert.equal(second.config.wss.port, 47651);
  assert.ok(secondCalls.includes('wss.new'));
  await second.shutdown();
});

test('electron runtime saves an environment image pin and restores it without a second launcher environment', async () => {
  const imagePin = `sha256:${'a'.repeat(64)}`;
  const profileStore = fakeRuntimeProfileStore();
  const first = createElectronControllerRuntime(fakeRuntimeDeps([], {
    env: {
      ...validLanWssEnv(),
      WAR_CONTAINER_RUNTIME: 'local-docker',
      WAR_CONTAINER_SECCOMP_PROFILE_PATH: 'C:/war/security/chromium-userns-seccomp.json',
      WAR_CONTAINER_IMAGE: imagePin,
    },
    fs: readableTlsFs(),
    https: fakeHttpsServer(47651),
    runtimeProfileStore: profileStore,
  }));

  await first.start();
  await first.shutdown();
  assert.equal(profileStore.saves[0]?.imagePin, imagePin);

  const second = createElectronControllerRuntime(fakeRuntimeDeps([], {
    env: {}, fs: readableTlsFs(), https: fakeHttpsServer(47651), runtimeProfileStore: profileStore,
  }));
  await second.start();
  assert.equal(second.config.containers.imagePin, imagePin);
  await second.shutdown();
});

function fakeRuntimeDeps(calls, options = {}) {
  const storeFiles = [];
  class FakeStore {
    constructor(file) {
      this.file = file;
      storeFiles.push(file);
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

  let appName = 'Electron';
  return {
    storeFiles,
    app: {
      setName: (name) => { appName = name; calls.push(`app.setName:${name}`); },
      enableSandbox: () => calls.push('enableSandbox'),
      setPath: (name, value) => calls.push(`app.setPath:${name}:${value}`),
      requestSingleInstanceLock: () => {
        calls.push('requestSingleInstanceLock');
        return options.singleInstance !== false;
      },
      whenReady: async () => calls.push('whenReady'),
      getPath: () => options.profileByName ? `C:/AppData/${appName}` : 'C:/userData',
      on: () => {},
      quit: () => calls.push('app.quit'),
    },
    BrowserWindow: FakeWindow,
    clipboard: { readText: () => '', writeText: () => {} },
    dialog: {},
    ipcMain,
    protocol: {
      registerSchemesAsPrivileged: () => calls.push('registerSchemesAsPrivileged'),
      handle: () => calls.push('protocol.handle'),
    },
    session: {
      defaultSession: { setPermissionRequestHandler: () => calls.push('permissionHandler') },
    },
    fs: options.fs || {
      constants: { R_OK: 4 },
      accessSync: () => { throw new Error('missing'); },
      promises: { readFile: async () => '' },
    },
    JsonStore: FakeStore,
    ControllerCore: FakeCore,
    ControllerApplicationService: FakeApplication,
    ControllerWssServerAdapter: class { constructor() { calls.push('adapter.new'); } },
    ControllerWssRuntimeServer: class { constructor() { calls.push('wss.new'); } shutdown() { calls.push('wss.shutdown'); } },
    https: options.https,
    SshContainerHostManager: options.SshContainerHostManager,
    createDockerContainerAdapter: options.createDockerContainerAdapter,
    runtimeProfileStore: options.runtimeProfileStore,
    env: options.env || {},
  };
}

function readableTlsFs() {
  return {
    constants: { R_OK: 4 },
    accessSync() {},
    promises: { readFile: async () => Buffer.from('tls') },
  };
}

function fakeHttpsServer(port) {
  return {
    createServer: () => ({
      once() {},
      listen(_port, _host, callback) { callback(); },
      address: () => ({ port }),
      close() {},
    }),
  };
}

function validLanWssEnv() {
  return {
    WAR_CONTROLLER_WSS_ENABLED: '1',
    WAR_CONTROLLER_WSS_HOST: '192.168.1.20',
    WAR_CONTROLLER_WSS_PORT: '47651',
    WAR_CONTROLLER_ALLOW_LAN: '1',
    WAR_CONTROLLER_TLS_CERT_PATH: 'C:/tls/controller.crt',
    WAR_CONTROLLER_TLS_KEY_PATH: 'C:/tls/controller.key',
  };
}

function fakeRuntimeProfileStore() {
  let profile = null;
  const saves = [];
  return {
    saves,
    async load() { return profile ? { status: 'loaded', profile: structuredClone(profile) } : { status: 'missing', profile: null }; },
    async save(next) { profile = structuredClone(next); saves.push(structuredClone(next)); },
  };
}
