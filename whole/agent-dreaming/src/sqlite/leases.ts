import type { SqliteDatabase } from './database.js';
import type { SqliteRow } from './database.js';

export class SqliteLeaseStore {
  constructor(private readonly context: SqliteDatabase) {}

  async acquireLease(input: { scope: string; owner: string; leaseMs: number }): Promise<boolean> {
    this.context.ensureOpen();
    this.validate(input);
    return this.context.transaction(() => {
      const now = Date.now();
      const old = this.context.db.prepare(
        'SELECT owner,expires_at FROM leases WHERE scope=?'
      ).get(input.scope) as SqliteRow | undefined;
      if (old && Number(old.expires_at) > now && old.owner !== input.owner) return false;
      this.context.db.prepare(
        'INSERT INTO leases(scope,owner,expires_at) VALUES(?,?,?) ' +
        'ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at'
      ).run(input.scope, input.owner, now + input.leaseMs);
      return true;
    });
  }

  async renewLease(input: { scope: string; owner: string; leaseMs: number }): Promise<boolean> {
    this.context.ensureOpen();
    this.validate(input);
    const now = Date.now();
    const result = this.context.db.prepare(
      'UPDATE leases SET expires_at=? WHERE scope=? AND owner=? AND expires_at>?'
    ).run(now + input.leaseMs, input.scope, input.owner, now);
    return Number(result.changes) === 1;
  }

  async releaseLease(input: { scope: string; owner: string }): Promise<void> {
    this.context.ensureOpen();
    this.context.db.prepare('DELETE FROM leases WHERE scope=? AND owner=?').run(input.scope, input.owner);
  }

  private validate(input: { scope: string; owner: string; leaseMs: number }): void {
    if (!input.scope.trim() || !input.owner.trim()
      || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new TypeError('Lease scope, owner and positive integer leaseMs are required');
    }
  }
}
