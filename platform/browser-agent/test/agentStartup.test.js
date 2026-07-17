import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('controller WSS session starts only after browser and HTTP control are ready', async () => {
  const source = await fs.readFile(new URL('../src/agent.js', import.meta.url), 'utf8');
  const browserStart = source.indexOf('await supervisor.start()');
  const httpListening = source.indexOf("log('info', 'agent', 'http_listening'");
  const sessionStart = source.indexOf('controllerSession?.start()');

  assert.notEqual(browserStart, -1);
  assert.notEqual(httpListening, -1);
  assert.notEqual(sessionStart, -1);
  assert.ok(sessionStart > browserStart);
  assert.ok(sessionStart > httpListening);
});
