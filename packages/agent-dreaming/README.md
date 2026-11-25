# @saga/agent-dreaming

Runtime-neutral background memory dreaming for agent applications. The package owns the orchestration loop; the host supplies the runtime adapter, durable repository, evidence resolver and policy-enforcing commit boundary.

## What it does

A dreaming run reads new experiences and memories due for review, resolves their original evidence, asks a model to identify reusable information and corrections, validates the returned structure, and submits proposals to the host for an atomic commit. It checkpoints processed sequence numbers, uses a per-scope lease to prevent concurrent workers, and records run outcomes.

The runtime can be Copilot SDK, CodeBuddy SDK, pi.dev or another agent/model runtime. No vendor SDK is imported by this package.

## Integration

Implement three interfaces:

- `DreamingRuntime`: one structured generation call. The adapter maps the request to the chosen SDK and returns parsed JSON.
- `DreamingRepository`: load experiences/memories/relationships, persist runs and checkpoints, provide a distributed lease, and atomically validate/apply proposals.
- `DreamingEvidenceResolver`: resolve stable source references to original transcript, trace event or artifact content.

The host's `commitProposal` is the trust boundary. It must re-check scope, target versions, permissions, evidence validity and domain rules inside the same transaction that applies the proposal. Use `proposal.id` as an idempotency key. The package never writes authoritative memories directly.

Example:

```ts
import { DreamingEngine } from '@saga/agent-dreaming';

const dreaming = new DreamingEngine(runtimeAdapter, repository, evidenceResolver, {
  scopes: ['user:123'],
  intervalMs: 30 * 60_000,
  batchSize: 40,
  maxBatchesPerRun: 3,
  reviewIntervalMs: 7 * 24 * 60 * 60_000,
});

dreaming.start(); // startup run + recurring background runs

// After persisting a new experience:
await dreaming.notifyRecordAppended('user:123');

// Explicit/manual run:
await dreaming.runNow('user:123');

// During graceful shutdown:
dreaming.stop();
```

## Runtime adapter

The adapter is intentionally small. It does not expose provider-specific session APIs to the dreaming package.

```ts
const runtimeAdapter: DreamingRuntime = {
  id: 'copilot-sdk',
  async generate(request) {
    const result = await copilotSession.sendAndWait({
      prompt: request.system + '\\n\\n' + request.prompt,
      responseFormat: 'json',
      signal: request.signal,
    });
    return { output: JSON.parse(result.text), model: 'configured-model' };
  },
};
```

For CodeBuddy or pi.dev, only this adapter changes. Keep model selection, credentials, SDK lifecycle and provider-specific retry policy in the host application.

## Automatic execution and operations

- Call `start()` once during host startup. It immediately schedules one run per configured scope and then runs on the configured interval.
- Call `notifyRecordAppended(scope)` after meaningful records are committed. Concurrent notifications for the same scope are coalesced.
- A durable per-scope lease prevents two processes from dreaming the same scope concurrently. The engine renews it while the run is active; the repository must implement owner-checked acquire/renew/release operations.
- Checkpoints advance only through records explicitly reported as processed. Failed runs remain visible and are retried by a later trigger.
- Re-review is host-selected through `reviewBefore`; the repository decides which older records need replay.
- The host must keep the repository and evidence resolver durable across restarts.

## Safety and correctness

Model output is untrusted. The package rejects invalid operations, mismatched scopes, unknown processed IDs, unresolved evidence references and targets outside the loaded scope. Proposed records are forced to `candidate`; the model cannot promote memory to `confirmed`.

The repository must provide transactionality, idempotent proposal commits, evidence resolution and authorization. A lease is required for multi-process deployments. Do not let the model directly access the memory database or call commit APIs.

The package does not prescribe a database, scheduler service, vector index, graph database or agent framework. A host can use SQLite for a single-process deployment or a transactional database/queue for multiple workers.
