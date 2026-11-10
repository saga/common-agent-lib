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
export interface ContextSnapshot {
  id: string; provider: string; model?: string; createdAt?: string;
  messages: ContextMessage[]; tools: ContextTool[]; parameters: Record<string, unknown>;
  system?: string; rawRequest: unknown; rawResponse?: unknown; responseMessages: ContextMessage[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };
  warnings: string[];
}
export interface NormalizeOptions { provider?: string; id?: string; redactSecrets?: boolean; includeRaw?: boolean }
export interface MessageChange {
  index: number; kind: 'added' | 'removed' | 'changed' | 'unchanged';
  before?: ContextMessage; after?: ContextMessage; changedFields?: string[];
}
export interface ContextDiff { added: number; removed: number; changed: number; unchanged: number; changes: MessageChange[] }
