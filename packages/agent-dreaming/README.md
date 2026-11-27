# @saga/agent-dreaming

A self-contained Agent Memory package for Node.js 24.15+. The package boundary and accepted architecture put the complete lifecycle here: experiences, evidence, durable memory, knowledge maintenance, retrieval, context assembly, feedback, scheduling, persistence and run history. It has no dependency on another internal `@saga/*` package.

## Search and task-aware context

The SQLite store includes scope-isolated FTS5 search for durable memories, experiences and original evidence. Chinese/CJK queries also use a bounded substring fallback because the default SQLite tokenizer does not segment CJK text like an English tokenizer.

```ts
const hits = await store.search({
  scope: 'person:opaque-user-id',
  query: 'architecture recovery and idempotent writes',
  sourceTypes: ['memory', 'experience', 'evidence'],
  limit: 20,
});

const context = await store.buildContext({
  scope: 'person:opaque-user-id',
  task: 'Review the recovery design for the payment service',
  budget: { maxUnits: 12_000, unit: 'tokens', reservedUnits: 2_000 },
});

// Inject context.text into the next Agent request. Record feedback only after
// the task outcome is known, using the exact context object that was injected.
await store.recordContextFeedback({
  id: 'feedback:task-123:memory-1',
  context,
  memoryId: context.items.find((item) => item.sourceType === 'memory')!.id,
  taskId: 'task:123',
  outcome: 'useful',
});
```

Candidate, expired, superseded and archived memories are excluded from normal context. Explicit user memories are treated as required context: when they exceed the available budget they remain present and the result reports overflow. Token measurement uses the supplied `measure` callback when exact model-token accounting is required; the built-in fallback is approximate and is marked in `context.budget.estimated`.

The context result includes a bounded always-on memory index, rendered text, included items and source references, omitted items with reasons, a context hash and budget diagnostics. `recordContextFeedback()` links a known task outcome to the exact context hash and memory revision; it rejects feedback for a memory that was not included in that context. A durable, separately persisted Memory Manifest remains future work.

## Implementation status

The current release implements the Dreaming engine, Experience / Evidence / Memory persistence, automatic evidence-validated consolidation, version history, feedback, local retrieval, task-aware Context Builder, context-use feedback, SQLite scheduling and run recovery. Knowledge-page maintenance and a separately persisted Memory Manifest remain accepted package-owned work items documented in [ARCHITECTURE-ANALYSIS.md](./ARCHITECTURE-ANALYSIS.md). They will be added here rather than delegated to another package.

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

// Call this for each authenticated message authored directly by the memory owner.
const handled = await dreaming.applyUserMessage({
  id: 'source-message:2',
  scope: 'person:opaque-user-id',
  text: '记住我更喜欢直接、简洁的技术回答',
  origin: { system: 'copilot', application: 'assistant-ui', channel: 'conversation' },
});
// If handled is undefined, record the message as a normal experience instead.

dreaming.start();
await dreaming.runNow('person:opaque-user-id');
await dreaming.shutdown(); // Stops the engine, Copilot client and SQLite store.
```

The `createSqliteCopilotDreaming()` factory composes the engine, SQLite store, Copilot adapter and durable SQLite worker. Its `start()` method schedules recurring jobs in the database; it does not rely on the engine's in-process interval. Use `createCopilotDreaming(repository, evidenceResolver, options)` when persistence is supplied separately, or construct `DreamingEngine` and a custom `DreamingRuntime` yourself.

The adapter uses `@microsoft/copilot-sdk` directly. It creates a short-lived, isolated session for each generation call and defaults to the SDK's `empty` mode, so Dreaming receives supplied experiences and evidence but has no tool access by default. The SDK client is reused; conversation history is not. Each temporary session is deleted after the response so Copilot session files do not accumulate. Structured output is requested with a JSON Schema and validated again by the Dreaming engine.

The Copilot SDK is an optional peer dependency. The package can be installed and used with a custom runtime without installing Copilot. Provider-specific SDKs are adapter dependencies only; they do not provide or own any Memory, Knowledge, Evidence, Retrieval or Context capability.


## Architecture decisions and design

- [DECISION.md](./DECISION.md): `agent-dreaming` is self-contained. It must not import or require another internal package; all Memory, Knowledge, Evidence Search, Retrieval and Context Assembly capabilities belong here.
- [ARCHITECTURE-ANALYSIS.md](./ARCHITECTURE-ANALYSIS.md): comparison with Anthropic's Agent Memory research and Claude Code's recovered AutoDream implementation, including the concrete Knowledge Maintenance and Context Injection design.

The package exposes focused internal modules but one installable capability. Consumers do not need to compose it with sibling memory, knowledge or context packages. The host supplies authenticated identity, authorized source records and any application-specific source adapter; the memory lifecycle and its search / consolidation / context logic remain inside this package. Features listed in the accepted target architecture are not implied to be present until they appear in the implementation status and public API.

## Other model runtimes

Implement the small `DreamingRuntime.generate()` contract to connect CodeBuddy, pi.dev, DeepAgents, or another provider. The core package does not depend on their session APIs or lifecycle. Provider-specific authentication, model selection and retry policy belong in the adapter.

## What Dreaming does

1. Loads new experiences and experiences due for re-review.
2. Selects memories through local vector similarity and source-reference overlap, while prioritizing stale and expired memories.
3. Loads related memory edges and resolves original evidence.
4. Sends a bounded, structured task to the configured runtime.
5. Validates scope, targets, provenance, relationships and quality assessment.
6. Automatically applies evidence-backed additions, updates, merges, supersedes and archives. New or uncertain memories remain `candidate`; this is not a human-review state.
7. Records applied/rejected proposal IDs, run outcomes and a contiguous checkpoint.

For personal memory, `scope` is the stable identity of the memory owner, normally derived from the authenticated person. Use that same scope for authorized records from ChatGPT, Claude, Copilot, browsers and other sources. Do not create a new scope for each application, provider, device, project or conversation. Put source attribution in `origin`; it is not a memory boundary.

Memories may carry a `memoryType`: `fact`, `preference`, `goal`, `constraint`, `knowledge`, `behavior-pattern` or `ongoing-context`. This helps hosts inspect and retrieve personal memories without treating a single observation as a permanent personality trait. Existing records without a type remain supported.

Dreaming runs without a human approval step. Every automatic mutation is validated for scope and provenance and preserves the previous memory version. Invalid or unsupported proposals are rejected rather than placed in a review queue.


## Direct user instructions

Call `dreaming.applyUserMessage()` with the authenticated user's raw message before passing ordinary conversation text into the experience pipeline. It recognizes direct requests such as `记住...`, `不要再犯...`, `下次不能...`, `remember...` and `don't ... again`.

