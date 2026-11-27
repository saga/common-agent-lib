import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDreamingStore } from '../src/sqlite-store.js';
import { DreamingEngine } from '../src/engine.js';
import type { DreamingKnowledgeProposal, DreamingRuntime } from '../src/types.js';

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreaming-knowledge-maintenance-'));
  const store = new SqliteDreamingStore({ filename: path.join(dir, 'db.sqlite'), embeddingProvider: false });
  return {
    store,
    close: async () => {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedEvidence(store: SqliteDreamingStore) {
  await store.putEvidence('alice', {
    ref: 'evidence:payment', kind: 'document',
    content: 'Payment recovery uses an idempotency key and verifies the durable transaction state.',
  });
}

function pageInput(id = 'knowledge:payments', content = 'Payment recovery verifies durable transaction state.') {
  return {
    id, scope: 'alice', title: 'Payment recovery',
    summary: 'Safe retries with idempotency.',
    content, tags: ['payments', 'recovery'], sourceRefs: ['evidence:payment'],
  };
}

function proposal(overrides: Partial<DreamingKnowledgeProposal> = {}): DreamingKnowledgeProposal {
  return {
    id: 'knowledge-proposal:1',
    scope: 'alice',
    operation: 'create',
    targetPageIds: [],
    proposedPage: pageInput(),
    rationale: 'Repeated evidence describes a reusable recovery approach.',
    evidenceRefs: ['evidence:payment'],
    confidence: 0.94,
    ...overrides,
  };
}

function withoutPage(input: DreamingKnowledgeProposal): DreamingKnowledgeProposal {
  delete input.proposedPage;
  return input;
}

test('Knowledge proposal creates pages and proposal commits are idempotent', async () => {
  const x = setup();
  try {
    await seedEvidence(x.store);
    const p = proposal();
    const evidence = await x.store.resolve({ scope: 'alice', refs: p.evidenceRefs });
    const first = await x.store.commitKnowledgeProposal({ proposal: p, evidence, runId: 'run:1' });
    const repeated = await x.store.commitKnowledgeProposal({ proposal: p, evidence, runId: 'run:2' });
    assert.equal(first.applied, true);
    assert.equal(repeated.reason, 'already-applied');
    const stored = await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge:payments' });
    assert.equal(stored?.status, 'active');
    assert.equal(stored?.version, 1);
  } finally {
    await x.close();
  }
});

test('Knowledge revise versions the old page; merge supersedes sources and records graph links', async () => {
  const x = setup();
  try {
    await seedEvidence(x.store);
    await x.store.saveKnowledgePage(pageInput('knowledge:payments-a'));
    await x.store.saveKnowledgePage({
      ...pageInput('knowledge:payments-b'),
      title: 'Payment retries',
      content: 'Payment retries need a durable outcome check.',
    });
    const evidence = await x.store.resolve({ scope: 'alice', refs: ['evidence:payment'] });
    const revisedProposal = proposal({
      id: 'knowledge-proposal:revise',
      operation: 'revise',
      targetPageIds: ['knowledge:payments-a'],
      proposedPage: pageInput('knowledge:payments-a', 'Revised content includes idempotency and final outcome verification.'),
    });
    await x.store.commitKnowledgeProposal({ proposal: revisedProposal, evidence, runId: 'run:2' });
    const revised = await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge:payments-a' });
    assert.equal(revised?.version, 2);
    assert.equal((await x.store.listKnowledgePageVersions({ scope: 'alice', pageId: 'knowledge:payments-a' })).length, 1);

    const merged = proposal({
      id: 'knowledge-proposal:merge',
      operation: 'merge',
      targetPageIds: ['knowledge:payments-a', 'knowledge:payments-b'],
      proposedPage: pageInput('knowledge:payments-unified', 'Unified page covering payment retries and durable recovery.'),
    });
    const result = await x.store.commitKnowledgeProposal({ proposal: merged, evidence, runId: 'run:3' });
    assert.equal(result.applied, true);
    assert.equal((await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge:payments-a' }))?.status, 'superseded');
    assert.equal((await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge:payments-b' }))?.status, 'superseded');
    const links = await x.store.listKnowledgeLinks({ scope: 'alice', pageIds: ['knowledge:payments-unified'] });
    assert.equal(links.filter((item) => item.kind === 'supersedes').length, 2);
  } finally {
    await x.close();
  }
});

test('Knowledge link, supersede and deprecate proposals update the graph transactionally', async () => {
  const x = setup();
  try {
    await seedEvidence(x.store);
    await x.store.saveKnowledgePage(pageInput('knowledge:old'));
    await x.store.saveKnowledgePage({
      ...pageInput('knowledge:related'),
      title: 'Payment idempotency',
      content: 'Idempotency keys prevent duplicate payment execution.',
    });
    const evidence = await x.store.resolve({ scope: 'alice', refs: ['evidence:payment'] });
    const linked = withoutPage(proposal({
      id: 'knowledge-proposal:link',
      operation: 'link',
      targetPageIds: ['knowledge:old', 'knowledge:related'],
      link: { fromId: 'knowledge:old', toId: 'knowledge:related', kind: 'supports' },
    }));
    assert.equal((await x.store.commitKnowledgeProposal({ proposal: linked, evidence, runId: 'run:4' })).applied, true);
    assert.equal((await x.store.listKnowledgeLinks({ scope: 'alice', pageIds: ['knowledge:old'] }))
      .some((item) => item.kind === 'supports'), true);

    const superseded = proposal({
      id: 'knowledge-proposal:supersede',
      operation: 'supersede',
      targetPageIds: ['knowledge:old'],
      proposedPage: pageInput('knowledge:replacement', 'Updated payment recovery guidance.'),
    });
    assert.equal((await x.store.commitKnowledgeProposal({ proposal: superseded, evidence, runId: 'run:5' })).applied, true);
    assert.equal((await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge:old' }))?.status, 'superseded');
    assert.equal((await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge:replacement' }))?.status, 'active');

    const deprecated = withoutPage(proposal({
      id: 'knowledge-proposal:deprecate',
      operation: 'deprecate',
      targetPageIds: ['knowledge:related'],
    }));
    assert.equal((await x.store.commitKnowledgeProposal({ proposal: deprecated, evidence, runId: 'run:6' })).applied, true);
    assert.equal((await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge:related' }))?.status, 'deprecated');
  } finally {
    await x.close();
  }
});

test('Low-confidence proposals remain drafts and cannot modify or deprecate active pages', async () => {
  const x = setup();
  try {
    await seedEvidence(x.store);
    await x.store.saveKnowledgePage(pageInput());
    const evidence = await x.store.resolve({ scope: 'alice', refs: ['evidence:payment'] });
    const lowRevise = proposal({
      id: 'knowledge-proposal:weak-revise',
      operation: 'revise',
      targetPageIds: ['knowledge:payments'],
      proposedPage: pageInput('knowledge:payments', 'Uncertain proposed change.'),
      confidence: 0.4,
    });
    const result = await x.store.commitKnowledgeProposal({ proposal: lowRevise, evidence, runId: 'run:7' });
    assert.equal(result.applied, true);
    assert.equal(result.reason, 'saved-as-draft');
    assert.equal((await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge:payments' }))?.content,
      'Payment recovery verifies durable transaction state.');
    const draft = await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge-draft:knowledge-proposal:weak-revise' });
    assert.equal(draft?.status, 'draft');

    const lowDeprecate = withoutPage(proposal({
      id: 'knowledge-proposal:weak-deprecate',
      operation: 'deprecate',
      targetPageIds: ['knowledge:payments'],
      confidence: 0.2,
    }));
    const rejected = await x.store.commitKnowledgeProposal({ proposal: lowDeprecate, evidence, runId: 'run:8' });
    assert.equal(rejected.applied, false);
    assert.equal((await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge:payments' }))?.status, 'active');
  } finally {
    await x.close();
  }
});

test('Knowledge proposal rejects cross-scope targets and unsupported provenance', async () => {
  const x = setup();
  try {
    await seedEvidence(x.store);
    await x.store.saveKnowledgePage(pageInput());
    const evidence = await x.store.resolve({ scope: 'alice', refs: ['evidence:payment'] });
    const outside = withoutPage(proposal({
      id: 'knowledge-proposal:outside',
      operation: 'deprecate',
      targetPageIds: ['knowledge:outside'],
    }));
    await assert.rejects(() => x.store.commitKnowledgeProposal({
      proposal: outside, evidence, runId: 'run:9',
    }), /missing or outside scope/);

    await assert.rejects(() => x.store.commitKnowledgeProposal({
      proposal: proposal({
        id: 'knowledge-proposal:bad-ref',
        evidenceRefs: ['evidence:other'],
      }),
      evidence,
      runId: 'run:10',
    }), /evidence payload is incomplete/);
  } finally {
    await x.close();
  }
});

test('Dreaming Engine supplies active Knowledge and commits model-proposed durable pages', async () => {
  const x = setup();
  try {
    await seedEvidence(x.store);
    await x.store.saveKnowledgePage({
      ...pageInput('knowledge:existing'),
      title: 'Payment processing invariants',
      content: 'The payment processor verifies durable transaction state.',
    });
    await x.store.appendExperience({
      id: 'experience:1', scope: 'alice',
      content: 'Payment recovery design repeatedly requires idempotency and a durable outcome check.',
      createdAt: new Date().toISOString(), sourceRefs: ['evidence:payment'],
    });
    let prompt = '';
    const p = proposal({ id: 'knowledge-proposal:engine' });
    const runtime: DreamingRuntime = {
      id: 'test-runtime',
      async generate(request) {
        prompt = request.prompt;
        return {
          output: {
            proposals: [],
            processedRecordIds: ['experience:1'],
            reviewedMemoryIds: [],
            knowledgeProposals: [p],
          },
        };
      },
    };
    const engine = new DreamingEngine(runtime, x.store, x.store, { scopes: ['alice'], maxKnowledgePages: 10 });
    const run = await engine.runNow('alice');
    assert.ok(prompt.includes('activeKnowledgePages'));
    assert.ok(prompt.includes('knowledge:existing'));
    assert.ok(run?.appliedProposalIds.includes('knowledge:knowledge-proposal:engine'));
    assert.equal((await x.store.getKnowledgePage({ scope: 'alice', pageId: 'knowledge:payments' }))?.status, 'active');
  } finally {
    await x.close();
  }
});
