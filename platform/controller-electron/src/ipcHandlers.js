import { basename } from 'node:path';
import { IPC_CHANNELS, REQUEST_CHANNELS, validateIpcPayload } from './ipcContract.js';
import { mapErrorToIpcResult } from './errorMapper.js';
import { assertTrustedIpcSender } from './ipcSenderPolicy.js';
import { validateDeviceDescriptor, validateWorkflowRevision } from '../../protocol/src/protocolV2.js';

const MAX_IMPORT_BYTES = 1024 * 1024;

export function registerControllerIpcHandlers({
  ipcMain,
  mainWindow,
  application,
  dialog,
  fs,
  path,
  openRemoteWindow,
  allowedWindows,
} = {}) {
  const registrations = new Set();
  const invalidationListener = (event) => {
    const payload = sanitizeInvalidation(event);
    const primary = typeof mainWindow === 'function' ? mainWindow() : mainWindow;
    const extra = typeof allowedWindows === 'function' ? allowedWindows() : allowedWindows;
    const windows = new Set([primary, ...(extra ? [...extra] : [])].filter(Boolean));
    for (const window of windows) {
      const contents = window?.webContents;
      if (contents && !contents.isDestroyed?.()) contents.send?.(IPC_CHANNELS.events.invalidation, payload);
    }
  };

  const methodMap = buildMethodMap(application, { dialog, fs, path, openRemoteWindow });
  for (const channel of REQUEST_CHANNELS) {
    const method = methodMap.get(channel);
    if (!method) continue;
    ipcMain.handle(channel, async (event, payload) => {
      try {
        assertTrustedIpcSender(event, { mainWindow, allowedWindows });
        const validated = validateIpcPayload(channel, payload);
        const data = await method(validated);
        return { ok: true, data };
      } catch (error) {
        return mapErrorToIpcResult(error);
      }
    });
    registrations.add(channel);
  }

  application?.on?.('invalidation', invalidationListener);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const channel of registrations) ipcMain.removeHandler(channel);
      application?.off?.('invalidation', invalidationListener);
      registrations.clear();
    },
  };
}

