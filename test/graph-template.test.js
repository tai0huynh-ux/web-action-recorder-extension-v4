import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLinksToSteps, findRootStepIds, validateGraph } from '../src/graph.js';
import { redactObject, resolveTemplate } from '../src/template.js';

test('graph validation catches dangling links and roots valid graphs', () => {
  const profile = { name: 'x', steps: [{ id: 'a', type: 'log', next: 'b' }, { id: 'b', type: 'log' }] };
  assert.deepEqual(findRootStepIds(profile.steps), ['a']);
  assert.equal(validateGraph(profile).ok, true);
  assert.match(validateGraph({ name: 'bad', steps: [{ id: 'a', type: 'log', next: 'missing' }] }).errors.join('\n'), /Dangling/);
});

test('root discovery handles linear and disconnected chains in profile order', () => {
  assert.deepEqual(findRootStepIds([{ id: 'a', type: 'log', next: 'b' }, { id: 'b', type: 'log' }]), ['a']);
  assert.deepEqual(findRootStepIds([
    { id: 'a', type: 'log', next: 'b' },
    { id: 'b', type: 'log' },
    { id: 'c', type: 'log', next: 'd' },
    { id: 'd', type: 'log' }
  ]), ['a', 'c']);
});

test('root discovery treats condition true and false branches as incoming links', () => {
  const steps = [
    { id: 'a', type: 'condition', condition: {}, ifSteps: ['b'], elseSteps: ['c'] },
    { id: 'b', type: 'log' },
    { id: 'c', type: 'log' }
  ];
  assert.deepEqual(findRootStepIds(steps), ['a']);
});

test('root discovery treats OR and IFS condition next links as incoming links', () => {
  const orSteps = [
    { id: 'a', type: 'OR', conditions: [{ next: 'b' }, { next: 'c' }] },
    { id: 'b', type: 'log' },
    { id: 'c', type: 'log' }
  ];
  const ifsSteps = [
    { id: 'a', type: 'IFS', conditions: [{ next: 'b' }, { next: 'c' }] },
    { id: 'b', type: 'log' },
    { id: 'c', type: 'log' }
  ];
  assert.deepEqual(findRootStepIds(orSteps), ['a']);
  assert.deepEqual(findRootStepIds(ifsSteps), ['a']);
});

test('root discovery returns disconnected nodes and rejects cycle-only graphs', () => {
  assert.deepEqual(findRootStepIds([{ id: 'a', type: 'log' }, { id: 'b', type: 'log' }]), ['a', 'b']);
  const profile = { name: 'cycle', steps: [{ id: 'a', type: 'log', next: 'b' }, { id: 'b', type: 'log', next: 'a' }] };
  const graph = validateGraph(profile);
  assert.deepEqual(findRootStepIds(profile.steps), []);
  assert.equal(graph.ok, false);
  assert.match(graph.errors.join('\n'), /Graph has no root step/);
  assert.match(graph.errors.join('\n'), /Cycle detected/);
});

test('links convert back into profile step fields', () => {
  const steps = [{ id: 'a', type: 'condition', condition: {}, ifSteps: [], elseSteps: [] }, { id: 'b', type: 'log' }];
  const next = applyLinksToSteps(steps, [{ from: 'a', fromPort: 'if-out', to: 'b', toPort: 'in' }]);
  assert.deepEqual(next[0].ifSteps, ['b']);
});

test('template resolver replaces inputs and redacts secrets', () => {
  assert.equal(resolveTemplate('hello {{name}}', { name: 'Thanh' }), 'hello Thanh');
  assert.throws(() => resolveTemplate('{{missing}}', {}), /Missing input/);
  assert.equal(redactObject({ apiToken: 'abc' }).apiToken, '[redacted]');
});
