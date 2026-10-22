import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AgentEventSchema,
  AgentTokenUsageSchema,
  type AgentEvent,
  type AgentModelTokenUsage,
  type AgentTokenUsage,
} from '@saga/agent-contracts';

export type TraceEventInput = Omit<AgentEvent, 'id' | 'timestamp' | 'sequence' | 'payloadComplete'> & {
  id?: string;
  timestamp?: string;
};

export interface TraceQuery {
  sessionIds?: string[];
  traceId?: string;
  turnId?: string;
  types?: string[];
  category?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface AgentTraceStore {
  append(event: AgentEvent): Promise<AgentEvent>;
  query(query?: TraceQuery): Promise<AgentEvent[]>;
  close?(): Promise<void> | void;
}

export interface TraceRecorderOptions {
  /** Maximum UTF-8 byte length for event.data. Oversized data is replaced with a marked preview. */
  maxPayloadBytes?: number;
  /** Character limit for the preview recorded when a payload is too large. */
  previewChars?: number;
  /** Disable only for already-sanitized, trusted payloads. Defaults to true. */
  redactSecrets?: boolean;
}

export interface TraceSpanOptions extends Omit<TraceEventInput, 'type' | 'status' | 'durationMs'> {
  name: string;
  category?: string;
}

export interface TraceContext {
  sessionId?: string;
  agentId?: string;
  correlationId?: string;
  traceId: string;
  turnId?: string;
  parentEventId?: string;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_PREVIEW_CHARS = 4000;
const SECRET_KEY = /authorization|(^|[_-])token($|[_-])|api[_-]?key|password|secret|cookie|credential|private[_-]?key/i;
const SECRET_VALUE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

function redactValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, redactValue(child, childKey)]));
  }
  return value;
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return JSON.stringify({ payloadOmitted: true, reason: 'payload was not serializable' });
  }
}

function boundedPayload(
  input: unknown,
  maxBytes: number,
  previewChars: number,
  redactSecrets: boolean,
): { data: unknown; payloadComplete: boolean } {
  const safe = redactSecrets ? redactValue(input ?? null) : input ?? null;
  const json = serialize(safe);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= maxBytes) return { data: safe, payloadComplete: true };
  return {
    data: {
      payloadOmitted: true,
      reason: 'event payload exceeded the configured byte limit',
      originalBytes: bytes,
      preview: json.slice(0, previewChars),
    },
    payloadComplete: false,
  };
}

function safeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 200;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

/**
 * Sums token counts without treating missing measurements as zero.
 * Provider cost is only summed when every sample uses the same declared unit.
 * Context occupancy is intentionally not aggregated because it is a snapshot, not consumption.
 */
export function aggregateAgentTokenUsage(usages: readonly AgentTokenUsage[]): AgentTokenUsage | undefined {
  if (!usages.length) return undefined;
  const parsed = usages.map((usage) => AgentTokenUsageSchema.parse(usage));
  const result: AgentTokenUsage = {};
  const numericFields = [
    'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteTokens',
    'reasoningTokens', 'modelCalls', 'premiumRequestCost', 'totalNanoAiu',
  ] as const;
  for (const field of numericFields) {
    let total = 0;
    let found = false;
    for (const usage of parsed) {
      const value = usage[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        total += value;
        found = true;
      }
    }
    if (found) (result as Record<string, unknown>)[field] = total;
  }

  const costSamples = parsed.filter((usage) => typeof usage.providerCost === 'number');
  const costUnits = new Set(costSamples.map((usage) => usage.providerCostUnit ?? 'unspecified'));
  if (costSamples.length === parsed.length && costSamples.every((usage) => Boolean(usage.providerCostUnit)) && costUnits.size === 1) {
    result.providerCost = costSamples.reduce((total, usage) => total + (usage.providerCost ?? 0), 0);
    const unit = costSamples[0]?.providerCostUnit;
    if (unit) result.providerCostUnit = unit;
  }

  const sources = new Set(parsed.map((usage) => usage.source).filter((source): source is NonNullable<AgentTokenUsage['source']> => Boolean(source)));
  if (sources.size === 1 && parsed.every((usage) => usage.source)) result.source = parsed[0]?.source;

  const byModel: Record<string, AgentModelTokenUsage> = {};
  for (const usage of parsed) {
    for (const [model, counts] of Object.entries(usage.byModel ?? {})) {
      const current = { ...(byModel[model] ?? {}) } as Record<string, unknown>;
      for (const field of [
        'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteTokens',
        'reasoningTokens', 'premiumRequestCost', 'totalNanoAiu',
      ] as const) {
        const amount = counts[field];
        if (typeof amount === 'number' && Number.isFinite(amount)) {
          current[field] = ((typeof current[field] === 'number' ? current[field] : 0) as number) + amount;
        }
      }
      byModel[model] = current as AgentModelTokenUsage;
    }
  }
  if (Object.keys(byModel).length) result.byModel = byModel;
  return Object.keys(result).length ? AgentTokenUsageSchema.parse(result) : undefined;
}

