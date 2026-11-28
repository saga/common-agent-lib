import test from 'node:test';
import assert from 'node:assert/strict';
import { DreamingEngine, SqliteDreamingStore } from '../src/index.js';
import type { DreamingRuntime } from '../src/types.js';

test('personal explicit instruction flows into context and task outcome feedback', async () => {
  const store = new SqliteDreamingStore({ filename: ':memory:', embeddingProvider: false });
  try {
    const memory = await store.applyUserDirective({
      id: 'message:remember-payment-recovery',
      scope: 'person:alice',
      kind: 'remember',
      instruction: '支付恢复示例必须保留幂等键和持久化交易状态。',
      memoryType: 'constraint',
    });
    const context = await store.buildContext({
      scope: 'person:alice',
      task: 'Explain payment recovery retries and idempotency.',
      budget: { maxUnits: 8_000 },
    });
    const included = context.items.find((item) => item.id === memory.id);
    assert.ok(included, 'explicit instruction should be included in task context');
    assert.match(context.text, /幂等键/);
    assert.match(context.text, /持久化交易状态/);

    await store.recordContextFeedback({
      id: 'feedback:payment-recovery:memory',
      context,
      memoryId: memory.id,
      taskId: 'task:payment-recovery',
      outcome: 'useful',
    });
    const events = await store.loadFeedback({
      scope: 'person:alice',
      memoryIds: [memory.id],
      since: '2026-01-01T00:00:00.000Z',
      limit: 10,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.contextHash, context.hash);
    assert.equal(events[0]?.memoryRevision, included?.revision);
  } finally {
    await store.close();
  }
});

test('project memory is consolidated from source evidence and injected into a later task context', async () => {
  const store = new SqliteDreamingStore({ filename: ':memory:', embeddingProvider: false });
  const scope = 'project:payments';
  try {
    await store.putEvidence(scope, {
      ref: 'source:payment-recovery:v1',
      kind: 'design-document',
      content: 'Payment recovery requires an idempotency key and a durable transaction outcome check.',
    });
    await store.upsertMemory({
      id: 'memory:payment-recovery',
      scope,
      content: 'Payment retries use idempotency keys.',
      status: 'confirmed',
      importance: 0.9,
      sourceRefs: ['source:payment-recovery:v1'],
    });
    await store.appendExperience({
      id: 'experience:payment-recovery',
      scope,
      content: 'The payment recovery design must verify the durable transaction outcome before retrying.',
      createdAt: new Date().toISOString(),
      sourceRefs: ['source:payment-recovery:v1'],
    });

    const runtime: DreamingRuntime = {
      id: 'evaluation-runtime',
      async generate() {
        return {
          output: {
            proposals: [{
              id: 'proposal:payment-recovery:update',
              scope,
              operation: 'update',
              targetRecordIds: ['memory:payment-recovery'],
              proposedRecord: {
                id: 'memory:payment-recovery:proposed',
                scope,
                content: 'Payment recovery verifies the durable transaction outcome before retrying with the same idempotency key.',
                status: 'candidate',
                importance: 0.95,
                sourceRefs: ['source:payment-recovery:v1'],
              },
              rationale: 'The project source explicitly documents the durable outcome check.',
              evidenceRefs: ['source:payment-recovery:v1'],
            }],
            processedRecordIds: ['experience:payment-recovery'],
            reviewedMemoryIds: [],
          },
        };
      },
    };
    const engine = new DreamingEngine(runtime, store, store, { scopes: [scope] });
    const run = await engine.runNow(scope);
    assert.ok(run?.appliedProposalIds.includes('proposal:payment-recovery:update'));

    const memories = await store.listMemories(scope);
    const updated = memories.find((item) => item.id === 'memory:payment-recovery');
    assert.match(updated?.content ?? '', /durable transaction outcome/);
    assert.equal(updated?.status, 'confirmed');

    const context = await store.buildContext({
      scope,
      task: 'Review the payment recovery retry sequence and transaction outcome checks.',
      budget: { maxUnits: 8_000 },
    });
    assert.ok(context.items.some((item) => item.id === 'memory:payment-recovery'));
    assert.match(context.text, /durable transaction outcome/);
  } finally {
    await store.close();
  }
});
