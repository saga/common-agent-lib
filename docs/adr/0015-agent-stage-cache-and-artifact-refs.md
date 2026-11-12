# ADR 0015: Agent Stage Cache and Execution Artifact References

- Status: Accepted
- Date: 2026-11-12
- Context: extraction from the production-shaped multi-stage pipeline in devweekly/tools/novel-generation

## Context

The novel-generation pipeline exposed two recurring infrastructure needs that were implemented locally:

1. Reuse a completed stage only when its complete input fingerprint and output bytes still match, and the output still passes the current semantic validator.
2. Preserve exact prompts, responses, partial responses and source snapshots as durable files, while allowing a trace to point to those files without embedding large payloads in the event ledger.

These are useful beyond novel generation. Research synthesis, document processing, code analysis and other long-running agent workflows have the same basic requirements.

## Decision

Add two small, separate capabilities:

- @saga/agent-stage-cache owns deterministic file-backed stage caching, atomic writes, per-stage concurrency control, manifest serialization and cache diagnostics.
- @saga/agent-contracts defines AgentArtifactRef, and @saga/agent-tracing stores artifact references on AgentEvent and persists them in a dedicated SQLite column.

The stage cache accepts a caller-provided fingerprint and semantic validator. It does not inspect prompts, call models, decide workflow order, perform retries, update business state, authorize users or execute external side effects.

Artifact references describe separately stored content. They do not define an artifact backend, access control, encryption, retention or a business audit system.

## Compatibility and failure behavior

- The stage manifest remains version 1 and uses SHA-256 for fingerprint and output integrity.
- Existing trace databases receive artifact_refs_json through an additive ALTER TABLE migration; prior rows resolve to an empty artifact reference list.
- Trace payloads remain separate from artifact content. Artifact reference metadata is recursively redacted by the recorder.
- A failed or incomplete stage never creates a successful cache entry.
- A cache hit is accepted only after the caller's current validator succeeds.
- Per-stage locks serialize duplicate local execution. Manifest updates have a separate lock so distinct stages can finish concurrently.
- Filesystem locks are not a distributed scheduler or cross-region lease service. A database-backed durable execution system remains appropriate for multi-host workflows.

## Adoption

The first consumer considered is tools/novel-generation. It currently has a local stage-cache adapter and a durable file trace layout. The generic cache can replace only the generic execute/cache/checksum portion; Story State snapshots, run-directory identity, model-specific retry behavior, novel context selection and literary pipeline logic remain in that application.

The new workspace package is not yet published to npm. Until a release exists, consumers must not add an unresolved registry dependency. The application migration should happen after package publication or an explicit workspace/vendor integration is established. This avoids breaking local builds while the shared package is being contributed.

## Rejected alternatives

- A generic Workflow Engine: stage caching does not need workflow definitions or orchestration.
- A second Agent Runtime: model SDK lifecycle and retry behavior remain in provider-specific runtime adapters.
- Store all prompts and responses in SQLite trace rows: large payloads need separate retention, permission and storage treatment.
- Make Artifact Store a common implementation now: storage backends and URI authorization differ between local-first and hosted applications.

## Consequences

The library provides reusable, testable primitives without moving domain policies out of their applications. Consumers must provide comprehensive fingerprints and validators; missing inputs can otherwise cause incorrect cache reuse. Applications must also protect artifact locations and decide which content may be retained.
