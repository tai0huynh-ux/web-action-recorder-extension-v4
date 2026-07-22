const CHANNEL_PREFIX = 'war-controller:v1:';
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const MAX_IPC_PAYLOAD_BYTES = 262144;
export const MAX_LIST_LIMIT = 200;

export const IPC_CHANNELS = deepFreeze({
  system: {
    getBootstrap: `${CHANNEL_PREFIX}system:get-bootstrap`,
    getRuntime: `${CHANNEL_PREFIX}system:get-runtime`,
  },
  pairings: {
    list: `${CHANNEL_PREFIX}pairings:list`,
    request: `${CHANNEL_PREFIX}pairings:request`,
    confirm: `${CHANNEL_PREFIX}pairings:confirm`,
    reject: `${CHANNEL_PREFIX}pairings:reject`,
    revoke: `${CHANNEL_PREFIX}pairings:revoke`,
  },
  devices: {
    list: `${CHANNEL_PREFIX}devices:list`,
    get: `${CHANNEL_PREFIX}devices:get`,
  },
  settings: {
    get: `${CHANNEL_PREFIX}settings:get`,
    update: `${CHANNEL_PREFIX}settings:update`,
  },
  sessions: {
    list: `${CHANNEL_PREFIX}sessions:list`,
  },
  containers: {
    list: `${CHANNEL_PREFIX}containers:list`,
    trash: `${CHANNEL_PREFIX}containers:trash`,
    hosts: `${CHANNEL_PREFIX}containers:hosts`,
    hostAdd: `${CHANNEL_PREFIX}containers:host-add`,
    hostUpdate: `${CHANNEL_PREFIX}containers:host-update`,
    hostCheck: `${CHANNEL_PREFIX}containers:host-check`,
    hostRepair: `${CHANNEL_PREFIX}containers:host-repair`,
    hostTrash: `${CHANNEL_PREFIX}containers:host-trash`,
    hostRestore: `${CHANNEL_PREFIX}containers:host-restore`,
    hostPurge: `${CHANNEL_PREFIX}containers:host-purge`,
    add: `${CHANNEL_PREFIX}containers:add`,
    start: `${CHANNEL_PREFIX}containers:start`,
    stop: `${CHANNEL_PREFIX}containers:stop`,
    restart: `${CHANNEL_PREFIX}containers:restart`,
    refresh: `${CHANNEL_PREFIX}containers:refresh`,
    updateNetwork: `${CHANNEL_PREFIX}containers:update-network`,
    duplicate: `${CHANNEL_PREFIX}containers:duplicate`,
    delete: `${CHANNEL_PREFIX}containers:delete`,
    restore: `${CHANNEL_PREFIX}containers:restore`,
    purge: `${CHANNEL_PREFIX}containers:purge`,
  },
  groups: {
    list: `${CHANNEL_PREFIX}groups:list`,
    create: `${CHANNEL_PREFIX}groups:create`,
    update: `${CHANNEL_PREFIX}groups:update`,
    delete: `${CHANNEL_PREFIX}groups:delete`,
    addDevice: `${CHANNEL_PREFIX}groups:add-device`,
    removeDevice: `${CHANNEL_PREFIX}groups:remove-device`,
  },
  workflows: {
    list: `${CHANNEL_PREFIX}workflows:list`,
    get: `${CHANNEL_PREFIX}workflows:get`,
    import: `${CHANNEL_PREFIX}workflows:import`,
    originPreview: `${CHANNEL_PREFIX}workflows:origin-preview`,
    originPull: `${CHANNEL_PREFIX}workflows:origin-pull`,
    graphGet: `${CHANNEL_PREFIX}workflows:graph-get`,
    graphPreview: `${CHANNEL_PREFIX}workflows:graph-preview`,
    graphSave: `${CHANNEL_PREFIX}workflows:graph-save`,
  },
  jobs: {
    list: `${CHANNEL_PREFIX}jobs:list`,
    get: `${CHANNEL_PREFIX}jobs:get`,
    events: `${CHANNEL_PREFIX}jobs:events`,
    dispatch: `${CHANNEL_PREFIX}jobs:dispatch`,
    groupedPreview: `${CHANNEL_PREFIX}jobs:grouped-preview`,
    groupedDispatch: `${CHANNEL_PREFIX}jobs:grouped-dispatch`,
    cancel: `${CHANNEL_PREFIX}jobs:cancel`,
  },
  dialog: {
    importDevice: `${CHANNEL_PREFIX}dialog:import-device`,
    importWorkflow: `${CHANNEL_PREFIX}dialog:import-workflow`,
  },
  events: {
    invalidation: `${CHANNEL_PREFIX}events:invalidation`,
  },
});

