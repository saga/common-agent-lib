from pathlib import Path

import pytest

from pdf_engine.errors import UnsafePath
from pdf_engine.paths import resolve_workspace_path


def test_resolves_relative_path_inside_workspace(tmp_path: Path) -> None:
    (tmp_path / "input.pdf").write_bytes(b"%PDF")
    assert resolve_workspace_path(tmp_path, "input.pdf", must_exist=True) == tmp_path / "input.pdf"


def test_rejects_absolute_path(tmp_path: Path) -> None:
    with pytest.raises(UnsafePath):
        resolve_workspace_path(tmp_path, str(tmp_path / "input.pdf"), must_exist=False)


def test_rejects_parent_traversal(tmp_path: Path) -> None:
    with pytest.raises(UnsafePath):
        resolve_workspace_path(tmp_path, "../outside.pdf", must_exist=False)
