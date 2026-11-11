# Agent Memory Consolidation: design and integration

## Decision

Extend the existing memory, knowledge and context packages with provider-neutral contracts. Do not add an agent-memory runtime, database, scheduler, graph engine or model dependency.

The design follows the useful separation described in [Anthropic's components of agent memory](https://www.anthropic.com/research/components-of-agent-memory), while keeping all authority and domain decisions in the host application.

## Four cooperating layers

1. **Execution history** — `@saga/agent-tracing` records bounded, redacted events. Large payloads remain in host-controlled artifact storage. Memory source references may point to trace/event/artifact IDs.
2. **Memory notes** — `@saga/agent-memory` distinguishes episodic, semantic and procedural memories; tracks candidate/confirmed/superseded status, calibrated confidence, validation time and explicit relationships.
3. **Knowledge representations** — `@saga/agent-knowledge` models durable entries and relationships such as supports, contradicts, derived_from and supersedes.
4. **Injected context** — `@saga/agent-context` assembles host-selected candidates under a deterministic budget while retaining provenance and descriptive freshness metadata.

## Dreaming / consolidation flow

```text
Trace events + stored artifacts
          |
          v
Host selects eligible records and evidence
          |
          v
MemoryConsolidator / Knowledge maintenance proposer
          |
          v
Schema-validated change proposals
          |
          v
Host validates scope, references, conflicts and evidence
          |
          v
Host commits records / relationships / archive updates
          |
          v
Host refreshes indexes and next-task retrieval
          |
          v
agent-context assembles selected context
```

This flow may run after a task, periodically, or when memory volume crosses a threshold. Scheduling and model calls are host responsibilities.

## Trust and update rules

- A model-produced proposal is not an authoritative state change.
- The host resolves every target ID and evidence reference before applying a proposal.
- Confidence and confirmed status are calibrated by host-owned rules; do not trust self-reported confidence.
- Contradictions remain explicit relationships until a domain-aware resolver handles them.
- Updates and supersessions preserve prior records and provenance; do not destructively rewrite the only copy.
- Context assembly never decides whether an item is current, authorized or true. The host filters candidates and assigns priorities before calling it.

## Compatibility and migration

New semantic fields are optional or defaulted. Existing record kinds, storage lifecycle, KnowledgeEntry shape and ContextItem behavior remain usable. Existing stores can ignore relationships until an application chooses to persist them.

Suggested adoption order:
1. Start writing sourceRefs from memory/knowledge records to trace events or artifacts.
2. Add candidate memories from task outcomes; keep them out of confirmed-only context until validated.
3. Run consolidation on a bounded recent-record window and persist proposals for inspection.
4. Apply validated proposals and refresh the host's search index.
5. Use `agent-context` to budget recent memory, durable memory, knowledge and current task evidence.

## Non-goals

No autonomous memory agent, hidden reasoning capture, default full-prompt retention, graph database, vector database, universal scoring formula, automatic trust promotion or domain-specific retention policy.
