import type { DreamingEvidence, DreamingEvidenceResolver } from '../types.js';
import type { SqliteDatabase } from './database.js';
import { encode, mapEvidence, type SqliteRow } from './database.js';

export class SqliteEvidenceStore implements DreamingEvidenceResolver {
  constructor(private readonly context: SqliteDatabase) {}

  async putEvidence(scope: string, evidence: DreamingEvidence): Promise<void> {
    this.context.ensureOpen();
    if (!scope.trim() || !evidence.ref.trim() || !evidence.kind.trim()) {
      throw new TypeError('Evidence scope, ref and kind are required.');
    }
    if (evidence.expiresAt !== undefined && !Number.isFinite(Date.parse(evidence.expiresAt))) {
      throw new TypeError('Evidence expiresAt must be a valid timestamp.');
    }
    // Normalize to UTC ISO so SQLite comparisons are chronologically reliable.
    const expiresAt = evidence.expiresAt === undefined ? null : new Date(evidence.expiresAt).toISOString();
    this.context.transaction(() => {
      const old = this.context.db.prepare('SELECT * FROM evidence WHERE ref=?')
        .get(evidence.ref) as SqliteRow | undefined;
      if (old) {
        if (old.scope !== scope) {
          throw new Error('Evidence reference belongs to another scope: ' + evidence.ref);
        }
        const same = old.content === evidence.content
          && old.kind === evidence.kind
          && old.created_at === (evidence.createdAt ?? null)
          && old.expires_at === expiresAt
          && String(old.metadata) === encode(evidence.metadata ?? {})
          && (old.origin == null ? evidence.origin === undefined : String(old.origin) === encode(evidence.origin));
        if (!same) {
          throw new Error('Evidence references are immutable; use a new versioned reference: ' + evidence.ref);
        }
        return;
      }
      this.context.db.prepare(
        'INSERT INTO evidence(ref,scope,content,kind,created_at,metadata,origin,expires_at) VALUES(?,?,?,?,?,?,?,?)'
      ).run(evidence.ref, scope, evidence.content, evidence.kind,
        evidence.createdAt ?? null, encode(evidence.metadata ?? {}), evidence.origin ? encode(evidence.origin) : null,
        expiresAt);
    });
  }

  async resolve(input: { scope: string; refs: readonly string[] }): Promise<readonly DreamingEvidence[]> {
    this.context.ensureOpen();
    if (!input.refs.length) return [];
    const refs = [...new Set(input.refs)].slice(0, 900);
    const rows = this.context.db.prepare(
      `SELECT * FROM evidence WHERE scope=? AND ref IN (${refs.map(() => '?').join(',')})`
    ).all(input.scope, ...refs) as SqliteRow[];
    const byRef = new Map(rows.map((row) => [String(row.ref), mapEvidence(row)]));
    return input.refs.flatMap((ref) => {
      const value = byRef.get(ref);
      return value ? [value] : [];
    });
  }
}
