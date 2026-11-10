# @saga/agent-context-explorer

Provider-neutral inspection models and reusable React UI for understanding what an LLM request contains and what the provider returned.

The package normalizes OpenAI Chat Completions, Responses-style arrays, Anthropic-style messages/content blocks and generic message payloads. It renders roles, channels, text, thinking blocks, images, tool calls/results, refusals, JSON and unknown multimodal blocks while retaining their raw representation. It exposes tool schemas, model parameters, usage, raw request/response and message-level context diffing.

This is a viewer and normalization layer, not an Agent runtime, trace backend, prompt builder or model SDK wrapper. It has no dependency on provider SDKs, databases or tracing vendors. React is a peer dependency; the normalized model can be used without rendering the component.

## Install and use

```bash
npm install @saga/agent-context-explorer react
```

```tsx
import { normalizeContext, ContextExplorer } from '@saga/agent-context-explorer';

const snapshot = normalizeContext(capturedRequest, capturedResponse, {
  provider: 'openai-compatible',
  redactSecrets: true,
});

<ContextExplorer snapshot={snapshot} previous={previousSnapshot} />;
```

The component uses inline styles and CSS custom properties prefixed with --context- so hosts can theme it without adopting a CSS framework.

## Capture boundary

Capture at the provider transport boundary whenever possible. This is the only reliable point to inspect the final serialized message list, tool schemas and parameters after host-side context assembly. If only application conversation history is available, label it as such; it may differ from the payload actually sent to the model.

The package intentionally does not depend on @saga/agent-tracing. The host can query its trace store, select a model-call event, extract request/response payloads and pass them to normalizeContext. Trace IDs, event relationships and persistence remain in the tracing layer.

## Privacy and limitations

Secret-shaped object keys and Bearer values are redacted by default. Raw prompts and responses remain visible because they are the subject of inspection. Do not capture credentials, customer data or hidden reasoning unless the host's data policy permits it. Redaction is a defensive default, not authorization, retention control or encryption. Set includeRaw: false to omit raw provider payloads while retaining normalized messages.

Thinking/reasoning blocks are displayed only when present in captured payloads. The package does not retrieve hidden chain-of-thought. Unknown blocks are retained rather than silently discarded. Token counts are shown only when reported by the provider; no text-length estimate is presented as token usage. Images are represented by their URL/data reference and metadata; remote assets are not fetched.

Diff is order/index based. It exposes insertions and deletions instead of guessing semantic identity.

## Development

```sh
npm run typecheck
npm test
npm run build
```
