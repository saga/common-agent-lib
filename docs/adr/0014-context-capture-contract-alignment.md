# ADR 0014: Context Capture Contract Alignment with Saga Agent Runtimes

- Status: Accepted
- Date: 2026-11-10

## Context

The first Context Explorer model covered normalized provider exchanges and a generic session timeline. The other saga projects expose a richer runtime contract:

- Agentic Data Architect records turn lifecycle, model calls, tool progress/results, permissions, user-input waits, compaction, checkpoints, idle/error state and execution outcomes through TrajectoryEvent.
- Architecture Diagram Studio records the actual model selected by the runtime, per-call usage, context-window occupancy, latency and SDK lifecycle events. Its compact SDK event summaries are useful operational telemetry but are not full prompt captures.
- Vocal Saga's audit-ledger ADR requires preserving the actual model input/output and the revisions and source identifiers needed to explain how a result was produced. Hashes and summaries alone are insufficient for a full audit record.

A common viewer must accept all three styles without coupling itself to their SDKs, storage formats or business workflows. It must also avoid claiming replayability when the source did not capture the provider payload.

## Decision

### 1. Keep three layers separate

- Capture adapters translate provider/SDK/runtime records into the neutral ContextSession model.
- Context Explorer normalizes, correlates, compares and displays captured records.
- The host and \`@saga/agent-tracing\` own instrumentation, persistence, authorization, retention and business audit guarantees.

No provider SDK is required by the package. A provider is only the source of model exchanges; the Explorer itself does not call a model.

### 2. Preserve identity semantics

Keep the following identifiers distinct:

- \`sessionId\`: long-lived runtime conversation/session.
- \`traceId\`: distributed trace identity.
- \`turnId\`: one user/agent turn.
- \`requestId\`: host-side request identity.
- \`apiCallId\`, \`providerCallId\`, \`serviceRequestId\`: identifiers assigned by the API, provider or service.
- \`correlationId\`: a general-purpose correlation key when the source defines one.
- \`parentEventId\`, \`parentRunId\`, \`parentToolCallId\`: causal parent relationships.
- \`sequence\`: persisted event ordering within the source stream.

Adapters must not copy a turn ID into \`traceId\` or claim it is a true session ID. Agentic Data Architect's current TrajectoryEvent schema contains \`turnId\` but not \`sessionId\`; its adapter uses an explicitly synthetic \`trajectory:<turnId>\` session key unless a real session ID is supplied separately, and retains the source turn IDs in metadata.

### 3. Treat lifecycle events as first-class data

The neutral event model covers user input, turn and assistant-turn boundaries, model request/response, tool call/progress/result, permission request/completion, user-input request/completion, retry, compaction, context changes, checkpoint, stage gate, session idle/error and generic errors. Unknown source events remain \`custom\` with their original payload preserved.

Tool calls are correlated only by stable call IDs. Parent tool IDs, agent IDs, MCP server/tool names, progress, arguments, results and failure states are retained when present. Unmatched results remain visible as orphans; missing results remain pending.

### 4. Separate consumption from context occupancy

\`ModelCallUsage\` describes consumption for one provider call: input, uncached/new input, output, total, cached input, cache writes, reasoning, provider cost, Premium Request Cost/Nano AIU, duration, finish reason, reasoning effort, time-to-first-token and inter-token latency.

\`ContextUsage\` describes the context-window state at a point in time: current tokens, limit, message count and percentage.

All measurements are optional and retain their source. Missing values are not inferred from text length or estimated from model pricing. A usage total must not be confused with context-window occupancy.

### 5. Preserve provenance and payload completeness

A model exchange should retain the actual request after system/developer instructions, conversation history, retrieved memory, tool schemas and context-budget transformations have been applied, together with the actual response. Record provider/model identity, timing, usage, source/prompt/pipeline/configuration/memory revisions, input IDs and context hash when available.

\`payloadComplete\` is explicit. A runtime event stream that only contains compact summaries may still support lifecycle diagnosis, but it does not establish that the prompt or response can be reconstructed. Hashes, previews, character counts and truncated payloads do not substitute for the original content when full audit or replay is required.

### 6. Keep storage append-only at the host boundary

JSONL is a supported interchange shape, not a storage requirement. The host may use files, a database or an existing trace store. Events should be written in order with timestamps and stable sequence numbers. Persistence failures for required audit data must be returned to the caller; they must not be silently treated as successful writes.

### 7. Apply defensive data handling

The adapter applies default credential-shaped redaction. This is not a substitute for host-side data classification, authorization, encryption, retention or access auditing. Raw prompts, tool arguments/results and model responses can contain sensitive business data; hosts must decide whether and where they may be captured. Hidden reasoning must not be synthesized, and should only be recorded if explicitly returned by the provider and permitted by policy.

## Consequences

The package can consume shared saga trace envelopes and Agentic Data Architect trajectories while remaining provider-neutral. The same UI can distinguish incomplete operational traces from complete model exchanges and display richer runtime and usage data when available.

The package does not promise universal replay. Replayability depends on the host capturing the actual request, response, relevant tool inputs/results and context provenance. Existing compact event logs remain useful for diagnosis but are not promoted into fabricated ContextSnapshots.
