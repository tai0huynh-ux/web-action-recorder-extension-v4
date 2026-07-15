import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchPayload, mapRowsToDevices, parseInputText } from '../src/inputParser.js';

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
