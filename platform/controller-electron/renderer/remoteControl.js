const SHORTCUTS = new Set([
  'CTRL+A',
  'CTRL+C',
  'CTRL+L',
  'CTRL+T',
  'CTRL+V',
  'CTRL+W',
  'CTRL+R',
  'CTRL+SHIFT+T',
  'ALT+LEFT',
  'ALT+RIGHT',
  'F5',
  'ESCAPE',
]);

export function normalizeRemoteSelection(selectedDeviceIds, availableIds, limit = 8) {
  const available = new Set(availableIds || []);
  return [...new Set(selectedDeviceIds || [])].filter((id) => available.has(id)).slice(0, limit);
}

// Interactive Chrome is a distinct, human-only runtime. Keep mode detection
// tolerant of descriptors from older Controller/device payloads.
export function remoteModeForDevice(device) {
  const mode = device?.mode
    ?? device?.runtimeMode
    ?? device?.runtime?.mode
    ?? device?.capability?.mode
    ?? device?.capabilities?.mode
    ?? device?.metadata?.mode;
  return String(mode || 'managed').trim().toLowerCase() === 'interactive' ? 'interactive' : 'managed';
}

export function isInteractiveRemoteDevice(device) {
  return remoteModeForDevice(device) === 'interactive';
}

export function interactiveConnectionDescriptor(device) {
  const source = device?.connectionDescriptor
    ?? device?.interactiveConnection
    ?? device?.interactive?.connection
    ?? device?.sunshine
    ?? device?.connection
    ?? null;
  if (!source) return null;
  if (typeof source === 'string') return { deepLink: source };
  if (typeof source !== 'object') return null;
  const descriptor = {};
  for (const key of ['deepLink', 'uri', 'url', 'host', 'address', 'port', 'protocol', 'app', 'displayName', 'pairingCode']) {
    if (source[key] !== undefined && source[key] !== null && String(source[key]).trim()) descriptor[key] = source[key];
  }
  return Object.keys(descriptor).length ? descriptor : null;
}

// Alias kept explicit for callers that use the contract's terminology.
export const connectionDescriptorForInteractiveDevice = interactiveConnectionDescriptor;

export function remoteTargetsForAction({ selectedDeviceIds, activeDeviceId, synchronized }) {
  const selected = [...new Set(selectedDeviceIds || [])];
  if (synchronized) return selected;
  if (activeDeviceId && selected.includes(activeDeviceId)) return [activeDeviceId];
  return selected.length ? [selected[0]] : [];
}

export function pointForRemoteFrame(event, rect, frame) {
  const width = Number(frame?.width || 0);
  const height = Number(frame?.height || 0);
  if (!width || !height || !rect?.width || !rect?.height) return null;
  const x = clamp((Number(event.clientX) - rect.left) / rect.width, 0, 1) * width;
  const y = clamp((Number(event.clientY) - rect.top) / rect.height, 0, 1) * height;
  return { x: Math.round(x), y: Math.round(y), space: 'viewport' };
}

export function shortcutForKeyboardEvent(event) {
  const key = normalizeKey(event.key);
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('CTRL');
  if (event.shiftKey) parts.push('SHIFT');
  if (event.altKey) parts.push('ALT');
  if (!['CONTROL', 'SHIFT', 'ALT', 'META'].includes(key)) parts.push(key);
  const shortcut = parts.join('+');
  return SHORTCUTS.has(shortcut) ? shortcut : '';
}

export function printableTextForKeyboardEvent(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return '';
  return typeof event.key === 'string' && event.key.length === 1 ? event.key : '';
}

export function pollIntervalForFps(fps) {
  const normalized = Math.min(6, Math.max(1, Number(fps) || 3));
  return Math.round(1000 / normalized);
}

export function qualityForFps(fps) {
  const normalized = Math.min(6, Math.max(1, Number(fps) || 3));
  return normalized >= 5 ? 35 : normalized >= 3 ? 45 : 55;
}

export function normalizeOmniboxInput(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input;
  if (/^[^\s/]+\.[^\s/]+(?:\/[^\s]*)?$/i.test(input) || /^localhost(?::\d+)?(?:\/[^\s]*)?$/i.test(input)) {
    return 'https:' + '//' + input;
  }
  return 'https:' + '//www.google.com/search?q=' + encodeURIComponent(input);
}

export function browserStateFromRemoteResult(response, deviceId = '') {
  const data = response?.data ?? response;
  const targets = Array.isArray(data?.targets) ? data.targets : [];
  const target = targets.find((item) => item?.deviceId === deviceId) || data?.target || targets[0] || data;
  const candidates = [
    target?.result?.result?.browser,
    target?.result?.browser,
    target?.browser,
    data?.result?.result?.browser,
    data?.result?.browser,
    data?.browser,
  ];
  return candidates.find((browser) => browser && typeof browser === 'object') || null;
}

export function normalizedBrowserTabs(browser) {
  const tabs = Array.isArray(browser?.tabs) ? browser.tabs : [];
  return tabs
    .filter((tab) => tab && (tab.id || tab.targetId))
    .map((tab) => ({
      id: String(tab.id || tab.targetId),
      title: String(tab.title || tab.url || 'New tab'),
      url: String(tab.url || ''),
      active: tab.active === true || tab.id === browser?.activeTabId || tab.targetId === browser?.activeTabId,
    }));
}

function normalizeKey(key) {
  const value = String(key || '').toUpperCase();
  if (value === 'ARROWLEFT') return 'LEFT';
  if (value === 'ARROWRIGHT') return 'RIGHT';
  if (value === 'ESC') return 'ESCAPE';
  return value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
