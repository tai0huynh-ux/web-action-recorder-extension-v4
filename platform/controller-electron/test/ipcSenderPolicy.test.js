import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTrustedIpcSender } from '../src/ipcSenderPolicy.js';

test('sender policy accepts trusted main frame', () => {
  const { event, mainWindow } = trustedFixture('war-controller://app/');
  assert.equal(assertTrustedIpcSender(event, { mainWindow }), true);
});

test('sender policy accepts a registered remote window but not an unregistered window', () => {
  const remote = trustedFixture('war-controller://app/?view=remote');
  const main = trustedFixture('war-controller://app/');
  assert.equal(assertTrustedIpcSender(remote.event, { mainWindow: main.mainWindow, allowedWindows: new Set([remote.mainWindow]) }), true);
  assert.throws(() => assertTrustedIpcSender(remote.event, { mainWindow: main.mainWindow, allowedWindows: new Set() }), { code: 'AUTH_DENIED' });
});

test('sender policy rejects wrong schemes, hosts, and malformed URLs', () => {
  for (const url of ['https://app/', 'file:///index.html', 'data:text/html,x', 'war-controller://evil/', '::::']) {
    const { event, mainWindow } = trustedFixture(url);
    assert.throws(() => assertTrustedIpcSender(event, { mainWindow }), { code: 'AUTH_DENIED' });
  }
});

test('sender policy rejects iframe, different webContents, destroyed sender, devtools, and child paths', () => {
  {
    const { event, mainWindow } = trustedFixture('war-controller://app/');
    event.senderFrame = { url: 'war-controller://app/' };
    assert.throws(() => assertTrustedIpcSender(event, { mainWindow }), { code: 'AUTH_DENIED' });
  }
  {
    const { event, mainWindow } = trustedFixture('war-controller://app/');
    event.sender = { mainFrame: event.senderFrame, isDestroyed: () => false };
    assert.throws(() => assertTrustedIpcSender(event, { mainWindow }), { code: 'AUTH_DENIED' });
  }
  {
    const { event, mainWindow } = trustedFixture('war-controller://app/');
    event.sender.isDestroyed = () => true;
    assert.throws(() => assertTrustedIpcSender(event, { mainWindow }), { code: 'AUTH_DENIED' });
  }
  {
    const { event, mainWindow } = trustedFixture('devtools://devtools/bundled');
    assert.throws(() => assertTrustedIpcSender(event, { mainWindow }), { code: 'AUTH_DENIED' });
  }
  {
    const { event, mainWindow } = trustedFixture('war-controller://app/other.html');
    assert.throws(() => assertTrustedIpcSender(event, { mainWindow }), { code: 'AUTH_DENIED' });
  }
});

function trustedFixture(url) {
  const frame = { url };
  const webContents = { mainFrame: frame, isDestroyed: () => false };
  frame.top = frame;
  return { event: { sender: webContents, senderFrame: frame }, mainWindow: { webContents } };
}
