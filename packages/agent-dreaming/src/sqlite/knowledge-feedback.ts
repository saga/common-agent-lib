import type { DreamingKnowledgeFeedbackEvent } from '../types.js';
import type { SqliteDatabase, SqliteRow } from './database.js';
import { decode, encode } from './database.js';

const FEEDBACK_KINDS = ['retrieval', 'evidence', 'user-correction', 'human-review'] as const;
const FEEDBACK_OUTCOMES = [
  'useful', 'not-useful', 'neutral', 'supports', 'contradicts',
  'incorrect', 'outdated', 'not-applicable', 'confirmed', 'rejected', 'edited',
] as const;

export class SqliteKnowledgeFeedbackStore {
  constructor(private readonly context: SqliteDatabase) {}

  async record(event: DreamingKnowledgeFeedbackEvent): Promise<void> {
    this.context.ensureOpen();
    if (!event.id.trim() || !event.scope.trim() || !event.pageId.trim()) {
      throw new TypeError('Knowledge feedback id, scope and pageId are required.');
    }
    if (!Number.isSafeInteger(event.pageVersion) || event.pageVersion < 1) {
      throw new TypeError('Knowledge feedback pageVersion must be a positive integer.');
    }
    if (!FEEDBACK_KINDS.includes(event.kind) || !FEEDBACK_OUTCOMES.includes(event.outcome)) {
      throw new TypeError('Unsupported Knowledge feedback kind or outcome.');
    }
    if (!Number.isFinite(Date.parse(event.occurredAt))) {
      throw new TypeError('Knowledge feedback occurredAt must be a valid timestamp.');
    }
    this.context.transaction(() => {
      const page = this.context.db.prepare(
        'SELECT version FROM knowledge_pages WHERE id=? AND scope=?'
      ).get(event.pageId, event.scope) as SqliteRow | undefined;
      if (!page || Number(page.version) < event.pageVersion) {
        throw new Error('Knowledge feedback page/version does not exist in the supplied scope.');
      }
      if (Number(page.version) !== event.pageVersion) {
        const snapshot = this.context.db.prepare(
          'SELECT 1 AS found FROM knowledge_page_versions WHERE scope=? AND page_id=? AND version=?'
        ).get(event.scope, event.pageId, event.pageVersion) as SqliteRow | undefined;
        if (!snapshot) throw new Error('Knowledge feedback references an unknown page version.');
      }
      const payload = encode(event);
      const old = this.context.db.prepare(
        'SELECT scope,page_id,page_version,payload FROM knowledge_feedback WHERE id=?'
      ).get(event.id) as SqliteRow | undefined;
      if (old) {
        // occurredAt defaults to "now" at the API boundary. A replay of the same
        // idempotency key can therefore carry a slightly different timestamp;
        // preserve the first stored timestamp while comparing every semantic field.
        const previous = decode<DreamingKnowledgeFeedbackEvent>(old.payload);
        const comparable = { ...previous, occurredAt: event.occurredAt };
        if (old.scope !== event.scope || old.page_id !== event.pageId
          || Number(old.page_version) !== event.pageVersion || encode(comparable) !== payload) {
          throw new Error('Conflicting Knowledge feedback ID: ' + event.id);
        }
        return;
      }
      this.context.db.prepare(
        'INSERT INTO knowledge_feedback(id,scope,page_id,page_version,occurred_at,outcome,payload) VALUES(?,?,?,?,?,?,?)'
      ).run(event.id, event.scope, event.pageId, event.pageVersion, event.occurredAt, event.outcome, payload);
    });
  }

  async load(input: {
    scope: string;
    pageIds: readonly string[];
    since: string;
    limit: number;
  }): Promise<readonly DreamingKnowledgeFeedbackEvent[]> {
    this.context.ensureOpen();
    if (!input.scope.trim() || !Number.isFinite(Date.parse(input.since))) {
      throw new TypeError('Knowledge feedback query requires scope and valid since timestamp.');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 2_000) {
      throw new TypeError('Knowledge feedback limit must be between 1 and 2000.');
    }
    const pageIds = [...new Set(input.pageIds)];
    if (pageIds.length > 100) throw new TypeError('At most 100 Knowledge pages may be queried for feedback.');
    if (!pageIds.length) return [];
    const rows = this.context.db.prepare(
      `SELECT payload FROM knowledge_feedback WHERE scope=? AND occurred_at>=?
       AND page_id IN (${pageIds.map(() => '?').join(',')})
       ORDER BY occurred_at DESC,id LIMIT ?`
    ).all(input.scope, input.since, ...pageIds, input.limit) as SqliteRow[];
    return rows.map((row) => decode<DreamingKnowledgeFeedbackEvent>(row.payload));
  }
}
