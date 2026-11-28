import type { DreamingFeedbackEvent } from '../types.js';
import { validateFeedbackEvent } from '../quality.js';
import type { SqliteDatabase } from './database.js';
import type { SqliteRow } from './database.js';

export class SqliteFeedbackStore {
  constructor(private readonly context: SqliteDatabase) {}

  async recordFeedback(event: DreamingFeedbackEvent): Promise<void> {
    this.context.ensureOpen();
    validateFeedbackEvent(event);
    this.context.transaction(() => {
      const memory = this.context.db.prepare(
        'SELECT 1 FROM memories WHERE id=? AND scope=?'
      ).get(event.memoryId, event.scope);
      if (!memory) throw new Error('Feedback memory not found in scope: ' + event.memoryId);

      const old = this.context.db.prepare('SELECT payload FROM feedback WHERE id=?')
        .get(event.id) as SqliteRow | undefined;
      if (old) {
        if (String(old.payload) !== JSON.stringify(event)) {
          throw new Error('Conflicting feedback event ID: ' + event.id);
        }
        return;
      }
      this.context.db.prepare(
        'INSERT INTO feedback(id,scope,memory_id,occurred_at,payload) VALUES(?,?,?,?,?)'
      ).run(event.id, event.scope, event.memoryId, event.occurredAt, JSON.stringify(event));
    });
  }

  async loadFeedback(input: {
    scope: string; memoryIds: readonly string[]; since: string; limit: number;
  }): Promise<readonly DreamingFeedbackEvent[]> {
    this.context.ensureOpen();
    if (!input.memoryIds.length) return [];
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
      throw new TypeError('Feedback limit must be an integer between 1 and 10000');
    }
    const ids = [...new Set(input.memoryIds)].slice(0, 900);
    const rows = this.context.db.prepare(
      `SELECT payload FROM feedback WHERE scope=? AND occurred_at>=? AND memory_id IN (${ids.map(() => '?').join(',')}) ORDER BY occurred_at LIMIT ?`
    ).all(input.scope, input.since, ...ids, input.limit) as SqliteRow[];
    return rows.map((row) => JSON.parse(String(row.payload)) as DreamingFeedbackEvent);
  }
}
