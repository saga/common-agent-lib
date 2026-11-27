import { createHash } from 'node:crypto';
import type { DreamingMemoryManifest } from '../types.js';
import type { SqliteDatabase, SqliteRow } from './database.js';
import { decode, encode } from './database.js';

type ManifestEntry = {
  kind: 'explicit-memory' | 'important-memory' | 'knowledge';
  id: string;
  title?: string;
  summary?: string;
  content: string;
  importance?: number;
  authority?: string;
  version?: number;
  tags?: string[];
  sourceRefs: string[];
};

function mapManifest(row: SqliteRow): DreamingMemoryManifest {
  return {
    scope: String(row.scope),
    version: Number(row.version),
    hash: String(row.hash),
    content: String(row.content),
    itemIds: decode<string[]>(row.item_ids),
    stale: Number(row.stale) !== 0,
    truncated: Number(row.truncated) !== 0,
    builtAt: String(row.built_at),
  };
}

/** Scope-local, persisted index. Source writes mark it dirty through SQLite triggers. */
export class SqliteMemoryManifestStore {
  constructor(private readonly context: SqliteDatabase) {}

  async get(scope: string): Promise<DreamingMemoryManifest> {
    this.context.ensureOpen();
    if (!scope.trim()) throw new TypeError('scope is required');
    const row = this.context.db.prepare(
      'SELECT * FROM memory_manifest_state WHERE scope=?'
    ).get(scope) as SqliteRow | undefined;
    if (row && Number(row.stale) === 0) return mapManifest(row);
    return this.rebuild(scope);
  }

  async rebuild(scope: string): Promise<DreamingMemoryManifest> {
    this.context.ensureOpen();
    if (!scope.trim()) throw new TypeError('scope is required');
    return this.context.transaction(() => {
      const now = new Date().toISOString();
      const explicit = this.context.db.prepare(
        "SELECT id,content,importance,authority,refs FROM memories WHERE scope=? AND authority='user-explicit' AND status='confirmed' AND (valid_until IS NULL OR valid_until>?) ORDER BY updated_at DESC LIMIT 500"
      ).all(scope, now) as SqliteRow[];
      const important = this.context.db.prepare(
        "SELECT id,content,importance,authority,refs FROM memories WHERE scope=? AND authority!='user-explicit' AND status='confirmed' AND importance>=0.65 AND (valid_until IS NULL OR valid_until>?) ORDER BY importance DESC,updated_at DESC LIMIT 100"
      ).all(scope, now) as SqliteRow[];
      const pages = this.context.db.prepare(
        "SELECT id,title,summary,content,tags,refs,version FROM knowledge_pages WHERE scope=? AND status='active' ORDER BY updated_at DESC LIMIT 100"
      ).all(scope) as SqliteRow[];

      const candidates: ManifestEntry[] = [
        ...explicit.map((row): ManifestEntry => ({
          kind: 'explicit-memory', id: String(row.id), content: String(row.content).slice(0, 800),
          authority: String(row.authority), importance: Number(row.importance),
          sourceRefs: decode<string[]>(row.refs).slice(0, 8),
        })),
        ...important.map((row): ManifestEntry => ({
          kind: 'important-memory', id: String(row.id), content: String(row.content).slice(0, 600),
          importance: Number(row.importance), authority: String(row.authority),
          sourceRefs: decode<string[]>(row.refs).slice(0, 6),
        })),
        ...pages.map((row): ManifestEntry => ({
          kind: 'knowledge', id: String(row.id), title: String(row.title).slice(0, 240),
          summary: String(row.summary).slice(0, 400), content: String(row.content).slice(0, 360),
          tags: decode<string[]>(row.tags).slice(0, 12), version: Number(row.version),
          sourceRefs: decode<string[]>(row.refs).slice(0, 8),
        })),
      ];
      const entries: ManifestEntry[] = [];
      const maxItems = 200;
      const maxChars = 16_000;
      let truncated = candidates.length > maxItems;
      for (const entry of candidates.slice(0, maxItems)) {
        if (JSON.stringify({ scope, entries: [...entries, entry] }).length > maxChars) {
          truncated = true;
          continue;
        }
        entries.push(entry);
      }
      const content = JSON.stringify({ scope, entries });
      const hash = createHash('sha256').update(scope).update('\0').update(content).digest('hex');
      const itemIds = entries.map((entry) => entry.id);
      const old = this.context.db.prepare(
        'SELECT version,hash FROM memory_manifest_state WHERE scope=?'
      ).get(scope) as SqliteRow | undefined;
      const version = old ? Number(old.version) + (String(old.hash) === hash ? 0 : 1) : 1;
      this.context.db.prepare(
        'INSERT INTO memory_manifest_state(scope,version,hash,content,item_ids,stale,truncated,item_count,built_at) VALUES(?,?,?,?,?,0,?,?,?) ON CONFLICT(scope) DO UPDATE SET version=excluded.version,hash=excluded.hash,content=excluded.content,item_ids=excluded.item_ids,stale=0,truncated=excluded.truncated,item_count=excluded.item_count,built_at=excluded.built_at'
      ).run(scope, version, hash, content, encode(itemIds), truncated ? 1 : 0, entries.length, now);
      return { scope, version, hash, content, itemIds, stale: false, truncated, builtAt: now };
    });
  }
}
