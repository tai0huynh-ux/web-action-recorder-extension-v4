import test from 'node:test';
import assert from 'node:assert/strict';
import { compareX11Clipboard, readX11Clipboard } from '../src/clipboardVerifier.js';

test('clipboard verifier uses fixed xclip executable and clipboard args', async () => {
  const calls = [];
  const value = await readX11Clipboard({
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, 'synthetic');
      return { stdin: { end() {} } };
    }
  });
  assert.equal(value, 'synthetic');
  assert.equal(calls[0].file, '/usr/bin/xclip');
  assert.deepEqual(calls[0].args, ['-selection', 'clipboard', '-o']);
  assert.equal(calls[0].options.timeout, 1000);
  assert.equal(calls[0].options.maxBuffer, 4096);
});

test('clipboard verifier supports primary selection with fixed args', async () => {
  const calls = [];
  await readX11Clipboard({
    selection: 'primary',
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, '');
      return { stdin: { end() {} } };
    }
  });
  assert.deepEqual(calls[0].args, ['-selection', 'primary', '-o']);
});

test('clipboard verifier rejects unknown selection and redacts value from evidence', async () => {
  await assert.rejects(() => readX11Clipboard({ selection: 'secondary' }), /Unsupported X11 selection/);
  const evidence = await compareX11Clipboard('secret-value', {
    execFileImpl: (file, args, options, callback) => {
      callback(null, 'secret-value');
      return { stdin: { end() {} } };
    }
  });
  assert.deepEqual(evidence, { copied: true, expectedValueMatched: true });
  assert.equal(JSON.stringify(evidence).includes('secret-value'), false);
});

test('clipboard verifier reports sanitized failures', async () => {
  await assert.rejects(() => readX11Clipboard({
    execFileImpl: (file, args, options, callback) => {
      callback(Object.assign(new Error('secret clipboard text'), { killed: true }), '');
      return { stdin: { end() {} } };
    }
  }), /X11 clipboard read timed out/);
});
