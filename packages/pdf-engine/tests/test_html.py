from pdf_engine.ast import DocumentNode, PageNode, TextBlock
from pdf_engine.engine import document_to_html


def test_html_escapes_untrusted_pdf_text() -> None:
    document = DocumentNode(
        title="<script>alert(1)</script>",
        source_name="sample.pdf",
        page_count=1,
        pages=[PageNode(
            index=0, width=595, height=842, rotation=0, text="",
            blocks=[TextBlock(
                id="p1-b1", text="<img src=x onerror=alert(1)>",
                bbox={"x0": 1, "top": 1, "x1": 10, "bottom": 10},
            )],
        )],
    )
    html = document_to_html(document)
    assert "<script>" not in html
    assert "&lt;img" in html
