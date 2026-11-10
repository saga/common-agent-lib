export type ContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; signature?: string }
  | { kind: 'image'; url?: string; mediaType?: string; detail?: string; alt?: string }
  | { kind: 'tool-call'; id?: string; name: string; arguments: unknown }
  | { kind: 'tool-result'; toolCallId?: string; name?: string; content: unknown; isError?: boolean }
  | { kind: 'json'; value: unknown }
  | { kind: 'refusal'; text: string }
  | { kind: 'unknown'; type: string; value: unknown };

export type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'unknown';
export interface ContextMessage {
  id: string; index: number; role: MessageRole; name?: string; recipient?: string; channel?: string;
  timestamp?: string; parts: ContentPart[]; raw: unknown; tokenCount?: number; metadata: Record<string, unknown>;
}
export interface ContextTool { name: string; description?: string; inputSchema?: unknown; raw: unknown }

/** Provider-reported consumption for one model call. Missing measurements remain absent. */
export interface ModelCallUsage {
  model?: string; inputTokens?: number; newInputTokens?: number; outputTokens?: number; totalTokens?: number;
  cachedInputTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number;
  premiumRequestCost?: number; totalNanoAiu?: number; providerCost?: number; providerCostUnit?: string;
  durationMs?: number; finishReason?: string; reasoningEffort?: string;
  timeToFirstTokenMs?: number; interTokenLatencyMs?: number;
  source?: 'provider-event' | 'session-metrics' | 'unknown';
  byModel?: Record<string, Omit<ModelCallUsage, 'model' | 'byModel'>>;
}
/** Context-window occupancy is a snapshot, not token consumption. */
export interface ContextUsage {
  currentTokens?: number; tokenLimit?: number; messagesLength?: number; percent?: number;
}
export interface ContextProvenance {
  sourceRevision?: string; promptRevision?: string; pipelineVersion?: string;
  configurationRevision?: string; memoryRevision?: string; contextHash?: string;
  inputIds?: string[]; schemaVersion?: string; initiator?: string; scope?: string;
}
export interface ContextSnapshot {
  id: string; provider: string; model?: string; createdAt?: string;
  messages: ContextMessage[]; tools: ContextTool[]; parameters: Record<string, unknown>;
  system?: string; rawRequest: unknown; rawResponse?: unknown; responseMessages: ContextMessage[];
  usage?: ModelCallUsage; warnings: string[]; provenance?: ContextProvenance;
}
export interface NormalizeOptions { provider?: string; id?: string; redactSecrets?: boolean; includeRaw?: boolean; provenance?: ContextProvenance }
export interface MessageChange {
  index: number; kind: 'added' | 'removed' | 'changed' | 'unchanged';
  before?: ContextMessage; after?: ContextMessage; changedFields?: string[];
}
export interface ContextDiff { added: number; removed: number; changed: number; unchanged: number; changes: MessageChange[] }

export type ContextEventType =
  | 'user-input' | 'turn-start' | 'turn-end' | 'assistant-turn-start' | 'assistant-turn-end'
  | 'llm-request' | 'llm-response' | 'tool-call' | 'tool-progress' | 'tool-result'
  | 'permission' | 'permission-completed' | 'user-input-requested' | 'user-input-completed'
  | 'compaction' | 'context-changed' | 'retry' | 'checkpoint' | 'session-idle'
  | 'session-error' | 'stage-gate' | 'error' | 'custom';
export type ContextEventStatus = 'started' | 'completed' | 'failed' | 'cancelled' | 'waiting' | 'info';
export interface ContextEvent {
  id: string; type: ContextEventType; timestamp: string;
  sessionId?: string; traceId?: string; turnId?: string; runId?: string;
  correlationId?: string; parentEventId?: string; sequence?: number;
  agentId?: string; category?: string; provider?: string; model?: string;
  toolCallId?: string; parentToolCallId?: string; toolName?: string;
  mcpServerName?: string; mcpToolName?: string;
  status?: ContextEventStatus; durationMs?: number; summary?: string;
  input?: unknown; output?: unknown; data?: unknown; metadata?: Record<string, unknown>;
  usage?: ModelCallUsage; contextUsage?: ContextUsage; payloadComplete?: boolean;
}
export interface ContextRun {
  id: string; sequence: number; sessionId?: string; turnId?: string;
  requestId?: string; parentRunId?: string; stage?: string; attempt?: number;
  provider?: string; model?: string; actualModel?: string;
  startedAt: string; completedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'aborted';
  snapshot: ContextSnapshot; usage?: ModelCallUsage; contextUsage?: ContextUsage;
  provenance?: ContextProvenance; inputTokens?: number; outputTokens?: number;
  metadata?: Record<string, unknown>;
}
export interface ContextCompaction {
  id: string; timestamp: string; reason?: string; strategy?: string;
  before: ContextSnapshot; after: ContextSnapshot; summary?: string;
  removedMessageIds?: string[]; preservedMessageIds?: string[];
  preCompactionTokens?: number; postCompactionTokens?: number; tokensRemoved?: number;
  messagesRemoved?: number; durationMs?: number; requestId?: string;
  status?: 'completed' | 'failed'; error?: string; metadata?: Record<string, unknown>;
}
export interface ContextSession {
  id: string; traceId?: string; correlationId?: string; agentId?: string;
  startedAt?: string; updatedAt?: string; runs: ContextRun[];
  events: ContextEvent[]; compactions: ContextCompaction[];
  provenance?: ContextProvenance; metadata?: Record<string, unknown>;
}
export interface ToolCallNode {
  id: string; name: string; arguments: unknown; messageId: string; messageIndex: number;
  result?: unknown; resultMessageId?: string; status: 'pending' | 'completed' | 'failed';
  isError?: boolean; parentToolCallId?: string; agentId?: string;
  mcpServerName?: string; mcpToolName?: string; startedAt?: string; completedAt?: string;
  durationMs?: number; progress: Array<{ timestamp: string; message?: unknown; data?: unknown }>;
}
export interface ToolCallGraph {
  nodes: ToolCallNode[];
  roots: string[];
  orphanResults: Array<{ toolCallId?: string; messageId: string; content: unknown }>;
}
