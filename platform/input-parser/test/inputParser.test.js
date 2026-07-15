import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchPayload, mapFieldsToNamedInputs, mapRowsToDevices, parseInputText } from '../src/inputParser.js';

const devices = [{ id: 'dev-a' }, { id: 'dev-b' }];

test('parses pipe-separated fields', () => {
  assert.deepEqual(parseInputText('a|b|c').rows[0].fields, ['a', 'b', 'c']);
});

test('maps two rows to two devices', () => {
  const { rows } = parseInputText('a|b\nc|d');
  assert.deepEqual(mapRowsToDevices({ rows, devices, expectedFieldCount: 2 }), [
    { deviceId: 'dev-a', deviceIndex: 0, fields: ['a', 'b'], sourceRowIndex: 0 },
    { deviceId: 'dev-b', deviceIndex: 1, fields: ['c', 'd'], sourceRowIndex: 1 }
  ]);
});

test('broadcasts one row to multiple devices', () => {
  const { rows } = parseInputText('a|b');
  assert.deepEqual(mapRowsToDevices({ rows, devices, expectedFieldCount: 2 }), [
    { deviceId: 'dev-a', deviceIndex: 0, fields: ['a', 'b'], sourceRowIndex: 0 },
    { deviceId: 'dev-b', deviceIndex: 1, fields: ['a', 'b'], sourceRowIndex: 0 }
  ]);
});

test('keeps pipe inside quoted fields', () => {
  assert.deepEqual(parseInputText('"a|b"|c').rows[0].fields, ['a|b', 'c']);
});

test('keeps newlines inside quoted fields', () => {
  assert.deepEqual(parseInputText('"a\nb"|c').rows, [{ fields: ['a\nb', 'c'], sourceRowIndex: 0, startOffset: 0, startLine: 1 }]);
});

test('unescapes doubled quotes inside quoted fields', () => {
  assert.deepEqual(parseInputText('"a ""quote"""|b').rows[0].fields, ['a "quote"', 'b']);
});

test('returns structured error for unclosed quote', () => {
  assert.throws(() => parseInputText('"a|b'), (error) => error.code === 'UNCLOSED_QUOTE');
});

test('returns structured error for missing row', () => {
  assert.throws(
    () => mapRowsToDevices({ rows: parseInputText('a|b').rows, devices, expectedFieldCount: 2, broadcastSingleRow: false }),
    (error) => error.code === 'MISSING_ROW'
  );
});

test('returns structured error for extra row', () => {
  assert.throws(
    () => mapRowsToDevices({ rows: parseInputText('a\nb\nc').rows, devices, expectedFieldCount: 1 }),
    (error) => error.code === 'EXTRA_ROW'
  );
});

test('returns structured error for missing field', () => {
  assert.throws(
    () => mapRowsToDevices({ rows: parseInputText('a|b').rows, devices: [{ id: 'dev-a' }], expectedFieldCount: 3 }),
    (error) => error.code === 'MISSING_FIELD'
  );
});

test('returns structured error for extra field', () => {
  assert.throws(
    () => mapRowsToDevices({ rows: parseInputText('a|b|c').rows, devices: [{ id: 'dev-a' }], expectedFieldCount: 2 }),
    (error) => error.code === 'EXTRA_FIELD'
  );
});

test('preserves empty field between separators', () => {
  assert.deepEqual(parseInputText('a||c').rows[0].fields, ['a', '', 'c']);
});

test('supports quoted empty field', () => {
  assert.deepEqual(parseInputText('""|b').rows[0].fields, ['', 'b']);
});

test('preserves Vietnamese and Unicode characters', () => {
  assert.deepEqual(parseInputText('xin chào|東京|🙂').rows[0].fields, ['xin chào', '東京', '🙂']);
});

test('preview mapping and dispatch payload come from the same normalized result', () => {
  const { rows } = parseInputText('"a|b"|c');
  const preview = mapRowsToDevices({ rows, devices: [{ id: 'dev-a' }], expectedFieldCount: 2 });
  assert.deepEqual(preview, [{ deviceId: 'dev-a', deviceIndex: 0, fields: ['a|b', 'c'], sourceRowIndex: 0 }]);
  assert.deepEqual(createDispatchPayload(preview), [{ deviceId: 'dev-a', inputs: ['a|b', 'c'], sourceRowIndex: 0 }]);
});

test('returns structured error when no selected device exists', () => {
  assert.throws(
    () => mapRowsToDevices({ rows: parseInputText('a|b').rows, devices: [], expectedFieldCount: 2 }),
    (error) => error.code === 'NO_DEVICES'
  );
});

test('duplicate input name is rejected', () => {
  assert.throws(
    () => mapFieldsToNamedInputs(['alice'], [
      inputDefinition('account', 0),
      inputDefinition('account', 1)
    ]),
    (error) => error.code === 'DUPLICATE_INPUT_NAME'
  );
});

test('duplicate input index is rejected', () => {
  assert.throws(
    () => mapFieldsToNamedInputs(['alice'], [
      inputDefinition('account', 0),
      inputDefinition('password', 0, { sensitive: true })
    ]),
    (error) => error.code === 'DUPLICATE_INPUT_INDEX'
  );
});

test('field array maps to named input object by index', () => {
  assert.deepEqual(
    mapFieldsToNamedInputs(['alice@example.com', 'secret'], [
      inputDefinition('account', 0),
      inputDefinition('password', 1, { sensitive: true })
    ]),
    {
      account: 'alice@example.com',
      password: 'secret'
    }
  );
});

test('missing required field is rejected by named input mapper', () => {
  assert.throws(
    () => mapFieldsToNamedInputs(['alice@example.com'], [
      inputDefinition('account', 0),
      inputDefinition('password', 1, { sensitive: true })
    ]),
    (error) => error.code === 'MISSING_FIELD' && !JSON.stringify(error.details).includes('secret')
  );
});

test('extra field is rejected by named input mapper', () => {
  assert.throws(
    () => mapFieldsToNamedInputs(['alice@example.com', 'secret', 'extra'], [
      inputDefinition('account', 0),
      inputDefinition('password', 1, { sensitive: true })
    ]),
    (error) => error.code === 'EXTRA_FIELD'
  );
});

test('empty field is valid for named input mapper', () => {
  assert.deepEqual(
    mapFieldsToNamedInputs(['', 'secret'], [
      inputDefinition('account', 0),
      inputDefinition('password', 1, { sensitive: true })
    ]),
    {
      account: '',
      password: 'secret'
    }
  );
});

test('sensitive value does not appear in validation error details', () => {
  assert.throws(
    () => mapFieldsToNamedInputs(['secret-password'], [inputDefinition('password', 0, { sensitive: true, defaultValue: 'plaintext' })]),
    (error) => error.code === 'SENSITIVE_DEFAULT_VALUE' && !JSON.stringify(error).includes('secret-password') && !JSON.stringify(error).includes('plaintext')
  );
});

function inputDefinition(name, index, overrides = {}) {
  return {
    name,
    label: name,
    index,
    required: true,
    sensitive: false,
    ...overrides
  };
}
