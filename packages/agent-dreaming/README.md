# @saga/agent-dreaming

Background memory consolidation for Node.js 24.15+. The package owns the Dreaming loop, durable local storage, evidence lookup, review workflow and run history. It does not depend on an Agent runtime package.

## Default runtime: Copilot SDK

Install the SDK when using the built-in adapter:

```sh
npm install @saga/agent-dreaming @microsoft/copilot-sdk
```

```ts
import {
  createSqliteCopilotDreaming,
  SqliteDreamingStore,
} from '@saga/agent-dreaming';

const store = new SqliteDreamingStore({ filename: './data/dreaming.sqlite' });
const dreaming = createSqliteCopilotDreaming(store, {
  scopes: ['user:1'],
  intervalMs: 15 * 60_000,
});

await store.putEvidence('user:1', {
  ref: 'note:1',
  kind: 'note',
  content: 'Original source text',
});
await store.appendExperience({
  id: 'experience:1',
  scope: 'user:1',
  content: 'A meaningful interaction or task outcome',
  createdAt: new Date().toISOString(),
  sourceRefs: ['note:1'],
});

dreaming.start();
await dreaming.runNow('user:1');
await dreaming.shutdown(); // Stops the engine, Copilot client and SQLite store.
```

The `createSqliteCopilotDreaming()` factory composes the engine, SQLite store and Copilot adapter. Use `createCopilotDreaming(repository, evidenceResolver, options)` when persistence is supplied separately, or construct `DreamingEngine` and a custom `DreamingRuntime` yourself.

The adapter uses `@microsoft/copilot-sdk` directly. It creates a short-lived, isolated session for each generation call and defaults to the SDK's `empty` mode, so Dreaming receives supplied experiences and evidence but has no tool access by default. The SDK client is reused; conversation history is not. Structured output is requested with a JSON Schema and validated again by the Dreaming engine.

The Copilot SDK is an optional peer dependency. The core package can be installed and used with a custom runtime without installing Copilot. The adapter does not depend on `@saga/copilot-agent-runtime`.

## Other model runtimes

Implement the small `DreamingRuntime.generate()` contract to connect CodeBuddy, pi.dev, DeepAgents, or another provider. The core package does not depend on their session APIs or lifecycle. Provider-specific authentication, model selection and retry policy belong in the adapter.

## What Dreaming does

1. Loads new experiences and experiences due for re-review.
2. Selects memories linked by source references, then includes stale, expired and important memories within the configured limit.
3. Loads related memory edges and resolves original evidence.
4. Sends a bounded, structured task to the configured runtime.
5. Validates scope, targets, provenance, relationships and quality assessment.
6. Commits only provenance-backed, quality-gated new memories as `candidate`; other changes enter the durable review queue.
7. Records reviewed IDs, run outcomes and a contiguous checkpoint.

Dreaming does not decide that a memory is trusted. Updates, merges, supersedes and archives require explicit review. Prior memory snapshots are retained before mutations.

## Storage

`SqliteDreamingStore` implements:

- `DreamingRepository`: experiences, memories, relationships, checkpoints and run persistence.
- `DreamingEvidenceResolver`: scope-isolated local evidence lookup. Evidence refs are immutable; publish changed source content under a new versioned ref so earlier evidence remains available for review.
- `DreamingReviewQueue`: durable proposal review and explicit approve/reject.
- `DreamingRunStore`: query individual runs or bounded run history.
- `DreamingMemoryHistoryStore`: inspect snapshots preserved before memory changes.

SQLite uses Node's built-in `node:sqlite`; no native addon or third-party SQLite driver is required. WAL supports multiple local processes sharing a file, not multi-host distributed storage. Keep transactions short: model calls and external evidence access happen outside database transactions.

## Host responsibilities and boundaries

The host authenticates users, authorizes scope access and review decisions, and decides when a candidate may become confirmed. Do not expose database or review methods directly as untrusted model tools.

The built-in memory ranking uses source-reference overlap, stale/expiry status and importance. It does not include embeddings or vector search; a host can provide its own repository to add semantic retrieval or domain-specific ranking.

The timer is process-local. For guaranteed scheduling across restarts, run `DreamingEngine` from a durable worker or external scheduler and keep the repository lease enabled. The in-process timer is a trigger, not a durable queue.
