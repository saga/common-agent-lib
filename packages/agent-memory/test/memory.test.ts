import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWorkingMemory, selectArchiveCandidates, type MemoryRecord } from '../src/index.js';

function record(sequence: number, content: string, importance = 0.5): MemoryRecord {
  return { id: 'm-' + sequence, sequence, scope: 'session-1', kind: 'message', content, createdAt: new Date(2026, 0, sequence).toISOString(), lifecycle: 'active', importance, tags: [], sourceRefs: [], metadata: {} };
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