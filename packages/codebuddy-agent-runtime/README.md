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
- Model-aware context-window option discovery and explicit per-call overrides, guarded by `supportedLengths` and `maxInputTokens`.

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

## Context-window tiers

The default is unchanged: omit `contextWindow` and the runtime uses the model's configured default tier. A model only exposes a selector when its metadata declares at least two distinct `contextWindow.supportedLengths`, every tier is an integer within `maxInputTokens`, and the physical cap is known. For example:

```ts
const modelContextWindow = {
  maxInputTokens: 1_000_000,
  contextWindow: { supportedLengths: [300_000, 1_000_000], defaultLength: 300_000 },
};

const option = buildCodeBuddyContextWindowOption(modelContextWindow);
// options: [{ value: '300000', name: '300K' }, { value: '1000000', name: '1M' }]
const result = await runtime.run({
  prompt: 'Analyze this document',
  contextWindowModel: modelContextWindow,
  contextWindow: 1_000_000, // explicit session/task override only
});
```

The tier values are token counts, not compaction thresholds. `maxInputTokens` remains the physical model limit. If `defaultLength` is absent or invalid, the smallest supported tier is used as the selector's initial value. CodeBuddy's current TypeScript `query()` API does not expose a `contextWindow` parameter, so an explicit choice is applied through an isolated temporary project `.codebuddy/settings.json` seed. The temporary directory is removed after the invocation; only the current project's `.codebuddy/models.json` is copied into it with mode `0600` so model IDs and context tiers still resolve. Host/user settings, project settings, Skills and MCP config are not copied or loaded. Leaving `contextWindow` unset does not create the temporary workspace.

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
