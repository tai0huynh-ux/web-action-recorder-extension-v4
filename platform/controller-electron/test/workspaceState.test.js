import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampWorkspaceLayout,
  createWorkspaceSelection,
  normalizeDeviceStatus,
  reduceDeviceSelection,
  selectedDevices,
} from '../renderer/workspaceState.js';

const devices = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('multi-selection reducer supports single, toggle, range, select all, and clear', () => {
  let selection = createWorkspaceSelection();
  selection = reduceDeviceSelection(selection, devices, { type: 'single', id: 'a' });
  assert.deepEqual([...selection.selectedIds], ['a']);
  selection = reduceDeviceSelection(selection, devices, { type: 'toggle', id: 'c' });
  assert.deepEqual([...selection.selectedIds].sort(), ['a', 'c']);
  selection = reduceDeviceSelection(selection, devices, { type: 'range', id: 'b' });
  assert.deepEqual([...selection.selectedIds], ['b', 'c']);
  selection = reduceDeviceSelection(selection, devices, { type: 'selectAllVisible' });
  assert.deepEqual([...selection.selectedIds], ['a', 'b', 'c']);
  selection = reduceDeviceSelection(selection, devices, { type: 'clear' });
  assert.equal(selection.selectedIds.size, 0);
});

test('selected devices come from renderer-only selection state', () => {
  const selection = reduceDeviceSelection(createWorkspaceSelection(), devices, { type: 'single', id: 'b' });
  assert.deepEqual(selectedDevices(devices, selection), [{ id: 'b' }]);
});

test('panel sizes are bounded and collapse state is explicit', () => {
  assert.deepEqual(clampWorkspaceLayout({ leftWidth: 100, centerWidth: 900, graphCollapsed: true }), {
    leftWidth: 220,
    centerWidth: 600,
    graphCollapsed: true,
  });
  assert.deepEqual(clampWorkspaceLayout({ leftWidth: 220, centerWidth: 600 }), {
    leftWidth: 220,
    centerWidth: 600,
    graphCollapsed: false,
  });
});

test('device statuses normalize to translated status keys', () => {
  assert.equal(normalizeDeviceStatus({ status: 'online' }), 'online');
  assert.equal(normalizeDeviceStatus({ status: 'offline' }), 'offline');
  assert.equal(normalizeDeviceStatus({ revoked: true }), 'revoked');
  assert.equal(normalizeDeviceStatus({ status: 'connecting' }), 'connecting');
  assert.equal(normalizeDeviceStatus({}), 'unknown');
});
