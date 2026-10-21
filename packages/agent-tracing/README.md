# @saga/agent-tracing

Provider-neutral tracing primitives for Node.js Agent applications. Works with Copilot SDK, CodeBuddy/WorkBuddy, LangChain, custom agents and ordinary async tools.

## Included

- `AgentTraceRecorder`: creates trace contexts, normalized events and duration spans.
- `InMemoryTraceStore`: test/demo store.
- `SqliteTraceStore`: append-only local SQLite event storage with sequence assignment and indexed queries.
- Recursive credential redaction and bounded event payloads.
- Query filters for trace, turn, sessions, event types, category and time range.
- Shared event schema from `@saga/agent-contracts`.

This package is an operational trace recorder, not a trace vendor, not a business audit engine, and not an authorization or policy system.

## Install

```bash
npm install @saga/agent-tracing @saga/agent-contracts
```

Requires Node.js >=22.13 for the built-in `node:sqlite` store. If a host wants another database or a remote backend, implement `AgentTraceStore`; the recorder does not require SQLite.

## Basic use

```ts
import { AgentTraceRecorder, SqliteTraceStore } from '@saga/agent-tracing';

const store = new SqliteTraceStore({ filename: './data/agent-traces.sqlite' });
const trace = new AgentTraceRecorder(store);
const context = trace.createContext({ sessionId: 'conversation-123' });

await trace.record({
  ...context,
  category: 'agent',
  type: 'turn.started',
  status: 'running',
  data: { requestId: 'req-42', prompt: 'Summarize the source' },
});

const answer = await trace.runSpan(
  { ...context, category: 'tool', name: 'knowledge.search', provider: 'local-index', data: { query: 'portfolio' } },
  async () => searchKnowledge('portfolio'),
);

const events = await trace.query({ traceId: context.traceId, limit: 100 });
await trace.close();
```

## Query and custom persistence

`trace.query({ traceId, turnId, sessionIds, types, category, since, until, limit })` returns events in chronological order. The recorder assigns a fresh event ID and timestamp if the caller does not provide them. The store assigns monotonically increasing sequence numbers within each trace; callers should not ask the LLM to provide event sequence numbers.

To store in PostgreSQL, a hosted telemetry service or an existing application database, implement:

```ts
interface AgentTraceStore {
  append(event: AgentEvent): Promise<AgentEvent>;
  query(query?: TraceQuery): Promise<AgentEvent[]>;
  close?(): Promise<void> | void;
}
```

The storage adapter owns atomic sequence assignment, durability, indexes, retention, access controls and concurrency semantics.

## Privacy and failure semantics

- Secret-shaped keys such as `token`, `authorization`, `api_key`, `password`, `secret`, `cookie` and `credential` are recursively redacted by default. Bearer values are redacted too.
- Event `data` is limited to 1 MiB by default. An oversized payload is replaced with a marked record containing its original byte count and a bounded preview; `payloadComplete=false` means the stored event is incomplete.
- The recorder does not automatically persist hidden model reasoning or tool payloads. Callers decide which fields are safe to include.
- Persistence errors propagate. Applications may explicitly catch them for best-effort telemetry; workflows where a recorded event is a required guarantee should not silently swallow errors.
- Do not use traces as the sole regulatory/business audit record. A span, LangSmith trace or tool result does not prove that an actor was authorized or an external side effect succeeded.
- SQLite is local persistence, not multi-user access control, backup or tamper-proof storage. Protect files and define retention.
