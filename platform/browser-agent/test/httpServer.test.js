import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHttpServer } from '../src/httpServer.js';
import { loadConfig } from '../src/config.js';

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

async function startFixture(env = {}, dispatcher = { dispatch: async () => ({ ok: true }) }) {
  const config = loadConfig({ WAR_AUTO_START_BROWSER: '0', ...env }, process.cwd());
  const server = createHttpServer({
    config,
    identity: { deviceId: 'device-1' },
    version: '0.1.0',
    dispatcher,
    supervisor: {
      getState: () => ({ browserState: 'running', extensionLoaded: true }),
      getBrowserState: async () => ({ browserState: 'running', extensionLoaded: true, browser: { tabs: [] } })
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}
