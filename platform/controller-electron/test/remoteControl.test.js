import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRemoteSelection,
  pointForRemoteFrame,
  pollIntervalForFps,
  printableTextForKeyboardEvent,
  qualityForFps,
  remoteTargetsForAction,
  shortcutForKeyboardEvent,
} from '../renderer/remoteControl.js';

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
