# @saga/agent-dreaming

Standalone memory-dreaming engine for Node.js 24.15+. It includes durable SQLite persistence; the host supplies a model runtime adapter and may add external evidence connectors.

## Included

- Dreaming engine, prompt construction, output validation and candidate quality gates.
- SQLite persistence for experiences, memories, relationships, evidence, feedback, checkpoints, runs, proposals and leases.
- Durable review queue with explicit approve/reject operations.
- Scope-isolated atomic leases, WAL mode and idempotent proposal/feedback writes.
- SQLite-backed evidence resolver.
- Feedback quality and post-review effectiveness evaluation.

No dependency on another `@saga/*` package, Agent framework or provider SDK.

## Use

```ts
import { DreamingEngine } from '@saga/agent-dreaming';
import { SqliteDreamingStore } from '@saga/agent-dreaming/sqlite';

const store = new SqliteDreamingStore({ filename: './data/dreaming.sqlite' });
await store.appendExperience({
  id: 'exp-1', scope: 'user:1', content: 'A durable experience',
  createdAt: new Date().toISOString(), sourceRefs: ['note:1'],
});
await store.putEvidence('user:1', { ref: 'note:1', kind: 'note', content: 'Original source' });

const runtime = {
  id: 'my-runtime',
  async generate(request) {
    return { output: await callYourModel(request) };
  },
};
const engine = new DreamingEngine(runtime, store, store, { scopes: ['user:1'] });
engine.start();
await engine.runNow('user:1');
await engine.shutdown();
await store.close();
```

The SQLite store implements both `DreamingRepository` and `DreamingEvidenceResolver`. Replace either interface only when integrating another database or external source system.

## Store API

- `appendExperience` assigns a per-scope sequence if omitted.
- `upsertMemory`, `appendRelationship`, `putEvidence` manage durable source data.
- `listMemories`, `listReviewQueue` query persisted state.
- `resolveReview` applies an explicit human approval or rejection.
- `recordFeedback` is immutable and idempotent by event ID.
- `close` closes the SQLite connection.

The host must authenticate users and authorize scope access and review decisions. Do not expose persistence methods directly as untrusted model tools.

## Runtime and evidence adapters

The only required application adapter is `DreamingRuntime.generate()`. Copilot SDK, CodeBuddy SDK and pi.dev can be used without becoming dependencies of this package. SQLite evidence is resolved locally; GitHub, Jira, Confluence and other remote sources remain optional resolver adapters.

## SQLite

Uses Node's built-in `node:sqlite`; no native addon or third-party SQLite package. Node.js 24.15+ is required. SQLite calls are synchronous internally, so transactions must remain short; never perform model or network calls inside a transaction. WAL supports multiple local processes sharing a database file, not multi-host distributed storage.

Only provenance-backed, quality-gated additions are committed automatically, and remain `candidate`. Mutations of existing memories enter the durable review queue. Human approval is explicit; the host is responsible for reviewer authentication and authorization.
