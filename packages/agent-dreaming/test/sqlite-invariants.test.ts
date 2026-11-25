import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDreamingStore } from '../src/sqlite-store.js';
import type { DreamingMemory, DreamingProposal } from '../src/index.js';

const createStore = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreaming-invariants-'));
  const store = new SqliteDreamingStore({ filename: path.join(dir, 'store.sqlite') });
  return {
    store,
    async close() {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const evidence = { ref: 'source:1', kind: 'note', content: 'Verified source' };
const record = (id: string, content = id): DreamingMemory => ({
  id, scope: 'scope-a', content, status: 'confirmed', importance: 0.7, sourceRefs: ['source:1'],
});
const proposal = (id: string, operation: DreamingProposal['operation'],
  targetRecordIds: string[], proposedRecord?: DreamingMemory): DreamingProposal => ({
  id, scope: 'scope-a', operation, targetRecordIds,
  ...(proposedRecord ? { proposedRecord } : {}),
  rationale: 'Supported by source evidence', evidenceRefs: ['source:1'],
});

test('scope collisions and conflicting experience IDs fail instead of silently overwriting', async () => {
  const { store, close } = createStore();
  try {
    await store.putEvidence('scope-a', evidence);
    await assert.rejects(() => store.putEvidence('scope-b', evidence), /another scope/);

    await store.upsertMemory(record('memory-1'));
    await assert.rejects(() => store.upsertMemory({ ...record('memory-1'), scope: 'scope-b' }), /another scope/);

    const experience = {
      id: 'experience-1', scope: 'scope-a', content: 'Original',
      createdAt: '2026-01-01T00:00:00.000Z', sourceRefs: ['source:1'],
    };
    await store.appendExperience(experience);
    await store.appendExperience(experience);
    await assert.rejects(() => store.appendExperience({ ...experience, content: 'Changed' }), /Conflicting experience ID/);
    await assert.rejects(() => store.appendExperience({ ...experience, scope: 'scope-b' }), /Conflicting experience ID/);
    assert.equal((await store.loadExperiences({ scope: 'scope-a', afterSequence: 0, limit: 10 })).items.length, 1);
  } finally {
    await close();
  }
});

test('auto-committed add proposals are provenance-checked and idempotent', async () => {
  const { store, close } = createStore();
  try {
    const p = proposal('proposal-add', 'add', [], { ...record('memory-added', 'Durable fact'), status: 'candidate' });
    const input = { proposal: p, evidence: [evidence], runId: 'run-1' };
    assert.deepEqual(await store.commitProposal(input), { applied: true });
    assert.deepEqual(await store.commitProposal(input), { applied: true });
    assert.equal((await store.listMemories('scope-a')).length, 1);
    assert.equal((await store.listMemories('scope-a'))[0]?.status, 'candidate');
    const conflictingRetry = proposal('proposal-add', 'add', [], {
      ...record('different-memory', 'Different payload'), status: 'candidate',
    });
    await assert.rejects(() => store.commitProposal({
      proposal: conflictingRetry, evidence: [evidence], runId: 'run-1',
    }), /Conflicting applied proposal ID/);

    const invalid = proposal('proposal-invalid', 'add', [], {
      ...record('memory-invalid'), sourceRefs: ['unverified:ref'], status: 'candidate',
    });
    assert.deepEqual(await store.commitProposal({ proposal: invalid, evidence: [evidence], runId: 'run-2' }),
      { applied: false, reason: 'unlisted-provenance' });
  } finally {
    await close();
  }
});

test('review approval atomically archives, merges and supersedes only in its scope', async () => {
  const { store, close } = createStore();
  try {
    await store.putEvidence('scope-a', evidence);
    await store.upsertMemory(record('old-1'));
    await store.upsertMemory(record('old-2'));

    const merge = proposal('merge-1', 'merge', ['old-1', 'old-2'], record('merged-1', 'Combined fact'));
    merge.relationships = [{
      id: 'relation-1', scope: 'scope-a', fromId: 'merged-1', toId: 'old-1',
      kind: 'derived-from', sourceRefs: ['source:1'],
    }];
    await store.stageProposal({ proposal: merge, evidence: [evidence], runId: 'run-1', reason: 'mutation' });
    assert.equal(await store.resolveReview({
      scope: 'scope-a', proposalId: 'merge-1', decision: 'approve', reviewedBy: 'reviewer',
    }), 'approved');
    const afterMerge = await store.listMemories('scope-a');
    assert.equal(afterMerge.find((m) => m.id === 'old-1')?.status, 'superseded');
    assert.equal(afterMerge.find((m) => m.id === 'old-2')?.status, 'superseded');
    assert.equal(afterMerge.find((m) => m.id === 'merged-1')?.status, 'confirmed');
    assert.equal((await store.loadRelationships({ scope: 'scope-a', memoryIds: ['merged-1'], limit: 10 })).length, 1);

    const archive = proposal('archive-1', 'archive', ['merged-1']);
    await store.stageProposal({ proposal: archive, evidence: [evidence], runId: 'run-2', reason: 'mutation' });
    assert.equal(await store.resolveReview({
      scope: 'scope-a', proposalId: 'archive-1', decision: 'approve', reviewedBy: 'reviewer',
    }), 'approved');
    assert.equal((await store.listMemories('scope-a')).find((m) => m.id === 'merged-1')?.status, 'archived');
  } finally {
    await close();
  }
});

test('update approval preserves identity and maps relationship endpoints to the retained ID', async () => {
  const { store, close } = createStore();
  try {
    await store.putEvidence('scope-a', evidence);
    await store.upsertMemory(record('target'));
    await store.upsertMemory(record('related'));
    const update = proposal('update-with-link', 'update', ['target'], {
      ...record('model-generated-id', 'Updated content'), status: 'candidate',
    });
    update.relationships = [{
      id: 'updated-link', scope: 'scope-a', fromId: 'model-generated-id', toId: 'related',
      kind: 'related-to', sourceRefs: ['source:1'],
    }];
    await store.stageProposal({ proposal: update, evidence: [evidence], runId: 'run-3', reason: 'mutation' });
    assert.equal(await store.resolveReview({
      scope: 'scope-a', proposalId: 'update-with-link', decision: 'approve', reviewedBy: 'reviewer',
    }), 'approved');
    const memories = await store.listMemories('scope-a');
    assert.equal(memories.length, 2);
    assert.equal(memories.find((m) => m.id === 'target')?.content, 'Updated content');
    assert.equal(memories.some((m) => m.id === 'model-generated-id'), false);
    const links = await store.loadRelationships({ scope: 'scope-a', memoryIds: ['target'], limit: 10 });
    assert.equal(links[0]?.fromId, 'target');
  } finally {
    await close();
  }
});

test('invalid approval leaves the review item pending and applies no partial mutation', async () => {
  const { store, close } = createStore();
  try {
    await store.upsertMemory(record('target'));
    const update = proposal('bad-update', 'update', ['target'], {
      ...record('new-id', 'Must not be applied'), status: 'candidate',
    });
    await store.stageProposal({ proposal: update, evidence: [], runId: 'run-4', reason: 'mutation' });
    await assert.rejects(() => store.resolveReview({
      scope: 'scope-a', proposalId: 'bad-update', decision: 'approve', reviewedBy: 'reviewer',
    }), /unresolved-evidence/);
    assert.equal((await store.listMemories('scope-a')).find((m) => m.id === 'target')?.content, 'target');
    assert.equal((await store.listReviewQueue({ scope: 'scope-a' }))[0]?.status, 'pending');
  } finally {
    await close();
  }
});

test('proposal ID reuse with different content is rejected', async () => {
  const { store, close } = createStore();
  try {
    const first = proposal('stable-id', 'add', [], { ...record('memory-1'), status: 'candidate' });
    const second = proposal('stable-id', 'add', [], { ...record('memory-2'), status: 'candidate' });
    await store.stageProposal({ proposal: first, evidence: [evidence], runId: 'run-1', reason: 'quality-gate' });
    await assert.rejects(() => store.stageProposal({
      proposal: second, evidence: [evidence], runId: 'run-1', reason: 'quality-gate',
    }), /Conflicting proposal ID/);
  } finally {
    await close();
  }
});

test('feedback must refer to a memory in the same scope', async () => {
  const { store, close } = createStore();
  try {
    await assert.rejects(() => store.recordFeedback({
      id: 'feedback-missing', scope: 'scope-a', memoryId: 'missing',
      kind: 'retrieval', outcome: 'useful', occurredAt: '2026-01-01T00:00:00.000Z',
    }), /not found in scope/);
    await store.upsertMemory(record('owned-memory'));
    await assert.rejects(() => store.recordFeedback({
      id: 'feedback-wrong-scope', scope: 'scope-b', memoryId: 'owned-memory',
      kind: 'retrieval', outcome: 'useful', occurredAt: '2026-01-01T00:00:00.000Z',
    }), /not found in scope/);
  } finally {
    await close();
  }
});

test('expired leases can be taken over but an old owner cannot renew them', async () => {
  const { store, close } = createStore();
  try {
    assert.equal(await store.acquireLease({ scope: 'scope-a', owner: 'worker-a', leaseMs: 5 }), true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(await store.acquireLease({ scope: 'scope-a', owner: 'worker-b', leaseMs: 1_000 }), true);
    assert.equal(await store.renewLease({ scope: 'scope-a', owner: 'worker-a', leaseMs: 1_000 }), false);
    assert.equal(await store.renewLease({ scope: 'scope-a', owner: 'worker-b', leaseMs: 1_000 }), true);
  } finally {
    await close();
  }
});
