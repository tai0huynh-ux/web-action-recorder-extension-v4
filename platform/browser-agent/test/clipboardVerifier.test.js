import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { compareX11Clipboard, readX11Clipboard } from '../src/clipboardVerifier.js';
import { startX11ClipboardPaste } from '../src/clipboardVerifier.js';

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
  assert.equal(calls[0].options.killSignal, 'SIGKILL', 'a reader that ignores SIGTERM must not outlive its command deadline');
  assert.equal(calls[0].options.maxBuffer, 4097);
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

test('clipboard selection reader permits the bounded 64 KiB remote-copy limit without exposing contents', async () => {
  const calls = [];
  const secret = 'synthetic clipboard secret';
  const value = await readX11Clipboard({
    maxBytes: 64 * 1024,
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, secret);
      return { stdin: { end() {} } };
    },
  });

  assert.equal(value, secret);
  assert.equal(calls[0].options.maxBuffer, (64 * 1024) + 1);
  assert.equal(JSON.stringify(calls[0]).includes(secret), false);
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

test('clipboard verifier rejects oversized and non-UTF-8 X11 data without exposing it', async () => {
  await assert.rejects(() => readX11Clipboard({
    maxBytes: 4,
    execFileImpl: (file, args, options, callback) => {
      callback(null, Buffer.from('oversized'));
      return { stdin: { end() {} } };
    }
  }), /exceeded limit/);
  await assert.rejects(() => readX11Clipboard({
    execFileImpl: (file, args, options, callback) => {
      callback(null, Buffer.from([0xc3, 0x28]));
      return { stdin: { end() {} } };
    }
  }), /valid UTF-8/);
});

test('one-shot X11 clipboard session accepts exactly 64 KiB and completes only after a selection request', async () => {
  const secret = 'x'.repeat(64 * 1024);
  const calls = [];
  const child = fakeSensitiveClipboardChild();
  const session = await startX11ClipboardPaste(secret, {
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      queueMicrotask(() => child.stderr.emit('data', Buffer.from('Waiting for selection requests')));
      return child;
    }
  });

  assert.deepEqual(calls, [{
    file: '/usr/local/bin/war-xclip-sensitive',
    args: ['-selection', 'clipboard', '-in', '-quiet', '-sensitive', '-wait', '250'],
    options: { env: { DISPLAY: ':99' }, stdio: ['pipe', 'ignore', 'pipe'] }
  }]);
  assert.equal(child.stdin.values.length, 1);
  assert.equal(Buffer.byteLength(child.stdin.values[0], 'utf8'), 64 * 1024);
  assert.equal(JSON.stringify(session).includes(secret), false);

  const completion = session.waitForPaste();
  child.emit('close', 0, null);
  assert.deepEqual(await completion, { written: true, bytes: 64 * 1024 });
  assert.equal(calls.length, 1, 'one-shot ownership must not rewrite an empty clipboard value');
  await assert.rejects(() => startX11ClipboardPaste(`${secret}x`), /limit|64 KiB|exceed/i);
});

test('one-shot X11 clipboard helper reports timeout and early exit without plaintext', async () => {
  const secret = 'helper failure must not expose this text';
  const timedOutChild = fakeSensitiveClipboardChild({ closeOnKill: true });
  const timeoutError = await startX11ClipboardPaste(secret, {
    timeoutMs: 1,
    spawnImpl: () => timedOutChild
  }).then(() => undefined, (error) => error);
  assert.equal(timeoutError?.code, 'CLIPBOARD_WRITE_FAILED');
  assert.equal(timeoutError?.message.includes(secret), false);

  const exitedChild = fakeSensitiveClipboardChild();
  const exitError = await startX11ClipboardPaste(secret, {
    spawnImpl: () => {
      queueMicrotask(() => exitedChild.emit('close', 1, null));
      return exitedChild;
    }
  }).then(() => undefined, (error) => error);
  assert.equal(exitError?.code, 'CLIPBOARD_WRITE_FAILED');
  assert.equal(exitError?.message.includes(secret), false);
});

test('one-shot clipboard helper force-settles a SIGTERM-ignoring child with SIGKILL without exposing plaintext', async () => {
  const secret = 'SIGTERM-resistant clipboard secret';
  const child = fakeSensitiveClipboardChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true; // Simulate a wedged helper that never emits close after either signal.
  };

  const outcome = await settleWithin(
    startX11ClipboardPaste(secret, {
      timeoutMs: 1,
      killGraceMs: 1,
      spawnImpl: () => child
    }).then(() => undefined, (error) => error),
    100
  );

  assert.notEqual(outcome, SETTLEMENT_TIMEOUT, 'clipboard helper timeout must not wait forever for close');
  assert.equal(outcome?.code, 'CLIPBOARD_WRITE_FAILED');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(String(outcome?.message || '').includes(secret), false);

  let replacementSpawned = false;
  const quarantined = await startX11ClipboardPaste('replacement must wait', {
    spawnImpl: () => { replacementSpawned = true; return fakeSensitiveClipboardChild({ closeOnKill: true }); }
  }).then(() => undefined, (error) => error);
  assert.equal(quarantined?.code, 'CLIPBOARD_WRITE_FAILED');
  assert.equal(replacementSpawned, false, 'a helper without close must quarantine later clipboard ownership');
  assert.equal(String(quarantined?.message || '').includes('replacement must wait'), false);

  child.emit('close', null, 'SIGKILL');
  const recoveredChild = fakeSensitiveClipboardChild({ closeOnKill: true });
  const recovered = await startX11ClipboardPaste('safe after late close', {
    spawnImpl: () => {
      queueMicrotask(() => recoveredChild.stderr.emit('data', Buffer.from('Waiting for selection requests')));
      return recoveredChild;
    }
  });
  await recovered.abort();
});

function fakeSensitiveClipboardChild({ closeOnKill = false } = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.values = [];
  child.stdin.end = (value) => { child.stdin.values.push(value); };
  child.kill = () => {
    if (closeOnKill) queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  return child;
}

const SETTLEMENT_TIMEOUT = Symbol('clipboard-settlement-timeout');

function settleWithin(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(SETTLEMENT_TIMEOUT), timeoutMs))
  ]);
}
