from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class TextBlock:
    id: str
    text: str
    bbox: dict[str, float]
    font_size: float | None = None
    font_names: list[str] = field(default_factory=list)
    bold: bool | None = None
    source_page: int = 0
    confidence: str = "heuristic"


@dataclass
class Word:
    text: str
    bbox: dict[str, float]


@dataclass
class TableBlock:
    bbox: dict[str, float] | None
    rows: list[list[str]]


@dataclass
class PageNode:
    index: int
    width: float
    height: float
    rotation: int
    text: str
    blocks: list[TextBlock] = field(default_factory=list)
    words: list[Word] = field(default_factory=list)
    tables: list[TableBlock] = field(default_factory=list)


@dataclass
class DocumentNode:
    title: str
    source_name: str
    page_count: int
    pages: list[PageNode]
    metadata: dict[str, Any] = field(default_factory=dict)
    extraction_notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
