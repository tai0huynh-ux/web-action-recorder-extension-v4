import { redactDiagnostic, redactUrl } from '../../diagnostics/src/redaction.js';
import { ERROR_CODES } from '../../controller-core/src/errors.js';

const PUBLIC_ERROR_CODES = new Set([
  ...Object.values(ERROR_CODES),
  'CONTAINER_ADAPTER_UNAVAILABLE',
  'CONTAINER_HOST_ALREADY_EXISTS',
  'CONTAINER_HOST_IN_USE',
  'CONTAINER_HOST_MANAGER_UNAVAILABLE',
  'CONTAINER_HOST_NOT_FOUND',
  'CONTAINER_HOST_NOT_IN_TRASH',
  'CONTAINER_HOST_TARGET_EXISTS',
  'CONTAINER_HOST_UNAVAILABLE',
  'CONTAINER_NOT_IN_TRASH',
  'CONTAINER_NOT_RECONNECTABLE',
  'CONTAINER_NOT_REPAIRABLE',
  'CONTAINER_SCAN_UNAVAILABLE',
  'CONTROLLER_WSS_NOT_CONFIGURED',
  'DANGEROUS_WORKFLOW_INPUT',
  'DEADLINE_SECONDS_OUT_OF_RANGE',
  'DUPLICATE_GROUPED_DEVICE',
  'ERR_IPC_DANGEROUS_KEY',
  'ERR_IPC_INVALID_DEADLINE',
  'ERR_IPC_INVALID_ID',
  'ERR_IPC_INVALID_INTEGER',
  'ERR_IPC_INVALID_LIMIT',
  'ERR_IPC_INVALID_PAYLOAD',
  'ERR_IPC_PAYLOAD_TOO_LARGE',
  'ERR_IPC_SCHEMA',
  'ERR_IPC_UNEXPECTED_PAYLOAD',
  'ERR_IPC_UNKNOWN_CHANNEL',
  'ERR_IPC_UNKNOWN_PROPERTY',
  'GROUPED_INPUT_TOO_LARGE',
  'GROUPED_INPUT_TOO_MANY_ROWS',
  'INTERACTIVE_DESCRIPTOR_INVALID',
  'INTERACTIVE_DESCRIPTOR_REQUIRED',
  'INTERACTIVE_NOT_CONFIGURED',
  'HOST_PROVISIONING_REQUIRED',
  'IMPORT_INVALID',
  'IMPORT_REJECTED',
  'IMPORT_TOO_LARGE',
  'IMPORT_UNAVAILABLE',
  'INVALID_CONTAINER_HOST',
  'INVALID_DISPATCH_PAYLOAD',
  'INVALID_GRAPH_OPERATION',
  'INVALID_GRAPH_PAYLOAD',
  'INVALID_GROUPED_INPUT_MODE',
  'INVALID_GROUPED_INPUT_PAYLOAD',
  'INVALID_ORIGIN_SYNC_POLICY',
  'INVALID_WORKFLOW_INPUTS',
  'MISSING_WORKFLOW_INPUT',
  'ORIGIN_SYNC_UNAVAILABLE',
  'ORIGIN_WORKFLOW_GET_FAILED',
  'REMOTE_AGENT_UPDATE_FAILED',
  'REMOTE_AGENT_UPDATE_REQUIRED',
  'REMOTE_AGENT_UPDATE_TIMEOUT',
  'REMOTE_CAPTURE_FAILED',
  'REMOTE_COMMAND_NOT_ALLOWED',
  'REMOTE_CONTROL_FAILED',
  'REMOTE_CONTROL_UNAVAILABLE',
  'REMOTE_INVALID_PAYLOAD',
  'REMOTE_INVALID_QUALITY',
  'REMOTE_PAYLOAD_TOO_LARGE',
  'REMOTE_TARGET_LIMIT',
  'REMOTE_WINDOW_UNAVAILABLE',
  'SENSITIVE_INPUT_UNSUPPORTED',
  'SESSION_OFFLINE',
  'SSH_AUTH_FAILED',
  'SSH_CLIENT_MISSING',
  'SSH_DNS_FAILED',
  'SSH_HOST_COMMAND_FAILED',
  'SSH_HOST_REPAIR_INCOMPLETE',
  'SSH_HOST_REPAIR_VERIFY_FAILED',
  'SSH_IDENTITY_INVALID',
  'SSH_IDENTITY_NOT_FILE',
  'SSH_IDENTITY_NOT_READABLE',
  'SSH_REPAIR_COMMAND_FAILED',
  'SSH_SUDO_REQUIRED',
  'SSH_TIMEOUT',
  'SSH_UNREACHABLE',
  'UNKNOWN_WORKFLOW_INPUT',
  'WORKFLOW_GRAPH_INVALID',
  'WORKFLOW_GRAPH_NODE_NOT_FOUND',
  'WORKFLOW_INPUT_TOO_DEEP',
  'WORKFLOW_INPUT_TOO_LARGE',
  'WORKFLOW_INPUT_TYPE_MISMATCH',
  'WSS_CONFIGURATION_ERROR',
  'WSS_DISABLED',
  'WSS_NOT_RUNNING',
  'WSS_SEND_FAILED',
  'WSS_TLS_RELOAD_UNAVAILABLE',
]);

