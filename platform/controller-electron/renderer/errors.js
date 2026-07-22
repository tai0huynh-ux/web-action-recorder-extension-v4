const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,80}$/;
const MAX_ERROR_LENGTH = 300;

/**
 * Normalize Electron IPC failures before they reach the renderer. IPC errors
 * are deliberately nested so that the renderer must not stringify an object.
 */
export function controllerError(result, fallbackCode = 'ERROR') {
  const normalized = normalizeControllerError(result, fallbackCode);
  const error = new Error(normalized.message);
  error.code = normalized.code;
  if (normalized.details !== undefined) error.details = normalized.details;
  return error;
}

export function safeError(result, fallbackCode = 'ERROR') {
  const normalized = normalizeControllerError(result, fallbackCode);
  const detail = normalized.message;
  return (normalized.code === detail ? detail : `${normalized.code}: ${detail}`).slice(0, MAX_ERROR_LENGTH);
}

function normalizeControllerError(result, fallbackCode) {
  const visited = new Set();
  let value = result;
  let code = '';
  let message = '';
  let details;

  for (let depth = 0; depth < 6 && value !== undefined && value !== null; depth += 1) {
    if (typeof value === 'string') {
      if (!message) message = value;
      break;
    }
    if (value instanceof Error) {
      code ||= normalizeCode(value.code);
      message ||= normalizeMessage(value.message);
      details ??= value.details;
      break;
    }
    if (typeof value !== 'object') {
      if (!message) message = String(value);
      break;
    }
    if (visited.has(value)) break;
    visited.add(value);

    code ||= normalizeCode(value.code);
    if (!message && typeof value.message === 'string') message = normalizeMessage(value.message);
    if (details === undefined && value.details !== undefined) details = value.details;

    const nested = firstObject(value.error, value.data?.error, value.data?.operation, value.operation);
    if (nested) {
      value = nested;
      continue;
    }
    if (typeof value.error === 'string') {
      message ||= normalizeMessage(value.error);
      break;
    }
    if (!message && typeof value.data === 'string') message = normalizeMessage(value.data);
    break;
  }

  message = normalizeMessage(message) || 'Request failed';
  if (CODE_PATTERN.test(message) && !code) code = message;
  if (message === '[object Object]') message = 'Request failed';
  return { code: code || fallbackCode, message, details };
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object') || null;
}

function normalizeCode(value) {
  return typeof value === 'string' && CODE_PATTERN.test(value) ? value : '';
}

function normalizeMessage(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text && text !== '[object Object]' ? text : '';
}
