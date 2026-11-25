import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DreamingEvidence, DreamingExperience, DreamingMemory } from '../types.js';

export interface SqliteDreamingOptions {
  filename: string;
  busyTimeoutMs?: number;
}
export type SqliteRow = Record<string, any>;

export const encode = (value: unknown): string => JSON.stringify(value ?? null);
export const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;

export function mapExperience(row: SqliteRow): DreamingExperience {
  return {
    id: String(row.id),
    scope: String(row.scope),
    sequence: Number(row.sequence),
    content: String(row.content),
    createdAt: String(row.created_at),
    sourceRefs: decode<string[]>(row.refs),
    metadata: decode<Record<string, unknown>>(row.metadata),
  };
}

export function mapMemory(row: SqliteRow): DreamingMemory {
  return {
    id: String(row.id),
    scope: String(row.scope),
    content: String(row.content),
    status: row.status,
    importance: Number(row.importance),
    sourceRefs: decode<string[]>(row.refs),
    ...(row.last_validated_at ? { lastValidatedAt: String(row.last_validated_at) } : {}),
    ...(row.valid_until ? { validUntil: String(row.valid_until) } : {}),
    ...(row.confidence !== null ? { confidence: Number(row.confidence) } : {}),
    metadata: decode<Record<string, unknown>>(row.metadata),
  };
}

export function mapEvidence(row: SqliteRow): DreamingEvidence {
  return {
    ref: String(row.ref),
    content: String(row.content),
    kind: String(row.kind),
    ...(row.created_at ? { createdAt: String(row.created_at) } : {}),
    metadata: decode<Record<string, unknown>>(row.metadata),
  };
}

/** Owns the SQLite connection, schema and transaction boundary shared by store modules. */
export class SqliteDatabase {
  readonly db: DatabaseSync;
  private closed = false;

  constructor(options: SqliteDreamingOptions) {
    const filename = options.filename?.trim();
    if (!filename) throw new TypeError('filename is required');
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 30_000) {
      throw new TypeError('busyTimeoutMs must be an integer between 0 and 30000');
    }
    if (filename !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    }

    this.db = new DatabaseSync(filename, { timeout: busyTimeoutMs });
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS experiences(id TEXT PRIMARY KEY,scope TEXT NOT NULL,sequence INTEGER NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,refs TEXT NOT NULL,metadata TEXT NOT NULL,reviewed_at TEXT,UNIQUE(scope,sequence));' +
      'CREATE INDEX IF NOT EXISTS experiences_scope_seq ON experiences(scope,sequence);' +
      'CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,importance REAL NOT NULL,refs TEXT NOT NULL,last_validated_at TEXT,valid_until TEXT,confidence REAL,metadata TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS memories_scope_status ON memories(scope,status,importance DESC);' +
      'CREATE TABLE IF NOT EXISTS relationships(id TEXT PRIMARY KEY,scope TEXT NOT NULL,from_id TEXT NOT NULL,to_id TEXT NOT NULL,kind TEXT NOT NULL,refs TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS relationships_scope_from ON relationships(scope,from_id);' +
      'CREATE INDEX IF NOT EXISTS relationships_scope_to ON relationships(scope,to_id);' +
      'CREATE TABLE IF NOT EXISTS evidence(ref TEXT PRIMARY KEY,scope TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT,metadata TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY,scope TEXT NOT NULL,memory_id TEXT NOT NULL,occurred_at TEXT NOT NULL,payload TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS feedback_memory_time ON feedback(scope,memory_id,occurred_at);' +
      'CREATE TABLE IF NOT EXISTS checkpoints(scope TEXT PRIMARY KEY,after_sequence INTEGER NOT NULL,last_run_at TEXT,last_run_id TEXT);' +
      'CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,payload TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS runs_scope_started ON runs(scope,started_at DESC);' +
      'CREATE TABLE IF NOT EXISTS proposals(proposal_id TEXT PRIMARY KEY,scope TEXT NOT NULL,run_id TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,evidence TEXT NOT NULL,created_at TEXT NOT NULL,reviewed_at TEXT,reviewed_by TEXT);' +
      'CREATE INDEX IF NOT EXISTS proposals_scope_status ON proposals(scope,status,created_at);' +
      'CREATE TABLE IF NOT EXISTS applied_proposals(proposal_id TEXT PRIMARY KEY,scope TEXT NOT NULL,applied_at TEXT NOT NULL,payload TEXT NOT NULL DEFAULT \'\');' +
      'CREATE TABLE IF NOT EXISTS leases(scope TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);'
    );

    const appliedColumns = this.db.prepare('PRAGMA table_info(applied_proposals)').all() as SqliteRow[];
    if (!appliedColumns.some((column) => column.name === 'payload')) {
      this.db.exec("ALTER TABLE applied_proposals ADD COLUMN payload TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec('PRAGMA user_version=2');
    if (filename !== ':memory:') {
      try { chmodSync(filename, 0o600); } catch { /* Directory permissions still protect the database. */ }
    }
  }

  ensureOpen(): void {
    if (this.closed) throw new Error('SQLite store is closed');
  }

  transaction<T>(operation: () => T): T {
    this.ensureOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  insertMemory(memory: DreamingMemory, status: DreamingMemory['status']): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO memories(id,scope,content,status,importance,refs,last_validated_at,valid_until,confidence,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      memory.id, memory.scope, memory.content, status, memory.importance,
      encode(memory.sourceRefs), memory.lastValidatedAt ?? null, memory.validUntil ?? null,
      memory.confidence ?? null, encode(memory.metadata ?? {}), now, now,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
