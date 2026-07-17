import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS } from '../src/ipcContract.js';

const require = createRequire(import.meta.url);
const preloadPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/preload.cjs');

test('preload exposes only the warController global with the exact API shape', () => {
  const harness = loadPreload();
  assert.deepEqual(Object.keys(harness.exposed), ['warController']);
  const api = harness.exposed.warController;

  assert.equal(api.apiVersion, 'v1');
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(publicShape(api), {
    apiVersion: 'string',
    system: ['getBootstrapState', 'getRuntimeStatus', 'onInvalidation'],
    pairings: ['confirm', 'list', 'reject', 'request', 'revoke'],
    devices: ['get', 'list'],
    settings: ['get', 'update'],
    sessions: ['list'],
    containers: ['add', 'delete', 'duplicate', 'list', 'refresh', 'restart', 'start', 'stop'],
    groups: ['addDevice', 'create', 'list', 'remove', 'removeDevice', 'update'],
    workflows: ['get', 'graphGet', 'graphPreview', 'graphSave', 'importFile', 'list', 'originPreview', 'originPull'],
    jobs: ['cancel', 'dispatch', 'events', 'get', 'groupedDispatch', 'groupedPreview', 'list'],
    dialogs: ['importDeviceDescriptor', 'importWorkflow'],
  });
  for (const key of Object.keys(api)) {
    if (api[key] && typeof api[key] === 'object') assert.equal(Object.isFrozen(api[key]), true);
  }
});

test('preload does not expose generic or privileged APIs', () => {
  const api = loadPreload().exposed.warController;
  const publicKeys = JSON.stringify(publicShape(api));
  for (const forbidden of ['invoke', 'send', 'subscribe', 'ipcRenderer', 'electron', 'process', 'Buffer', 'require', 'fs', 'path', 'child_process']) {
    assert.equal(Object.hasOwn(api, forbidden), false);
    assert.equal(publicKeys.includes(forbidden), false);
  }
});

test('preload methods invoke the fixed IPC contract channels with intact payloads', async () => {
  const { exposed, invocations } = loadPreload();
  const api = exposed.warController;
  const payload = { id: 'value', nested: { ok: true } };

  const methods = [
    [api.system.getBootstrapState, IPC_CHANNELS.system.getBootstrap],
    [api.system.getRuntimeStatus, IPC_CHANNELS.system.getRuntime],
    [api.pairings.list, IPC_CHANNELS.pairings.list],
    [api.pairings.request, IPC_CHANNELS.pairings.request],
    [api.pairings.confirm, IPC_CHANNELS.pairings.confirm],
    [api.pairings.reject, IPC_CHANNELS.pairings.reject],
    [api.pairings.revoke, IPC_CHANNELS.pairings.revoke],
    [api.devices.list, IPC_CHANNELS.devices.list],
    [api.devices.get, IPC_CHANNELS.devices.get],
    [api.settings.get, IPC_CHANNELS.settings.get],
    [api.settings.update, IPC_CHANNELS.settings.update],
    [api.sessions.list, IPC_CHANNELS.sessions.list],
    [api.containers.list, IPC_CHANNELS.containers.list],
    [api.containers.add, IPC_CHANNELS.containers.add],
    [api.containers.start, IPC_CHANNELS.containers.start],
    [api.containers.stop, IPC_CHANNELS.containers.stop],
    [api.containers.restart, IPC_CHANNELS.containers.restart],
    [api.containers.refresh, IPC_CHANNELS.containers.refresh],
    [api.containers.duplicate, IPC_CHANNELS.containers.duplicate],
    [api.containers.delete, IPC_CHANNELS.containers.delete],
    [api.groups.list, IPC_CHANNELS.groups.list],
    [api.groups.create, IPC_CHANNELS.groups.create],
    [api.groups.update, IPC_CHANNELS.groups.update],
    [api.groups.remove, IPC_CHANNELS.groups.delete],
    [api.groups.addDevice, IPC_CHANNELS.groups.addDevice],
    [api.groups.removeDevice, IPC_CHANNELS.groups.removeDevice],
    [api.workflows.list, IPC_CHANNELS.workflows.list],
    [api.workflows.get, IPC_CHANNELS.workflows.get],
    [api.workflows.importFile, IPC_CHANNELS.workflows.import],
    [api.workflows.originPreview, IPC_CHANNELS.workflows.originPreview],
    [api.workflows.originPull, IPC_CHANNELS.workflows.originPull],
    [api.workflows.graphGet, IPC_CHANNELS.workflows.graphGet],
    [api.workflows.graphPreview, IPC_CHANNELS.workflows.graphPreview],
    [api.workflows.graphSave, IPC_CHANNELS.workflows.graphSave],
    [api.jobs.list, IPC_CHANNELS.jobs.list],
    [api.jobs.get, IPC_CHANNELS.jobs.get],
    [api.jobs.events, IPC_CHANNELS.jobs.events],
    [api.jobs.dispatch, IPC_CHANNELS.jobs.dispatch],
    [api.jobs.groupedPreview, IPC_CHANNELS.jobs.groupedPreview],
    [api.jobs.groupedDispatch, IPC_CHANNELS.jobs.groupedDispatch],
    [api.jobs.cancel, IPC_CHANNELS.jobs.cancel],
    [api.dialogs.importDeviceDescriptor, IPC_CHANNELS.dialog.importDevice],
    [api.dialogs.importWorkflow, IPC_CHANNELS.dialog.importWorkflow],
  ];

  for (const [method, channel] of methods) {
    const result = await method(payload);
    assert.deepEqual(result, { ok: true, channel, payload });
  }
  assert.deepEqual(invocations.map((item) => item.payload), methods.map(() => payload));
});

test('onInvalidation validates callbacks and strips the Electron event object', () => {
  const { exposed, listeners, removedListeners } = loadPreload();
  const api = exposed.warController;

  assert.throws(() => api.system.onInvalidation(null), TypeError);
  assert.equal(listeners.length, 0);

  const received = [];
  const unsubscribe = api.system.onInvalidation((payload) => received.push(payload));
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].channel, IPC_CHANNELS.events.invalidation);

  const electronEvent = { sender: 'secret-event' };
  const payload = { sequence: 1, domain: 'devices' };
  listeners[0].listener(electronEvent, payload);
  assert.deepEqual(received, [payload]);

  unsubscribe();
  unsubscribe();
  assert.equal(removedListeners.length, 1);
  assert.equal(removedListeners[0].channel, IPC_CHANNELS.events.invalidation);
  assert.equal(removedListeners[0].listener, listeners[0].listener);
});

function loadPreload() {
  delete require.cache[preloadPath];
  const exposed = {};
  const invocations = [];
  const listeners = [];
  const removedListeners = [];
  const electronStub = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = value;
      },
    },
    ipcRenderer: {
      invoke(channel, payload) {
        invocations.push({ channel, payload });
        return Promise.resolve({ ok: true, channel, payload });
      },
      on(channel, listener) {
        listeners.push({ channel, listener });
      },
      removeListener(channel, listener) {
        removedListeners.push({ channel, listener });
      },
    },
  };

  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  return { exposed, invocations, listeners, removedListeners };
}

function publicShape(api) {
  const shape = {};
  for (const [key, value] of Object.entries(api)) {
    shape[key] = value && typeof value === 'object' ? Object.keys(value).sort() : typeof value;
  }
  return shape;
}
