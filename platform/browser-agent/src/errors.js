import { redactDiagnostic, redactUrl } from '../../diagnostics/src/redaction.js';

export { redactUrl };

export class AgentError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toPublicError(error, production = false) {
  if (error instanceof AgentError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && !production ? { details: error.details } : {})
      }
    };
  }
  return {
    error: {
      code: 'internal_error',
      message: production ? 'Internal server error' : error?.message || 'Internal server error'
    }
  };
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
