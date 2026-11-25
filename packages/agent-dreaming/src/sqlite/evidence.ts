import type { DreamingEvidence, DreamingEvidenceResolver } from '../types.js';
import type { SqliteDatabase } from './database.js';
import { encode, mapEvidence, type SqliteRow } from './database.js';

export class SqliteEvidenceStore implements DreamingEvidenceResolver {
  constructor(private readonly context: SqliteDatabase) {}

  async putEvidence(scope: string, evidence: DreamingEvidence): Promise<void> {
    this.context.ensureOpen();
    this.context.transaction(() => {
      const old = this.context.db.prepare('SELECT scope FROM evidence WHERE ref=?').get(evidence.ref) as SqliteRow | undefined;
      if (old && old.scope !== scope) {
        throw new Error('Evidence reference belongs to another scope: ' + evidence.ref);
      }
      this.context.db.prepare(
        'INSERT INTO evidence(ref,scope,content,kind,created_at,metadata) VALUES(?,?,?,?,?,?) ' +
        'ON CONFLICT(ref) DO UPDATE SET content=excluded.content,kind=excluded.kind,created_at=excluded.created_at,metadata=excluded.metadata'
      ).run(scope === '' ? evidence.ref : evidence.ref, scope, evidence.content, evidence.kind,
        evidence.createdAt ?? null, encode(evidence.metadata ?? {}));
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
