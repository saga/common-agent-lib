import type { DatabaseSync } from 'node:sqlite';

export interface EmbeddingProvider {
  readonly id: string;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface MemorySearchResult {
  scope: string;
  memoryId: string;
  score: number;
}

export interface MemoryRetriever {
  index(input: { scope: string; memoryId: string; content: string }): Promise<void>;
  search(input: { scope: string; query: string; limit?: number; minScore?: number }): Promise<MemorySearchResult[]>;
  remove(input: { scope: string; memoryId: string }): Promise<void>;
}

function validateVector(vector: readonly number[]): number[] {
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
    throw new TypeError('Embedding must be a non-empty finite numeric vector.');
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) throw new TypeError('Embedding vector must not be zero.');
  return vector.map((value) => value / magnitude);
}

/** SQLite-backed vector index. Cosine similarity is computed in-process; no native extension is required. */
export class SqliteVectorIndex implements MemoryRetriever {
  constructor(
    private readonly db: DatabaseSync,
    private readonly embeddings: EmbeddingProvider,
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS memory_embeddings (' +
      'scope TEXT NOT NULL, memory_id TEXT NOT NULL, provider TEXT NOT NULL, dimensions INTEGER NOT NULL, vector TEXT NOT NULL, ' +
      'updated_at TEXT NOT NULL, PRIMARY KEY(scope,memory_id,provider));' +
      'CREATE INDEX IF NOT EXISTS memory_embeddings_scope_provider ON memory_embeddings(scope,provider);',
    );
  }

  async index(input: { scope: string; memoryId: string; content: string }): Promise<void> {
    if (!input.scope.trim() || !input.memoryId.trim() || !input.content.trim()) {
      throw new TypeError('scope, memoryId and content are required for embedding.');
    }
    const [raw] = await this.embeddings.embed([input.content]);
    if (!raw) throw new Error('Embedding provider returned no vector.');
    const vector = validateVector(raw);
    this.db.prepare(
      'INSERT INTO memory_embeddings(scope,memory_id,provider,dimensions,vector,updated_at) VALUES(?,?,?,?,?,?) ' +
      'ON CONFLICT(scope,memory_id,provider) DO UPDATE SET dimensions=excluded.dimensions,vector=excluded.vector,updated_at=excluded.updated_at',
    ).run(input.scope, input.memoryId, this.embeddings.id, vector.length, JSON.stringify(vector), new Date().toISOString());
  }

  async search(input: { scope: string; query: string; limit?: number; minScore?: number }): Promise<MemorySearchResult[]> {
    const limit = input.limit ?? 20;
    const minScore = input.minScore ?? 0.15;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError('limit must be between 1 and 1000.');
    if (!Number.isFinite(minScore) || minScore < -1 || minScore > 1) throw new TypeError('minScore must be between -1 and 1.');
    const [raw] = await this.embeddings.embed([input.query]);
    if (!raw) return [];
    const query = validateVector(raw);
    const rows = this.db.prepare(
      'SELECT memory_id,dimensions,vector FROM memory_embeddings WHERE scope=? AND provider=?',
    ).all(input.scope, this.embeddings.id) as Array<{ memory_id: string; dimensions: number; vector: string }>;
    const matches: MemorySearchResult[] = [];
    for (const row of rows) {
      if (row.dimensions !== query.length) continue;
      const vector = JSON.parse(row.vector) as number[];
      if (vector.length !== query.length) continue;
      let score = 0;
      for (let index = 0; index < query.length; index += 1) score += query[index]! * vector[index]!;
      if (score >= minScore) matches.push({ scope: input.scope, memoryId: row.memory_id, score });
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async remove(input: { scope: string; memoryId: string }): Promise<void> {
    this.db.prepare('DELETE FROM memory_embeddings WHERE scope=? AND memory_id=?')
      .run(input.scope, input.memoryId);
  }
}
