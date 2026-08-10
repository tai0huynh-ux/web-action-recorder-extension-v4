import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserStateFromRemoteResult,
  connectionDescriptorForInteractiveDevice,
  interactiveConnectionDescriptor,
  isInteractiveRemoteDevice,
  normalizeRemoteSelection,
  normalizeOmniboxInput,
  normalizedBrowserTabs,
  pointForRemoteFrame,
  pollIntervalForFps,
  printableTextForKeyboardEvent,
  qualityForFps,
  remoteTargetsForAction,
  remoteModeForDevice,
  shortcutForKeyboardEvent,
} from '../renderer/remoteControl.js';

test('remote mode and interactive connection descriptor stay explicit', () => {
  const device = {
    deviceId: 'chrome-human',
    mode: 'interactive',
    interactive: { connection: { deepLink: 'moonlight://pair/chrome-human', host: '192.168.1.201', port: 47989 } },
  };
  assert.equal(remoteModeForDevice(device), 'interactive');
  assert.equal(isInteractiveRemoteDevice(device), true);
  assert.deepEqual(interactiveConnectionDescriptor(device), {
    deepLink: 'moonlight://pair/chrome-human',
    host: '192.168.1.201',
    port: 47989,
  });
  assert.deepEqual(connectionDescriptorForInteractiveDevice(device), interactiveConnectionDescriptor(device));
  assert.equal(remoteModeForDevice({ mode: 'managed' }), 'managed');
});

test('remote selection is stable, bounded, and limited to available devices', () => {
  assert.deepEqual(normalizeRemoteSelection(['b', 'a', 'b', 'missing'], ['a', 'b']), ['b', 'a']);
  assert.equal(normalizeRemoteSelection(Array.from({ length: 12 }, (_, index) => `d-${index}`), Array.from({ length: 12 }, (_, index) => `d-${index}`)).length, 8);
});

test('remote action targets active device unless synchronization is enabled', () => {
  assert.deepEqual(remoteTargetsForAction({ selectedDeviceIds: ['a', 'b'], activeDeviceId: 'b', synchronized: false }), ['b']);
  assert.deepEqual(remoteTargetsForAction({ selectedDeviceIds: ['a', 'b'], activeDeviceId: 'b', synchronized: true }), ['a', 'b']);
});

test('remote pointer coordinates map displayed image into Chromium viewport', () => {
  assert.deepEqual(pointForRemoteFrame({ clientX: 250, clientY: 150 }, { left: 50, top: 50, width: 400, height: 200 }, { width: 1280, height: 720 }), { x: 640, y: 360, space: 'viewport' });
});

test('remote keyboard maps required Chromium shortcuts and text input', () => {
  assert.equal(shortcutForKeyboardEvent({ key: 't', ctrlKey: true }), 'CTRL+T');
  assert.equal(shortcutForKeyboardEvent({ key: 'c', ctrlKey: true }), 'CTRL+C');
  assert.equal(shortcutForKeyboardEvent({ key: 'v', ctrlKey: true }), 'CTRL+V');
  assert.equal(shortcutForKeyboardEvent({ key: 't', ctrlKey: true, shiftKey: true }), 'CTRL+SHIFT+T');
  assert.equal(printableTextForKeyboardEvent({ key: 'x' }), 'x');
  assert.equal(printableTextForKeyboardEvent({ key: 'x', ctrlKey: true }), '');
});

test('remote frame pacing trades quality for refresh rate', () => {
  assert.equal(pollIntervalForFps(1), 1000);
  assert.equal(pollIntervalForFps(6), 167);
  assert.equal(qualityForFps(1), 55);
  assert.equal(qualityForFps(6), 35);
});

test('omnibox resolves addresses and searches without renderer navigation', () => {
  assert.equal(normalizeOmniboxInput('example.test/path'), 'https://example.test/path');
  assert.equal(normalizeOmniboxInput('https://example.test/path'), 'https://example.test/path');
  assert.equal(normalizeOmniboxInput('openai remote browser'), 'https://www.google.com/search?q=openai%20remote%20browser');
});

test('browser state unwraps the Controller target dispatcher envelope', () => {
  const browser = { activeTabId: 'tab-2', tabs: [{ id: 'tab-2', title: 'Example', url: 'https://example.test/' }] };
  const result = { ok: true, data: { targets: [{ deviceId: 'device-2', ok: true, result: { status: 'succeeded', result: { browser } } }] } };
  assert.equal(browserStateFromRemoteResult(result, 'device-2'), browser);
  assert.deepEqual(normalizedBrowserTabs(browser), [{ id: 'tab-2', title: 'Example', url: 'https://example.test/', active: true }]);
});
