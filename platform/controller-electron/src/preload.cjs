const { contextBridge, ipcRenderer } = require('electron');

const IPC_CHANNELS = Object.freeze({
  system: Object.freeze({
    getBootstrap: 'war-controller:v1:system:get-bootstrap',
    getRuntime: 'war-controller:v1:system:get-runtime',
  }),
  pairings: Object.freeze({
    list: 'war-controller:v1:pairings:list',
    request: 'war-controller:v1:pairings:request',
    confirm: 'war-controller:v1:pairings:confirm',
    reject: 'war-controller:v1:pairings:reject',
    revoke: 'war-controller:v1:pairings:revoke',
  }),
  devices: Object.freeze({
    list: 'war-controller:v1:devices:list',
    get: 'war-controller:v1:devices:get',
  }),
  sessions: Object.freeze({
    list: 'war-controller:v1:sessions:list',
  }),
  groups: Object.freeze({
    list: 'war-controller:v1:groups:list',
    create: 'war-controller:v1:groups:create',
    update: 'war-controller:v1:groups:update',
    delete: 'war-controller:v1:groups:delete',
    addDevice: 'war-controller:v1:groups:add-device',
    removeDevice: 'war-controller:v1:groups:remove-device',
  }),
  workflows: Object.freeze({
    list: 'war-controller:v1:workflows:list',
    get: 'war-controller:v1:workflows:get',
    import: 'war-controller:v1:workflows:import',
  }),
  jobs: Object.freeze({
    list: 'war-controller:v1:jobs:list',
    get: 'war-controller:v1:jobs:get',
    events: 'war-controller:v1:jobs:events',
    dispatch: 'war-controller:v1:jobs:dispatch',
    cancel: 'war-controller:v1:jobs:cancel',
  }),
  dialog: Object.freeze({
    importDevice: 'war-controller:v1:dialog:import-device',
    importWorkflow: 'war-controller:v1:dialog:import-workflow',
  }),
  events: Object.freeze({
    invalidation: 'war-controller:v1:events:invalidation',
  }),
});

function call(channel) {
  return (payload) => ipcRenderer.invoke(channel, payload);
}

function onInvalidation(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('Invalidation callback must be a function');
  }
  let subscribed = true;
  const listener = (_event, payload) => {
    callback(payload);
  };
  ipcRenderer.on(IPC_CHANNELS.events.invalidation, listener);
  return () => {
    if (!subscribed) return;
    subscribed = false;
    ipcRenderer.removeListener(IPC_CHANNELS.events.invalidation, listener);
  };
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}

const api = deepFreeze({
  apiVersion: 'v1',
  system: {
    getBootstrapState: call(IPC_CHANNELS.system.getBootstrap),
    getRuntimeStatus: call(IPC_CHANNELS.system.getRuntime),
    onInvalidation,
  },
  pairings: {
    list: call(IPC_CHANNELS.pairings.list),
    request: call(IPC_CHANNELS.pairings.request),
    confirm: call(IPC_CHANNELS.pairings.confirm),
    reject: call(IPC_CHANNELS.pairings.reject),
    revoke: call(IPC_CHANNELS.pairings.revoke),
  },
  devices: {
    list: call(IPC_CHANNELS.devices.list),
    get: call(IPC_CHANNELS.devices.get),
  },
  sessions: {
    list: call(IPC_CHANNELS.sessions.list),
  },
  groups: {
    list: call(IPC_CHANNELS.groups.list),
    create: call(IPC_CHANNELS.groups.create),
    update: call(IPC_CHANNELS.groups.update),
    remove: call(IPC_CHANNELS.groups.delete),
    addDevice: call(IPC_CHANNELS.groups.addDevice),
    removeDevice: call(IPC_CHANNELS.groups.removeDevice),
  },
  workflows: {
    list: call(IPC_CHANNELS.workflows.list),
    get: call(IPC_CHANNELS.workflows.get),
    importFile: call(IPC_CHANNELS.dialog.importWorkflow),
  },
  jobs: {
    list: call(IPC_CHANNELS.jobs.list),
    get: call(IPC_CHANNELS.jobs.get),
    events: call(IPC_CHANNELS.jobs.events),
    dispatch: call(IPC_CHANNELS.jobs.dispatch),
    cancel: call(IPC_CHANNELS.jobs.cancel),
  },
  dialogs: {
    importDeviceDescriptor: call(IPC_CHANNELS.dialog.importDevice),
    importWorkflow: call(IPC_CHANNELS.dialog.importWorkflow),
  },
});

contextBridge.exposeInMainWorld('warController', api);
