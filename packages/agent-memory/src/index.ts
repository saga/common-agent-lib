import * as z from 'zod';

export const MemoryKindSchema = z.enum(['message', 'turn', 'tool-call', 'finding', 'evidence', 'decision', 'artifact', 'note', 'summary']);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;
export const MemoryLifecycleSchema = z.enum(['active', 'archived']);
export type MemoryLifecycle = z.infer<typeof MemoryLifecycleSchema>;

/** 记忆的语义类型；与原始记录 kind、存储 lifecycle 相互独立。 */
export const MemoryTypeSchema = z.enum(['episodic', 'semantic', 'procedural']);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
/** status 是宿主维护的权威状态，不是模型自行声明即可生效的信任等级。 */
export const MemoryStatusSchema = z.enum(['candidate', 'confirmed', 'superseded']);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

/** 一条可持久化的 Agent 工作记忆；原始内容由宿主应用保存。 */
export const MemoryRecordSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  scope: z.string().min(1),
  kind: MemoryKindSchema,
  content: z.string(),
  createdAt: z.string().datetime(),
  lifecycle: MemoryLifecycleSchema.default('active'),
  importance: z.number().min(0).max(1).default(0.5),
  /** Optional semantic classification; existing records remain valid. */
  memoryType: MemoryTypeSchema.optional(),
  /** Host-owned state. LLM output must not directly promote this field. */
  status: MemoryStatusSchema.optional(),
  /** Calibrated by the host from evidence, never trusted from a model claim alone. */
  confidence: z.number().min(0).max(1).optional(),
  lastAccessedAt: z.string().datetime().optional(),
  lastValidatedAt: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  supersededBy: z.string().min(1).optional(),
  tags: z.array(z.string()).default([]),
  sourceRefs: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const MemoryRelationshipKindSchema = z.enum([
  'supports', 'contradicts', 'derived_from', 'supersedes', 'related_to',
]);
export type MemoryRelationshipKind = z.infer<typeof MemoryRelationshipKindSchema>;
export const MemoryRelationshipSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  kind: MemoryRelationshipKindSchema,
  createdAt: z.string().datetime(),
  sourceRefs: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type MemoryRelationship = z.infer<typeof MemoryRelationshipSchema>;

/** Structured suggestion from a consolidator. The host validates and commits it. */
export const MemoryChangeProposalSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  operation: z.enum(['add', 'update', 'merge', 'supersede', 'archive']),
  targetRecordIds: z.array(z.string()).default([]),
  proposedRecord: MemoryRecordSchema.optional(),
  relationships: z.array(MemoryRelationshipSchema).default([]),
  rationale: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
}).strict().superRefine((proposal, ctx) => {
  if (proposal.operation === 'add' && !proposal.proposedRecord) {
    ctx.addIssue({ code: 'custom', path: ['proposedRecord'], message: 'add proposals require proposedRecord.' });
  }
  if (proposal.operation !== 'add' && proposal.targetRecordIds.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['targetRecordIds'], message: 'non-add proposals require at least one targetRecordId.' });
  }
  if (proposal.operation === 'merge' && proposal.targetRecordIds.length < 2) {
    ctx.addIssue({ code: 'custom', path: ['targetRecordIds'], message: 'merge proposals require at least two targetRecordIds.' });
  }\n  if (['update', 'merge', 'supersede'].includes(proposal.operation) && !proposal.proposedRecord) {
    ctx.addIssue({ code: 'custom', path: ['proposedRecord'], message: 'this operation requires proposedRecord.' });
  }
});
export type MemoryChangeProposal = z.infer<typeof MemoryChangeProposalSchema>;

export const MemoryConsolidationResultSchema = z.object({
  proposals: z.array(MemoryChangeProposalSchema),
  processedRecordIds: z.array(z.string()),
  notes: z.array(z.string()),
}).strict();
export type MemoryConsolidationResult = z.infer<typeof MemoryConsolidationResultSchema>;

/** Validate model/provider output before the host considers applying any proposal. */
export function parseMemoryConsolidationResult(value: unknown): MemoryConsolidationResult {
  return MemoryConsolidationResultSchema.parse(value);
}

export interface MemoryConsolidationInput {
  scope: string;
  records: readonly MemoryRecord[];
  existingMemories: readonly MemoryRecord[];
  relationships?: readonly MemoryRelationship[];
  /** Optional task/domain context supplied by the host. */
  context?: Readonly<Record<string, unknown>>;
}
/** Model-backed implementations live in host applications, not this package. */
export interface MemoryConsolidator {
  consolidate(input: MemoryConsolidationInput): Promise<MemoryConsolidationResult>;
}

