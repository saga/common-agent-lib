import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DreamingEngine,
  evaluateMemoryQuality,
  type DreamingCheckpoint,
  type DreamingEvidence,
  type DreamingFeedbackEvent,
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
  initialMemories: DreamingMemory[] = [],
  noExperiences = false,
  resolverOverride?: { resolve(input: { scope: string; refs: readonly string[] }): Promise<readonly DreamingEvidence[]> },
  experiencesOverride?: DreamingExperience[],
  initialCheckpoint = 0,
) {
  const experience: DreamingExperience = {
    id: 'e1', sequence: 1, scope: 'user-1', content: 'User prefers concise technical answers.',
    createdAt: '2026-11-01T00:00:00.000Z', sourceRefs: ['trace:t1:event:e1'],
  };
  const evidence: DreamingEvidence = {
    ref: 'trace:t1:event:e1', content: experience.content, kind: 'trace-event',
  };
  const memory: DreamingMemory[] = [...initialMemories];
  const runs: DreamingRun[] = [];
  let checkpoint: DreamingCheckpoint = { scope: 'user-1', afterSequence: initialCheckpoint };
  let lease = false;
  const commits: string[] = [];
  const committed: DreamingProposal[] = [];
  const staged: Array<{ proposal: DreamingProposal; reason: string }> = [];
  const reviewedMemories: string[] = [];
  const feedbackEvents: DreamingFeedbackEvent[] = [];
  const prompts: string[] = [];
  const memoryReviewRequests: Array<{ reviewBefore?: string; expiredBefore?: string }> = [];
  const repository: DreamingRepository = {
    async loadExperiences({ afterSequence }) {
      const items = experiencesOverride
        ? experiencesOverride
        : (!noExperiences && experience.sequence > afterSequence ? [experience] : []);
      return { items, hasMore: false };
    },
    async loadMemories(input) {
      memoryReviewRequests.push({ reviewBefore: input.reviewBefore, expiredBefore: input.expiredBefore });
      return memory;
    },
    async loadRelationships() { return []; },
    async loadCheckpoint() { return checkpoint; },
    async saveCheckpoint(value) { checkpoint = value; },
    async markExperiencesReviewed() {},
    async markMemoriesReviewed({ ids }) { reviewedMemories.push(...ids); },
    async recordFeedback(event) {
      const existing = feedbackEvents.find((item) => item.id === event.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw new Error('feedback id conflict');
      if (!existing) feedbackEvents.push(event);
    },
    async loadFeedback({ memoryIds, since }) {
      const selected = new Set(memoryIds);
      return feedbackEvents.filter((event) => selected.has(event.memoryId) && event.occurredAt >= since);
    },
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
    async generate(request) {
      prompts.push(request.prompt);
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
  const resolver = resolverOverride ?? {
    async resolve({ refs }: { scope: string; refs: readonly string[] }) {
      return refs.includes(evidence.ref) ? [evidence] : [];
    },
  };
  const engine = new DreamingEngine(runtime, repository, resolver, {
    scopes: ['user-1'], batchSize: 10, maxBatchesPerRun: 1, ...callbacks,
  });
  return { engine, checkpoint: () => checkpoint, runs, commits, committed, staged, reviewedMemories, memoryReviewRequests, feedbackEvents, prompts };
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

test('evidence resolver cannot inject unrelated or duplicate evidence into a Dreaming run', async () => {
  const resolver = {
    async resolve() {
      return [
        { ref: 'unrequested:1', content: 'unrelated', kind: 'note' },
        { ref: 'unrequested:1', content: 'duplicate', kind: 'note' },
      ];
    },
  };
  const f = fixture('trace:t1:event:e1', {}, undefined, [], false, resolver);
  await assert.rejects(() => f.engine.runNow('user-1'), /invalid, duplicate or unrequested evidence/);
  assert.deepEqual(f.commits, []);
  assert.equal(f.runs[0]?.status, 'failed');
});

test('re-review experiences at or before the checkpoint do not block new experience progress', async () => {
  const oldReviewed: DreamingExperience = {
    id: 'old-review', sequence: 4, scope: 'user-1', content: 'An older experience due for maintenance review.',
    createdAt: '2026-10-01T00:00:00.000Z', sourceRefs: ['trace:t1:event:e1'],
  };
  const newExperience: DreamingExperience = {
    id: 'new-experience', sequence: 6, scope: 'user-1', content: 'A new experience after the checkpoint.',
    createdAt: '2026-11-26T00:00:00.000Z', sourceRefs: ['trace:t1:event:e1'],
  };
  const f = fixture(
    'trace:t1:event:e1',
    {},
    { proposals: [], processedRecordIds: ['new-experience'], reviewedMemoryIds: [], notes: [] },
    [],
    false,
    undefined,
    [oldReviewed, newExperience],
    5,
  );
  const run = await f.engine.runNow('user-1');
  assert.equal(run?.status, 'completed');
  assert.equal(f.checkpoint().afterSequence, 6);
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


test('existing-memory mutations are applied automatically with no review queue', async () => {
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
  const f = fixture('trace:t1:event:e1', {}, output, [{
    id: 'm-existing', scope: 'user-1', content: 'Older preference.', status: 'confirmed',
    importance: 0.8, sourceRefs: ['trace:t1:event:e1'],
  }]);
  const run = await f.engine.runNow('user-1');
  assert.deepEqual(f.commits, ['p-update']);
  assert.deepEqual(f.staged, []);
  assert.deepEqual(run?.pendingProposalIds, []);
});

test('low quality additions are stored automatically as candidates', async () => {
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
  assert.deepEqual(f.commits, ['p-low']);
  assert.deepEqual(f.staged, []);
  assert.deepEqual(run?.pendingProposalIds, []);
});

test('high contradiction risk is retained automatically as a candidate', async () => {
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
  assert.deepEqual(f.commits, ['p-explicit-conflict']);
  assert.deepEqual(f.staged, []);
  assert.deepEqual(run?.pendingProposalIds, []);
});

test('missing quality assessment remains automatic without a review dependency', async () => {
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
  const run = await f.engine.runNow('user-1');
  assert.deepEqual(f.commits, ['p-unrated']);
  assert.deepEqual(f.staged, []);
  assert.deepEqual(run?.pendingProposalIds, []);
});


test('additions without provenance are rejected instead of staged for review', async () => {
  const output = {
    proposals: [{
      id: 'p-no-source', scope: 'user-1', operation: 'add', targetRecordIds: [],
      proposedRecord: {
        id: 'm-no-source', scope: 'user-1', content: 'No source reference.',
        status: 'candidate', importance: 0.5, sourceRefs: [],
      },
      rationale: 'No provenance.',
      evidenceRefs: ['trace:t1:event:e1'],
      quality: { confidence: 0.99, durability: 0.9, specificity: 0.9, contradictionRisk: 0.01 },
    }],
    processedRecordIds: ['e1'],
  };
  const f = fixture('trace:t1:event:e1', {}, output);
  const run = await f.engine.runNow('user-1');
  assert.deepEqual(f.commits, []);
  assert.deepEqual(f.staged, []);
  assert.deepEqual(run?.pendingProposalIds, []);
});

test('invalid automatic candidate thresholds fail at construction', () => {
  assert.throws(() => new DreamingEngine(
    { id: 'test', async generate() { return { output: {} }; } },
    {} as DreamingRepository,
    { async resolve() { return []; } },
    { scopes: ['user-1'], autoCandidateThresholds: { confidence: 1.2 } },
  ), /must be between 0 and 1/);
});


test('memory review persists only IDs explicitly reported by the runtime', async () => {
  const output = {
    proposals: [],
    processedRecordIds: ['e1'],
    reviewedMemoryIds: ['m-stale'],
  };
  const f = fixture('trace:t1:event:e1', {}, output, [{
    id: 'm-stale', scope: 'user-1', content: 'An old preference.',
    status: 'confirmed', importance: 0.8, sourceRefs: ['trace:t1:event:e1'],
    lastValidatedAt: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-11-20T00:00:00.000Z',
  }]);
  const run = await f.engine.runNow('user-1');
  assert.deepEqual(f.reviewedMemories, ['m-stale']);
  assert.deepEqual(run?.reviewedMemoryIds, ['m-stale']);
  assert.ok(f.memoryReviewRequests[0]?.reviewBefore);
  assert.ok(f.memoryReviewRequests[0]?.expiredBefore);
});

test('runtime cannot mark a memory outside the loaded scope as reviewed', async () => {
  const output = {
    proposals: [],
    processedRecordIds: ['e1'],
    reviewedMemoryIds: ['m-other-scope'],
  };
  const f = fixture('trace:t1:event:e1', {}, output);
  await assert.rejects(() => f.engine.runNow('user-1'), /unknown memory as reviewed/);
  assert.deepEqual(f.reviewedMemories, []);
});


test('stale memories can be reviewed even when there are no new experience rows', async () => {
  const output = { proposals: [], processedRecordIds: [], reviewedMemoryIds: ['m-seeded'] };
  const f = fixture('trace:t1:event:e1', {}, output, [{
    id: 'm-seeded', scope: 'user-1', content: 'Seeded durable memory.',
    status: 'confirmed', importance: 0.8, sourceRefs: ['trace:t1:event:e1'],
    lastValidatedAt: '2026-01-01T00:00:00.000Z',
  }], true);
  const run = await f.engine.runNow('user-1');
  assert.equal(run?.status, 'completed');
  assert.deepEqual(f.reviewedMemories, ['m-seeded']);
  assert.deepEqual(run?.processedRecordIds, []);
});


test('explicitly contradictory derived memory proposals are applied automatically', async () => {
  const output = {
    proposals: [{
      id: 'p-explicit-conflict', scope: 'user-1', operation: 'add', targetRecordIds: [],
      proposedRecord: {
        id: 'm-new', scope: 'user-1', content: 'A changed preference.',
        status: 'candidate', importance: 0.8, sourceRefs: ['trace:t1:event:e1'],
      },
      rationale: 'The new statement conflicts with an older preference.',
      evidenceRefs: ['trace:t1:event:e1'],
      conflictsWith: ['m-existing'],
      quality: { confidence: 0.99, durability: 0.9, specificity: 0.9, contradictionRisk: 0.01 },
    }],
    processedRecordIds: ['e1'],
  };
  const f = fixture('trace:t1:event:e1', {}, output, [{
    id: 'm-existing', scope: 'user-1', content: 'An older preference.',
    status: 'confirmed', importance: 0.8, sourceRefs: ['trace:t1:event:e1'],
  }]);
  const run = await f.engine.runNow('user-1');
  assert.deepEqual(f.commits, ['p-explicit-conflict']);
  assert.deepEqual(f.staged, []);
  assert.deepEqual(run?.pendingProposalIds, []);
});


test('feedback evaluator keeps small samples inconclusive', () => {
  const events: DreamingFeedbackEvent[] = [
    { id: 'f1', scope: 'user-1', memoryId: 'm1', kind: 'retrieval', outcome: 'not-useful', occurredAt: '2026-11-24T00:00:00.000Z' },
  ];
  const quality = evaluateMemoryQuality(events, '2026-11-25T00:00:00.000Z');
  assert.equal(quality.sampleCount, 1);
  assert.equal(quality.recommendation, 'none');
  assert.equal(quality.usefulness, 0);
});

test('repeated negative retrieval feedback and corrections recommend review', () => {
  const events: DreamingFeedbackEvent[] = [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `r${index}`, scope: 'user-1', memoryId: 'm1', kind: 'retrieval' as const,
      outcome: 'not-useful' as const, occurredAt: '2026-11-24T00:00:00.000Z',
    })),
    { id: 'c1', scope: 'user-1', memoryId: 'm1', kind: 'user-correction', outcome: 'incorrect', occurredAt: '2026-11-24T00:00:00.000Z' },
    { id: 'c2', scope: 'user-1', memoryId: 'm1', kind: 'user-correction', outcome: 'outdated', occurredAt: '2026-11-24T00:00:00.000Z' },
  ];
  const quality = evaluateMemoryQuality(events, '2026-11-25T00:00:00.000Z');
  assert.equal(quality.recommendation, 'review');
  assert.ok(quality.reasons.includes('low-retrieval-usefulness'));
  assert.ok(quality.reasons.includes('repeated-user-correction'));
});

test('contradicting evidence and human rejection are strong review signals', () => {
  const events: DreamingFeedbackEvent[] = [
    { id: 'e1', scope: 'user-1', memoryId: 'm1', kind: 'evidence', outcome: 'contradicts', occurredAt: '2026-11-24T00:00:00.000Z' },
    { id: 'e2', scope: 'user-1', memoryId: 'm1', kind: 'evidence', outcome: 'contradicts', occurredAt: '2026-11-24T00:00:00.000Z' },
    { id: 'e3', scope: 'user-1', memoryId: 'm1', kind: 'evidence', outcome: 'supports', occurredAt: '2026-11-24T00:00:00.000Z' },
    { id: 'h1', scope: 'user-1', memoryId: 'm1', kind: 'human-review', outcome: 'rejected', occurredAt: '2026-11-24T00:00:00.000Z' },
  ];
  const quality = evaluateMemoryQuality(events, '2026-11-25T00:00:00.000Z');
  assert.equal(quality.recommendation, 'review');
  assert.ok(quality.reasons.includes('contradicting-evidence'));
  assert.ok(quality.reasons.includes('human-rejected'));
});

test('feedback events are validated and persisted through the engine', async () => {
  const f = fixture();
  const event: DreamingFeedbackEvent = {
    id: 'feedback-1', scope: 'user-1', memoryId: 'm1', kind: 'retrieval',
    outcome: 'useful', occurredAt: '2026-11-25T00:00:00.000Z', taskId: 'task-1',
  };
  await f.engine.recordFeedback(event);
  await f.engine.recordFeedback(event);
  assert.equal(f.feedbackEvents.length, 1);
  await assert.rejects(() => f.engine.recordFeedback({
    ...event, id: 'bad-feedback', kind: 'retrieval', outcome: 'contradicts',
  }), /kind and outcome do not match/);
});

test('future and expired feedback are excluded from the evaluation window', () => {
  const events: DreamingFeedbackEvent[] = [
    { id: 'old', scope: 'user-1', memoryId: 'm1', kind: 'retrieval', outcome: 'not-useful', occurredAt: '2026-01-01T00:00:00.000Z' },
    { id: 'future', scope: 'user-1', memoryId: 'm1', kind: 'retrieval', outcome: 'not-useful', occurredAt: '2026-12-01T00:00:00.000Z' },
  ];
  const quality = evaluateMemoryQuality(events, '2026-11-25T00:00:00.000Z');
  assert.equal(quality.sampleCount, 0);
  assert.equal(quality.recommendation, 'none');
});


test('long-term feedback summaries are supplied to the dreaming runtime', async () => {
  const f = fixture('trace:t1:event:e1', {}, undefined, [{
    id: 'm-feedback', scope: 'user-1', content: 'A memory with repeated poor retrieval outcomes.',
    status: 'confirmed', importance: 0.8, sourceRefs: ['trace:t1:event:e1'],
  }]);
  for (let index = 0; index < 5; index += 1) {
    await f.engine.recordFeedback({
      id: `negative-${index}`, scope: 'user-1', memoryId: 'm-feedback',
      kind: 'retrieval', outcome: 'not-useful', occurredAt: '2026-11-24T00:00:00.000Z',
      taskId: `task-${index}`,
    });
  }
  await f.engine.runNow('user-1');
  assert.match(f.prompts[0] ?? '', /low-retrieval-usefulness/);
  assert.match(f.prompts[0] ?? '', /"recommendation": "review"/);
});


test('review effectiveness compares usefulness before and after an accepted review', () => {
  const events: DreamingFeedbackEvent[] = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `before-${index}`, scope: 'user-1', memoryId: 'm-review',
      kind: 'retrieval' as const, outcome: 'not-useful' as const,
      occurredAt: `2026-10-${String(1 + index).padStart(2, '0')}T00:00:00.000Z`,
    })),
    {
      id: 'review-1', scope: 'user-1', memoryId: 'm-review', kind: 'human-review',
      outcome: 'edited', occurredAt: '2026-10-10T00:00:00.000Z',
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `after-${index}`, scope: 'user-1', memoryId: 'm-review',
      kind: 'retrieval' as const, outcome: 'useful' as const,
      occurredAt: `2026-10-${String(11 + index).padStart(2, '0')}T00:00:00.000Z`,
    })),
  ];
  const quality = evaluateMemoryQuality(events, '2026-11-01T00:00:00.000Z');
  assert.equal(quality.reviewEffectiveness?.trend, 'improving');
  assert.equal(quality.reviewEffectiveness?.baselineSampleCount, 4);
  assert.equal(quality.reviewEffectiveness?.followUpSampleCount, 4);
  assert.equal(quality.reviewEffectiveness?.delta, 1);
});

