import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DreamingEngine,
  type DreamingCheckpoint,
  type DreamingEvidence,
  type DreamingExperience,
  type DreamingMemory,
  type DreamingOptions,
  type DreamingProposal,
  type DreamingRepository,
  type DreamingRun,
  type DreamingRuntime,
} from '../src/index.js';

function fixture(
  proposalEvidenceRef = 'trace:t1:event:e1',
  callbacks: Pick<DreamingOptions, 'onRun' | 'onError'> = {},
  modelOutput?: unknown,
) {
  const experience: DreamingExperience = {
    id: 'e1', sequence: 1, scope: 'user-1', content: 'User prefers concise technical answers.',
    createdAt: '2026-11-01T00:00:00.000Z', sourceRefs: ['trace:t1:event:e1'],
  };
  const evidence: DreamingEvidence = {
    ref: 'trace:t1:event:e1', content: experience.content, kind: 'trace-event',
  };
  const memory: DreamingMemory[] = [];
  const runs: DreamingRun[] = [];
  let checkpoint: DreamingCheckpoint = { scope: 'user-1', afterSequence: 0 };
  let lease = false;
  const commits: string[] = [];
  const committed: DreamingProposal[] = [];
  const staged: Array<{ proposal: DreamingProposal; reason: string }> = [];
  const repository: DreamingRepository = {
    async loadExperiences({ afterSequence }) {
      const items = experience.sequence > afterSequence ? [experience] : [];
      return { items, hasMore: false };
    },
    async loadMemories() { return memory; },
    async loadRelationships() { return []; },
    async loadCheckpoint() { return checkpoint; },
    async saveCheckpoint(value) { checkpoint = value; },
    async markExperiencesReviewed() {},
    async createRun(run) { runs.push(run); },
    async updateRun(run) {
      const index = runs.findIndex((item) => item.id === run.id);
      if (index >= 0) runs[index] = run;
    },
    async commitProposal({ proposal }) {
      committed.push(proposal);
      commits.push(proposal.id);
      return { applied: true };
    },
    async stageProposal({ proposal, reason }) {
      staged.push({ proposal, reason });
      return { staged: true };
    },
    async acquireLease() {
      if (lease) return false;
      lease = true;
      return true;
    },
    async releaseLease() { lease = false; },
  };
  const runtime: DreamingRuntime = {
    id: 'test-runtime',
    async generate() {
      return {
        model: 'test-model',
        output: modelOutput ?? {
          proposals: [{
            id: 'p1', scope: 'user-1', operation: 'add', targetRecordIds: [],
            proposedRecord: {
              id: 'm1', scope: 'user-1', content: 'Prefers concise technical answers.',
              status: 'confirmed', importance: 0.9, sourceRefs: ['trace:t1:event:e1'],
            },
            rationale: 'Explicit preference in source evidence.',
            evidenceRefs: [proposalEvidenceRef],
            quality: { confidence: 0.95, durability: 0.9, specificity: 0.9, contradictionRisk: 0.02 },
          }],
          processedRecordIds: ['e1'],
          notes: [],
        },
      };
    },
  };
  const resolver = {
    async resolve({ refs }: { scope: string; refs: readonly string[] }) {
      return refs.includes(evidence.ref) ? [evidence] : [];
    },
  };
  const engine = new DreamingEngine(runtime, repository, resolver, {
    scopes: ['user-1'], batchSize: 10, maxBatchesPerRun: 1, ...callbacks,
  });
  return { engine, checkpoint: () => checkpoint, runs, commits, committed, staged };
}

test('runNow resolves evidence, submits proposals and advances checkpoint', async () => {
  const f = fixture();
  const run = await f.engine.runNow('user-1');
  assert.equal(run?.status, 'completed');
  assert.deepEqual(f.commits, ['p1']);
  assert.equal(f.checkpoint().afterSequence, 1);
  assert.equal(f.runs[0]?.model, 'test-model');
  assert.deepEqual(f.runs[0]?.appliedProposalIds, ['p1']);
  assert.equal(f.committed[0]?.proposedRecord?.status, 'candidate');
});

test('model cannot promote a proposed memory to confirmed', async () => {
  const f = fixture();
  const run = await f.engine.runNow('user-1');
  assert.equal(run?.status, 'completed');
  assert.equal(f.committed[0]?.proposedRecord?.status, 'candidate');
});

test('unknown evidence references reject a proposal before commit', async () => {
  const f = fixture('trace:missing:event:missing');
  const run = await f.engine.runNow('user-1');
  assert.deepEqual(run?.rejectedProposalIds, ['p1']);
  assert.deepEqual(f.commits, []);
});

test('concurrent triggers for one scope share the same run', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    f.engine.runNow('user-1'),
    f.engine.runNow('user-1'),
  ]);
  assert.equal(first?.id, second?.id);
  assert.deepEqual(f.commits, ['p1']);
});

