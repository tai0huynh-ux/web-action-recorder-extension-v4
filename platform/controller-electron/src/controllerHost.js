import { isIP } from 'node:net';

const HOST_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function normalizeControllerHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim();
  if (!host || host.length > 255 || /[\u0000-\u0020\u007f]/.test(host)) return null;

  if (host.startsWith('[') || host.endsWith(']')) {
    if (!host.startsWith('[') || !host.endsWith(']')) return null;
    return isIP(host.slice(1, -1)) === 6 ? host : null;
  }

  if (isIP(host) === 4) return host;
  if (isIP(host) !== 0 || /^[0-9.]+$/.test(host)) return null;

  const labels = host.split('.');
  if (!labels.length || labels.some((label) => !HOST_LABEL_RE.test(label))) return null;
  return host;
}

export function requireControllerHost(value) {
  const host = normalizeControllerHost(value);
  if (!host) throw new Error('Controller host is invalid');
  return host;
}
