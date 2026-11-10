# ADR 0013: Session-level Agent Context Debugger

- Status: Accepted
- Date: 2026-11-10

## Context

A single request viewer cannot explain multi-step Agent behavior. Debugging needs a session-level view of repeated LLM calls, tool execution, retries/errors and context transformations. The explorer must remain independent of Agent runtimes and trace persistence.

## Decision

Extend @saga/agent-context-explorer with a host-neutral session model:

- ContextRun represents one provider request/response and its normalized ContextSnapshot.
- ContextEvent represents runtime events such as tool-call/result, retry, error and compaction markers.
- ContextSession groups runs, events and compaction snapshots under a session/trace identity.
- Tool-call graph correlates calls/results using stable call IDs and exposes orphan results.
- Timeline merges model calls, runtime events and compaction records chronologically.
- Compaction analysis compares before/after message identities and provider-reported token usage.

The UI uses Ant Design for data-heavy views and Ant Design X Bubble for message presentation.

## Boundaries

The host or tracing integration emits session/run/event records. The explorer does not intercept Copilot SDK, CodeBuddy SDK or other provider transports, persist events, infer missing tool results, estimate tokens or manage context budgets. Existing agent-tracing remains the source of trace lifecycle and persistence; adapters can map its records to this package's neutral model.

## Consequences

Applications can embed a session debugger without coupling to a specific Agent runtime or tracing vendor. Missing call/result correlation becomes visible rather than silently hidden. Compaction comparisons are auditable when hosts preserve snapshots before and after transformation.

The initial model was subsequently aligned with the shared saga trace envelope and the Agentic Data Architect trajectory contract. See ADR 0014 for the expanded lifecycle, usage, provenance, adapter and payload-completeness decisions. The trajectory adapter deliberately synthesizes a clearly named session key when its source only provides turn identity; it never treats a turn ID as a trace ID.
