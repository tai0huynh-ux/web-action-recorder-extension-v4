import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSecureWebPreferences } from '../src/secureWindow.js';
test('secure preferences are immutable and reject weakening', () => { const p = buildSecureWebPreferences(); assert.equal(p.sandbox, true); assert.equal(p.nodeIntegration, false); assert.throws(() => buildSecureWebPreferences({ nodeIntegration: true })); });
