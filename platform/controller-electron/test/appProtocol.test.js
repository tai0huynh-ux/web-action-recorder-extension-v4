import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRendererAsset } from '../src/appProtocol.js';
test('renderer protocol rejects traversal', () => { assert.throws(() => resolveRendererAsset('C:/renderer', 'war-controller://app/%2e%2e/x.js')); });
