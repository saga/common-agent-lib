class PdfEngineError(Exception):
    """Expected, safe-to-return PDF engine error."""


class InvalidRequest(PdfEngineError):
    pass


class UnsafePath(PdfEngineError):
    pass
