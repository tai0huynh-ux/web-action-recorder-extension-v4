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
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (/authorization|token|cookie|localstorage|password|secret/i.test(key)) {
      output[key] = '[REDACTED]';
    } else if (key === 'url' && typeof child === 'string') {
      output[key] = redactUrl(child);
    } else {
      output[key] = redact(child);
    }
  }
  return output;
}

export function redactUrl(raw) {
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return raw;
  }
}
