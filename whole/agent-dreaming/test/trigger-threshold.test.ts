import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDreamingStore } from '../src/sqlite-store.js';
import { DreamingEngine } from '../src/engine.js';
import type { DreamingRuntime } from '../src/types.js';

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreaming-trigger-threshold-'));
  const store = new SqliteDreamingStore({ filename: path.join(dir, 'db.sqlite'), embeddingProvider: false });
  return {
    store,
    close: async () => {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const runtime: DreamingRuntime = {
  id: 'trigger-threshold-test-runtime',
  async generate() {
    return {
      output: {
        proposals: [],
        processedRecordIds: ['experience:1', 'experience:2', 'experience:3'],
        reviewedMemoryIds: [],
      },
    };
  },
};

async function append(store: SqliteDreamingStore, id: string) {
  await store.appendExperience({
    id, scope: 'alice', content: `Useful evidence record ${id}.`,
    createdAt: new Date().toISOString(), sourceRefs: [],
  });
}

test('record-appended only invokes the runtime after the configured number of unprocessed experiences', async () => {
  const x = setup();
  try {
    let runtimeCalls = 0;
    const observedRuntime: DreamingRuntime = {
      ...runtime,
      async generate(request) {
        runtimeCalls += 1;
        return runtime.generate(request);
      },
    };
    let resolveStartup!: () => void;
    const startupFinished = new Promise<void>((resolve) => { resolveStartup = resolve; });
    const engine = new DreamingEngine(observedRuntime, x.store, x.store, {
      scopes: ['alice'],
      minNewExperiencesToTrigger: 3,
      onRun(run) {
        if (run.trigger === 'startup') resolveStartup();
      },
    });
    engine.start();
    await startupFinished;
    await new Promise<void>((resolve) => setImmediate(resolve));

    await append(x.store, 'experience:1');
    await append(x.store, 'experience:2');
    assert.equal(await x.store.countUnprocessedExperiences('alice'), 2);
    assert.equal(await engine.notifyRecordAppended('alice'), undefined);
    assert.equal(runtimeCalls, 0);

    await append(x.store, 'experience:3');
    assert.equal(await x.store.countUnprocessedExperiences('alice'), 3);
    const run = await engine.notifyRecordAppended('alice');
    assert.equal(run?.trigger, 'record-appended');
    assert.equal(run?.status, 'completed');
    assert.equal(runtimeCalls, 1);
    assert.equal(await x.store.countUnprocessedExperiences('alice'), 0);

    engine.stop();
    await engine.shutdown();
  } finally {
    await x.close();
  }
});

test('manual runs bypass the record-appended threshold and bounded run options are validated', async () => {
  const x = setup();
  try {
    await append(x.store, 'experience:1');
    let calls = 0;
    const manualRuntime: DreamingRuntime = {
      id: 'manual-threshold-test-runtime',
      async generate() {
        calls += 1;
        return {
          output: {
            proposals: [],
            processedRecordIds: ['experience:1'],
            reviewedMemoryIds: [],
          },
        };
      },
    };
    const engine = new DreamingEngine(manualRuntime, x.store, x.store, {
      scopes: ['alice'], minNewExperiencesToTrigger: 3,
    });
    const run = await engine.runNow('alice');
    assert.equal(run?.trigger, 'manual');
    assert.equal(calls, 1);

    assert.throws(() => new DreamingEngine(manualRuntime, x.store, x.store, {
      scopes: ['alice'], minNewExperiencesToTrigger: 0,
    }), /minNewExperiencesToTrigger/);
    assert.throws(() => new DreamingEngine(manualRuntime, x.store, x.store, {
      scopes: ['alice'], batchSize: 101,
    }), /batchSize/);
    assert.throws(() => new DreamingEngine(manualRuntime, x.store, x.store, {
      scopes: ['alice'], maxBatchesPerRun: 11,
    }), /maxBatchesPerRun/);
  } finally {
    await x.close();
  }
});
