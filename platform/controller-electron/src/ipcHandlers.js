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
} = {}) {
  const registrations = new Set();
  const invalidationListener = (event) => {
    const payload = sanitizeInvalidation(event);
    const contents = typeof mainWindow === 'function' ? mainWindow()?.webContents : mainWindow?.webContents;
    if (contents && !contents.isDestroyed?.()) contents.send?.(IPC_CHANNELS.events.invalidation, payload);
  };

  const methodMap = buildMethodMap(application, { dialog, fs, path });
  for (const channel of REQUEST_CHANNELS) {
    const method = methodMap.get(channel);
    if (!method) continue;
    ipcMain.handle(channel, async (event, payload) => {
      try {
        assertTrustedIpcSender(event, { mainWindow });
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
    [IPC_CHANNELS.devices.list, () => application.listDevices()],
    [IPC_CHANNELS.devices.get, (payload) => application.getDevice(payload)],
    [IPC_CHANNELS.settings.get, () => application.getSettings()],
    [IPC_CHANNELS.settings.update, (payload) => application.updateSettings(payload)],
    [IPC_CHANNELS.sessions.list, () => application.listSessions()],
    [IPC_CHANNELS.containers.list, () => application.listContainers()],
    [IPC_CHANNELS.containers.add, (payload) => application.addContainer(payload)],
    [IPC_CHANNELS.containers.start, (payload) => application.startContainer(payload)],
    [IPC_CHANNELS.containers.stop, (payload) => application.stopContainer(payload)],
    [IPC_CHANNELS.containers.restart, (payload) => application.restartContainer(payload)],
    [IPC_CHANNELS.containers.refresh, (payload) => application.refreshContainer(payload)],
    [IPC_CHANNELS.containers.duplicate, (payload) => application.duplicateContainer(payload)],
    [IPC_CHANNELS.containers.delete, (payload) => application.deleteContainer(payload)],
    [IPC_CHANNELS.groups.list, () => application.listGroups()],
    [IPC_CHANNELS.groups.create, (payload) => application.createGroup(payload)],
    [IPC_CHANNELS.groups.update, (payload) => application.updateGroup(payload)],
    [IPC_CHANNELS.groups.delete, (payload) => application.deleteGroup(payload)],
    [IPC_CHANNELS.groups.addDevice, (payload) => application.addDeviceToGroup(payload)],
    [IPC_CHANNELS.groups.removeDevice, (payload) => application.removeDeviceFromGroup(payload)],
    [IPC_CHANNELS.workflows.list, () => application.listWorkflows()],
    [IPC_CHANNELS.workflows.get, (payload) => application.getWorkflowRevision(payload)],
    [IPC_CHANNELS.workflows.import, (payload) => application.importWorkflowRevision(payload)],
    [IPC_CHANNELS.jobs.list, (payload) => application.listJobs(payload)],
    [IPC_CHANNELS.jobs.get, (payload) => application.getJob(payload)],
    [IPC_CHANNELS.jobs.events, (payload) => application.listJobEvents(payload)],
    [IPC_CHANNELS.jobs.dispatch, (payload) => application.dispatchWorkflow(payload)],
    [IPC_CHANNELS.jobs.cancel, (payload) => application.cancelJob(payload)],
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
  const stat = await fs.promises.stat(filePath);
  if (stat.isSymbolicLink?.()) throw codedError('IMPORT_REJECTED', `${label} import rejected`);
  if (!stat.isFile?.()) throw codedError('IMPORT_REJECTED', `${label} import rejected`);
  if (stat.size > MAX_IMPORT_BYTES) throw codedError('IMPORT_TOO_LARGE', `${label} import is too large`);
  const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  const validation = validator(parsed);
  if (!validation.ok) throw codedError('IMPORT_INVALID', `${label} is invalid`, validation.errors);
  return { canceled: false, name: basename(filePath), value: parsed };
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
