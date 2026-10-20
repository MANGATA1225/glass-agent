"""Small, local, atomic session snapshots. No credentials are stored here."""

import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from .core import Agent


class SessionStore:
    def __init__(self, path: Path, workspace: Path, provider: str, model: str) -> None:
        self.path = path.expanduser().absolute()
        self.workspace = str(workspace.resolve())
        self.provider = provider
        self.model = model

    @staticmethod
    def new_path(workspace: Path) -> Path:
        return workspace.resolve() / ".glass-agent" / "sessions" / (str(uuid.uuid4()) + ".json")

    @staticmethod
    def latest_path(workspace: Path) -> Path:
        directory = workspace.resolve() / ".glass-agent" / "sessions"
        if directory.is_symlink() or directory.parent.is_symlink():
            raise ValueError("session directory must not be a symbolic link")
        sessions = [path for path in directory.glob("*.json") if path.is_file() and not path.is_symlink()]
        if not sessions:
            raise ValueError("no saved session in this workspace")
        return max(sessions, key=lambda path: path.stat().st_mtime)

    def load(self, agent: Agent) -> None:
        self._check_links()
        if not self.path.exists():
            return
        if self.path.stat().st_size > 64 * 1024 * 1024:
            raise ValueError("session file is too large")
        with self.path.open("r", encoding="utf-8") as stream:
            state: Dict[str, Any] = json.load(stream)
        if state.get("version") != 1 or any(state.get(key) != value for key, value in (
            ("workspace", self.workspace), ("provider", self.provider), ("model", self.model)
        )):
            raise ValueError("session workspace, provider, or model does not match")
        history = state.get("history")
        summary = state.get("summary")
        kept = state.get("first_kept_index")
        if (not isinstance(history, list) or not all(isinstance(item, dict) for item in history)
                or not isinstance(summary, str) or type(kept) is not int or not 0 <= kept <= len(history)
                or kept < len(history) and history[kept].get("role") != "user"):
            raise ValueError("session file has an invalid conversation")
        remote_session_id = state.get("remote_session_id")
        if remote_session_id is not None and hasattr(agent.model, "session_id"):
            if not isinstance(remote_session_id, str) or not remote_session_id:
                raise ValueError("session file has an invalid remote session ID")
            agent.model.session_id = remote_session_id
        agent.history = history
        agent.summary = summary
        agent.first_kept_index = kept

    def _check_links(self) -> None:
        if any(part.is_symlink() for part in (self.path, *self.path.parents)):
            raise ValueError("session path must not contain a symbolic link")

    def save(self, agent: Agent) -> None:
        self._check_links()
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._check_links()
        state = {
            "version": 1, "workspace": self.workspace, "provider": self.provider,
            "model": self.model, "history": agent.history, "summary": agent.summary,
            "first_kept_index": agent.first_kept_index,
        }
        if hasattr(agent.model, "session_id"):
            state["remote_session_id"] = agent.model.session_id
        temporary: Optional[str] = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=parent, prefix=".session-",
                                             suffix=".tmp", delete=False) as stream:
                temporary = stream.name
                os.chmod(temporary, 0o600)
                json.dump(state, stream, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
