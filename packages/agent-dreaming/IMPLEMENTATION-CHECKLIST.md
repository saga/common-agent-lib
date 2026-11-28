# Agent Dreaming implementation checklist

- Decision: `@saga/agent-dreaming` is self-contained; no other internal `@saga/*` package may be required.
- Source of truth: [DECISION.md](./DECISION.md) and [ARCHITECTURE-ANALYSIS.md](./ARCHITECTURE-ANALYSIS.md).
- Status reflects code in this package, not design intent.

## P0 — Complete the first usable memory-to-context loop

- [x] Add package-owned SQLite full-text search for Memory, Experience and Evidence (FTS5 triggers use ordinary rowid deletion so updates remain compatible with SQLite's FTS5 implementation).
- [x] Support CJK substring matching in addition to FTS5 token search.
- [x] Enforce scope and lifecycle filters in every search path; exclude candidate, expired, superseded and archived memories from normal context.
- [x] Add package-owned task-aware Context Builder with always-on explicit memory, task-relevant memory, experience and source evidence.
- [x] Enforce context item and character/token budgets; preserve explicit user instructions and report overflow.
- [x] Return included/omitted IDs, omission reasons, source references, revisions and a stable context hash.
- [x] Add tests for CJK retrieval, scope isolation, explicit memory priority, lifecycle filtering and budget overflow.
- [x] Add host-facing examples showing how to append the returned context to an Agent request.
- [x] Record task outcome feedback against context ID, context hash and the exact included memory revision.

## P1 — Knowledge maintenance (next major capability)

- [x] Add KnowledgePage, KnowledgeLink, KnowledgePageVersion and structured KnowledgeProposal types owned by this package.
- [x] Add SQLite tables, additive migration, FTS5 index and pre-update version snapshots for Knowledge pages and links.
- [x] Implement model-proposed create, revise, merge, link, supersede and deprecate operations with structured-output validation, scope / provenance checks, transactional idempotency and immutable prior-page snapshots.
- [x] Add scope-isolated Knowledge full-text search (FTS5 + CJK fallback) and bounded, scope-filtered link expansion (depth 0-2; 50-page hard cap).
- [x] Persist a bounded Memory Manifest for explicit instructions, important Memory and active Knowledge; source-table triggers mark it stale, reads rebuild only when dirty, and unchanged content keeps its version/hash.
- [x] Connect model-proposed Knowledge create, revise, merge, link, supersede and deprecate operations to the Dreaming run.
- [x] Add a bounded Knowledge Maintenance stage to each eligible Dreaming batch. Supply at most 100 active pages / 200 active links and cap each model response at 30 Knowledge proposals.
- [x] Create pages only when the model identifies durable value; low-confidence creates/revisions/merges/supersedes become drafts and cannot mutate active pages.
- [x] Re-review active pages at a bounded 90-day default interval; changed pages reset their review timestamp.
- [x] Prioritize two or more negative feedback signals for the exact active page version; retain old-version feedback without treating it as current.
- [x] Bind Knowledge context-use feedback to context ID/hash and the exact page version, with scope and context-membership checks.
- [x] Demote a Knowledge page to draft if its cited Evidence is deleted.
- [ ] Add explicit Evidence expiry metadata and expiry-driven Knowledge demotion / revalidation.
- [x] Test page revision history, duplicate-save idempotency, CJK retrieval, cross-scope isolation, evidence provenance and relation integrity.
- [x] Test all six Knowledge lifecycle operations, proposal idempotency, low-confidence mutation safety and Dreaming Engine integration.

## P2 — Improve evidence discovery and feedback

- [x] Allow a host-provided history adapter to search historical transcripts / traces when local Memory / Experience / Knowledge / Evidence retrieval is insufficient; the package validates scope and Evidence refs, re-ranks locally and enforces hard result / context bounds.
- [x] Keep retrieval orchestration, ranking, scope checks and evidence validation inside this package; the host remains responsible for authenticating external source access.
- [x] Add memory and Knowledge context-use feedback linked to context ID, context hash, task ID, entity ID and exact revision.
- [x] Use repeated current-version negative usefulness / contradiction signals to prioritize Knowledge re-review; never treat retrieval alone as positive feedback.
- [x] Coalesce `record-appended` triggers until at least two unprocessed Experience records exist by default; allow a bounded 1-100 override.
- [x] Bound each run to at most 100 Experiences per batch and 10 batches; startup, interval and manual runs bypass the event-trigger threshold.

## P3 — Hardening and evaluation

- [ ] Add end-to-end evaluation scenarios for personal memory, project memory, knowledge maintenance and context injection.
- [ ] Add benchmarks for FTS / CJK search and large per-scope memory collections.
- [x] Verify npm pack contains the package decision, design, implementation checklist and usage docs.
- [x] Run package build, typecheck, full test suite and isolated-consumer package test (Node.js 24 and 26 CI).

## Implementation notes

- The built-in default remains SQLite. FTS5 is part of the SQLite capability used by the supported Node runtime.
- Token budgets use an injected tokenizer when supplied. Without one, the built-in estimator is explicitly marked as approximate.
- Explicit user memories are required context items. If they exceed the available budget, they remain included and the result reports overflow instead of silently discarding them.
- Candidate memories are available to the consolidation engine but are not eligible for normal Agent context.
- Knowledge pages are not generated from one-off events; page creation is value-gated.