export function buildMethodMap(application, dependencies = {}) {
  return new Map([
    [IPC_CHANNELS.system.getBootstrap, () => application.getBootstrapState()],
    [IPC_CHANNELS.system.getRuntime, () => application.getRuntimeStatus()],
    [IPC_CHANNELS.pairings.list, () => application.listPairings()],
    [IPC_CHANNELS.pairings.request, (payload) => application.requestPairing(payload)],
    [IPC_CHANNELS.pairings.confirm, (payload) => application.confirmPairing(payload)],
    [IPC_CHANNELS.pairings.reject, (payload) => application.rejectPairing(payload)],
    [IPC_CHANNELS.pairings.revoke, (payload) => application.revokeAgent(payload)],
    [IPC_CHANNELS.pairings.reconnect, (payload) => application.reconnectAgent(payload)],
    [IPC_CHANNELS.devices.list, () => application.listDevices()],
    [IPC_CHANNELS.devices.get, (payload) => application.getDevice(payload)],
    [IPC_CHANNELS.settings.get, () => application.getSettings()],
    [IPC_CHANNELS.settings.update, (payload) => application.updateSettings(payload)],
    [IPC_CHANNELS.sessions.list, () => application.listSessions()],
    [IPC_CHANNELS.remote.capture, (payload) => application.remoteCapture(payload)],
    [IPC_CHANNELS.remote.control, (payload) => application.remoteControl(payload)],
    [IPC_CHANNELS.remote.openWindow, (payload) => {
      if (typeof dependencies.openRemoteWindow !== 'function') throw codedError('REMOTE_WINDOW_UNAVAILABLE', 'Remote window support is unavailable');
      return dependencies.openRemoteWindow(payload);
    }],
    [IPC_CHANNELS.containers.list, () => application.listContainers()],
    [IPC_CHANNELS.containers.trash, () => application.listContainerTrash()],
    [IPC_CHANNELS.containers.hosts, () => application.listContainerHosts()],
    [IPC_CHANNELS.containers.hostAdd, (payload) => application.addContainerHost(payload)],
    [IPC_CHANNELS.containers.hostUpdate, (payload) => application.updateContainerHost(payload)],
    [IPC_CHANNELS.containers.hostCheck, (payload) => application.checkContainerHost(payload)],
    [IPC_CHANNELS.containers.hostReconnect, (payload) => application.reconnectContainerHost(payload)],
    [IPC_CHANNELS.containers.hostRepair, (payload) => application.repairContainerHost(payload)],
    [IPC_CHANNELS.containers.hostTrash, (payload) => application.trashContainerHost(payload)],
    [IPC_CHANNELS.containers.hostRestore, (payload) => application.restoreContainerHost(payload)],
    [IPC_CHANNELS.containers.hostPurge, (payload) => application.purgeContainerHost(payload)],
    [IPC_CHANNELS.containers.scan, (payload) => application.scanContainerHost(payload)],
    [IPC_CHANNELS.containers.add, (payload) => application.addContainer(payload)],
    [IPC_CHANNELS.containers.start, (payload) => application.startContainer(payload)],
    [IPC_CHANNELS.containers.stop, (payload) => application.stopContainer(payload)],
    [IPC_CHANNELS.containers.restart, (payload) => application.restartContainer(payload)],
    [IPC_CHANNELS.containers.reconnect, (payload) => application.reconnectContainer(payload)],
    [IPC_CHANNELS.containers.repair, (payload) => application.repairContainer(payload)],
    [IPC_CHANNELS.containers.refresh, (payload) => application.refreshContainer(payload)],
    [IPC_CHANNELS.containers.updateNetwork, (payload) => application.updateContainerNetwork(payload)],
    [IPC_CHANNELS.containers.duplicate, (payload) => application.duplicateContainer(payload)],
    [IPC_CHANNELS.containers.delete, (payload) => application.deleteContainer(payload)],
    [IPC_CHANNELS.containers.restore, (payload) => application.restoreContainer(payload)],
    [IPC_CHANNELS.containers.purge, (payload) => application.purgeContainer(payload)],
    [IPC_CHANNELS.groups.list, () => application.listGroups()],
    [IPC_CHANNELS.groups.create, (payload) => application.createGroup(payload)],
    [IPC_CHANNELS.groups.update, (payload) => application.updateGroup(payload)],
    [IPC_CHANNELS.groups.delete, (payload) => application.deleteGroup(payload)],
    [IPC_CHANNELS.groups.addDevice, (payload) => application.addDeviceToGroup(payload)],
    [IPC_CHANNELS.groups.removeDevice, (payload) => application.removeDeviceFromGroup(payload)],
    [IPC_CHANNELS.workflows.list, () => application.listWorkflows()],
    [IPC_CHANNELS.workflows.get, (payload) => application.getWorkflowRevision(payload)],
    [IPC_CHANNELS.workflows.import, (payload) => application.importWorkflowRevision(payload)],
    [IPC_CHANNELS.workflows.originPreview, (payload) => application.previewOriginSync(payload)],
    [IPC_CHANNELS.workflows.originPull, (payload) => application.pullOriginSync(payload)],
    [IPC_CHANNELS.workflows.graphGet, (payload) => application.getWorkflowGraph(payload)],
    [IPC_CHANNELS.workflows.graphPreview, (payload) => application.previewWorkflowGraph(payload)],
    [IPC_CHANNELS.workflows.graphSave, (payload) => application.saveWorkflowGraph(payload)],
    [IPC_CHANNELS.jobs.list, (payload) => application.listJobs(payload)],
    [IPC_CHANNELS.jobs.get, (payload) => application.getJob(payload)],
    [IPC_CHANNELS.jobs.events, (payload) => application.listJobEvents(payload)],
    [IPC_CHANNELS.jobs.dispatch, (payload) => application.dispatchWorkflow(payload)],
    [IPC_CHANNELS.jobs.groupedPreview, (payload) => application.previewGroupedInput(payload)],
    [IPC_CHANNELS.jobs.groupedDispatch, (payload) => application.dispatchGroupedInput(payload)],
    [IPC_CHANNELS.jobs.cancel, (payload) => application.cancelJob(payload)],
    [IPC_CHANNELS.diagnostics.run, () => application.getDiagnostics()],
    [IPC_CHANNELS.diagnostics.repair, (payload) => application.repairDiagnostics(payload)],
    [IPC_CHANNELS.dialog.importDevice, () => importJsonFile({ ...dependencies, validator: validateDeviceDescriptor, label: 'DeviceDescriptor' })],
    [IPC_CHANNELS.dialog.importWorkflow, () => importJsonFile({ ...dependencies, validator: validateWorkflowRevision, label: 'WorkflowRevision' })],
  ]);
}

async function importJsonFile({ dialog, fs, path, validator, label }) {
  if (!dialog || !fs || !path) throw codedError('IMPORT_UNAVAILABLE', 'Import dialog is unavailable');
  const selection = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (selection.canceled || selection.filePaths?.length !== 1) return { canceled: true };
  const filePath = selection.filePaths[0];
  const before = await fs.promises.lstat(filePath);
  if (before.isSymbolicLink?.() || !before.isFile?.()) throw codedError('IMPORT_REJECTED', `${label} import rejected`);
  const handle = await fs.promises.open(filePath, 'r');
  let source;
  try {
    const opened = await handle.stat();
    const after = await fs.promises.lstat(filePath);
    if (after.isSymbolicLink?.() || !after.isFile?.() || !sameFile(opened, after)) throw codedError('IMPORT_REJECTED', `${label} import rejected`);
    if (opened.size > MAX_IMPORT_BYTES) throw codedError('IMPORT_TOO_LARGE', `${label} import is too large`);
    source = await readBounded(handle, MAX_IMPORT_BYTES);
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(source);
  const validation = validator(parsed);
  if (!validation.ok) throw codedError('IMPORT_INVALID', `${label} is invalid`, validation.errors);
  return { canceled: false, name: basename(filePath), value: parsed };
}

async function readBounded(handle, maxBytes) {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw codedError('IMPORT_TOO_LARGE', 'Import file is too large');
  return buffer.subarray(0, offset).toString('utf8');
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sanitizeInvalidation(event = {}) {
  const payload = {};
  if (Number.isInteger(event.sequence)) payload.sequence = event.sequence;
  if (typeof event.domain === 'string') payload.domain = event.domain;
  if (typeof event.deviceId === 'string') payload.deviceId = event.deviceId;
  if (typeof event.jobId === 'string') payload.jobId = event.jobId;
  if (typeof event.containerId === 'string') payload.containerId = event.containerId;
  return payload;
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
