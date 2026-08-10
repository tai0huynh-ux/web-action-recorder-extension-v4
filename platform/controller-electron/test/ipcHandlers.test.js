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

test('clipboard IPC keeps clipboard text in the main process and returns metadata only', async () => {
  const ipcMain = fakeIpcMain();
  const application = fakeApplication();
  const window = trustedWindow();
  const secret = 'synthetic clipboard secret';
  const clipboard = {
    writes: [],
    readText: () => secret,
    writeText(text, type) { this.writes.push([text, type]); },
  };
  application.remoteClipboardCopy = async (payload) => {
    application.calls.push(['remoteClipboardCopy', payload]);
    return { ok: true, data: { ...payload, copied: true, bytes: Buffer.byteLength(secret), text: secret } };
  };
  application.remoteClipboardPaste = async (payload) => {
    application.calls.push(['remoteClipboardPaste', { ...payload, text: '<redacted>' }]);
    assert.equal(payload.text, secret);
    return { ok: true, data: { pasted: true, bytes: Buffer.byteLength(payload.text) } };
  };
  registerControllerIpcHandlers({ ipcMain, mainWindow: window, application, clipboard, dialog: {}, fs: {}, path: {} });

  const copied = await ipcMain.handlers.get(IPC_CHANNELS.remote.clipboardCopy)(trustedEvent(window), { deviceId: 'device-1' });
  assert.deepEqual(copied, { ok: true, data: { deviceId: 'device-1', copied: true, bytes: Buffer.byteLength(secret) } });
  assert.deepEqual(clipboard.writes, [[secret, 'clipboard']]);
  assert.equal(JSON.stringify(copied).includes(secret), false);

  const pasted = await ipcMain.handlers.get(IPC_CHANNELS.remote.clipboardPaste)(trustedEvent(window), { deviceIds: ['device-1'], synchronized: false });
  assert.equal(pasted.ok, true);
  assert.equal(JSON.stringify(pasted).includes(secret), false);
});