/**
 * In-memory store for tests, demos and short-lived processes.
 * For persistence across restarts, use SqliteTraceStore or provide another AgentTraceStore.
 */
export class InMemoryTraceStore implements AgentTraceStore {
  private readonly events: AgentEvent[] = [];
  private readonly ids = new Set<string>();
  private readonly sequenceByTrace = new Map<string, number>();

  async append(event: AgentEvent): Promise<AgentEvent> {
    if (this.ids.has(event.id)) throw new Error('Duplicate agent trace event id: ' + event.id);
    const traceId = event.traceId ?? event.sessionId ?? event.correlationId ?? event.id;
    const sequence = (this.sequenceByTrace.get(traceId) ?? 0) + 1;
    const persisted = AgentEventSchema.parse({ ...event, traceId, sequence, payloadComplete: event.payloadComplete ?? true });
    this.events.push(persisted);
    this.ids.add(persisted.id);
    this.sequenceByTrace.set(traceId, sequence);
    return persisted;
  }

  async query(query: TraceQuery = {}): Promise<AgentEvent[]> {
    return filterEvents(this.events, query);
  }

  async close(): Promise<void> {}
}

function filterEvents(events: AgentEvent[], query: TraceQuery): AgentEvent[] {
  const limit = safeLimit(query.limit);
  const sessionIds = query.sessionIds?.length ? new Set(query.sessionIds) : undefined;
  const types = query.types?.length ? new Set(query.types) : undefined;
  return events
    .filter((event) => !sessionIds || (event.sessionId !== undefined && sessionIds.has(event.sessionId)))
    .filter((event) => !query.traceId || event.traceId === query.traceId)
    .filter((event) => !query.turnId || event.turnId === query.turnId)
    .filter((event) => !query.category || event.category === query.category)
    .filter((event) => !types || types.has(event.type))
    .filter((event) => !query.since || event.timestamp >= query.since)
    .filter((event) => !query.until || event.timestamp <= query.until)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || (left.sequence ?? 0) - (right.sequence ?? 0))
    .slice(-limit)
    .map((event) => ({ ...event }));
}

/** Durable local SQLite store. Node.js 22.13+ is required for node:sqlite. */
export class SqliteTraceStore implements AgentTraceStore {
  private readonly database: DatabaseSync;

