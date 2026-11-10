# ADR 0014: Align Context Explorer with saga trace contracts

- Status: Accepted
- Date: 2026-11-10

## Context

The initial session debugger introduced a useful provider-neutral model, but comparison with existing saga projects exposed gaps:

- `agentic-data-architect` records a typed TrajectoryEvent lifecycle, including turn boundaries, tool progress, permissions, user-input waits, checkpoints, stage gates, idle and errors.
- `architecture-diagram-studio` distinguishes model-call usage from context-window occupancy and records cached/write/reasoning tokens, premium request cost, nano-AIU, finish reason, reasoning effort, time-to-first-token and inter-token latency. Its compact SDK event log is intentionally not a full prompt capture.
- `vocal-saga` ADR-0002 requires the actual translation inputs, prompt/context revisions, source identities, model/provider information and response evidence to be preserved when a run must be reproducible. A hash or summary alone is insufficient for that purpose.
- `agent-contracts` and `agent-tracing` already define correlation fields, normalized usage, context occupancy, payload completeness, redaction and durable event storage.

The explorer must consume these conventions without becoming another runtime, recorder or business-audit system.

## Decision

Extend the explorer's model with the saga correlation and execution fields: session/trace/turn/request/parent IDs, sequence, provider and observed model, attempt/stage, richer statuses, tool parent/agent/MCP metadata, progress, permissions, user-input waits, checkpoints, idle/error and stage-gate events.

Keep model-call usage and context occupancy separate. Preserve provider-reported total/new input tokens, cache counters, reasoning tokens, provider cost with unit, premium-request cost, nano-AIU, latency, finish reason and reasoning effort. Map Agentic Data Architect's `contextTokensAtCall`, `contextTokenLimitAtCall`, `contextPercentAtCall` and `contextMessagesAtCall` to context occupancy. Missing measurements remain absent; the package does not estimate tokens or currency.

Add `ContextProvenance` for source, prompt, pipeline, configuration and memory revisions, context hash, input IDs, schema version, initiator and scope. These are optional because not every runtime exposes them, but hosts should supply them when reproducibility depends on those values.

Add structural adapters for:
- `@saga/agent-tracing` / `@saga/agent-contracts` AgentEvent envelopes.
- `agentic-data-architect` TrajectoryEvent records.

The adapters preserve original payloads and mark incomplete payloads. They map service/provider request IDs, API call IDs, MCP tool metadata, progress, permissions, user-input waits, cancellation and aborted states. They only create a ContextRun when an actual request or normalized snapshot is available. A compact event summary is not treated as a complete prompt/response.

## Capture contract

For a model call that needs to be inspected or reproduced, the host should capture the final request at the provider transport boundary, after system/developer prompt injection, history selection, memory retrieval, tool-schema injection and context compression. The matching response, provider/model identity, request ID, usage and timing should be captured when available.

Tool events should retain stable call IDs, parent call IDs, agent identity, MCP server/tool identity, arguments, progress, result and error status, subject to host data-classification policy.

Permission and user-input events must distinguish waiting from running and completed states. Retries, timeout kinds, cancellation and session idle should remain explicit events rather than being flattened into a generic error.

## Boundaries

- `agent-contracts` defines the common event and usage envelope.
- `agent-tracing` owns event recording, redaction, payload bounds, sequence assignment, storage and queries.
- `agent-context-explorer` adapts, normalizes, correlates, compares and renders captured data.
- Host applications own provider instrumentation, authorization, data classification, retention and business audit.

The explorer does not depend on a particular SDK or trace backend. It does not duplicate the recorder's persistence responsibilities or claim that an operational trace proves business authorization or external side-effect completion.

## Consequences

Existing ContextSession callers remain source-compatible where fields were optional. The richer model can display saga runtime details without forcing every provider to implement every field. Applications can incrementally adopt the adapter while retaining provider-specific data.

A trace with missing or bounded payloads remains useful for lifecycle diagnosis, but the UI and documentation must not present it as a fully reconstructable context. Reproducibility requires the host to preserve the actual content and its relevant revisions under an appropriate access and retention policy.
