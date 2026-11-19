# saga-pdf-engine

Local, provider-neutral PDF processing package for AI-agent applications. It is a Python package, intentionally independent from the JavaScript workspaces in the repository.

## Stack and responsibilities

- **pypdf**: page count/metadata, page rotation and ordering, merge/split, writer operations.
- **pdfplumber**: text, word/character coordinates, tables and layout-oriented extraction.
- **pypdfium2**: raster rendering for previews and visual QA.
- **Document AST**: normalized, format-neutral representation of pages, text blocks, words and tables.
- **Reflow export**: semantic HTML/CSS generation from the AST. The host application prints this HTML to PDF with its existing Chromium runtime. This package does not pretend that PDF coordinates are semantic paragraphs.

No PyMuPDF dependency is used. All three selected libraries have permissive licenses (pypdf BSD-3-Clause, pdfplumber MIT, pypdfium2 Apache-2.0/BSD-3-Clause); verify transitive notices and the exact versions shipped in the product before distribution.

## Install

From this directory:

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
pytest
ruff check .
```

Python 3.11+. On Windows use `.venv\\Scripts\\activate`.

## Agent integration

Run the package as a local JSON-lines process:

```bash
saga-pdf-engine --workspace /absolute/path/to/agent-workspace
```

Each stdin line is one JSON request; each stdout line is one JSON response. Diagnostics go to stderr. The process accepts only files beneath the configured workspace (including symlinks resolved before access). This avoids exposing an unauthenticated localhost HTTP port and gives the host control over process lifetime.

Request:

```json
{"id":"r1","method":"inspect","params":{"input":"docs/source.pdf"}}
```

Response:

```json
{"id":"r1","ok":true,"result":{"page_count":12,"metadata":{},"pages":[...]}}
```

Methods:

| Method | Parameters | Result |
|---|---|---|
| `health` | none | versions and capability list |
| `inspect` | `input` | metadata, page sizes, rotation, text presence |
| `extract` | `input`, optional `pages`, `include_words`, `include_tables` | page text and positioned blocks |
| `render_page` | `input`, `page` (0-based), optional `scale`, `output` | PNG path, dimensions |
| `rotate_pages` | `input`, `output`, `rotations` | rotated copy |
| `reorder_pages` | `input`, `output`, `order` (0-based indices) | reordered copy |
| `merge` | `inputs`, `output` | merged copy |
| `split` | `input`, `output_dir` | one PDF per page |
| `export_html` | `input`, `output`, optional `title` | reflow-ready semantic HTML |
| `extract_tables` | `input`, optional `pages` | table matrices and page coordinates |

All writes are to new output paths; input files are never overwritten. Output paths must also be inside the workspace. Page indices are zero-based. Page selections are validated and bounded.

## Reflow contract

The package exports a best-effort AST:
- document → pages
- page → text blocks / words / tables
- text block → text, bounding box, inferred style hints

PDFs do not reliably encode paragraph, heading, reading-order or image-anchor semantics. The extractor preserves source coordinates and marks inferred fields as heuristic. Multi-column reading order, ligatures, scanned pages, complex tables, footnotes and image-to-paragraph association require additional layout/OCR models and human/visual review.

`export_html` creates accessible, responsive HTML with page/section boundaries and source references. The host's Chromium instance can print it to PDF. This is the semantic reflow path; it is not an in-place PDF edit and does not guarantee pixel-identical reproduction.

## Safety and correctness

- Never overwrite source PDFs; generate a new artifact.
- Treat PDFs as untrusted input. Run the worker with least filesystem privileges and resource limits.
- Enforce file-size/page-count/render-scale limits at the host boundary.
- Do not expose arbitrary filesystem paths to the Agent; resolve relative paths under the workspace.
- Do not claim text redaction by drawing a white rectangle. True redaction requires removal of underlying text/content and verification.
- Digital signatures are invalidated by modifications; signed/encrypted PDFs need explicit handling.
- Validate output by reopening it with pypdf and rendering representative/all pages.
- For scanned PDFs, extraction can be empty; OCR is a separate optional capability and is not silently fabricated here.

## Development

```bash
python -m pytest
python -m ruff check .
python -m saga_pdf_engine.server --workspace ./fixtures
```
