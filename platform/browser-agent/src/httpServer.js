import http from 'node:http';
import { AgentError, toPublicError } from './errors.js';
import { isLoopbackHost } from './config.js';

export function createHttpServer({ config, identity, supervisor, dispatcher, version, startedAt = Date.now(), log = () => {} }) {
  const production = config.nodeEnv === 'production';
  const server = http.createServer(async (req, res) => {
    try {
      setCommonHeaders(res);
      if (req.method === 'OPTIONS') return sendJson(res, 204, {});
      if (req.url === '/health' && req.method === 'GET') {
        const state = supervisor.getState();
        return sendJson(res, 200, {
          ok: state.browserState === 'running',
          status: state.browserState === 'running' ? 'ok' : 'degraded',
          version,
          deviceId: identity.deviceId,
          browserState: state.browserState,
          extensionLoaded: state.extensionLoaded,
          uptime: Math.floor((Date.now() - startedAt) / 1000)
        });
      }
      if (req.url === '/v1/state' && req.method === 'GET') {
        if (!isLoopbackHost(config.host)) requireAuth(req, config);
        return sendJson(res, 200, redactStateForClient({
          version,
          deviceId: identity.deviceId,
          ...(await supervisor.getBrowserState())
        }, !isLoopbackHost(config.host)));
      }
      if (req.url === '/v1/control' && req.method === 'POST') {
        requireAuth(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        const result = await dispatcher.dispatch(body);
        return sendJson(res, 200, redactStateForClient(result, !isLoopbackHost(config.host)));
      }
      return sendJson(res, 404, { error: { code: 'not_found', message: 'Route not found' } });
    } catch (error) {
      const status = error instanceof AgentError ? error.status : 500;
      log('error', 'httpServer', 'request_failed', { message: error.message, status });
      return sendJson(res, status, toPublicError(error, production));
    }
  });
  return server;
}

function redactStateForClient(value, remoteMode) {
  if (!remoteMode) return value;
  if (Array.isArray(value)) return value.map((item) => redactStateForClient(item, remoteMode));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'profileDir') continue;
    output[key] = redactStateForClient(child, remoteMode);
  }
  return output;
}

export function listen(server, config) {
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => resolve(server));
  });
}

function requireAuth(req, config) {
  if (isLoopbackHost(config.host) && !config.token) return;
  if (!isLoopbackHost(config.host)) {
    const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || '');
    if (!config.allow.includes(remoteAddress)) {
      throw new AgentError('forbidden', 'Remote address is not allowed', 403);
    }
  }
  const expected = `Bearer ${config.token}`;
  if (!config.token || req.headers.authorization !== expected) {
    throw new AgentError('unauthorized', 'Authorization is required', 401);
  }
}

function normalizeRemoteAddress(address) {
  if (address.startsWith('::ffff:')) return address.slice('::ffff:'.length);
  return address;
}

function setCommonHeaders(res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type');
  res.setHeader('access-control-allow-origin', 'null');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  if (status === 204) return res.end();
  res.end(JSON.stringify(body));
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new AgentError('payload_too_large', 'Request body is too large', 413));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new AgentError('invalid_json', 'Request body must be valid JSON'));
      }
    });
  });
}
