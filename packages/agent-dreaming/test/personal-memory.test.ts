import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDreamingStore } from '../src/sqlite-store.js';

test('one personal scope consolidates records from different source applications', async () => {
  const store = new SqliteDreamingStore({ filename: ':memory:', embeddingProvider: false });
  try {
    const chatgptOrigin = { system: 'openai', application: 'chatgpt-web', channel: 'conversation' };
    const claudeOrigin = { system: 'anthropic', application: 'claude-desktop', channel: 'conversation' };

    await store.appendExperience({
      id: 'chatgpt:1',
      scope: 'person:42',
      content: 'The person repeatedly asks for concise architecture reviews.',
      createdAt: '2026-11-25T10:00:00.000Z',
      sourceRefs: ['evidence:chatgpt:1'],
      origin: chatgptOrigin,
    });
    await store.appendExperience({
      id: 'claude:1',
      scope: 'person:42',
      content: 'The person again rejects unnecessary abstraction in a design discussion.',
      createdAt: '2026-11-26T10:00:00.000Z',
      sourceRefs: ['evidence:claude:1'],
      origin: claudeOrigin,
    });
    await store.appendExperience({
      id: 'other-person:1',
      scope: 'person:99',
      content: 'A different person's experience.',
      createdAt: '2026-11-26T10:00:00.000Z',
      sourceRefs: ['evidence:other:1'],
    });

    const page = await store.loadExperiences({ scope: 'person:42', afterSequence: 0, limit: 10 });
    assert.deepEqual(page.items.map((item) => item.id), ['chatgpt:1', 'claude:1']);
    assert.deepEqual(page.items.map((item) => item.origin), [chatgptOrigin, claudeOrigin]);

    await store.putEvidence('person:42', {
      ref: 'evidence:chatgpt:1',
      kind: 'conversation',
      content: 'Original conversation evidence.',
      origin: chatgptOrigin,
    });
    assert.deepEqual(
      (await store.resolve({ scope: 'person:42', refs: ['evidence:chatgpt:1'] }))[0]?.origin,
      chatgptOrigin,
    );

    await store.upsertMemory({
      id: 'memory:preference:1',
      scope: 'person:42',
      content: 'Prefers practical designs without unnecessary abstraction.',
      memoryType: 'preference',
      status: 'candidate',
      importance: 0.9,
      sourceRefs: ['evidence:chatgpt:1', 'evidence:claude:1'],
    });
    assert.equal((await store.listMemories('person:42'))[0]?.memoryType, 'preference');
    assert.equal((await store.listMemories('person:99')).length, 0);
  } finally {
    await store.close();
  }
});
