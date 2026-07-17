import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('extension manifest grants clipboardWrite without clipboardRead', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.permissions.includes('clipboardWrite'), true);
  assert.equal(manifest.permissions.includes('clipboardRead'), false);
});

test('content script gates bounded copy to authorized controller jobs', () => {
  const source = fs.readFileSync(new URL('../src/content-script.js', import.meta.url), 'utf8');
  assert.match(source, /authorizedControllerJob/);
  assert.match(source, /startsWith\('controller-cmd-'\)/);
  assert.match(source, /COPY_SHORTCUT_REJECTED/);
  assert.match(source, /COPY_SELECTION_REQUIRED/);
  assert.match(source, /COPY_EXECUTION_FAILED/);
  assert.doesNotMatch(source, /CTRL\+V/);
  assert.doesNotMatch(source, /CTRL\+X/);
});

test('shared validation still rejects paste and cut shortcuts', async () => {
  const { validateProfile } = await import('../src/shared.js');
  assert.throws(() => validateProfile({ name: 'paste', steps: [{ id: 'paste', type: 'shortcut', keys: ['CTRL', 'V'] }] }), /Shortcut/);
  assert.throws(() => validateProfile({ name: 'cut', steps: [{ id: 'cut', type: 'shortcut', keys: ['CTRL', 'X'] }] }), /Shortcut/);
});
