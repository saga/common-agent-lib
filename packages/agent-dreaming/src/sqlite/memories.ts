import type {
  DreamingMemory, DreamingRelationship, DreamingMemoryVersion,
} from '../types.js';
import type { SqliteDatabase } from './database.js';
import type { MemoryRetriever } from '../retrieval.js';
import { encode, mapMemory, type SqliteRow } from './database.js';

function assertLimit(limit: number, max = 10_000): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new TypeError(`limit must be an integer between 1 and ${max}`);
  }
  return limit;
}

export class SqliteMemoryStore {
  constructor(private readonly context: SqliteDatabase, private readonly retriever?: MemoryRetriever) {}

  private snapshotBeforeChange(row: SqliteRow, reason: string): void {
    const memory = mapMemory(row);
    const version = Number((
      this.context.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS n FROM memory_versions WHERE scope=? AND memory_id=?')
        .get(memory.scope, memory.id) as SqliteRow
    ).n);
    this.context.db.prepare(
      'INSERT INTO memory_versions(scope,memory_id,version,reason,captured_at,payload) VALUES(?,?,?,?,?,?)'
    ).run(memory.scope, memory.id, version, reason, new Date().toISOString(), encode(memory));
  }

  async upsertMemory(memory: DreamingMemory): Promise<void> {
    this.context.ensureOpen();
    this.context.transaction(() => {
      const old = this.context.db.prepare('SELECT * FROM memories WHERE id=?').get(memory.id) as SqliteRow | undefined;
      if (old && old.scope !== memory.scope) {
        throw new Error('Memory ID belongs to another scope: ' + memory.id);
      }
      if (old?.authority === 'user-explicit' && memory.authority !== 'user-explicit') {
        throw new Error('User-explicit memory cannot be overwritten by derived memory: ' + memory.id);
      }
      if (old) this.snapshotBeforeChange(old, 'upsert');
      const now = new Date().toISOString();
      this.context.db.prepare(
        'INSERT INTO memories(id,scope,content,status,importance,refs,last_validated_at,valid_until,confidence,metadata,created_at,updated_at,memory_type,authority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET content=excluded.content,status=excluded.status,importance=excluded.importance,refs=excluded.refs,last_validated_at=excluded.last_validated_at,valid_until=excluded.valid_until,confidence=excluded.confidence,metadata=excluded.metadata,updated_at=excluded.updated_at,memory_type=excluded.memory_type,authority=excluded.authority'
      ).run(
        memory.id, memory.scope, memory.content, memory.status, memory.importance,
        encode(memory.sourceRefs), memory.lastValidatedAt ?? null, memory.validUntil ?? null,
        memory.confidence ?? null, encode(memory.metadata ?? {}), now, now, memory.memoryType ?? null, memory.authority ?? 'derived',
      );
    });
  }

  async loadMemories(input: {
    scope: string; experienceIds: readonly string[]; reviewBefore?: string; expiredBefore?: string; limit: number;
  }): Promise<readonly DreamingMemory[]> {
    this.context.ensureOpen();
    const limit = assertLimit(input.limit);
    const experienceIds = [...new Set(input.experienceIds)].filter(Boolean);
    let relevantRefs: string[] = [];
    let experienceTexts: string[] = [];
    if (experienceIds.length) {
      const placeholders = experienceIds.map(() => '?').join(',');
      const rows = this.context.db.prepare(
        `SELECT refs,content FROM experiences WHERE scope=? AND id IN (${placeholders})`
      ).all(input.scope, ...experienceIds) as SqliteRow[];
      relevantRefs = [...new Set(rows.flatMap((row) => {
        try { return JSON.parse(String(row.refs)) as string[]; } catch { return []; }
      }))].filter(Boolean).slice(0, 500);
      experienceTexts = rows.map((row) => String(row.content)).filter((value) => value.trim()).slice(0, 20);
    }

    const rows = this.context.db.prepare(
      `SELECT * FROM memories
       WHERE scope=? AND status IN ('candidate','confirmed')
       ORDER BY CASE WHEN authority='user-explicit' THEN 0 ELSE 1 END,
       CASE
         WHEN valid_until IS NOT NULL AND valid_until<=? THEN 0
         WHEN last_validated_at IS NULL OR last_validated_at<=? THEN 1
         ELSE 2
       END,
       importance DESC, updated_at DESC
       LIMIT 10000`
    ).all(
      input.scope,
      input.expiredBefore ?? new Date().toISOString(),
      input.reviewBefore ?? '1970-01-01T00:00:00.000Z',
    ) as SqliteRow[];

    const memories = rows.map(mapMemory);
    const vectorScores = new Map<string, number>();
    if (this.retriever && experienceTexts.length && memories.length) {
      try {
        // Backfill missing vectors lazily. The index implementation is idempotent by scope/id/provider.
        for (const memory of memories) {
          await this.retriever.index({
            scope: input.scope, memoryId: memory.id, content: memory.content,
          });
        }
        for (const query of experienceTexts) {
          const matches = await this.retriever.search({
            scope: input.scope, query, limit: Math.min(200, memories.length), minScore: 0.15,
          });
          for (const match of matches) {
            vectorScores.set(match.memoryId, Math.max(vectorScores.get(match.memoryId) ?? -1, match.score));
          }
        }
      } catch (error) {
        // Transformers.js is optional. Without it, source-reference and recency ranking remain available.
        if (!(error instanceof Error) || !error.message.includes('optional @huggingface/transformers')) throw error;
      }
    }

    const refSet = new Set(relevantRefs);
    const now = input.expiredBefore ?? new Date().toISOString();
    const reviewBefore = input.reviewBefore ?? '1970-01-01T00:00:00.000Z';
    const ranked = memories.map((memory) => {
      const explicitRank = memory.authority === 'user-explicit' ? 0 : 1;
      const dueRank = memory.validUntil && memory.validUntil <= now ? 0
        : !memory.lastValidatedAt || memory.lastValidatedAt <= reviewBefore ? 1 : 2;
      const sourceMatch = memory.sourceRefs.some((ref) => refSet.has(ref));
      return { memory, explicitRank, dueRank, vectorScore: vectorScores.get(memory.id) ?? -1, sourceMatch };
    });
    ranked.sort((a, b) =>
      a.explicitRank - b.explicitRank
      || a.dueRank - b.dueRank
      || b.vectorScore - a.vectorScore
      || Number(b.sourceMatch) - Number(a.sourceMatch)
      || b.memory.importance - a.memory.importance,
    );
    return ranked.slice(0, limit).map((item) => item.memory);
  }

