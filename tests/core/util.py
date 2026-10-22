"""Shared test helpers for runtime/core."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from runtime.core import WorkflowCore
from runtime.core.checkpoint import STATE_SCHEMA_VERSION, now_to_minute
from runtime.core.memory_store import CHECKPOINT_QUARANTINE_PREFIX
from runtime.core.state_machine import STATE_LABELS


class CoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / ".git").mkdir()
        self.home = self.root / "home"
        self.home.mkdir()
        self.env = {"HOME": str(self.home)}
        self.core = WorkflowCore(
            self.root,
            env=self.env,
            import_legacy=False,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # -- seeding ---------------------------------------------------------
    def seed(
        self,
        *,
        phase: str = "S0 Idle",
        loop: int = 0,
        level: int = 2,
        status: str = "active",
        **extra: Any,
    ):
        fields: dict[str, Any] = {
            "_schema": STATE_SCHEMA_VERSION,
            "status": status,
            "updated_at": now_to_minute(),
            "phase": phase,
            "loop": loop,
            "level": level,
        }
        fields.update(extra)
        return self.core.store.write(fields)

    def seed_code(self, code: str, *, loop: int = 0, level: int = 2, **extra: Any):
        return self.seed(phase=STATE_LABELS[code], loop=loop, level=level, **extra)

    def t(self, to: str, **kwargs: Any):
        return self.core.transition(to, **kwargs)

    # -- checkpoint state (delx-memory) ----------------------------------
    @property
    def state_key(self) -> str:
        return self.core.resolved.memory_key

    def state_exists(self) -> bool:
        return self.core.store.memory.get(self.state_key) is not None

    def state_text(self) -> str | None:
        entry = self.core.store.memory.get(self.state_key)
        return None if entry is None else entry.value

    def write_state_text(self, text: str, *, core: WorkflowCore | None = None) -> None:
        """直接改记忆条目（模拟外部写入 / 损坏数据）。"""
        target = core or self.core
        target.store.memory.set(target.resolved.memory_key, text)

    def raw_state(self) -> str:
        text = self.state_text()
        return "" if text is None else text

    def archive_keys(self, kind: str, *, core: WorkflowCore | None = None) -> list[str]:
        target = core or self.core
        prefix = f"{CHECKPOINT_QUARANTINE_PREFIX}{target.resolved.project_id}:{kind}:"
        return target.store.memory.keys(prefix)
