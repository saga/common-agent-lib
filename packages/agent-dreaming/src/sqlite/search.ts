import type {
  DreamingEvidence, DreamingExperience, DreamingMemory, DreamingOrigin,
  DreamingSearchHit, DreamingSearchRequest,
} from '../types.js';
import type { SqliteDatabase } from './database.js';
import { decode, mapEvidence, mapExperience, mapMemory, type SqliteRow } from './database.js';

function assertLimit(limit: number, max = 200): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new TypeError(`limit must be an integer between 1 and ${max}`);
  }
  return limit;
}

/** Keep user text out of the FTS query language; CJK is handled by bounded substring matching. */
function buildFtsQuery(query: string): string | undefined {
  const terms = query.normalize('NFKC').match(/[A-Za-z0-9_]+/gu) ?? [];
  const unique = [...new Set(terms.map((term) => term.toLocaleLowerCase()))].slice(0, 12);
  return unique.length ? unique.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ') : undefined;
}

function cjkTerms(query: string): string[] {
  const runs = query.normalize('NFKC').match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) ?? [];
  const terms = new Set<string>();
  for (const run of runs) {
    if ([...run].length === 1) terms.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      terms.add(run.slice(index, index + 2));
      if (terms.size >= 12) return [...terms];
    }
  }
  return [...terms];
}

function mapExperienceHit(row: SqliteRow, score: number): DreamingSearchHit {
  const item = mapExperience(row);
  return {
    id: item.id, scope: item.scope, sourceType: 'experience', content: item.content,
    score, sourceRefs: item.sourceRefs, createdAt: item.createdAt,
    revision: item.createdAt, origin: item.origin, metadata: item.metadata,
  };
}

function mapMemoryHit(row: SqliteRow, score: number): DreamingSearchHit {
  const item = mapMemory(row);
  return {
    id: item.id, scope: item.scope, sourceType: 'memory', content: item.content,
    score, sourceRefs: item.sourceRefs, revision: String(row.updated_at),
    createdAt: String(row.created_at), memoryType: item.memoryType,
    authority: item.authority, status: item.status, importance: item.importance,
    confidence: item.confidence, metadata: item.metadata,
  };
}

function mapEvidenceHit(row: SqliteRow, score: number): DreamingSearchHit {
  const item: DreamingEvidence = mapEvidence(row);
  return {
    id: item.ref, scope: String(row.scope), sourceType: 'evidence',
    content: item.content, score, sourceRefs: [item.ref], createdAt: item.createdAt,
    revision: item.createdAt ?? item.ref, kind: item.kind,
    origin: item.origin, metadata: item.metadata,
  };
}

export class SqliteSearchStore {
  constructor(private readonly context: SqliteDatabase) {}

