# CodeBuddy / WorkBuddy Agent SDK Compatibility Notes

> Last reviewed: 2026-10-23. Evidence is from the CodeBuddy SDK versions actually probed in Saga projects, not a promise that every future Preview release behaves the same way.

## Scope and current package boundary

`@saga/codebuddy-agent-runtime` pins `@tencent-ai/agent-sdk` to `0.3.276` and deliberately wraps the one-shot TypeScript `query()` API. The upstream Agent SDK is a Preview integration. The V2 Session API must be treated as a separate option surface, not as a typed alias of `query()` options. Long-lived Session pools, durable run state, document/chapter batching, reviewer workflows, and business progress stay in the host application.

## Observed option compatibility

A CodeBuddy SDK probe recorded the following observations for versions `0.3.274`, `0.3.276`, and `0.3.282`. Version `0.2.3` predates the tested option fields. The current `vocal-saga/local-agent-service/package-lock.json` resolves `0.3.276`, which is why the common package now pins that exact baseline. The npm registry page lists `0.3.284` as a newer release, but this audit has not completed the three-layer probe against `0.3.284`; treat it as unverified, not automatically compatible. Re-probe the exact installed package whenever the lockfile/runtime version changes.

| Option / behavior | `query()` Options | V2 `SessionOptions` | Implementation guidance |
| --- | --- | --- | --- |
| `thinking` | Declared and observed passed through | Declared and observed passed through | Can be used when a workflow genuinely uses Session, but verify again after upgrades. |
| `effort` | Declared and observed as `--effort` | Declared and observed passed through | Verify the effective CLI argv/env, not only TypeScript declaration presence. |
| `fallbackModel` | Declared and observed in `query()` options | Not declared and not forwarded in the probed versions; it can be silently ignored | Use the `query()` path for task profiles that require this option. Do not cast it into Session config and assume it works. The observed `extraArgs: { 'fallback-model': '…' }` workaround is CLI-specific and must be validated against the pinned version before use. |
| `contextWindow` | No direct `query()` option in the probed TypeScript API | Not treated as a reliable per-session option by this package | Discover choices through the local Agent's explicit `config-options` endpoint. For an explicit override, the current adapter uses an isolated temporary project `.codebuddy/settings.json` seed and validates the requested tier first. |
| `autoCompactWindow` | Different control | Different control | Do not treat compaction thresholds as context-window tiers or as the model's physical input-token limit. |

These are observed SDK facts and should not be generalized to unknown releases. The package API intentionally avoids wrapping the unstable V2 Session contract.

## Three-layer SDK probing procedure

When an SDK option appears undocumented, inconsistently typed, or ignored, use three independent checks:

1. **Declaration surface.** Read the installed package version and inspect its actual `lib/types.d.ts` declarations. Compare the field in the precise interfaces used by the call site (for example `Options` versus `SessionOptions`). A field present in one interface is not evidence that another API accepts it.
2. **Compile-time acceptance.** Compile a small object literal against the installed SDK types without type casts. This catches fields that the current package does not declare, but successful compilation alone does not prove runtime forwarding.
3. **Runtime transport.** Execute a synthetic probe and instrument/intercept the child-process boundary to record only the relevant argv, environment variable names/values that are not secret, and option forwarding. Confirm the option reaches the CLI/runtime in the expected form. Never print tokens, credentials, full environments, private prompts, or real document contents.

Keep the probe reproducible and tied to a concrete SDK version. Record the exact package version, API surface, resulting argv/env evidence, and a small regression test. Re-run all three checks after an SDK upgrade. Do not infer API support from online docs for a different version or from an unrelated SDK interface.

## Versions currently observed in Saga repositories

This is an audit snapshot, not a guarantee that a semver range has already been verified:

| Repository | Declared version | Lockfile observation in this review | Notes |
| --- | --- | --- | --- |
| `common-agent-lib/packages/codebuddy-agent-runtime` | Exact `0.3.276` | No root lockfile was present at the queried path; package dependency is pinned exactly | Shared adapter baseline. |
| `vocal-saga/local-agent-service` | Exact `0.3.276` | `0.3.276` | Pinned to match the concrete version used for the common adapter baseline. |
| `agentic-data-architect` | Exact `0.3.274` | `0.3.274` | Pinned to its pre-existing, probe-observed lockfile version. Uses `query()` with explicit `resume: sessionId`; its permission/tool policy and Investigation state remain application-owned. |
| `desktop-agent` | Exact `0.3.276` | No root package lockfile was found at the queried path | Pinned to the common known baseline, but a lockfile should be added for reproducible installs. Its interactive host-side `canUseTool` approval gate is not compatible with the shared runtime's no-tool default and must not inherit its security policy implicitly. |

