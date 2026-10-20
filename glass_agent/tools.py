"""Small read-only workspace tool set."""

import os
from pathlib import Path
from typing import List

from .core import Tool


def workspace_tools(workspace: Path) -> List[Tool]:
    root = Path(workspace).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("workspace must be a directory")

    def list_files(_arguments: dict) -> str:
        found = []
        for directory, subdirs, files in os.walk(root, followlinks=False):
            subdirs[:] = sorted(d for d in subdirs if not d.startswith(".") and d not in ("node_modules", "__pycache__", "venv"))
            for name in sorted(files):
                if name.startswith("."):
                    continue
                path = Path(directory, name)
                if path.is_symlink():
                    continue
                found.append(path.relative_to(root).as_posix())
                if len(found) >= 100:
                    return "\n".join(found) + "\n[only first 100 files shown]"
        return "\n".join(found) if found else "(no visible files)"

    def read_file(arguments: dict) -> str:
        requested = Path(arguments["path"])
        if requested.is_absolute() or any(part.startswith(".") for part in requested.parts):
            raise ValueError("path must be a visible file inside the workspace")
        path = (root / requested).resolve()
        try:
            relative = path.relative_to(root)
        except ValueError:
            raise ValueError("path leaves the workspace") from None
        if any(part.startswith(".") for part in relative.parts):
            raise ValueError("hidden files are not available")
        if not path.is_file():
            raise ValueError("file not found")
        if path.stat().st_size > 65536:
            raise ValueError("file is larger than 64 KiB")
        try:
            return path.read_text(encoding="utf-8")
        except UnicodeError:
            raise ValueError("file is not UTF-8 text") from None

    return [
        Tool(
            name="list_files",
            description="List up to 100 visible files in the workspace, excluding hidden and dependency directories.",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            execute=list_files,
        ),
        Tool(
            name="read_file",
            description="Read one visible UTF-8 text file (up to 64 KiB) inside the workspace.",
            parameters={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False},
            execute=read_file,
        ),
    ]
