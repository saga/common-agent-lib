import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDreamingStore } from '../src/sqlite-store.js';

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreaming-manifest-'));
  const store = new SqliteDreamingStore({ filename: path.join(dir, 'db.sqlite'), embeddingProvider: false });
  return {
    store,
    close: async () => {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Memory Manifest persists by scope, stays versioned and rebuilds only after source changes', async () => {
  const x = setup();
  try {
    await x.store.applyUserDirective({
      id: 'directive:1', scope: 'alice', kind: 'remember',
      instruction: 'Always preserve idempotency keys in payment recovery examples.',
    });
    const first = await x.store.getMemoryManifest('alice');
    assert.equal(first.version, 1);
    assert.equal(first.stale, false);
    assert.ok(first.content.includes('idempotency keys'));

    const unchanged = await x.store.getMemoryManifest('alice');
    assert.equal(unchanged.version, 1);
    assert.equal(unchanged.hash, first.hash);

    await x.store.upsertMemory({
      id: 'memory:important', scope: 'alice',
      content: 'Prefer durable transaction state over retry counters.',
      status: 'confirmed', importance: 0.9, sourceRefs: ['evidence:one'],
    });
    const rebuilt = await x.store.getMemoryManifest('alice');
    assert.equal(rebuilt.version, 2);
    assert.notEqual(rebuilt.hash, first.hash);
    assert.ok(rebuilt.content.includes('durable transaction state'));

    const otherScope = await x.store.getMemoryManifest('bob');
    assert.equal(otherScope.itemIds.length, 0);
    assert.notEqual(otherScope.hash, rebuilt.hash);
  } finally {
    await x.close();
  }
});

test('Memory Manifest indexes active Knowledge pages and respects its hard size bound', async () => {
  const x = setup();
  try {
    await x.store.putEvidence('alice', {
      ref: 'evidence:one', kind: 'document', content: 'Payment recovery design.',
    });
    await x.store.saveKnowledgePage({
      id: 'knowledge:payments', scope: 'alice', title: 'Payment recovery',
      summary: 'Safe retries with idempotency.',
      content: 'A long-lived reusable explanation for payment recovery.',
      sourceRefs: ['evidence:one'], tags: ['payments'],
    });
    const manifest = await x.store.getMemoryManifest('alice');
    assert.ok(manifest.itemIds.includes('knowledge:payments'));
    assert.ok(manifest.content.length <= 16_000);
  } finally {
    await x.close();
  }
});
