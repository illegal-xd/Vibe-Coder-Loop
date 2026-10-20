"""Exec 层测试工具。"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path


class ExecTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="vibe_exec_")
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _git(self, *args: str) -> str:
        import subprocess

        env = dict(os.environ)
        env["GIT_AUTHOR_NAME"] = env["GIT_COMMITTER_NAME"] = "t"
        env["GIT_AUTHOR_EMAIL"] = env["GIT_COMMITTER_EMAIL"] = "t@t.t"
        r = subprocess.run(
            ["git", *args], cwd=self.tmp, capture_output=True, text=True, env=env
        )
        return r.stdout

    def init_git_repo(self) -> None:
        self._git("init", "-q")
        self._git("config", "user.email", "t@t.t")
        self._git("config", "user.name", "t")