export const REQUEST_CHANNELS = deepFreeze([
  IPC_CHANNELS.system.getBootstrap,
  IPC_CHANNELS.system.getRuntime,
  IPC_CHANNELS.pairings.list,
  IPC_CHANNELS.pairings.request,
  IPC_CHANNELS.pairings.confirm,
  IPC_CHANNELS.pairings.reject,
  IPC_CHANNELS.pairings.revoke,
  IPC_CHANNELS.devices.list,
  IPC_CHANNELS.devices.get,
  IPC_CHANNELS.settings.get,
  IPC_CHANNELS.settings.update,
  IPC_CHANNELS.sessions.list,
  IPC_CHANNELS.containers.list,
  IPC_CHANNELS.containers.trash,
  IPC_CHANNELS.containers.hosts,
  IPC_CHANNELS.containers.hostAdd,
  IPC_CHANNELS.containers.hostUpdate,
  IPC_CHANNELS.containers.hostCheck,
  IPC_CHANNELS.containers.hostRepair,
  IPC_CHANNELS.containers.hostTrash,
  IPC_CHANNELS.containers.hostRestore,
  IPC_CHANNELS.containers.hostPurge,
  IPC_CHANNELS.containers.add,
  IPC_CHANNELS.containers.start,
  IPC_CHANNELS.containers.stop,
  IPC_CHANNELS.containers.restart,
  IPC_CHANNELS.containers.refresh,
  IPC_CHANNELS.containers.updateNetwork,
  IPC_CHANNELS.containers.duplicate,
  IPC_CHANNELS.containers.delete,
  IPC_CHANNELS.containers.restore,
  IPC_CHANNELS.containers.purge,
  IPC_CHANNELS.groups.list,
  IPC_CHANNELS.groups.create,
  IPC_CHANNELS.groups.update,
  IPC_CHANNELS.groups.delete,
  IPC_CHANNELS.groups.addDevice,
  IPC_CHANNELS.groups.removeDevice,
  IPC_CHANNELS.workflows.list,
  IPC_CHANNELS.workflows.get,
  IPC_CHANNELS.workflows.import,
  IPC_CHANNELS.workflows.originPreview,
  IPC_CHANNELS.workflows.originPull,
  IPC_CHANNELS.workflows.graphGet,
  IPC_CHANNELS.workflows.graphPreview,
  IPC_CHANNELS.workflows.graphSave,
  IPC_CHANNELS.jobs.list,
  IPC_CHANNELS.jobs.get,
  IPC_CHANNELS.jobs.events,
  IPC_CHANNELS.jobs.dispatch,
  IPC_CHANNELS.jobs.groupedPreview,
  IPC_CHANNELS.jobs.groupedDispatch,
  IPC_CHANNELS.jobs.cancel,
  IPC_CHANNELS.dialog.importDevice,
  IPC_CHANNELS.dialog.importWorkflow,
]);

export const EVENT_CHANNELS = deepFreeze([
  IPC_CHANNELS.events.invalidation,
]);

export const CHANNELS = Object.freeze({
  bootstrap: IPC_CHANNELS.system.getBootstrap,
  runtime: IPC_CHANNELS.system.getRuntime,
});

const NO_PAYLOAD = Object.freeze({ kind: 'none' });
const LIST_PAYLOAD = Object.freeze({ kind: 'object', properties: Object.freeze({ limit: 'limit' }) });

