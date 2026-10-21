# Lightweight Context Assembly: design proposal

## Decision

A reusable context-assembly layer is viable, but it should start as a small TypeScript library (tentatively **@saga/agent-context**), not as a network microservice and not as a full Context Language Model implementation.

The first version should be deterministic: the host retrieves and classifies candidate context; the package orders, deduplicates, applies a caller-owned budget, renders the selected items and reports what was included or omitted. This is the missing composition layer between knowledge/memory storage and a provider-specific Agent Runtime.

## What the current vocal-saga implementation demonstrates

The local Agent Service already has useful, separable layers:

- `src/documents/contextGraph.ts` maintains revision-scoped book entities, relations, evidence, chapter summaries, lexical source-feature indexes and analysis workflow state.
- `src/documents/voiceContext.ts` sanitizes literary memory and builds a compact project voice context. It distinguishes confirmed data from candidate material, avoids treating arbitrary object properties as memory, and limits future-chapter summaries.
- `src/literary.ts` composes a review prompt from the translation brief, glossary, voice context, Context Graph and preceding source segments.
- `tests/document-context-graph.test.mjs` verifies an important invariant: retrieval for a current chapter must exclude later chapter summaries and future-knowledge graph records.

Those are not all the same kind of responsibility. The source graph, source evidence validation, character identity resolution, chapter-order knowledge boundary and confirmed/candidate semantics are novel-translation domain logic. The final ordering, deduplication, budget accounting and rendering of already-authorized context items can be made generic.

## Proposed responsibility split

~~~text
Host application
  ├─ retrieve memory / graph / documents / recent turns
  ├─ apply authorization and temporal knowledge boundary
  ├─ attach confidence, provenance and priority
  └─ define task-specific required context
             |
             v
@saga/agent-context
  ├─ validate item shape
  ├─ stable ordering and deduplication
  ├─ enforce a caller-supplied character/token budget
  ├─ keep required items or report that the budget is impossible
  ├─ render deterministic sections
  └─ return included/omitted item IDs and budget statistics
             |
             v
  provider-specific prompt builder / Agent Runtime
~~~

### Generic package can own

- ContextItem and ContextSection interfaces with stable IDs, text, source reference, priority, required/optional flag and optional deduplication key.
- A deterministic assembler with stable tie-breaking, section order and explicit budget behavior.
- A pluggable length estimator. The default can count characters, but a model-aware token estimator must be injected by the host; the package must not pretend character count equals tokens.
- Assembly output containing final text, ordered included items, omitted IDs plus reasons, character/token statistics and provenance references.
- Pure functions and tests, without a database or model SDK.

### Keep in vocal-saga / application adapters

- Context Graph storage, graph traversal, lexical/semantic retrieval and the index.
- Novel/translation schemas: entities, character voices, relationship voice rules, approved voice anchors, chapter summaries and translation brief.
- Source evidence validation, stable character/alias merge, confidence calibration and candidate approval.
- Chapter-order / anti-spoiler constraints. The host must filter inaccessible future facts before generic assembly; the model must not set its own knowledge boundary.
- Prompt instructions, translation modes, review-focus policies, persistence, job scheduling and agent-specific workflow.

## Minimal API shape (illustrative)

~~~ts
const result = assembleContext({
  sections: [
    {
      id: 'instructions',
      priority: 100,
      required: true,
      items: [{ id: 'system-rules', text: 'Follow the task contract.', source: 'app-policy' }],
    },
    {
      id: 'current-source',
      priority: 90,
      required: true,
      items: currentSegments,
    },
    {
      id: 'confirmed-memory',
      priority: 60,
      items: retrievedMemory,
    },
    {
      id: 'retrieval',
      priority: 40,
      items: relatedEvidence,
    },
  ],
  budget: { maxChars: 18000 },
});

const promptContext = result.text;
// result also describes included/omitted IDs and budget use
~~~

This is a design illustration, not a committed package API. Exact names and token-budget behavior should be fixed after extracting one real call path.

## Why not implement CLM directly

The referenced Context Language Models project explores letting a model update its context as a file, including learning what to retain. That is a separate research/runtime direction. The practical near-term goal here is lower-risk and easier to test: deterministic selection and composition around application-owned sources. We should not allow an LLM to silently rewrite source facts, promote candidates to confirmed memory or override access/temporal limits.

## Recommended adoption sequence

1. Extract @saga/document-core first. Its types and deterministic helpers have clear inputs/outputs and no external service dependencies.
2. Add a narrow @saga/agent-context implementation only for assembling preselected items; prove it against buildProjectVoiceContext / buildLiteraryReviewPrompt without moving the underlying retrieval.
3. Migrate one local-agent-service prompt path and compare exact included source IDs, temporal filtering, budget behavior and final prompt shape.
4. Only after a second application uses it, consider whether any additional context persistence/compaction abstraction is genuinely shared.

## Acceptance invariants

- A context item retains a source/provenance reference through assembly.
- No item outside the host-provided authorized and temporally eligible set can be introduced by the assembler.
- Required context that exceeds the budget produces an explicit error/warning; it is never silently dropped.
- Equal-priority items use stable tie-breaking for reproducible prompts.
- The result reports both included and excluded items; truncation is not presented as complete context.
- The package does not store memory, issue model calls, manage sessions, authorize data or mutate application state.
