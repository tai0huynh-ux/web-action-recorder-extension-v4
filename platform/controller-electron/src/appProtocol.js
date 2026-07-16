import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' });
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'";

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
