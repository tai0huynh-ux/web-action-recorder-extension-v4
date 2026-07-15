import { domainError, ERROR_CODES } from './errors.js';

export class DeviceRegistry {
  constructor({ store, audit, now, id }) {
    this.store = store;
    this.audit = audit;
    this.now = now;
    this.id = id;
  }

  enrollDevice(body, { rawToken, tokenHash }) {
    const item = {
      id: body.deviceId || this.id('dev'),
      name: String(body.name || body.deviceName || 'Endpoint'),
      groupIds: Array.isArray(body.groupIds) ? [...body.groupIds] : [],
      labels: Array.isArray(body.labels) ? [...body.labels] : [],
      tokenHash,
      createdAt: this.now(),
      lastSeenAt: this.now(),
      status: 'online',
      extensionVersion: body.extensionVersion || '',
      browser: body.browser || '',
      capabilities: body.capabilities || {},
      profiles: []
    };
    return this.store.update((state) => {
      state.devices = state.devices.filter((device) => device.id !== item.id).concat(item);
      this.audit.append(state, 'device.enrolled', { deviceId: item.id });
      return { ...publicDevice(item), deviceToken: rawToken };
    });
  }

  registerDevice(deviceId, body) {
    return this.store.update((state) => {
      const item = requireDevice(state, deviceId);
      rejectRevoked(item);
      Object.assign(item, {
        name: String(body.name || item.name),
        groupIds: Array.isArray(body.groupIds) ? [...body.groupIds] : item.groupIds,
        labels: Array.isArray(body.labels) ? [...body.labels] : item.labels || [],
        extensionVersion: body.extensionVersion || item.extensionVersion,
        browser: body.browser || item.browser,
        profiles: Array.isArray(body.profiles) ? body.profiles : item.profiles,
        capabilities: body.capabilities || item.capabilities,
        lastSeenAt: this.now(),
        status: 'online'
      });
      return { ok: true };
    });
  }

  heartbeat(deviceId, body = {}) {
    return this.store.update((state) => {
      const item = requireDevice(state, deviceId);
      rejectRevoked(item);
      item.status = body.status || 'online';
      item.runState = body.runState || null;
      item.lastSeenAt = this.now();
      return { ok: true };
    });
  }

  listDevices() {
    return { devices: this.store.snapshot().devices.map(publicDevice) };
  }

  getDevice(deviceId) {
    return publicDevice(requireDevice(this.store.snapshot(), deviceId));
  }

  setStatus(deviceId, status) {
    return this.store.update((state) => {
      const item = requireDevice(state, deviceId);
      item.status = status;
      item.lastSeenAt = this.now();
      return publicDevice(item);
    });
  }

  revoke(deviceId) {
    return this.store.update((state) => {
      const item = requireDevice(state, deviceId);
      item.revoked = true;
      item.status = 'offline';
      item.revokedAt = this.now();
      this.audit.append(state, 'device.revoked', { deviceId });
      return publicDevice(item);
    });
  }

  ensureLegacyDevice(deviceId) {
    return this.store.update((state) => {
      if (!state.devices.some((device) => device.id === deviceId)) {
        state.devices.push({ id: deviceId, name: 'Legacy endpoint', tokenHash: '', createdAt: this.now(), lastSeenAt: null, status: 'unknown', profiles: [] });
      }
      return publicDevice(requireDevice(state, deviceId));
    });
  }
}

export function requireDevice(state, deviceId) {
  const device = state.devices.find((item) => item.id === deviceId);
  if (!device) throw domainError(ERROR_CODES.DEVICE_NOT_FOUND, 'Device not found', 404);
  return device;
}

export function rejectRevoked(device) {
  if (device.revoked) throw domainError(ERROR_CODES.DEVICE_REVOKED, 'Device is revoked', 409);
}

export function publicDevice(device) {
  const { tokenHash: _tokenHash, ...safe } = device;
  return structuredClone(safe);
}
