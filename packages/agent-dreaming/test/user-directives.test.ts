import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectUserMemoryDirective,
  DreamingEngine,
  SqliteDreamingStore,
} from '../src/index.js';

test('detects direct remember and avoid instructions in Chinese and English', () => {
  assert.deepEqual(detectUserMemoryDirective('记住我更喜欢简洁、直接的技术解释'), {
    kind: 'remember',
    instruction: '我更喜欢简洁、直接的技术解释',
    memoryType: 'preference',
  });
  assert.deepEqual(detectUserMemoryDirective('不要再犯把推测当成已验证事实的错误'), {
    kind: 'avoid',
    instruction: '把推测当成已验证事实的错误',
    memoryType: 'constraint',
  });
  assert.deepEqual(detectUserMemoryDirective('下次不能在没有检查源代码时声称已经完成'), {
    kind: 'avoid',
    instruction: '在没有检查源代码时声称已经完成',
    memoryType: 'constraint',
  });
  assert.equal(detectUserMemoryDirective("Remember that I prefer concise answers")?.kind, 'remember');
  assert.equal(detectUserMemoryDirective("Please remember that I prefer concise answers")?.kind, 'remember');
  assert.equal(detectUserMemoryDirective("Don't use unverified assumptions again")?.kind, 'avoid');
});

test('does not interpret ordinary conversation or secrets as memory directives', () => {
  assert.equal(detectUserMemoryDirective('这个方案可以再简单一些'), undefined);
  assert.equal(detectUserMemoryDirective('记住我的密码是 example-password'), undefined);
  assert.equal(detectUserMemoryDirective('记住'), undefined);
});

test('explicit user instruction is written immediately without calling the model', async () => {
  const store = new SqliteDreamingStore({ filename: ':memory:', embeddingProvider: false });
  let modelCalls = 0;
  const engine = new DreamingEngine({
    id: 'must-not-run',
    async generate() {
      modelCalls += 1;
      throw new Error('Explicit directives must not invoke the model.');
    },
  }, store, store, { scopes: ['person:42'] });

  try {
    const input = {
      id: 'chat-message-100',
      scope: 'person:42',
      text: '记住我希望代码审查直接指出问题，不要先写泛泛的开场',
      origin: { system: 'copilot', application: 'desktop-chat', channel: 'conversation' },
    };
    const first = await engine.applyUserMessage(input);
    const retry = await engine.applyUserMessage(input);

    assert.ok(first);
    assert.ok(retry);
    assert.equal(first.directive.kind, 'remember');
    assert.equal(first.memory.status, 'confirmed');
    assert.equal(first.memory.authority, 'user-explicit');
    assert.equal(first.memory.memoryType, 'preference');
    assert.equal(first.memory.importance, 1);
    assert.equal(first.memory.id, retry.memory.id);
    assert.equal(first.memory.sourceRefs.length, 1);
    const recall = await store.loadMemories({
      scope: 'person:42', experienceIds: [], reviewBefore: '2020-01-01T00:00:00.000Z',
      expiredBefore: '2026-11-27T00:00:00.000Z', limit: 1,
    });
    assert.equal(recall[0]?.authority, 'user-explicit');
    assert.equal(modelCalls, 0);
    assert.equal((await store.listReviewQueue({ scope: 'person:42' })).length, 0);
  } finally {
    await engine.shutdown();
    await store.close();
  }
});

test('avoid directives become high-priority constraints', async () => {
  const store = new SqliteDreamingStore({ filename: ':memory:', embeddingProvider: false });
  const engine = new DreamingEngine(
    { id: 'unused', async generate() { throw new Error('Should not be called.'); } },
    store, store, { scopes: ['person:42'] },
  );
  try {
    const result = await engine.applyUserMessage({
      id: 'chat-message-101',
      scope: 'person:42',
      text: '下次不能未经验证就说 API 已经支持这个功能',
    });
    assert.ok(result);
    assert.equal(result.directive.kind, 'avoid');
    assert.equal(result.memory.memoryType, 'constraint');
    assert.equal(result.memory.authority, 'user-explicit');
    assert.match(result.memory.content, /Avoid repeating this behavior/);
    assert.equal((await store.resolve({ scope: 'person:42', refs: result.memory.sourceRefs })).length, 1);
  } finally {
    await engine.shutdown();
    await store.close();
  }
});

test('derived Dreaming proposals cannot overwrite or supersede user-explicit memories', async () => {
  const store = new SqliteDreamingStore({ filename: ':memory:', embeddingProvider: false });
  const engine = new DreamingEngine(
    { id: 'unused', async generate() { throw new Error('Should not be called.'); } },
    store, store, { scopes: ['person:42'] },
  );
  try {
    const result = await engine.applyUserMessage({
      id: 'chat-message-102',
      scope: 'person:42',
      text: '记住默认使用 PostgreSQL，除非我明确要求其他数据库',
    });
    assert.ok(result);
    const ref = result.memory.sourceRefs[0]!;
    const proposal = {
      id: 'model-update-explicit-memory',
      scope: 'person:42',
      operation: 'update' as const,
      targetRecordIds: [result.memory.id],
      proposedRecord: {
        id: 'model-generated-id',
        scope: 'person:42',
        content: 'Prefer SQLite by default.',
        memoryType: 'preference' as const,
        status: 'candidate' as const,
        importance: 0.99,
        sourceRefs: [ref],
      },
      rationale: 'A derived observation appears to differ.',
      evidenceRefs: [ref],
    };
    const outcome = await store.commitProposal({
      proposal,
      evidence: await store.resolve({ scope: 'person:42', refs: [ref] }),
      runId: 'run-1',
    });
    assert.deepEqual(outcome, { applied: false, reason: 'user-explicit-memory-protected' });

    const after = (await store.listMemories('person:42')).find((item) => item.id === result.memory.id);
    assert.equal(after?.content, '默认使用 PostgreSQL，除非我明确要求其他数据库');
    assert.equal(after?.authority, 'user-explicit');
    await assert.rejects(() => store.upsertMemory({
      ...result.memory,
      content: 'Derived overwrite attempt',
      authority: 'derived',
    }), /User-explicit memory cannot be overwritten/);
  } finally {
    await engine.shutdown();
    await store.close();
  }
});
