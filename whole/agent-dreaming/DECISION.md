# Decision: agent-dreaming is a self-contained Agent Memory system

- Status: Accepted
- Date: 2026-11-28
- Scope: `whole/agent-dreaming`

## Decision

`@saga/agent-dreaming` is an independent, self-contained package. It must not depend on, import, or require another internal `@saga/*` package to provide any part of its memory lifecycle.

**All core Agent Memory capabilities belong inside this package.** They are not delegated to sibling packages and must not be described in this package's API or integration instructions as requiring another internal package.

This includes:

1. Experience and source-evidence records, ingestion contracts, evidence resolution and historical evidence search.
2. Memory schema, lifecycle, provenance, authority, scope isolation, relationships, version history and feedback.
3. Knowledge pages, knowledge relationships, maintenance proposals, indexes, version history and knowledge retrieval.
4. Memory retrieval, full-text search, optional semantic/vector retrieval and relevance ranking.
5. Always-on memory manifest, task-aware Context selection, de-duplication, budgeting, rendering and omission diagnostics.
6. Dreaming prompts, model proposal parsing, validation, consolidation orchestration, automatic commit and recovery.
7. SQLite persistence, migrations, scheduling, worker leases, checkpoints and run ledger.
8. Built-in authorization policy primitives and explicit-user-instruction handling.

A consumer should be able to install and use `@saga/agent-dreaming` without installing or importing another `@saga/*` package.

## Dependency boundary

Allowed:

- Node.js built-in modules.
- Code and modules owned by this package.
- Optional third-party provider SDKs behind package-owned adapters, such as the existing Copilot SDK adapter.
- Optional third-party embedding runtimes behind the package-owned `EmbeddingProvider` contract.
- Host-provided implementations of package-owned source, persistence, identity and policy interfaces where an application-specific integration is necessary.

Not allowed:

- Runtime or type imports from `@saga/agent-memory`, `@saga/agent-knowledge`, `@saga/agent-context`, `@saga/agent-tracing`, `@saga/agent-contracts`, or any other internal package.
- Requiring a consumer to install another internal package to obtain Memory, Knowledge, Evidence Search, Context Assembly, persistence, scheduling or authorization functionality.
- Public APIs whose primary types are imported from another internal package.
- README examples or package-level design instructions that tell consumers to compose this package with a sibling package to complete the memory lifecycle.

Provider adapters are an intentional boundary: a model provider may be external, but memory semantics, retrieval, evidence validation, persistence and context construction are owned here.

## Internal architecture

Keep one package and one public API, with focused internal modules. Module boundaries are implementation organization, not separately installable packages.

The package owns these internal domains:

| Internal domain | Responsibility |
|---|---|
| Experience | Append-only records of meaningful interactions and task outcomes |
| Evidence | Immutable source material, provenance, resolution and search |
| Memory | Durable personal / agent memory, authority, lifecycle and relationships |
| Knowledge | Reusable topic pages, links, maintenance and indexes |
| Retrieval | FTS, optional embeddings, ranking and bounded graph expansion |
| Context | Always-on manifest, task-aware selection, budget and rendering |
| Dreaming | Replay, discovery, proposals, validation and consolidation |
| Feedback | Retrieval outcomes, evidence support, corrections and task feedback |
| Persistence | SQLite schema, migrations, transactions, history and idempotency |
| Runtime | Provider adapters and structured model generation |
| Operations | Scheduler, worker, leases, checkpoints and run tracking |
| Authorization | Scope boundaries, authenticated actor policy and explicit directives |

The default local implementation remains SQLite. The package may expose repository interfaces for alternate storage, but the built-in store must continue to provide a complete usable implementation.

## Data ownership and boundaries

- A `scope` is a stable owner/isolation boundary. Personal memory uses the same owner scope across applications, providers, devices and conversations.
- `origin` records where information came from; it is provenance, not a scope boundary.
- Project, task and domain applicability must be represented as metadata or explicit relations. Do not fragment one person's memory by creating a new scope for each application, session or project.
- Experience and Evidence remain inspectable. Derived Memory and Knowledge must retain source references.
- User-explicit instructions outrank derived memories and cannot be changed by model inference.
- Model proposals are untrusted. The engine validates scope, targets, evidence, relationship endpoints and operation semantics before committing.
- Context assembly is not authorization. Only host-authorized source records may enter the package; the package must preserve scope isolation at every retrieval and persistence boundary.

## Context policy

The package must distinguish the amount of data it retains from the amount of data it injects.

- Maintain a bounded, generated Memory Manifest as the always-on entry point.
- Retrieve task-relevant Memory, Knowledge and recent Experience on demand.
- Load full source Evidence only when required; default context carries concise content and source references.
- Enforce an explicit context budget and return included IDs, omitted IDs, omission reasons, source references, versions and overflow diagnostics.
- Do not inject the entire memory database or all knowledge pages into each Agent request.
- The package returns prompt-ready context; it does not need to own the host application's interactive Agent conversation loop.

## Provider and host boundary

The package owns all memory behavior, but it does not become an identity provider or a universal Agent runtime.

- The host authenticates the user and supplies a trusted, stable scope and authorized source records.
- Source adapters may expose application-specific historical records through package-owned interfaces. Search orchestration, ranking, evidence validation and consolidation remain inside this package.
- A `DreamingRuntime` generates structured proposals. Provider-specific authentication and session lifecycle remain in its adapter.
- The Copilot adapter may remain an optional peer integration. Core storage, retrieval, Knowledge Maintenance and Context Assembly must not require Copilot.
- A custom runtime or storage implementation is allowed, but no core capability may disappear when one is replaced.

## Consequences

Positive:

- One installable package provides the complete memory lifecycle.
- No duplicated Memory / Knowledge / Context schema translation across internal packages.
- Consumers have one clear persistence, retrieval, authorization and operational boundary.
- The package can evolve its internal modules without coordinating breaking releases across sibling packages.

Trade-offs:

- The package contains more internal code. Keep modules focused and avoid turning the public API into a large framework.
- Some source systems and model providers still require adapters. Adapters connect external systems; they do not own the memory lifecycle.
- Existing sibling packages may continue to exist for other consumers, but `agent-dreaming` must not depend on them or require them.

## Implementation rule

Before merging a new capability, verify:

1. Its core types and implementation live under `whole/agent-dreaming`.
2. Its default persistence and tests are included in this package.
3. No internal `@saga/*` dependency or import is added.
4. The package can be packed and installed in an isolated consumer.
5. The complete lifecycle works with the built-in SQLite store and a configured runtime.

This decision supersedes any package-level wording that suggests Memory, Knowledge, Context, tracing or another internal package is required to complete `agent-dreaming`.
