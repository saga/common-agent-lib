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
  scopes: ['person:opaque-user-id'],
  intervalMs: 15 * 60_000,
});

await store.putEvidence('person:opaque-user-id', {
  ref: 'note:1',
  kind: 'note',
  content: 'Original source text',
  origin: { system: 'copilot', application: 'assistant-ui', channel: 'conversation' },
});
await store.appendExperience({
  id: 'experience:1',
  scope: 'person:opaque-user-id',
  content: 'A meaningful interaction or task outcome',
  createdAt: new Date().toISOString(),
  sourceRefs: ['note:1'],
  origin: { system: 'copilot', application: 'assistant-ui', channel: 'conversation' },
});

dreaming.start();
await dreaming.runNow('person:opaque-user-id');
await dreaming.shutdown(); // Stops the engine, Copilot client and SQLite store.
```

The `createSqliteCopilotDreaming()` factory composes the engine, SQLite store, Copilot adapter and durable SQLite worker. Its `start()` method schedules recurring jobs in the database; it does not rely on the engine's in-process interval. Use `createCopilotDreaming(repository, evidenceResolver, options)` when persistence is supplied separately, or construct `DreamingEngine` and a custom `DreamingRuntime` yourself.

The adapter uses `@microsoft/copilot-sdk` directly. It creates a short-lived, isolated session for each generation call and defaults to the SDK's `empty` mode, so Dreaming receives supplied experiences and evidence but has no tool access by default. The SDK client is reused; conversation history is not. Each temporary session is deleted after the response so Copilot session files do not accumulate. Structured output is requested with a JSON Schema and validated again by the Dreaming engine.

The Copilot SDK is an optional peer dependency. The core package can be installed and used with a custom runtime without installing Copilot. The adapter does not depend on `@saga/copilot-agent-runtime`.

## Other model runtimes

Implement the small `DreamingRuntime.generate()` contract to connect CodeBuddy, pi.dev, DeepAgents, or another provider. The core package does not depend on their session APIs or lifecycle. Provider-specific authentication, model selection and retry policy belong in the adapter.

## What Dreaming does

1. Loads new experiences and experiences due for re-review.
2. Selects memories through local vector similarity and source-reference overlap, while prioritizing stale and expired memories.
3. Loads related memory edges and resolves original evidence.
4. Sends a bounded, structured task to the configured runtime.
5. Validates scope, targets, provenance, relationships and quality assessment.
6. Commits only provenance-backed, quality-gated new memories as `candidate`; other changes enter the durable review queue.
7. Records reviewed IDs, run outcomes and a contiguous checkpoint.

For personal memory, `scope` is the stable identity of the memory owner, normally derived from the authenticated person. Use that same scope for authorized records from ChatGPT, Claude, Copilot, browsers and other sources. Do not create a new scope for each application, provider, device, project or conversation. Put source attribution in `origin`; it is not a memory boundary.

Memories may carry a `memoryType`: `fact`, `preference`, `goal`, `constraint`, `knowledge`, `behavior-pattern` or `ongoing-context`. This helps hosts inspect and retrieve personal memories without treating a single observation as a permanent personality trait. Existing records without a type remain supported.

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

The host authenticates users and supplies a trusted subject identity. For personal memory, map that identity to one stable scope across integrations; never trust an origin field to identify the owner. The package applies configured scope grants and review permissions through its authorization policy. Candidate promotion remains quality-gated; changing a confirmed memory requires an authorized review decision. Do not expose persistence methods directly as untrusted model tools.

The built-in memory ranking uses a persisted SQLite vector index with cosine similarity, source-reference overlap, stale/expiry status and importance. The default local embedding provider uses optional Transformers.js with a multilingual MiniLM model; install @huggingface/transformers to enable local semantic embeddings. Without that optional package, Dreaming falls back to source-reference and recency ranking. Supply a custom EmbeddingProvider or MemoryRetriever to override the default. Embeddings are cached by content hash and isolated by scope and provider ID.

The package includes `SqliteDreamingScheduler` and `DreamingWorker`. Jobs, recurring intervals, attempts and claim leases are persisted in SQLite. Expired claims are recovered after process crashes; workers renew leases during long runs, retry failures with bounded exponential backoff and expose exhausted jobs for manual retry. `DreamingEngine.start()` remains a convenience process-local trigger; use the durable worker for restart-safe scheduling.

## Built-in authorization and review

The package exports RoleBasedDreamingAuthorization, DenyAllDreamingAuthorization and AuthorizedDreamingReviewQueue. The role policy is default-deny and grants permissions by authenticated subject and scope. Review reads and approve/reject operations go through the authorized facade, which checks permissions before touching the underlying durable queue. Authentication and trusted subject identification remain the host's responsibility; caller-provided role claims are not permission grants. Use a custom DreamingAuthorizationPolicy to integrate an existing IAM or policy engine.
