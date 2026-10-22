from __future__ import annotations

import hashlib
import subprocess
import unittest
from pathlib import Path

from runtime.core.recovery import age_minutes, verify_pending

from .util import CoreTest


def _state_text(**overrides: str) -> str:
    base = {
        "_schema": 1,
        "status": "active",
        "updated_at": "2026-10-20 08:55",
        "phase": "S2 Preflight",
        "loop": "1",
        "level": "2",
        "goal": "\n  explicit: x\n  constraints: []\n  risk: []",
        "current_step": "step",
        "completed": "[]",
        "pending": "[]",
        "decisions": "[]",
        "review": "\n  result: none\n  last_review: none\n  last_failure: none\n  issues: []",
        "user_decisions": "[]",
        "resume": "r",
    }
    base.update(overrides)
    lines = ["---"]
    for key, value in base.items():
        value = str(value)
        if value.startswith("\n"):
            lines.append(f"{key}:{value}")
        else:
            lines.append(f"{key}: {value}")
    return "\n".join(lines) + "\n"


class RecoveryTests(CoreTest):
    def _write(self, text: str) -> None:
        self.write_state_text(text)

    def test_no_checkpoint(self) -> None:
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "fresh_start")
        self.assertFalse(self.state_exists())

    def test_fresh_active_resume(self) -> None:
        self.seed_code("S8", loop=1)
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "resume")
        self.assertEqual(result.phase, "S8 Code")
        self.assertEqual(result.loop, 1)
        self.assertEqual(result.rev, 1)

    def test_paused_resume_preserves_status(self) -> None:
        self.seed_code("S8", loop=1, status="paused")
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "resume")
        self.assertEqual(result.status, "paused")

    def test_v7_stale(self) -> None:
        self._write(_state_text(updated_at="2020-01-01 00:00", phase="S8 Code", loop="1"))
        result = self.core.load_checkpoint(expected_age_minutes=60)
        self.assertEqual(result.mode, "resume_stale")
        self.assertEqual(result.code, "CHECKPOINT_STALE")
        self.assertGreater(age_minutes("2020-01-01 00:00") or 0, 60)

    def test_v8_corrupt_backed_up(self) -> None:
        self._write("<<< definitely not yaml >>>\n")
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "fresh_start")
        self.assertEqual(result.code, "CHECKPOINT_CORRUPT")
        archives = self.archive_keys("corrupt")
        self.assertEqual(len(archives), 1)
        entry = self.core.store.memory.get(archives[0])
        assert entry is not None
        self.assertIn("definitely not yaml", entry.value)
        self.assertIsNone(self.state_text())

    def test_degraded_restores_only_flat_scalars(self) -> None:
        self._write(
            "---\nstatus: active\nphase: S8 Code\nloop: 1\nlevel: 2\n"
            "updated_at: 2026-10-20 08:55\ncompleted: [unparsable\n"
        )
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "resume_degraded")
        self.assertEqual(result.code, "CHECKPOINT_DEGRADED")
        self.assertEqual(result.phase, "S8 Code")
        self.assertEqual(result.loop, 1)
        self.assertEqual(result.completed, [])

    def test_missing_required_fields_reference_only(self) -> None:
        self._write("---\nstatus: active\nphase: S1 Intent\n")
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "reference_only")
        self.assertEqual(result.code, "CHECKPOINT_DEGRADED")
        self.assertIn("loop", result.missing)

    def test_complete_not_resumed(self) -> None:
        self.seed_code("S13", status="complete")
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "reference_only")
        self.assertIn("complete", result.reason)

    def test_foreign_project_backed_up(self) -> None:
        self._write(_state_text(_project_id="deadbeefdeadbeef"))
        before = self.state_text()
        denied = self.core.transition("S3")
        self.assertEqual(denied.code, "CHECKPOINT_FOREIGN")
        self.assertEqual(self.state_text(), before)
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "reference_only")
        self.assertEqual(result.code, "CHECKPOINT_FOREIGN")
        self.assertEqual(self.state_text(), before)

    def test_v18_schema_ahead_read_only(self) -> None:
        self._write(_state_text(_schema="2"))
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "reference_only")
        self.assertEqual(result.code, "CHECKPOINT_SCHEMA_AHEAD")
        self.assertTrue(self.state_exists())
        before = self.state_text()
        denied = self.core.transition("S3")
        self.assertEqual(denied.code, "CHECKPOINT_SCHEMA_AHEAD")
        self.assertEqual(self.state_text(), before)

    def test_invalid_updated_at_degraded(self) -> None:
        self._write(_state_text(updated_at="not-a-date", phase="S8 Code", loop="1"))
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "reference_only")
        self.assertEqual(result.code, "CHECKPOINT_DEGRADED")

    def test_v9_pending_strong_evidence_sha(self) -> None:
        (self.root / "a.py").write_text("hello\n", encoding="utf-8")
        digest = hashlib.sha256(b"hello\n").hexdigest()
        checks = verify_pending(
            [f"path: a.py sha256:{digest}"],
            project_root=self.root,
        )
        self.assertEqual(checks[0].state, "verified")
        self.assertTrue(checks[0].move_to_completed)

    def test_v10_pending_weak_evidence_not_completed(self) -> None:
        (self.root / "a.py").write_text("hello\n", encoding="utf-8")
        checks = verify_pending(["path: a.py"], project_root=self.root)
        self.assertEqual(checks[0].state, "unverified")
        self.assertFalse(checks[0].move_to_completed)

    def test_v11_pending_no_clue(self) -> None:
        checks = verify_pending(["写文档并人工确认"], project_root=self.root)
        self.assertEqual(checks[0].state, "still_pending")
        self.assertFalse(checks[0].move_to_completed)

    def test_pending_git_commit_after_round_start(self) -> None:
        subprocess.run(["git", "-C", str(self.root), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(self.root), "config", "user.email", "tester@local"], check=True)
        subprocess.run(["git", "-C", str(self.root), "config", "user.name", "T"], check=True)
        (self.root / "a.py").write_text("x\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.root), "add", "a.py"], check=True)
        subprocess.run(["git", "-C", str(self.root), "commit", "-qm", "c"], check=True)
        checks = verify_pending(
            ["path: a.py"],
            project_root=self.root,
            round_started_at="2000-01-01 00:00",
        )
        self.assertEqual(checks[0].state, "verified")

    def test_pending_absolute_path_ignored(self) -> None:
        checks = verify_pending(["path: /etc/hosts"], project_root=self.root)
        self.assertEqual(checks[0].state, "still_pending")
        self.assertTrue(any("ignored" in item for item in checks[0].evidence))

    def test_pending_exec_command_evidence(self) -> None:
        checks = verify_pending(
            ["cmd: pytest tests/x.py"],
            project_root=self.root,
            exec_results={"pytest tests/x.py": True},
        )
        self.assertEqual(checks[0].state, "verified")

    def test_v24_artifact_missing_does_not_block_recovery(self) -> None:
        self.seed_code(
            "S8",
            review={
                "result": "failed",
                "last_review": "none",
                "last_failure": "boom",
                "issues": [],
                "last_failure_ref": {
                    "tier": "pinned",
                    "ref": "artifacts/deadbeef00000000.log",
                    "sha256": "0" * 64,
                    "reproducible": True,
                    "regen_cmd": ["pytest", "-x"],
                },
            },
        )
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "resume")
        self.assertEqual(len(result.artifact_missing), 1)
        self.assertEqual(result.artifact_missing[0]["regen_cmd"], ["pytest", "-x"])

    def test_artifact_ephemeral_unverified_without_index(self) -> None:
        self.seed_code(
            "S8",
            review={
                "result": "failed",
                "last_review": "none",
                "last_failure": "boom",
                "issues": [],
                "last_failure_ref": {"tier": "ephemeral", "ref": "b3f1"},
            },
        )
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "resume")
        self.assertEqual(len(result.artifact_unverified), 1)


if __name__ == "__main__":
    unittest.main()
