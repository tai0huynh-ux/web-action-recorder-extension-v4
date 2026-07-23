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
    reconnect: 'war-controller:v1:pairings:reconnect',
  }),
  devices: Object.freeze({
    list: 'war-controller:v1:devices:list',
    get: 'war-controller:v1:devices:get',
  }),
  settings: Object.freeze({
    get: 'war-controller:v1:settings:get',
    update: 'war-controller:v1:settings:update',
  }),
  sessions: Object.freeze({
    list: 'war-controller:v1:sessions:list',
  }),
  remote: Object.freeze({
    capture: 'war-controller:v1:remote:capture',
    control: 'war-controller:v1:remote:control',
    openWindow: 'war-controller:v1:remote:open-window',
  }),
  containers: Object.freeze({
    list: 'war-controller:v1:containers:list',
    trash: 'war-controller:v1:containers:trash',
    hosts: 'war-controller:v1:containers:hosts',
    hostAdd: 'war-controller:v1:containers:host-add',
    hostUpdate: 'war-controller:v1:containers:host-update',
    hostCheck: 'war-controller:v1:containers:host-check',
    hostReconnect: 'war-controller:v1:containers:host-reconnect',
    hostRepair: 'war-controller:v1:containers:host-repair',
    hostTrash: 'war-controller:v1:containers:host-trash',
    hostRestore: 'war-controller:v1:containers:host-restore',
    hostPurge: 'war-controller:v1:containers:host-purge',
    scan: 'war-controller:v1:containers:scan',
    add: 'war-controller:v1:containers:add',
    start: 'war-controller:v1:containers:start',
    stop: 'war-controller:v1:containers:stop',
    restart: 'war-controller:v1:containers:restart',
    reconnect: 'war-controller:v1:containers:reconnect',
    repair: 'war-controller:v1:containers:repair',
    refresh: 'war-controller:v1:containers:refresh',
    updateNetwork: 'war-controller:v1:containers:update-network',
    duplicate: 'war-controller:v1:containers:duplicate',
    delete: 'war-controller:v1:containers:delete',
    restore: 'war-controller:v1:containers:restore',
    purge: 'war-controller:v1:containers:purge',
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
    originPreview: 'war-controller:v1:workflows:origin-preview',
    originPull: 'war-controller:v1:workflows:origin-pull',
    graphGet: 'war-controller:v1:workflows:graph-get',
    graphPreview: 'war-controller:v1:workflows:graph-preview',
    graphSave: 'war-controller:v1:workflows:graph-save',
  }),
  jobs: Object.freeze({
    list: 'war-controller:v1:jobs:list',
    get: 'war-controller:v1:jobs:get',
    events: 'war-controller:v1:jobs:events',
    dispatch: 'war-controller:v1:jobs:dispatch',
    groupedPreview: 'war-controller:v1:jobs:grouped-preview',
    groupedDispatch: 'war-controller:v1:jobs:grouped-dispatch',
    cancel: 'war-controller:v1:jobs:cancel',
  }),
  diagnostics: Object.freeze({
    run: 'war-controller:v1:diagnostics:run',
    repair: 'war-controller:v1:diagnostics:repair',
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
    reconnect: call(IPC_CHANNELS.pairings.reconnect),
  },
  devices: {
    list: call(IPC_CHANNELS.devices.list),
    get: call(IPC_CHANNELS.devices.get),
  },
  settings: {
    get: call(IPC_CHANNELS.settings.get),
    update: call(IPC_CHANNELS.settings.update),
  },
  sessions: {
    list: call(IPC_CHANNELS.sessions.list),
  },
  remote: {
    capture: call(IPC_CHANNELS.remote.capture),
    control: call(IPC_CHANNELS.remote.control),
    openWindow: call(IPC_CHANNELS.remote.openWindow),
  },
  containers: {
    list: call(IPC_CHANNELS.containers.list),
    trash: call(IPC_CHANNELS.containers.trash),
    hosts: call(IPC_CHANNELS.containers.hosts),
    addHost: call(IPC_CHANNELS.containers.hostAdd),
    updateHost: call(IPC_CHANNELS.containers.hostUpdate),
    checkHost: call(IPC_CHANNELS.containers.hostCheck),
    reconnectHost: call(IPC_CHANNELS.containers.hostReconnect),
    repairHost: call(IPC_CHANNELS.containers.hostRepair),
    trashHost: call(IPC_CHANNELS.containers.hostTrash),
    restoreHost: call(IPC_CHANNELS.containers.hostRestore),
    purgeHost: call(IPC_CHANNELS.containers.hostPurge),
    scan: call(IPC_CHANNELS.containers.scan),
    add: call(IPC_CHANNELS.containers.add),
    start: call(IPC_CHANNELS.containers.start),
    stop: call(IPC_CHANNELS.containers.stop),
    restart: call(IPC_CHANNELS.containers.restart),
    reconnect: call(IPC_CHANNELS.containers.reconnect),
    repair: call(IPC_CHANNELS.containers.repair),
    refresh: call(IPC_CHANNELS.containers.refresh),
    updateNetwork: call(IPC_CHANNELS.containers.updateNetwork),
    duplicate: call(IPC_CHANNELS.containers.duplicate),
    delete: call(IPC_CHANNELS.containers.delete),
    restore: call(IPC_CHANNELS.containers.restore),
    purge: call(IPC_CHANNELS.containers.purge),
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
    importFile: call(IPC_CHANNELS.workflows.import),
    originPreview: call(IPC_CHANNELS.workflows.originPreview),
    originPull: call(IPC_CHANNELS.workflows.originPull),
    graphGet: call(IPC_CHANNELS.workflows.graphGet),
    graphPreview: call(IPC_CHANNELS.workflows.graphPreview),
    graphSave: call(IPC_CHANNELS.workflows.graphSave),
  },
  jobs: {
    list: call(IPC_CHANNELS.jobs.list),
    get: call(IPC_CHANNELS.jobs.get),
    events: call(IPC_CHANNELS.jobs.events),
    dispatch: call(IPC_CHANNELS.jobs.dispatch),
    groupedPreview: call(IPC_CHANNELS.jobs.groupedPreview),
    groupedDispatch: call(IPC_CHANNELS.jobs.groupedDispatch),
    cancel: call(IPC_CHANNELS.jobs.cancel),
  },
  diagnostics: {
    run: call(IPC_CHANNELS.diagnostics.run),
    repair: call(IPC_CHANNELS.diagnostics.repair),
  },
  dialogs: {
    importDeviceDescriptor: call(IPC_CHANNELS.dialog.importDevice),
    importWorkflow: call(IPC_CHANNELS.dialog.importWorkflow),
  },
});

contextBridge.exposeInMainWorld('warController', api);
