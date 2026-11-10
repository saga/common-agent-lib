import type { ContextCompaction, ContextEvent, ContextMessage, ContextSession, ContextSnapshot, ToolCallGraph, ToolCallNode } from './model.js';
import { diffContext } from './diff.js';

const messageParts = (message: ContextMessage) => message.parts;
export function buildToolCallGraph(messages: readonly ContextMessage[], events: readonly ContextEvent[] = []): ToolCallGraph {
  const nodes = new Map<string, ToolCallNode>();
  const orphanResults: ToolCallGraph['orphanResults'] = [];
  for (const message of messages) {
    for (const part of messageParts(message)) {
      if (part.kind === 'tool-call') {
        const id = part.id ?? message.id + ':' + part.name + ':' + nodes.size;
        const parent = message.metadata.parentToolCallId;
        nodes.set(id, { id, name: part.name, arguments: part.arguments, messageId: message.id, messageIndex: message.index, status: 'pending', ...(typeof parent === 'string' ? { parentToolCallId: parent } : {}) });
      } else if (part.kind === 'tool-result') {
        const node = part.toolCallId ? nodes.get(part.toolCallId) : undefined;
        if (node) Object.assign(node, { result: part.content, resultMessageId: message.id, status: part.isError ? 'failed' : 'completed', isError: part.isError });
        else orphanResults.push({ toolCallId: part.toolCallId, messageId: message.id, content: part.content });
      }
    }
  }
  for (const event of events) {
    if (event.type === 'tool-call' && event.toolCallId) {
      const existing = nodes.get(event.toolCallId);
      if (existing) {
        existing.durationMs = event.durationMs ?? existing.durationMs;
        existing.status = event.status === 'failed' ? 'failed' : existing.status;
      } else {
        nodes.set(event.toolCallId, { id: event.toolCallId, name: event.toolName ?? 'unknown', arguments: event.input, messageId: event.id, messageIndex: -1, status: event.status === 'failed' ? 'failed' : 'pending', ...(typeof event.parentEventId === 'string' ? { parentToolCallId: event.parentEventId } : {}), ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}) });
      }
    }
    if (event.type === 'tool-result' && event.toolCallId) {
      const node = nodes.get(event.toolCallId);
      if (node) Object.assign(node, { result: event.output, status: event.status === 'failed' ? 'failed' : 'completed', isError: event.status === 'failed', ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}) });
      else orphanResults.push({ toolCallId: event.toolCallId, messageId: event.id, content: event.output });
    }
  }
  const values = [...nodes.values()];
  const roots = values.filter((node) => !node.parentToolCallId || !nodes.has(node.parentToolCallId)).map((node) => node.id);
  return { nodes: values, roots, orphanResults };
}
export function buildContextTimeline(session: Pick<ContextSession, 'runs' | 'events' | 'compactions'>): Array<{ id: string; timestamp: string; type: string; title: string; description?: string; status?: string; durationMs?: number }> {
  const items: Array<{ id: string; timestamp: string; type: string; title: string; description?: string; status?: string; durationMs?: number }> = [];
  for (const run of session.runs) items.push({
    id: 'run:' + run.id, timestamp: run.startedAt, type: 'llm-request',
    title: 'LLM call #' + run.sequence + (run.snapshot.model ? ' · ' + run.snapshot.model : ''),
    description: (run.inputTokens ?? run.snapshot.usage?.inputTokens ?? 0) + ' input tokens · ' + (run.outputTokens ?? run.snapshot.usage?.outputTokens ?? 0) + ' output tokens',
    status: run.status, durationMs: run.completedAt ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)) : undefined,
  });
  for (const event of session.events) items.push({ id: event.id, timestamp: event.timestamp, type: event.type, title: event.summary ?? event.toolName ?? event.type, description: event.runId ? 'Run ' + event.runId : undefined, status: event.status, durationMs: event.durationMs });
  for (const compaction of session.compactions) items.push({ id: 'compaction:' + compaction.id, timestamp: compaction.timestamp, type: 'compaction', title: 'Context compaction', description: compaction.reason ?? compaction.strategy ?? 'Context changed', status: 'completed' });
  return items.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
}
export interface CompactionAnalysis {
  diff: ReturnType<typeof diffContext>; beforeTokens?: number; afterTokens?: number;
  tokenReduction?: number; tokenReductionPercent?: number; removedMessageIds: string[]; preservedMessageIds: string[];
}
export function analyzeCompaction(compaction: ContextCompaction): CompactionAnalysis {
  const before = compaction.before.messages;
  const after = compaction.after.messages;
  const afterIds = new Set(after.map((message) => message.id));
  const beforeIds = new Set(before.map((message) => message.id));
  const removed = compaction.removedMessageIds ?? before.filter((message) => !afterIds.has(message.id)).map((message) => message.id);
  const preserved = compaction.preservedMessageIds ?? before.filter((message) => afterIds.has(message.id)).map((message) => message.id);
  const beforeTokens = compaction.before.usage?.inputTokens;
  const afterTokens = compaction.after.usage?.inputTokens;
  const reduction = beforeTokens !== undefined && afterTokens !== undefined ? beforeTokens - afterTokens : undefined;
  return {
    diff: diffContext(before, after), ...(beforeTokens !== undefined ? { beforeTokens } : {}),
    ...(afterTokens !== undefined ? { afterTokens } : {}), ...(reduction !== undefined ? { tokenReduction: reduction, tokenReductionPercent: beforeTokens ? reduction / beforeTokens * 100 : 0 } : {}),
    removedMessageIds: removed, preservedMessageIds: preserved.filter((id) => beforeIds.has(id)),
  };
}
export function latestSnapshot(session: Pick<ContextSession, 'runs'>): ContextSnapshot | undefined {
  return [...session.runs].sort((a, b) => b.sequence - a.sequence)[0]?.snapshot;
}
