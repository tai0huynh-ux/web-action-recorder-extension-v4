import { AgentError } from './errors.js';

export const DEFAULT_LIMITS = Object.freeze({
  inputMaxQueue: 50,
  inputMaxTextLength: 4096,
  inputMaxDurationMs: 5000,
  inputMaxScrollDelta: 5000,
  semanticDefaultTimeoutMs: 5000,
  semanticMaxTimeoutMs: 30000,
  screenshotMaxBytes: 5 * 1024 * 1024
});

export const MOUSE_BUTTONS = new Set(['left', 'right', 'middle']);
export const KEY_ALLOWLIST = new Set([
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  'Backspace', 'Tab', 'Enter', 'Escape', 'Space', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Shift', 'Control', 'Alt', 'Meta',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
]);

export const SHORTCUT_ALLOWLIST = new Set([
  'CTRL+A',
  'CTRL+C',
  'CTRL+L',
  'CTRL+T',
  'CTRL+W',
  'CTRL+SHIFT+T',
  'ALT+LEFT',
  'ALT+RIGHT',
  'CTRL+R',
  'F5',
  'ESCAPE'
]);

export function limitsFromConfig(config = {}) {
  return {
    inputMaxQueue: config.inputMaxQueue ?? DEFAULT_LIMITS.inputMaxQueue,
    inputMaxTextLength: config.inputMaxTextLength ?? DEFAULT_LIMITS.inputMaxTextLength,
    inputMaxDurationMs: config.inputMaxDurationMs ?? DEFAULT_LIMITS.inputMaxDurationMs,
    inputMaxScrollDelta: config.inputMaxScrollDelta ?? DEFAULT_LIMITS.inputMaxScrollDelta,
    semanticDefaultTimeoutMs: config.semanticDefaultTimeoutMs ?? DEFAULT_LIMITS.semanticDefaultTimeoutMs,
    semanticMaxTimeoutMs: config.semanticMaxTimeoutMs ?? DEFAULT_LIMITS.semanticMaxTimeoutMs,
    screenshotMaxBytes: config.screenshotMaxBytes ?? DEFAULT_LIMITS.screenshotMaxBytes
  };
}

export function requireObject(value, name = 'value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentError('invalid_payload', `${name} must be an object`);
  }
  return value;
}

export function requireFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AgentError('invalid_payload', `${name} must be a finite number`);
  }
  return value;
}

export function requireInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AgentError('invalid_payload', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function requireString(value, name, { min = 1, max = 2048 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new AgentError('invalid_payload', `${name} length is invalid`);
  }
  return value;
}

export function validateTimeoutMs(value, limits) {
  const fallback = limits.semanticDefaultTimeoutMs;
  const timeout = value === undefined ? fallback : value;
  return requireInteger(timeout, 'timeoutMs', 100, limits.semanticMaxTimeoutMs);
}

export function validateButton(value = 'left') {
  if (!MOUSE_BUTTONS.has(value)) throw new AgentError('invalid_payload', 'button is invalid');
  return value;
}

export function validateClickCount(value = 1) {
  return requireInteger(value, 'clickCount', 1, 3);
}

export function validateKey(value) {
  requireString(value, 'key', { max: 32 });
  if (!KEY_ALLOWLIST.has(value)) throw new AgentError('invalid_payload', 'key is not allowed');
  return value;
}

export function validateShortcut(keys) {
  const normalized = normalizeShortcut(keys);
  if (!SHORTCUT_ALLOWLIST.has(normalized)) throw new AgentError('invalid_payload', 'shortcut is not allowed');
  return normalized;
}

export function normalizeShortcut(keys) {
  const list = Array.isArray(keys) ? keys : String(keys || '').split('+');
  if (!list.length || list.length > 4) throw new AgentError('invalid_payload', 'shortcut keys are invalid');
  const normalized = list.map((key) => String(key).trim().toUpperCase()).filter(Boolean);
  if (normalized.length !== list.length) throw new AgentError('invalid_payload', 'shortcut keys are invalid');
  return normalized.join('+');
}

export function assertNoSensitiveLog(payload) {
  const text = JSON.stringify(payload);
  if (/super-secret|typed secret|prompt secret/i.test(text)) {
    throw new AgentError('sensitive_log', 'Sensitive text reached a log payload');
  }
}
