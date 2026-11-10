import type { ContextCompaction, ContextEvent, ContextMessage, ContextSession, ContextSnapshot, ToolCallGraph, ToolCallNode } from './model.js';
import { diffContext } from './diff.js';

export function buildToolCallGraph(messages: readonly ContextMessage[], events: readonly ContextEvent[] = []): ToolCallGraph {
  const nodes = new Map<string, ToolCallNode>();
  const orphanResults: ToolCallGraph['orphanResults'] = [];
  const ensureNode = (id: string, name: string, args: unknown, messageId: string, messageIndex: number, extra: Partial<ToolCallNode> = {}) => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const node: ToolCallNode = { id, name, arguments: args, messageId, messageIndex, status: 'pending', progress: [], ...extra };
    nodes.set(id, node);
    return node;
  };
  for (const message of messages) for (const part of message.parts) {
    if (part.kind === 'tool-call') {
      const id = part.id ?? message.id + ':' + part.name + ':' + nodes.size;
      const parent = message.metadata.parentToolCallId;
      ensureNode(id, part.name, part.arguments, message.id, message.index, {
        ...(typeof parent === 'string' ? { parentToolCallId: parent } : {}),
      });
    } else if (part.kind === 'tool-result') {
      const node = part.toolCallId ? nodes.get(part.toolCallId) : undefined;
      if (node) Object.assign(node, { result: part.content, resultMessageId: message.id, status: part.isError ? 'failed' : 'completed', isError: part.isError });
      else orphanResults.push({ toolCallId: part.toolCallId, messageId: message.id, content: part.content });
    }
  }
  for (const event of events) {
    if (event.type === 'tool-call' && event.toolCallId) {
      const node = ensureNode(event.toolCallId, event.toolName ?? event.mcpToolName ?? 'unknown', event.input, event.id, -1, {
        ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.mcpServerName ? { mcpServerName: event.mcpServerName } : {}),
        ...(event.mcpToolName ? { mcpToolName: event.mcpToolName } : {}),
        ...(event.timestamp ? { startedAt: event.timestamp } : {}),
      });
      node.durationMs = event.durationMs ?? node.durationMs;
      if (event.status === 'failed' || event.status === 'cancelled') node.status = 'failed';
      if (event.status === 'completed') node.status = 'completed';
    } else if (event.type === 'tool-progress' && event.toolCallId) {
      const node = nodes.get(event.toolCallId);
      if (node) node.progress.push({ timestamp: event.timestamp, message: event.summary, data: event.data });
    } else if (event.type === 'tool-result' && event.toolCallId) {
      const node = nodes.get(event.toolCallId);
      if (node) Object.assign(node, {
        result: event.output ?? event.data, status: event.status === 'failed' ? 'failed' : 'completed',
        isError: event.status === 'failed', completedAt: event.timestamp,
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      });
      else orphanResults.push({ toolCallId: event.toolCallId, messageId: event.id, content: event.output ?? event.data });
    }
  }
  const values = [...nodes.values()];
  const roots = values.filter((node) => !node.parentToolCallId || !nodes.has(node.parentToolCallId)).map((node) => node.id);
  return { nodes: values, roots, orphanResults };
}

export function buildContextTimeline(session: Pick<ContextSession, 'runs' | 'events' | 'compactions'>): Array<{
  id: string; timestamp: string; type: string; title: string; description?: string; status?: string; durationMs?: number;
}> {
  const items: Array<{ id: string; timestamp: string; type: string; title: string; description?: string; status?: string; durationMs?: number }> = [];
  for (const run of session.runs) items.push({
    id: 'run:' + run.id, timestamp: run.startedAt, type: 'llm-request',
    title: 'LLM call #' + run.sequence + (run.actualModel ?? run.snapshot.model ? ' · ' + (run.actualModel ?? run.snapshot.model) : ''),
    description: [run.provider ?? run.snapshot.provider, run.requestId ? 'request ' + run.requestId : undefined,
      (run.usage?.inputTokens ?? run.inputTokens ?? run.snapshot.usage?.inputTokens) !== undefined ? (run.usage?.inputTokens ?? run.inputTokens ?? run.snapshot.usage?.inputTokens) + ' input tokens' : undefined,
      (run.usage?.outputTokens ?? run.outputTokens ?? run.snapshot.usage?.outputTokens) !== undefined ? (run.usage?.outputTokens ?? run.outputTokens ?? run.snapshot.usage?.outputTokens) + ' output tokens' : undefined].filter(Boolean).join(' · '),
    status: run.status,
    durationMs: run.completedAt ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)) : run.usage?.durationMs,
  });
  for (const event of session.events) items.push({
    id: event.id, timestamp: event.timestamp, type: event.type,
    title: event.summary ?? event.toolName ?? event.mcpToolName ?? event.type,
    description: [event.runId ? 'Run ' + event.runId : undefined, event.turnId ? 'Turn ' + event.turnId : undefined,
      event.provider, event.model, event.payloadComplete === false ? 'payload incomplete' : undefined].filter(Boolean).join(' · ') || undefined,
    status: event.status, durationMs: event.durationMs,
  });
  for (const compaction of session.compactions) items.push({
    id: 'compaction:' + compaction.id, timestamp: compaction.timestamp, type: 'compaction',
    title: 'Context compaction', description: compaction.reason ?? compaction.strategy ?? 'Context changed',
    status: compaction.status ?? 'completed', durationMs: compaction.durationMs,
  });
  return items.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
}

export interface CompactionAnalysis {
  diff: ReturnType<typeof diffContext>; beforeTokens?: number; afterTokens?: number;
  tokenReduction?: number; tokenReductionPercent?: number;
  removedMessageIds: string[]; preservedMessageIds: string[];
}
export function analyzeCompaction(compaction: ContextCompaction): CompactionAnalysis {
  const before = compaction.before.messages; const after = compaction.after.messages;
  const afterIds = new Set(after.map((message) => message.id));
  const beforeIds = new Set(before.map((message) => message.id));
  const removed = compaction.removedMessageIds ?? before.filter((message) => !afterIds.has(message.id)).map((message) => message.id);
  const preserved = compaction.preservedMessageIds ?? before.filter((message) => afterIds.has(message.id)).map((message) => message.id);
  const beforeTokens = compaction.preCompactionTokens ?? compaction.before.usage?.inputTokens;
  const afterTokens = compaction.postCompactionTokens ?? compaction.after.usage?.inputTokens;
  const reduction = compaction.tokensRemoved ?? (beforeTokens !== undefined && afterTokens !== undefined ? beforeTokens - afterTokens : undefined);
  return {
    diff: diffContext(before, after),
    ...(beforeTokens !== undefined ? { beforeTokens } : {}),
    ...(afterTokens !== undefined ? { afterTokens } : {}),
    ...(reduction !== undefined ? { tokenReduction: reduction, tokenReductionPercent: beforeTokens ? reduction / beforeTokens * 100 : 0 } : {}),
    removedMessageIds: removed, preservedMessageIds: preserved.filter((id) => beforeIds.has(id)),
  };
}
export function latestSnapshot(session: Pick<ContextSession, 'runs'>): ContextSnapshot | undefined {
  return [...session.runs].sort((a, b) => b.sequence - a.sequence)[0]?.snapshot;
}
