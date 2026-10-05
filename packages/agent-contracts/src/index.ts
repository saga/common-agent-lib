import * as z from 'zod';

/** Actor performing or requesting an agent operation. */
export const ActorReferenceSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  displayName: z.string().optional(),
});
export type ActorReference = z.infer<typeof ActorReferenceSchema>;

/** External or internal resource affected by an operation. */
export const ResourceReferenceSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  uri: z.string().optional(),
});
export type ResourceReference = z.infer<typeof ResourceReferenceSchema>;

/** Provider-neutral description of an agent. Runtime implementations remain provider-specific. */
export const AgentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  model: z.string().optional(),
  skills: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** Minimal session identity. Persistence and lifecycle are owned by the runtime. */
export const SessionReferenceSchema = z.object({
  id: z.string(),
  agentId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type SessionReference = z.infer<typeof SessionReferenceSchema>;

/** Common tool descriptor; execution, authorization and registry remain application concerns. */
export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

/** Retrieval request/result contract. The actual provider may be vector, lexical, graph, SQL or hybrid. */
export const KnowledgeSearchRequestSchema = z.object({
  query: z.string(),
  scope: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.unknown()).default({}),
  limit: z.number().int().positive().max(100).default(10),
});
export type KnowledgeSearchRequest = z.infer<typeof KnowledgeSearchRequestSchema>;

export const KnowledgeHitSchema = z.object({
  id: z.string(),
  content: z.string(),
  score: z.number().optional(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  sources: z.array(z.string()).default([]),
});
export type KnowledgeHit = z.infer<typeof KnowledgeHitSchema>;

export const KnowledgeSearchResultSchema = z.object({
  hits: z.array(KnowledgeHitSchema),
});
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResultSchema>;

/** Reference used for just-in-time context loading instead of eagerly embedding large data in prompts. */
export const ContextReferenceSchema = z.object({
  id: z.string(),
  type: z.enum(['message', 'file', 'document', 'knowledge', 'artifact', 'tool-result', 'workflow-state']),
  uri: z.string().optional(),
  summary: z.string().optional(),
  tokenEstimate: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ContextReference = z.infer<typeof ContextReferenceSchema>;

/** Provider-neutral interruption. It does not decide who is authorized to resolve it. */
export const AgentInterruptSchema = z.object({
  id: z.string(),
  type: z.enum(['input', 'confirmation', 'approval', 'review', 'authorization']),
  reason: z.string(),
  message: z.string().optional(),
  required: z.boolean().default(true),
  expiresAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AgentInterrupt = z.infer<typeof AgentInterruptSchema>;

export const InterruptResultSchema = z.object({
  interruptId: z.string(),
  status: z.enum(['approved', 'rejected', 'provided', 'cancelled', 'expired']),
  value: z.unknown().optional(),
  actor: ActorReferenceSchema.optional(),
  timestamp: z.string().datetime(),
});
export type InterruptResult = z.infer<typeof InterruptResultSchema>;

/** Approval data contract. Policy/authorization decisions are intentionally outside this package. */
export const ApprovalRequestSchema = z.object({
  id: z.string(),
  action: z.string(),
  reason: z.string().optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  requestedBy: ActorReferenceSchema,
  target: ResourceReferenceSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  requestId: z.string(),
  decision: z.enum(['approved', 'rejected']),
  decidedBy: ActorReferenceSchema,
  decidedAt: z.string().datetime(),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** Policy engine input/output. This package never implements the policy engine. */
export const PolicyRequestSchema = z.object({
  actor: ActorReferenceSchema,
  action: z.string(),
  resource: ResourceReferenceSchema.optional(),
  context: z.record(z.string(), z.unknown()).default({}),
});
export type PolicyRequest = z.infer<typeof PolicyRequestSchema>;

export const PolicyDecisionSchema = z.object({
  decision: z.enum(['allow', 'deny', 'require_approval']),
  policyId: z.string().optional(),
  reason: z.string().optional(),
  obligations: z.array(z.string()).default([]),
  expiresAt: z.string().datetime().optional(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/** Business command request. Execution belongs to the application boundary. */
export const AgentCommandSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
  requestedBy: ActorReferenceSchema,
  idempotencyKey: z.string().optional(),
  expectedVersion: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

export const CommandResultSchema = z.object({
  commandId: z.string(),
  status: z.enum(['accepted', 'rejected', 'completed', 'failed']),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

/** Evidence/provenance attached to an answer or decision. */
export const EvidenceSchema = z.object({
  id: z.string(),
  type: z.enum(['document', 'database', 'api', 'tool', 'agent', 'human']),
  title: z.string().optional(),
  uri: z.string().optional(),
  excerpt: z.string().optional(),
  source: z.string().optional(),
  retrievedAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Claim status used when an agent conclusion can be checked against explicit evidence. */
export const ClaimStatusSchema = z.enum(['verified', 'supported', 'inferred', 'unknown', 'contradicted']);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

/** A claim stores evidence references rather than embedding the complete evidence objects. */
export const ClaimSchema = z.object({
  id: z.string(),
  claim: z.string().min(1),
  status: ClaimStatusSchema,
  evidenceIds: z.array(z.string()),
});
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Prevents an agent from promoting a claim to a stronger status than its evidence supports.
 *
 * verified is deterministic/application-owned and therefore cannot be granted by the model.
 * A supported claim needs evidence with distinct origins; two records from the same source do
 * not become independent merely because their ids are different.
 */
export function calibrateClaimStatus(
  evidence: number | readonly Evidence[],
  claimed: ClaimStatus,
): ClaimStatus {
  const evidenceCount = typeof evidence === 'number' ? evidence : evidence.length;
  if (evidenceCount === 0) return 'unknown';
  if (claimed === 'verified') return 'inferred';
  if (claimed === 'contradicted') return 'contradicted';
  if (claimed !== 'supported') return claimed;

  const independentOrigins = typeof evidence === 'number'
    ? evidenceCount
    : new Set(evidence
        .map((item) => {
          const metadata = item.metadata ?? {};
          const sourceHash = typeof metadata.sourceHash === 'string' ? metadata.sourceHash : undefined;
          return sourceHash
            ? 'hash:' + sourceHash
            : item.source
              ? 'source:' + item.source
              : item.uri
                ? 'uri:' + item.uri
                : undefined;
        })
        .filter((origin): origin is string => Boolean(origin))).size;

  return independentOrigins >= 2 ? 'supported' : 'inferred';
}
/** A compact, user-readable intermediate result from a meaningful agent work stage. */
export const AgentCheckpointSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(1200),
  confirmed: z.array(z.string().min(1).max(500)).max(8).default([]),
  evidenceIds: z.array(z.string().min(1).max(120)).max(20).default([]),
  unknowns: z.array(z.string().min(1).max(500)).max(8).default([]),
  nextStep: z.string().min(1).max(500).optional(),
});
export type AgentCheckpoint = z.infer<typeof AgentCheckpointSchema>;

/** Provider-neutral agent event. Business audit remains a separate application concern. */
export const AgentEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.string().datetime(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  actor: ActorReferenceSchema.optional(),
  data: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export interface ToolProvider {
  listTools(context?: Record<string, unknown>): Promise<ToolDefinition[]>;
}

export interface KnowledgeProvider {
  search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult>;
}

export interface PolicyProvider {
  decide(request: PolicyRequest): Promise<PolicyDecision>;
}

export interface CommandExecutor {
  execute(command: AgentCommand): Promise<CommandResult>;
}
