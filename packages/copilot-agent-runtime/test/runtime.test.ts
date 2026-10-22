import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CopilotAgentRuntime,
  diffCopilotUsageMetrics,
  normalizeCopilotModelCallUsage,
  aggregateCopilotModelCallUsages,
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
    source: 'session-metrics',
    inputTokens: 400,
    outputTokens: 100,
    totalTokens: 500,
    totalPremiumRequestCost: 1,
    models: { gpt: { inputTokens: 300, outputTokens: 100, totalTokens: 400, totalNanoAiu: 40 } },
  });
});

test('normalizes provider usage events and aggregates per-model cache/reasoning metrics', () => {
  const first = normalizeCopilotModelCallUsage({
    model: 'gpt-5', inputTokens: 120, outputTokens: 30, cacheReadTokens: 20,
    cacheWriteTokens: 4, reasoningTokens: 8, cost: 0.5, duration: 900,
    timeToFirstTokenMs: 120, interTokenLatencyMs: 15,
  });
  const second = normalizeCopilotModelCallUsage({
    model: 'gpt-5', inputTokens: 80, outputTokens: 20, cacheReadTokens: 10,
    reasoningTokens: 3, cost: 0.25,
  });
  assert.equal(first?.totalTokens, 150);
  assert.equal(first?.cachedInputTokens, 20);
  assert.equal(first?.premiumRequestCost, 0.5);

  const usage = aggregateCopilotModelCallUsages([first!, second!]);
  assert.equal(usage?.source, 'provider-event');
  assert.equal(usage?.modelCalls, 2);
  assert.equal(usage?.inputTokens, 200);
  assert.equal(usage?.outputTokens, 50);
  assert.equal(usage?.totalTokens, 250);
  assert.equal(usage?.cachedInputTokens, 30);
  assert.equal(usage?.reasoningTokens, 11);
  assert.equal(usage?.totalPremiumRequestCost, 0.75);
  assert.equal(usage?.models?.['gpt-5']?.inputTokens, 200);
  assert.equal(usage?.models?.['gpt-5']?.cacheWriteTokens, 4);
});

test('captures per-call token usage and context occupancy, filling unreported fields from session metrics', async () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const emit = (event: { type: string; data?: unknown }) => {
    for (const handler of listeners.get(event.type) ?? []) handler(event);
    for (const handler of listeners.get('*') ?? []) handler(event);
  };
  const snapshots = [
    { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, totalNanoAiu: 50, totalPremiumRequestCost: 1 },
    { inputTokens: 1100, outputTokens: 230, totalTokens: 1330, totalNanoAiu: 80, totalPremiumRequestCost: 1.3 },
  ];
  let snapshotIndex = 0;
  const session = {
    usage: { getMetrics: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] },
    on: (typeOrHandler: string | ((event: unknown) => void), maybeHandler?: (event: unknown) => void) => {
      const type = typeof typeOrHandler === 'function' ? '*' : typeOrHandler;
      const handler = typeof typeOrHandler === 'function' ? typeOrHandler : maybeHandler!;
      const handlers = listeners.get(type) ?? new Set<(event: unknown) => void>();
      handlers.add(handler);
      listeners.set(type, handlers);
      return () => handlers.delete(handler);
    },
    sendAndWait: async () => {
      emit({
        type: 'assistant.usage',
        data: {
          model: 'gpt-5', inputTokens: 90, outputTokens: 20, cacheReadTokens: 30,
          cacheWriteTokens: 5, reasoningTokens: 7, cost: 0.2, duration: 450,
        },
      });
      emit({
        type: 'session.usage_info',
        data: { currentTokens: 2400, tokenLimit: 128000, messagesLength: 18 },
      });
      return { type: 'assistant.message', data: { content: 'done' } };
    },
    setModel: async () => undefined,
  } as unknown as CopilotSession;

  const runtime = new CopilotAgentRuntime();
  const result = await runtime.runTurn({
    turnId: 'turn-usage',
    lockKey: 'session-usage',
    session,
    prompt: 'hello',
    timeoutMs: 1000,
  });

  assert.equal(result.content, 'done');
  assert.equal(result.usage?.source, 'provider-event');
  assert.equal(result.usage?.inputTokens, 90);
  assert.equal(result.usage?.outputTokens, 20);
  assert.equal(result.usage?.totalTokens, 110);
  assert.equal(result.usage?.cachedInputTokens, 30);
  assert.equal(result.usage?.cacheWriteTokens, 5);
  assert.equal(result.usage?.reasoningTokens, 7);
  assert.equal(result.usage?.totalNanoAiu, 30);
  assert.equal(result.modelCallUsages?.length, 1);
  assert.equal(result.modelCallUsages?.[0]?.durationMs, 450);
  assert.equal(result.contextUsage?.currentTokens, 2400);
  assert.equal(result.contextUsage?.tokenLimit, 128000);
  assert.equal(result.contextUsage?.percent, 2);
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
    on: (typeOrHandler: string | ((event: unknown) => void), maybeHandler?: (event: unknown) => void) => {
      const type = typeof typeOrHandler === 'string' ? typeOrHandler : '*';
      const handler = typeof typeOrHandler === 'function' ? typeOrHandler : maybeHandler!;
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
      return () => handlers.delete(handler);
    },
    sendAndWait: () => new Promise(() => undefined),
    abort: async () => {
      for (const handler of listeners.get('session.idle') ?? []) handler({ type: 'session.idle' });
      for (const handler of listeners.get('*') ?? []) handler({ type: 'session.idle' });
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
