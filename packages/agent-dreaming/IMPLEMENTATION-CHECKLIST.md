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

- [x] Add KnowledgePage, KnowledgeLink and KnowledgePageVersion types owned by this package. (KnowledgeProposal is deferred until the page lifecycle is proven.)
- [x] Add SQLite tables, additive migration, FTS5 index and pre-update version snapshots for Knowledge pages and links.
- [ ] Implement model-proposed create, revise, merge, link, supersede and deprecate operations with scope / provenance validation and idempotency. (Base page save / revise and link persistence are implemented.)
- [x] Add scope-isolated Knowledge full-text search (FTS5 + CJK fallback) and bounded, scope-filtered link expansion (depth 0-2; 50-page hard cap).
- [x] Persist a bounded Memory Manifest for explicit instructions, important Memory and active Knowledge; source-table triggers mark it stale, reads rebuild only when dirty, and unchanged content keeps its version/hash.
- [ ] Connect model-proposed Knowledge create, revise, merge, link, supersede and deprecate operations to the Dreaming run.
- [ ] Add a bounded Knowledge Maintenance stage after Memory consolidation. Create pages only when multiple experiences or a durable research objective justify them.
- [ ] Re-check pages affected by contradictory, expired or superseding evidence.
- [x] Test page revision history, duplicate-save idempotency, CJK retrieval, cross-scope isolation, evidence provenance and relation integrity.

## P2 — Improve evidence discovery and feedback

- [ ] Allow a host-provided source adapter to search historical transcripts / traces when local Experience and Evidence search is insufficient.
- [ ] Keep retrieval orchestration, ranking, scope checks and evidence validation inside this package; adapters only fetch authorized source records.
- [x] Add memory context-use feedback linked to context ID, task ID, memory ID and exact revision. (Knowledge-page feedback follows with P1.)
- [ ] Use repeated usefulness / contradiction signals to prioritize re-review; never treat retrieval alone as positive feedback.
- [ ] Add bounded discovery triggers and a minimum new-signal threshold to avoid wasteful Dreaming runs.

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
