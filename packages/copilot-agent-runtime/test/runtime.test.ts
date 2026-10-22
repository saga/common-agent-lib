import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CopilotAgentRuntime,
  diffCopilotUsageMetrics,
  isCopilotSessionNotFound,
  isCopilotWaitTimeout,
  resumeOrCreateCopilotSession,
} from '../src/index.js';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';

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

test('resume-or-create only creates a session when the previous session is missing', async () => {
  let created = 0;
  const client = {
    resumeSession: async () => { throw new Error('Session not found: old-session'); },
    createSession: async () => { created += 1; return { sessionId: 'new-session' }; },
  } as unknown as CopilotClient;

  const result = await resumeOrCreateCopilotSession(client, 'old-session', {} as never);
  assert.equal(created, 1);
  assert.equal((result as unknown as { sessionId: string }).sessionId, 'new-session');
});

test('resume-or-create preserves non-missing-session errors', async () => {
  let created = 0;
  const client = {
    resumeSession: async () => { throw new Error('permission denied'); },
    createSession: async () => { created += 1; return {}; },
  } as unknown as CopilotClient;

  await assert.rejects(
    resumeOrCreateCopilotSession(client, 'session-1', {} as never),
    /permission denied/,
  );
  assert.equal(created, 0);
});

test('application watchdog aborts a stuck Copilot turn and waits for idle', async () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const session = {
    on: (type: string, handler: (event: unknown) => void) => {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
      return () => handlers.delete(handler);
    },
    sendAndWait: () => new Promise(() => undefined),
    abort: async () => {
      for (const handler of listeners.get('session.idle') ?? []) handler({ type: 'session.idle' });
    },
    setModel: async () => undefined,
  } as unknown as CopilotSession;

  const runtime = new CopilotAgentRuntime({ abortIdleGraceMs: 100 });
  await assert.rejects(
    runtime.runTurn({
      turnId: 'turn-timeout',
      lockKey: 'session-1',
      session,
      prompt: 'hang',
      timeoutMs: 10,
    }),
    /Timeout after 10ms waiting for session\.idle/,
  );
  assert.equal(runtime.activeTurnCount(), 0);
});
