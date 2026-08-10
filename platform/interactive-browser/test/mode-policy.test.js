import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERACTIVE_MODE_DENIED, assertInteractiveCommandAllowed, evaluateInteractiveCommand, isInteractiveCommandAllowed } from '../mode-policy.mjs';

test('interactive mode permits health checks only', () => {
  for (const command of ['health', 'bridge.health', { type: 'status.health' }]) {
    assert.equal(isInteractiveCommandAllowed(command), true);
    assert.equal(evaluateInteractiveCommand(command).kind, 'health');
    assert.doesNotThrow(() => assertInteractiveCommandAllowed(command));
  }
});

test('interactive mode denies every effectful controller surface with typed error', () => {
  for (const command of ['dispatch', 'workflow.execute', 'input.click', 'capture.screenshot', 'clipboard.read', { action: 'browser.navigate' }]) {
    assert.deepEqual(evaluateInteractiveCommand(command), { allowed: false, code: INTERACTIVE_MODE_DENIED, kind: 'effectful' });
    assert.throws(() => assertInteractiveCommandAllowed(command), (error) => error.code === INTERACTIVE_MODE_DENIED);
  }
  assert.equal(isInteractiveCommandAllowed({ type: 'health', action: 'dispatch' }), false);
});
