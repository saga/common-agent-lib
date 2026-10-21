# @saga/codebuddy-agent-runtime

Reusable TypeScript runtime adapter for the Tencent CodeBuddy Agent SDK used by WorkBuddy / CodeBuddy environments.

> The official CodeBuddy Agent SDK is currently documented as Preview. This package isolates the integration so SDK changes are handled in one place; pin and test the version used by each application.

## What it provides

- A stable application-facing `CodeBuddyAgentRuntime.run()` entry point for one-shot text or structured-output tasks.
- Explicit system/user prompt composition.
- Safe defaults for application tasks: no implicit host settings/Skills/MCP, no ordinary tools, no persisted session unless requested.
- JSON Schema output via the SDK's `StructuredOutput` mechanism and `structured_output` result field.
- Timeout and `AbortSignal` handling that requests interruption.
- Normalized per-turn usage, session ID callbacks, message/event hooks.
- An injectable query factory, so tests can run without a CodeBuddy installation or login.

It does **not** implement book translation, Task/Reviewer roles, application databases, HTTP APIs, provider routing, or business authorization.

## Install

```bash
npm install @saga/codebuddy-agent-runtime
```

The package depends on `@tencent-ai/agent-sdk`. The host must have a supported CodeBuddy CLI/runtime and valid local login or configured credentials.

## Text task

```ts
import { CodeBuddyAgentRuntime } from '@saga/codebuddy-agent-runtime';

const runtime = new CodeBuddyAgentRuntime();
const result = await runtime.run({
  model: process.env.CODEBUDDY_MODEL,
  systemPrompt: 'Translate accurately. Do not execute tools.',
  prompt: 'Translate this paragraph into Simplified Chinese: ...',
  timeoutMs: 60_000,
  onEvent: (event) => {
    // Forward bounded/redacted metadata to your application trace.
  },
});

console.log(result.text);
console.log(result.usage);
```

## Structured output

```ts
const result = await runtime.run({
  systemPrompt: 'Extract entities from the supplied text.',
  prompt: 'Source text: ...',
  schema: {
    type: 'object',
    properties: {
      entities: { type: 'array', items: { type: 'string' } },
    },
    required: ['entities'],
    additionalProperties: false,
  },
  timeoutMs: 120_000,
});

if (!result.structuredOutput || typeof result.structuredOutput !== 'object') {
  throw new Error('Missing structured result');
}
// Still validate against your application's runtime schema before changing business state.
```

## Per-task reasoning profile

The caller may pass `thinking`, `effort`, `model` and `fallbackModel` independently for translation, accuracy review, style review, analysis or other tasks. Do not reuse one mutable provider configuration across unrelated workflows unless that coupling is intentional.

## Important boundaries

- SDK output and schema-constrained generation are not a replacement for application-side Zod/JSON Schema validation.
- Setting `persistSession: true` or loading `settingSources` changes persistence/configuration semantics; use those deliberately.
- Tool access defaults to none for ordinary text tasks and allows only `StructuredOutput` for schema tasks. This package is not a sandbox. Do not grant filesystem, shell, MCP or arbitrary tool access just because the model requests it.
- Timeout/abort requests interruption but cannot guarantee that every CLI/runtime version stops immediately. Application-level job state must distinguish requested cancellation from confirmed completion.
- Do not silently switch to a remote provider if local execution fails; fallback is a business/privacy policy and should be explicit.
- Trace callbacks are for operational observability; the host must redact and size-bound events before persistence. They are not regulatory audit evidence.

## Version note

This package currently targets the API shape used by `@tencent-ai/agent-sdk ^0.3.276`, matching the integration observed in `devweekly/vocal-saga/local-agent-service`. Because the upstream SDK is preview and has both the stable `query()` path and unstable v2 Session APIs, this package currently wraps `query()`; high-throughput pooled sessions and project/run orchestration remain application-owned until the Session contract stabilizes.