const SECRET_KEYS = new Set([
  'authorization',
  'pairingCode',
  'code',
  'credential',
  'credentials',
  'token',
  'tokenHash',
  'credentialHash',
  'privateKey',
  'keyPath',
  'env',
  'environment',
  'inputs',
  'stack',
  'cause',
]);
const MAX_DEPTH = 4;
const MAX_DETAILS_BYTES = 8192;

export function mapErrorToIpcResult(error) {
  const requestedCode = typeof error?.code === 'string' ? error.code : '';
  const code = PUBLIC_ERROR_CODES.has(requestedCode) ? requestedCode : 'INTERNAL_ERROR';
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code,
      message: publicErrorMessage(code),
    }),
  });
}

export function mapError(error) {
  return mapErrorToIpcResult(error);
}

function publicErrorMessage(code) {
  if (code === 'INTERNAL_ERROR') return 'Internal application error';
  if (code === 'AUTH_DENIED' || code === 'SSH_AUTH_FAILED') return 'Request denied';
  if (code.endsWith('_NOT_FOUND')) return 'Requested resource was not found';
  if (code.startsWith('ERR_IPC_') || code.startsWith('INVALID_') || code.includes('_INVALID') || code.startsWith('MISSING_') || code.startsWith('UNKNOWN_')) return 'Invalid request';
  if (code.includes('UNAVAILABLE') || code.includes('OFFLINE') || code.includes('NOT_CONFIGURED') || code.includes('UNREACHABLE') || code.includes('TIMEOUT')) return 'Requested service is unavailable';
  return 'Request rejected';
}

export function sanitizeErrorDetails(details) {
  const sanitized = redactDiagnostic(sanitize(details, 0, new WeakSet()));
  const encoded = JSON.stringify(sanitized);
  if (encoded && Buffer.byteLength(encoded, 'utf8') > MAX_DETAILS_BYTES) {
    return { truncated: true };
  }
  return sanitized;
}

function sanitize(value, depth, seen) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      code: typeof value.code === 'string' ? value.code : undefined,
      message: typeof value.code === 'string' ? redactString(value.message) : 'Internal application error',
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1, seen));
  }

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) {
      output[key] = '<redacted>';
    } else if (key.toLowerCase() === 'url' && typeof child === 'string') {
      output[key] = redactUrl(child);
    } else {
      output[key] = sanitize(child, depth + 1, seen);
    }
  }
  return output;
}

function isSecretKey(key) {
  const normalized = key.toLowerCase();
  return SECRET_KEYS.has(key) || SECRET_KEYS.has(normalized) || normalized.includes('credential') || normalized.includes('token');
}

function redactString(value) {
  return value
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, '[Path]')
    .replace(/\/(?:[^\s"'<>/]+\/)+[^\s"'<>]+/g, '[Path]')
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer <redacted>');
}
