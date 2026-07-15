import test from 'node:test';
import assert from 'node:assert/strict';
import { runContainerSmoke } from './containerGate.js';

test('real Chromium headed container smoke', async () => {
  const result = await runContainerSmoke();
  assert.equal(result.initialHealth.extensionLoaded, true);
  assert.equal(result.persistence.deviceIdBefore, result.persistence.deviceIdAfterContainerRestart);
  assert.ok(result.persistence.markerSeenCount >= 2);
});
