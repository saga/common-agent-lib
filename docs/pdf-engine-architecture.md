# PDF Engine architecture

## Decision

Implement PDF processing as an independent Python package in `packages/pdf-engine`, using pypdf, pdfplumber and pypdfium2. Keep the package independent of Agent SDKs, MCP SDKs, Electron and application persistence.

The TypeScript host owns Agent tool schemas, policy, workspace selection, process lifecycle, user approval, artifact history and UI. The Python worker owns deterministic document operations.

## Runtime boundary

```text
Agent (Copilot / CodeBuddy / other)
       |
       v
Host-owned PDF tools (TypeScript + schema validation + policy)
       |
       | JSON Lines over stdin/stdout
       v
saga-pdf-engine (Python child process)
       |
       +-- pypdf       page operations and PDF writing
       +-- pdfplumber  text, words, tables and coordinates
       +-- pypdfium2   page rasterization
       |
       +-- Document AST
       +-- semantic HTML export
       |
       v
Host workspace artifacts -> Chromium print-to-PDF -> visual QA
```

Use stdio rather than an unauthenticated localhost server. One request and one response occupy one JSON line. Worker diagnostics go to stderr; stdout is reserved for protocol messages. The host must correlate request IDs, enforce timeouts, terminate crashed workers and limit concurrency.

## Document model

The AST is an interchange representation, not a claim that PDF source structure is semantic:

- Document: source metadata, original page count, extraction notes.
- Page: original page index, dimensions, rotation, extracted text.
- TextBlock: text, bounding box, font-size/font-name hints, source page, heuristic confidence.
- Word: token and bounding box, optional for more precise selection.
- TableBlock: extracted cell matrix and source bounding box.

Coordinates and page indexes refer to the source PDF. Keep source page references on every extracted object so the UI can map an AST selection back to the original rendered page.

Paragraph candidates are inferred by joining adjacent lines using vertical gaps and indentation. Heading inference is conservative and heuristic. Do not use these fields as legal, financial or accessibility-grade structure without validation.

## Capability boundaries

| Capability | Implementation | Guarantee |
|---|---|---|
| Inspect metadata/pages | pypdf + pdfplumber | deterministic for readable PDFs |
| Extract text/words/tables | pdfplumber | best effort; layout-dependent |
| Render page PNG | pypdfium2 | visual page rendering |
| Rotate/reorder/merge/split | pypdf | structural page operations |
| Semantic HTML draft | AST + HTML/CSS | best effort, not fidelity-preserving |
| Print HTML to PDF | host Chromium | host responsibility |
| Arbitrary text rewrite in existing PDF | not provided | requires content reconstruction |
| True redaction | not provided | never simulate with a white overlay |
| OCR/scanned-PDF recovery | extension point | not included in initial package |
| Digital-signature preservation | not provided | edits can invalidate signatures |

## Reflow workflow

1. Inspect the source and identify encrypted, scanned, mixed, or text-based pages.
2. Extract page text, words, table candidates and source coordinates.
3. Build the AST with source provenance and heuristic notes.
4. Ask the model to propose structural edits to the AST, not raw PDF drawing commands.
5. Validate the proposed AST against a strict schema and preserve source references.
6. Render a responsive HTML draft with CSS page and typography settings.
7. Let the host Chromium runtime print a new PDF artifact.
8. Render the result with pypdfium2 and compare page images / extracted text.
9. Report missing text, page count changes, extraction warnings and visual review status.

The first implementation only carries extracted text and detected tables into HTML. Images, captions, footnotes, mathematical notation and robust multi-column reading order are explicit follow-up capabilities, not silently discarded as if they were supported.

## Safety and resource controls

- Run the worker with a dedicated least-privilege workspace.
- Accept only workspace-relative paths; resolve symlinks before checking containment.
- Never overwrite source files or existing output artifacts.
- Keep PDFs out of model prompts unless explicitly needed; pass bounded extracted content.
- Enforce host-side file-size, page-count, render-scale, execution-time and parallel-job limits.
- Treat PDF text, metadata, links and embedded objects as untrusted content, never as Agent instructions.
- Do not allow a model-generated path to access arbitrary user files.
- Treat encrypted files, malformed PDFs and unsupported features as explicit errors.
- Preserve originals; every edit/reflow creates a new artifact and a provenance record.
- Verify output by reopening and rendering it. A successful write is not proof of visual correctness.

## Future extension points

1. Image extraction and image-to-block association.
2. OCR adapter for scanned documents.
3. Layout model for columns, reading order, headers/footers and footnotes.
4. Schema-validated AST patch operations with stable block IDs.
5. Reflow profiles (single-column tablet, print A4, accessible large type).
6. Visual diff and text-coverage evaluation.
7. Optional true-redaction implementation with independent verification.

Do not add these as mandatory dependencies until a real corpus demonstrates the need.
