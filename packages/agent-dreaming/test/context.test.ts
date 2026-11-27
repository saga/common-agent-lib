import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDreamingStore } from '../src/sqlite-store.js';

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreaming-context-'));
  const store = new SqliteDreamingStore({ filename: path.join(dir, 'db.sqlite'), embeddingProvider: false });
  return {
    store,
    close: async () => {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('task context includes explicit memory and relevant evidence but excludes candidate and expired memories', async () => {
  const x = setup();
  try {
    await x.store.putEvidence('alice', {
      ref: 'source:architecture', kind: 'document',
      content: 'The architecture decision requires idempotent writes and durable checkpoints.',
    });
    await x.store.appendExperience({
      id: 'experience:architecture', scope: 'alice',
      content: 'We decided that architecture writes must be idempotent.',
      createdAt: '2026-11-27T00:00:00.000Z',
      sourceRefs: ['source:architecture'],
    });
    await x.store.upsertMemory({
      id: 'memory:explicit', scope: 'alice',
      content: '记住：技术设计必须优先保证幂等性和可恢复性。',
      status: 'confirmed', authority: 'user-explicit', importance: 1,
      sourceRefs: ['source:architecture'], memoryType: 'constraint',
    });
    await x.store.upsertMemory({
      id: 'memory:candidate', scope: 'alice',
      content: 'Architecture uses a temporary experimental cache.',
      status: 'candidate', importance: 1, sourceRefs: ['source:architecture'],
    });
    await x.store.upsertMemory({
      id: 'memory:expired', scope: 'alice',
      content: 'Architecture uses an expired implementation detail.',
      status: 'confirmed', importance: 1, validUntil: '2020-01-01T00:00:00.000Z',
      sourceRefs: ['source:architecture'],
    });

    const result = await x.store.buildContext({
      scope: 'alice',
      task: 'Design architecture recovery and idempotent writes.',
      budget: { maxUnits: 8_000 },
    });

    assert.match(result.text, /memory:explicit/);
    assert.match(result.text, /experience:architecture/);
    assert.match(result.text, /source:architecture/);
    assert.doesNotMatch(result.text, /memory:candidate/);
    assert.doesNotMatch(result.text, /memory:expired/);
    assert.equal(result.items.some((item) => item.authority === 'user-explicit'), true);
    assert.ok(result.hash.length === 64);
  } finally {
    await x.close();
  }
});

test('CJK history search works and every search is scope isolated', async () => {
  const x = setup();
  try {
    await x.store.appendExperience({
      id: 'alice:1', scope: 'alice', content: '我们讨论了系统设计和故障恢复策略。',
      createdAt: new Date().toISOString(), sourceRefs: [],
    });
    await x.store.appendExperience({
      id: 'bob:1', scope: 'bob', content: '我们讨论了系统设计和数据库优化。',
      createdAt: new Date().toISOString(), sourceRefs: [],
    });

    const alice = await x.store.search({ scope: 'alice', query: '系统设计', sourceTypes: ['experience'] });
    const bob = await x.store.search({ scope: 'bob', query: '系统设计', sourceTypes: ['experience'] });
    assert.deepEqual(alice.map((item) => item.id), ['alice:1']);
    assert.deepEqual(bob.map((item) => item.id), ['bob:1']);
  } finally {
    await x.close();
  }
});

test('explicit memories remain included when required context exceeds budget and overflow is reported', async () => {
  const x = setup();
  try {
    await x.store.upsertMemory({
      id: 'memory:must-keep', scope: 'alice',
      content: 'Never omit this explicit user instruction, even when context is constrained.',
      status: 'confirmed', authority: 'user-explicit', importance: 1, sourceRefs: [],
    });
    const result = await x.store.buildContext({
      scope: 'alice', task: 'Unrelated task',
      budget: { maxUnits: 10 },
    });
    assert.equal(result.items.some((item) => item.id === 'memory:must-keep'), true);
    assert.equal(result.budget.exceeded, true);
    assert.ok(result.budget.overflowUnits > 0);
  } finally {
    await x.close();
  }
});

test('context builder excludes duplicate content and reports omitted items', async () => {
  const x = setup();
  try {
    await x.store.appendExperience({
      id: 'experience:1', scope: 'alice',
      content: 'Use durable checkpoints for reliable recovery.',
      createdAt: new Date().toISOString(), sourceRefs: [],
    });
    await x.store.putEvidence('alice', {
      ref: 'source:1', kind: 'note',
      content: 'Use durable checkpoints for reliable recovery.',
    });
    const result = await x.store.buildContext({
      scope: 'alice', task: 'durable checkpoints recovery',
      budget: { maxUnits: 4_000 },
    });
    assert.ok(result.omittedItems.some((item) => item.reason === 'duplicate'));
  } finally {
    await x.close();
  }
});


test('context feedback records the exact included memory revision and rejects unrelated memories', async () => {
  const x = setup();
  try {
    await x.store.upsertMemory({
      id: 'memory:feedback', scope: 'alice',
      content: 'Architecture decisions should preserve durable checkpoints.',
      status: 'confirmed', importance: 0.9, sourceRefs: ['source:feedback'],
      memoryType: 'preference',
    });
    const context = await x.store.buildContext({
      scope: 'alice', task: 'architecture durable checkpoints',
      budget: { maxUnits: 4_000 },
    });
    const item = context.items.find((candidate) => candidate.id === 'memory:feedback');
    assert.ok(item?.revision);
    await x.store.recordContextFeedback({
      id: 'feedback:task-1:memory-feedback',
      context,
      memoryId: 'memory:feedback',
      taskId: 'task:1',
      outcome: 'useful',
      occurredAt: '2026-11-28T00:00:00.000Z',
    });
    const events = await x.store.loadFeedback({
      scope: 'alice', memoryIds: ['memory:feedback'], since: '2026-11-01T00:00:00.000Z', limit: 10,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.contextId, context.id);
    assert.equal(events[0]?.contextHash, context.hash);
    assert.equal(events[0]?.memoryRevision, item?.revision);
    await assert.rejects(() => x.store.recordContextFeedback({
      id: 'feedback:task-1:unrelated',
      context,
      memoryId: 'memory:not-in-context',
      taskId: 'task:1',
      outcome: 'useful',
    }), /only be recorded for a memory included/);
  } finally {
    await x.close();
  }
});
