import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDreamingStore } from '../src/sqlite-store.js';

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreaming-knowledge-'));
  const store = new SqliteDreamingStore({ filename: path.join(dir, 'db.sqlite'), embeddingProvider: false });
  return {
    store,
    close: async () => {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const page = (overrides: Record<string, unknown> = {}) => ({
  id: 'knowledge:payments', scope: 'alice', title: 'Payment recovery',
  summary: 'Retry and recovery behavior for payment processing.',
  content: 'A payment retry must use an idempotency key. Recovery checks the durable transaction state before reissuing work.',
  tags: ['payments', 'recovery'],
  sourceRefs: ['evidence:payment-design'],
  ...overrides,
});

test('Knowledge page save is idempotent and revision preserves the exact previous snapshot', async () => {
  const x = setup();
  try {
    await x.store.putEvidence('alice', {
      ref: 'evidence:payment-design', kind: 'document',
      content: 'Payment design requires an idempotency key and a durable transaction state.',
    });
    const first = await x.store.saveKnowledgePage(page());
    assert.equal(first.version, 1);
    const repeated = await x.store.saveKnowledgePage(page());
    assert.equal(repeated.version, 1);
    assert.equal((await x.store.listKnowledgePageVersions({ scope: 'alice', pageId: first.id })).length, 0);

    const revised = await x.store.saveKnowledgePage(page({
      content: 'A payment retry must use an idempotency key. Recovery verifies durable transaction state and records the final outcome.',
      reason: 'Added evidence about terminal transaction outcomes',
    }));
    assert.equal(revised.version, 2);
    const history = await x.store.listKnowledgePageVersions({ scope: 'alice', pageId: first.id });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.version, 1);
    assert.equal(history[0]?.snapshot.content, first.content);
  } finally {
    await x.close();
  }
});

test('Knowledge page provenance and scope are enforced', async () => {
  const x = setup();
  try {
    await x.store.putEvidence('alice', {
      ref: 'evidence:payment-design', kind: 'document', content: 'Alice source document.',
    });
    await assert.rejects(() => x.store.saveKnowledgePage(page({
      sourceRefs: ['evidence:outside-scope'],
    })), /provenance is missing or outside scope/);
    await x.store.saveKnowledgePage(page());
    await assert.rejects(() => x.store.saveKnowledgePage(page({ scope: 'bob' })), /belongs to another scope/);
    assert.equal((await x.store.listKnowledgePages({ scope: 'bob' })).length, 0);
  } finally {
    await x.close();
  }
});

test('Knowledge links require two same-scope pages and source evidence', async () => {
  const x = setup();
  try {
    await x.store.putEvidence('alice', {
      ref: 'evidence:payment-design', kind: 'document', content: 'Payment design.',
    });
    await x.store.saveKnowledgePage(page());
    await x.store.saveKnowledgePage(page({
      id: 'knowledge:idempotency',
      title: 'Idempotency',
      summary: 'Prevent duplicate execution.',
      content: 'An idempotency key makes repeated requests safe.',
    }));
    const link = await x.store.appendKnowledgeLink({
      id: 'link:1', scope: 'alice', fromId: 'knowledge:payments',
      toId: 'knowledge:idempotency', kind: 'related-to',
      sourceRefs: ['evidence:payment-design'],
    });
    assert.equal(link.kind, 'related-to');
    assert.equal((await x.store.listKnowledgeLinks({ scope: 'alice', pageIds: ['knowledge:payments'] })).length, 1);
    await assert.rejects(() => x.store.appendKnowledgeLink({
      id: 'link:cross-scope', scope: 'bob', fromId: 'knowledge:payments',
      toId: 'knowledge:idempotency', kind: 'related-to',
      sourceRefs: ['evidence:payment-design'],
    }), /both exist in the same scope/);
  } finally {
    await x.close();
  }
});

test('Knowledge search supports English and CJK, respects scope and active status', async () => {
  const x = setup();
  try {
    await x.store.putEvidence('alice', {
      ref: 'evidence:payment-design', kind: 'document', content: 'Payment recovery and idempotent processing.',
    });
    await x.store.saveKnowledgePage(page());
    await x.store.saveKnowledgePage(page({
      id: 'knowledge:draft', title: 'Draft recovery', summary: 'not public',
      content: 'Payment recovery draft content.', status: 'draft',
    }));
    const english = await x.store.searchKnowledge({ scope: 'alice', query: 'payment retry idempotency' });
    assert.equal(english[0]?.id, 'knowledge:payments');
    const cjk = await x.store.saveKnowledgePage(page({
      id: 'knowledge:cjk', title: '支付恢复', summary: '支付重试与故障恢复',
      content: '支付流程需要幂等键，并且在恢复前检查交易状态。',
      tags: ['支付', '恢复'],
    }));
    const cjkHits = await x.store.searchKnowledge({ scope: 'alice', query: '支付恢复' });
    assert.ok(cjkHits.some((hit) => hit.id === cjk.id));
    assert.equal((await x.store.searchKnowledge({ scope: 'bob', query: '支付恢复' })).length, 0);
    assert.equal((await x.store.searchKnowledge({ scope: 'alice', query: 'recovery' })).some((hit) => hit.id === 'knowledge:draft'), false);
    assert.equal((await x.store.searchKnowledge({ scope: 'alice', query: 'recovery', includeInactive: true })).some((hit) => hit.id === 'knowledge:draft'), true);
  } finally {
    await x.close();
  }
});
