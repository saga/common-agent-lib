# @saga/agent-context-explorer

Provider-neutral LLM request/response inspection and session-level Agent debugging UI built with Ant Design and Ant Design X.

The package accepts normalized snapshots, session/run/event records, existing `@saga/agent-tracing` event envelopes and the `agentic-data-architect` TrajectoryEvent shape. It does not depend on a provider SDK or tracing storage implementation.

## Install

```bash
npm install @saga/agent-context-explorer react antd @ant-design/x
```

## Single exchange

```tsx
import { normalizeContext, ContextExplorer } from '@saga/agent-context-explorer';

const snapshot = normalizeContext(request, response, {
  provider: 'openai-compatible',
  provenance: {
    promptRevision: 'prompt-v3',
    configurationRevision: 'config-42',
    contextHash: 'sha256:...',
  },
});
<ContextExplorer snapshot={snapshot} />;
```

## Session debugger

```tsx
import { ContextDebugger, type ContextSession } from '@saga/agent-context-explorer';

const session: ContextSession = {
  id: 'session-123',
  traceId: 'trace-456',
  runs: [{
    id: 'run-1', sequence: 1, sessionId: 'session-123', turnId: 'turn-1',
    requestId: 'request-1', provider: 'openai-compatible', model: 'model-a',
    actualModel: 'model-a', startedAt, completedAt, status: 'completed',
    snapshot, usage: { inputTokens: 1200, outputTokens: 240, source: 'provider-event' },
    contextUsage: { currentTokens: 18000, tokenLimit: 128000, messagesLength: 24, percent: 14 },
    provenance: { promptRevision: 'prompt-v3', configurationRevision: 'config-42' },
  }],
  events: [
    { id: 'event-1', type: 'tool-call', timestamp, toolCallId: 'call-1', toolName: 'search', status: 'started' },
    { id: 'event-2', type: 'tool-progress', timestamp: progressAt, toolCallId: 'call-1', summary: 'Reading page 1' },
    { id: 'event-3', type: 'tool-result', timestamp: resultAt, toolCallId: 'call-1', status: 'completed', output: result },
  ],
  compactions: [{ id: 'compact-1', timestamp, reason: 'Context budget threshold', before, after, strategy: 'summary-and-prune' }],
};
<ContextDebugger session={session} />;
```

## Adapting existing saga traces

The adapter consumes the existing event envelope without coupling the package to the recorder implementation:

```ts
import {
  contextSessionsFromAgentEvents,
  contextSessionFromTrajectoryEvents,
} from '@saga/agent-context-explorer';

// Events returned by AgentTraceRecorder.query() / AgentTraceStore.query()
const sessions = contextSessionsFromAgentEvents(agentEvents);

// agentic-data-architect trajectory records
const session = contextSessionFromTrajectoryEvents(trajectoryEvents);
```

The AgentEvent adapter recognizes provider payloads stored as `data.request` / `data.response` (or `requestPayload` / `responsePayload`) and preserves correlation, sequence, usage, context occupancy and payload completeness. The Trajectory adapter maps turn, tool, permission, user-input, retry, compaction, checkpoint and error events. It creates a ContextRun only when the trajectory contains an actual provider request or an already normalized snapshot; summary-only model events remain events and are not promoted into fabricated snapshots.

For other runtimes, implement the same mapping at the host boundary. Keep the original event type and payload in `data` / `metadata` so provider- or application-specific details are not discarded.

## Data contract

- `ContextSession` groups runs, events and compaction snapshots. Correlation supports session, trace, turn, request, parent-event and sequence identifiers.
- `ContextRun` represents one actual model exchange. It records requested and observed model identity, provider, attempt/stage, timing, status, usage, context occupancy and provenance.
- `ContextEvent` covers turn lifecycle, model calls, tool lifecycle/progress, permissions, user-input waits, retry, checkpoint, compaction, context changes, idle and errors. Unknown runtime events remain `custom`.
- `ContextCompaction` records before/after snapshots and provider/runtime reported token and message reductions, duration and failure details.
- `ModelCallUsage` is consumption for a provider call. It keeps reported total input and uncached/new input separate, alongside cache, reasoning, latency and provider billing metrics. `ContextUsage` is a point-in-time context-window measurement. They are deliberately separate and neither is inferred from text length.
- `ContextProvenance` associates captured context with source, prompt, pipeline, configuration and memory revisions, hashes and input IDs.
- `buildToolCallGraph` correlates calls, progress and results by stable tool-call IDs. It preserves parent tool and agent/MCP metadata and surfaces orphan results.
- `buildContextTimeline` orders model calls, runtime events and compactions by timestamp and persisted sequence.
- `analyzeCompaction` compares before/after message identities and uses reported usage only; it does not estimate tokens.

## Capture requirements

Capture the actual provider request after the host has injected system/developer instructions, history, retrieved memory, tool schemas and context-budget transformations. Capturing only the user's initial prompt or an application-side draft does not establish what the model received.

For useful cross-project debugging, retain:
- Stable `sessionId`, `traceId`, `turnId`, `requestId`, `parentEventId`, and store-assigned `sequence`.
- Actual provider/model identity, request/response payloads, status, timestamps and duration.
- Tool call IDs, parent IDs, arguments/results when permitted, progress and failure status.
- Permission and user-input request/completion events, including waiting and timeout states.
- Provider-reported usage and context occupancy, with their source.
- Context/prompt/configuration/memory revisions or hashes when those inputs affect reproducibility.

A runtime event stream may not expose provider payloads. Mark incomplete payloads with `payloadComplete: false`; do not claim a Session can be fully replayed if the SDK only provides truncated event summaries. Diagram Studio's compact SDK event logs are useful for lifecycle diagnosis but are not a substitute for transport-boundary request capture.

## Boundaries and persistence

- `@saga/agent-context`: deterministic context composition and budget accounting.
- `@saga/agent-tracing`: trace/span lifecycle, correlation, redaction, payload bounds, persistence and operational telemetry.
- `@saga/agent-context-explorer`: normalization, inspection, correlation views, comparison and analysis.
- Host application: SDK/HTTP instrumentation, permissions, data classification, retention, authorization and business audit.

The explorer does not intercept SDKs, persist traces, authorize access, estimate tokens, or implement a tamper-proof business audit ledger. It can read the event envelope used by `@saga/agent-tracing`, but storage remains with the host/tracing layer. Persistence errors must be handled by the recorder/host; required audit writes must not be silently swallowed.

## Privacy and limitations

Secret-shaped keys and Bearer values are redacted by default during normalization. Raw prompts and responses remain visible because they are the subject of inspection. Redaction is a defensive default, not authorization, retention control or encryption. Hosts must classify content and control access before recording it. Do not persist hidden reasoning unless the provider explicitly returns it and the host policy allows capture.

The default `@saga/agent-tracing` recorder bounds event payloads and marks truncated records with `payloadComplete=false`. The explorer surfaces that limitation; it cannot reconstruct omitted content. Tool correlation requires stable IDs. A missing result is shown as pending; a result with no matching call is surfaced as an orphan.

React, Ant Design and Ant Design X are peer dependencies. The host application owns global theme configuration and CSS reset.

## Development

```sh
npm run typecheck
npm test
npm run build
```
