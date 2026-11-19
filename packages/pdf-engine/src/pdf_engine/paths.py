from pathlib import Path

from .errors import UnsafePath


def resolve_workspace_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
    if not value or not isinstance(value, str):
        raise UnsafePath("A non-empty relative path is required.")
    candidate = Path(value)
    if candidate.is_absolute():
        raise UnsafePath("Absolute paths are not accepted; use a workspace-relative path.")
    root = workspace.resolve()
    resolved = (root / candidate).resolve(strict=must_exist)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise UnsafePath("Path escapes the configured workspace.") from exc
    if must_exist and not resolved.is_file():
        raise UnsafePath("Input path is not a regular file.")
    return resolved
