export class ControllerCoreError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'ControllerCoreError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const ERROR_CODES = Object.freeze({
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  WORKFLOW_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
  WORKFLOW_HASH_MISMATCH: 'WORKFLOW_HASH_MISMATCH',
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  INVALID_TARGET: 'INVALID_TARGET',
  DUPLICATE_JOB: 'DUPLICATE_JOB',
  JOB_TERMINAL: 'JOB_TERMINAL',
  JOB_EXPIRED: 'JOB_EXPIRED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  AUTH_DENIED: 'AUTH_DENIED',
  MANAGED_AGENT_CREDENTIAL_REQUIRED: 'MANAGED_AGENT_CREDENTIAL_REQUIRED',
  STORE_CORRUPT: 'STORE_CORRUPT',
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED'
});

export function domainError(code, message, status = statusForCode(code), details = undefined) {
  return new ControllerCoreError(code, message, status, details);
}

function statusForCode(code) {
  if (code === ERROR_CODES.AUTH_DENIED) return 401;
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code === ERROR_CODES.DEVICE_REVOKED || code === ERROR_CODES.JOB_TERMINAL || code === ERROR_CODES.MANAGED_AGENT_CREDENTIAL_REQUIRED) return 409;
  if (code === ERROR_CODES.CAPACITY_EXCEEDED) return 413;
  return 400;
}
