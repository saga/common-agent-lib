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
export interface ContextUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; reasoningTokens?: number }
export interface ContextSnapshot {
  id: string; provider: string; model?: string; createdAt?: string;
  messages: ContextMessage[]; tools: ContextTool[]; parameters: Record<string, unknown>;
  system?: string; rawRequest: unknown; rawResponse?: unknown; responseMessages: ContextMessage[];
  usage?: ContextUsage; warnings: string[];
}
export interface NormalizeOptions { provider?: string; id?: string; redactSecrets?: boolean; includeRaw?: boolean }
export interface MessageChange {
  index: number; kind: 'added' | 'removed' | 'changed' | 'unchanged';
  before?: ContextMessage; after?: ContextMessage; changedFields?: string[];
}
export interface ContextDiff { added: number; removed: number; changed: number; unchanged: number; changes: MessageChange[] }

export type ContextEventType = 'llm-request' | 'llm-response' | 'tool-call' | 'tool-result' | 'compaction' | 'retry' | 'error' | 'custom';
export interface ContextEvent {
  id: string; type: ContextEventType; timestamp: string; sessionId?: string; runId?: string;
  parentEventId?: string; toolCallId?: string; toolName?: string; status?: 'started' | 'completed' | 'failed' | 'cancelled';
  durationMs?: number; summary?: string; input?: unknown; output?: unknown; metadata?: Record<string, unknown>;
}
export interface ContextRun {
  id: string; sequence: number; startedAt: string; completedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; snapshot: ContextSnapshot;
  inputTokens?: number; outputTokens?: number; metadata?: Record<string, unknown>;
}
export interface ContextCompaction {
  id: string; timestamp: string; reason?: string; strategy?: string;
  before: ContextSnapshot; after: ContextSnapshot; summary?: string;
  removedMessageIds?: string[]; preservedMessageIds?: string[]; metadata?: Record<string, unknown>;
}
export interface ContextSession {
  id: string; traceId?: string; startedAt?: string; updatedAt?: string;
  runs: ContextRun[]; events: ContextEvent[]; compactions: ContextCompaction[];
  metadata?: Record<string, unknown>;
}
export interface ToolCallNode {
  id: string; name: string; arguments: unknown; messageId: string; messageIndex: number;
  result?: unknown; resultMessageId?: string; status: 'pending' | 'completed' | 'failed';
  isError?: boolean; parentToolCallId?: string; durationMs?: number;
}
export interface ToolCallGraph { nodes: ToolCallNode[]; roots: string[]; orphanResults: Array<{ toolCallId?: string; messageId: string; content: unknown }> }
