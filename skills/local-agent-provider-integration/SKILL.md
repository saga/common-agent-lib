---
name: local-agent-provider-integration
description: Integrate a local WorkBuddy / OpenCode Agent service with an app or browser extension without silently changing routing, privacy or provider semantics.
---

# Local Agent Provider Integration

Use this Skill when an application can call a local Agent runtime (for example WorkBuddy / CodeBuddy or OpenCode) alongside remote model APIs.

## Routing must be explicit

- Model the local provider as a separate route with its own enabled flag, provider ID, URL, optional token and model override.
- Keep settings for distinct tasks separate when they have different latency, privacy, workflow or quality requirements. Document translation, current-page translation and background assistant requests should not accidentally share a setting just because they call an LLM.
- Normalize provider/model routing in one helper; do not reimplement slightly different prefix parsing in each call site.
- When a user explicitly selects the local provider, fail clearly or preserve the existing result if it is unavailable. Never silently fall back to a remote service; the fallback could leak local content, incur a charge or change model behavior.
- If fallback is desired, make it an explicit user-visible policy with a clear indication of which provider actually handled the request.

## Provider fallback policy

- Define fallback eligibility as an explicit policy, not as a generic catch-all around provider execution.
- A user-enabled fallback may retry on a recognized quota, rate-limit or resource-exhaustion failure. Do not classify authentication, permission denial, user cancellation, invalid tool input, schema/business validation or unknown failures as capacity errors.
- Record every provider attempt and the actual provider/model that produced the final result. Keep the user's preferred provider setting unchanged unless the user explicitly changes it.
- When switching provider or model, do not reuse the prior SDK session as though cross-runtime conversation state were portable. Start a compatible session and transfer only the context the host intentionally reconstructs.
- Error classifiers are version-sensitive: test against real representative errors and negative cases from the specific SDK versions in the lockfile. A broad regex alone is not proof that a fallback decision is safe.

## Health and request lifecycle

- Keep a cheap health check separate from inference. When feasible, detect availability before showing the provider as selectable or before starting a long document job.
- Distinguish service-unavailable, authentication, model/provider, timeout, malformed response and cancellation errors.
- Apply timeouts, cancellation and concurrency limits at the service boundary. A browser/UI request should not start unbounded independent work.
- A queued / background task needs an observable task ID and status if the UI is not expected to wait for the full result.

## Divide responsibilities

- The extension/UI should own user interaction, content selection, small request routing and progress projection.
- The local service should own expensive or stateful work where appropriate: EPUB/PDF parsing, document workspace management, cache, persistent run history, provider invocation and SQLite-backed state.
- Do not assume browser request-body limits are the right limit for a long-running local document operation; use a document/task API when that is the better boundary.
- Keep normal web/page translation independent from document translation so a change to one workflow does not accidentally alter the other.

## Cache identity and per-task profile changes

- Treat output-affecting options as part of task identity: resolved model/provider, fallback model, thinking/effort, context-window override, prompt revision, schema/response format, and task-specific context version. If any of these changes, invalidate or namespace cached results; do not return a previous result under a new profile.
- Keep independent task profiles (for example translation, accuracy review and style review) distinct. When a selected model changes, refresh that model's supported config options and clear an override that is no longer valid for the new model.
- Client-side option lists are hints, not authority. Revalidate the model/profile/tier on the local service immediately before execution; a stale or unsupported override should produce an explicit response rather than being silently ignored.
- A session ID and task/profile revision should be distinct identifiers. Session scope controls conversation history; the profile/cache key controls which execution settings produced a result. Do not substitute one for the other.

## Local service security

- Bind local services to loopback unless remote access is an explicit requirement.
- Treat localhost as a network boundary, not as authorization. Add an optional or required bearer token according to the threat model and validate origins / request shapes as appropriate.
- Validate paths and file identifiers on the server. Do not accept arbitrary filesystem paths from a browser request without a constrained workspace boundary.
- Bound logged payloads, redact credentials and avoid storing full document content in routine operational events.
- Keep the health endpoint minimal; it should report service/provider readiness without leaking credentials or private workspace paths.

## Integration checklist

- [ ] Provider selection is explicit and persisted.
- [ ] Provider, URL, model and token settings are normalized in one place.
- [ ] Local and remote routing are covered by tests.
- [ ] A local failure cannot accidentally invoke a remote provider.
- [ ] Service unavailable and invalid response states are user-visible.
- [ ] Large document parsing and persistence live at the chosen service boundary.
- [ ] Cancellation, retry, concurrency and task progress have defined semantics.
- [ ] Logs and health responses are bounded and redacted.

Repository example: fanyi-extension documents the separate WorkBuddy/OpenCode local provider and the no-silent-fallback rule. The exact endpoint and provider SDK must be taken from the target repository; this Skill does not assume they are interchangeable.
