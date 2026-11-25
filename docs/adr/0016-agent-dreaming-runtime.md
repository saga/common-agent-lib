# ADR 0016: Add a runtime-neutral Agent Dreaming package

- Status: Accepted
- Date: 2026-11-25

## Context

The existing agent-memory package defines records, relationships, consolidation proposals and working-memory helpers, but does not execute background consolidation. Requiring each host application to implement replay, scheduling, checkpoints and run tracking duplicates operational logic. Binding this behavior to Copilot or CodeBuddy would prevent other runtimes from using it.

## Decision

Add `@saga/agent-dreaming` as a separate package. The package owns a bounded background execution loop and exposes three host boundaries:

1. `DreamingRuntime`: one structured generation call, implemented by Copilot SDK, CodeBuddy SDK, pi.dev or another runtime.
2. `DreamingRepository`: durable experience/memory access, run/checkpoint persistence, per-scope lease and atomic idempotent proposal commit.
3. `DreamingEvidenceResolver`: resolves original evidence referenced by experiences and memories.

Calling `start()` performs startup dreaming and schedules periodic runs. Hosts can trigger an immediate run after persisting a meaningful experience. The engine replays new and review-due experiences, validates structured proposals and advances only contiguous processed checkpoints.

## Trust and operational boundaries

The host remains authoritative for storage, authorization, domain validation, confidence calibration, memory promotion, indexes and retention. The model cannot commit directly or promote a memory to confirmed. Multi-process hosts must implement owner-checked durable lease acquire/renew/release and idempotent commits. The package does not import a provider SDK, database, queue or graph engine.

## Consequences

- Multiple runtimes can drive the same Dreaming workflow without provider coupling.
- Hosts implement persistence and policy once, against explicit interfaces.
- Background work is recoverable across restarts when the repository persists runs and checkpoints.
- The timer is process-local; deployments requiring guaranteed scheduled execution must run the engine in a durable worker/service and implement repository leases.
