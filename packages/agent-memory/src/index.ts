import * as z from 'zod';

export const MemoryKindSchema = z.enum(['message', 'turn', 'tool-call', 'finding', 'evidence', 'decision', 'artifact', 'note', 'summary']);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;
export const MemoryLifecycleSchema = z.enum(['active', 'archived']);
export type MemoryLifecycle = z.infer<typeof MemoryLifecycleSchema>;

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
  tags: z.array(z.string()).default([]),
  sourceRefs: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

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

export interface WorkingMemoryPolicy { maxItems: number; maxChars: number; keepImportanceAtLeast?: number; }
export interface WorkingMemoryResult { included: MemoryRecord[]; omitted: MemoryRecord[]; includedChars: number; omittedCount: number; }

/** 从持久化记忆中构造有界工作记忆；被排除的记录仍可通过分页再次读取。 */
export function buildWorkingMemory(records: MemoryRecord[], policy: WorkingMemoryPolicy): WorkingMemoryResult {
  const maxItems = Math.max(1, Math.trunc(policy.maxItems));
  const maxChars = Math.max(1, Math.trunc(policy.maxChars));
  const threshold = policy.keepImportanceAtLeast ?? 0.8;
  const ordered = [...records].sort((a, b) => b.sequence - a.sequence);
  const kept: MemoryRecord[] = [];
  const keptIds = new Set<string>();
  let chars = 0;
  for (const record of ordered) {
    if (record.importance < threshold) continue;
    if (kept.length >= maxItems || chars + record.content.length > maxChars) continue;
    kept.push(record); keptIds.add(record.id); chars += record.content.length;
  }
  for (const record of ordered) {
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