A recognized instruction is written immediately as a `confirmed` memory with `authority: 'user-explicit'`. This path does not call the model, wait for a Dreaming run, pass a quality threshold or enter a review queue. The source message is stored as immutable evidence, and repeated delivery of the same message ID is idempotent.

Explicit memories have the highest priority. They are recalled ahead of derived memories and cannot be overwritten, merged, superseded or archived by ordinary model proposals. A subsequent direct user instruction can add or update explicit memory. Passwords, API keys, tokens and similar authentication secrets are not stored.

Only call this method for a message authored by the authenticated memory owner. Do not pass imported documents, quoted text, tool output, assistant messages or messages from other participants as user instructions. The host remains responsible for authentication and mapping the person to the correct scope.

## Storage

`SqliteDreamingStore` implements:

- `DreamingRepository`: experiences, memories, relationships, checkpoints and run persistence.
- `DreamingEvidenceResolver`: scope-isolated local evidence lookup. Evidence refs are immutable; publish changed source content under a new versioned ref so earlier evidence remains available for review.
- `DreamingReviewQueue`: retained for compatibility with earlier integrations and already-staged proposals. The default Dreaming lifecycle does not use it.
- `DreamingRunStore`: query individual runs or bounded run history.
- `DreamingMemoryHistoryStore`: inspect snapshots preserved before memory changes.

SQLite uses Node's built-in `node:sqlite`; no native addon or third-party SQLite driver is required. WAL supports multiple local processes sharing a file, not multi-host distributed storage. Keep transactions short: model calls and external evidence access happen outside database transactions.

## Host responsibilities and boundaries

The host authenticates users and supplies a trusted subject identity. For personal memory, map that identity to one stable scope across integrations; never trust an origin field to identify the owner. Pass direct messages through `applyUserMessage()` only after verifying their author. Derived Dreaming proposals are applied automatically after scope, target and evidence validation. User-explicit memories are protected from derived changes. Do not expose persistence methods directly as untrusted model tools.

The built-in memory ranking uses a persisted SQLite vector index with cosine similarity, source-reference overlap, stale/expiry status and importance. The default local embedding provider uses optional Transformers.js with a multilingual MiniLM model; install @huggingface/transformers to enable local semantic embeddings. Without that optional package, Dreaming falls back to source-reference and recency ranking. Supply a custom EmbeddingProvider or MemoryRetriever to override the default. Embeddings are cached by content hash and isolated by scope and provider ID.

The package includes `SqliteDreamingScheduler` and `DreamingWorker`. Jobs, recurring intervals, attempts and claim leases are persisted in SQLite. Expired claims are recovered after process crashes; workers renew leases during long runs, retry failures with bounded exponential backoff and expose exhausted jobs for manual retry. `DreamingEngine.start()` remains a convenience process-local trigger; use the durable worker for restart-safe scheduling.

## Authorization boundary

The package exports RoleBasedDreamingAuthorization and DenyAllDreamingAuthorization. The role policy is default-deny and grants permissions by authenticated subject and scope. The legacy AuthorizedDreamingReviewQueue is not part of the automatic Dreaming path. Authentication and trusted subject identification remain the host's responsibility; caller-provided role claims are not permission grants. Use a custom DreamingAuthorizationPolicy to integrate an existing IAM or policy engine.
