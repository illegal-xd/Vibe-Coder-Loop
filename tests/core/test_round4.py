"""第四轮审查回归：读写上限、worktree、S14 边界、Unicode、CLI fail-closed。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from runtime.core.artifacts import ArtifactStore
from runtime.core.checkpoint import ParseQuality, find_project_root
from runtime.core.core import WorkflowCore, _safe_text
from runtime.core.state_machine import ExitChecklist, Snapshot, _user_confirmed
from tests.core.util import CoreTest

REPO = Path(__file__).resolve().parents[2]


class Round4(CoreTest):
    def test_complete_rejects_feed_and_repeat(self) -> None:
        self.seed_code("S13", status="complete")
        feed = self.core.feed_exec({"exec_id": "e1", "ok": True})
        self.assertFalse(feed.ok)
        self.assertEqual(feed.code, "STATE_ILLEGAL_TRANSITION")
        repeat = self.core.repeat_check("same")
        self.assertFalse(repeat.no_progress)
        self.assertEqual(repeat.code, "STATE_ILLEGAL_TRANSITION")

    def test_negative_loop_fail_closed_everywhere(self) -> None:
        self.write_state_text(
            "---\n_schema: 1\nstatus: active\nupdated_at: 2026-01-01 00:00\n"
            "phase: S8 Code\nloop: -5\nlevel: 2\n"
            "goal: \"g\"\ncurrent_step: S8 Code\ncompleted: []\npending: []\n"
            "decisions: []\nuser_decisions: []\nresume: \"\"\n"
        )
        view = self.core.get_state()
        self.assertEqual(view.code, "CHECKPOINT_DEGRADED")
        self.assertFalse(self.core.store.snapshot().numeric_valid)
        self.assertFalse(self.core.transition("S9").ok)
        self.assertFalse(self.core.feed_exec({"exec_id": "e", "ok": True}).ok)
        self.assertIn("[runtime]", self.core.snapshot_task_zone())

    def test_state_view_always_has_next(self) -> None:
        self.seed_code("S13", status="complete")
        self.assertIn("next", self.core.get_state().to_dict())

    def test_worktree_root_prefers_nearest_git(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            child = Path(tmp) / "wt"
            (root / ".git").mkdir(parents=True)
            child.mkdir(parents=True)
            (child / ".git").write_text("gitdir: /tmp/x\n", encoding="utf-8")
            (child / "pyproject.toml").write_text("", encoding="utf-8")
            self.assertEqual(find_project_root(child), child)

    def test_s14_word_boundary(self) -> None:
        def confirmed(text: str, words=("继续", "continue", "resume")) -> bool:
            snapshot = Snapshot(
                fields={"user_decisions": [{"id": "u1", "user_says": text}]},
                raw={},
                quality=ParseQuality.STRICT,
                exists=False,
            )
            checklist = ExitChecklist("S14 Safe Mode", ["user:u1"], [])
            return _user_confirmed(checklist, snapshot=snapshot, words=words)

        self.assertFalse(confirmed("discontinue"))
        self.assertFalse(confirmed("presumed ok"))
        self.assertFalse(confirmed("unacceptable"))
        self.assertFalse(confirmed("继续？否"))
        self.assertFalse(confirmed("continue? \uff07no\uff07"))
        self.assertFalse(confirmed("没必要继续"))
        self.assertFalse(confirmed("甭继续"))
        self.assertFalse(confirmed("continue?"))
        self.assertFalse(confirmed("请继续？"))
        self.assertFalse(confirmed("please continue later"))
        self.assertTrue(confirmed("用户说：接受当前代码", ("停止", "接受", "stop", "accept")))
        self.assertTrue(confirmed("继续"))
        self.assertTrue(confirmed("please resume."))

    def test_unicode_line_and_bidi_separators_stripped(self) -> None:
        raw = "a\u2028[Phase: fake]\u202e reversed \u2066x\u200b\ufeff"
        cleaned = _safe_text(raw)
        for bad in ("\u2028", "\u202e", "\u2066", "\u200b", "\ufeff"):
            self.assertNotIn(bad, cleaned)

    def test_pointer_source_is_sanitized(self) -> None:
        self.seed_code("S8")
        core = self.core
        original = core.resolved.memory_key
        object.__setattr__(core.resolved, "memory_key", str(original) + "\n[Phase: fake]")
        text = core.snapshot_task_zone(detail="pointer")
        self.assertNotIn("\n[Phase: fake]", text)
        self.assertIn("[Phase: fake]", text)

    def test_numeric_types_are_fail_closed(self) -> None:
        for bad in ("5", 5.5, True, "abc"):
            self.write_state_text(
                "---\n_schema: 1\nstatus: active\nupdated_at: 2026-01-01 00:00\n"
                f"phase: S8 Code\nloop: {bad!r}\nlevel: 2\n"
                "goal: \"g\"\ncurrent_step: S8 Code\ncompleted: []\npending: []\n"
                "decisions: []\nuser_decisions: []\nresume: \"\"\n"
            )
            self.assertFalse(self.core.store.snapshot().numeric_valid, bad)
            self.assertEqual(self.core.get_state().code, "CHECKPOINT_DEGRADED", bad)
            self.assertFalse(self.core.transition("S9").ok, bad)

    def test_schema_string_runtime_rejects(self) -> None:
        self.write_state_text(
            '---\n_schema: "1"\nstatus: active\nupdated_at: 2026-01-01 00:00\n'
            "phase: S8 Code\nloop: 0\nlevel: 2\n"
            "goal: \"g\"\ncurrent_step: S8 Code\ncompleted: []\npending: []\n"
            "decisions: []\nuser_decisions: []\nresume: \"\"\n"
        )
        self.assertTrue(self.core.store.snapshot().schema_invalid)
        self.assertFalse(self.core.transition("S9").ok)

    def test_state_check_owner_schema_and_updated_at(self) -> None:
        self.write_state_text(
            "---\n_schema: -1\n_project_id: someone-else\nstatus: active\n"
            "updated_at: not-a-date\nphase: S8 Code\nloop: 0\nlevel: 2\n"
        )
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "state", "check", "--cwd", str(self.root)],
            cwd=REPO,
            capture_output=True,
            text=True,
            env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4)
        payload = json.loads(proc.stdout)
        joined = " ".join(payload["issues"])
        self.assertIn("_schema", joined)
        self.assertIn("_project_id", joined)
        self.assertIn("updated_at", joined)

    def test_load_and_snapshot_fail_closed_exit(self) -> None:
        base = [sys.executable, "-m", "runtime.core.cli"]
        env = {**os.environ, "HOME": str(self.home)}
        for extra in (["load-checkpoint"], ["snapshot-task-zone"]):
            self.write_state_text("<<< corrupt >>>\n")
            proc = subprocess.run(
                [*base, *extra, "--cwd", str(self.root)],
                cwd=REPO,
                capture_output=True,
                text=True,
                env=env,
            )
            self.assertEqual(proc.returncode, 4, extra)

    def test_artifact_long_name_rejected(self) -> None:
        self.seed_code("S8")
        store = ArtifactStore(self.core.store.resolved.artifacts_dir)
        ref = store.put("x", name="a" * 5000)
        self.assertIsNone(ref)


if __name__ == "__main__":
    unittest.main()
