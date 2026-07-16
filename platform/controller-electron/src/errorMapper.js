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
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const known = code !== 'INTERNAL_ERROR';
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code,
      message: known ? String(error?.message || 'Request rejected') : 'Internal application error',
      details: sanitizeErrorDetails(error?.details ?? error),
    }),
  });
}

export function mapError(error) {
  return mapErrorToIpcResult(error);
}

export function sanitizeErrorDetails(details) {
  const seen = new WeakSet();
  const sanitized = sanitize(details, 0, seen);
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
      output[key] = '[Redacted]';
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
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [Redacted]');
}
