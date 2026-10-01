import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCopilotWaitTimeout } from '../src/index.js';

test('recognizes the SDK wait timeout shape', () => {
  assert.equal(
    isCopilotWaitTimeout(new Error('Timeout after 300000ms waiting for session.idle')),
    true,
  );
  assert.equal(isCopilotWaitTimeout(new Error('session.error: timeout')), false);
  assert.equal(isCopilotWaitTimeout(new Error('other error')), false);
});