  async appendRelationship(relationship: DreamingRelationship): Promise<void> {
    this.context.ensureOpen();
    this.context.transaction(() => {
      const old = this.context.db.prepare('SELECT * FROM relationships WHERE id=?')
        .get(relationship.id) as SqliteRow | undefined;
      if (old) {
        const same = old.scope === relationship.scope
          && old.from_id === relationship.fromId
          && old.to_id === relationship.toId
          && old.kind === relationship.kind
          && String(old.refs) === encode(relationship.sourceRefs);
        if (!same) throw new Error('Conflicting relationship ID: ' + relationship.id);
        return;
      }
      this.context.db.prepare(
        'INSERT INTO relationships(id,scope,from_id,to_id,kind,refs) VALUES(?,?,?,?,?,?)'
      ).run(
        relationship.id, relationship.scope, relationship.fromId,
        relationship.toId, relationship.kind, encode(relationship.sourceRefs),
      );
    });
  }

  async loadRelationships(input: {
    scope: string; memoryIds: readonly string[]; limit: number;
  }): Promise<readonly DreamingRelationship[]> {
    this.context.ensureOpen();
    if (!input.memoryIds.length) return [];
    const limit = assertLimit(input.limit);
    const ids = [...new Set(input.memoryIds)];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.context.db.prepare(
      `SELECT * FROM relationships WHERE scope=? AND
       (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
       ORDER BY id LIMIT ?`
    ).all(input.scope, ...ids, ...ids, limit) as SqliteRow[];
    return rows.map((row) => ({
      id: String(row.id),
      scope: String(row.scope),
      fromId: String(row.from_id),
      toId: String(row.to_id),
      kind: String(row.kind),
      sourceRefs: JSON.parse(String(row.refs)) as string[],
    }));
  }

  async markMemoriesReviewed(input: {
    scope: string; ids: readonly string[]; reviewedAt: string;
  }): Promise<void> {
    this.context.ensureOpen();
    if (!input.ids.length) return;
    const statement = this.context.db.prepare(
      'UPDATE memories SET last_validated_at=?,updated_at=? WHERE scope=? AND id=?'
    );
    this.context.transaction(() => {
      for (const id of input.ids) statement.run(input.reviewedAt, input.reviewedAt, input.scope, id);
    });
  }

  async listMemories(scope: string, limit = 200): Promise<DreamingMemory[]> {
    this.context.ensureOpen();
    const bounded = assertLimit(limit, 1_000);
    return (this.context.db.prepare(
      'SELECT * FROM memories WHERE scope=? ORDER BY updated_at DESC LIMIT ?'
    ).all(scope, bounded) as SqliteRow[]).map(mapMemory);
  }

  async listMemoryVersions(input: {
    scope: string; memoryId: string; limit?: number;
  }): Promise<DreamingMemoryVersion[]> {
    this.context.ensureOpen();
    const limit = assertLimit(input.limit ?? 50, 500);
    const rows = this.context.db.prepare(
      'SELECT * FROM memory_versions WHERE scope=? AND memory_id=? ORDER BY version DESC LIMIT ?'
    ).all(input.scope, input.memoryId, limit) as SqliteRow[];
    return rows.map((row) => ({
      scope: String(row.scope),
      memoryId: String(row.memory_id),
      version: Number(row.version),
      reason: String(row.reason),
      capturedAt: String(row.captured_at),
      snapshot: JSON.parse(String(row.payload)) as DreamingMemory,
    }));
  }

  recordVersionBeforeMutation(row: SqliteRow, reason: string): void {
    this.snapshotBeforeChange(row, reason);
  }
}
