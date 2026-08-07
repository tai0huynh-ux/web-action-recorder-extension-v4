import { redactDiagnostic, redactUrl } from '../../diagnostics/src/redaction.js';

export { redactUrl };

const PUBLIC_AGENT_ERROR_CODES = new Set([
  'CLIPBOARD_VERIFY_FAILED',
  'artifact_not_found',
  'browser_not_running',
  'browser_profile_in_use',
  'browser_profile_lock_cleanup_failed',
  'browser_profile_lock_invalid',
  'browser_profile_lock_read_failed',
  'browser_stop_timeout',
  'command_aborted',
  'command_failed',
  'deadline_exceeded',
  'extension_not_loaded',
  'forbidden',
  'identity_invalid',
  'input_queue_overflow',
  'invalid_artifact',
  'invalid_config',
  'invalid_envelope',
  'invalid_internal_page',
  'invalid_json',
  'invalid_payload',
  'invalid_protocol',
  'invalid_response',
  'invalid_target',
  'invalid_timestamp',
  'invalid_url',
  'payload_too_large',
  'point_out_of_bounds',
  'remote_frame_too_large',
  'sandbox_status_unavailable',
  'screenshot_too_large',
  'semantic_timeout',
  'sensitive_log',
  'tab_not_found',
  'unauthorized',
  'unsupported_command',
  'wrong_device',
  'x11_command_failed',
  'x11_connect_failed',
  'x11_connect_timeout',
  'x11_disconnected',
  'x11_reconnect_limit',
  'x11_timeout',
  'x11_write_failed',
]);

export class AgentError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toPublicError(error) {
  if (error instanceof AgentError) {
    const code = PUBLIC_AGENT_ERROR_CODES.has(error.code) ? error.code : 'internal_error';
    return {
      error: {
        code,
        message: publicAgentErrorMessage(code),
      }
    };
  }
  return {
    error: {
      code: 'internal_error',
      message: 'Internal server error'
    }
  };
}

function publicAgentErrorMessage(code) {
  if (code === 'internal_error') return 'Internal server error';
  if (code === 'unauthorized') return 'Authorization is required';
  if (code === 'forbidden') return 'Request denied';
  if (code.endsWith('_not_found') || code === 'tab_not_found' || code === 'artifact_not_found') return 'Requested resource was not found';
  if (code.startsWith('invalid_') || code === 'wrong_device' || code === 'unsupported_command' || code === 'point_out_of_bounds' || code === 'sensitive_log') return 'Invalid request';
  if (code.includes('timeout') || code.includes('unavailable') || code.includes('not_running') || code.includes('disconnected')) return 'Requested service is unavailable';
  return 'Request rejected';
}

export function createLogger({ deviceId } = {}) {
  return function log(level, component, event, fields = {}) {
    const safeFields = redact(fields);
    const line = {
      timestamp: new Date().toISOString(),
      level,
      component,
      event,
      ...(deviceId ? { deviceId } : {}),
      ...safeFields
    };
    console.log(JSON.stringify(line));
  };
}

export function redact(value) {
  return redactDiagnostic(value);
}
