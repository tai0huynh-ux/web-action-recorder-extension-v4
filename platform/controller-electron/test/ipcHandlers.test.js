import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IPC_CHANNELS, REQUEST_CHANNELS } from '../src/ipcContract.js';
import { registerControllerIpcHandlers } from '../src/ipcHandlers.js';

test('IPC handlers register every request channel and dispose cleanly', () => {
  const ipcMain = fakeIpcMain();
  const application = fakeApplication();
  const registration = registerControllerIpcHandlers({ ipcMain, mainWindow: trustedWindow(), application, dialog: {}, fs: {}, path: {} });
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [...REQUEST_CHANNELS].sort());
  registration.dispose();
  registration.dispose();
  assert.equal(ipcMain.handlers.size, 0);
});

test('IPC handlers validate sender before application calls and map AUTH_DENIED safely', async () => {
  const ipcMain = fakeIpcMain();
  const application = fakeApplication();
  registerControllerIpcHandlers({ ipcMain, mainWindow: trustedWindow(), application, dialog: {}, fs: {}, path: {} });
  const result = await ipcMain.handlers.get(IPC_CHANNELS.system.getBootstrap)(untrustedEvent('https://app/'));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTH_DENIED');
  assert.equal(application.calls.length, 0);
});

test('IPC dispatch rejects invalid sender before creating a persisted job', async () => {
  const ipcMain = fakeIpcMain();
  const application = fakeApplication();
  application.persistedJobs = 0;
  application.dispatchWorkflow = (payload) => {
    application.persistedJobs += 1;
    application.calls.push(['dispatchWorkflow', payload]);
    return { jobId: 'job-created' };
  };
  registerControllerIpcHandlers({ ipcMain, mainWindow: trustedWindow(), application, dialog: {}, fs: {}, path: {} });
  const result = await ipcMain.handlers.get(IPC_CHANNELS.jobs.dispatch)(untrustedEvent('https://app/'), {
    deviceId: 'device-1',
    workflowId: 'workflow-1',
    revision: 1,
    inputs: {},
    deadlineSeconds: 300,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTH_DENIED');
  assert.equal(application.persistedJobs, 0);
  assert.equal(application.calls.length, 0);
});

test('IPC handlers validate payloads and call the exact application method', async () => {
  const ipcMain = fakeIpcMain();
  const application = fakeApplication();
  const window = trustedWindow();
  registerControllerIpcHandlers({ ipcMain, mainWindow: window, application, dialog: {}, fs: {}, path: {} });

  const ok = await ipcMain.handlers.get(IPC_CHANNELS.devices.get)(trustedEvent(window), { deviceId: 'device-1' });
  assert.equal(ok.ok, true);
  assert.deepEqual(application.calls.at(-1), ['getDevice', { deviceId: 'device-1' }]);

  const rejected = await ipcMain.handlers.get(IPC_CHANNELS.devices.get)(trustedEvent(window), { deviceId: 'device-1', extra: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'ERR_IPC_UNKNOWN_PROPERTY');
});

test('IPC handlers support import dialog cancellation without filesystem access', async () => {
  const ipcMain = fakeIpcMain();
  const application = fakeApplication();
  const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const window = trustedWindow();
  registerControllerIpcHandlers({ ipcMain, mainWindow: window, application, dialog, fs: {}, path: {} });
  const result = await ipcMain.handlers.get(IPC_CHANNELS.dialog.importDevice)(trustedEvent(window));
  assert.deepEqual(result, { ok: true, data: { canceled: true } });
});

test('IPC handlers forward sanitized invalidation payloads only', () => {
  const ipcMain = fakeIpcMain();
  const application = fakeApplication();
  const window = trustedWindow();
  const registration = registerControllerIpcHandlers({ ipcMain, mainWindow: window, application, dialog: {}, fs: {}, path: {} });
  application.emit('invalidation', { sequence: 1, domain: 'jobs', jobId: 'job-1', credential: 'secret', result: { ok: true } });
  assert.deepEqual(window.webContents.sent, [[IPC_CHANNELS.events.invalidation, { sequence: 1, domain: 'jobs', jobId: 'job-1' }]]);
  registration.dispose();
  application.emit('invalidation', { sequence: 2, domain: 'jobs' });
  assert.equal(window.webContents.sent.length, 1);
});

function fakeIpcMain() {
  return {
    handlers: new Map(),
    handle(channel, handler) { this.handlers.set(channel, handler); },
    removeHandler(channel) { this.handlers.delete(channel); },
  };
}

function fakeApplication() {
  const app = new EventEmitter();
  app.calls = [];
  const names = [
    'getBootstrapState', 'getRuntimeStatus', 'listPairings', 'requestPairing', 'confirmPairing', 'rejectPairing', 'revokeAgent',
    'listDevices', 'getDevice', 'listSessions', 'listGroups', 'createGroup', 'updateGroup', 'deleteGroup', 'addDeviceToGroup',
    'removeDeviceFromGroup', 'listWorkflows', 'getWorkflowRevision', 'importWorkflowRevision', 'listJobs', 'getJob',
    'listJobEvents', 'dispatchWorkflow', 'cancelJob',
  ];
  for (const name of names) {
    app[name] = (payload) => {
      app.calls.push([name, payload]);
      return { method: name, payload };
    };
  }
  return app;
}

function trustedWindow() {
  const frame = { url: 'war-controller://app/' };
  const webContents = { mainFrame: frame, sent: [], isDestroyed: () => false, send(...args) { this.sent.push(args); } };
  frame.top = frame;
  return { webContents };
}

function trustedEvent(window = trustedWindow()) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame };
}

function untrustedEvent(url) {
  const window = trustedWindow();
  const frame = { url };
  window.webContents.mainFrame = frame;
  return { sender: window.webContents, senderFrame: frame };
}
