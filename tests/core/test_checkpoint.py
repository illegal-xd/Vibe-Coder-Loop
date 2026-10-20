from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from runtime.core import WorkflowCore
from runtime.core.checkpoint import (
    STATE_SCHEMA_VERSION,
    CheckpointLocationError,
    StateResolver,
    now_to_minute,
)
from runtime.core.state_machine import STATE_LABELS

from .util import CoreTest


class CheckpointLocationTests(CoreTest):
    def test_default_path_and_project_id(self) -> None:
        self.seed()
        self.assertEqual(self.state_path, self.root.resolve() / ".vibe-kernel" / ".state.md")
        self.assertTrue(self.state_path.exists())
        raw = self.state_path.read_text(encoding="utf-8")
        self.assertIn("_project_id", raw)
        self.assertEqual(self.core.get_state().rev, 1)

    def test_directory_permissions_and_gitignore(self) -> None:
        self.seed()
        if os.name != "nt":
            self.assertEqual(self.core.resolved.state_dir.stat().st_mode & 0o777, 0o700)
        gitignore = (self.root / ".gitignore").read_text(encoding="utf-8")
        self.assertIn(".vibe-kernel/", gitignore)
        # 二次写入不重复追加
        self.seed()
        self.assertEqual((self.root / ".gitignore").read_text(encoding="utf-8").count(".vibe-kernel/"), 1)

    def test_rev_conflict_preserves_other_writer(self) -> None:
        first = self.seed()
        stale_rev = first.rev
        other = self.core.store.write({"phase": STATE_LABELS["S2"]})
        self.assertTrue(other.ok)
        before = self.state_path.read_bytes()
        conflict = self.core.store.write({"phase": STATE_LABELS["S3"]}, expected_rev=stale_rev)
        self.assertFalse(conflict.ok)
        self.assertEqual(conflict.code, "STATE_REV_CONFLICT")
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_append_merge_is_ordered_union(self) -> None:
        self.seed(completed=["a"])
        self.core.store.write({"completed": ["b"]})
        fields = self.core.store.snapshot().fields
        self.assertEqual(fields["completed"], ["a", "b"])
        self.core.store.write({"completed": ["b", "c"]})
        self.assertEqual(self.core.store.snapshot().fields["completed"], ["a", "b", "c"])

    def test_pending_is_replace_not_union(self) -> None:
        self.seed(pending=["old"])
        self.core.store.write({"pending": []})
        self.assertEqual(self.core.store.snapshot().fields["pending"], [])

    def test_unknown_keys_passthrough(self) -> None:
        self.seed(custom={"keep": ["x", 1]})
        self.core.store.write({"phase": STATE_LABELS["S2"]})
        raw = self.core.store.snapshot().raw
        self.assertEqual(raw["custom"], {"keep": ["x", 1]})

    def test_no_op_write_does_not_bump_rev(self) -> None:
        first = self.seed()
        second = self.core.store.write({"phase": STATE_LABELS["S0"]})
        self.assertTrue(second.ok)
        self.assertFalse(second.changed)
        self.assertEqual(second.rev, first.rev)

    def test_symlink_same_project(self) -> None:
        link = Path(self._tmp.name + "-link")
        if link.exists():
            link.unlink()
        try:
            link.symlink_to(self.root)
        except OSError:
            self.skipTest("平台不支持软链")
        try:
            other = WorkflowCore(link, env=self.env, import_legacy=False)
            self.assertEqual(other.resolved.state_path, self.core.resolved.state_path)
            self.assertEqual(other.resolved.project_id, self.core.resolved.project_id)
        finally:
            link.unlink()

    def test_path_with_spaces_and_unicode(self) -> None:
        special = Path(self._tmp.name) / "项目 空格"
        special.mkdir()
        (special / ".git").mkdir()
        core = WorkflowCore(special, env=self.env, import_legacy=False)
        result = core.store.write({"phase": "S0 Idle"})
        self.assertTrue(result.ok)
        self.assertTrue(core.resolved.state_path.exists())

    def test_highest_project_marker_wins(self) -> None:
        child = self.root / "pkg"
        child.mkdir()
        (child / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        resolved = StateResolver(self.env).resolve(child)
        self.assertEqual(resolved.project_root, self.root.resolve())
        self.assertEqual(resolved.state_path, self.root.resolve() / ".vibe-kernel" / ".state.md")

    def test_reject_state_inside_skill_dir(self) -> None:
        skill = Path(self._tmp.name) / "fake-skill"
        skill.mkdir()
        (skill / "SKILL.md").write_text("# skill\n", encoding="utf-8")
        env = {"HOME": str(self.home), "VIBE_KERNEL_SKILL_DIR": str(skill)}
        with self.assertRaises(CheckpointLocationError) as ctx:
            WorkflowCore(
                self.root,
                env=env,
                import_legacy=False,
                state_dir=skill / ".vibe-kernel",
            )
        self.assertEqual(ctx.exception.code, "CHECKPOINT_LOCATION_UNRESOLVED")

    def test_legacy_import_only_read_once(self) -> None:
        skill = self.home / ".agents" / "skills" / "vibe-coder-loop"
        skill.mkdir(parents=True)
        legacy = skill / ".state.md"
        legacy.write_text(
            "---\n"
            f"_schema: {STATE_SCHEMA_VERSION}\n"
            "status: active\n"
            f"updated_at: {now_to_minute()}\n"
            "phase: S2 Preflight\n"
            "loop: 1\n"
            "level: 2\n"
            "goal:\n  explicit: x\n  constraints: []\n  risk: []\n"
            "current_step: step\n"
            "completed: []\n"
            "pending: []\n"
            "decisions: []\n"
            "review:\n  result: none\n  last_review: none\n  last_failure: none\n  issues: []\n"
            "user_decisions: []\n"
            "resume: r\n",
            encoding="utf-8",
        )
        core = WorkflowCore(self.root, env={"HOME": str(self.home)}, import_legacy=True)
        result = core.load_checkpoint()
        self.assertEqual(result.mode, "resume")
        self.assertIsNotNone(result.legacy_import)
        self.assertTrue(self.state_path.exists())
        self.assertFalse(legacy.exists())
        self.assertTrue(any(skill.glob(".state.md.legacy-*")))

    def test_tracked_by_git_warning(self) -> None:
        self.seed()
        import subprocess

        subprocess.run(["git", "-C", str(self.root), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(self.root), "add", "-f", ".vibe-kernel/.state.md"], check=True)
        result = self.core.store.write({"phase": STATE_LABELS["S1"]})
        self.assertIn("STATE_TRACKED_BY_GIT", result.warnings)


if __name__ == "__main__":
    unittest.main()
