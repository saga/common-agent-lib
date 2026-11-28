import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDreamingStore } from '../src/sqlite-store.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
      content: 'A different persons experience.',
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


test('opens an existing v2 database and adds the new personal-memory fields without losing data', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreaming-v2-migration-'));
  const filename = path.join(dir, 'dreaming.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE experiences(
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, sequence INTEGER NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL, refs TEXT NOT NULL,
      metadata TEXT NOT NULL, reviewed_at TEXT, UNIQUE(scope, sequence)
    );
    CREATE TABLE memories(
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
      importance REAL NOT NULL, refs TEXT NOT NULL, last_validated_at TEXT, valid_until TEXT,
      confidence REAL, metadata TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE evidence(
      ref TEXT PRIMARY KEY, scope TEXT NOT NULL, content TEXT NOT NULL,
      kind TEXT NOT NULL, created_at TEXT, metadata TEXT NOT NULL
    );
  `);
  legacy.prepare('INSERT INTO experiences(id,scope,sequence,content,created_at,refs,metadata) VALUES(?,?,?,?,?,?,?)')
    .run('legacy-exp', 'person:legacy', 1, 'Legacy observation', '2026-11-20T00:00:00.000Z', '["legacy-ref"]', '{}');
  legacy.prepare('INSERT INTO memories(id,scope,content,status,importance,refs,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('legacy-memory', 'person:legacy', 'Legacy memory', 'confirmed', 0.8, '["legacy-ref"]', '{}', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z');
  legacy.prepare('INSERT INTO evidence(ref,scope,content,kind,metadata) VALUES(?,?,?,?,?)')
    .run('legacy-ref', 'person:legacy', 'Legacy source', 'note', '{}');
  legacy.close();

  const store = new SqliteDreamingStore({ filename, embeddingProvider: false });
  try {
    const experience = (await store.loadExperiences({
      scope: 'person:legacy', afterSequence: 0, limit: 10,
    })).items[0];
    const memory = (await store.listMemories('person:legacy'))[0];
    const evidence = (await store.resolve({ scope: 'person:legacy', refs: ['legacy-ref'] }))[0];

    assert.equal(experience?.content, 'Legacy observation');
    assert.equal(experience?.origin, undefined);
    assert.equal(memory?.content, 'Legacy memory');
    assert.equal(memory?.memoryType, undefined);
    assert.equal(evidence?.content, 'Legacy source');
    assert.equal(evidence?.origin, undefined);

    await store.upsertMemory({
      id: 'new-memory', scope: 'person:legacy', content: 'New preference',
      memoryType: 'preference', status: 'candidate', importance: 0.9, sourceRefs: ['legacy-ref'],
    });
    assert.equal((await store.listMemories('person:legacy')).find((item) => item.id === 'new-memory')?.memoryType, 'preference');
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
