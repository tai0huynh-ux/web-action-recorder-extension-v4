export const BRIDGE_STATES = Object.freeze({
  disconnected: 'disconnected',
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  incompatible: 'incompatible'
});

const PROTOCOL_VERSION = 'war-control.v2';
const MAX_PENDING = 64;

export class NativeBridgeClient {
  constructor({ chromeApi = globalThis.chrome, hostName, now = () => new Date().toISOString(), timeoutMs = 10000, maxPending = MAX_PENDING } = {}) {
    this.chrome = chromeApi;
    this.hostName = hostName;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.state = BRIDGE_STATES.disconnected;
    this.port = null;
    this.pending = new Map();
    this.backoffMs = 500;
  }

  connect() {
    if (this.state === BRIDGE_STATES.connected || this.state === BRIDGE_STATES.connecting) return;
    this.state = this.port ? BRIDGE_STATES.reconnecting : BRIDGE_STATES.connecting;
    try {
      this.port = this.chrome.runtime.connectNative(this.hostName);
      this.port.onMessage.addListener((message) => this.handleMessage(message));
      this.port.onDisconnect.addListener(() => this.handleDisconnect());
      this.state = BRIDGE_STATES.connected;
      this.backoffMs = 500;
    } catch (error) {
      this.state = BRIDGE_STATES.disconnected;
      this.rejectAll(error);
    }
  }

  disconnect() {
    this.port?.disconnect?.();
    this.port = null;
    this.state = BRIDGE_STATES.disconnected;
    this.rejectAll(new Error('Native bridge disconnected.'));
  }

  request(type, payload = {}, options = {}) {
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error('Native bridge pending request limit reached.'));
    if (this.state !== BRIDGE_STATES.connected) this.connect();
    if (!this.port) return Promise.reject(new Error('Native host is unavailable.'));
    const correlationId = options.correlationId || createId('corr');
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: createId('msg'),
      type,
      sentAt: this.now(),
      correlationId,
      ...(options.jobId ? { jobId: options.jobId } : {}),
      ...(options.deadline ? { deadline: options.deadline } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      payload
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`Native bridge request timed out: ${type}`));
      }, options.timeoutMs || this.timeoutMs);
      this.pending.set(correlationId, { resolve, reject, timer });
      this.port.postMessage(envelope);
    });
  }

  handleMessage(message) {
    if (message?.protocolVersion && message.protocolVersion !== PROTOCOL_VERSION) {
      this.state = BRIDGE_STATES.incompatible;
      this.rejectAll(new Error('Native bridge protocol mismatch.'));
      return;
    }
    const correlationId = message?.correlationId;
    const pending = this.pending.get(correlationId);
    if (!pending) return;
    this.pending.delete(correlationId);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  handleDisconnect() {
    this.port = null;
    this.state = BRIDGE_STATES.disconnected;
    const error = this.chrome.runtime.lastError?.message
      ? new Error(this.chrome.runtime.lastError.message)
      : new Error('Native bridge disconnected.');
    this.rejectAll(error);
  }

  rejectAll(error) {
    for (const [key, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(key);
    }
  }
}

export async function createWorkflowRevisionForBridge(profile, { sourceDeviceId = 'extension-local', revision = 1, now = new Date().toISOString() } = {}) {
  const profilePayload = sanitizeProfile(profile);
  const draft = {
    workflowId: profilePayload.id,
    revision,
    schemaVersion: 'war-workflow-revision.v2',
    name: profilePayload.name,
    description: profilePayload.description || '',
    createdAt: profilePayload.createdAt || now,
    updatedAt: now,
    sourceDeviceId,
    requiredInputs: inferInputDefinitions(profilePayload),
    profilePayload
  };
  return { ...draft, contentHash: await sha256Hex(stableStringify(stripHashFields(draft))) };
}

export async function syncWorkflowRevision(client, revision) {
  const deadline = new Date(Date.now() + 30000).toISOString();
  return client.request('workflow.upload', { revision }, {
    deadline,
    idempotencyKey: `${revision.workflowId}:${revision.contentHash}`,
    correlationId: createId('workflow')
  });
}

function sanitizeProfile(profile) {
  const clone = JSON.parse(JSON.stringify(profile || {}));
  deleteRuntimeKeys(clone);
  clone.id = typeof clone.id === 'string' && clone.id ? clone.id : 'workflow';
  clone.name = typeof clone.name === 'string' && clone.name ? clone.name : 'Untitled workflow';
  clone.schemaVersion = Number.isInteger(clone.schemaVersion) ? clone.schemaVersion : 1;
  clone.enabled = Boolean(clone.enabled);
  clone.allowHighRisk = Boolean(clone.allowHighRisk);
  clone.steps = Array.isArray(clone.steps) ? clone.steps.map((step) => redactSensitiveStep(step)) : [];
  return sortObject(clone);
}

function deleteRuntimeKeys(value) {
  if (Array.isArray(value)) return value.forEach(deleteRuntimeKeys);
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (/^(runtime|runId|runState|status|lastRunAt|lastError|isRoot)$/.test(key)) delete value[key];
    else deleteRuntimeKeys(value[key]);
  }
}

function redactSensitiveStep(step) {
  const next = { ...(step || {}) };
  if (next.type === 'type' && /password|passwd|token|secret|otp|pin/i.test(`${next.selector || ''} ${next.name || ''}`)) {
    delete next.text;
    next.requiresSecretPrompt = true;
  }
  return sortObject(next);
}

function inferInputDefinitions(profile) {
  const names = new Map();
  const add = (name, source = {}) => {
    if (!name || names.has(name)) return;
    const sensitive = Boolean(source.sensitive) || /password|passwd|token|secret|otp|pin/i.test(name);
    names.set(name, {
      name,
      label: source.label || String(name).replace(/[_.-]+/g, ' '),
      index: names.size,
      required: source.required !== false,
      sensitive,
      ...(!sensitive && source.defaultValue !== undefined ? { defaultValue: source.defaultValue } : {})
    });
  };
  for (const item of Array.isArray(profile.requiredInputs) ? profile.requiredInputs : []) {
    if (typeof item === 'string') add(item);
    else add(item.name, item);
  }
  const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  JSON.stringify(profile).replace(re, (_match, name) => {
    add(name);
    return '';
  });
  return [...names.values()];
}

function stripHashFields(value) {
  if (Array.isArray(value)) return value.map(stripHashFields);
  if (!value || typeof value !== 'object') return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (['contentHash', 'createdAt', 'updatedAt', 'revision', 'sourceDeviceId'].includes(key)) continue;
    next[key] = stripHashFields(child);
  }
  return sortObject(next);
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((next, key) => {
    next[key] = sortObject(value[key]);
    return next;
  }, {});
}

function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
