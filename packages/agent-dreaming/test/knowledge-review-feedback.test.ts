import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDreamingStore } from '../src/sqlite-store.js';
import { DreamingEngine } from '../src/engine.js';
import type { DreamingKnowledgePage, DreamingRuntime } from '../src/types.js';

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreaming-knowledge-review-'));
  const store = new SqliteDreamingStore({ filename: path.join(dir, 'db.sqlite'), embeddingProvider: false });
  return {
    store,
    close: async () => {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const evidence = {
  ref: 'evidence:payment',
  kind: 'document',
  content: 'Payment recovery uses idempotency keys and verifies durable transaction state before retrying.',
};

async function seedPage(store: SqliteDreamingStore): Promise<DreamingKnowledgePage> {
  await store.putEvidence('alice', evidence);
  return store.saveKnowledgePage({
    id: 'knowledge:payment-recovery',
    scope: 'alice',
    title: 'Payment recovery',
    summary: 'Safe recovery and retry behavior for payments.',
    content: 'Before retrying a payment, check its durable transaction state and reuse its idempotency key.',
    tags: ['payments', 'recovery'],
    sourceRefs: [evidence.ref],
  });
}

function makeRuntime(
  onGenerate: (prompt: string, call: number) => Record<string, unknown>,
): DreamingRuntime {
  let calls = 0;
  return {
    id: 'knowledge-review-test-runtime',
    async generate(request) {
      calls += 1;
      return { output: onGenerate(request.prompt, calls) };
    },
  };
}

function resultFor(pageId: string, reviewed = true): Record<string, unknown> {
  return {
    proposals: [],
    processedRecordIds: [],
    reviewedMemoryIds: [],
    reviewedKnowledgePageIds: reviewed ? [pageId] : [],
    knowledgeProposals: [],
  };
}

test('periodic Knowledge re-review runs without new experiences or memories and does not dirty the Memory Manifest', async () => {
  const x = setup();
  try {
    const page = await seedPage(x.store);
    const oldReview = new Date(Date.now() - 120 * 24 * 60 * 60_000).toISOString();
    await x.store.markKnowledgePagesReviewed({
      scope: 'alice', ids: [page.id], reviewedAt: oldReview,
    });
    const beforeManifest = await x.store.getMemoryManifest('alice');
    let calls = 0;
    const runtime = makeRuntime((_prompt, call) => {
      calls = call;
      return resultFor(page.id);
    });
    const engine = new DreamingEngine(runtime, x.store, x.store, {
      scopes: ['alice'],
      knowledgeReviewIntervalMs: 90 * 24 * 60 * 60_000,
    });

    const run = await engine.runNow('alice');
    const reviewed = await x.store.getKnowledgePage({ scope: 'alice', pageId: page.id });
    const afterManifest = await x.store.getMemoryManifest('alice');

    assert.equal(calls, 1);
    assert.equal(run?.status, 'completed');
    assert.deepEqual(run?.reviewedKnowledgePageIds, [page.id]);
    assert.ok(reviewed?.lastReviewedAt);
    assert.ok(Date.parse(reviewed.lastReviewedAt) > Date.parse(oldReview));
    assert.equal(afterManifest.version, beforeManifest.version);
    assert.equal(afterManifest.hash, beforeManifest.hash);

    await engine.runNow('alice');
    assert.equal(calls, 1, 'a recently reviewed page with no new signals should not trigger another model call');
  } finally {
    await x.close();
  }
});

test('two negative signals for the exact active page version trigger an early Knowledge review', async () => {
  const x = setup();
  try {
    const page = await seedPage(x.store);
    await x.store.markKnowledgePagesReviewed({
      scope: 'alice', ids: [page.id], reviewedAt: new Date().toISOString(),
    });
    const current = await x.store.getKnowledgePage({ scope: 'alice', pageId: page.id });
    assert.ok(current);
    const occurredAt = new Date().toISOString();
    await x.store.recordKnowledgeFeedback({
      id: 'knowledge-feedback:outdated',
      scope: 'alice',
      pageId: page.id,
      pageVersion: current.version,
      kind: 'user-correction',
      outcome: 'outdated',
      occurredAt,
    });
    await x.store.recordKnowledgeFeedback({
      id: 'knowledge-feedback:incorrect',
      scope: 'alice',
      pageId: page.id,
      pageVersion: current.version,
      kind: 'evidence',
      outcome: 'incorrect',
      occurredAt,
    });

    let prompt = '';
    let calls = 0;
    const runtime = makeRuntime((value, call) => {
      calls = call;
      prompt = value;
      return resultFor(page.id);
    });
    const engine = new DreamingEngine(runtime, x.store, x.store, {
      scopes: ['alice'],
      knowledgeReviewIntervalMs: 90 * 24 * 60 * 60_000,
    });
    const run = await engine.runNow('alice');

    assert.equal(calls, 1);
    assert.ok(prompt.includes('recentKnowledgeFeedback'));
    assert.ok(prompt.includes('outdated'));
    assert.ok(prompt.includes('incorrect'));
    assert.deepEqual(run?.reviewedKnowledgePageIds, [page.id]);
  } finally {
    await x.close();
  }
});

test('Knowledge context feedback binds the exact context hash and page version, including delayed feedback', async () => {
  const x = setup();
  try {
    const page = await seedPage(x.store);
    const context = await x.store.buildContext({
      scope: 'alice',
      task: 'How should payment recovery retries work?',
      budget: { maxUnits: 8_000 },
    });
    const item = context.items.find((candidate) =>
      candidate.id === page.id && candidate.sourceType === 'knowledge');
    assert.ok(item);
    assert.equal(item.knowledgeVersion, 1);

    await x.store.markKnowledgePagesReviewed({
      scope: 'alice', ids: [page.id], reviewedAt: new Date().toISOString(),
    });
    await x.store.saveKnowledgePage({
      id: page.id,
      scope: 'alice',
      title: page.title,
      summary: page.summary,
      content: 'Updated recovery guidance includes terminal outcome reconciliation.',
      tags: page.tags,
      sourceRefs: page.sourceRefs,
      reason: 'Source evidence now includes terminal reconciliation behavior.',
    });
    assert.equal(
      (await x.store.getKnowledgePage({ scope: 'alice', pageId: page.id }))?.lastReviewedAt,
      undefined,
      'a content revision resets the review timestamp',
    );

    const feedbackInput = {
      id: 'knowledge-feedback:task-1',
      context,
      pageId: page.id,
      taskId: 'task:payment-retry',
      outcome: 'not-useful' as const,
    };
    await x.store.recordKnowledgeContextFeedback(feedbackInput);
    await x.store.recordKnowledgeContextFeedback(feedbackInput);

    const events = await x.store.loadKnowledgeFeedback({
      scope: 'alice',
      pageIds: [page.id],
      since: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
      limit: 20,
    });
    assert.equal(events.length, 1, 'feedback idempotency');
    assert.equal(events[0]?.pageVersion, 1);
    assert.equal(events[0]?.contextId, context.id);
    assert.equal(events[0]?.contextHash, context.hash);
    assert.equal(events[0]?.taskId, 'task:payment-retry');
    assert.equal(events[0]?.outcome, 'not-useful');

    await assert.rejects(() => x.store.recordKnowledgeContextFeedback({
      ...feedbackInput,
      id: 'knowledge-feedback:not-in-context',
      pageId: 'knowledge:not-in-context',
    }), /not included in the supplied Context Builder result/);
  } finally {
    await x.close();
  }
});

test('negative feedback for a superseded page version does not trigger current-version review', async () => {
  const x = setup();
  try {
    const page = await seedPage(x.store);
    await x.store.saveKnowledgePage({
      id: page.id,
      scope: page.scope,
      title: page.title,
      summary: page.summary,
      content: 'Revised guidance with the latest transaction reconciliation rule.',
      tags: page.tags,
      sourceRefs: page.sourceRefs,
    });
    const current = await x.store.getKnowledgePage({ scope: 'alice', pageId: page.id });
    assert.ok(current);
    await x.store.markKnowledgePagesReviewed({
      scope: 'alice', ids: [page.id], reviewedAt: new Date().toISOString(),
    });
    const oldDate = new Date().toISOString();
    for (const [index, outcome] of ['outdated', 'incorrect'].entries()) {
      await x.store.recordKnowledgeFeedback({
        id: `knowledge-feedback:old-${index}`,
        scope: 'alice',
        pageId: page.id,
        pageVersion: 1,
        kind: 'evidence',
        outcome: outcome as 'outdated' | 'incorrect',
        occurredAt: oldDate,
      });
    }

    let calls = 0;
    const runtime = makeRuntime((_prompt, call) => {
      calls = call;
      return resultFor(page.id);
    });
    const engine = new DreamingEngine(runtime, x.store, x.store, {
      scopes: ['alice'],
      knowledgeReviewIntervalMs: 90 * 24 * 60 * 60_000,
    });
    await engine.runNow('alice');
    assert.equal(calls, 0, 'old-version feedback is evidence about history, not the active page version');
  } finally {
    await x.close();
  }
});