test('a busy scope lease prevents overlapping workers', async () => {
  const f = fixture();
  const run = await f.engine.runNow('user-1');
  assert.equal(run?.status, 'completed');
});

test('runNow rejects scopes that were not configured', async () => {
  const f = fixture();
  assert.throws(() => f.engine.runNow('another-user'), /Unknown dreaming scope/);
});

test('notifyRecordAppended rejects scopes that were not configured', async () => {
  const f = fixture();
  assert.throws(() => f.engine.notifyRecordAppended('another-user'), /Unknown dreaming scope/);
});


test('observer callback failures do not fail a completed run', async () => {
  const observedErrors: unknown[] = [];
  const f = fixture('trace:t1:event:e1', {
    onRun() { throw new Error('metrics backend unavailable'); },
    onError(error) { observedErrors.push(error); },
  });
  const run = await f.engine.runNow('user-1');
  assert.equal(run?.status, 'completed');
  assert.equal(f.runs[0]?.status, 'completed');
  assert.equal(observedErrors.length, 1);
});


test('existing-memory mutations are staged for review, never auto-applied', async () => {
  const output = {
    proposals: [{
      id: 'p-update', scope: 'user-1', operation: 'update', targetRecordIds: ['m-existing'],
      proposedRecord: {
        id: 'm-new', scope: 'user-1', content: 'Updated preference.',
        status: 'candidate', importance: 0.8, sourceRefs: ['trace:t1:event:e1'],
      },
      rationale: 'New evidence may supersede an older preference.',
      evidenceRefs: ['trace:t1:event:e1'],
      quality: { confidence: 0.99, durability: 0.9, specificity: 0.9, contradictionRisk: 0.01 },
    }],
    processedRecordIds: ['e1'],
  };
  const f = fixture('trace:t1:event:e1', {}, output);
  const run = await f.engine.runNow('user-1');
  assert.deepEqual(f.commits, []);
  assert.deepEqual(f.staged.map((item) => [item.proposal.id, item.reason]), [['p-update', 'mutation']]);
  assert.deepEqual(run?.pendingProposalIds, ['p-update']);
});

test('low quality additions are staged instead of auto-applied', async () => {
  const output = {
    proposals: [{
      id: 'p-low', scope: 'user-1', operation: 'add', targetRecordIds: [],
      proposedRecord: {
        id: 'm-low', scope: 'user-1', content: 'Possibly temporary preference.',
        status: 'candidate', importance: 0.5, sourceRefs: ['trace:t1:event:e1'],
      },
      rationale: 'Weak signal.',
      evidenceRefs: ['trace:t1:event:e1'],
      quality: { confidence: 0.4, durability: 0.3, specificity: 0.7, contradictionRisk: 0.05 },
    }],
    processedRecordIds: ['e1'],
  };
  const f = fixture('trace:t1:event:e1', {}, output);
  const run = await f.engine.runNow('user-1');
  assert.deepEqual(f.commits, []);
  assert.deepEqual(f.staged.map((item) => [item.proposal.id, item.reason]), [['p-low', 'quality-gate']]);
  assert.deepEqual(run?.pendingProposalIds, ['p-low']);
});

test('high contradiction risk is routed to review', async () => {
  const output = {
    proposals: [{
      id: 'p-conflict', scope: 'user-1', operation: 'add', targetRecordIds: [],
      proposedRecord: {
        id: 'm-conflict', scope: 'user-1', content: 'Potentially conflicting preference.',
        status: 'candidate', importance: 0.5, sourceRefs: ['trace:t1:event:e1'],
      },
      rationale: 'Evidence conflicts with an existing memory.',
      evidenceRefs: ['trace:t1:event:e1'],
      quality: { confidence: 0.9, durability: 0.8, specificity: 0.8, contradictionRisk: 0.8 },
    }],
    processedRecordIds: ['e1'],
  };
  const f = fixture('trace:t1:event:e1', {}, output);
  const run = await f.engine.runNow('user-1');
  assert.deepEqual(f.commits, []);
  assert.deepEqual(f.staged.map((item) => [item.proposal.id, item.reason]), [['p-conflict', 'conflict-risk']]);
  assert.deepEqual(run?.pendingProposalIds, ['p-conflict']);
});

test('missing quality assessment cannot pass the automatic candidate gate', async () => {
  const output = {
    proposals: [{
      id: 'p-unrated', scope: 'user-1', operation: 'add', targetRecordIds: [],
      proposedRecord: {
        id: 'm-unrated', scope: 'user-1', content: 'Unrated candidate.',
        status: 'candidate', importance: 0.5, sourceRefs: ['trace:t1:event:e1'],
      },
      rationale: 'No assessment provided.',
      evidenceRefs: ['trace:t1:event:e1'],
    }],
    processedRecordIds: ['e1'],
  };
  const f = fixture('trace:t1:event:e1', {}, output);
  await f.engine.runNow('user-1');
  assert.deepEqual(f.commits, []);
  assert.deepEqual(f.staged.map((item) => item.reason), ['missing-assessment']);
});
