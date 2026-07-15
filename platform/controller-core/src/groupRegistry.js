import { requireDevice } from './deviceRegistry.js';
import { domainError, ERROR_CODES } from './errors.js';

export class GroupRegistry {
  constructor({ store, audit, now, id }) {
    this.store = store;
    this.audit = audit;
    this.now = now;
    this.id = id;
  }

  createGroup(body) {
    return this.store.update((state) => {
      const group = { id: body.id || this.id('group'), name: body.name || 'Group', labels: body.labels || [], deviceIds: [], createdAt: this.now(), updatedAt: this.now() };
      state.groups.push(group);
      this.audit.append(state, 'group.created', { groupId: group.id });
      return structuredClone(group);
    });
  }

  updateGroup(groupId, body) {
    return this.store.update((state) => {
      const group = requireGroup(state, groupId);
      if (body.name !== undefined) group.name = body.name;
      if (body.labels !== undefined) group.labels = Array.isArray(body.labels) ? body.labels : [];
      group.updatedAt = this.now();
      return structuredClone(group);
    });
  }

  deleteGroup(groupId) {
    return this.store.update((state) => {
      requireGroup(state, groupId);
      state.groups = state.groups.filter((group) => group.id !== groupId);
      for (const device of state.devices) device.groupIds = (device.groupIds || []).filter((id) => id !== groupId);
      this.audit.append(state, 'group.deleted', { groupId });
      return { ok: true };
    });
  }

  addDevice(groupId, deviceId) {
    return this.store.update((state) => {
      const group = requireGroup(state, groupId);
      const device = requireDevice(state, deviceId);
      group.deviceIds ||= [];
      if (!group.deviceIds.includes(deviceId)) group.deviceIds.push(deviceId);
      device.groupIds ||= [];
      if (!device.groupIds.includes(groupId)) device.groupIds.push(groupId);
      group.updatedAt = this.now();
      this.audit.append(state, 'group.device_added', { groupId, deviceId });
      return structuredClone(group);
    });
  }

  removeDevice(groupId, deviceId) {
    return this.store.update((state) => {
      const group = requireGroup(state, groupId);
      group.deviceIds = (group.deviceIds || []).filter((id) => id !== deviceId);
      const device = state.devices.find((item) => item.id === deviceId);
      if (device) device.groupIds = (device.groupIds || []).filter((id) => id !== groupId);
      group.updatedAt = this.now();
      return structuredClone(group);
    });
  }

  listGroups() {
    return { groups: structuredClone(this.store.snapshot().groups || []) };
  }

  membershipSnapshot(groupId) {
    const state = this.store.snapshot();
    const group = requireGroup(state, groupId);
    const deviceIds = [...(group.deviceIds || [])].sort();
    return Object.freeze({ groupId, deviceIds });
  }
}

function requireGroup(state, groupId) {
  const group = (state.groups || []).find((item) => item.id === groupId);
  if (!group) throw domainError(ERROR_CODES.GROUP_NOT_FOUND, 'Group not found', 404);
  return group;
}
