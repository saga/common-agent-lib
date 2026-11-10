import test from 'node:test';
import assert from 'node:assert/strict';
import { contextSessionFromTrajectoryEvents, contextSessionsFromAgentEvents } from '../src/index.js';

test('adapts saga AgentEvent envelope and preserves usage/context occupancy', () => {
  const sessions = contextSessionsFromAgentEvents([
    {
      id: 'model-1', timestamp: '2026-01-01T00:00:00.000Z', type: 'model_call',
      sessionId: 'session-1', traceId: 'trace-1', turnId: 'turn-1', sequence: 2,
      provider: 'openai-compatible', model: 'model-a', status: 'completed',
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, source: 'provider-event' },
      contextUsage: { currentTokens: 1200, tokenLimit: 8000, messagesLength: 8, percent: 15 },
      data: { request: { model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }, response: { choices: [{ message: { role: 'assistant', content: 'hi' } }] }, requestId: 'req-1' },
    },
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.runs.length, 1);
  assert.equal(sessions[0]?.runs[0]?.requestId, 'req-1');
  assert.equal(sessions[0]?.runs[0]?.usage?.cachedInputTokens, 40);
  assert.equal(sessions[0]?.events[0]?.contextUsage?.percent, 15);
  assert.equal(sessions[0]?.runs[0]?.snapshot.messages[0]?.parts[0]?.kind, 'text');
});

test('adapts agentic-data-architect trajectory tool lifecycle and usage', () => {
  const session = contextSessionFromTrajectoryEvents([
    { id: 't1', turnId: 'turn-1', timestamp: '2026-01-01T00:00:00.000Z', type: 'tool_call', name: 'Search', status: 'started', details: { toolCallId: 'call-1', tool: 'search', arguments: { q: 'x' }, agentId: 'researcher', parentToolCallId: 'call-parent' } },
    { id: 't2', turnId: 'turn-1', timestamp: '2026-01-01T00:00:01.000Z', type: 'tool_progress', name: 'Reading result', status: 'info', details: { toolCallId: 'call-1', progressMessage: 'page 1' } },
    { id: 't3', turnId: 'turn-1', timestamp: '2026-01-01T00:00:02.000Z', type: 'tool_result', name: 'Search complete', status: 'completed', details: { toolCallId: 'call-1', resultPreview: 'found' } },
    { id: 't4', turnId: 'turn-1', timestamp: '2026-01-01T00:00:03.000Z', type: 'model_call', name: 'Model call', status: 'completed', model: 'model-a', inputTokens: 50, outputTokens: 10, details: { cachedInputTokens: 20, reasoningTokens: 4 } },
  ]);
  assert.equal(session.events[0]?.toolCallId, 'call-1');
  assert.equal(session.events[1]?.type, 'tool-progress');
  assert.equal(session.events[3]?.usage?.cachedInputTokens, 20);
  assert.equal(session.runs.length, 0, 'trajectory summaries without actual provider payload must not fabricate a context snapshot');
});
