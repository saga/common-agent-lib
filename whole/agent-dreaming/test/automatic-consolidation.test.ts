import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDreamingStore } from '../src/sqlite-store.js';
import type { DreamingMemory, DreamingProposal } from '../src/types.js';

const makeMemory = (id: string, scope = 'person:1'): DreamingMemory => ({
  id, scope, content: `Memory ${id}`, status: 'confirmed', importance: 0.7,
  sourceRefs: ['source:verified'],
});

const makeProposal = (
  id: string,
  operation: DreamingProposal['operation'],
  targets: string[],
  proposedRecord?: DreamingMemory,
): DreamingProposal => ({
  id,
  scope: 'person:1',
  operation,
  targetRecordIds: targets,
  ...(proposedRecord ? { proposedRecord } : {}),
  rationale: 'Supported by source evidence.',
  evidenceRefs: ['source:verified'],
});

test('Dreaming automatically updates, merges, supersedes and archives derived memories', async () => {
  const store = new SqliteDreamingStore({ filename: ':memory:', embeddingProvider: false });
  try {
    await store.putEvidence('person:1', {
      ref: 'source:verified',
      kind: 'conversation',
      content: 'Verified source text.',
    });
    await store.upsertMemory(makeMemory('memory-a'));
    await store.upsertMemory(makeMemory('memory-b'));

    const update = makeProposal('proposal-update', 'update', ['memory-a'], {
      ...makeMemory('model-update-id'),
      content: 'Updated fact from new evidence.',
      status: 'candidate',
    });
    assert.deepEqual(await store.commitProposal({
      proposal: update,
      evidence: [{ ref: 'source:verified', kind: 'conversation', content: 'Verified source text.' }],
      runId: 'run-1',
    }), { applied: true });
    const updated = (await store.listMemories('person:1')).find((item) => item.id === 'memory-a');
    assert.equal(updated?.content, 'Updated fact from new evidence.');
    assert.equal(updated?.authority, 'derived');
    assert.equal((await store.listMemories('person:1')).some((item) => item.id === 'model-update-id'), false);
    assert.equal((await store.listMemoryVersions({ scope: 'person:1', memoryId: 'memory-a' })).length, 1);

    const merge = makeProposal('proposal-merge', 'merge', ['memory-a', 'memory-b'], {
      ...makeMemory('memory-merged'),
      content: 'Consolidated fact.',
      status: 'candidate',
    });
    assert.deepEqual(await store.commitProposal({
      proposal: merge,
      evidence: [{ ref: 'source:verified', kind: 'conversation', content: 'Verified source text.' }],
      runId: 'run-2',
    }), { applied: true });
    const afterMerge = await store.listMemories('person:1');
    assert.equal(afterMerge.find((item) => item.id === 'memory-a')?.status, 'superseded');
    assert.equal(afterMerge.find((item) => item.id === 'memory-b')?.status, 'superseded');
    assert.equal(afterMerge.find((item) => item.id === 'memory-merged')?.status, 'candidate');

    const archive = makeProposal('proposal-archive', 'archive', ['memory-merged']);
    assert.deepEqual(await store.commitProposal({
      proposal: archive,
      evidence: [{ ref: 'source:verified', kind: 'conversation', content: 'Verified source text.' }],
      runId: 'run-3',
    }), { applied: true });
    assert.equal((await store.listMemories('person:1')).find((item) => item.id === 'memory-merged')?.status, 'archived');
    assert.equal((await store.listMemoryVersions({ scope: 'person:1', memoryId: 'memory-merged' })).length, 1);
    assert.equal((await store.listReviewQueue({ scope: 'person:1' })).length, 0);
  } finally {
    await store.close();
  }
});

test('low-confidence additions are persisted as candidates without a review queue', async () => {
  const store = new SqliteDreamingStore({ filename: ':memory:', embeddingProvider: false });
  try {
    const proposal = makeProposal('low-confidence', 'add', [], {
      ...makeMemory('candidate-memory'),
      content: 'A plausible but weakly supported fact.',
      status: 'candidate',
    });
    assert.deepEqual(await store.commitProposal({
      proposal,
      evidence: [{ ref: 'source:verified', kind: 'conversation', content: 'Source text.' }],
      runId: 'run-candidate',
    }), { applied: true });
    const memory = (await store.listMemories('person:1'))[0];
    assert.equal(memory?.status, 'candidate');
    assert.equal(memory?.authority, 'derived');
    assert.equal((await store.listReviewQueue({ scope: 'person:1' })).length, 0);
  } finally {
    await store.close();
  }
});
