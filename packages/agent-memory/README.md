# @saga/agent-memory

Provider-neutral memory contracts and deterministic working-memory helpers. The package does not bind to SQLite, vector stores, graph databases, or an Agent SDK.

## Memory layers

- **Episodic**: what happened in a specific interaction or execution.
- **Semantic**: reusable facts and concepts learned across experiences.
- **Procedural**: a useful method or heuristic for future tasks.

These semantic types are separate from the original record kind and the storage lifecycle. `candidate / confirmed / superseded` is a host-owned status; a model suggestion cannot promote its own output to confirmed. A missing status on a legacy record remains unclassified and must not be silently treated as confirmed.

## Consolidation contracts

`MemoryConsolidator` accepts raw records, existing memories and optional relationships, then returns schema-validated change proposals. Supported operations are add, update, merge, supersede and archive. The package validates proposal shape but does not call a model, decide whether evidence is sufficient, or commit changes.

The host must:
1. Resolve every referenced record and evidence source.
2. Check scope, provenance, conflicts and domain-specific validity.
3. Calibrate confidence and decide whether a candidate may become confirmed.
4. Commit the change and its relationships atomically where possible.
5. Keep original records and trace references available for later inspection.

## Relationships and provenance

Memory relationships support `supports`, `contradicts`, `derived_from`, `supersedes` and `related_to`. Use `sourceRefs` / `evidenceRefs` for stable references to trace events, tool results or stored artifacts. A reference convention such as `trace:<traceId>:event:<eventId>` is useful, but storage and resolution remain host-owned.

## Existing helpers

- `MemoryStore` and `MemoryArchiveStore` define persistence boundaries.
- Cursor pagination and archive summaries keep old records accessible.
- `buildWorkingMemory()` selects a bounded prompt-ready subset and excludes archived, superseded and expired records. Candidate records remain eligible unless the host filters them before calling the helper.
- `selectArchiveCandidates()` identifies old active records for host-managed archival.

The default working-memory budget is character-based, not a model token count. Hosts should use `@saga/agent-context` with their target model's tokenizer for final prompt assembly.

## Non-goals

No database implementation, vector search, graph engine, scheduler, model call, autonomous trust promotion, or application-specific retention policy is included.
