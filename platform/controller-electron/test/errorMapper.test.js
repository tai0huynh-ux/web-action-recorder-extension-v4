import test from 'node:test';
import assert from 'node:assert/strict';
import { mapErrorToIpcResult, sanitizeErrorDetails } from '../src/errorMapper.js';

test('error mapper preserves known codes and IPC validation codes', () => {
  const error = new Error('Rejected');
  error.code = 'ERR_IPC_INVALID_LIMIT';
  const result = mapErrorToIpcResult(error);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ERR_IPC_INVALID_LIMIT');
  assert.equal(result.error.message, 'Invalid request');
});

test('error mapper never exposes raw known-error messages or details', () => {
  const secret = 'synthetic-ipc-secret';
  const error = new Error(`credential=${secret} C:\\private\\controller.key`);
  error.code = 'AUTH_DENIED';
  error.details = { callbackUrl: `https://controller.example/#access_token=${secret}` };

  const result = mapErrorToIpcResult(error);
  const encoded = JSON.stringify(result);

  assert.equal(result.error.code, 'AUTH_DENIED');
  assert.equal(result.error.message, 'Request denied');
  assert.equal(Object.hasOwn(result.error, 'details'), false);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('controller.key'), false);
});

test('error mapper converts unknown and malformed errors to internal errors', () => {
  assert.equal(mapErrorToIpcResult(new Error('boom')).error.code, 'INTERNAL_ERROR');
  assert.equal(mapErrorToIpcResult('boom').error.code, 'INTERNAL_ERROR');
  assert.equal(mapErrorToIpcResult(null).error.code, 'INTERNAL_ERROR');
  assert.equal(mapErrorToIpcResult(new Error('boom')).error.message, 'Internal application error');
});

test('error mapper omits arbitrary details containing stack, secrets, hashes, bearer tokens, and paths', () => {
  const error = new Error('Denied');
  error.code = 'AUTH_DENIED';
  const secret = 'synthetic-controller-credential';
  error.details = {
    stack: 'secret stack',
    Authorization: `Bearer ${secret}`,
    credential: secret,
    tokenHash: 'hash',
    credentialHash: 'hash',
    path: 'C:\\Users\\a\\secret\\key.pem',
    nested: { inputs: { password: secret } },
  };
  const result = mapErrorToIpcResult(error);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('secret stack'), false);
  assert.equal(encoded.includes('credentialHash":"hash'), false);
  assert.equal(encoded.includes('C:\\\\Users'), false);
  assert.equal(Object.hasOwn(result.error, 'details'), false);
});

test('error mapper fails closed for unknown codes and omits URL details', () => {
  const secret = 'synthetic-websocket-credential';
  const result = mapErrorToIpcResult({
    code: 'ERR_SESSION_FAILED',
    message: 'Session failed',
    details: {
      url: `wss://controller.example/session?credential=${secret}&device=controller`
    }
  });
  const encoded = JSON.stringify(result);
  assert.equal(result.error.code, 'INTERNAL_ERROR');
  assert.equal(encoded.includes(secret), false);
  assert.equal(Object.hasOwn(result.error, 'details'), false);
});

test('error detail sanitizer handles circular and oversized details', () => {
  const circular = { name: 'root' };
  circular.self = circular;
  assert.equal(sanitizeErrorDetails(circular).self, '[Circular]');
  const oversized = sanitizeErrorDetails({ value: 'x'.repeat(9000) });
  assert.deepEqual(oversized, { truncated: true });
});
