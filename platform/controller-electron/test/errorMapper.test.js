import test from 'node:test';
import assert from 'node:assert/strict';
import { mapErrorToIpcResult, sanitizeErrorDetails } from '../src/errorMapper.js';

test('error mapper preserves known codes and IPC validation codes', () => {
  const error = new Error('Rejected');
  error.code = 'ERR_IPC_INVALID_LIMIT';
  const result = mapErrorToIpcResult(error);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ERR_IPC_INVALID_LIMIT');
  assert.equal(result.error.message, 'Rejected');
});

test('error mapper converts unknown and malformed errors to internal errors', () => {
  assert.equal(mapErrorToIpcResult(new Error('boom')).error.code, 'INTERNAL_ERROR');
  assert.equal(mapErrorToIpcResult('boom').error.code, 'INTERNAL_ERROR');
  assert.equal(mapErrorToIpcResult(null).error.code, 'INTERNAL_ERROR');
  assert.equal(mapErrorToIpcResult(new Error('boom')).error.message, 'Internal application error');
});

test('error mapper removes stack, secrets, hashes, bearer tokens, and absolute paths', () => {
  const error = new Error('Denied');
  error.code = 'AUTH_DENIED';
  error.details = {
    stack: 'secret stack',
    Authorization: 'Bearer abc123',
    credential: 'secret',
    tokenHash: 'hash',
    credentialHash: 'hash',
    path: 'C:\\Users\\a\\secret\\key.pem',
    nested: { inputs: { password: 'secret' } },
  };
  const result = mapErrorToIpcResult(error);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('abc123'), false);
  assert.equal(encoded.includes('secret stack'), false);
  assert.equal(encoded.includes('credentialHash":"hash'), false);
  assert.equal(encoded.includes('C:\\\\Users'), false);
});

test('error detail sanitizer handles circular and oversized details', () => {
  const circular = { name: 'root' };
  circular.self = circular;
  assert.equal(sanitizeErrorDetails(circular).self, '[Circular]');
  const oversized = sanitizeErrorDetails({ value: 'x'.repeat(9000) });
  assert.deepEqual(oversized, { truncated: true });
});
