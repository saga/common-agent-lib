# ADR 0016: Build an independent Agent Dreaming package with Copilot as the default adapter

- Status: Accepted
- Date: 2026-11-26

## Context

The memory model defines durable records, relationships, consolidation proposals and working-memory selection, but it does not run the background consolidation lifecycle. Hosts should not each have to reimplement scheduling, replay, evidence resolution, review queues, checkpoints, leases and run tracking.

Binding the core engine to an Agent runtime package would couple storage and memory semantics to one provider's session model. At the same time, leaving every provider integration to each host makes the default path unnecessarily hard to use.

## Decision

Keep the Dreaming engine independent of Agent runtime packages and make the Copilot SDK the built-in default model adapter.

- `DreamingEngine` owns bounded replay, context assembly, schema validation, quality gates, candidate handling, checkpoints, lease renewal and run state.
- `CopilotDreamingRuntime` calls `@microsoft/copilot-sdk` directly. It uses an isolated short-lived session, structured JSON output and an empty tool surface by default. The SDK is an optional peer dependency; the core package still works with any `DreamingRuntime`.
- CodeBuddy, pi.dev, DeepAgents and other providers integrate by implementing the small `DreamingRuntime.generate()` contract. The package does not depend on `@saga/copilot-agent-runtime`, `@saga/codebuddy-agent-runtime` or another orchestration runtime.
- `SqliteDreamingStore` provides a built-in local implementation of experiences, memories, relationships, evidence, feedback, checkpoints, runs, review proposals, leases and memory history. Hosts can replace it with a transactional database implementation.
- Separate modules own types, prompts, parsing, quality evaluation, engine orchestration and each SQLite concern.

## Dreaming lifecycle

1. Load new and review-due experiences for one scope.
2. Select memories linked to the batch's source references, then prioritize expired, stale and important memories within the configured bound.
3. Load relevant relationships and resolve original source evidence.
4. Ask the configured runtime for structured proposals and IDs actually reviewed.
5. Validate scope, known targets, evidence provenance, relationship endpoints and quality assessment.
6. Commit only eligible new memories as `candidate`; stage all mutations and uncertain proposals for explicit review.
7. Preserve the previous memory snapshot before update, merge, supersede or archive.
8. Persist review timestamps, run state and only the contiguous processed checkpoint.

The engine supports startup, periodic, manual and record-appended triggers. The process-local timer is not a durable queue; production systems that require guaranteed scheduling should use an external worker or scheduler.

## Trust and operational boundaries

The model only proposes changes. It cannot directly write durable memory, promote a candidate to confirmed or author feedback that claims a human decision.

The host authenticates users and authorizes scopes and reviewers. It remains responsible for domain validation, candidate promotion, retention policy and any semantic/vector ranking. Review approval is an application action, not a model tool.

SQLite enforces scope separation, atomic review transactions, proposal idempotency, lease ownership and version history for local single-host use. Multi-host deployments need a transactional shared repository and distributed lease implementation. The host must keep source evidence available for later inspection.

## Consequences

- The default integration path uses the Copilot SDK without importing an Agent runtime wrapper.
- Other model providers can reuse the same orchestration and persistence contracts.
- Local installations can run without a separate database service.
- The package does not attempt to become a vector store, full memory retrieval framework, durable job scheduler or authorization system.
- SQLite ranking uses source-reference overlap, staleness and importance. Hosts can implement semantic retrieval through their own repository.
