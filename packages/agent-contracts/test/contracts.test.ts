import assert from 'node:assert/strict';
import {
  AgentCheckpointSchema,
  ClaimSchema,
  calibrateClaimStatus,
  AgentCommandSchema,
  AgentDefinitionSchema,
  AgentInterruptSchema,
  AgentEventSchema,
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
  { id: 'e1', type: 'document', source: 'doc-a' },
  { id: 'e2', type: 'document', source: 'doc-b' },
], 'supported'), 'supported');
assert.equal(calibrateClaimStatus([
  { id: 'e1', type: 'document', source: 'doc-a' },
  { id: 'e2', type: 'document', source: 'doc-a' },
], 'supported'), 'inferred');
assert.equal(calibrateClaimStatus([{ id: 'e1', type: 'document' }], 'verified'), 'inferred');
assert.equal(AgentEventSchema.parse({ id: 'ev1', type: 'tool.called', timestamp: '2026-10-01T00:00:00Z' }).type, 'tool.called');

console.log('agent-contracts tests passed');
