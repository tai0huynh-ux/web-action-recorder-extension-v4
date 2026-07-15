import crypto from 'node:crypto';

export function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function timingEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function bearerToken(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

export function cleanIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

export function ipAllowed(ip, allowed = []) {
  return allowed.includes('*') || allowed.includes(cleanIp(ip));
}

export function requireLongToken(name, token) {
  if (String(token || '').length < 24) throw new Error(`${name} must have at least 24 characters`);
}
