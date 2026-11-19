from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter

from pdf_engine.engine import reorder_pages, rotate_pages, split_pdf
from pdf_engine.errors import InvalidRequest


def make_pdf(path: Path, count: int = 3) -> None:
    writer = PdfWriter()
    for _ in range(count):
        writer.add_blank_page(width=300, height=400)
    with path.open("wb") as stream:
        writer.write(stream)


def test_reorder_pages_writes_new_pdf(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    output = tmp_path / "reordered.pdf"
    make_pdf(source)
    result = reorder_pages(source, output, [2, 0, 1])
    assert result["page_count"] == 3
    assert len(PdfReader(str(output)).pages) == 3


def test_reorder_requires_complete_permutation(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    make_pdf(source)
    with pytest.raises(InvalidRequest):
        reorder_pages(source, tmp_path / "bad.pdf", [0, 0, 1])


def test_rotate_pages_and_split(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    rotated = tmp_path / "rotated.pdf"
    make_pdf(source, 2)
    rotate_pages(source, rotated, {"1": 90})
    assert int(PdfReader(str(rotated)).pages[1].get("/Rotate", 0)) == 90
    result = split_pdf(rotated, tmp_path / "split")
    assert result["page_count"] == 2
    assert all(Path(path).exists() for path in result["outputs"])