  async search(input: DreamingSearchRequest): Promise<DreamingSearchHit[]> {
    this.context.ensureOpen();
    if (!input.scope.trim()) throw new TypeError('scope is required');
    if (!input.query.trim()) throw new TypeError('query is required');
    if (input.query.length > 4_000) throw new TypeError('query must not exceed 4000 characters');
    const limit = assertLimit(input.limit ?? 20);
    const types = new Set(input.sourceTypes ?? ['memory', 'experience', 'evidence']);
    const allowed = new Set(['memory', 'experience', 'evidence']);
    for (const type of types) if (!allowed.has(type)) throw new TypeError('Unsupported search source type: ' + type);

    const results: DreamingSearchHit[] = [];
    if (types.has('memory')) results.push(...this.searchMemories(input.scope, input.query, limit, input.includeCandidates === true));
    if (types.has('experience')) results.push(...this.searchExperiences(input.scope, input.query, limit));
    if (types.has('evidence')) results.push(...this.searchEvidence(input.scope, input.query, limit));

    const priority: Record<DreamingSearchHit['sourceType'], number> = {
      memory: 3, experience: 2, evidence: 1,
    };
    return results.sort((a, b) =>
      b.score - a.score || priority[b.sourceType] - priority[a.sourceType]
      || (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
    ).slice(0, limit);
  }

  async listAlwaysOnMemories(input: { scope: string; limit?: number }): Promise<DreamingSearchHit[]> {
    this.context.ensureOpen();
    if (!input.scope.trim()) throw new TypeError('scope is required');
    const limit = assertLimit(input.limit ?? 12, 100);
    const now = new Date().toISOString();
    const rows = this.context.db.prepare(
      `SELECT * FROM memories
       WHERE scope=? AND status='confirmed' AND (valid_until IS NULL OR valid_until>?)
         AND (
           authority='user-explicit'
           OR (memory_type IN ('preference','constraint','goal') AND importance>=0.75)
         )
       ORDER BY CASE WHEN authority='user-explicit' THEN 0 ELSE 1 END,
         importance DESC, updated_at DESC
       LIMIT ?`
    ).all(input.scope, now, limit) as SqliteRow[];
    return rows.map((row) => mapMemoryHit(row, row.authority === 'user-explicit' ? 1 : Number(row.importance)));
  }

  private searchExperiences(scope: string, query: string, limit: number): DreamingSearchHit[] {
    const results = new Map<string, DreamingSearchHit>();
    const fts = buildFtsQuery(query);
    if (fts) {
      const rows = this.context.db.prepare(
        `SELECT e.*, bm25(experience_search) AS search_rank
         FROM experience_search
         JOIN experiences e ON e.id=experience_search.id AND e.scope=experience_search.scope
         WHERE experience_search.scope=? AND experience_search MATCH ?
         ORDER BY bm25(experience_search), e.created_at DESC LIMIT ?`
      ).all(scope, fts, limit) as SqliteRow[];
      for (const row of rows) results.set(String(row.id), mapExperienceHit(row, 1 + Math.min(1, Math.abs(Number(row.search_rank)) * 10_000)));
    }
    const terms = cjkTerms(query);
    if (terms.length) {
      const predicates = terms.map(() => 'instr(content, ?) > 0').join(' OR ');
      const scoreExpr = terms.map(() => 'CASE WHEN instr(content, ?) > 0 THEN 1 ELSE 0 END').join(' + ');
      const rows = this.context.db.prepare(
        `SELECT *, (${scoreExpr}) AS matched_terms FROM experiences
         WHERE scope=? AND (${predicates})
         ORDER BY matched_terms DESC, created_at DESC LIMIT ?`
      ).all(...terms, scope, ...terms, limit) as SqliteRow[];
      for (const row of rows) {
        const score = Number(row.matched_terms) / terms.length;
        const hit = mapExperienceHit(row, score);
        const old = results.get(hit.id);
        if (!old || old.score < hit.score) results.set(hit.id, hit);
      }
    }
    return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private searchEvidence(scope: string, query: string, limit: number): DreamingSearchHit[] {
    const results = new Map<string, DreamingSearchHit>();
    const fts = buildFtsQuery(query);
    if (fts) {
      const rows = this.context.db.prepare(
        `SELECT e.*, bm25(evidence_search) AS search_rank
         FROM evidence_search
         JOIN evidence e ON e.ref=evidence_search.ref AND e.scope=evidence_search.scope
         WHERE evidence_search.scope=? AND evidence_search MATCH ?
         ORDER BY bm25(evidence_search), e.created_at DESC LIMIT ?`
      ).all(scope, fts, limit) as SqliteRow[];
      for (const row of rows) results.set(String(row.ref), mapEvidenceHit(row, 1 + Math.min(1, Math.abs(Number(row.search_rank)) * 10_000)));
    }
    const terms = cjkTerms(query);
    if (terms.length) {
      const predicates = terms.map(() => 'instr(content, ?) > 0').join(' OR ');
      const scoreExpr = terms.map(() => 'CASE WHEN instr(content, ?) > 0 THEN 1 ELSE 0 END').join(' + ');
      const rows = this.context.db.prepare(
        `SELECT *, (${scoreExpr}) AS matched_terms FROM evidence
         WHERE scope=? AND (${predicates})
         ORDER BY matched_terms DESC, created_at DESC LIMIT ?`
      ).all(...terms, scope, ...terms, limit) as SqliteRow[];
      for (const row of rows) {
        const score = Number(row.matched_terms) / terms.length;
        const hit = mapEvidenceHit(row, score);
        const old = results.get(hit.id);
        if (!old || old.score < hit.score) results.set(hit.id, hit);
      }
    }
    return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private searchMemories(scope: string, query: string, limit: number, includeCandidates: boolean): DreamingSearchHit[] {
    const results = new Map<string, DreamingSearchHit>();
    const fts = buildFtsQuery(query);
    const statuses = includeCandidates ? "('confirmed','candidate')" : "('confirmed')";
    if (fts) {
      const rows = this.context.db.prepare(
        `SELECT m.*, bm25(memory_search) AS search_rank
         FROM memory_search
         JOIN memories m ON m.id=memory_search.id AND m.scope=memory_search.scope
         WHERE memory_search.scope=? AND memory_search MATCH ?
           AND m.status IN ${statuses}
           AND (m.valid_until IS NULL OR m.valid_until>?)
         ORDER BY bm25(memory_search), m.importance DESC LIMIT ?`
      ).all(scope, fts, new Date().toISOString(), limit) as SqliteRow[];
      for (const row of rows) results.set(String(row.id), mapMemoryHit(row, 1 + Math.min(1, Math.abs(Number(row.search_rank)) * 10_000)));
    }
    const terms = cjkTerms(query);
    if (terms.length) {
      const predicates = terms.map(() => 'instr(content, ?) > 0').join(' OR ');
      const scoreExpr = terms.map(() => 'CASE WHEN instr(content, ?) > 0 THEN 1 ELSE 0 END').join(' + ');
      const rows = this.context.db.prepare(
        `SELECT *, (${scoreExpr}) AS matched_terms FROM memories
         WHERE scope=? AND status IN ${statuses}
           AND (valid_until IS NULL OR valid_until>?) AND (${predicates})
         ORDER BY matched_terms DESC, importance DESC, updated_at DESC LIMIT ?`
      ).all(...terms, scope, new Date().toISOString(), ...terms, limit) as SqliteRow[];
      for (const row of rows) {
        const score = Number(row.matched_terms) / terms.length;
        const hit = mapMemoryHit(row, score);
        const old = results.get(hit.id);
        if (!old || old.score < hit.score) results.set(hit.id, hit);
      }
    }
    return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
