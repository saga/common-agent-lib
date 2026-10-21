# @saga/document-core

Format-neutral contracts and deterministic helpers for long-document workflows. The package has no runtime dependencies and does not call an LLM.

## Included

- Canonical document and segment types shared by browser and server code.
- Budgeted, order-preserving segment batching, including optional chapter/page boundaries.
- Logical reader pagination for EPUB chapters, PDF source pages and other documents.
- Defensive normalization of model translation results against the current batch's expected segment IDs.
- Character-count estimates and configurable page labels.

## Example

~~~ts
import {
  buildSegmentBatches,
  getMissingDocumentBatchIds,
  normalizeDocumentBatchResult,
} from '@saga/document-core';

const batches = buildSegmentBatches(document.segments, {
  maxChars: 3000,
  maxSegments: 24,
  splitOnContextChange: true,
});

const expectedIds = batches[0].map((segment) => segment.id);
const translations = normalizeDocumentBatchResult(modelOutput, expectedIds);
const missingIds = getMissingDocumentBatchIds(expectedIds, translations);
~~~

## Boundary

This package intentionally does **not** parse EPUB/PDF/DOCX/HTML files, depend on DOM APIs or PDF workers, call models, persist projects, cache translations, or run document workflows. Format-specific parser and exporter implementations stay with the host application. Stable document IDs are assigned by the parser/import layer; this package does not invent identities after parsing.

Character budgets use JavaScript string length (UTF-16 code units), matching the original implementation. They are not token counts. If a model context limit is important, the caller must use its own tokenizer or token estimator.

## Development

~~~sh
npm run typecheck
npm test
npm run build
~~~