The npm registry lists [`@tencent-ai/agent-sdk` `0.3.284`](https://www.npmjs.com/package/@tencent-ai/agent-sdk) as a release newer than the current locked `0.3.276`, but this review has not run the declaration / compilation / transport probe on `0.3.284`. Keep the shared package pinned to the tested baseline until that probe and the regression suite are run. For application repos with a different concrete version, read their lockfile; the package.json range is not runtime evidence.

## Choosing `query()` versus V2 Session

- Prefer `query()` for isolated tasks with a per-task model, thinking mode, effort, fallback model, structured output, timeout, or cancellation profile. This is the path covered by this package and the current per-task CodeBuddy profiles in `fanyi-extension` / `vocal-saga`.
- The query path can also continue a known SDK session using `resume`; `@saga/codebuddy-agent-runtime` now exposes this as `resumeSessionId` and opts into `persistSession` by default for such calls. This is SDK session continuity only; it is not a workflow checkpoint or business-state recovery mechanism.
- Choose a persistent Session only when conversation history or resumable identity is an actual requirement. Audit each required option against `SessionOptions` independently; do not assume parity with `query()`.
- Do not reuse one mutable Session across unrelated task profiles if a setting cannot be applied or verified per turn. A misleading configuration is worse than the startup cost of a separate query.
- If the host introduces a Session pool, define the key and concurrency invariant explicitly. Application evidence from document translation shows that one scoped session should have one active turn at a time; reusing the same scope serializes calls, while distinct lanes permit parallel work only when their prompts are self-contained and history isolation is intended.
- A durable multi-step workflow must persist its own run/checkpoint/status and restore the correct session/run association. A returned SDK session ID is not a durable business checkpoint and must survive structured-output/result normalization if the host needs to resume it.

## Config-option discovery and context window

The UI should consume a provider/configuration endpoint such as `GET /api/codebuddy/config-options?model=…`; it should not invent selectable tiers from the model list or from `maxInputTokens` alone. A context-window selector is meaningful only when the configuration metadata supplies at least two valid distinct tiers, each no greater than the model's physical `maxInputTokens`. Keep the default unchanged when the user has not explicitly selected an override. After model/profile changes, refresh the options and clear any saved tier that does not belong to the selected model. The host must validate the requested value again at execution time because UI options can be stale.

The runtime's model-metadata helper validates the server-side metadata and applies an explicit selected tier in an isolated temporary directory. It does not replace the host's `config-options` endpoint, UI state, task-profile persistence, or execution-time validation.

## Regression-test expectations

At minimum, test:

- `query()` options forward `model`, `fallbackModel`, `thinking` and `effort` without silently moving those fields into a Session config.
- No context-window override means no temporary workspace and no added project setting source.
- Unsupported/invalid context tiers fail before starting an SDK invocation; valid overrides clean up temporary files on both success and error.
- Session IDs and structured output are both preserved when present in one result stream.
- Timeout and caller abort request SDK interruption. Application status distinguishes cancellation requested from runtime shutdown/idle confirmed; do not claim the process definitely stopped merely because the caller's Promise rejected.
- Structured output is still validated by the host application before it changes business state.

## Sources observed in Saga repositories

- `fanyi-extension/.workbuddy-ai/memory/2026-10-18.md`: versioned SDK probe findings for `0.3.274` / `0.3.276` / `0.3.282`.
- `vocal-saga`: `7045b6d` keeps unsupported query options out of V2 Session config; `0d7e2d8` adds validated context-window config options and isolated settings seeding; `ac8d932` preserves a CodeBuddy session ID in structured request results; `d3f37ea` isolates persistent workflow turns from the shared session pool.
- `common-agent-lib/packages/codebuddy-agent-runtime`: provider-neutral query adapter, strict context-window metadata validation, temporary settings isolation, timeout/abort request, explicit `resumeSessionId` continuation, structured output, and usage/session-ID normalization.
- `agentic-data-architect/src/agent/codebuddy.ts`: uses `query()` with `resume: sessionId`, captures a returned session ID, and owns workspace, permissions, Mission/Evidence/Journey state and runtime-switch behavior at the application boundary.
- `desktop-agent/src/main/agent/codebuddy.ts`: pairs `permissionMode: 'bypassPermissions'` with a host-side `canUseTool` gate and explicit user approval for non-read tools. This is an application-specific interactive tool runtime, not a safe default for the common no-tools query adapter.

The above application repositories supply evidence and regression cases; this document records only cross-project integration rules. Literary translation roles, review policy, chapter orchestration, and application persistence stay outside the common runtime.
