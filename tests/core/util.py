"""Shared test helpers for runtime/core."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from typing import Any

from runtime.core import WorkflowCore
from runtime.core.checkpoint import STATE_SCHEMA_VERSION, now_to_minute
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

    @property
    def state_path(self) -> Path:
        return self.core.resolved.state_path

    def raw_state(self) -> str:
        return self.state_path.read_text(encoding="utf-8")
