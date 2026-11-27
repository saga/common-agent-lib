# ADR 0016: Build an independent Agent Dreaming package with Copilot as the default adapter

- Status: Accepted
- Date: 2026-11-26

## Context

The memory model defines durable records, relationships, consolidation proposals and working-memory selection, but it does not run the background consolidation lifecycle. Hosts should not each have to reimplement scheduling, replay, evidence resolution, review queues, checkpoints, leases and run tracking.

Binding the core engine to an Agent runtime package would couple storage and memory semantics to one provider's session model. At the same time, leaving every provider integration to each host makes the default path unnecessarily hard to use.

## Decision

Keep the Dreaming engine independent of Agent runtime packages and make the Copilot SDK the built-in default model adapter.

- `DreamingEngine` owns bounded replay, context assembly, schema validation, automatic proposal application, checkpoints, lease renewal and run state.
- `CopilotDreamingRuntime` calls `@microsoft/copilot-sdk` directly. It uses an isolated short-lived session, structured JSON output and an empty tool surface by default. The SDK is an optional peer dependency; the core package still works with any `DreamingRuntime`.
- Other model providers integrate by implementing the small `DreamingRuntime.generate()` contract. Provider adapters are the only model-runtime boundary; the package has no dependency on another internal `@saga/*` package.
- `SqliteDreamingStore` provides a built-in local implementation of experiences, memories, relationships, evidence, feedback, checkpoints, runs, review proposals, leases and memory history. Hosts can replace it with a transactional database implementation.
- Separate modules own types, prompts, parsing, quality evaluation, engine orchestration and each SQLite concern.

## Dreaming lifecycle

1. Load new and review-due experiences for one scope.
2. Select memories linked to the batch's source references, then prioritize expired, stale and important memories within the configured bound.
3. Load relevant relationships and resolve original source evidence.
4. Ask the configured runtime for structured proposals and IDs actually reviewed.
5. Validate scope, known targets, evidence provenance, relationship endpoints and quality assessment.
6. Apply every scope- and provenance-valid proposal automatically. New or uncertain memories remain `candidate`; candidate is not a request for human approval.
7. Preserve the previous memory snapshot before update, merge, supersede or archive.
8. Persist reviewed timestamps, run state and only the contiguous processed checkpoint. The default lifecycle never stages proposals for human review.

The engine supports startup, periodic, manual and record-appended triggers. The process-local timer is not a durable queue; production systems that require guaranteed scheduling should use an external worker or scheduler.

## Trust and operational boundaries

The model proposes changes, while the engine validates and applies them automatically. Candidate records remain eligible for recall and future consolidation; they do not wait for a reviewer.

A direct user message can express an explicit memory instruction. The host passes only authenticated user-authored messages to `DreamingEngine.applyUserMessage()`. Recognized `remember` and `avoid` instructions are persisted immediately as confirmed memories with `authority=user-explicit`, without a model call or review step. Passwords and authentication secrets are not stored. Explicit memories are recalled ahead of derived memories and cannot be changed by model-derived proposals. A later direct user instruction is the only path that can change this authority level.

The host remains responsible for authentication, mapping the user to a stable scope, source authorization and application-specific retention policy. The package owns its built-in evidence search, full-text / optional vector retrieval, knowledge maintenance and context assembly. These application trust boundaries are not approval gates in the Dreaming lifecycle.

SQLite enforces scope separation, atomic review transactions, proposal idempotency, lease ownership and version history for local single-host use. Multi-host deployments need a transactional shared repository and distributed lease implementation. The host must keep source evidence available for later inspection.

## Consequences

- The default integration path uses the Copilot SDK without importing an Agent runtime wrapper.
- Other model providers can reuse the same orchestration and persistence contracts.
- Local installations can run without a separate database service.
- The package owns the complete local memory lifecycle, including full-text and optional semantic retrieval, Knowledge Maintenance, context selection and context budgeting.
- The package has built-in SQLite scheduling, persistence and authorization primitives; hosts still authenticate users and authorize the source records supplied to it.
- Provider and source adapters may connect external systems, but they do not delegate Memory, Knowledge, Evidence, Retrieval or Context behavior to another internal package.


## Person-centric memory semantics

The memory owner and the source application are different concepts.

- A `scope` is a stable owner/isolation boundary. For personal memory, the host derives it from the authenticated person and reuses it across applications, providers, devices and conversations.
- An application, website, model provider or session must not become its own personal-memory scope. This would fragment one person's history and prevent cross-source consolidation.
- Experiences and evidence carry optional `origin` provenance (system, application, channel and source record ID). Origin helps attribute and inspect evidence; it does not identify the memory owner or partition retrieval.
- Memories carry an optional `memoryType` to distinguish facts, preferences, goals, constraints, knowledge, recurring behavior and ongoing context. It is descriptive metadata, not a trust level.
- Dreaming compares observations across origins but must preserve context, distinguish one-off actions from repeated patterns, and avoid turning project-specific preferences into global traits.
- Different owner scopes remain strictly isolated. Cross-source consolidation is allowed only after the host has authenticated and authorized the source records for that owner.

The new fields are optional. SQLite adds them through an additive schema migration so existing experiences, evidence and memories remain readable.


## 2026-11-27 amendment: automatic memory maintenance and explicit user authority

The previous review-gated mutation flow is replaced by an automatic lifecycle.

- Valid additions, updates, merges, supersedes and archives are committed automatically after scope, target and evidence validation. Mutations retain version history. Invalid proposals are rejected; uncertain additions may remain candidates without being queued for human approval.
- The engine no longer calls `stageProposal()` during normal runs. The review queue and authorized review facade remain only for compatibility with earlier integrations and already-staged records.
- Memory records carry an `authority` field: `derived` or `user-explicit`. User-explicit records have the highest precedence, are prioritized during recall and are protected from model-derived mutation.
- `detectUserMemoryDirective()` recognizes direct remember/avoid phrasing. The host calls `DreamingEngine.applyUserMessage()` only for a message authored by the authenticated memory owner. The SQLite implementation writes the directive and immutable source evidence immediately, with idempotency by source message ID.
- Explicit instructions bypass model generation, quality gates and review queues. Ordinary model inference cannot overwrite them; a subsequent direct user instruction can add or update user-explicit memory.
- SQLite schema version 4 adds memory authority and a durable user-directive ledger with an additive migration. Existing records default to `derived`.

This amendment removes human approval from the normal memory lifecycle without removing authentication, provenance validation, scope isolation or version history.


## 2026-11-28 amendment: self-contained Agent Memory package

The package-level decision in [packages/agent-dreaming/DECISION.md](../../packages/agent-dreaming/DECISION.md) makes `@saga/agent-dreaming` the single installable owner of the complete Agent Memory lifecycle.

- Memory, Knowledge, Evidence Search, Retrieval, Context Assembly, feedback, persistence, scheduling and authorization primitives are implemented inside this package.
- No other internal `@saga/*` package is a runtime or type dependency.
- The package owns Knowledge pages, relationships, maintenance proposals and history; it also owns the always-on Memory Manifest and task-aware Context Builder.
- The package may expose adapter contracts for host-specific source ingestion and alternate providers. Adapters do not move core memory behavior outside the package.
- Existing sibling packages may remain useful independently, but they are not part of the `agent-dreaming` installation or execution path.

This amendment supersedes earlier wording that assigned semantic retrieval or context assembly to the host or another package.
