import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCompaction, buildContextTimeline, buildToolCallGraph, normalizeContext } from '../src/index.js';

test('correlates tool calls and results by call id', () => {
  const snapshot = normalizeContext({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'search', input: { q: 'x' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'found', name: 'search' },
  ] });
  const graph = buildToolCallGraph(snapshot.messages);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0]?.status, 'completed');
  assert.equal(graph.nodes[0]?.result, 'found');
  assert.equal(graph.orphanResults.length, 0);
});
test('builds chronological session timeline from runs, events and compactions', () => {
  const snapshot = normalizeContext({ messages: [] });
  const timeline = buildContextTimeline({
    runs: [{ id: 'r1', sequence: 1, startedAt: '2026-01-01T00:00:02Z', status: 'completed', snapshot }],
    events: [{ id: 'e1', type: 'tool-call', timestamp: '2026-01-01T00:00:01Z', toolName: 'search' }],
    compactions: [],
  });
  assert.deepEqual(timeline.map((item) => item.id), ['e1', 'run:r1']);
});
test('analyzes messages and token delta across compaction', () => {
  const before = normalizeContext({ messages: [{ id: 'm1', role: 'user', content: 'keep' }, { id: 'm2', role: 'assistant', content: 'drop' }] }, { usage: { prompt_tokens: 100 } });
  const after = normalizeContext({ messages: [{ id: 'm1', role: 'user', content: 'keep' }] }, { usage: { prompt_tokens: 40 } });
  const result = analyzeCompaction({ id: 'c1', timestamp: '2026-01-01T00:00:00Z', before, after });
  assert.deepEqual(result.removedMessageIds, ['m2']);
  assert.deepEqual(result.preservedMessageIds, ['m1']);
  assert.equal(result.tokenReduction, 60);
  assert.equal(result.tokenReductionPercent, 60);
});

test('correlates out-of-order tool lifecycle events by stable call id', () => {
  const graph = buildToolCallGraph([], [
    { id: 'result', type: 'tool-result', timestamp: '2026-01-01T00:00:02Z', toolCallId: 'call-1', status: 'completed', output: 'ok' },
    { id: 'call', type: 'tool-call', timestamp: '2026-01-01T00:00:01Z', toolCallId: 'call-1', toolName: 'search', status: 'started' },
  ]);
  assert.equal(graph.nodes[0]?.status, 'completed');
  assert.equal(graph.nodes[0]?.result, 'ok');
  assert.equal(graph.orphanResults.length, 0);
});
