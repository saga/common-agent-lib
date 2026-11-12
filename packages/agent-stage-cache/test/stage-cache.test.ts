import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCachedStage, StageCacheError } from '../src/index.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test('executes once and reuses only a matching fingerprint and intact output', async () => {
  const runDir = await tempDir('agent-stage-cache-');
  try {
    let calls = 0;
    const run = (fingerprint: string) => runCachedStage({
      runDir, stageId: 'draft', outputFile: 'draft.md', fingerprint,
      execute: async () => 'result-' + (++calls),
    });

    const first = await run('prompt-a');
    const second = await run('prompt-a');
    assert.equal(first.status, 'executed');
    assert.equal(second.status, 'cache_hit');
    assert.equal(first.output, 'result-1');
    assert.equal(second.output, 'result-1');
    assert.equal(calls, 1);

    const third = await run('prompt-b');
    assert.equal(third.status, 'executed');
    assert.equal(third.output, 'result-2');
    assert.equal(calls, 2);

    await writeFile(path.join(runDir, 'draft.md'), 'corrupted\n', 'utf8');
    const fourth = await run('prompt-b');
    assert.equal(fourth.status, 'executed');
    assert.equal(fourth.output, 'result-3');
    assert.equal(calls, 3);

    const events = (await readFile(path.join(runDir, 'stage-events.jsonl'), 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { status: string });
    assert.ok(events.some((event) => event.status === 'cache_hit'));
    assert.ok(events.some((event) => event.status === 'cache_corrupt'));
    assert.ok(events.some((event) => event.status === 'completed'));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('different stages can complete concurrently without losing manifest entries', async () => {
  const runDir = await tempDir('agent-stage-cache-manifest-race-');
  try {
    await Promise.all(['plot', 'creative'].map((stageId) => runCachedStage({
      runDir, stageId, outputFile: stageId + '.md', fingerprint: stageId,
      execute: async () => stageId + ' output',
    })));
    const manifest = JSON.parse(await readFile(path.join(runDir, 'pipeline-manifest.json'), 'utf8')) as {
      stages: Record<string, { outputHash: string }>;
    };
    assert.ok(manifest.stages.plot);
    assert.ok(manifest.stages.creative);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('parallel calls to one stage are serialized and the second call observes the cache', async () => {
  const runDir = await tempDir('agent-stage-cache-same-stage-');
  try {
    let calls = 0;
    const execute = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return 'shared result';
    };
    const [first, second] = await Promise.all([
      runCachedStage({ runDir, stageId: 'one', outputFile: 'one.md', fingerprint: 'same', execute }),
      runCachedStage({ runDir, stageId: 'one', outputFile: 'one.md', fingerprint: 'same', execute }),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(new Set([first.status, second.status]), new Set(['executed', 'cache_hit']));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('semantically invalid cached output is regenerated', async () => {
  const runDir = await tempDir('agent-stage-cache-validation-');
  try {
    let calls = 0;
    await runCachedStage({
      runDir, stageId: 'review', outputFile: 'review.json', fingerprint: 'same-input',
      execute: async () => (++calls, JSON.stringify({ status: 'needs_repair', issues: [] })),
    });
    const result = await runCachedStage({
      runDir, stageId: 'review', outputFile: 'review.json', fingerprint: 'same-input',
      execute: async () => (++calls, JSON.stringify({ status: 'pass', issues: [] })),
      validate: (output) => {
        const value = JSON.parse(output) as { status: string; issues: unknown[] };
        if (value.status === 'needs_repair' && value.issues.length === 0) throw new Error('invalid review');
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.status, 'executed');
    assert.equal(JSON.parse(result.output).status, 'pass');
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('rejects output path traversal and does not cache failed or empty generation', async () => {
  const runDir = await tempDir('agent-stage-cache-invalid-');
  try {
    await assert.rejects(() => runCachedStage({
      runDir, stageId: 'bad', outputFile: '../outside.txt', fingerprint: 'x', execute: async () => 'bad',
    }), StageCacheError);
    await assert.rejects(() => runCachedStage({
      runDir, stageId: 'empty', outputFile: 'empty.md', fingerprint: 'x', execute: async () => '  ',
    }), /empty output/);
    await assert.rejects(() => runCachedStage({
      runDir, stageId: 'failed', outputFile: 'failed.md', fingerprint: 'x', execute: async () => { throw new Error('boom'); },
    }), /boom/);
    const manifestText = await readFile(path.join(runDir, 'pipeline-manifest.json'), 'utf8').catch(() => '');
    if (manifestText) {
      const manifest = JSON.parse(manifestText) as { stages: Record<string, unknown> };
      assert.deepEqual(Object.keys(manifest.stages), []);
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
