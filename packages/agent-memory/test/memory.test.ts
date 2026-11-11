import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildWorkingMemory,
  MemoryChangeProposalSchema,
  parseMemoryConsolidationResult,
  MemoryRecordSchema,
  MemoryRelationshipSchema,
  selectArchiveCandidates,
  type MemoryRecord,
} from '../src/index.js';

function record(sequence: number, content: string, importance = 0.5): MemoryRecord {
  return { id: 'm-' + sequence, sequence, scope: 'session-1', kind: 'message', content, createdAt: new Date(2026, 0, sequence).toISOString(), lifecycle: 'active', importance, status: 'candidate', tags: [], sourceRefs: [], metadata: {} };
}

test('工作记忆优先保留高重要度记录，再补最新记录', () => {
  const result = buildWorkingMemory([record(1, 'old', 1), record(2, 'new-1'), record(3, 'new-2'), record(4, 'latest')], { maxItems: 2, maxChars: 100 });
  assert.deepEqual(result.included.map((item) => item.sequence), [1, 4]);
  assert.equal(result.omittedCount, 2);
});

test('超过活跃窗口时返回旧记录作为 archive 候选', () => {
  const candidates = selectArchiveCandidates([record(1, 'a'), record(2, 'bb'), record(3, 'ccc'), record(4, 'dddd')], { maxActiveItems: 2, maxActiveChars: 100 });
  assert.deepEqual(candidates.map((item) => item.sequence), [1, 2]);
});

test('旧版 MemoryRecord 仍可解析，新语义字段采用可选兼容扩展', () => {
  const parsed = MemoryRecordSchema.parse({ ...record(1, 'experience'), status: undefined });
  assert.equal(parsed.memoryType, undefined);
  assert.equal(parsed.status, undefined);
});

test('Memory 记录支持 episodic / semantic / procedural 分类与验证元数据', () => {
  const parsed = MemoryRecordSchema.parse({
    ...record(1, 'Use UTC dates for this source.'),
    memoryType: 'procedural',
    status: 'confirmed',
    confidence: 0.95,
    lastValidatedAt: '2026-11-11T00:00:00.000Z',
  });
  assert.equal(parsed.memoryType, 'procedural');
  assert.equal(parsed.confidence, 0.95);
});

test('记忆关系保留关系类型和来源引用', () => {
  const relation = MemoryRelationshipSchema.parse({
    id: 'rel-1', scope: 'session-1', fromId: 'm-2', toId: 'm-1',
    kind: 'derived_from', createdAt: '2026-11-11T00:00:00.000Z',
    sourceRefs: ['trace:tr-1:event:ev-1'],
  });
  assert.equal(relation.kind, 'derived_from');
});

test('Consolidation 只产生经过 Schema 验证的提议，不直接修改权威记忆', () => {
  const proposal = MemoryChangeProposalSchema.parse({
    id: 'proposal-1', scope: 'session-1', operation: 'add', targetRecordIds: [],
    proposedRecord: record(5, 'Check the source timezone first.'),
    rationale: 'Repeatedly useful across tasks.',
    evidenceRefs: ['trace:tr-1:event:ev-1'],
    createdAt: '2026-11-11T00:00:00.000Z',
  });
  assert.equal(proposal.operation, 'add');
  assert.throws(() => MemoryChangeProposalSchema.parse({
    id: 'bad', scope: 'session-1', operation: 'update', rationale: 'missing target',
    createdAt: '2026-11-11T00:00:00.000Z',
  }));
});

test('working memory excludes archived, superseded and expired records', () => {
  const now = '2026-11-11T00:00:00.000Z';
  const archived = { ...record(5, 'archived'), lifecycle: 'archived' as const };
  const superseded = { ...record(6, 'old rule'), status: 'superseded' as const };
  const expired = { ...record(7, 'expired'), validUntil: '2026-11-10T00:00:00.000Z' };
  const current = { ...record(8, 'current'), status: 'confirmed' as const };
  const result = buildWorkingMemory([archived, superseded, expired, current], {
    maxItems: 10, maxChars: 1000, now,
  });
  assert.deepEqual(result.included.map((item) => item.id), ['m-8']);
  assert.equal(result.omittedCount, 3);
});

test('consolidation result envelope validates proposals and processed source coverage', () => {
  const result = parseMemoryConsolidationResult({
    proposals: [{
      id: 'p1', scope: 'session-1', operation: 'add', targetRecordIds: [],
      proposedRecord: record(9, 'Reusable rule.'),
      rationale: 'Repeated evidence.',
      evidenceRefs: ['trace:tr-1:event:ev-9'],
      createdAt: '2026-11-11T00:00:00.000Z',
    }],
    processedRecordIds: ['m-1', 'm-2'],
    notes: [],
  });
  assert.deepEqual(result.processedRecordIds, ['m-1', 'm-2']);
  assert.throws(() => parseMemoryConsolidationResult({ proposals: [], processedRecordIds: 'bad', notes: [] }));
});
