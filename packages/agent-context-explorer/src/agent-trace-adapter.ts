import type { ContextEvent, ContextEventType, ContextRun, ContextSession, ContextSnapshot, ModelCallUsage, ContextUsage } from './model.js';
import { normalizeContext } from './normalize.js';

/** Structural subset of @saga/agent-contracts AgentEvent; no runtime dependency is required. */
export interface AgentTraceEventLike {
  id: string; timestamp: string; type: string; sessionId?: string; agentId?: string;
  correlationId?: string; traceId?: string; turnId?: string; parentEventId?: string;
  sequence?: number; category?: string; status?: string; durationMs?: number;
  provider?: string; model?: string; payloadComplete?: boolean;
  data?: unknown; metadata?: Record<string, unknown>;
  usage?: Record<string, unknown>; contextUsage?: Record<string, unknown>;
}
export interface AgentTraceAdapterOptions {
  sessionId?: string; provider?: string; includeRaw?: boolean; redactSecrets?: boolean;
}
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function usageOf(value: unknown): ModelCallUsage | undefined {
  const usage = object(value);
  const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'premiumRequestCost', 'totalNanoAiu', 'providerCost', 'durationMs', 'timeToFirstTokenMs', 'interTokenLatencyMs'] as const;
  const result: Record<string, unknown> = {};
  for (const field of fields) { const n = number(usage[field]); if (n !== undefined) result[field] = n; }
  for (const field of ['providerCostUnit', 'finishReason', 'reasoningEffort'] as const) { const s = string(usage[field]); if (s) result[field] = s; }
  if (usage.source === 'provider-event' || usage.source === 'session-metrics' || usage.source === 'unknown') result.source = usage.source;
  if (Object.keys(result).length) return result as ModelCallUsage;
  return undefined;
}
function contextUsageOf(value: unknown): ContextUsage | undefined {
  const usage = object(value); const result: ContextUsage = {};
  for (const field of ['currentTokens', 'tokenLimit', 'messagesLength', 'percent'] as const) {
    const n = number(usage[field]); if (n !== undefined) result[field] = n;
  }
  return Object.keys(result).length ? result : undefined;
}
function eventType(type: string): ContextEventType {
  const normalized = type.toLowerCase().replace(/[._]/g, '-');
  const known: ContextEventType[] = [
    'user-input', 'turn-start', 'turn-end', 'assistant-turn-start', 'assistant-turn-end',
    'llm-request', 'llm-response', 'tool-call', 'tool-progress', 'tool-result',
    'permission', 'permission-completed', 'user-input-requested', 'user-input-completed',
    'compaction', 'context-changed', 'retry', 'checkpoint', 'session-idle',
    'session-error', 'stage-gate', 'error', 'custom',
  ];
  if (known.includes(normalized as ContextEventType)) return normalized as ContextEventType;
  if (normalized === 'model-call' || normalized === 'model-request') return 'llm-request';
  if (normalized === 'model-response') return 'llm-response';
  if (normalized === 'status' || normalized === 'intent') return 'custom';
  return 'custom';
}
function runFromEvent(event: AgentTraceEventLike, options: AgentTraceAdapterOptions): ContextRun | undefined {
  const data = object(event.data);
  const embedded = object(data.snapshot);
  const request = data.request ?? data.requestPayload ?? data.rawRequest;
  const response = data.response ?? data.responsePayload ?? data.rawResponse;
  if (!Object.keys(embedded).length && request === undefined) return undefined;
  const snapshot = Object.keys(embedded).length
    ? embedded as unknown as ContextSnapshot
    : normalizeContext(request, response, {
      provider: options.provider ?? event.provider,
      id: string(data.requestId) ?? event.id,
      includeRaw: options.includeRaw,
      redactSecrets: options.redactSecrets,
    });
  const usage = usageOf(event.usage) ?? usageOf(snapshot.usage);
  const contextUsage = contextUsageOf(event.contextUsage);
  const completed = response !== undefined || /completed|success|finished/i.test(event.status ?? '');
  return {
    id: string(data.runId) ?? event.id, sequence: event.sequence ?? 1,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(string(data.requestId) ? { requestId: string(data.requestId) } : {}),
    ...(string(data.parentRunId) ? { parentRunId: string(data.parentRunId) } : {}),
    ...(string(data.stage) ? { stage: string(data.stage) } : {}),
    ...(number(data.attempt) !== undefined ? { attempt: number(data.attempt) } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(snapshot.model ? { actualModel: snapshot.model } : {}),
    startedAt: event.timestamp,
    ...(completed ? { completedAt: string(data.completedAt) ?? event.timestamp } : {}),
    status: /fail|error/i.test(event.status ?? '') ? 'failed' : completed ? 'completed' : 'running',
    snapshot, ...(usage ? { usage } : {}), ...(contextUsage ? { contextUsage } : {}),
    ...(data.provenance && typeof data.provenance === 'object' ? { provenance: data.provenance } : {}),
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    metadata: { ...(event.metadata ?? {}), sourceEventType: event.type, ...(event.payloadComplete === false ? { payloadComplete: false } : {}) },
  };
}
function toContextEvent(event: AgentTraceEventLike): ContextEvent {
  const data = object(event.data);
  const mappedType = eventType(event.type);
  const status = ['started', 'completed', 'failed', 'cancelled', 'waiting', 'info'].includes(event.status ?? '')
    ? event.status as ContextEvent['status'] : undefined;
  return {
    id: event.id, type: mappedType, timestamp: event.timestamp,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.traceId ? { traceId: event.traceId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(string(data.runId) ? { runId: string(data.runId) } : {}),
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    ...(event.parentEventId ? { parentEventId: event.parentEventId } : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.category ? { category: event.category } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(string(data.toolCallId) ? { toolCallId: string(data.toolCallId) } : {}),
    ...(string(data.parentToolCallId) ? { parentToolCallId: string(data.parentToolCallId) } : {}),
    ...(string(data.tool ?? data.toolName) ? { toolName: string(data.tool ?? data.toolName) } : {}),
    ...(string(data.mcpServerName) ? { mcpServerName: string(data.mcpServerName) } : {}),
    ...(string(data.mcpToolName) ? { mcpToolName: string(data.mcpToolName) } : {}),
    ...(status ? { status } : {}), ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(string(data.summary ?? data.progressMessage ?? data.message ?? data.error) ? { summary: string(data.summary ?? data.progressMessage ?? data.message ?? data.error) } : {}),
    ...(data.arguments !== undefined ? { input: data.arguments } : data.input !== undefined ? { input: data.input } : {}),
    ...(data.result !== undefined ? { output: data.result } : data.output !== undefined ? { output: data.output } : {}),
    data: event.data, ...(event.metadata ? { metadata: event.metadata } : {}),
    ...(usageOf(event.usage) ? { usage: usageOf(event.usage) } : {}),
    ...(contextUsageOf(event.contextUsage) ? { contextUsage: contextUsageOf(event.contextUsage) } : {}),
    ...(event.payloadComplete !== undefined ? { payloadComplete: event.payloadComplete } : {}),
  };
}

/** Convert the existing @saga/agent-tracing / @saga/agent-contracts event envelope into debugger sessions. */
export function contextSessionsFromAgentEvents(
  events: readonly AgentTraceEventLike[],
  options: AgentTraceAdapterOptions = {},
): ContextSession[] {
  const selected = options.sessionId ? events.filter((event) => event.sessionId === options.sessionId) : [...events];
  const groups = new Map<string, AgentTraceEventLike[]>();
  for (const event of selected) {
    const id = event.sessionId ?? event.traceId ?? event.correlationId ?? 'unscoped';
    groups.set(id, [...(groups.get(id) ?? []), event]);
  }
  return [...groups.entries()].map(([id, group]) => {
    const ordered = [...group].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || (a.sequence ?? 0) - (b.sequence ?? 0));
    const runs = ordered.map((event) => runFromEvent(event, options)).filter((run): run is ContextRun => Boolean(run));
    return {
      id, ...(ordered[0]?.traceId ? { traceId: ordered[0].traceId } : {}),
      ...(ordered[0]?.correlationId ? { correlationId: ordered[0].correlationId } : {}),
      ...(ordered[0]?.agentId ? { agentId: ordered[0].agentId } : {}),
      ...(ordered[0]?.timestamp ? { startedAt: ordered[0].timestamp } : {}),
      ...(ordered.at(-1)?.timestamp ? { updatedAt: ordered.at(-1)!.timestamp } : {}),
      runs, events: ordered.map(toContextEvent),
      compactions: [],
      metadata: { source: '@saga/agent-tracing', eventCount: ordered.length },
    };
  });
}
