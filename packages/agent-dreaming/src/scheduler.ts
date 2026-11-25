import type { DatabaseSync } from 'node:sqlite';

export interface ScheduledDreamingJob {
  id: string;
  scope: string;
  dueAt: number;
  intervalMs?: number;
  attempts: number;
}

export interface DurableSchedulerOptions {
  leaseMs?: number;
  retryBaseMs?: number;
  maxAttempts?: number;
  clock?: () => number;
}

/**
 * Minimal durable scheduler backed by the same SQLite database as Dreaming.
 * Jobs survive process restarts; a worker claims due jobs using expiring leases.
 */
export class SqliteDreamingScheduler {
  private readonly leaseMs: number;
  private readonly retryBaseMs: number;
  private readonly maxAttempts: number;
  private readonly clock: () => number;

  constructor(private readonly db: DatabaseSync, options: DurableSchedulerOptions = {}) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.clock = options.clock ?? Date.now;
    for (const [name, value] of Object.entries({
      leaseMs: this.leaseMs, retryBaseMs: this.retryBaseMs, maxAttempts: this.maxAttempts,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
    }
    db.exec(
      'CREATE TABLE IF NOT EXISTS dreaming_jobs (' +
      'id TEXT PRIMARY KEY, scope TEXT NOT NULL, due_at INTEGER NOT NULL, interval_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, ' +
      'lease_owner TEXT, lease_until INTEGER, last_error TEXT, updated_at INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS dreaming_jobs_due ON dreaming_jobs(due_at,lease_until);',
    );
  }

  schedule(input: { id: string; scope: string; dueAt?: number; intervalMs?: number }): void {
    if (!input.id.trim() || !input.scope.trim()) throw new TypeError('Job id and scope are required.');
    if (input.intervalMs !== undefined && (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1_000)) {
      throw new TypeError('intervalMs must be at least 1000.');
    }
    const dueAt = input.dueAt ?? this.clock();
    if (!Number.isSafeInteger(dueAt)) throw new TypeError('dueAt must be a Unix timestamp in milliseconds.');
    this.db.prepare(
      'INSERT INTO dreaming_jobs(id,scope,due_at,interval_ms,attempts,updated_at) VALUES(?,?,?,?,0,?) ' +
      'ON CONFLICT(id) DO NOTHING',
    ).run(input.id, input.scope, dueAt, input.intervalMs ?? null, this.clock());
  }

  claim(owner: string, limit = 20): ScheduledDreamingJob[] {
    if (!owner.trim()) throw new TypeError('Scheduler owner is required.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be between 1 and 500.');
    const now = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(
        'SELECT id,scope,due_at,interval_ms,attempts FROM dreaming_jobs ' +
        'WHERE due_at<=? AND (lease_until IS NULL OR lease_until<=?) AND attempts<? ORDER BY due_at LIMIT ?',
      ).all(now, now, this.maxAttempts, limit) as Array<{
        id: string; scope: string; due_at: number; interval_ms: number | null; attempts: number;
      }>;
      const update = this.db.prepare('UPDATE dreaming_jobs SET lease_owner=?,lease_until=?,updated_at=? WHERE id=?');
      for (const row of rows) update.run(owner, now + this.leaseMs, now, row.id);
      this.db.exec('COMMIT');
      return rows.map((row) => ({
        id: row.id, scope: row.scope, dueAt: row.due_at,
        ...(row.interval_ms === null ? {} : { intervalMs: row.interval_ms }),
        attempts: row.attempts,
      }));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  complete(input: { id: string; owner: string }): boolean {
    const row = this.db.prepare('SELECT interval_ms FROM dreaming_jobs WHERE id=? AND lease_owner=?')
      .get(input.id, input.owner) as { interval_ms: number | null } | undefined;
    if (!row) return false;
    if (row.interval_ms === null) {
      return this.db.prepare('DELETE FROM dreaming_jobs WHERE id=? AND lease_owner=?').run(input.id, input.owner).changes === 1;
    }
    const nextDue = this.clock() + row.interval_ms;
    return this.db.prepare(
      'UPDATE dreaming_jobs SET due_at=?,attempts=0,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND lease_owner=?',
    ).run(nextDue, this.clock(), input.id, input.owner).changes === 1;
  }

  fail(input: { id: string; owner: string; error: unknown }): boolean {
    const now = this.clock();
    const row = this.db.prepare('SELECT attempts,interval_ms FROM dreaming_jobs WHERE id=? AND lease_owner=?')
      .get(input.id, input.owner) as { attempts: number; interval_ms: number | null } | undefined;
    if (!row) return false;
    const attempts = row.attempts + 1;
    const delay = Math.min(60 * 60_000, this.retryBaseMs * 2 ** Math.min(attempts - 1, 10));
    return this.db.prepare(
      'UPDATE dreaming_jobs SET attempts=?,due_at=?,lease_owner=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_owner=?',
    ).run(attempts, now + delay, String(input.error).slice(0, 4_000), now, input.id, input.owner).changes === 1;
  }

  listDeadLetters(limit = 100): Array<{ id: string; scope: string; attempts: number; lastError: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError('limit must be between 1 and 1000.');
    return this.db.prepare(
      'SELECT id,scope,attempts,last_error AS lastError FROM dreaming_jobs WHERE attempts>=? ORDER BY updated_at DESC LIMIT ?',
    ).all(this.maxAttempts, limit) as Array<{ id: string; scope: string; attempts: number; lastError: string | null }>;
  }

  retry(id: string): boolean {
    return this.db.prepare(
      'UPDATE dreaming_jobs SET attempts=0,due_at=?,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND attempts>=?',
    ).run(this.clock(), this.clock(), id, this.maxAttempts).changes === 1;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM dreaming_jobs WHERE id=?').run(id);
  }
}
