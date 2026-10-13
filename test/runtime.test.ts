import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedNodeVersion } from '../src/runtime.js';

test('Node runtime gate accepts OpenClaw-supported Node 24 and 26 lines', () => {
  assert.equal(isSupportedNodeVersion('v24.15.9'), false);
  assert.equal(isSupportedNodeVersion('v24.16.0'), true);
  assert.equal(isSupportedNodeVersion('v24.21.0'), true);
  assert.equal(isSupportedNodeVersion('v25.9.0'), false);
  assert.equal(isSupportedNodeVersion('v26.0.9'), false);
  assert.equal(isSupportedNodeVersion('v26.1.0'), true);
  assert.equal(isSupportedNodeVersion('v26.7.0'), true);
  assert.equal(isSupportedNodeVersion('v27.0.0'), true);
  assert.equal(isSupportedNodeVersion('not-a-version'), false);
});
