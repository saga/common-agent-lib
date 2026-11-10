# @saga/agent-context-explorer

Provider-neutral LLM request/response inspection and session-level Agent debugging UI built with Ant Design and Ant Design X.

The package normalizes OpenAI Chat Completions, Responses-style arrays, Anthropic-style messages/content blocks and generic message payloads. It exposes structured messages, tools, parameters, raw payloads and usage. The session debugger adds a chronological LLM-call timeline, correlated tool execution graph, run-level token accounting, context diffs and before/after compaction analysis.

## Install

```bash
npm install @saga/agent-context-explorer react antd @ant-design/x
```

## Single exchange

```tsx
import { normalizeContext, ContextExplorer } from '@saga/agent-context-explorer';

const snapshot = normalizeContext(request, response, { provider: 'openai-compatible' });
<ContextExplorer snapshot={snapshot} />;
```

## Agent session debugger

```tsx
import { ContextDebugger, type ContextSession } from '@saga/agent-context-explorer';

const session: ContextSession = {
  id: 'session-123',
  runs: [{ id: 'run-1', sequence: 1, startedAt, completedAt, status: 'completed', snapshot }],
  events: [
    { id: 'event-1', type: 'tool-call', timestamp, toolCallId: 'call-1', toolName: 'search', status: 'started' },
    { id: 'event-2', type: 'tool-result', timestamp: resultAt, toolCallId: 'call-1', toolName: 'search', status: 'completed', output: result },
  ],
  compactions: [{ id: 'compact-1', timestamp, reason: 'Context budget threshold', before, after, strategy: 'summary-and-prune' }],
};
<ContextDebugger session={session} />;
```

## Data model and responsibilities

- `ContextRun` is one actual provider request/response, including the normalized snapshot and per-call usage.
- `ContextEvent` carries runtime events that may not be present in provider payloads: tool lifecycle, retries, errors and custom trace events.
- `ContextSession` groups ordered model calls, runtime events and compaction snapshots under one Agent session/trace.
- `buildToolCallGraph` correlates tool calls and results using provider call IDs. It reports unmatched results rather than silently dropping them.
- `buildContextTimeline` merges run, event and compaction records into chronological order.
- `analyzeCompaction` compares before/after message sets and provider-reported input token counts. It does not estimate tokens.

Capture at the provider transport boundary whenever possible. Runtime events should be emitted by the host or tracing integration; the explorer does not intercept SDKs, persist traces or infer missing events. The host owns event ordering, trace identity, permissions, retention and data classification.

## Privacy and limitations

Secret-shaped keys and Bearer values are redacted by default during normalization. Raw prompts and responses remain visible because they are the subject of inspection. Redaction is a defensive default, not authorization, retention control or encryption. Hidden reasoning is displayed only if explicitly present in captured payloads; the package never retrieves or reconstructs it.

Tool correlation requires stable tool-call IDs. A missing result is shown as pending; a result with no matching call is surfaced as an orphan. Compaction analysis is only as accurate as the before/after snapshots supplied by the host. Token reduction is shown only when provider-reported usage exists.

React, Ant Design and Ant Design X are peer dependencies. The host application owns global theme configuration and CSS reset.

## Development

```sh
npm run typecheck
npm test
npm run build
```
