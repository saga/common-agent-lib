# Agent Dreaming implementation checklist

- Decision: `@saga/agent-dreaming` is self-contained; no other internal `@saga/*` package may be required.
- Source of truth: [DECISION.md](./DECISION.md) and [ARCHITECTURE-ANALYSIS.md](./ARCHITECTURE-ANALYSIS.md).
- Status reflects code in this package, not design intent.

## P0 — Complete the first usable memory-to-context loop

- [x] Add package-owned SQLite full-text search for Memory, Experience and Evidence.
- [x] Support CJK substring matching in addition to FTS5 token search.
- [x] Enforce scope and lifecycle filters in every search path; exclude candidate, expired, superseded and archived memories from normal context.
- [x] Add package-owned task-aware Context Builder with always-on explicit memory, task-relevant memory, experience and source evidence.
- [x] Enforce context item and character/token budgets; preserve explicit user instructions and report overflow.
- [x] Return included/omitted IDs, omission reasons, source references, revisions and a stable context hash.
- [x] Add tests for CJK retrieval, scope isolation, explicit memory priority, lifecycle filtering and budget overflow.
- [ ] Add host-facing examples showing how to append the returned context to an Agent request.
- [ ] Record ContextBuild / ContextUse feedback so later Dreaming can evaluate the exact memory revisions used by a task.

## P1 — Knowledge maintenance (next major capability)

- [ ] Add KnowledgePage, KnowledgeLink, KnowledgeProposal and KnowledgeVersion types owned by this package.
- [ ] Add SQLite tables, additive migrations, FTS index and version snapshots for Knowledge.
- [ ] Implement create, revise, merge, link, supersede and deprecate operations with scope / provenance validation and idempotency.
- [ ] Add Knowledge retrieval with bounded link expansion; do not require an external graph database.
- [ ] Add a bounded Knowledge Maintenance stage after Memory consolidation. Create pages only when multiple experiences or a durable research objective justify them.
- [ ] Re-check pages affected by contradictory, expired or superseding evidence.
- [ ] Test duplicate topic prevention, cross-scope isolation, provenance validation, relation integrity and version restoration.

## P2 — Improve evidence discovery and feedback

- [ ] Allow a host-provided source adapter to search historical transcripts / traces when local Experience and Evidence search is insufficient.
- [ ] Keep retrieval orchestration, ranking, scope checks and evidence validation inside this package; adapters only fetch authorized source records.
- [ ] Add context-use feedback linked to context ID, task ID, memory/page ID and exact revision.
- [ ] Use repeated usefulness / contradiction signals to prioritize re-review; never treat retrieval alone as positive feedback.
- [ ] Add bounded discovery triggers and a minimum new-signal threshold to avoid wasteful Dreaming runs.

## P3 — Hardening and evaluation

- [ ] Add end-to-end evaluation scenarios for personal memory, project memory, knowledge maintenance and context injection.
- [ ] Add benchmarks for FTS / CJK search and large per-scope memory collections.
- [ ] Verify npm pack contains the package decision, design and usage docs.
- [ ] Run package build, typecheck, full test suite and isolated-consumer package test.

## Implementation notes

- The built-in default remains SQLite. FTS5 is part of the SQLite capability used by the supported Node runtime.
- Token budgets use an injected tokenizer when supplied. Without one, the built-in estimator is explicitly marked as approximate.
- Explicit user memories are required context items. If they exceed the available budget, they remain included and the result reports overflow instead of silently discarding them.
- Candidate memories are available to the consolidation engine but are not eligible for normal Agent context.
- Knowledge pages are not generated from one-off events; page creation is value-gated.