test('declining post-review usefulness raises a review signal', () => {
  const events: DreamingFeedbackEvent[] = [
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `before-${index}`, scope: 'user-1', memoryId: 'm-review',
      kind: 'retrieval' as const, outcome: 'useful' as const,
      occurredAt: `2026-10-0${index + 1}T00:00:00.000Z`,
    })),
    {
      id: 'review-1', scope: 'user-1', memoryId: 'm-review', kind: 'human-review',
      outcome: 'confirmed', occurredAt: '2026-10-10T00:00:00.000Z',
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `after-${index}`, scope: 'user-1', memoryId: 'm-review',
      kind: 'retrieval' as const, outcome: 'not-useful' as const,
      occurredAt: `2026-10-${11 + index}T00:00:00.000Z`,
    })),
  ];
  const quality = evaluateMemoryQuality(events, '2026-11-01T00:00:00.000Z');
  assert.equal(quality.reviewEffectiveness?.trend, 'declining');
  assert.equal(quality.recommendation, 'review');
  assert.ok(quality.reasons.includes('post-review-usefulness-declined'));
});

test('review effectiveness remains inconclusive without enough before-and-after observations', () => {
  const events: DreamingFeedbackEvent[] = [
    { id: 'before-1', scope: 'user-1', memoryId: 'm-review', kind: 'retrieval', outcome: 'not-useful', occurredAt: '2026-10-01T00:00:00.000Z' },
    { id: 'review-1', scope: 'user-1', memoryId: 'm-review', kind: 'human-review', outcome: 'edited', occurredAt: '2026-10-10T00:00:00.000Z' },
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `after-${index}`, scope: 'user-1', memoryId: 'm-review',
      kind: 'retrieval' as const, outcome: 'useful' as const,
      occurredAt: `2026-10-${11 + index}T00:00:00.000Z`,
    })),
  ];
  const quality = evaluateMemoryQuality(events, '2026-11-01T00:00:00.000Z');
  assert.equal(quality.reviewEffectiveness, undefined);
});
