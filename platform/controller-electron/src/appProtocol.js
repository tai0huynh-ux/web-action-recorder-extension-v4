import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' });
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export function resolveRendererAsset(rendererRoot, requestUrl) {
  if (/%2e|%5c|%00/i.test(String(requestUrl))) throw new Error('Invalid renderer asset');
  const url = new URL(requestUrl);
  if (url.protocol !== 'war-controller:' || url.hostname !== 'app') throw new Error('Invalid renderer origin');
  const raw = decodeURIComponent(url.pathname);
  if (!raw || raw.includes('\\') || raw.includes('\0') || raw.split('/').includes('..')) throw new Error('Invalid renderer asset');
  const candidate = path.resolve(rendererRoot, `.${raw === '/' ? '/index.html' : raw}`);
  if (!candidate.startsWith(`${path.resolve(rendererRoot)}${path.sep}`)) throw new Error('Renderer traversal rejected');
  const mimeType = MIME[path.extname(candidate)];
  if (!mimeType) throw new Error('Renderer asset type rejected');
  return { path: candidate, mimeType, url: pathToFileURL(candidate).href };
}
