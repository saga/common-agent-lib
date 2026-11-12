# @saga/agent-stage-cache

A small file-backed cache for deterministic, resumable stages in multi-step agent workflows.

It is deliberately not a Workflow Engine, scheduler, model runtime or general job queue. The host decides the workflow, stage order, retry policy, task inputs and semantic acceptance criteria.

## Availability

This package currently lives in the `common-agent-lib` workspace and has not yet been published to the npm registry. Do not add a registry dependency until a release is available. The API example below shows the intended consumer interface.

## What it provides

- Exact caller-supplied input fingerprints, stored alongside a SHA-256 digest.
- Output integrity checks using SHA-256.
- Caller-owned synchronous or asynchronous semantic validation for both cache hits and fresh output.
- Atomic output, fingerprint and manifest writes using unique temporary files in the target directory.
- Per-stage exclusive lock files, so concurrent local processes do not execute the same stage twice for one run directory.
- A separate manifest lock, so different stages can complete concurrently without losing updates.
- Append-only JSONL events for cache hit/miss, corruption, invalidation, execution, completion and failure.
- Stable status and hash metadata returned to the host.

## Basic use

~~~ts
import { runCachedStage } from '@saga/agent-stage-cache';

const result = await runCachedStage({
  runDir: '.output/run-123',
  stageId: 'analysis',
  outputFile: 'analysis.json',
  fingerprint: JSON.stringify({
    promptHash,
    systemPromptVersion: 'v3',
    model,
    modelVersion,
    taskProfile,
    schemaVersion: 2,
    sourceSnapshotHash,
  }),
  execute: () => runAgent(),
  validate: (output) => validateAnalysis(JSON.parse(output)),
});

console.log(result.status); // executed | cache_hit
console.log(result.output);
~~~

The fingerprint is intentionally supplied by the host. Include every input that can change the meaning of the output: exact prompt and system-prompt revisions, provider/model and fallback chain, generation parameters, tool/skill versions, source snapshot, schema and validator versions. The library does not inspect prompts or infer dependencies.

## Files written

~~~text
<runDir>/
  pipeline-manifest.json
  stage-<stageId>.input.txt
  stage-events.jsonl
  <host-selected outputFile>
  .stage-cache-locks/
    <stageId>.lock
~~~

The manifest stores only cache metadata and hashes. Exact fingerprints are retained in the stage input file because that is often essential for diagnosing why a result was reused. Hosts handling private source material should decide whether retaining that file is acceptable and may place runDir under an access-controlled, ignored directory.

## Concurrency and filesystem assumptions

- One logical run should have one stable runDir; stage IDs and output paths must be unique within it.
- A stage lock is held for the entire execution. Same-host live process IDs are not expired by age, even for long-running model calls.
- Manifest updates use a separate exclusive lock. Atomic rename and exclusive lock-file creation require a filesystem with reliable local filesystem semantics.
- This is not a distributed lock service. Do not use it as a cross-region or unreliable network-filesystem coordinator. Use a database/job system when execution spans hosts or requires lease fencing.
- A stale lock from a dead same-host process can be reclaimed. A lock from another host is reclaimed only after staleLockMs, which defaults to 24 hours.
- A cache hit is not permission to bypass authorization or freshness checks. The caller must include relevant authorization scope and source snapshot versions in its fingerprint and revalidate any policy that can change independently.

## Failure semantics

- Empty output, execution errors, validator errors and persistence errors fail the stage; no successful cache entry is written.
- Corrupt or missing output is treated as a cache miss and regenerated.
- A cached output that no longer passes the supplied validator is recorded as cache_invalid and regenerated.
- Required evidence, approval, business state and external side effects remain host-owned. The cache never decides that a stage is complete outside its own content-integrity contract.

## Validation

~~~sh
npm run typecheck --workspace=@saga/agent-stage-cache
npm test --workspace=@saga/agent-stage-cache
npm run build --workspace=@saga/agent-stage-cache
~~~
