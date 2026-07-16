import path from 'node:path';
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { JsonStore } from '../../../companion/store.js';
import { ControllerCore } from '../../controller-core/src/controllerCore.js';
import { resolveRuntimeConfig } from './runtimeConfig.js';
import { resolveRendererAsset, CSP } from './appProtocol.js';
import { CHANNELS } from './ipcContract.js';
import { secureWindowOptions } from './secureWindow.js';

app.enableSandbox();
let core;
let config;
function bootstrap() { const state = core.store.snapshot(); return { applicationVersion: app.getVersion(), protocolVersion: 'v1', storeStatus: 'loaded', wss: { enabled: config.wss.enabled, host: config.wss.host, port: config.wss.port }, deviceCount: state.devices.length, workflowCount: state.workflowRevisions.length, groupCount: state.groups.length, sessionCount: core.sessions.sessions.size }; }
async function createWindow() {
  const win = new BrowserWindow(secureWindowOptions(path.join(import.meta.dirname, 'preload.cjs')));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('war-controller://app/')) event.preventDefault(); });
  await win.loadURL('war-controller://app/'); win.show();
}
protocol.handle('war-controller', async (request) => { const asset = resolveRendererAsset(path.join(import.meta.dirname, '..', 'renderer'), request.url); return new Response(await (await import('node:fs/promises')).readFile(asset.path), { headers: { 'content-type': asset.mimeType, 'content-security-policy': CSP, 'cache-control': 'no-store' } }); });
app.whenReady().then(async () => { config = resolveRuntimeConfig(process.env, app.getPath('userData')); core = new ControllerCore({ store: new JsonStore(config.storePath) }); await core.load(); session.defaultSession.setPermissionRequestHandler((_w, _p, callback) => callback(false)); ipcMain.handle(CHANNELS.bootstrap, (event) => { if (!event.senderFrame?.url.startsWith('war-controller://app/')) throw new Error('AUTH_DENIED'); return bootstrap(); }); ipcMain.handle(CHANNELS.runtime, (event) => { if (!event.senderFrame?.url.startsWith('war-controller://app/')) throw new Error('AUTH_DENIED'); return bootstrap().wss; }); await createWindow(); });
app.on('window-all-closed', () => app.quit());