const CHANNEL_SCHEMAS = new Map([
  [IPC_CHANNELS.system.getBootstrap, NO_PAYLOAD],
  [IPC_CHANNELS.system.getRuntime, NO_PAYLOAD],
  [IPC_CHANNELS.pairings.list, LIST_PAYLOAD],
  [IPC_CHANNELS.pairings.request, objectSchema({ device: 'object', displayName: 'optionalString', requestId: 'optionalString' })],
  [IPC_CHANNELS.pairings.confirm, objectSchema({ requestId: 'id', code: 'id' })],
  [IPC_CHANNELS.pairings.reject, objectSchema({ pairingId: 'id', reason: 'optionalString' })],
  [IPC_CHANNELS.pairings.revoke, objectSchema({ deviceId: 'id' })],
  [IPC_CHANNELS.devices.list, LIST_PAYLOAD],
  [IPC_CHANNELS.devices.get, objectSchema({ deviceId: 'id' })],
  [IPC_CHANNELS.settings.get, NO_PAYLOAD],
  [IPC_CHANNELS.settings.update, objectSchema({ locale: 'optionalString', workspace: 'optionalObject', hostAliases: 'optionalObject' })],
  [IPC_CHANNELS.sessions.list, LIST_PAYLOAD],
  [IPC_CHANNELS.containers.list, LIST_PAYLOAD],
  [IPC_CHANNELS.containers.trash, NO_PAYLOAD],
  [IPC_CHANNELS.containers.hosts, NO_PAYLOAD],
  [IPC_CHANNELS.containers.hostAdd, objectSchema({ name: 'id', target: 'id', identityFile: 'id', controllerHost: 'optionalString', controllerCaPath: 'optionalString', seccompProfilePath: 'optionalString', image: 'optionalString', ipv6Interface: 'optionalString', ipv6Prefix: 'optionalString', ipv6Driver: 'optionalString' })],
  [IPC_CHANNELS.containers.hostUpdate, objectSchema({ hostId: 'id', name: 'id', target: 'id', identityFile: 'optionalString', controllerHost: 'optionalString', controllerCaPath: 'optionalString', seccompProfilePath: 'optionalString', image: 'optionalString', ipv6Interface: 'optionalString', ipv6Prefix: 'optionalString', ipv6Driver: 'optionalString' })],
  [IPC_CHANNELS.containers.hostCheck, objectSchema({ hostId: 'id' })],
  [IPC_CHANNELS.containers.hostRepair, objectSchema({ hostId: 'id' })],
  [IPC_CHANNELS.containers.hostTrash, objectSchema({ hostId: 'id' })],
  [IPC_CHANNELS.containers.hostRestore, objectSchema({ hostId: 'id' })],
  [IPC_CHANNELS.containers.hostPurge, objectSchema({ hostId: 'id' })],
  [IPC_CHANNELS.containers.add, objectSchema({ name: 'id', image: 'optionalString', host: 'optionalString', deviceId: 'optionalString', runtime: 'optionalObject' })],
  [IPC_CHANNELS.containers.start, objectSchema({ containerId: 'id' })],
  [IPC_CHANNELS.containers.stop, objectSchema({ containerId: 'id' })],
  [IPC_CHANNELS.containers.restart, objectSchema({ containerId: 'id' })],
  [IPC_CHANNELS.containers.refresh, objectSchema({ containerId: 'id' })],
  [IPC_CHANNELS.containers.updateNetwork, objectSchema({ containerId: 'id', ipv4Enabled: 'optionalBoolean', ipv6Enabled: 'optionalBoolean', ipv6Suffix: 'optionalString' })],
  [IPC_CHANNELS.containers.duplicate, objectSchema({ containerId: 'id', name: 'optionalString' })],
  [IPC_CHANNELS.containers.delete, objectSchema({ containerId: 'id' })],
  [IPC_CHANNELS.containers.restore, objectSchema({ containerId: 'id' })],
  [IPC_CHANNELS.containers.purge, objectSchema({ containerId: 'id' })],
  [IPC_CHANNELS.groups.list, LIST_PAYLOAD],
  [IPC_CHANNELS.groups.create, objectSchema({ name: 'id', deviceIds: 'optionalIdArray' })],
  [IPC_CHANNELS.groups.update, objectSchema({ groupId: 'id', name: 'optionalString' })],
  [IPC_CHANNELS.groups.delete, objectSchema({ groupId: 'id' })],
  [IPC_CHANNELS.groups.addDevice, objectSchema({ groupId: 'id', deviceId: 'id' })],
  [IPC_CHANNELS.groups.removeDevice, objectSchema({ groupId: 'id', deviceId: 'id' })],
  [IPC_CHANNELS.workflows.list, LIST_PAYLOAD],
  [IPC_CHANNELS.workflows.get, objectSchema({ workflowId: 'id' })],
  [IPC_CHANNELS.workflows.import, objectSchema({ workflow: 'object', deadline: 'deadline' })],
  [IPC_CHANNELS.workflows.originPreview, objectSchema({ deviceId: 'id' })],
  [IPC_CHANNELS.workflows.originPull, objectSchema({ deviceId: 'id', conflictPolicy: 'optionalString' })],
  [IPC_CHANNELS.workflows.graphGet, objectSchema({ workflowId: 'id', revision: 'positiveInteger' })],
  [IPC_CHANNELS.workflows.graphPreview, objectSchema({ workflowId: 'id', revision: 'positiveInteger', operations: 'optionalArray' })],
  [IPC_CHANNELS.workflows.graphSave, objectSchema({ workflowId: 'id', revision: 'positiveInteger', operations: 'optionalArray' })],
  [IPC_CHANNELS.jobs.list, LIST_PAYLOAD],
  [IPC_CHANNELS.jobs.get, objectSchema({ jobId: 'id' })],
  [IPC_CHANNELS.jobs.events, objectSchema({ jobId: 'id', limit: 'limit' })],
  [IPC_CHANNELS.jobs.dispatch, objectSchema({ deviceId: 'id', workflowId: 'id', revision: 'positiveInteger', inputs: 'optionalObject', deadlineSeconds: 'optionalPositiveInteger' })],
  [IPC_CHANNELS.jobs.groupedPreview, objectSchema({ workflowId: 'id', revision: 'positiveInteger', deviceIds: 'optionalIdArray', text: 'optionalString', mode: 'optionalString', broadcastSingleRow: 'optionalBoolean', deadlineSeconds: 'optionalPositiveInteger' })],
  [IPC_CHANNELS.jobs.groupedDispatch, objectSchema({ workflowId: 'id', revision: 'positiveInteger', deviceIds: 'optionalIdArray', text: 'optionalString', mode: 'optionalString', broadcastSingleRow: 'optionalBoolean', deadlineSeconds: 'optionalPositiveInteger' })],
  [IPC_CHANNELS.jobs.cancel, objectSchema({ jobId: 'id' })],
  [IPC_CHANNELS.dialog.importDevice, NO_PAYLOAD],
  [IPC_CHANNELS.dialog.importWorkflow, NO_PAYLOAD],
  [IPC_CHANNELS.events.invalidation, NO_PAYLOAD],
]);

