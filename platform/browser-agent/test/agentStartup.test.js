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

test('Agent-generated dispatch rejection uses the durable terminal path', async () => {
  const source = await fs.readFile(new URL('../src/agent.js', import.meta.url), 'utf8');
  const rejectionStart = source.indexOf("log('warn', 'agent', 'controller_dispatch_rejected'");
  const rejectionEnd = source.indexOf("controllerSession.on('cancel'", rejectionStart);
  const rejectionSource = source.slice(rejectionStart, rejectionEnd);
  assert(rejectionSource.includes('nativeBridge.handle({'));
  assert(rejectionSource.includes("type: 'execution.result'"));
  assert(!rejectionSource.includes('controllerSession.sendExecutionEvent'));
});
