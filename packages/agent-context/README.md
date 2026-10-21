# @saga/agent-context

A small, provider-neutral context assembler for TypeScript agent applications. It does not retrieve data, call an LLM, store memories, or make authorization decisions.

## Install

This package currently lives in the [common-agent-lib workspace](https://github.com/saga/common-agent-lib/tree/main/packages/agent-context). It is not yet published to the npm registry.

## Example

~~~ts
import { assembleContext } from '@saga/agent-context';

const result = assembleContext({
  sections: [
    {
      id: 'task-contract',
      title: 'Task contract',
      required: true,
      items: [{
        id: 'must-follow',
        text: 'Follow the task instructions and do not invent source facts.',
        sources: [{ id: 'translation-policy-v3', kind: 'policy' }],
      }],
    },
    {
      id: 'confirmed-memory',
      title: 'Confirmed memory',
      priority: 60,
      items: retrievedMemory.map((memory) => ({
        id: memory.id,
        text: memory.text,
        dedupeKey: memory.canonicalKey,
        sources: memory.sources,
        priority: memory.relevance,
      })),
    },
    {
      id: 'current-source',
      title: 'Current source',
      required: true,
      items: currentSegments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        sources: [{ id: segment.id, kind: 'source-segment' }],
      })),
    },
  ],
  budget: { maxUnits: 18_000, unit: 'characters' },
});

console.log(result.text);
console.log(result.budget, result.omittedItems, result.issues);
~~~

## Selection and rendering rules

- The host supplies the candidate set, priorities, required flags, and source references.
- Required sections/items are never dropped. If their rendered output exceeds the budget, the result contains all required text plus a required-context-exceeds-budget issue; optional content is omitted.
- Optional items are admitted by descending effective priority (section.priority + item.priority) and then stable input order.
- The final output is rendered in the original section/item order. The budget includes headers and separators.
- Cross-source deduplication happens only when a caller supplies the same dedupeKey. A duplicate ID is a validation error. The winner is chosen by required status, priority, then stable input order; the omitted item reports duplicateOf.
- Provenance and metadata are returned with every included/omitted item but are not automatically inserted into prompt text.
- Empty optional text is reported as empty-content; an empty required item is an input error.

## Length budgets

The default estimator is JavaScript string length in UTF-16 code units. It is deterministic but is **not a model token count**. For token budgets, inject the tokenizer/estimator used by the target model and set budget.unit, for example:

~~~ts
measure: (rendered) => tokenizer.count(rendered)
~~~

The estimator measures the complete rendered context (including section headers and separators). It must return a finite, non-negative number.

## Deliberate non-goals

This package does not search vector stores, traverse graphs, summarize conversations, compress memory, maintain persistent context files, call models, choose trust/approval status, enforce data entitlements, or decide temporal/anti-spoiler boundaries. The host must apply authorization and domain filters before supplying items. It also does not implement autonomous Context Language Models.

## Validation

~~~sh
npm run typecheck
npm test
npm run build
~~~
