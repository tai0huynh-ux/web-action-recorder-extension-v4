import { domainError, ERROR_CODES } from './errors.js';
import { normalizeIpv6Address, normalizeIpv6Prefix, normalizeManagedNetwork } from './networkConfig.js';

const STATUS = new Set(['created', 'starting', 'running', 'stopping', 'stopped', 'restarting', 'deleting', 'deleted', 'failed']);

export class ContainerRegistry {
  constructor({ store, audit, now, id }) {
    this.store = store;
    this.audit = audit;
    this.now = now;
    this.id = id;
  }

  listContainers() {
    return { containers: this.store.snapshot().managedContainers.map(publicContainer) };
  }

  getContainer(containerId) {
    return publicContainer(requireContainer(this.store.snapshot(), containerId));
  }

  createContainer(payload = {}) {
    const at = this.now();
    const item = {
      id: payload.containerId || this.id('container'),
      name: requiredName(payload.name),
      image: requiredName(payload.image || 'war-browser-agent:phase1'),
      deviceId: optionalString(payload.deviceId),
      status: 'created',
      desiredState: 'stopped',
      host: optionalString(payload.host),
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      lastError: null,
      resourceUsage: null,
      runtime: sanitizeRuntime(payload.runtime),
    };
    return this.store.update((state) => {
      state.managedContainers ||= [];
      if (state.managedContainers.some((container) => container.id === item.id)) throw domainError(ERROR_CODES.DUPLICATE_JOB, 'Container already exists', 409);
      state.managedContainers.push(item);
      this.audit.append(state, 'container.created', { containerId: item.id });
      return publicContainer(item);
    });
  }

  updateStatus(containerId, status, { desiredState, lastError = null, resourceUsage = null, runtime = null } = {}) {
    if (!STATUS.has(status)) throw domainError(ERROR_CODES.INVALID_TARGET, 'Unsupported container status', 400);
    return this.store.update((state) => {
      const item = requireContainer(state, containerId);
      item.status = status;
      if (desiredState) item.desiredState = desiredState;
      item.lastError = lastError ? String(lastError).slice(0, 500) : null;
      item.resourceUsage = resourceUsage ? sanitizeResourceUsage(resourceUsage) : item.resourceUsage;
      if (runtime) item.runtime = { ...item.runtime, ...sanitizeRuntime(runtime) };
      item.updatedAt = this.now();
      this.audit.append(state, 'container.status', { containerId, status });
      return publicContainer(item);
    });
  }

  duplicateContainer(containerId, payload = {}) {
    const source = requireContainer(this.store.snapshot(), containerId);
    return this.createContainer({
      name: payload.name || `${source.name} copy`,
      image: source.image,
      deviceId: payload.deviceId,
      host: source.host,
      runtime: payload.runtime || source.runtime,
    });
  }

  deleteContainer(containerId) {
    return this.store.update((state) => {
      const item = requireContainer(state, containerId);
      item.status = 'deleted';
      item.desiredState = 'deleted';
      item.deletedAt = this.now();
      item.updatedAt = item.deletedAt;
      this.audit.append(state, 'container.deleted', { containerId });
      return publicContainer(item);
    });
  }
}

function requireContainer(state, containerId) {
  const item = (state.managedContainers || []).find((container) => container.id === containerId);
  if (!item) throw domainError(ERROR_CODES.DEVICE_NOT_FOUND, 'Container not found', 404);
  return item;
}

function requiredName(value) {
  const text = String(value || '').trim();
  if (!text) throw domainError(ERROR_CODES.INVALID_TARGET, 'Container name is required', 400);
  if (text.length > 120) throw domainError(ERROR_CODES.INVALID_TARGET, 'Container name is too long', 400);
  return text;
}

function optionalString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, 240);
}

function sanitizeRuntime(runtime = {}) {
  let network;
  try {
    network = normalizeManagedNetwork(runtime);
  } catch (error) {
    throw domainError(ERROR_CODES.INVALID_TARGET, error.message, 400);
  }
  return {
    dockerName: optionalString(runtime.dockerName),
    networkMode: optionalString(runtime.networkMode || 'bridge'),
    nonRootUser: optionalString(runtime.nonRootUser || 'war'),
    privileged: false,
    ...network,
    ipv4Network: optionalString(runtime.ipv4Network),
    ipv6Prefix: normalizeOptionalIpv6Prefix(runtime.ipv6Prefix),
    ipv6Address: normalizeOptionalIpv6Address(runtime.ipv6Address),
    ipv6Network: optionalString(runtime.ipv6Network),
    ipv6Driver: ['bridge', 'macvlan'].includes(runtime.ipv6Driver) ? runtime.ipv6Driver : null,
    ipv6MacAddress: normalizeOptionalMacAddress(runtime.ipv6MacAddress),
    ipv6PrefixChanged: runtime.ipv6PrefixChanged === true,
  };
}

function normalizeOptionalIpv6Prefix(value) {
  if (!value) return null;
  try {
    return normalizeIpv6Prefix(value);
  } catch {
    throw domainError(ERROR_CODES.INVALID_TARGET, 'Managed container IPv6 prefix is invalid', 400);
  }
}

function normalizeOptionalIpv6Address(value) {
  if (!value) return null;
  try {
    return normalizeIpv6Address(value);
  } catch {
    throw domainError(ERROR_CODES.INVALID_TARGET, 'Managed container IPv6 address is invalid', 400);
  }
}

function normalizeOptionalMacAddress(value) {
  if (!value) return null;
  const text = String(value).toLowerCase();
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(text)) {
    throw domainError(ERROR_CODES.INVALID_TARGET, 'Managed container MAC address is invalid', 400);
  }
  return text;
}

function sanitizeResourceUsage(value = {}) {
  return {
    cpuPercent: Number.isFinite(value.cpuPercent) ? value.cpuPercent : null,
    memoryBytes: Number.isFinite(value.memoryBytes) ? value.memoryBytes : null,
    memoryLimitBytes: Number.isFinite(value.memoryLimitBytes) ? value.memoryLimitBytes : null,
  };
}

function publicContainer(container) {
  return structuredClone(container);
}
