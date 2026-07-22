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
