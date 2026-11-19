from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any

import pdfplumber
import pypdf
import pypdfium2

from . import __version__
from .engine import (
    export_html, extract_document, extract_tables, inspect_pdf, merge_pdfs,
    reorder_pages, render_page, rotate_pages, split_pdf,
)
from .errors import InvalidRequest, PdfEngineError
from .paths import resolve_workspace_path


def dispatch(method: str, params: dict[str, Any], workspace: Path) -> dict[str, Any]:
    if method == "health":
        return {
            "version": __version__,
            "dependencies": {
                "pypdf": pypdf.__version__,
                "pdfplumber": pdfplumber.__version__,
                "pypdfium2": getattr(pypdfium2, "__version__", "unknown"),
            },
            "methods": [
                "health", "inspect", "extract", "extract_tables", "render_page",
                "rotate_pages", "reorder_pages", "merge", "split", "export_html", "reflow",
            ],
        }

    def input_path(key: str = "input") -> Path:
        return resolve_workspace_path(workspace, params.get(key, ""), must_exist=True)

    def output_path(key: str = "output") -> Path:
        return resolve_workspace_path(workspace, params.get(key, ""), must_exist=False)

    if method == "inspect":
        return inspect_pdf(input_path())
    if method == "extract":
        document = extract_document(
            input_path(),
            selected_pages=params.get("pages"),
            include_words=bool(params.get("include_words", False)),
            include_tables=bool(params.get("include_tables", False)),
        )
        return document.to_dict()
    if method == "extract_tables":
        return extract_tables(input_path(), params.get("pages"))
    if method == "render_page":
        return render_page(
            input_path(), output_path(), int(params.get("page", 0)), float(params.get("scale", 1.5))
        )
    if method == "rotate_pages":
        return rotate_pages(input_path(), output_path(), params.get("rotations", {}))
    if method == "reorder_pages":
        return reorder_pages(input_path(), output_path(), params.get("order", []))
    if method == "merge":
        inputs = params.get("inputs", [])
        if not isinstance(inputs, list):
            raise InvalidRequest("inputs must be an array of workspace-relative paths.")
        paths = [resolve_workspace_path(workspace, value, must_exist=True) for value in inputs]
        return merge_pdfs(paths, output_path())
    if method == "split":
        return split_pdf(input_path(), output_path("output_dir"))
    if method in {"export_html", "reflow"}:
        return export_html(input_path(), output_path(), params.get("title"))
    raise InvalidRequest(f"Unknown method: {method}")


def serve(workspace: Path) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    workspace = workspace.resolve()
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = request.get("method")
            params = request.get("params") or {}
            if not isinstance(method, str) or not isinstance(params, dict):
                raise InvalidRequest("Request must contain string method and object params.")
            result = dispatch(method, params, workspace)
            response = {"id": request_id, "ok": True, "result": result}
        except (PdfEngineError, ValueError, TypeError, KeyError) as exc:
            response = {"id": request_id, "ok": False, "error": {"type": type(exc).__name__, "message": str(exc)}}
        except Exception:
            traceback.print_exc(file=sys.stderr)
            response = {"id": request_id, "ok": False, "error": {"type": "InternalError", "message": "PDF operation failed; see worker stderr."}}
        sys.stdout.write(json.dumps(response, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description="Local JSONL PDF engine")
    parser.add_argument("--workspace", required=True, help="Root directory for all input and output files")
    args = parser.parse_args()
    serve(Path(args.workspace))


if __name__ == "__main__":
    main()
