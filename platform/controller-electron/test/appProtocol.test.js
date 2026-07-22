import test from 'node:test';
import assert from 'node:assert/strict';
import { CSP, resolveRendererAsset } from '../src/appProtocol.js';
test('renderer protocol rejects traversal', () => { assert.throws(() => resolveRendererAsset('C:/renderer', 'war-controller://app/%2e%2e/x.js')); });
test('renderer protocol emits the strict controller CSP', () => {
  assert.equal(CSP, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'");
  assert.equal(CSP.includes('unsafe-inline'), false);
  assert.equal(CSP.includes('unsafe-eval'), false);
});