/** 分页请求；cursor 的具体编码方式由存储实现决定。 */
export const MemoryPageRequestSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  lifecycle: MemoryLifecycleSchema.optional(),
}).strict();
export type MemoryPageRequest = z.infer<typeof MemoryPageRequestSchema>;

export interface MemoryPage<T> { items: T[]; nextCursor?: string; hasMore: boolean; }

/** 归档摘要；归档不删除原始记录。 */
export const MemoryArchiveSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  fromSequence: z.number().int().positive(),
  toSequence: z.number().int().positive(),
  summary: z.string().min(1),
  sourceRecordIds: z.array(z.string()).min(1),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type MemoryArchive = z.infer<typeof MemoryArchiveSchema>;

export interface MemoryStore {
  append(record: MemoryRecord): Promise<void>;
  page(scope: string, request: MemoryPageRequest): Promise<MemoryPage<MemoryRecord>>;
  markArchived(scope: string, ids: string[]): Promise<void>;
}
export interface MemoryArchiveStore {
  saveArchive(archive: MemoryArchive): Promise<void>;
  pageArchives(scope: string, request: MemoryPageRequest): Promise<MemoryPage<MemoryArchive>>;
}

export interface WorkingMemoryPolicy { maxItems: number; maxChars: number; keepImportanceAtLeast?: number; /** Fixed clock for deterministic expiry filtering; defaults to now. */ now?: string; }
export interface WorkingMemoryResult { included: MemoryRecord[]; omitted: MemoryRecord[]; includedChars: number; omittedCount: number; }

/** 从持久化记忆中构造有界工作记忆；被排除的记录仍可通过分页再次读取。 */
export function buildWorkingMemory(records: MemoryRecord[], policy: WorkingMemoryPolicy): WorkingMemoryResult {
  const maxItems = Math.max(1, Math.trunc(policy.maxItems));
  const maxChars = Math.max(1, Math.trunc(policy.maxChars));
  const threshold = policy.keepImportanceAtLeast ?? 0.8;
  const now = Date.parse(policy.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) throw new Error('Working memory policy now must be a valid ISO date.');
  const ordered = [...records].sort((a, b) => b.sequence - a.sequence);
  const eligible = ordered.filter((record) =>
    record.lifecycle === 'active' &&
    record.status !== 'superseded' &&
    (!record.validUntil || Date.parse(record.validUntil) > now),
  );
  const kept: MemoryRecord[] = [];
  const keptIds = new Set<string>();
  let chars = 0;
  for (const record of eligible) {
    if (record.importance < threshold) continue;
    if (kept.length >= maxItems || chars + record.content.length > maxChars) continue;
    kept.push(record); keptIds.add(record.id); chars += record.content.length;
  }
  for (const record of eligible) {
    if (keptIds.has(record.id)) continue;
    if (kept.length >= maxItems || chars + record.content.length > maxChars) continue;
    kept.push(record); keptIds.add(record.id); chars += record.content.length;
  }
  const included = kept.sort((a, b) => a.sequence - b.sequence);
  const omitted = ordered.filter((record) => !keptIds.has(record.id));
  return { included, omitted, includedChars: chars, omittedCount: omitted.length };
}

/** 当活跃记忆超出窗口时挑出旧记录，供宿主生成归档摘要。 */
export function selectArchiveCandidates(records: MemoryRecord[], policy: { maxActiveItems: number; maxActiveChars: number }): MemoryRecord[] {
  const active = records.filter((record) => record.lifecycle === 'active').sort((a, b) => a.sequence - b.sequence);
  const maxItems = Math.max(1, Math.trunc(policy.maxActiveItems));
  const maxChars = Math.max(1, Math.trunc(policy.maxActiveChars));
  const totalChars = active.reduce((sum, record) => sum + record.content.length, 0);
  if (active.length <= maxItems && totalChars <= maxChars) return [];
  const keepFrom = Math.max(0, active.length - maxItems);
  const candidates = active.slice(0, keepFrom);
  const candidateIds = new Set(candidates.map((record) => record.id));
  let candidateChars = candidates.reduce((sum, record) => sum + record.content.length, 0);
  if (totalChars > maxChars) {
    for (const record of active) {
      if (candidateIds.has(record.id)) continue;
      candidates.push(record); candidateIds.add(record.id); candidateChars += record.content.length;
      if (totalChars - candidateChars <= maxChars) break;
    }
  }
  return candidates.sort((a, b) => a.sequence - b.sequence);
}
