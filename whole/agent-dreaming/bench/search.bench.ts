import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteDreamingStore } from '../src/sqlite-store.js';

const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-dreaming-bench-'));
const store = new SqliteDreamingStore({
  filename: path.join(directory, 'benchmark.sqlite'),
  embeddingProvider: false,
});

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]?.toFixed(3) ?? 0);
}

async function measure(name: string, scope: string, query: string): Promise<Record<string, number | string>> {
  for (let i = 0; i < 5; i += 1) {
    await store.search({ scope, query, sourceTypes: ['memory'], limit: 20 });
  }
  const samples: number[] = [];
  let resultCount = 0;
  for (let i = 0; i < 30; i += 1) {
    const started = performance.now();
    const result = await store.search({ scope, query, sourceTypes: ['memory'], limit: 20 });
    samples.push(performance.now() - started);
    resultCount = result.length;
  }
  return {
    scenario: name,
    samples: samples.length,
    resultCount,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  };
}

try {
  const common = 'Payment recovery uses idempotency keys and verifies the durable transaction state before retrying. 支付恢复流程使用幂等键，并在重试前核对持久化交易状态。';
  for (let i = 0; i < 1_500; i += 1) {
    await store.upsertMemory({
      id: `benchmark:primary:${i}`,
      scope: 'benchmark:primary',
      content: `${common} Record ${i} covers routine recovery behavior.`,
      status: 'confirmed',
      importance: 0.8,
      sourceRefs: [],
    });
  }
  for (let i = 0; i < 200; i += 1) {
    await store.upsertMemory({
      id: `benchmark:other:${i}`,
      scope: 'benchmark:other',
      content: `${common} foreignscopeonlytoken ${i}`,
      status: 'confirmed',
      importance: 0.8,
      sourceRefs: [],
    });
  }

  const results = [
    await measure('english-fts', 'benchmark:primary', 'payment recovery idempotency'),
    await measure('cjk-substring', 'benchmark:primary', '幂等键支付恢复'),
  ];
  const isolation = await store.search({
    scope: 'benchmark:primary',
    query: 'foreignscopeonlytoken',
    sourceTypes: ['memory'],
    limit: 20,
  });
  if (isolation.length !== 0) throw new Error('Scope isolation benchmark failed.');
  console.log(JSON.stringify({
    node: process.version,
    primaryMemoryCount: 1_500,
    otherScopeMemoryCount: 200,
    scopeIsolationResultCount: isolation.length,
    results,
  }, null, 2));
} finally {
  await store.close();
  rmSync(directory, { recursive: true, force: true });
}
