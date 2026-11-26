import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteVectorIndex, type EmbeddingProvider } from '../src/retrieval.js';
import { SqliteDreamingScheduler } from '../src/scheduler.js';
import { RoleBasedDreamingAuthorization, assertDreamingAuthorized } from '../src/authorization.js';
import { SqliteDreamingStore } from '../src/sqlite-store.js';

test('SQLite vector index persists vectors and enforces scope isolation', async () => {
  const db = new DatabaseSync(':memory:');
  const provider: EmbeddingProvider = {
    id: 'test-v1',
    async embed(texts) {
      return texts.map((text) => text.includes('architecture') ? [1, 0] : [0, 1]);
    },
  };
  const index = new SqliteVectorIndex(db, provider);
  await index.index({ scope: 'alice', memoryId: 'm1', content: 'architecture decisions' });
  await index.index({ scope: 'bob', memoryId: 'm2', content: 'cooking recipes' });
  assert.deepEqual(await index.search({ scope: 'alice', query: 'architecture', limit: 5 }), [
    { scope: 'alice', memoryId: 'm1', score: 1 },
  ]);
  assert.deepEqual(await index.search({ scope: 'alice', query: 'cooking', limit: 5 }), []);
  db.close();
});

test('durable scheduler claims jobs exclusively, retries failures and recovers expired leases', () => {
  const db = new DatabaseSync(':memory:');
  let now = 1_000;
  const scheduler = new SqliteDreamingScheduler(db, {
    leaseMs: 100,
    retryBaseMs: 50,
    maxAttempts: 3,
    clock: () => now,
  });
  scheduler.schedule({ id: 'job-1', scope: 'alice' });
  assert.equal(scheduler.claim('worker-a').length, 1);
  assert.equal(scheduler.claim('worker-b').length, 0);
  scheduler.schedule({ id: 'job-1', scope: 'alice' });
  assert.equal(scheduler.claim('worker-b').length, 0, 're-registering a recurring job must not steal its lease');
  now += 50;
  assert.equal(scheduler.renew({ id: 'job-1', owner: 'worker-a' }), true);
  now += 101;
  assert.equal(scheduler.claim('worker-b').length, 0, 'renewal extends the lease');
  now += 50;
  assert.equal(scheduler.claim('worker-b')[0]?.id, 'job-1');
  assert.equal(scheduler.fail({ id: 'job-1', owner: 'worker-b', error: 'temporary' }), true);
  assert.equal(scheduler.claim('worker-c').length, 0);
  now += 50;
  assert.equal(scheduler.claim('worker-c')[0]?.id, 'job-1');
  assert.equal(scheduler.complete({ id: 'job-1', owner: 'worker-c' }), true);
  assert.equal(scheduler.claim('worker-d').length, 0);
  db.close();
});

test('authorization is default deny and caller role claims cannot elevate permissions', async () => {
  const policy = new RoleBasedDreamingAuthorization({
    'reviewer:1': { 'scope:1': ['reviewer'] },
  });
  await assertDreamingAuthorized(policy, {
    actor: { subject: 'reviewer:1' }, scope: 'scope:1', action: 'review:resolve',
  });
  await assert.rejects(() => assertDreamingAuthorized(policy, {
    actor: { subject: 'unknown', roles: ['admin'] }, scope: 'scope:1', action: 'review:resolve',
  }), /Not authorized/);
  await assert.rejects(() => assertDreamingAuthorized(policy, {
    actor: { subject: 'reviewer:1' }, scope: 'scope:1', action: 'memory:write',
  }), /Not authorized/);
});

test('SQLite memory recall uses built-in vector ranking with an injected embedding model', async () => {
  const dbDir = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await dbDir.mkdtemp(path.join(os.tmpdir(), 'dreaming-vector-'));
  const store = new SqliteDreamingStore({
    filename: path.join(dir, 'db.sqlite'),
    embeddingProvider: {
      id: 'semantic-test-v1',
      async embed(texts) {
        return texts.map((text) => /architecture|system design/i.test(text) ? [1, 0] : [0, 1]);
      },
    },
  });
  try {
    await store.appendExperience({
      id: 'experience:architecture', scope: 'scope:1',
      content: 'We discussed architecture and system design.',
      createdAt: new Date().toISOString(), sourceRefs: [],
    });
    await store.upsertMemory({
      id: 'memory:relevant', scope: 'scope:1', content: 'Architecture decision records explain system design.',
      status: 'confirmed', importance: 0.2, sourceRefs: [],
    });
    await store.upsertMemory({
      id: 'memory:unrelated', scope: 'scope:1', content: 'Favorite recipes and cooking tips.',
      status: 'confirmed', importance: 0.99, sourceRefs: [],
    });
    const result = await store.loadMemories({
      scope: 'scope:1', experienceIds: ['experience:architecture'], limit: 1,
    });
    assert.equal(result[0]?.id, 'memory:relevant');
  } finally {
    await store.close();
    await dbDir.rm(dir, { recursive: true, force: true });
  }
});

test('scheduler exposes exhausted jobs and supports explicit retry', () => {
  const db = new DatabaseSync(':memory:');
  let now = 10_000;
  const scheduler = new SqliteDreamingScheduler(db, {
    leaseMs: 100, retryBaseMs: 10, maxAttempts: 1, clock: () => now,
  });
  scheduler.schedule({ id: 'job-dead', scope: 'alice' });
  scheduler.claim('worker');
  assert.equal(scheduler.fail({ id: 'job-dead', owner: 'worker', error: 'permanent' }), true);
  assert.equal(scheduler.claim('worker').length, 0);
  assert.equal(scheduler.listDeadLetters()[0]?.id, 'job-dead');
  assert.equal(scheduler.retry('job-dead'), true);
  assert.equal(scheduler.claim('worker')[0]?.id, 'job-dead');
  db.close();
});
