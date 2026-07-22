import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { JsonStore } from '../../../companion/store.js';
import { ControllerCore } from '../../controller-core/src/controllerCore.js';
import { ControllerWssServerAdapter } from '../../controller-wss/src/serverAdapter.js';
import { ControllerWssRuntimeServer } from '../../controller-wss/src/wssServer.js';
import { ControllerApplicationService } from './controllerApplication.js';
import { resolveRendererAsset, CSP } from './appProtocol.js';
import { registerControllerIpcHandlers } from './ipcHandlers.js';
import { resolveElectronRuntimeConfig } from './runtimeConfig.js';
import { createControllerSettingsStore } from './settingsStore.js';
import { secureWindowOptions } from './secureWindow.js';
import { createDockerContainerAdapter } from './containerAdapter.js';
import { SshContainerHostManager } from './sshHostManager.js';

export function createElectronControllerRuntime(dependencies = {}) {
  const state = {
    app: dependencies.app,
    BrowserWindow: dependencies.BrowserWindow,
    ipcMain: dependencies.ipcMain,
    protocol: dependencies.protocol,
    session: dependencies.session,
    dialog: dependencies.dialog,
    fs: dependencies.fs || fs,
    path: dependencies.path || path,
    https: dependencies.https || https,
    JsonStore: dependencies.JsonStore || JsonStore,
    ControllerCore: dependencies.ControllerCore || ControllerCore,
    ControllerApplicationService: dependencies.ControllerApplicationService || ControllerApplicationService,
    createControllerSettingsStore: dependencies.createControllerSettingsStore || createControllerSettingsStore,
    ControllerWssServerAdapter: dependencies.ControllerWssServerAdapter || ControllerWssServerAdapter,
    ControllerWssRuntimeServer: dependencies.ControllerWssRuntimeServer || ControllerWssRuntimeServer,
    createDockerContainerAdapter: dependencies.createDockerContainerAdapter || createDockerContainerAdapter,
    SshContainerHostManager: dependencies.SshContainerHostManager || SshContainerHostManager,
    rendererRoot: dependencies.rendererRoot || path.join(import.meta.dirname, '..', 'renderer'),
    preloadPath: dependencies.preloadPath || path.join(import.meta.dirname, 'preload.cjs'),
    version: dependencies.version || dependencies.app?.getVersion?.() || '0.1.0',
    env: dependencies.env || process.env,
    config: null,
    store: null,
    settingsStore: null,
    containerHostManager: null,
    core: null,
    application: null,
    mainWindow: null,
    ipcRegistration: null,
    wssRuntime: null,
    httpsServer: null,
    started: false,
    shuttingDown: false,
  };

  return {
    get config() { return state.config; },
    get core() { return state.core; },
    get application() { return state.application; },
    get mainWindow() { return state.mainWindow; },
    async start() {
      if (state.started) return this;
      state.shuttingDown = false;
      requireDependencies(state);
      if (!state.app.isReady?.()) {
        state.app.enableSandbox();
        state.protocol.registerSchemesAsPrivileged?.([{ scheme: 'war-controller', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
      } else if (!state.app.isReady) {
        state.app.enableSandbox();
        state.protocol.registerSchemesAsPrivileged?.([{ scheme: 'war-controller', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
      }
      const smokeUserDataPath = state.env?.WAR_CONTROLLER_PACKAGED_SMOKE_USER_DATA_PATH;
      if (state.env?.WAR_CONTROLLER_PACKAGED_SMOKE_OUTPUT && smokeUserDataPath && typeof state.app.setPath === 'function') {
        state.app.setPath('userData', smokeUserDataPath);
      }
      if (state.app.requestSingleInstanceLock && !state.app.requestSingleInstanceLock()) {
        state.app.quit?.();
        return this;
      }
      state.app.on?.('second-instance', () => {
        if (state.mainWindow && !state.mainWindow.isDestroyed?.()) {
          state.mainWindow.show?.();
          state.mainWindow.focus?.();
        }
      });
      await state.app.whenReady();
      state.config = resolveElectronRuntimeConfig({ app: state.app, env: state.env, fs: state.fs, path: state.path });
      registerProtocolHandler(state);
      state.store = new state.JsonStore(state.config.storePath);
      state.settingsStore = state.createControllerSettingsStore({ fs: state.fs, path: state.path, filePath: state.config.settingsPath });
      state.core = new state.ControllerCore({ store: state.store });
      await state.core.load();
      state.containerHostManager = new state.SshContainerHostManager({
        config: state.config,
        settingsStore: state.settingsStore,
        createAdapter: state.createDockerContainerAdapter,
        fsImpl: state.fs,
      });
      await state.containerHostManager.load();
      await maybeStartWss(state);
      state.application = new state.ControllerApplicationService({
        core: state.core,
        wssRuntime: state.wssRuntime,
        containerAdapter: state.createDockerContainerAdapter({ config: state.config }),
        containerHostManager: state.containerHostManager,
        config: state.config,
        version: state.version,
        settingsStore: state.settingsStore
      });
      state.wssRuntime?.adapter?.on?.('execution', (event) => {
        state.application?.invalidate?.('jobs', { jobId: event.jobId, deviceId: event.deviceId });
      });
      state.ipcRegistration = registerControllerIpcHandlers({
        ipcMain: state.ipcMain,
        mainWindow: () => state.mainWindow,
        application: state.application,
        dialog: state.dialog,
        fs: state.fs,
        path: state.path,
      });
      state.session.defaultSession?.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
      state.mainWindow = createMainWindow(state);
      await state.mainWindow.loadURL('war-controller://app/');
      state.mainWindow.once?.('ready-to-show', () => state.mainWindow?.show?.());
      state.app.on?.('window-all-closed', () => {
        if (!state.shuttingDown) state.app.quit?.();
      });
      state.started = true;
      return this;
    },
    async shutdown() {
      if (state.shuttingDown) return;
      state.shuttingDown = true;
      state.ipcRegistration?.dispose?.();
      state.wssRuntime?.shutdown?.();
      state.httpsServer?.close?.();
      state.core?.sessions?.shutdown?.();
      if (state.mainWindow && !state.mainWindow.isDestroyed?.()) await closeWindow(state.mainWindow);
      state.protocol.unhandle?.('war-controller');
      state.mainWindow = null;
      state.application = null;
      state.core = null;
      state.store = null;
      state.settingsStore = null;
      state.containerHostManager = null;
      state.started = false;
    },
  };
}

async function closeWindow(window) {
  if (typeof window.close !== 'function') return;
  let closed = false;
  const waitForClosed = typeof window.once === 'function'
    ? new Promise((resolve) => {
      window.once('closed', () => {
        closed = true;
        resolve();
      });
      setTimeout(resolve, 250);
    })
    : Promise.resolve();
  window.close();
  await waitForClosed;
  if (!closed && typeof window.destroy === 'function' && !window.isDestroyed?.()) window.destroy();
}

function requireDependencies(state) {
  for (const key of ['app', 'BrowserWindow', 'ipcMain', 'protocol', 'session', 'dialog']) {
    if (!state[key]) throw new Error(`Electron runtime missing dependency: ${key}`);
  }
}

function registerProtocolHandler(state) {
  state.protocol.handle('war-controller', async (request) => {
    const asset = resolveRendererAsset(state.rendererRoot, request.url);
    return new Response(await state.fs.promises.readFile(asset.path), {
      headers: {
        'content-type': asset.mimeType,
        'content-security-policy': CSP,
        'cache-control': 'no-store',
      },
    });
  });
}

function createMainWindow(state) {
  const iconPath = state.path.join(state.rendererRoot, 'assets', 'war-controller-icon.svg');
  const win = new state.BrowserWindow(secureWindowOptions(state.preloadPath, iconPath));
  win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  win.webContents.on?.('will-navigate', (event, target) => {
    try {
      const url = new URL(target);
      if (url.protocol !== 'war-controller:' || url.hostname !== 'app') event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  return win;
}

async function maybeStartWss(state) {
  if (!state.config.wss.enabled) return;
  const options = {
    cert: await state.fs.promises.readFile(state.config.wss.tls.certPath),
    key: await state.fs.promises.readFile(state.config.wss.tls.keyPath),
  };
  state.httpsServer = state.https.createServer(options, (_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    state.httpsServer.once('error', reject);
    state.httpsServer.listen(state.config.wss.port, state.config.wss.host, resolve);
  });
  const adapter = new state.ControllerWssServerAdapter({ sessionManager: state.core.sessions });
  state.wssRuntime = new state.ControllerWssRuntimeServer({ server: state.httpsServer, adapter });
}
