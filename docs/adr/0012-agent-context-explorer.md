# ADR 0012: Agent Context Explorer package

- Status: Accepted
- Date: 2026-11-10

## Context

Agent applications need to inspect the provider request and response, not only host conversation history or a trace summary. Existing @saga/agent-tracing owns event correlation, recording, redaction, bounded payloads and persistence. Existing @saga/agent-context owns deterministic prompt/context assembly. Neither should become a provider-specific inspection UI.

## Decision

Add @saga/agent-context-explorer as an independent workspace package. It provides a provider-neutral normalized model, adapters for common OpenAI-compatible and Anthropic-style payload shapes, message-level diffing and a reusable React inspector. It has no dependency on a model SDK, tracing backend, application database or UI framework other than React as a peer dependency.

Capture should happen at the provider transport boundary whenever possible. The host remains responsible for deciding which payloads may be captured, stored, retained and shown. Raw prompt/response content is visible in the inspector; secret-shaped fields and Bearer values are redacted by default. Hidden reasoning is never inferred or generated.

## Boundaries

- agent-context: deterministic context composition and budget accounting.
- agent-tracing: trace/span lifecycle, correlation, event persistence and operational telemetry.
- agent-context-explorer: normalize, inspect and compare captured model exchanges.
- Host application: transport interception, permissions, data classification, storage retention, user access and provider-specific capture details.

The explorer does not own trace storage, authorization, prompt construction, model execution, token estimation or autonomous context management.

## Consequences

The UI can be embedded in existing React applications without adopting Langfuse or another hosted platform. Provider-specific adapters can be added as payload formats evolve. Trace integration remains an application-level composition rather than a dependency cycle.
