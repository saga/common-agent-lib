import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffCopilotUsageMetrics, isCopilotSessionNotFound, isCopilotWaitTimeout } from '../src/index.js';

test('recognizes the SDK wait timeout shape', () => {
  assert.equal(
    isCopilotWaitTimeout(new Error('Timeout after 300000ms waiting for session.idle')),
    true,
  );
  assert.equal(isCopilotWaitTimeout(new Error('session.error: timeout')), false);
  assert.equal(isCopilotWaitTimeout(new Error('other error')), false);
});

test('computes incremental Copilot usage from cumulative metrics', () => {
  const delta = diffCopilotUsageMetrics(
    {
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      totalPremiumRequestCost: 2.5,
      modelMetrics: {
        gpt: { usage: { inputTokens: 1000, outputTokens: 250 }, totalNanoAiu: 100 },
      },
    },
    {
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1000,
      totalPremiumRequestCost: 1.5,
      modelMetrics: {
        gpt: { usage: { inputTokens: 700, outputTokens: 150 }, totalNanoAiu: 60 },
      },
    },
  );

  assert.deepEqual(delta, {
    inputTokens: 400,
    outputTokens: 100,
    totalTokens: 500,
    totalPremiumRequestCost: 1,
    models: { gpt: { inputTokens: 300, outputTokens: 100, totalNanoAiu: 40 } },
  });
});

test('recognizes missing resumable Copilot sessions', () => {
  assert.equal(isCopilotSessionNotFound(new Error('Session not found: 123')), true);
  assert.equal(isCopilotSessionNotFound(new Error('permission denied')), false);
});