from __future__ import annotations

import html
from pathlib import Path
from typing import Any, Iterable

import pdfplumber
import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter

from .ast import DocumentNode, PageNode, TableBlock, TextBlock, Word
from .errors import InvalidRequest


def _bbox(obj: dict[str, Any]) -> dict[str, float]:
    return {
        "x0": float(obj.get("x0", 0)),
        "top": float(obj.get("top", 0)),
        "x1": float(obj.get("x1", 0)),
        "bottom": float(obj.get("bottom", 0)),
    }


def inspect_pdf(path: Path) -> dict[str, Any]:
    reader = PdfReader(str(path), strict=False)
    pages = []
    with pdfplumber.open(str(path)) as pdf:
        for index, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            pages.append({
                "index": index,
                "width": float(page.width),
                "height": float(page.height),
                "rotation": int(reader.pages[index].get("/Rotate", 0) or 0),
                "has_text": bool(text.strip()),
                "character_count": len(text),
            })
    return {
        "page_count": len(reader.pages),
        "metadata": {str(k): str(v) for k, v in (reader.metadata or {}).items()},
        "pages": pages,
        "encrypted": reader.is_encrypted,
    }


def extract_document(
    path: Path,
    *,
    selected_pages: Iterable[int] | None = None,
    include_words: bool = False,
    include_tables: bool = False,
) -> DocumentNode:
    reader = PdfReader(str(path), strict=False)
    page_count = len(reader.pages)
    indexes = list(range(page_count)) if selected_pages is None else list(selected_pages)
    if any(not isinstance(i, int) or i < 0 or i >= page_count for i in indexes):
        raise InvalidRequest("pages must contain valid zero-based page indexes.")

    pages: list[PageNode] = []
    notes: list[str] = []
    with pdfplumber.open(str(path)) as pdf:
        for index in indexes:
            page = pdf.pages[index]
            chars = page.chars
            font_sizes = [float(c["size"]) for c in chars if c.get("size") is not None]
            median_size = sorted(font_sizes)[len(font_sizes) // 2] if font_sizes else None
            # pdfplumber's text extraction is authoritative for the page text.
            blocks: list[TextBlock] = []
            for block_index, item in enumerate(page.extract_text_lines(layout=False, return_chars=True) or []):
                text = str(item.get("text", "")).strip()
                if not text:
                    continue
                line_chars = item.get("chars", [])
                sizes = [float(c["size"]) for c in line_chars if c.get("size") is not None]
                size = sum(sizes) / len(sizes) if sizes else median_size
                fonts = sorted({str(c.get("fontname", "")) for c in line_chars if c.get("fontname")})
                bold = any("bold" in f.lower() or "black" in f.lower() for f in fonts)
                blocks.append(TextBlock(
                    id=f"p{index + 1}-l{block_index + 1}",
                    text=text,
                    bbox=_bbox(item),
                    font_size=round(size, 2) if size is not None else None,
                    font_names=fonts,
                    bold=bold,
                    source_page=index,
                ))

            # Join adjacent visual lines into paragraph candidates. This is a
            # deliberately conservative geometric heuristic, not semantic truth.
            paragraphs: list[TextBlock] = []
            for line in blocks:
                if paragraphs:
                    previous = paragraphs[-1]
                    gap = line.bbox["top"] - previous.bbox["bottom"]
                    same_column = abs(line.bbox["x0"] - previous.bbox["x0"]) <= 14
                    line_size = line.font_size or median_size or 10
                    if same_column and -2 <= gap <= max(4, line_size * 0.8):
                        previous.text = previous.text.rstrip() + " " + line.text.lstrip()
                        previous.bbox["x1"] = max(previous.bbox["x1"], line.bbox["x1"])
                        previous.bbox["bottom"] = max(previous.bbox["bottom"], line.bbox["bottom"])
                        previous.font_names = sorted(set(previous.font_names + line.font_names))
                        previous.bold = bool(previous.bold and line.bold)
                        continue
                line.id = f"p{index + 1}-b{len(paragraphs) + 1}"
                paragraphs.append(line)
            blocks = paragraphs

            words = [
                Word(text=str(w["text"]), bbox=_bbox(w))
                for w in (page.extract_words() if include_words else [])
            ]
            tables: list[TableBlock] = []
            if include_tables:
                for table in page.find_tables():
                    x0, top, x1, bottom = table.bbox
                    tables.append(TableBlock(
                        bbox={"x0": float(x0), "top": float(top), "x1": float(x1), "bottom": float(bottom)},
                        rows=[[str(cell or "") for cell in row] for row in (table.extract() or [])],
                    ))
            text = page.extract_text() or ""
            if not text.strip():
                notes.append(f"Page {index + 1} contains no extractable text; it may be scanned or image-only.")
            pages.append(PageNode(
                index=index,
                width=float(page.width),
                height=float(page.height),
                rotation=int(reader.pages[index].get("/Rotate", 0) or 0),
                text=text,
                blocks=blocks,
                words=words,
                tables=tables,
            ))
    return DocumentNode(
        title=str((reader.metadata or {}).get("/Title") or path.stem),
        source_name=path.name,
        page_count=page_count,
        pages=pages,
        metadata={str(k): str(v) for k, v in (reader.metadata or {}).items()},
        extraction_notes=notes + [
            "Text block order and style hints are heuristic; original PDF coordinates are preserved.",
            "PDF extraction does not reliably recover semantic paragraphs, columns, image anchors or heading hierarchy.",
        ],
    )


def render_page(path: Path, output: Path, page_index: int, scale: float = 1.5) -> dict[str, Any]:
    _ensure_new_output(output)
    if page_index < 0:
        raise InvalidRequest("page must be a zero-based non-negative index.")
    if not 0.25 <= scale <= 4:
        raise InvalidRequest("scale must be between 0.25 and 4.")
    document = pdfium.PdfDocument(str(path))
    try:
        if page_index >= len(document):
            raise InvalidRequest("page index is outside the document.")
        page = document[page_index]
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        output.parent.mkdir(parents=True, exist_ok=True)
        try:
            with output.open("xb") as stream:
                image.save(stream, format="PNG")
        except Exception:
            output.unlink(missing_ok=True)
            raise
        return {"path": str(output), "width": image.width, "height": image.height}
    finally:
        document.close()


def rotate_pages(source: Path, output: Path, rotations: dict[str, int]) -> dict[str, Any]:
    reader = PdfReader(str(source), strict=False)
    writer = PdfWriter()
    for index, page in enumerate(reader.pages):
        degrees = int(rotations.get(str(index), 0))
        if degrees % 90:
            raise InvalidRequest("rotation values must be multiples of 90 degrees.")
        if degrees:
            page.rotate(degrees)
        writer.add_page(page)
    _write_pdf(writer, output)
    return {"output": str(output), "page_count": len(writer.pages)}


def reorder_pages(source: Path, output: Path, order: list[int]) -> dict[str, Any]:
    reader = PdfReader(str(source), strict=False)
    if sorted(order) != list(range(len(reader.pages))):
        raise InvalidRequest("order must be a permutation of all zero-based page indexes.")
    writer = PdfWriter()
    for index in order:
        writer.add_page(reader.pages[index])
    _write_pdf(writer, output)
    return {"output": str(output), "page_count": len(writer.pages)}


def merge_pdfs(inputs: list[Path], output: Path) -> dict[str, Any]:
    if not inputs:
        raise InvalidRequest("inputs must not be empty.")
    writer = PdfWriter()
    for path in inputs:
        writer.append(str(path))
    _write_pdf(writer, output)
    return {"output": str(output), "page_count": len(writer.pages)}


def split_pdf(source: Path, output_dir: Path) -> dict[str, Any]:
    reader = PdfReader(str(source), strict=False)
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    for index, page in enumerate(reader.pages):
        writer = PdfWriter()
        writer.add_page(page)
        target = output_dir / f"page-{index + 1:04d}.pdf"
        _write_pdf(writer, target)
        outputs.append(str(target))
    return {"outputs": outputs, "page_count": len(outputs)}


def _ensure_new_output(output: Path) -> None:
    if output.exists():
        raise InvalidRequest(f"Refusing to overwrite an existing output: {output.name}")


def _write_pdf(writer: PdfWriter, output: Path) -> None:
    _ensure_new_output(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output.open("xb") as stream:
            writer.write(stream)
    except Exception:
        output.unlink(missing_ok=True)
        raise


def document_to_html(document: DocumentNode, title: str | None = None) -> str:
    safe_title = html.escape(title or document.title)
    sections: list[str] = []
    for page in document.pages:
        lines: list[str] = []
        for block in page.blocks:
            text = html.escape(block.text)
            # Heading inference is intentionally conservative and labelled heuristic.
            page_sizes = sorted(b.font_size for b in page.blocks if b.font_size is not None)
            typical_size = page_sizes[len(page_sizes) // 2] if page_sizes else None
            is_heading = bool(
                block.font_size and typical_size
                and block.font_size >= 1.2 * typical_size
                and block.bold
            )
            tag = "h2" if is_heading else "p"
            lines.append(f'<{tag} data-source-block="{html.escape(block.id)}">{text}</{tag}>')
        if page.tables:
            for table in page.tables:
                rows = "".join(
                    "<tr>" + "".join(f"<td>{html.escape(cell)}</td>" for cell in row) + "</tr>"
                    for row in table.rows
                )
                lines.append(f'<table class="source-table">{rows}</table>')
        sections.append(
            f'<section class="source-page" data-source-page="{page.index + 1}">'
            + "\n".join(lines)
            + "</section>"
        )
    body = "\n".join(sections)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{safe_title}</title><style>
@page {{ size: A4; margin: 22mm 18mm; }}
* {{ box-sizing: border-box; }} body {{ font: 11pt/1.65 Georgia,serif; color:#202124; max-width: 780px; margin:0 auto; }}
h1 {{ font: 700 24pt/1.2 Arial,sans-serif; }} h2 {{ font:700 16pt/1.3 Arial,sans-serif; break-after:avoid; }}
p {{ margin:0 0 0.85em; orphans:3; widows:3; }} table {{ border-collapse:collapse; width:100%; margin:1em 0; }}
td {{ border:1px solid #bbb; padding:5px; vertical-align:top; }} .source-page {{ margin-bottom:2em; }}
@media print {{ .source-page {{ break-after:auto; }} }}
</style></head><body><h1>{safe_title}</h1>{body}</body></html>"""


def export_html(source: Path, output: Path, title: str | None = None) -> dict[str, Any]:
    _ensure_new_output(output)
    document = extract_document(source, include_tables=True)
    content = document_to_html(document, title)
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output.open("x", encoding="utf-8") as stream:
            stream.write(content)
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return {
        "output": str(output),
        "page_count": document.page_count,
        "block_count": sum(len(p.blocks) for p in document.pages),
        "note": "HTML is a reflow draft. Review extraction and print with the host Chromium runtime.",
    }


def extract_tables(source: Path, selected_pages: Iterable[int] | None = None) -> dict[str, Any]:
    reader = PdfReader(str(source), strict=False)
    indexes = list(range(len(reader.pages))) if selected_pages is None else list(selected_pages)
    if any(i < 0 or i >= len(reader.pages) for i in indexes):
        raise InvalidRequest("pages contains an invalid zero-based page index.")
    result = []
    with pdfplumber.open(str(source)) as pdf:
        for index in indexes:
            page = pdf.pages[index]
            for table in page.find_tables():
                result.append({
                    "page": index,
                    "bbox": list(table.bbox),
                    "rows": table.extract() or [],
                })
    return {"tables": result}
