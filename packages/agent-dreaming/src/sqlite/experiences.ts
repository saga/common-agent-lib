import type {
  DreamingCheckpoint, DreamingExperience, DreamingPage, DreamingRun,
} from '../types.js';
import type { SqliteDatabase } from './database.js';
import { encode, mapExperience, type SqliteRow } from './database.js';

function assertLimit(limit: number, max = 10_000): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new TypeError(`limit must be an integer between 1 and ${max}`);
  }
  return limit;
}

export class SqliteExperienceStore {
  constructor(private readonly context: SqliteDatabase) {}

  async appendExperience(input: Omit<DreamingExperience, 'sequence'> & { sequence?: number }): Promise<DreamingExperience> {
    this.context.ensureOpen();
    this.context.transaction(() => {
      const old = this.context.db.prepare('SELECT * FROM experiences WHERE id=?').get(input.id) as SqliteRow | undefined;
      if (old) {
        const same = old.scope === input.scope
          && old.content === input.content
          && old.created_at === input.createdAt
          && (input.sequence === undefined || Number(old.sequence) === input.sequence)
          && String(old.refs) === encode(input.sourceRefs)
          && String(old.metadata) === encode(input.metadata ?? {});
        if (!same) throw new Error('Conflicting experience ID: ' + input.id);
        return;
      }
      const sequence = input.sequence ?? Number((
        this.context.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM experiences WHERE scope=?').get(input.scope) as SqliteRow
      ).n);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new TypeError('Experience sequence must be a positive safe integer');
      }
      this.context.db.prepare(
        'INSERT INTO experiences(id,scope,sequence,content,created_at,refs,metadata) VALUES(?,?,?,?,?,?,?)'
      ).run(
        input.id, input.scope, sequence, input.content, input.createdAt,
        encode(input.sourceRefs), encode(input.metadata ?? {}),
      );
    });
    return mapExperience(this.context.db.prepare('SELECT * FROM experiences WHERE id=?').get(input.id) as SqliteRow);
  }

  async loadExperiences(input: {
    scope: string; afterSequence: number; reviewBefore?: string; limit: number;
  }): Promise<DreamingPage<DreamingExperience>> {
    this.context.ensureOpen();
    const limit = assertLimit(input.limit);
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new TypeError('afterSequence must be a non-negative safe integer');
    }
    const rows = this.context.db.prepare(
      'SELECT * FROM experiences WHERE scope=? AND (sequence>? OR (? IS NOT NULL AND (reviewed_at IS NULL OR reviewed_at<=?))) ORDER BY sequence LIMIT ?'
    ).all(input.scope, input.afterSequence, input.reviewBefore ?? null, input.reviewBefore ?? null, limit + 1) as SqliteRow[];
    return {
      items: rows.slice(0, limit).map(mapExperience),
      hasMore: rows.length > limit,
    };
  }

  async markExperiencesReviewed(input: {
    scope: string; ids: readonly string[]; reviewedAt: string;
  }): Promise<void> {
    this.context.ensureOpen();
    if (!input.ids.length) return;
    const statement = this.context.db.prepare(
      'UPDATE experiences SET reviewed_at=? WHERE scope=? AND id=?'
    );
    this.context.transaction(() => {
      for (const id of input.ids) statement.run(input.reviewedAt, input.scope, id);
    });
  }

  async loadCheckpoint(scope: string): Promise<DreamingCheckpoint> {
    this.context.ensureOpen();
    const row = this.context.db.prepare('SELECT * FROM checkpoints WHERE scope=?').get(scope) as SqliteRow | undefined;
    return row
      ? {
          scope,
          afterSequence: Number(row.after_sequence),
          ...(row.last_run_at ? { lastRunAt: String(row.last_run_at) } : {}),
          ...(row.last_run_id ? { lastRunId: String(row.last_run_id) } : {}),
        }
      : { scope, afterSequence: 0 };
  }

  async saveCheckpoint(checkpoint: DreamingCheckpoint): Promise<void> {
    this.context.ensureOpen();
    if (!Number.isSafeInteger(checkpoint.afterSequence) || checkpoint.afterSequence < 0) {
      throw new TypeError('Checkpoint afterSequence must be a non-negative safe integer');
    }
    this.context.db.prepare(
      'INSERT INTO checkpoints(scope,after_sequence,last_run_at,last_run_id) VALUES(?,?,?,?) ' +
      'ON CONFLICT(scope) DO UPDATE SET after_sequence=MAX(after_sequence,excluded.after_sequence),last_run_at=excluded.last_run_at,last_run_id=excluded.last_run_id'
    ).run(checkpoint.scope, checkpoint.afterSequence, checkpoint.lastRunAt ?? null, checkpoint.lastRunId ?? null);
  }

  async createRun(run: DreamingRun): Promise<void> {
    this.context.ensureOpen();
    this.context.db.prepare(
      'INSERT INTO runs(id,scope,status,started_at,finished_at,payload) VALUES(?,?,?,?,?,?)'
    ).run(run.id, run.scope, run.status, run.startedAt, run.finishedAt ?? null, encode(run));
  }

  async updateRun(run: DreamingRun): Promise<void> {
    this.context.ensureOpen();
    const result = this.context.db.prepare(
      'UPDATE runs SET status=?,finished_at=?,payload=? WHERE id=? AND scope=?'
    ).run(run.status, run.finishedAt ?? null, encode(run), run.id, run.scope);
    if (Number(result.changes) !== 1) throw new Error(`Dreaming run not found: ${run.id}`);
  }

  async getRun(input: { scope: string; runId: string }): Promise<DreamingRun | undefined> {
    this.context.ensureOpen();
    const row = this.context.db.prepare('SELECT payload FROM runs WHERE scope=? AND id=?')
      .get(input.scope, input.runId) as SqliteRow | undefined;
    return row ? (JSON.parse(String(row.payload)) as DreamingRun) : undefined;
  }

  async listRuns(input: {
    scope: string;
    status?: DreamingRun['status'];
    limit?: number;
    before?: string;
  }): Promise<DreamingRun[]> {
    this.context.ensureOpen();
    const limit = assertLimit(input.limit ?? 50, 500);
    const filters = ['scope=?'];
    const params: unknown[] = [input.scope];
    if (input.status) { filters.push('status=?'); params.push(input.status); }
    if (input.before) { filters.push('started_at<?'); params.push(input.before); }
    params.push(limit);
    const rows = this.context.db.prepare(
      `SELECT payload FROM runs WHERE ${filters.join(' AND ')} ORDER BY started_at DESC,id DESC LIMIT ?`
    ).all(...params) as SqliteRow[];
    return rows.map((row) => JSON.parse(String(row.payload)) as DreamingRun);
  }
}