export function assertKnownChannel(channel) {
  if (!CHANNEL_SCHEMAS.has(channel)) {
    throw createIpcContractError('ERR_IPC_UNKNOWN_CHANNEL', 'Unknown IPC channel');
  }
  return channel;
}

export function validateIpcPayload(channel, payload) {
  const schema = CHANNEL_SCHEMAS.get(channel);
  if (!schema) {
    throw createIpcContractError('ERR_IPC_UNKNOWN_CHANNEL', 'Unknown IPC channel');
  }

  validatePayloadSize(payload);
  assertNoDangerousKeys(payload);

  if (schema.kind === 'none') {
    if (payload === undefined || payload === null) return {};
    if (isPlainObject(payload) && Reflect.ownKeys(payload).length === 0) return {};
    throw createIpcContractError('ERR_IPC_UNEXPECTED_PAYLOAD', 'Channel does not accept payload data');
  }

  if (!isPlainObject(payload)) {
    throw createIpcContractError('ERR_IPC_INVALID_PAYLOAD', 'IPC payload must be an object');
  }

  const allowedProperties = Object.keys(schema.properties);
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key === 'symbol' || !allowedProperties.includes(key)) {
      throw createIpcContractError('ERR_IPC_UNKNOWN_PROPERTY', 'IPC payload contains an unknown property');
    }
  }

  const clone = {};
  for (const [key, rule] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(payload, key)) continue;
    clone[key] = sanitizeValue(key, payload[key], rule);
  }
  return clone;
}

