import assert from 'node:assert/strict';
import {
  AgentCheckpointSchema,
  ClaimSchema,
  calibrateClaimStatus,
  AgentCommandSchema,
  AgentDefinitionSchema,
  AgentInterruptSchema,
  AgentEventSchema,
  AgentTraceContextSchema,
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  ContextReferenceSchema,
  EvidenceSchema,
  KnowledgeSearchRequestSchema,
  PolicyDecisionSchema,
  PolicyRequestSchema,
  ToolDefinitionSchema,
} from '../src/index.js';

const actor = { id: 'user-1', type: 'human' };

assert.equal(AgentCheckpointSchema.parse({
  title: 'Position source',
  summary: 'Confirmed the main input.',
  evidenceIds: ['e1'],
}).evidenceIds.length, 1);
assert.equal(AgentDefinitionSchema.parse({ id: 'a', name: 'Researcher' }).id, 'a');
assert.equal(ToolDefinitionSchema.parse({ name: 'search', description: 'Search', inputSchema: {} }).name, 'search');
assert.equal(KnowledgeSearchRequestSchema.parse({ query: 'positions' }).limit, 10);
assert.equal(ContextReferenceSchema.parse({ id: 'f1', type: 'file' }).type, 'file');
assert.equal(AgentInterruptSchema.parse({ id: 'i1', type: 'approval', reason: 'confirm' }).required, true);
assert.equal(ApprovalRequestSchema.parse({ id: 'r1', action: 'trade', requestedBy: actor }).requestedBy.id, 'user-1');
assert.equal(ApprovalDecisionSchema.parse({ requestId: 'r1', decision: 'approved', decidedBy: actor, decidedAt: '2026-10-01T00:00:00Z' }).decision, 'approved');
assert.equal(PolicyRequestSchema.parse({ actor, action: 'read' }).action, 'read');
assert.equal(PolicyDecisionSchema.parse({ decision: 'allow' }).decision, 'allow');
assert.equal(AgentCommandSchema.parse({ id: 'c1', type: 'query', payload: {}, requestedBy: actor }).type, 'query');
assert.equal(EvidenceSchema.parse({ id: 'e1', type: 'document' }).type, 'document');
assert.equal(ClaimSchema.parse({ id: 'c1', claim: 'Position source is system A', status: 'inferred', evidenceIds: ['e1'] }).status, 'inferred');
assert.equal(calibrateClaimStatus([], 'supported'), 'unknown');
assert.equal(calibrateClaimStatus([{ id: 'e1', type: 'document', source: 'doc-a' }], 'supported'), 'inferred');
assert.equal(calibrateClaimStatus([
  { id: 'e1', type: 'document' },
  { id: 'e2', type: 'document' },
], 'supported'), 'inferred');
assert.equal(calibrateClaimStatus([
  { id: 'e1', type: 'document', source: 'doc-a' },
  { id: 'e2', type: 'document', source: 'doc-b' },
], 'supported'), 'supported');
assert.equal(calibrateClaimStatus([
  { id: 'e1', type: 'document', source: 'doc-a' },
  { id: 'e2', type: 'document', source: 'doc-a' },
], 'supported'), 'inferred');
assert.equal(calibrateClaimStatus([{ id: 'e1', type: 'document' }], 'verified'), 'inferred');
assert.equal(AgentEventSchema.parse({ id: 'ev1', type: 'tool.called', timestamp: '2026-10-01T00:00:00Z' }).type, 'tool.called');
assert.equal(AgentTraceContextSchema.parse({ traceId: 'trace-1', turnId: 'turn-2', sequence: 3 }).sequence, 3);
assert.equal(AgentTraceContextSchema.safeParse({ sequence: -1 }).success, false);
const traceEvent = AgentEventSchema.parse({
  id: 'ev2',
  type: 'tool.completed',
  timestamp: '2026-10-01T00:00:01Z',
  sessionId: 'session-1',
  correlationId: 'request-1',
  traceId: 'trace-1',
  turnId: 'turn-2',
  parentEventId: 'ev1',
  sequence: 4,
  category: 'tool',
  status: 'succeeded',
  durationMs: 125,
  provider: 'copilot',
  model: 'gpt-5',
  payloadComplete: true,
  data: { toolName: 'search' },
});
assert.equal(traceEvent.traceId, 'trace-1');
assert.equal(traceEvent.durationMs, 125);
assert.equal(AgentEventSchema.safeParse({
  id: 'ev3', type: 'tool.failed', timestamp: '2026-10-01T00:00:01Z', durationMs: -1,
}).success, false);

console.log('agent-contracts tests passed');