  constructor(options: { filename: string; busyTimeoutMs?: number }) {
    if (!options.filename.trim()) throw new TypeError('SqliteTraceStore filename must not be empty');
    if (options.filename !== ':memory:') {
      const directory = path.dirname(path.resolve(options.filename));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(options.filename);
    this.database.exec('PRAGMA journal_mode=WAL;');
    this.database.exec('PRAGMA busy_timeout=' + Math.max(0, Math.min(30_000, Math.floor(options.busyTimeoutMs ?? 5000))) + ';');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS trace_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        session_id TEXT,
        agent_id TEXT,
        correlation_id TEXT,
        trace_id TEXT NOT NULL,
        turn_id TEXT,
        parent_event_id TEXT,
        sequence INTEGER NOT NULL,
        category TEXT,
        type TEXT NOT NULL,
        status TEXT,
        duration_ms REAL,
        provider TEXT,
        model TEXT,
        payload_complete INTEGER NOT NULL DEFAULT 1,
        actor_json TEXT,
        data_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        usage_json TEXT,
        context_usage_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trace_session_time ON trace_events(session_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_trace_id_sequence ON trace_events(trace_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_trace_turn ON trace_events(turn_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_trace_type_time ON trace_events(type, timestamp DESC);
    `);
    // Upgrade databases created by earlier package versions without rebuilding the event ledger.
    const existingColumns = new Set(
      (this.database.prepare('PRAGMA table_info(trace_events)').all() as Array<{ name?: unknown }>)
        .map((column) => String(column.name ?? '')),
    );
    if (!existingColumns.has('usage_json')) this.database.exec('ALTER TABLE trace_events ADD COLUMN usage_json TEXT');
    if (!existingColumns.has('context_usage_json')) this.database.exec('ALTER TABLE trace_events ADD COLUMN context_usage_json TEXT');
    if (options.filename !== ':memory:') {
      try { chmodSync(options.filename, 0o600); } catch { /* File permissions vary by platform. */ }
    }
  }

  async append(event: AgentEvent): Promise<AgentEvent> {
    const traceId = event.traceId ?? event.sessionId ?? event.correlationId ?? event.id;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM trace_events WHERE trace_id = ?',
      ).get(traceId) as { next_sequence: number };
      const persisted = AgentEventSchema.parse({
        ...event,
        traceId,
        sequence: Number(row.next_sequence),
        payloadComplete: event.payloadComplete ?? true,
      });
      this.database.prepare(`
        INSERT INTO trace_events
          (id, timestamp, session_id, agent_id, correlation_id, trace_id, turn_id, parent_event_id,
           sequence, category, type, status, duration_ms, provider, model, payload_complete,
           actor_json, data_json, metadata_json, usage_json, context_usage_json)
        VALUES ($id, $timestamp, $session_id, $agent_id, $correlation_id, $trace_id, $turn_id, $parent_event_id,
           $sequence, $category, $type, $status, $duration_ms, $provider, $model, $payload_complete,
           $actor_json, $data_json, $metadata_json, $usage_json, $context_usage_json)
      `).run({
        $id: persisted.id,
        $timestamp: persisted.timestamp,
        $session_id: persisted.sessionId ?? null,
        $agent_id: persisted.agentId ?? null,
        $correlation_id: persisted.correlationId ?? null,
        $trace_id: persisted.traceId ?? '',
        $turn_id: persisted.turnId ?? null,
        $parent_event_id: persisted.parentEventId ?? null,
        $sequence: persisted.sequence ?? 0,
        $category: persisted.category ?? null,
        $type: persisted.type,
        $status: persisted.status ?? null,
        $duration_ms: persisted.durationMs ?? null,
        $provider: persisted.provider ?? null,
        $model: persisted.model ?? null,
        $payload_complete: persisted.payloadComplete === false ? 0 : 1,
        $actor_json: persisted.actor === undefined ? null : JSON.stringify(persisted.actor),
        $data_json: serialize(persisted.data),
        $metadata_json: serialize(persisted.metadata),
        $usage_json: persisted.usage === undefined ? null : JSON.stringify(persisted.usage),
        $context_usage_json: persisted.contextUsage === undefined ? null : JSON.stringify(persisted.contextUsage),
      });
      this.database.exec('COMMIT');
      return persisted;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async query(query: TraceQuery = {}): Promise<AgentEvent[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.sessionIds?.length) {
      clauses.push('session_id IN (' + query.sessionIds.map(() => '?').join(',') + ')');
      params.push(...query.sessionIds);
    }
    if (query.traceId) { clauses.push('trace_id = ?'); params.push(query.traceId); }
    if (query.turnId) { clauses.push('turn_id = ?'); params.push(query.turnId); }
    if (query.category) { clauses.push('category = ?'); params.push(query.category); }
    if (query.types?.length) {
      clauses.push('type IN (' + query.types.map(() => '?').join(',') + ')');
      params.push(...query.types);
    }
    if (query.since) { clauses.push('timestamp >= ?'); params.push(query.since); }
    if (query.until) { clauses.push('timestamp <= ?'); params.push(query.until); }
    params.push(safeLimit(query.limit));

    const rows = this.database.prepare(`
      SELECT * FROM trace_events ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
      ORDER BY timestamp DESC, rowid DESC LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>;

    return rows.reverse().map((row) => AgentEventSchema.parse({
      id: String(row.id),
      timestamp: String(row.timestamp),
      ...(row.session_id !== null ? { sessionId: String(row.session_id) } : {}),
      ...(row.agent_id !== null ? { agentId: String(row.agent_id) } : {}),
      ...(row.correlation_id !== null ? { correlationId: String(row.correlation_id) } : {}),
      traceId: String(row.trace_id),
      ...(row.turn_id !== null ? { turnId: String(row.turn_id) } : {}),
      ...(row.parent_event_id !== null ? { parentEventId: String(row.parent_event_id) } : {}),
      sequence: Number(row.sequence),
      ...(row.category !== null ? { category: String(row.category) } : {}),
      type: String(row.type),
      ...(row.status !== null ? { status: String(row.status) } : {}),
      ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}),
      ...(row.provider !== null ? { provider: String(row.provider) } : {}),
      ...(row.model !== null ? { model: String(row.model) } : {}),
      payloadComplete: Number(row.payload_complete) === 1,
      ...(row.actor_json !== null ? { actor: JSON.parse(String(row.actor_json)) } : {}),
      ...(row.usage_json !== null ? { usage: JSON.parse(String(row.usage_json)) } : {}),
      ...(row.context_usage_json !== null ? { contextUsage: JSON.parse(String(row.context_usage_json)) } : {}),
      data: JSON.parse(String(row.data_json)),
      metadata: JSON.parse(String(row.metadata_json)),
    }));
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

/**
 * Records normalized events and spans. Storage errors are propagated by default;
 * callers that prefer best-effort telemetry can catch them at their application boundary.
 */
export class AgentTraceRecorder {
  private readonly maxPayloadBytes: number;
  private readonly previewChars: number;
  private readonly redactSecrets: boolean;

  constructor(private readonly store: AgentTraceStore, options: TraceRecorderOptions = {}) {
    this.maxPayloadBytes = Math.max(1, Math.floor(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES));
    this.previewChars = Math.max(0, Math.floor(options.previewChars ?? DEFAULT_PREVIEW_CHARS));
    this.redactSecrets = options.redactSecrets ?? true;
  }

  createContext(input: Omit<TraceContext, 'traceId'> & { traceId?: string } = {}): TraceContext {
    return { ...input, traceId: input.traceId ?? randomUUID() };
  }

  async record(input: TraceEventInput): Promise<AgentEvent> {
    const payload = boundedPayload(input.data, this.maxPayloadBytes, this.previewChars, this.redactSecrets);
    const metadata = this.redactSecrets ? redactValue(input.metadata ?? {}) : input.metadata ?? {};
    const event = AgentEventSchema.parse({
      ...input,
      id: input.id ?? randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      traceId: input.traceId ?? input.sessionId ?? input.correlationId ?? randomUUID(),
      data: payload.data,
      payloadComplete: payload.payloadComplete,
      metadata,
    });
    return this.store.append(event);
  }

  async runSpan<T>(options: TraceSpanOptions, task: () => Promise<T> | T): Promise<T> {
    const { name, category = 'operation', data, ...context } = options;
    const spanContext = {
      ...context,
      traceId: context.traceId ?? context.sessionId ?? context.correlationId ?? randomUUID(),
    };
    const startedAt = Date.now();
    const startedEvent = await this.record({
      ...spanContext,
      category,
      type: category + '.started',
      status: 'running',
      data: { name, ...(data === undefined ? {} : { details: data }) },
    });
    try {
      const result = await task();
      await this.record({
        ...spanContext,
        parentEventId: startedEvent.id,
        category,
        type: category + '.completed',
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        data: { name },
      });
      return result;
    } catch (error) {
      try {
        await this.record({
          ...spanContext,
          parentEventId: startedEvent.id,
          category,
          type: category + '.failed',
          status: 'failed',
          durationMs: Date.now() - startedAt,
          data: {
            name,
            error: {
              name: error instanceof Error ? error.name : 'Error',
              message: error instanceof Error ? error.message : String(error),
            },
          },
        });
      } catch (traceError) {
        throw new AggregateError([error, traceError], 'Operation failed and its failure trace could not be persisted');
      }
      throw error;
    }
  }

  query(query?: TraceQuery): Promise<AgentEvent[]> {
    return this.store.query(query);
  }

  close(): Promise<void> {
    return Promise.resolve(this.store.close?.());
  }
}
