import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextSessionFromTrajectoryEvents,
  contextSessionsFromAgentEvents,
} from '../src/index.js';

const at = (second: number) => new Date(Date.UTC(2026, 10, 10, 8, 0, second)).toISOString();

test('maps Agentic Data Architect trajectory identifiers, usage and context occupancy without conflating turn and session', () => {
  const session = contextSessionFromTrajectoryEvents([
    {
      id: 'turn-start-1', turnId: 'turn-7', timestamp: at(0), type: 'turn_start',
      name: 'Turn started', status: 'started', details: {},
    },
    {
      id: 'model-1', turnId: 'turn-7', timestamp: at(1), type: 'model_call',
      name: 'Model call', status: 'completed', model: 'claude-sonnet',
      inputTokens: 1400, outputTokens: 300, premiumRequestCost: 0.02,
      details: {
        sessionId: 'session-3', requestId: 'request-9', apiCallId: 'api-2',
        providerCallId: 'provider-4', serviceRequestId: 'service-5',
        initiator: 'planner', attempt: 2, stage: 'planning',
        request: { model: 'claude-sonnet', messages: [{ role: 'user', content: 'hello' }] },
        response: { id: 'response-1', content: [{ type: 'text', text: 'world' }] },
        cachedInputTokens: 200, newInputTokens: 1200, cacheWriteTokens: 50,
        reasoningTokens: 80, timeToFirstTokenMs: 420, interTokenLatencyMs: 25,
        contextTokensAtCall: 18000, contextTokenLimitAtCall: 200000,
        contextPercentAtCall: 9, contextMessagesAtCall: 18,
      },
    },
    {
      id: 'tool-1', turnId: 'turn-7', timestamp: at(2), type: 'tool_call',
      name: 'Search', status: 'started',
      details: { toolCallId: 'call-1', tool: 'search', parentToolCallId: 'call-parent', agentId: 'researcher', mcpServerName: 'exa', mcpToolName: 'search' },
    },
    {
      id: 'permission-1', turnId: 'turn-7', timestamp: at(3), type: 'permission',
      name: 'Permission requested', status: 'waiting',
      details: { requestId: 'permission-request-1', kind: 'shell', fullCommandText: 'npm test' },
    },
  ]);

  assert.equal(session.id, 'session-3');
  assert.equal(session.traceId, undefined);
  assert.deepEqual(session.metadata?.sourceTurnIds, ['turn-7']);
  assert.equal(session.runs.length, 1);
  const run = session.runs[0]!;
  assert.equal(run.turnId, 'turn-7');
  assert.equal(run.requestId, 'request-9');
  assert.equal(run.apiCallId, 'api-2');
  assert.equal(run.providerCallId, 'provider-4');
  assert.equal(run.serviceRequestId, 'service-5');
  assert.equal(run.initiator, 'planner');
  assert.equal(run.attempt, 2);
  assert.equal(run.stage, 'planning');
  assert.equal(run.payloadComplete, true);
  assert.equal(run.usage?.cachedInputTokens, 200);
  assert.equal(run.usage?.newInputTokens, 1200);
  assert.equal(run.usage?.timeToFirstTokenMs, 420);
  assert.equal(run.usage?.interTokenLatencyMs, 25);
  assert.equal(run.contextUsage?.currentTokens, 18000);
  assert.equal(run.contextUsage?.percent, 9);

  const tool = session.events.find((event) => event.id === 'tool-1')!;
  assert.equal(tool.toolCallId, 'call-1');
  assert.equal(tool.parentToolCallId, 'call-parent');
  assert.equal(tool.agentId, 'researcher');
  assert.equal(tool.mcpServerName, 'exa');
  const permission = session.events.find((event) => event.id === 'permission-1')!;
  assert.equal(permission.type, 'permission');
  assert.equal(permission.status, 'waiting');
});

test('does not mark request-only trajectory records as replay-complete', () => {
  const session = contextSessionFromTrajectoryEvents([{
    id: 'model-2', turnId: 'turn-8', timestamp: at(1), type: 'model_call',
    name: 'Model call', status: 'completed',
    details: { requestId: 'request-10', request: { model: 'model-x', messages: [{ role: 'user', content: 'input' }] } },
  }]);
  assert.equal(session.id, 'trajectory:turn-8');
  assert.equal(session.runs[0]?.payloadComplete, false);
  assert.equal(session.runs[0]?.snapshot.responseMessages.length, 0);
});

test('maps shared agent-tracing events and keeps correlation identifiers distinct', () => {
  const sessions = contextSessionsFromAgentEvents([
    {
      id: 'event-1', timestamp: at(1), type: 'model.call', sessionId: 'session-1',
      traceId: 'trace-1', turnId: 'turn-1', correlationId: 'corr-1', sequence: 1,
      provider: 'anthropic', model: 'claude-sonnet', status: 'completed',
      data: {
        requestId: 'request-1', providerCallId: 'provider-1',
        request: { model: 'claude-sonnet', messages: [{ role: 'user', content: 'hello' }] },
        response: { content: [{ type: 'text', text: 'hi' }] },
        initiator: 'assistant',
      },
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, source: 'provider-event' },
      contextUsage: { currentTokens: 10, tokenLimit: 100, messagesLength: 2, percent: 10 },
    },
    {
      id: 'event-2', timestamp: at(2), type: 'tool.call', sessionId: 'session-1',
      traceId: 'trace-1', turnId: 'turn-1', sequence: 2, status: 'started',
      data: { toolCallId: 'call-1', tool: 'search', parentToolCallId: 'call-parent' },
    },
  ]);

  assert.equal(sessions.length, 1);
  const session = sessions[0]!;
  assert.equal(session.id, 'session-1');
  assert.equal(session.traceId, 'trace-1');
  assert.equal(session.runs[0]?.requestId, 'request-1');
  assert.equal(session.runs[0]?.providerCallId, 'provider-1');
  assert.equal(session.runs[0]?.payloadComplete, true);
  assert.equal(session.runs[0]?.contextUsage?.percent, 10);
  assert.equal(session.events[0]?.correlationId, 'corr-1');
  assert.equal(session.events[0]?.requestId, 'request-1');
  assert.equal(session.events[0]?.providerCallId, 'provider-1');
  assert.equal(session.events[1]?.toolCallId, 'call-1');
  assert.equal(session.events[1]?.parentToolCallId, 'call-parent');
});
