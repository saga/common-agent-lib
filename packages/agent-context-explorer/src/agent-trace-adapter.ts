import type { ContextCompaction, ContextEvent, ContextEventType, ContextRun, ContextSession, ContextSnapshot, ModelCallUsage, ContextUsage } from './model.js';
import { normalizeContext, redactContextPayload } from './normalize.js';

/** Structural subset of @saga/agent-contracts AgentEvent; no runtime dependency is required. */
export interface AgentTraceEventLike {
  id: string; timestamp: string; type: string; sessionId?: string; agentId?: string;
  correlationId?: string; traceId?: string; turnId?: string; parentEventId?: string;
  sequence?: number; category?: string; status?: string; durationMs?: number;
  provider?: string; model?: string; payloadComplete?: boolean;
  data?: unknown; metadata?: Record<string, unknown>; actor?: { id: string; type?: string; displayName?: string };
  usage?: unknown; contextUsage?: unknown;
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
  const fields = ['inputTokens', 'newInputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'premiumRequestCost', 'totalNanoAiu', 'providerCost', 'durationMs', 'timeToFirstTokenMs', 'interTokenLatencyMs'] as const;
  const result: Record<string, unknown> = {};
  for (const field of fields) { const n = number(usage[field]); if (n !== undefined) result[field] = n; }
  for (const field of ['providerCostUnit', 'finishReason', 'reasoningEffort'] as const) { const s = string(usage[field]); if (s) result[field] = s; }
  if (usage.source === 'provider-event' || usage.source === 'session-metrics' || usage.source === 'unknown') result.source = usage.source;
  if (usage.byModel && typeof usage.byModel === 'object' && !Array.isArray(usage.byModel)) {
    const byModel: Record<string, Omit<ModelCallUsage, 'model' | 'byModel'>> = {};
    for (const [model, counts] of Object.entries(usage.byModel as Record<string, unknown>)) {
      const normalized = usageOf(counts);
      if (!normalized) continue;
      const { byModel: nested, model: ignoredModel, ...metrics } = normalized;
      void nested; void ignoredModel;
      byModel[model] = metrics;
    }
    if (Object.keys(byModel).length) result.byModel = byModel;
  }
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
  if (normalized === 'context-compaction') return 'compaction';
  if (normalized === 'model-call' || normalized === 'model-request') return 'llm-request';
  if (normalized === 'model-response') return 'llm-response';
  if (normalized === 'status' || normalized === 'intent') return 'custom';
  return 'custom';
}
function runFromEvent(event: AgentTraceEventLike, options: AgentTraceAdapterOptions): ContextRun | undefined {
  const data = object(redactContextPayload(event.data, options.redactSecrets ?? true));
  const embedded = object(data.snapshot);
  const request = data.request ?? data.requestPayload ?? data.rawRequest;
  const response = data.response ?? data.responsePayload ?? data.rawResponse;
  if (!Object.keys(embedded).length && request === undefined) return undefined;
  const snapshot = Object.keys(embedded).length
    ? snapshotOf(embedded, options)!
    : normalizeContext(request, response, {
      provider: options.provider ?? event.provider,
      id: string(data.requestId) ?? event.id,
      includeRaw: options.includeRaw,
      redactSecrets: options.redactSecrets,
    });
  const usage = usageOf(event.usage) ?? usageOf(snapshot.usage);
  const contextUsage = contextUsageOf(event.contextUsage);
  const completed = response !== undefined || /completed|success|finished/i.test(event.status ?? '');
  const runStatus: ContextRun['status'] = /fail|error/i.test(event.status ?? '') ? 'failed' : /cancel/i.test(event.status ?? '') ? 'cancelled' : /abort/i.test(event.status ?? '') ? 'aborted' : completed ? 'completed' : 'running';
  const attempt = number(data.attempt);
  const actualModel = snapshot.model ?? event.model;
  const requestId = string(data.requestId ?? data.serviceRequestId);
  return {
    id: string(data.runId ?? data.apiCallId ?? data.providerCallId) ?? event.id, sequence: event.sequence ?? 1,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(requestId ? { requestId, correlationId: requestId } : {}),
    ...(string(data.apiCallId) ? { apiCallId: string(data.apiCallId) } : {}),
    ...(string(data.providerCallId) ? { providerCallId: string(data.providerCallId) } : {}),
    ...(string(data.serviceRequestId) ? { serviceRequestId: string(data.serviceRequestId) } : {}),
    ...(string(data.parentRunId) ? { parentRunId: string(data.parentRunId) } : {}),
    ...(string(data.stage) ? { stage: string(data.stage) } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(actualModel ? { actualModel } : {}),
    ...(string(data.initiator) ? { initiator: string(data.initiator) } : {}),
    startedAt: event.timestamp,
    ...(completed ? { completedAt: string(data.completedAt) ?? event.timestamp } : {}),
    status: runStatus,
    snapshot, ...(usage ? { usage } : {}), ...(contextUsage ? { contextUsage } : {}),
    payloadComplete: event.payloadComplete ?? (request !== undefined && response !== undefined || embedded.rawRequest != null && embedded.rawResponse !== undefined || Array.isArray(embedded.messages) && Array.isArray(embedded.responseMessages) && embedded.responseMessages.length > 0),
    ...(data.provenance && typeof data.provenance === 'object' ? { provenance: data.provenance } : {}),
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    metadata: { ...(redactContextPayload(event.metadata ?? {}, options.redactSecrets ?? true)), sourceEventType: event.type, ...(event.payloadComplete === false ? { payloadComplete: false } : {}) },
  };
}
function snapshotOf(value: unknown, options: AgentTraceAdapterOptions): ContextSnapshot | undefined {
  const record = object(value);
  if (!Object.keys(record).length) return undefined;
  if (Array.isArray(record.messages) && Array.isArray(record.responseMessages) && typeof record.provider === 'string') {
    const safeRecord = redactContextPayload(record, options.redactSecrets ?? true) as unknown as ContextSnapshot;
    if (options.includeRaw !== false) return safeRecord;
    const { rawResponse: omittedResponse, ...withoutResponse } = safeRecord;
    void omittedResponse;
    return { ...withoutResponse, rawRequest: null, warnings: [...(safeRecord.warnings ?? []), 'Raw provider payloads were omitted by configuration.'] };
  }
  if (Array.isArray(record.messages) || Array.isArray(record.input) || Array.isArray(record.contents)) {
    return normalizeContext(record, undefined, { provider: options.provider, includeRaw: options.includeRaw, redactSecrets: options.redactSecrets });
  }
  return undefined;
}
function compactionsFromAgentEvents(events: readonly AgentTraceEventLike[], options: AgentTraceAdapterOptions): ContextCompaction[] {
  const result: ContextCompaction[] = [];
  for (const event of events) {
    if (!/compaction/i.test(event.type)) continue;
    const data = object(redactContextPayload(event.data, options.redactSecrets ?? true));
    const before = snapshotOf(data.before ?? data.beforeSnapshot, options);
    const after = snapshotOf(data.after ?? data.afterSnapshot, options);
    if (!before || !after) continue;
    result.push({
      id: string(data.compactionId) ?? event.id, timestamp: event.timestamp,
      ...(string(data.reason) ? { reason: string(data.reason) } : {}),
      ...(string(data.strategy) ? { strategy: string(data.strategy) } : {}),
      before, after,
      ...(string(data.summary) ? { summary: string(data.summary) } : {}),
      ...(Array.isArray(data.removedMessageIds) ? { removedMessageIds: data.removedMessageIds.filter((v: unknown): v is string => typeof v === 'string') } : {}),
      ...(Array.isArray(data.preservedMessageIds) ? { preservedMessageIds: data.preservedMessageIds.filter((v: unknown): v is string => typeof v === 'string') } : {}),
      ...(number(data.preCompactionTokens) !== undefined ? { preCompactionTokens: number(data.preCompactionTokens) } : {}),
      ...(number(data.postCompactionTokens) !== undefined ? { postCompactionTokens: number(data.postCompactionTokens) } : {}),
      ...(number(data.tokensRemoved) !== undefined ? { tokensRemoved: number(data.tokensRemoved) } : {}),
      ...(number(data.messagesRemoved) !== undefined ? { messagesRemoved: number(data.messagesRemoved) } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(string(data.requestId) ? { requestId: string(data.requestId) } : {}),
      ...(event.status === 'failed' ? { status: 'failed' as const, error: string(data.error) ?? 'Compaction failed' } : { status: 'completed' as const }),
      metadata: { sourceEventId: event.id },
    });
  }
  return result;
}
function toContextEvent(event: AgentTraceEventLike, options: AgentTraceAdapterOptions): ContextEvent {
  const data = object(event.data);
  const mappedType = eventType(event.type);
  const status = ['started', 'running', 'completed', 'failed', 'cancelled', 'aborted', 'waiting', 'info'].includes(event.status ?? '')
    ? event.status as ContextEvent['status'] : undefined;
  return {
    id: event.id, type: mappedType, timestamp: event.timestamp,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.traceId ? { traceId: event.traceId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(string(data.runId ?? data.apiCallId ?? data.providerCallId) ? { runId: string(data.runId ?? data.apiCallId ?? data.providerCallId) } : {}),
    ...(string(data.requestId ?? data.serviceRequestId) ? { requestId: string(data.requestId ?? data.serviceRequestId) } : {}),
    ...(string(data.providerCallId) ? { providerCallId: string(data.providerCallId) } : {}),
    ...(string(data.serviceRequestId) ? { serviceRequestId: string(data.serviceRequestId) } : {}),
    ...(event.correlationId ? { correlationId: event.correlationId } : string(data.requestId ?? data.serviceRequestId) ? { correlationId: string(data.requestId ?? data.serviceRequestId) } : {}),
    ...(event.parentEventId ? { parentEventId: event.parentEventId } : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.actor ? { actor: redactContextPayload(event.actor, options.redactSecrets ?? true) } : {}),
    ...(event.category ? { category: event.category } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(string(data.initiator) ? { initiator: string(data.initiator) } : {}),
    ...(string(data.toolCallId) ? { toolCallId: string(data.toolCallId) } : {}),
    ...(string(data.parentToolCallId) ? { parentToolCallId: string(data.parentToolCallId) } : {}),
    ...(string(data.tool ?? data.toolName) ? { toolName: string(data.tool ?? data.toolName) } : {}),
    ...(string(data.mcpServerName) ? { mcpServerName: string(data.mcpServerName) } : {}),
    ...(string(data.mcpToolName) ? { mcpToolName: string(data.mcpToolName) } : {}),
    ...(status ? { status } : {}), ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(string(data.summary ?? data.progressMessage ?? data.message ?? data.error) ? { summary: string(data.summary ?? data.progressMessage ?? data.message ?? data.error) } : {}),
    ...(data.arguments !== undefined ? { input: redactContextPayload(data.arguments, options.redactSecrets ?? true) } : data.input !== undefined ? { input: redactContextPayload(data.input, options.redactSecrets ?? true) } : {}),
    ...(data.result !== undefined ? { output: redactContextPayload(data.result, options.redactSecrets ?? true) } : data.output !== undefined ? { output: redactContextPayload(data.output, options.redactSecrets ?? true) } : {}),
    data: redactContextPayload(event.data, options.redactSecrets ?? true), ...(event.metadata ? { metadata: redactContextPayload(event.metadata, options.redactSecrets ?? true) } : {}),
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
      runs, events: ordered.map((event) => toContextEvent(event, options)),
      compactions: compactionsFromAgentEvents(ordered, options),
      metadata: { source: '@saga/agent-tracing', eventCount: ordered.length },
    };
  });
}


/** Structural form of agentic-data-architect TrajectoryEvent. */
export interface TrajectoryEventLike {
  id: string; turnId: string; timestamp: string; type: string; name: string;
  sessionId?: string; sequence?: number; provider?: string; payloadComplete?: boolean;
  status?: string; durationMs?: number; model?: string; inputTokens?: number; outputTokens?: number;
  premiumRequestCost?: number; details?: Record<string, unknown>;
}
function trajectoryType(type: string): ContextEventType {
  const map: Record<string, ContextEventType> = {
    user_input: 'user-input', turn_start: 'turn-start', assistant_turn_start: 'assistant-turn-start',
    assistant_turn_end: 'assistant-turn-end', model_call: 'llm-request', tool_call: 'tool-call',
    tool_progress: 'tool-progress', tool_result: 'tool-result', permission: 'permission',
    permission_completed: 'permission-completed', user_input_requested: 'user-input-requested',
    user_input_completed: 'user-input-completed', compaction: 'compaction',
    session_idle: 'session-idle', session_error: 'session-error', context_changed: 'context-changed',
    turn_end: 'turn-end', error: 'error', checkpoint: 'checkpoint', stage_gate: 'stage-gate',
  };
  return map[type] ?? 'custom';
}
/** Adapt agentic-data-architect trajectory records without pretending absent provider payloads are available. */
export function contextSessionFromTrajectoryEvents(
  events: readonly TrajectoryEventLike[],
  options: { sessionId?: string; provider?: string; includeRaw?: boolean; redactSecrets?: boolean } = {},
): ContextSession {
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const firstDetails = object(ordered[0]?.details);
  const sourceTurnIds = [...new Set(ordered.map((event) => event.turnId).filter(Boolean))];
  // TrajectoryEvent has turnId but no session identity. Do not silently relabel a turn as a session.
  const sessionId = options.sessionId ?? string(firstDetails.sessionId) ?? ordered[0]?.sessionId ??
    (sourceTurnIds[0] ? 'trajectory:' + sourceTurnIds[0] : 'trajectory:unscoped');
  const contextEvents: ContextEvent[] = ordered.map((event) => {
    const details = object(event.details);
    const status = ['started', 'running', 'completed', 'failed', 'waiting', 'info', 'cancelled', 'aborted'].includes(event.status ?? '')
      ? event.status as ContextEvent['status'] : undefined;
    const requestId = string(details.requestId);
    const toolCallId = string(details.toolCallId);
    const parentToolCallId = string(details.parentToolCallId);
    const agentId = string(details.agentId);
    const mcpServerName = string(details.mcpServerName ?? details.serverName);
    const mcpToolName = string(details.mcpToolName);
    const toolName = string(details.toolName ?? details.tool ?? details.mcpToolName);
    return {
      id: event.id, type: trajectoryType(event.type), timestamp: event.timestamp,
      sessionId, turnId: event.turnId,
      ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
      ...(event.provider ? { provider: event.provider } : {}),
      ...(requestId ? { requestId } : {}),
      ...(string(details.apiCallId) ? { apiCallId: string(details.apiCallId) } : {}),
      ...(string(details.providerCallId) ? { providerCallId: string(details.providerCallId) } : {}),
      ...(string(details.serviceRequestId) ? { serviceRequestId: string(details.serviceRequestId) } : {}),
      ...(string(details.initiator) ? { initiator: string(details.initiator) } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(parentToolCallId ? { parentToolCallId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(mcpServerName ? { mcpServerName } : {}),
      ...(mcpToolName ? { mcpToolName } : {}),
      ...(toolName ? { toolName } : {}),
      ...(event.model ? { model: event.model } : {}),
      ...(status ? { status } : {}), ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(string(details.apiCallId ?? details.providerCallId) ? { runId: string(details.apiCallId ?? details.providerCallId) } : {}),
      summary: string(details.progressMessage ?? details.summary) ?? event.name,
      ...(details.arguments !== undefined ? { input: redactContextPayload(details.arguments, options.redactSecrets ?? true) } : {}),
      ...(details.resultPreview !== undefined ? { output: redactContextPayload(details.resultPreview, options.redactSecrets ?? true) } : {}),
      data: redactContextPayload(event.details, options.redactSecrets ?? true),
      ...(event.type === 'model_call' ? { usage: usageOf({
        inputTokens: event.inputTokens, newInputTokens: details.newInputTokens, outputTokens: event.outputTokens,
        premiumRequestCost: event.premiumRequestCost,
        cachedInputTokens: details.cachedInputTokens, cacheWriteTokens: details.cacheWriteTokens,
        reasoningTokens: details.reasoningTokens, totalNanoAiu: details.totalNanoAiu,
        durationMs: event.durationMs, timeToFirstTokenMs: details.timeToFirstTokenMs,
        interTokenLatencyMs: details.interTokenLatencyMs, finishReason: details.finishReason,
        reasoningEffort: details.reasoningEffort, source: 'provider-event',
      }) } : {}),
      ...(event.type === 'model_call' ? { contextUsage: contextUsageOf({
        currentTokens: details.contextTokensAtCall, tokenLimit: details.contextTokenLimitAtCall,
        percent: details.contextPercentAtCall, messagesLength: details.contextMessagesAtCall,
      }) } : {}),
      ...(event.payloadComplete !== undefined ? { payloadComplete: event.payloadComplete } : {}),
    };
  });
  const runs: ContextRun[] = [];
  for (const event of ordered) {
    if (event.type !== 'model_call') continue;
    const details = object(event.details);
    const request = details.request ?? details.requestPayload ?? details.rawRequest;
    const response = details.response ?? details.responsePayload ?? details.rawResponse;
    const embedded = object(details.snapshot);
    if (!request && !Object.keys(embedded).length) continue;
    const snapshot = Object.keys(embedded).length ? snapshotOf(embedded, options)! : normalizeContext(request, response, {
      provider: options.provider, id: string(details.apiCallId ?? details.providerCallId) ?? event.id,
      includeRaw: options.includeRaw, redactSecrets: options.redactSecrets,
    });
    const eventRecord = contextEvents.find((item) => item.id === event.id);
    const usage = usageOf(eventRecord?.usage) ?? usageOf(snapshot.usage);
    const contextUsage = contextUsageOf(eventRecord?.contextUsage);
    const requestId = string(details.serviceRequestId ?? details.requestId ?? details.apiCallId ?? details.providerCallId);
    const actualModel = snapshot.model ?? event.model;
    runs.push({
      id: string(details.apiCallId ?? details.providerCallId) ?? event.id,
      sequence: event.sequence ?? runs.length + 1, sessionId, turnId: event.turnId,
      ...(requestId ? { requestId } : {}),
      ...(string(details.apiCallId) ? { apiCallId: string(details.apiCallId) } : {}),
      ...(string(details.providerCallId) ? { providerCallId: string(details.providerCallId) } : {}),
      ...(string(details.serviceRequestId) ? { serviceRequestId: string(details.serviceRequestId) } : {}),
      ...(string(details.parentRunId) ? { parentRunId: string(details.parentRunId) } : {}),
      ...(string(details.stage) ? { stage: string(details.stage) } : {}),
      ...(number(details.attempt) !== undefined ? { attempt: number(details.attempt) } : {}),
      ...(event.model || snapshot.model ? { model: event.model ?? snapshot.model, actualModel: snapshot.model ?? event.model } : {}),
      provider: options.provider ?? event.provider ?? string(details.provider) ?? snapshot.provider,
      ...(string(details.initiator) ? { initiator: string(details.initiator) } : {}),
      startedAt: event.timestamp,
      ...(response !== undefined || event.status === 'completed' ? { completedAt: string(details.completedAt) ?? event.timestamp } : {}),
      status: /fail|error/i.test(event.status ?? '') ? 'failed' : event.status === 'cancelled' ? 'cancelled' : event.status === 'aborted' ? 'aborted' : response !== undefined || event.status === 'completed' ? 'completed' : 'running',
      snapshot, ...(usage ? { usage } : {}), ...(contextUsage ? { contextUsage } : {}),
      payloadComplete: event.payloadComplete ?? (request !== undefined && response !== undefined || embedded.rawRequest != null && embedded.rawResponse !== undefined || Array.isArray(embedded.messages) && Array.isArray(embedded.responseMessages) && embedded.responseMessages.length > 0),
      ...(snapshot.provenance ? { provenance: snapshot.provenance } : {}),
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    });
  }
  return {
    id: sessionId,
    ...(ordered[0]?.timestamp ? { startedAt: ordered[0].timestamp } : {}),
    ...(ordered.at(-1)?.timestamp ? { updatedAt: ordered.at(-1)!.timestamp } : {}),
    runs, events: contextEvents,
    compactions: [],
    metadata: { source: 'agentic-data-architect-trajectory', eventCount: ordered.length, sourceTurnIds },
  };
}
