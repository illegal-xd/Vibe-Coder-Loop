from __future__ import annotations

import os
import unittest
from pathlib import Path

from runtime.core import WorkflowCore
from runtime.core.checkpoint import (
    STATE_SCHEMA_VERSION,
    CheckpointLocationError,
    StateResolver,
    now_to_minute,
)
from runtime.core.memory_store import CHECKPOINT_KEY_PREFIX, CHECKPOINT_TAGS
from runtime.core.state_machine import STATE_LABELS

from .util import CoreTest


class CheckpointLocationTests(CoreTest):
    def test_default_memory_key_and_project_id(self) -> None:
        self.seed()
        project_real = str(self.root.resolve())
        self.assertEqual(self.core.resolved.memory_key, f"{CHECKPOINT_KEY_PREFIX}{project_real}")
        self.assertTrue(self.state_exists())
        raw = self.raw_state()
        self.assertIn("_project_id", raw)
        self.assertEqual(self.core.get_state().rev, 1)

    def test_no_project_directory_created(self) -> None:
        self.seed()
        self.assertFalse((self.root / ".vibe-kernel").exists())
        self.assertFalse((self.root / ".gitignore").exists())

    def test_entry_tags_and_l0_metadata(self) -> None:
        self.seed()
        entry = self.core.store.memory.get(self.state_key)
        assert entry is not None
        for tag in CHECKPOINT_TAGS:
            self.assertIn(tag, entry.tags)
        self.assertEqual(entry.metadata.get("layer"), "L0")
        self.assertEqual(entry.metadata.get("scope"), "project")
        self.assertEqual(entry.metadata.get("project_id"), self.core.resolved.project_id)

    def test_rev_conflict_preserves_other_writer(self) -> None:
        first = self.seed()
        stale_rev = first.rev
        other = self.core.store.write({"phase": STATE_LABELS["S2"]})
        self.assertTrue(other.ok)
        before = self.state_text()
        conflict = self.core.store.write({"phase": STATE_LABELS["S3"]}, expected_rev=stale_rev)
        self.assertFalse(conflict.ok)
        self.assertEqual(conflict.code, "STATE_REV_CONFLICT")
        self.assertEqual(self.state_text(), before)

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
            self.assertEqual(other.resolved.memory_key, self.core.resolved.memory_key)
            self.assertEqual(other.resolved.project_id, self.core.resolved.project_id)
        finally:
            link.unlink()

    def test_path_with_spaces_and_unicode(self) -> None:
        special = Path(self._tmp.name) / "项目 空格"
        special.mkdir()
        (special / ".git").mkdir()
        core = WorkflowCore(special, env=self.env, import_legacy=False)
        result = core.store.write({"phase": "S0 Idle", "status": "active"})
        self.assertTrue(result.ok)
        self.assertIsNotNone(core.store.memory.get(core.resolved.memory_key))
        self.assertFalse((special / ".vibe-kernel").exists())

    def test_highest_project_marker_wins(self) -> None:
        child = self.root / "pkg"
        child.mkdir()
        (child / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        resolved = StateResolver(self.env).resolve(child)
        self.assertEqual(resolved.project_root, self.root.resolve())
        self.assertEqual(
            resolved.memory_key,
            f"{CHECKPOINT_KEY_PREFIX}{self.root.resolve()}",
        )

    def test_reject_non_checkpoint_memory_key(self) -> None:
        with self.assertRaises(CheckpointLocationError) as ctx:
            WorkflowCore(
                self.root,
                env=self.env,
                import_legacy=False,
                memory_key="skill:elsewhere",
            )
        self.assertEqual(ctx.exception.code, "CHECKPOINT_LOCATION_UNRESOLVED")

    def test_explicit_memory_db_override(self) -> None:
        custom = Path(self._tmp.name) / "custom" / "memory.sqlite"
        core = WorkflowCore(self.root, env=self.env, import_legacy=False, memory_db=custom)
        self.assertTrue(core.store.write({"phase": "S0 Idle", "status": "active"}).ok)
        self.assertTrue(custom.exists())

    def test_legacy_import_keeps_file(self) -> None:
        legacy_dir = self.root / ".vibe-kernel"
        legacy_dir.mkdir()
        legacy = legacy_dir / ".state.md"
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
        core = WorkflowCore(self.root, env=self.env, import_legacy=True)
        result = core.load_checkpoint()
        self.assertEqual(result.mode, "resume")
        self.assertIsNotNone(result.legacy_import)
        self.assertTrue(core.store.memory.get(core.resolved.memory_key) is not None)
        self.assertTrue(legacy.exists())
        self.assertFalse(any(legacy_dir.glob(".state.md.legacy-*")))

    def test_second_write_reuses_entry(self) -> None:
        self.seed()
        first = self.core.store.memory.get(self.state_key)
        self.seed()
        second = self.core.store.memory.get(self.state_key)
        assert first is not None and second is not None
        self.assertEqual(first.created_at, second.created_at)
        self.assertEqual(len(self.core.store.memory.keys(CHECKPOINT_KEY_PREFIX)), 1)


if __name__ == "__main__":
    unittest.main()
