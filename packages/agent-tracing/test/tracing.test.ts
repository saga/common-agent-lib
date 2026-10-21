import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  AgentTraceRecorder,
  InMemoryTraceStore,
  SqliteTraceStore,
} from '../src/index.js';

test('records normalized events with trace-local sequence and query filters', async () => {
  const store = new InMemoryTraceStore();
  const trace = new AgentTraceRecorder(store);
  const context = trace.createContext({ sessionId: 's1', traceId: 't1' });
  await trace.record({ ...context, type: 'turn.started', category: 'agent', status: 'running' });
  await trace.record({ ...context, type: 'tool.completed', category: 'tool', status: 'succeeded' });
  await trace.record({ sessionId: 's2', traceId: 't2', type: 'turn.completed' });
  const events = await trace.query({ traceId: 't1' });
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.deepEqual((await trace.query({ sessionIds: ['s1'], types: ['tool.completed'] })).map((event) => event.type), ['tool.completed']);
});

test('redacts nested credentials and bounds large payloads', async () => {
  const trace = new AgentTraceRecorder(new InMemoryTraceStore(), { maxPayloadBytes: 100, previewChars: 20 });
  const redacted = await trace.record({
    traceId: 't1', type: 'tool.completed',
    data: { nested: { api_key: 'secret-value', message: 'Bearer abc.def.ghi' } },
  });
  assert.equal((redacted.data as any).nested.api_key, '[REDACTED]');
  assert.equal((redacted.data as any).nested.message, 'Bearer [REDACTED]');

  const large = await trace.record({ traceId: 't1', type: 'tool.result', data: { output: 'x'.repeat(1000) } });
  assert.equal(large.payloadComplete, false);
  assert.equal((large.data as any).payloadOmitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(large.data), 'utf8') < 250);
});

test('SQLite store persists events and assigns sequence inside a transaction', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-tracing-'));
  const filename = path.join(directory, 'traces.sqlite');
  try {
    const store = new SqliteTraceStore({ filename });
    const trace = new AgentTraceRecorder(store);
    await trace.record({ sessionId: 's1', traceId: 't1', type: 'turn.started', data: { token: 'hide-me' } });
    await trace.record({ sessionId: 's1', traceId: 't1', type: 'turn.completed', durationMs: 10 });
    const rows = await trace.query({ traceId: 't1' });
    assert.deepEqual(rows.map((event) => event.sequence), [1, 2]);
    assert.equal((rows[0].data as any).token, '[REDACTED]');
    await trace.close();

    const reopened = new SqliteTraceStore({ filename });
    const restored = await reopened.query({ sessionIds: ['s1'], limit: 5 });
    assert.equal(restored.length, 2);
    assert.equal(restored[1].durationMs, 10);
    await reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runSpan records success and failure durations without swallowing operation errors', async () => {
  const trace = new AgentTraceRecorder(new InMemoryTraceStore());
  const context = trace.createContext({ sessionId: 's1', traceId: 't-span' });
  assert.equal(await trace.runSpan({ ...context, name: 'search', category: 'tool' }, () => 42), 42);
  await assert.rejects(
    trace.runSpan({ ...context, name: 'save', category: 'tool' }, () => { throw new Error('write failed'); }),
    /write failed/,
  );
  const events = await trace.query({ traceId: 't-span' });
  assert.deepEqual(events.map((event) => event.type), [
    'tool.started', 'tool.completed', 'tool.started', 'tool.failed',
  ]);
  assert.equal(events[1].status, 'succeeded');
  assert.equal(events[3].status, 'failed');
  assert.ok((events[3].durationMs ?? -1) >= 0);
});
