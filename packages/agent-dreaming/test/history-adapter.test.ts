import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDreamingStore } from '../src/sqlite-store.js';
import type { DreamingHistorySourceAdapter, DreamingHistoryRecord } from '../src/types.js';

function setup(options: Partial<ConstructorParameters<typeof SqliteDreamingStore>[0]> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreaming-history-adapter-'));
  const store = new SqliteDreamingStore({
    filename: path.join(dir, 'db.sqlite'),
    embeddingProvider: false,
    ...options,
  });
  return {
    store,
    close: async () => {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function addEvidence(store: SqliteDreamingStore, ref: string, content = 'Archived source record.') {
  await store.putEvidence('alice', { ref, kind: 'transcript', content });
}

function record(overrides: Partial<DreamingHistoryRecord> = {}): DreamingHistoryRecord {
  return {
    id: 'history:payment-retry',
    scope: 'alice',
    content: 'The payment recovery discussion requires reusing the idempotency key and checking the durable transaction state before a retry.',
    createdAt: '2026-11-26T10:00:00.000Z',
    sourceRefs: ['evidence:history'],
    origin: { system: 'conversation-archive', application: 'support-console', recordId: 'trace:42' },
    ...overrides,
  };
}

function contextRequest(task = 'How should payment retries preserve idempotency?') {
  return {
    scope: 'alice',
    task,
    budget: { maxUnits: 8_000 },
  };
}

test('history adapter is queried only as a fallback and results are re-ranked and evidence-checked in-package', async () => {
  let received: { scope: string; query: string; task: string; limit: number } | undefined;
  const adapter: DreamingHistorySourceAdapter = {
    async search(input) {
      received = input;
      return [
        record(),
        record({
          id: 'history:irrelevant',
          content: 'A discussion about gardening, soil and irrigation schedules.',
          sourceRefs: ['evidence:irrelevant'],
        }),
        record({
          id: 'history:missing-evidence',
          content: 'Payment idempotency and retry policy were reviewed.',
          sourceRefs: ['evidence:not-indexed'],
        }),
      ];
    },
  };
  const x = setup({ historySourceAdapter: adapter, maxHistoryItems: 3 });
  try {
    await addEvidence(x.store, 'evidence:history');
    await addEvidence(x.store, 'evidence:irrelevant');
    const result = await x.store.buildContext(contextRequest());

    assert.deepEqual(received, {
      scope: 'alice',
      query: 'How should payment retries preserve idempotency?',
      task: 'How should payment retries preserve idempotency?',
      limit: 3,
    });
    const hit = result.items.find((item) => item.id === 'history:payment-retry');
    assert.equal(hit?.sourceType, 'history');
    assert.ok((hit?.score ?? 0) > 0, 'score is calculated by the package');
    assert.equal(hit?.origin?.system, 'conversation-archive');
    assert.equal(hit?.sourceRefs[0], 'evidence:history');
    assert.equal(result.items.some((item) => item.id === 'history:irrelevant'), false);
    assert.equal(result.items.some((item) => item.id === 'history:missing-evidence'), false);
    assert.match(result.text, /Related historical transcripts and traces/);
  } finally {
    await x.close();
  }
});

test('history adapter is not invoked when local retrieval already meets the threshold', async () => {
  let calls = 0;
  const adapter: DreamingHistorySourceAdapter = {
    async search() {
      calls += 1;
      return [record()];
    },
  };
  const x = setup({ historySourceAdapter: adapter, historyFallbackMinLocalHits: 2 });
  try {
    await x.store.appendExperience({
      id: 'experience:1', scope: 'alice',
      content: 'Payment retry uses the same idempotency key.',
      createdAt: new Date().toISOString(), sourceRefs: [],
    });
    await x.store.appendExperience({
      id: 'experience:2', scope: 'alice',
      content: 'Payment recovery checks durable transaction state.',
      createdAt: new Date().toISOString(), sourceRefs: [],
    });
    const result = await x.store.buildContext(contextRequest());
    assert.equal(calls, 0);
    assert.equal(result.items.some((item) => item.sourceType === 'history'), false);
    assert.ok(result.items.filter((item) => item.sourceType === 'experience').length >= 2);
  } finally {
    await x.close();
  }
});

test('history adapter fails closed on cross-scope or malformed records', async () => {
  const adapter: DreamingHistorySourceAdapter = {
    async search() {
      return [record({ scope: 'bob' })];
    },
  };
  const x = setup({ historySourceAdapter: adapter });
  try {
    await addEvidence(x.store, 'evidence:history');
    await assert.rejects(
      () => x.store.buildContext(contextRequest()),
      /invalid or cross-scope historical record/,
    );
  } finally {
    await x.close();
  }
});

test('history item limits are hard bounded and context budgets still apply', async () => {
  let requestedLimit = 0;
  const adapter: DreamingHistorySourceAdapter = {
    async search(input) {
      requestedLimit = input.limit;
      return [record({
        content: 'Payment retry context with idempotency and durable outcome reconciliation. '.repeat(30),
      })];
    },
  };
  const x = setup({ historySourceAdapter: adapter, maxHistoryItems: 10 });
  try {
    await addEvidence(x.store, 'evidence:history');
    const result = await x.store.buildContext({
      ...contextRequest(),
      maxItemChars: 200,
      budget: { maxUnits: 1_200, maxItems: 2 },
    });
    assert.equal(requestedLimit, 10);
    const hit = result.items.find((item) => item.sourceType === 'history');
    assert.ok(hit);
    assert.ok(hit.text.length <= 200);
    assert.ok(result.budget.usedUnits <= result.budget.availableUnits || result.budget.exceeded);
  } finally {
    await x.close();
  }
});

test('history adapter configuration is validated at construction', async () => {
  const adapter: DreamingHistorySourceAdapter = { async search() { return []; } };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreaming-history-options-'));
  try {
    assert.throws(() => new SqliteDreamingStore({
      filename: path.join(dir, 'invalid-a.sqlite'),
      embeddingProvider: false,
      historyFallbackMinLocalHits: -1,
      historySourceAdapter: adapter,
    }), /historyFallbackMinLocalHits/);
    assert.throws(() => new SqliteDreamingStore({
      filename: path.join(dir, 'invalid-b.sqlite'),
      embeddingProvider: false,
      maxHistoryItems: 11,
      historySourceAdapter: adapter,
    }), /maxHistoryItems/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
