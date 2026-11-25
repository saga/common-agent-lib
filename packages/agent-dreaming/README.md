# @saga/agent-dreaming

Runtime-neutral background memory dreaming for agent applications. The package owns the orchestration loop; the host supplies the runtime adapter, durable repository, evidence resolver and policy-enforcing commit boundary.

## What it does

A dreaming run reads new experiences and memories due for review, resolves their original evidence, asks a model to identify reusable information and corrections, validates the returned structure, and submits proposals to the host for an atomic commit. It checkpoints processed sequence numbers, uses a per-scope lease to prevent concurrent workers, and records run outcomes.

The runtime can be Copilot SDK, CodeBuddy SDK, pi.dev or another agent/model runtime. No vendor SDK is imported by this package.

## Integration

Implement three interfaces:

- `DreamingRuntime`: one structured generation call. The adapter maps the request to the chosen SDK and returns parsed JSON.
- `DreamingRepository`: load experiences and memories due for review/expiry, persist runs and checkpoints, provide a distributed lease, atomically apply safe candidate additions, and durably stage review-required proposals.
- `DreamingEvidenceResolver`: resolve stable source references to original transcript, trace event or artifact content.

`commitProposal` is used only for low-risk `add` proposals that pass the quality gate; it must still re-check scope, evidence, permissions and idempotency, and must persist the record as `candidate`. `stageProposal` stores all mutations of existing memories and any proposal that fails or lacks a quality assessment in a durable review queue. Both operations must be idempotent by `proposal.id`. The package never writes authoritative memories directly.

Example:

```ts
import { DreamingEngine } from '@saga/agent-dreaming';

const dreaming = new DreamingEngine(runtimeAdapter, repository, evidenceResolver, {
  scopes: ['user:123'],
  intervalMs: 30 * 60_000,
  batchSize: 40,
  maxBatchesPerRun: 3,
  maxMemories: 100,
  maxRelationships: 200,
  maxEvidenceItems: 100,
  maxPromptChars: 120_000,
  reviewIntervalMs: 7 * 24 * 60 * 60_000, // defaults to 30 days
  memoryReviewIntervalMs: 30 * 24 * 60 * 60_000, // default
  autoCandidateThresholds: {
    confidence: 0.8, durability: 0.6, specificity: 0.6, contradictionRisk: 0.2,
  },
});

dreaming.start(); // startup run + recurring background runs

// After persisting a new experience:
await dreaming.notifyRecordAppended('user:123');

// Explicit/manual run:
await dreaming.runNow('user:123');

// During graceful shutdown:
await dreaming.shutdown(); // abort active runs and wait for lease cleanup
```

## Runtime adapter

The adapter is intentionally small. It does not expose provider-specific session APIs to the dreaming package.

```ts
const runtimeAdapter: DreamingRuntime = {
  id: 'copilot-sdk',
  async generate(request) {
    const result = await copilotSession.sendAndWait({
      prompt: request.system + '\n\n' + request.prompt,
      responseFormat: 'json',
      signal: request.signal,
    });
    return { output: JSON.parse(result.text), model: 'configured-model' };
  },
};
```

For CodeBuddy or pi.dev, only this adapter changes. Keep model selection, credentials, SDK lifecycle and provider-specific retry policy in the host application.

The same contract works with other SDKs. Keep provider-specific event handling inside the adapter:

| Runtime | Adapter responsibility |
| --- | --- |
| Copilot SDK | Send the system + task prompt to a session, wait for the final assistant response, parse JSON, and forward abort. |
| CodeBuddy SDK | Invoke `query()`, collect the final assistant text/structured result, parse JSON, and forward timeout/abort. |
| pi.dev | Send the prompt through the selected AgentSession, extract the final assistant response, parse JSON, and forward abort. |

The engine does not require a long-lived session. An adapter may create a short-lived session per batch or reuse a host-managed session, provided each call returns one complete `DreamingRuntimeResponse`. Credentials, model selection, tool permissions and session cleanup remain host-owned.

## Automatic execution and operations

- Call `start()` once during host startup. It immediately schedules one run per configured scope and then runs on the configured interval.
- Call `notifyRecordAppended(scope)` after meaningful records are committed. Concurrent notifications for the same scope are coalesced.
- A durable per-scope lease prevents two processes from dreaming the same scope concurrently. The engine renews it while the run is active, waits for an in-flight renewal before releasing it, and aborts the run if renewal fails; the repository must implement owner-checked acquire/renew/release operations.
- `stop()` stops future scheduling but lets active runs finish. `shutdown()` aborts active runs and waits for their cleanup, including lease release.
- `onRun` is an observer hook; callback failures are reported through `onError` and do not turn a completed run into a failed run.
- Checkpoints advance only through records explicitly reported as processed. Failed runs remain visible and are retried by a later trigger.
- The serialized batch prompt has a configurable character ceiling (`maxPromptChars`, default 120,000) to prevent unexpectedly large model requests. Keep evidence excerpts concise in the resolver.
- Experiences are re-reviewed through `reviewBefore`. Memories are reloaded when stale (`memoryReviewIntervalMs`, default 30 days) or expired (`validUntil <= now`); the repository must include these records even when they are not directly linked to the current experience batch.
- `quality` is a model-generated triage assessment (confidence, durability, specificity, contradiction risk), not a calibrated probability or trust score. Only `add` proposals that pass all thresholds are automatically committed as candidates. Missing assessments, missing provenance, weak quality, conflicts and all mutations of existing memories go to `stageProposal` for host review.
- Expiry triggers review, not deletion. The model may propose supersede/archive, but these operations are staged and never automatically applied.
- The host must keep the repository and evidence resolver durable across restarts.

## Safety and correctness

Model output is untrusted. The package rejects invalid operations, mismatched scopes, unknown processed IDs, unresolved evidence references, invalid relationship payloads and targets that are not loaded memories. Configured scopes are enforced at the public API. Proposed records are forced to `candidate`; the model cannot promote memory to `confirmed`. Existing-memory mutations and expiry actions are review-only. The host must implement `stageProposal` as a durable, idempotent review queue and keep its approval action separate from model execution.

The repository must provide transactionality, idempotent proposal commits, evidence resolution and authorization. A lease is required for multi-process deployments. Do not let the model directly access the memory database or call commit APIs.

The package does not prescribe a database, scheduler service, vector index, graph database or agent framework. A host can use SQLite for a single-process deployment or a transactional database/queue for multiple workers.
