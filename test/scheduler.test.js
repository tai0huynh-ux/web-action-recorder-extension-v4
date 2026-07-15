import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssignments, leaseNextCommand, ackCommand, finishCommand } from '../companion/scheduler.js';

test('random pool without duplicate refuses too few records', () => {
  assert.throws(() => buildAssignments({
    devices: [{ id: 'a' }, { id: 'b' }],
    profileId: 'p',
    dataset: [{ value: 1 }],
    assignmentMode: 'random_pool',
    allowDuplicate: false
  }), /Not enough/);
});

test('per-device lease keeps commands isolated', () => {
  const state = { commands: [
    { id: 'a1', deviceId: 'a', type: 'run_profile', status: 'queued', attempt: 0, maxAttempts: 3, notBefore: new Date(0).toISOString() },
    { id: 'b1', deviceId: 'b', type: 'run_profile', status: 'queued', attempt: 0, maxAttempts: 3, notBefore: new Date(0).toISOString() }
  ], results: [] };
  const command = leaseNextCommand(state, 'b', 10000);
  assert.equal(command.id, 'b1');
  ackCommand(state, 'b', command.id, command.leaseId);
  const finished = finishCommand(state, 'b', command.id, command.leaseId, { ok: true });
  assert.equal(finished.status, 'succeeded');
  assert.equal(state.commands.find((item) => item.id === 'a1').status, 'queued');
});
