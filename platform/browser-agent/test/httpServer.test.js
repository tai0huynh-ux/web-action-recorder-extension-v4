import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHttpServer } from '../src/httpServer.js';
import { loadConfig } from '../src/config.js';
import { AgentError } from '../src/errors.js';

test('/health does not expose secret', async () => {
  const fixture = await startFixture({ WAR_AGENT_TOKEN: '123456789012345678901234' });
  const response = await fetch(`${fixture.baseUrl}/health`);
  const text = await response.text();
  fixture.server.close();
  assert.equal(response.status, 200);
  assert.doesNotMatch(text, /123456789012345678901234/);
});

test('/v1/control requires auth when token configured', async () => {
  const fixture = await startFixture({ WAR_AGENT_TOKEN: '123456789012345678901234' });
  const response = await fetch(`${fixture.baseUrl}/v1/control`, { method: 'POST', body: '{}' });
  fixture.server.close();
  assert.equal(response.status, 401);
});

test('payload too large is rejected', async () => {
  const fixture = await startFixture({ WAR_AGENT_MAX_BODY_BYTES: '1024' });
  const response = await fetch(`${fixture.baseUrl}/v1/control`, {
    method: 'POST',
    body: 'x'.repeat(2000)
  }).catch((error) => error);
  fixture.server.close();
  assert.ok(response instanceof Error || response.status === 413);
});

test('bad JSON returns structured error', async () => {
  const fixture = await startFixture();
  const response = await fetch(`${fixture.baseUrl}/v1/control`, { method: 'POST', body: '{bad' });
  const body = await response.json();
  fixture.server.close();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'invalid_json');
});

test('unknown route returns 404', async () => {
  const fixture = await startFixture();
  const response = await fetch(`${fixture.baseUrl}/missing`);
  fixture.server.close();
  assert.equal(response.status, 404);
});

test('CORS is not wildcard', async () => {
  const fixture = await startFixture();
  const response = await fetch(`${fixture.baseUrl}/health`);
  fixture.server.close();
  assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
});

test('production internal errors do not expose stack', async () => {
  const fixture = await startFixture({ NODE_ENV: 'production' }, {
    dispatch: async () => {
      throw new Error('stack-secret');
    }
  });
  const response = await fetch(`${fixture.baseUrl}/v1/control`, {
    method: 'POST',
    body: '{}'
  });
  const text = await response.text();
  fixture.server.close();
  assert.equal(response.status, 500);
  assert.doesNotMatch(text, /stack-secret|at /);
});

test('development Agent errors use the same fixed secret-free public envelope', async () => {
  const secret = 'synthetic-http-error-secret';
  const logs = [];
  const dispatcher = {
    dispatch: async () => {
      throw new AgentError('invalid_payload', `credential=${secret}`, 400, {
        callbackUrl: `https://controller.example/#access_token=${secret}`,
      });
    },
  };
  const fixture = await startFixture({}, dispatcher, undefined, (...args) => logs.push(args));
  const productionFixture = await startFixture({ NODE_ENV: 'production' }, dispatcher);
  const response = await fetch(`${fixture.baseUrl}/v1/control`, { method: 'POST', body: '{}' });
  const productionResponse = await fetch(`${productionFixture.baseUrl}/v1/control`, { method: 'POST', body: '{}' });
  const body = await response.json();
  const productionBody = await productionResponse.json();
  fixture.server.close();
  productionFixture.server.close();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'invalid_payload');
  assert.equal(body.error.message, 'Invalid request');
  assert.equal(Object.hasOwn(body.error, 'details'), false);
  assert.deepEqual(productionBody, body);
  assert.equal(JSON.stringify(body).includes(secret), false);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('loopback state responses redact URL fragments', async () => {
  const secret = 'synthetic-state-fragment-secret';
  const fixture = await startFixture({}, undefined, {
    getState: () => ({ browserState: 'running', extensionLoaded: true }),
    getBrowserState: async () => ({
      browserState: 'running',
      extensionLoaded: true,
      browser: { tabs: [{ id: 'tab-1', url: `https://example.test/?safe=1#access_token=${secret}` }] },
    }),
  });
  const response = await fetch(`${fixture.baseUrl}/v1/state`);
  const body = await response.json();
  fixture.server.close();

  const encoded = JSON.stringify(body);
  assert.equal(encoded.includes(secret), false);
  assert.equal(body.browser.tabs[0].url.includes('#'), false);
  assert.match(body.browser.tabs[0].url, /safe=1/);
});

test('loopback control responses redact URL fragments', async () => {
  const secret = 'synthetic-control-fragment-secret';
  const fixture = await startFixture({}, {
    dispatch: async () => ({ ok: true, url: `https://example.test/?safe=1#id_token=${secret}` }),
  });
  const response = await fetch(`${fixture.baseUrl}/v1/control`, { method: 'POST', body: '{}' });
  const body = await response.json();
  fixture.server.close();

  assert.equal(JSON.stringify(body).includes(secret), false);
  assert.equal(body.url.includes('#'), false);
  assert.match(body.url, /safe=1/);
});

test('remote state responses redact fragments and omit local profile paths', async () => {
  const secret = 'synthetic-remote-state-secret';
  const token = '123456789012345678901234';
  const fixture = await startFixture({
    WAR_AGENT_HOST: '0.0.0.0',
    WAR_AGENT_ALLOW_REMOTE: '1',
    WAR_AGENT_TOKEN: token,
    WAR_AGENT_ALLOW: '127.0.0.1',
  }, undefined, {
    getState: () => ({ browserState: 'running', extensionLoaded: true }),
    getBrowserState: async () => ({
      browserState: 'running',
      extensionLoaded: true,
      profileDir: '/private/chromium-profile',
      browser: { tabs: [{ id: 'tab-1', url: `https://example.test/#access_token=${secret}` }] },
    }),
  });
  const response = await fetch(`${fixture.baseUrl}/v1/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  fixture.server.close();

  const encoded = JSON.stringify(body);
  assert.equal(response.status, 200);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('chromium-profile'), false);
  assert.equal(body.browser.tabs[0].url.includes('#'), false);
});

async function startFixture(
  env = {},
  dispatcher = { dispatch: async () => ({ ok: true }) },
  supervisor = {
    getState: () => ({ browserState: 'running', extensionLoaded: true }),
    getBrowserState: async () => ({ browserState: 'running', extensionLoaded: true, browser: { tabs: [] } }),
  },
  log = () => {},
) {
  const config = loadConfig({ WAR_AUTO_START_BROWSER: '0', ...env }, process.cwd());
  const server = createHttpServer({
    config,
    identity: { deviceId: 'device-1' },
    version: '0.1.0',
    dispatcher,
    supervisor,
    log,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}
