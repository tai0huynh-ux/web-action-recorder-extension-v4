export const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({
  leftWidth: 280,
  centerWidth: 420,
  graphCollapsed: false,
});

export const WORKSPACE_SAMPLE_NODES = Object.freeze([
  { id: 'sample-switch', type: 'switchTab', title: 'switchTab', delay: 500, body: 'Google Hình ảnh', badge: '1 : group 1', x: 110, y: 54 },
  { id: 'sample-click', type: 'click', title: 'click', delay: 500, body: 'Selector', badge: '2 : group 1', x: 520, y: 280 },
  { id: 'sample-input', type: 'input', title: 'input', delay: 250, body: 'Input', badge: '3 : group 1', x: 190, y: 395 },
]);

export function createWorkspaceSelection() {
  return {
    selectedIds: new Set(),
    anchorId: null,
  };
}

export function reduceDeviceSelection(selection, devices, action) {
  const ids = devices.map((device) => device.id || device.deviceId).filter(Boolean);
  const next = {
    selectedIds: new Set(selection?.selectedIds || []),
    anchorId: selection?.anchorId || null,
  };
  if (action.type === 'clear') {
    next.selectedIds.clear();
    next.anchorId = null;
    return next;
  }
  if (action.type === 'selectAllVisible') {
    next.selectedIds = new Set(ids);
    next.anchorId = ids[0] || null;
    return next;
  }
  if (action.type === 'toggle') {
    if (next.selectedIds.has(action.id)) next.selectedIds.delete(action.id);
    else next.selectedIds.add(action.id);
    next.anchorId = action.id;
    return next;
  }
  if (action.type === 'range') {
    const anchorIndex = Math.max(0, ids.indexOf(next.anchorId));
    const targetIndex = ids.indexOf(action.id);
    if (targetIndex === -1) return next;
    const [start, end] = [anchorIndex, targetIndex].sort((a, b) => a - b);
    next.selectedIds = new Set(ids.slice(start, end + 1));
    return next;
  }
  if (action.type === 'single') {
    next.selectedIds = new Set([action.id]);
    next.anchorId = action.id;
  }
  return next;
}

export function clampWorkspaceLayout(layout = {}) {
  return {
    leftWidth: clamp(layout.leftWidth, 220, 380, DEFAULT_WORKSPACE_LAYOUT.leftWidth),
    centerWidth: clamp(layout.centerWidth, 320, 600, DEFAULT_WORKSPACE_LAYOUT.centerWidth),
    graphCollapsed: Boolean(layout.graphCollapsed),
  };
}

export function normalizeDeviceStatus(device = {}) {
  if (device.revoked || device.status === 'revoked') return 'revoked';
  if (device.status === 'online' || device.online === true) return 'online';
  if (device.status === 'offline' || device.online === false) return 'offline';
  if (device.status === 'connecting') return 'connecting';
  if (['creating', 'pairing', 'created', 'starting', 'running', 'stopping', 'stopped', 'restarting', 'deleting', 'deleted', 'failed', 'unauthorized', 'unavailable'].includes(device.status)) return device.status;
  return 'unknown';
}

export function selectedDevices(devices, selection) {
  return devices.filter((device) => selection.selectedIds.has(device.id || device.deviceId));
}

function clamp(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