test('interactive open validates private Moonlight endpoint and action before invoking the launcher', async () => {
  const ipcMain = fakeIpcMain();
  const application = fakeApplication();
  const window = trustedWindow();
  const calls = [];
  registerControllerIpcHandlers({
    ipcMain,
    mainWindow: window,
    application,
    openInteractive: async (payload) => { calls.push(payload); return { status: 'opened', deviceId: payload.deviceId }; },
    dialog: {},
    fs: {},
    path: {},
  });
  const opened = await ipcMain.handlers.get(IPC_CHANNELS.remote.openInteractive)(trustedEvent(window), {
    deviceId: 'device-1',
    action: 'stream',
    descriptor: { host: '192.168.1.201', port: 47989, app: 'Desktop', ignored: 'value' },
  });
  assert.deepEqual(opened, { ok: true, data: { status: 'opened', deviceId: 'device-1' } });
  assert.deepEqual(calls, [{
    deviceId: 'device-1',
    action: 'stream',
    descriptor: { host: '192.168.1.201', port: 47989, app: 'Desktop', protocol: 'moonlight' },
  }]);

  const rejected = await ipcMain.handlers.get(IPC_CHANNELS.remote.openInteractive)(trustedEvent(window), {
    deviceId: 'device-1',
    action: 'pair',
    descriptor: { host: '8.8.8.8' },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'INTERACTIVE_DESCRIPTOR_INVALID');
});

test('IPC handlers return a fixed public error envelope for coded application failures', async () => {
  const ipcMain = fakeIpcMain();
  const application = fakeApplication();
  const secret = 'synthetic-handler-secret';
  application.getDevice = () => {
    const error = new Error(`credential=${secret}`);
    error.code = 'DEVICE_NOT_FOUND';
    error.details = { url: `https://controller.example/#access_token=${secret}` };
    throw error;
  };
  const window = trustedWindow();
  registerControllerIpcHandlers({ ipcMain, mainWindow: window, application, dialog: {}, fs: {}, path: {} });

  const result = await ipcMain.handlers.get(IPC_CHANNELS.devices.get)(trustedEvent(window), { deviceId: 'device-1' });
  const encoded = JSON.stringify(result);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DEVICE_NOT_FOUND');
  assert.equal(result.error.message, 'Requested resource was not found');
  assert.equal(Object.hasOwn(result.error, 'details'), false);
  assert.equal(encoded.includes(secret), false);
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

test('IPC import rejects symlinks and file swaps before reading from the opened handle', async () => {
  const window = trustedWindow();
  const application = fakeApplication();
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: ['workflow.json'] }) };

  const symlinkIpc = fakeIpcMain();
  registerControllerIpcHandlers({
    ipcMain: symlinkIpc,
    mainWindow: window,
    application,
    dialog,
    fs: { promises: { lstat: async () => fileStat({ symbolicLink: true }) } },
    path: {}
  });
  const symlink = await symlinkIpc.handlers.get(IPC_CHANNELS.dialog.importWorkflow)(trustedEvent(window));
  assert.equal(symlink.ok, false);
  assert.equal(symlink.error.code, 'IMPORT_REJECTED');

  const swappedIpc = fakeIpcMain();
  let lstatCount = 0;
  const handle = fakeFileHandle(fileStat({ ino: 2 }), '{}');
  registerControllerIpcHandlers({
    ipcMain: swappedIpc,
    mainWindow: window,
    application,
    dialog,
    fs: {
      promises: {
        lstat: async () => fileStat({ ino: lstatCount++ === 0 ? 1 : 3 }),
        open: async () => handle
      }
    },
    path: {}
  });
  const swapped = await swappedIpc.handlers.get(IPC_CHANNELS.dialog.importWorkflow)(trustedEvent(window));
  assert.equal(swapped.ok, false);
  assert.equal(swapped.error.code, 'IMPORT_REJECTED');
  assert.equal(handle.closed, true);
  assert.equal(handle.readCalls, 0);
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

function fileStat({ ino = 1, dev = 1, size = 2, symbolicLink = false } = {}) {
  return { ino, dev, size, isFile: () => !symbolicLink, isSymbolicLink: () => symbolicLink };
}

function fakeFileHandle(stat, source) {
  const bytes = Buffer.from(source);
  return {
    closed: false,
    readCalls: 0,
    async stat() { return stat; },
    async read(buffer, offset, length, position) {
      this.readCalls += 1;
      const chunk = bytes.subarray(position, position + length);
      chunk.copy(buffer, offset);
      return { bytesRead: chunk.length };
    },
    async close() { this.closed = true; }
  };
}

function fakeApplication() {
  const app = new EventEmitter();
  app.calls = [];
  const names = [
    'getBootstrapState', 'getRuntimeStatus', 'listPairings', 'requestPairing', 'confirmPairing', 'rejectPairing', 'revokeAgent',
    'listDevices', 'getDevice', 'listSessions', 'listContainers', 'listContainerTrash', 'listContainerHosts', 'addContainerHost', 'checkContainerHost', 'repairContainerHost',
    'trashContainerHost', 'restoreContainerHost', 'purgeContainerHost', 'addContainer', 'startContainer', 'stopContainer', 'restartContainer', 'refreshContainer',
    'updateContainerNetwork', 'duplicateContainer', 'deleteContainer', 'restoreContainer', 'purgeContainer', 'listGroups', 'createGroup', 'updateGroup', 'deleteGroup', 'addDeviceToGroup',
    'removeDeviceFromGroup', 'getSettings', 'updateSettings', 'listWorkflows', 'getWorkflowRevision', 'importWorkflowRevision', 'listJobs', 'getJob',
    'listJobEvents', 'dispatchWorkflow', 'cancelJob',
    'remoteCapture', 'remoteControl', 'remoteClipboardCopy', 'remoteClipboardPaste',
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
