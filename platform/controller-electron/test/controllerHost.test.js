import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeControllerHost, requireControllerHost } from '../src/controllerHost.js';

test('Controller host validation accepts only URL-safe hostnames and IP literals', () => {
  const valid = new Map([
    ['controller.example', 'controller.example'],
    ['controller-1', 'controller-1'],
    ['127.0.0.1', '127.0.0.1'],
    ['[2001:db8::20]', '[2001:db8::20]'],
    ['  controller.example  ', 'controller.example'],
  ]);
  for (const [input, expected] of valid) assert.equal(normalizeControllerHost(input), expected, input);

  const invalid = [
    '127.0.0.1@attacker.example',
    'controller.example/path',
    'controller.example?token=x',
    'controller.example#fragment',
    'controller.example:9443',
    'wss://controller.example',
    '2001:db8::20',
    '999.999.999.999',
    '.controller.example',
    'controller.example.',
    'controller..example',
    '-controller.example',
    'controller_1.example',
    '[2001:db8::20]@attacker.example',
  ];
  for (const input of invalid) assert.equal(normalizeControllerHost(input), null, input);
  assert.throws(() => requireControllerHost('controller.example/path'), /Controller host is invalid/);
});