function objectSchema(properties) {
  return Object.freeze({ kind: 'object', properties: Object.freeze({ ...properties }) });
}

function sanitizeValue(key, value, rule) {
  if (rule === 'id') return sanitizeRequiredId(key, value);
  if (rule === 'limit') return sanitizeLimit(value);
  if (rule === 'deadline') return sanitizeDeadline(value);
  if (rule === 'positiveInteger') return sanitizePositiveInteger(key, value, { optional: false });
  if (rule === 'optionalPositiveInteger') return sanitizePositiveInteger(key, value, { optional: true });
  if (rule === 'object') return sanitizeRequiredObject(key, value);
  if (rule === 'optionalObject') return sanitizeOptionalObject(key, value);
  if (rule === 'optionalArray') return sanitizeOptionalArray(key, value);
  if (rule === 'optionalString') return sanitizeOptionalString(key, value);
  if (rule === 'optionalBoolean') return sanitizeOptionalBoolean(key, value);
  if (rule === 'optionalIdArray') return sanitizeOptionalIdArray(key, value);
  throw createIpcContractError('ERR_IPC_SCHEMA', 'Unsupported IPC payload schema rule');
}

function sanitizeRequiredId(key, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createIpcContractError('ERR_IPC_INVALID_ID', `Invalid ${key}`);
  }
  return value;
}

function sanitizeLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw createIpcContractError('ERR_IPC_INVALID_LIMIT', 'Invalid list limit');
  }
  return value;
}

function sanitizeDeadline(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))) return value;
  throw createIpcContractError('ERR_IPC_INVALID_DEADLINE', 'Invalid deadline');
}

function sanitizePositiveInteger(key, value, { optional }) {
  if (value === undefined && optional) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw createIpcContractError('ERR_IPC_INVALID_INTEGER', `Invalid ${key}`);
  }
  return value;
}

function sanitizeRequiredObject(key, value) {
  if (!isPlainObject(value)) {
    throw createIpcContractError('ERR_IPC_INVALID_PAYLOAD', `Invalid ${key}`);
  }
  return deepCloneJson(value);
}

function sanitizeOptionalObject(key, value) {
  if (value === undefined) return undefined;
  return sanitizeRequiredObject(key, value);
}

function sanitizeOptionalArray(key, value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw createIpcContractError('ERR_IPC_INVALID_PAYLOAD', `Invalid ${key}`);
  }
  return deepCloneJson(value);
}

function sanitizeOptionalString(key, value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw createIpcContractError('ERR_IPC_INVALID_PAYLOAD', `Invalid ${key}`);
  }
  return value;
}

function sanitizeOptionalBoolean(key, value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw createIpcContractError('ERR_IPC_INVALID_PAYLOAD', `Invalid ${key}`);
  }
  return value;
}

function sanitizeOptionalIdArray(key, value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw createIpcContractError('ERR_IPC_INVALID_PAYLOAD', `Invalid ${key}`);
  }
  return value.map((item) => sanitizeRequiredId(key, item));
}

function validatePayloadSize(payload) {
  if (payload === undefined) return;
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw createIpcContractError('ERR_IPC_INVALID_PAYLOAD', 'IPC payload must be JSON serializable');
  }
  if (serialized === undefined) {
    throw createIpcContractError('ERR_IPC_INVALID_PAYLOAD', 'IPC payload must be JSON serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_IPC_PAYLOAD_BYTES) {
    throw createIpcContractError('ERR_IPC_PAYLOAD_TOO_LARGE', 'IPC payload exceeds maximum size');
  }
}

function assertNoDangerousKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && DANGEROUS_KEYS.has(key)) {
      throw createIpcContractError('ERR_IPC_DANGEROUS_KEY', 'IPC payload contains a dangerous key');
    }
    assertNoDangerousKeys(value[key]);
  }
}

function deepCloneJson(value) {
  assertNoDangerousKeys(value);
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createIpcContractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
