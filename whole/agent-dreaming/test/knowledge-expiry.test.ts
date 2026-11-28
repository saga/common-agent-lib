import test from 'node:test';
import assert from 'node:assert/strict';
import { DreamingEngine, SqliteDreamingStore } from '../src/index.js';
import type { DreamingKnowledgeProposal, DreamingRuntime } from '../src/types.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('expired Knowledge evidence demotes a versioned page and Dreaming reactivates it only with fresh provenance', async () => {
  const store = new SqliteDreamingStore({ filename: ':memory:', embeddingProvider: false });
  const scope = 'project:payments';
  const pageId = 'knowledge:payment-recovery';
  try {
    await store.putEvidence(scope, {
      ref: 'evidence:payment-recovery:v1',
      kind: 'design-document',
      content: 'Legacy payment recovery guidance: retry after checking transaction state.',
      expiresAt: new Date(Date.now() + 900).toISOString(),
    });
    await store.putEvidence(scope, {
      ref: 'evidence:payment-recovery:v2',
      kind: 'design-document',
      content: 'Current payment recovery guidance requires an idempotency key and a durable transaction outcome check.',
    });
    await store.saveKnowledgePage({
      id: pageId,
      scope,
      title: 'Payment recovery',
      summary: 'Retry and recovery rules for payment processing.',
      content: 'Check the transaction state before retrying a payment.',
      status: 'active',
      tags: ['payments', 'recovery'],
      sourceRefs: ['evidence:payment-recovery:v1'],
    });
    const initialManifest = await store.getMemoryManifest(scope);
    assert.ok(initialManifest.itemIds.includes(pageId));

    await wait(1_000);
    const expiredPage = await store.getKnowledgePage({ scope, pageId });
    assert.equal(expiredPage?.status, 'draft');
    assert.equal(expiredPage?.version, 2);
    assert.equal(expiredPage?.metadata?.evidenceExpiryRequiresReview, true);
    assert.deepEqual(expiredPage?.metadata?.expiredEvidenceRefs, ['evidence:payment-recovery:v1']);

    const history = await store.listKnowledgePageVersions({ scope, pageId });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.version, 1);
    assert.equal(history[0]?.snapshot.status, 'active');

    const ordinarySearch = await store.searchKnowledge({ scope, query: 'payment recovery' });
    assert.equal(ordinarySearch.some((hit) => hit.id === pageId), false);
    const inactiveSearch = await store.searchKnowledge({
      scope, query: 'payment recovery', includeInactive: true,
    });
    assert.equal(inactiveSearch.some((hit) => hit.id === pageId && hit.status === 'draft'), true);

    const expiredEvidenceSearch = await store.search({
      scope, query: 'legacy payment recovery guidance', sourceTypes: ['evidence'],
    });
    assert.equal(expiredEvidenceSearch.some((hit) => hit.id === 'evidence:payment-recovery:v1'), false);
    const resolvedOldEvidence = await store.resolve({
      scope, refs: ['evidence:payment-recovery:v1'],
    });
    assert.equal(resolvedOldEvidence[0]?.expiresAt !== undefined, true);

    const expiredManifest = await store.getMemoryManifest(scope);
    assert.equal(expiredManifest.itemIds.includes(pageId), false);
    const expiredContext = await store.buildContext({
      scope,
      task: 'Review payment recovery retries and current transaction checks.',
      budget: { maxUnits: 8_000 },
    });
    assert.equal(expiredContext.items.some((item) => item.id === pageId), false);

    await store.appendExperience({
      id: 'experience:payment-recovery:revalidation',
      scope,
      content: 'The current payment recovery design replaces the old retry guidance with an idempotency key and a durable transaction outcome check.',
      createdAt: new Date().toISOString(),
      sourceRefs: ['evidence:payment-recovery:v2'],
    });
    let suppliedPrompt = '';
    const proposal: DreamingKnowledgeProposal = {
      id: 'proposal:payment-recovery:revalidate',
      scope,
      operation: 'revise',
      targetPageIds: [pageId],
      proposedPage: {
        id: pageId,
        scope,
        title: 'Payment recovery',
        summary: 'Use idempotent retries and verify the durable transaction outcome.',
        content: 'Before retrying, verify the durable transaction outcome and reuse the same idempotency key.',
        status: 'active',
        tags: ['payments', 'recovery'],
        sourceRefs: ['evidence:payment-recovery:v2'],
      },
      rationale: 'A current design source replaces the expired source and preserves the durable recovery rule.',
      evidenceRefs: ['evidence:payment-recovery:v2'],
      confidence: 0.97,
    };
    const runtime: DreamingRuntime = {
      id: 'knowledge-revalidation-runtime',
      async generate(request) {
        suppliedPrompt = request.prompt;
        return {
          output: {
            proposals: [],
            processedRecordIds: ['experience:payment-recovery:revalidation'],
            reviewedMemoryIds: [],
            reviewedKnowledgePageIds: [pageId],
            knowledgeProposals: [proposal],
          },
        };
      },
    };
    const engine = new DreamingEngine(runtime, store, store, {
      scopes: [scope], maxKnowledgePages: 10,
    });
    const run = await engine.runNow(scope);
    assert.ok(suppliedPrompt.includes('knowledgePagesForMaintenance'));
    assert.ok(suppliedPrompt.includes('evidence:payment-recovery:v1'));
    assert.ok(run?.appliedProposalIds.includes('knowledge:proposal:payment-recovery:revalidate'));

    const reactivated = await store.getKnowledgePage({ scope, pageId });
    assert.equal(reactivated?.status, 'active');
    assert.equal(reactivated?.version, 3);
    assert.deepEqual(reactivated?.sourceRefs, ['evidence:payment-recovery:v2']);
    assert.equal(reactivated?.metadata?.evidenceExpiryRequiresReview, undefined);
    assert.equal((await store.listKnowledgePageVersions({ scope, pageId })).length, 2);

    const currentManifest = await store.getMemoryManifest(scope);
    assert.ok(currentManifest.itemIds.includes(pageId));
    const currentSearch = await store.searchKnowledge({ scope, query: 'payment recovery' });
    assert.ok(currentSearch.some((hit) => hit.id === pageId && hit.status === 'active'));
  } finally {
    await store.close();
  }
});
