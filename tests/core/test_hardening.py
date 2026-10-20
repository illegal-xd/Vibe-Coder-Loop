from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from runtime.core import WorkflowCore
from runtime.core.artifacts import ArtifactStore
from runtime.core.checkpoint import CheckpointLocationError, now_to_minute
from runtime.core.cli import main
from runtime.core.core import ExecResult
from runtime.core.state_parse import SubsetParseError, parse_subset, render_subset
from runtime.core.state_machine import STATE_LABELS, ExitChecklist

from .util import CoreTest
from .test_recovery import _state_text

REPO = Path(__file__).resolve().parents[2]


class UnknownPhaseHardening(CoreTest):
    def test_unknown_phase_rejected_without_write(self) -> None:
        for phase in ("Code", "S99 Bogus", ""):
            with self.subTest(phase=phase):
                self.seed(phase=phase)
                before = self.state_path.read_bytes()
                result = self.t("S1")
                self.assertFalse(result.ok)
                self.assertEqual(result.code, "STATE_ILLEGAL_TRANSITION")
                self.assertEqual(self.state_path.read_bytes(), before)

    def test_state_check_rejects_invalid_enums(self) -> None:
        self.seed(phase="S99 Bogus", level=99, loop=-5, status="weird")
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "state", "check", "--cwd", str(self.root)],
            cwd=REPO,
            capture_output=True,
            text=True,
            env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4)
        payload = json.loads(proc.stdout)
        self.assertFalse(payload["ok"])
        joined = " ".join(payload.get("issues", []))
        for needle in ("phase", "status", "loop", "level"):
            self.assertIn(needle, joined)


class CheckpointHardening(CoreTest):
    def test_corrupt_write_backs_up_and_refuses(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text("<<< corrupt >>>\n", encoding="utf-8")
        result = self.core.store.write({"phase": STATE_LABELS["S1"]})
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "CHECKPOINT_CORRUPT")
        self.assertFalse(self.state_path.exists())
        backups = list(self.state_path.parent.glob(".state.md.corrupt-*"))
        self.assertEqual(len(backups), 1)
        self.assertIn("corrupt", backups[0].read_text(encoding="utf-8"))

    def test_config_path_escape_rejected(self) -> None:
        config_dir = self.root / ".vibe-kernel"
        config_dir.mkdir()
        (config_dir / "config.json").write_text(
            json.dumps({"state_path": str(self.root.parent / "victim.txt")}),
            encoding="utf-8",
        )
        with self.assertRaises(CheckpointLocationError):
            WorkflowCore(self.root, env=self.env, import_legacy=False)
        (config_dir / "config.json").write_text(
            json.dumps({"state_path": "~/.zshrc"}), encoding="utf-8"
        )
        with self.assertRaises(CheckpointLocationError):
            WorkflowCore(self.root, env=self.env, import_legacy=False)

    def test_config_relative_path_allowed(self) -> None:
        config_dir = self.root / ".vibe-kernel"
        config_dir.mkdir()
        (config_dir / "config.json").write_text(
            json.dumps({"state_path": ".vibe-kernel/runtime/.state.md"}), encoding="utf-8"
        )
        core = WorkflowCore(self.root, env=self.env, import_legacy=False)
        self.assertEqual(core.resolved.state_path, self.root.resolve() / ".vibe-kernel" / "runtime" / ".state.md")

    def test_external_corrupt_state_is_copied_not_renamed(self) -> None:
        outside = Path(self._tmp.name) / "victim.txt"
        outside.write_text("PRECIOUS\n", encoding="utf-8")
        core = WorkflowCore(
            self.root,
            env=self.env,
            import_legacy=False,
            state_path=outside,
        )
        result = core.load_checkpoint()
        self.assertEqual(result.code, "CHECKPOINT_CORRUPT")
        self.assertTrue(outside.exists())
        self.assertEqual(outside.read_text(encoding="utf-8"), "PRECIOUS\n")
        backups = list(outside.parent.glob("victim.txt.corrupt-*"))
        self.assertEqual(len(backups), 1)

    @unittest.skipUnless(sys.platform == "darwin" or os.name == "nt", "大小写不敏感平台")
    def test_skill_dir_case_insensitive_bypass_blocked(self) -> None:
        skill = Path(self._tmp.name) / "CaseSkill"
        skill.mkdir()
        (skill / "SKILL.md").write_text("# skill\n", encoding="utf-8")
        env = {"HOME": str(self.home), "VIBE_KERNEL_SKILL_DIR": str(skill)}
        with self.assertRaises(CheckpointLocationError):
            WorkflowCore(
                self.root,
                env=env,
                import_legacy=False,
                state_dir=str(skill).upper(),
            )

    def test_gitignore_symlink_not_followed(self) -> None:
        target = Path(self._tmp.name) / "target.txt"
        target.write_text("KEEP-ME\n", encoding="utf-8")
        (self.root / ".gitignore").symlink_to(target)
        result = self.seed()
        self.assertEqual(target.read_text(encoding="utf-8"), "KEEP-ME\n")
        self.assertIn("gitignore_symlink_skipped", result.warnings)
        self.assertTrue((self.root / ".vibe-kernel" / ".gitignore").exists())

    def test_project_id_change_forces_write(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(_state_text(phase="S1 Intent", loop="0"), encoding="utf-8")
        result = self.core.store.write({"current_step": "keep"})
        self.assertTrue(result.ok)
        self.assertTrue(result.changed)
        self.assertTrue(self.core.store.snapshot().fields["_project_id"])

    def test_unknown_unicode_key_round_trip(self) -> None:
        self.core.store.write({"自定义键": {"值": [1, 2]}})
        self.core.store.write({"phase": STATE_LABELS["S2"]})
        raw = self.core.store.snapshot().raw
        self.assertEqual(raw["自定义键"], {"值": [1, 2]})


class PhaseGuardHardening(CoreTest):
    def _write_raw(self, **overrides: str) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(_state_text(**overrides), encoding="utf-8")

    def test_unknown_phase_rejected_in_all_read_paths(self) -> None:
        self._write_raw(phase="Code", loop="1")
        before = self.state_path.read_bytes()
        loaded = self.core.load_checkpoint()
        self.assertEqual(loaded.mode, "reference_only")
        self.assertEqual(loaded.code, "CHECKPOINT_DEGRADED")
        view = self.core.get_state()
        self.assertEqual(view.mode, "reference_only")
        self.assertEqual(view.code, "CHECKPOINT_DEGRADED")
        feed = self.core.feed_exec(ExecResult(exec_id="e1", ok=True))
        self.assertEqual(feed.code, "CHECKPOINT_DEGRADED")
        repeat = self.core.repeat_check("fp:x")
        self.assertEqual(repeat.code, "CHECKPOINT_DEGRADED")
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_non_utf8_state_is_corrupt_and_backed_up(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_bytes(b"\xff\xfe\x00")
        result = self.core.load_checkpoint()
        self.assertEqual(result.code, "CHECKPOINT_CORRUPT")
        self.assertFalse(self.state_path.exists())
        self.assertTrue(list(self.state_path.parent.glob(".state.md.corrupt-*")))

    @unittest.skipIf(os.name == "nt", "mkfifo 仅 POSIX")
    def test_state_file_fifo_does_not_block(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        os.mkfifo(self.state_path)
        result = self.core.load_checkpoint()
        self.assertEqual(result.code, "CHECKPOINT_CORRUPT")
        self.assertFalse(self.state_path.exists())

    def test_default_vibe_kernel_symlink_rejected(self) -> None:
        outside = Path(self._tmp.name) / "outside"
        outside.mkdir()
        (self.root / ".vibe-kernel").symlink_to(outside)
        with self.assertRaises(CheckpointLocationError):
            WorkflowCore(self.root, env=self.env, import_legacy=False)

    def test_existing_state_dir_permissions_not_changed(self) -> None:
        shared = Path(self._tmp.name) / "shared"
        shared.mkdir()
        os.chmod(shared, 0o755)
        core = WorkflowCore(
            self.root, env=self.env, import_legacy=False, state_dir=shared
        )
        core.store.write({"phase": STATE_LABELS["S0"]})
        if os.name != "nt":
            self.assertEqual(shared.stat().st_mode & 0o777, 0o755)

    def test_plan_fifo_does_not_block_transition(self) -> None:
        self.seed_code("S7")
        plan = self.root / ".vibe-kernel" / "plan.md"
        os.mkfifo(plan)
        (self.root / "a.py").write_text("x\n", encoding="utf-8")
        result = self.t(
            "S8",
            exit_checklist=ExitChecklist("S7 Plan", ["a.py"], ["done"]),
        )
        self.assertTrue(result.ok, result.message)


class ArchiveHardening(CoreTest):
    def test_s13_to_s0_then_s1_archives_old_task(self) -> None:
        self.seed_code(
            "S13",
            status="complete",
            completed=["old-task"],
            pending=["old-pending"],
        )
        self.assertTrue(self.t("S0").ok)
        self.assertEqual(self.core.get_state().status, "complete")
        self.assertTrue(self.t("S1", loop=0).ok)
        self.assertTrue(list(self.state_path.parent.glob(".state.md.complete-*")))
        fields = self.core.store.snapshot().fields
        self.assertEqual(fields["completed"], [])
        self.assertEqual(fields["pending"], [])

    def test_external_complete_state_is_copied_not_renamed(self) -> None:
        outside = Path(self._tmp.name) / "external.md"
        core = WorkflowCore(
            self.root, env=self.env, import_legacy=False, state_path=outside
        )
        core.store.write(
            {
                "status": "complete",
                "phase": "S13 Complete",
                "loop": 1,
                "level": 2,
                "completed": ["old-task"],
                "resume": "old",
            }
        )
        self.assertTrue(core.transition("S1", loop=0).ok)
        self.assertTrue(outside.exists())
        backups = list(outside.parent.glob("external.md.complete-*"))
        self.assertEqual(len(backups), 1)
        self.assertIn('"S13 Complete"', backups[0].read_text(encoding="utf-8"))


class SafeModeEvidenceHardening(CoreTest):
    def test_english_contractions_rejected(self) -> None:
        self.seed_code("S14", status="paused", _resume_from="S8 Code")
        for text in ("can't continue", "cant continue", "I dont want to continue", "won't continue"):
            with self.subTest(text=text):
                result = self.t(
                    "RESUME",
                    exit_checklist=ExitChecklist("S14", [], [text]),
                )
                self.assertEqual(result.code, "EXIT_CHECKLIST_INCOMPLETE")

    def test_s8_self_loop_does_not_append_completed(self) -> None:
        self.seed_code("S8", loop=1, completed=["prev"])
        self.assertTrue(self.t("S8").ok)
        self.assertEqual(self.core.store.snapshot().fields["completed"], ["prev"])

    def test_missing_fingerprint_does_not_use_stale_count(self) -> None:
        self.seed_code("S8", loop=1)
        self.core.feed_exec(ExecResult(exec_id="e1", ok=False, fingerprint="fp:a"))
        self.core.feed_exec(ExecResult(exec_id="e2", ok=False, fingerprint="fp:a"))
        self.core.feed_exec(ExecResult(exec_id="e3", ok=True))
        # 恢复后无指纹失败，不得沿用旧 count=2 立刻触发
        self.seed_code("S8", loop=1, review={"failure_state": {"consecutive_count": 2, "last_fingerprint": "fp:a"}})
        result = self.core.feed_exec(ExecResult(exec_id="e4", ok=False))
        self.assertEqual(result.consecutive_count, 1)
        self.assertFalse(result.no_progress)

    def test_snapshot_refuses_foreign_full_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            _state_text(_project_id="deadbeefdeadbeef", phase="S10 Review"),
            encoding="utf-8",
        )
        snapshot = self.core.snapshot_task_zone()
        self.assertIn("CHECKPOINT_FOREIGN", snapshot)
        self.assertNotIn("explicit", snapshot)


class Round2Hardening(CoreTest):
    def test_external_state_write_corrupt_copies_not_renames(self) -> None:
        outside = Path(self._tmp.name) / "victim.txt"
        outside.write_text("PRECIOUS\n", encoding="utf-8")
        core = WorkflowCore(
            self.root, env=self.env, import_legacy=False, state_path=outside
        )
        result = core.store.write({"phase": STATE_LABELS["S1"]})
        self.assertEqual(result.code, "CHECKPOINT_CORRUPT")
        self.assertTrue(outside.exists())
        self.assertEqual(outside.read_text(encoding="utf-8"), "PRECIOUS\n")
        self.assertEqual(len(list(outside.parent.glob("victim.txt.corrupt-*"))), 1)

    def test_unknown_key_only_write_is_persisted(self) -> None:
        self.seed()
        result = self.core.store.write({"future_key": {"x": 1}})
        self.assertTrue(result.changed)
        self.assertEqual(self.core.store.snapshot().raw["future_key"], {"x": 1})

    def test_feed_exec_replay_reports_current_phase(self) -> None:
        self.seed_code("S8", loop=1)
        self.core.feed_exec(ExecResult(exec_id="e1", ok=False, fingerprint="fp:a"))
        payload = ExecResult(exec_id="e2", ok=False, fingerprint="fp:a")
        self.core.feed_exec(payload)
        replay = self.core.feed_exec(payload)
        self.assertTrue(replay.escalated)
        self.assertEqual(replay.phase, "S14 Safe Mode")

    def test_feed_exec_vc_violation_escalates(self) -> None:
        self.seed_code("S8", loop=1)
        result = self.core.feed_exec(
            ExecResult(exec_id="e1", ok=True, vc_violation="redline")
        )
        self.assertEqual(result.code, "SCOPE_DENIED")
        self.assertTrue(result.escalated)
        self.assertEqual(self.core.get_state().phase, "S14 Safe Mode")

    def test_state_check_rejects_float_and_bool_numbers(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            _state_text(loop="1.5", level="true", _rev='"abc"'), encoding="utf-8"
        )
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "state", "check", "--cwd", str(self.root)],
            cwd=REPO,
            capture_output=True,
            text=True,
            env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4)
        issues = " ".join(json.loads(proc.stdout).get("issues", []))
        self.assertIn("loop", issues)
        self.assertIn("level", issues)
        self.assertIn("_rev", issues)

    def test_resume_from_s14_rejected(self) -> None:
        self.seed_code("S14", status="paused", _resume_from="S14 Safe Mode")
        result = self.t(
            "RESUME",
            exit_checklist=ExitChecklist("S14", [], ["用户说：继续"]),
        )
        self.assertEqual(result.code, "STATE_ILLEGAL_TRANSITION")


class ParserHardening(unittest.TestCase):
    def test_deep_indent_fail_closed(self) -> None:
        text = "".join(" " * i + f"k{i}:\n" for i in range(120))
        with self.assertRaises(SubsetParseError):
            parse_subset(text)

    def test_huge_int_fail_closed(self) -> None:
        with self.assertRaises(SubsetParseError):
            parse_subset("loop: " + "9" * 5000 + "\n")

    def test_infinite_float_fail_closed(self) -> None:
        with self.assertRaises(SubsetParseError):
            parse_subset("loop: 1.0e999\n")

    def test_quoted_unknown_keys_round_trip(self) -> None:
        data = {"自定义键": 1, "x": [{"a b": 2}]}
        self.assertEqual(parse_subset(render_subset(data)), data)


class ArtifactHardening(CoreTest):
    def test_absolute_or_parent_ref_rejected(self) -> None:
        store = ArtifactStore(self.core.resolved.artifacts_dir)
        for ref in ("/etc/passwd", "../secret.log", "artifacts/../../x.log"):
            with self.subTest(ref=ref):
                self.assertFalse(store.validate({"tier": "pinned", "ref": ref}).ok)

    def test_symlink_artifact_rejected(self) -> None:
        store = ArtifactStore(self.core.resolved.artifacts_dir)
        self.core.resolved.artifacts_dir.mkdir(parents=True, exist_ok=True)
        target = self.core.resolved.artifacts_dir / "real.log"
        target.write_text("x\n", encoding="utf-8")
        link = self.core.resolved.artifacts_dir / "link.log"
        link.symlink_to(target)
        self.assertFalse(store.validate({"tier": "pinned", "ref": "artifacts/link.log"}).ok)

    @unittest.skipIf(os.name == "nt", "mkfifo 仅 POSIX")
    def test_fifo_artifact_rejected_without_blocking(self) -> None:
        store = ArtifactStore(self.core.resolved.artifacts_dir)
        self.core.resolved.artifacts_dir.mkdir(parents=True, exist_ok=True)
        os.mkfifo(self.core.resolved.artifacts_dir / "fifo.log")
        check = store.validate({"tier": "pinned", "ref": "artifacts/fifo.log"})
        self.assertFalse(check.ok)

    def test_gc_refuses_symlink_artifacts_dir(self) -> None:
        real = Path(self._tmp.name) / "real-artifacts"
        real.mkdir()
        self.core.resolved.artifacts_dir.parent.mkdir(parents=True, exist_ok=True)
        (real / "old.log").write_text("x\n", encoding="utf-8")
        self.core.resolved.artifacts_dir.symlink_to(real)
        store = ArtifactStore(self.core.resolved.artifacts_dir)
        result = store.gc({"status": "complete"})
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "CHECKPOINT_LOCATION_UNRESOLVED")
        self.assertTrue((real / "old.log").exists())

    def test_put_rejects_same_name_different_content(self) -> None:
        store = ArtifactStore(self.core.resolved.artifacts_dir)
        first = store.put("a\n", name="same")
        second = store.put("b\n", name="same")
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        assert first is not None
        self.assertTrue(store.validate(first).ok)


class SafeModeHardening(CoreTest):
    def test_s14_self_escalation_rejected(self) -> None:
        self.seed_code("S14", status="paused", _resume_from="S8 Code")
        before = self.state_path.read_bytes()
        result = self.t("S14", force=True, reason="again")
        self.assertEqual(result.code, "STATE_ILLEGAL_TRANSITION")
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_s14_entry_does_not_complete_stage_or_clobber_step(self) -> None:
        self.seed_code("S8", loop=1, current_step="fix auth", completed=["prev"])
        entered = self.t("S14", force=True, reason="loop_budget_exhausted")
        self.assertTrue(entered.ok)
        fields = self.core.store.snapshot().fields
        self.assertEqual(fields["completed"], ["prev"])
        self.assertEqual(fields["current_step"], "fix auth")
        resumed = self.t(
            "RESUME",
            exit_checklist=ExitChecklist("S14", [], ["用户说：继续"]),
        )
        self.assertTrue(resumed.ok, resumed.message)
        fields = self.core.store.snapshot().fields
        self.assertEqual(fields["phase"], "S8 Code")
        self.assertEqual(fields["loop"], 1)
        self.assertEqual(fields["current_step"], "fix auth")

    def test_budget_overflow_can_still_reach_s14_and_s13(self) -> None:
        self.seed_code("S10", loop=5, level=0)
        self.assertTrue(self.t("S13").ok)
        self.seed_code("S10", loop=5, level=0)
        self.assertTrue(self.t("S14", force=True, reason="loop_budget_exhausted").ok)

    def test_no_progress_auto_escalates(self) -> None:
        self.seed_code("S8", loop=1)
        self.core.feed_exec(ExecResult(exec_id="e1", ok=False, fingerprint="fp:a"))
        second = self.core.feed_exec(ExecResult(exec_id="e2", ok=False, fingerprint="fp:a"))
        self.assertEqual(second.consecutive_count, 2)
        self.assertTrue(second.escalated)
        self.assertEqual(second.phase, "S14 Safe Mode")
        fields = self.core.store.snapshot().fields
        self.assertEqual(fields["phase"], "S14 Safe Mode")
        self.assertEqual(fields["_resume_from"], "S8 Code")

    def test_s14_evidence_negative_or_missing_user_rejected(self) -> None:
        self.seed_code("S14", status="paused", _resume_from="S8 Code")
        negative = self.t(
            "RESUME",
            exit_checklist=ExitChecklist("S14", [], ["用户说：不要再继续了"]),
        )
        self.assertEqual(negative.code, "EXIT_CHECKLIST_INCOMPLETE")
        fake_stage = self.t(
            "RESUME",
            exit_checklist=ExitChecklist("S14 stop", [], []),
        )
        self.assertEqual(fake_stage.code, "EXIT_CHECKLIST_INCOMPLETE")
        missing_user = self.t(
            "RESUME",
            exit_checklist=ExitChecklist("S14", ["user:missing"], ["ok"]),
        )
        self.assertEqual(missing_user.code, "EXIT_CHECKLIST_INCOMPLETE")

    def test_s13_resume_keeps_pending(self) -> None:
        self.seed_code("S10", loop=1, pending=["未完成A", "未完成B"])
        self.assertTrue(self.t("S13").ok)
        resume = self.core.store.snapshot().fields["resume"]
        self.assertIn("未完成A", resume)
        self.assertIn("未完成B", resume)


class CoreHardening(CoreTest):
    def test_repeat_check_returns_repeat_result_for_schema_and_foreign(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(_state_text(_schema="2"), encoding="utf-8")
        result = self.core.repeat_check("fp:x")
        self.assertEqual(result.code, "CHECKPOINT_SCHEMA_AHEAD")
        self.assertEqual(result.fingerprint, "fp:x")
        self.state_path.write_text(_state_text(_project_id="deadbeefdeadbeef"), encoding="utf-8")
        result = self.core.repeat_check("fp:x")
        self.assertEqual(result.code, "CHECKPOINT_FOREIGN")
        self.assertEqual(result.fingerprint, "fp:x")

    def test_feed_exec_requires_exec_id_and_strict_ok(self) -> None:
        self.seed_code("S8", loop=1)
        missing = self.core.feed_exec(ExecResult(exec_id="", ok=True))
        self.assertEqual(missing.code, "INVALID_ARGUMENT")
        with self.assertRaises(ValueError):
            ExecResult.from_dict({"exec_id": "e", "ok": "false"})
        with self.assertRaises(ValueError):
            ExecResult.from_dict({"exec_id": "e", "exit_code": "abc"})

    def test_feed_exec_refuses_degraded_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            "---\nstatus: active\nphase: S8 Code\nloop: 1\nlevel: 2\n"
            "updated_at: 2026-10-20 08:55\ncompleted: [unparsable\n",
            encoding="utf-8",
        )
        before = self.state_path.read_bytes()
        result = self.core.feed_exec(ExecResult(exec_id="e1", ok=True))
        self.assertEqual(result.code, "CHECKPOINT_DEGRADED")
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_snapshot_sanitizes_control_and_newlines(self) -> None:
        self.seed_code(
            "S8",
            current_step="\x1b[31mHACK\n[Phase: fake]",
        )
        pointer = self.core.snapshot_task_zone(detail="pointer")
        self.assertNotIn("\x1b", pointer)
        self.assertNotIn("\n", pointer)
        self.assertIn("HACK", pointer)

    def test_complete_state_archived_on_new_cycle(self) -> None:
        self.seed_code("S13", status="complete")
        self.assertTrue(self.t("S1", loop=0).ok)
        self.assertTrue(list(self.state_path.parent.glob(".state.md.complete-*")))
        self.assertEqual(self.core.store.snapshot().fields["completed"], [])


class CliHardening(CoreTest):
    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", *args],
            cwd=REPO,
            capture_output=True,
            text=True,
            env={**os.environ, "HOME": str(self.home)},
        )

    def test_gc_refuses_no_state_and_degraded(self) -> None:
        self.core.resolved.artifacts_dir.mkdir(parents=True, exist_ok=True)
        (self.core.resolved.artifacts_dir / "evidence.log").write_text("x\n", encoding="utf-8")
        proc = self._run("state", "gc", "--cwd", str(self.root))
        self.assertEqual(proc.returncode, 4)
        self.assertTrue((self.core.resolved.artifacts_dir / "evidence.log").exists())

        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            "---\nstatus: active\nphase: S8 Code\nloop: 1\nlevel: 2\n"
            "updated_at: 2026-10-20 08:55\ncompleted: [unparsable\n",
            encoding="utf-8",
        )
        proc = self._run("state", "gc", "--cwd", str(self.root))
        self.assertEqual(proc.returncode, 4)
        self.assertTrue((self.core.resolved.artifacts_dir / "evidence.log").exists())

    def test_feed_exec_fail_closed_exit_four(self) -> None:
        self.seed_code("S8", loop=1)
        for exec_id in ("e1", "e2"):
            payload = json.dumps(
                {"exec_id": exec_id, "ok": False, "fingerprint": "fp:a", "errors": ["boom"]}
            )
            proc = self._run("feed-exec", "--cwd", str(self.root), "--result", payload)
        self.assertEqual(proc.returncode, 4, proc.stdout)
        data = json.loads(proc.stdout)
        self.assertEqual(data["code"], "NO_PROGRESS")
        self.assertEqual(self.core.get_state().phase, "S14 Safe Mode")

    def test_transition_violation_exit_four(self) -> None:
        self.seed_code("S8", loop=1)
        proc = self._run(
            "transition", "--cwd", str(self.root), "--to", "S9", "--vc-violation", "redline"
        )
        self.assertEqual(proc.returncode, 4)
        self.assertEqual(json.loads(proc.stdout)["code"], "SCOPE_DENIED")

    def test_state_check_invalid_enums_exit_four(self) -> None:
        self.seed(phase="S99 Bogus", level=99, loop=-5, status="weird")
        proc = self._run("state", "check", "--cwd", str(self.root))
        self.assertEqual(proc.returncode, 4)
        self.assertIn("issues", json.loads(proc.stdout))

    def test_invalid_exec_result_exit_four(self) -> None:
        self.seed_code("S8", loop=1)
        proc = self._run(
            "feed-exec", "--cwd", str(self.root), "--result", '{"exec_id":"e","ok":"false"}'
        )
        self.assertEqual(proc.returncode, 4)
        self.assertEqual(json.loads(proc.stdout)["code"], "INVALID_ARGUMENT")


class CliHardening2(CliHardening):
    def test_repeat_check_success_exit_zero(self) -> None:
        self.seed_code("S8", loop=1)
        proc = self._run("repeat-check", "--cwd", str(self.root), "--fingerprint", "fp:x")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["consecutive_count"], 1)

    def test_gc_refuses_schema_invalid(self) -> None:
        self.core.resolved.artifacts_dir.mkdir(parents=True, exist_ok=True)
        (self.core.resolved.artifacts_dir / "old.log").write_text("x\n", encoding="utf-8")
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(_state_text(_schema="-1"), encoding="utf-8")
        proc = self._run("state", "gc", "--cwd", str(self.root))
        self.assertEqual(proc.returncode, 4)
        self.assertTrue((self.core.resolved.artifacts_dir / "old.log").exists())




class Round3Hardening(CoreTest):
    def _config_core(self, relative: str = ".vibe-kernel/run/.state.md"):
        config_dir = self.root / ".vibe-kernel"
        config_dir.mkdir(exist_ok=True)
        (config_dir / "config.json").write_text(
            json.dumps({"state_path": relative}), encoding="utf-8"
        )
        return WorkflowCore(self.root, env=self.env, import_legacy=False)

    def test_config_managed_corrupt_recovers(self) -> None:
        core = self._config_core()
        core.resolved.state_path.parent.mkdir(parents=True, exist_ok=True)
        core.resolved.state_path.write_text("<<< corrupt >>>\n", encoding="utf-8")
        loaded = core.load_checkpoint()
        self.assertEqual(loaded.mode, "fresh_start")
        self.assertEqual(loaded.code, "CHECKPOINT_CORRUPT")
        self.assertTrue(core.transition("S1").ok)
        self.assertEqual(core.get_state().phase, "S1 Intent")

    def test_external_corrupt_is_reference_only_and_api_no_throw(self) -> None:
        outside = Path(self._tmp.name) / "external.md"
        outside.write_text("<<< corrupt >>>\n", encoding="utf-8")
        core = WorkflowCore(
            self.root, env=self.env, import_legacy=False, state_path=outside
        )
        loaded = core.load_checkpoint()
        self.assertEqual(loaded.mode, "reference_only")
        result = core.transition("S1")
        self.assertEqual(result.code, "CHECKPOINT_CORRUPT")
        self.assertTrue(outside.exists())

    def test_archive_reset_on_config_path(self) -> None:
        core = self._config_core()
        core.resolved.state_path.parent.mkdir(parents=True, exist_ok=True)
        core.store.write(
            {
                "status": "complete",
                "phase": "S13 Complete",
                "loop": 1,
                "level": 2,
                "completed": ["old"],
                "pending": ["oldp"],
                "decisions": [{"id": "D1"}],
                "user_decisions": [{"id": "U1"}],
                "goal": {"explicit": "old-goal"},
                "resume": "old",
                "review": {"failure_state": {"consecutive_count": 2, "last_fingerprint": "fp:a"}},
            }
        )
        self.assertTrue(core.transition("S1", loop=0).ok)
        fields = core.store.snapshot().fields
        for key in ("completed", "pending", "decisions", "user_decisions"):
            self.assertEqual(fields[key], [], key)
        self.assertEqual(fields["resume"], "")
        self.assertEqual(fields["goal"]["explicit"], "")
        self.assertNotIn("failure_state", fields["review"])

    def test_archive_reset_on_external_path(self) -> None:
        outside = Path(self._tmp.name) / "external.md"
        core = WorkflowCore(
            self.root, env=self.env, import_legacy=False, state_path=outside
        )
        core.store.write(
            {
                "status": "complete",
                "phase": "S13 Complete",
                "loop": 1,
                "level": 2,
                "completed": ["old"],
                "pending": ["oldp"],
                "review": {"failure_state": {"consecutive_count": 2}},
            }
        )
        self.assertTrue(core.transition("S1", loop=0).ok)
        fields = core.store.snapshot().fields
        self.assertEqual(fields["completed"], [])
        self.assertEqual(fields["pending"], [])
        self.assertNotIn("failure_state", fields["review"])
        self.assertTrue(outside.exists())
        self.assertTrue(list(outside.parent.glob("external.md.complete-*")))

    def test_null_phase_rejected(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(_state_text(phase="null"), encoding="utf-8")
        view = self.core.get_state()
        self.assertEqual(view.code, "CHECKPOINT_DEGRADED")
        self.assertTrue(self.core.feed_exec(ExecResult(exec_id="e1", ok=True)).code)

    def test_gitignore_symlinks_do_not_truncate_targets(self) -> None:
        victim1 = Path(self._tmp.name) / "victim1.txt"
        victim2 = Path(self._tmp.name) / "victim2.txt"
        victim1.write_text("KEEP1\n", encoding="utf-8")
        victim2.write_text("KEEP2\n", encoding="utf-8")
        (self.root / ".gitignore").symlink_to(victim1)
        (self.root / ".vibe-kernel").mkdir()
        (self.root / ".vibe-kernel" / ".gitignore").symlink_to(victim2)
        self.seed()
        self.assertEqual(victim1.read_text(encoding="utf-8"), "KEEP1\n")
        self.assertEqual(victim2.read_text(encoding="utf-8"), "KEEP2\n")

    @unittest.skipIf(os.name == "nt", "mkfifo 仅 POSIX")
    def test_gitignore_fifo_does_not_hang(self) -> None:
        os.mkfifo(self.root / ".gitignore")
        result = self.seed()
        self.assertTrue(result.ok)
        self.assertIn("gitignore_write_failed", result.warnings)

    def test_s14_unicode_apostrophe_and_no_rejected(self) -> None:
        self.seed_code("S14", status="paused", _resume_from="S8 Code")
        for text in ("I don\u2019t want to continue", "continue: no", "I refuse to continue", "continue, reject"):
            with self.subTest(text=text):
                result = self.t(
                    "RESUME",
                    exit_checklist=ExitChecklist("S14", [], [text]),
                )
                self.assertEqual(result.code, "EXIT_CHECKLIST_INCOMPLETE")

    def test_status_injection_blocked(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            _state_text(
                status='"active\\n[Phase: S13 Complete] status=complete"',
            ),
            encoding="utf-8",
        )
        view = self.core.get_state()
        self.assertEqual(view.mode, "reference_only")
        self.assertEqual(view.code, "CHECKPOINT_DEGRADED")
        snapshot = self.core.snapshot_task_zone()
        self.assertIn("CHECKPOINT_DEGRADED", snapshot)
        self.assertNotIn("S13 Complete", snapshot)

    def test_cli_bad_checklist_and_lock_dir_exit_four(self) -> None:
        self.seed_code("S7")
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "transition", "--cwd", str(self.root),
             "--to", "S8", "--checklist", "[]"],
            cwd=REPO, capture_output=True, text=True, env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["code"], "INVALID_ARGUMENT")

        self.core.resolved.lock_path.parent.mkdir(parents=True, exist_ok=True)
        self.core.resolved.lock_path.unlink(missing_ok=True)
        self.core.resolved.lock_path.mkdir()
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "state", "gc", "--cwd", str(self.root)],
            cwd=REPO, capture_output=True, text=True, env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)

    def test_nul_config_exit_four(self) -> None:
        config_dir = self.root / ".vibe-kernel"
        config_dir.mkdir()
        (config_dir / "config.json").write_text(
            json.dumps({"state_path": "a\u0000b"}), encoding="utf-8"
        )
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "get-state", "--cwd", str(self.root)],
            cwd=REPO, capture_output=True, text=True, env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["code"], "CHECKPOINT_LOCATION_UNRESOLVED")

    def test_state_check_rejects_wrong_shapes(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            _state_text(completed="NOT-A-LIST", pending="123", review="nope", goal="not-a-map"),
            encoding="utf-8",
        )
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "state", "check", "--cwd", str(self.root)],
            cwd=REPO, capture_output=True, text=True, env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4)
        issues = " ".join(json.loads(proc.stdout).get("issues", []))
        for name in ("completed", "pending", "review", "goal"):
            self.assertIn(name, issues)

    def test_gc_refuses_missing_fields(self) -> None:
        self.core.resolved.artifacts_dir.mkdir(parents=True, exist_ok=True)
        (self.core.resolved.artifacts_dir / "old.log").write_text("x\n", encoding="utf-8")
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            "---\n_schema: 1\nstatus: paused\nphase: S1 Intent\n", encoding="utf-8"
        )
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "state", "gc", "--cwd", str(self.root)],
            cwd=REPO, capture_output=True, text=True, env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4)
        self.assertTrue((self.core.resolved.artifacts_dir / "old.log").exists())

    def test_feed_out_of_order_replay_is_idempotent(self) -> None:
        self.seed_code("S8", loop=1)
        self.core.feed_exec(ExecResult(exec_id="e1", ok=False, fingerprint="fp:a"))
        second = self.core.feed_exec(ExecResult(exec_id="e2", ok=False, fingerprint="fp:a"))
        self.assertEqual(second.consecutive_count, 2)
        replay = self.core.feed_exec(ExecResult(exec_id="e1", ok=False, fingerprint="fp:a"))
        self.assertEqual(replay.consecutive_count, 2)

    def test_gc_creates_state_dir_0700(self) -> None:
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "state", "gc", "--cwd", str(self.root)],
            cwd=REPO, capture_output=True, text=True, env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4)
        if os.name != "nt":
            self.assertEqual(self.core.resolved.state_dir.stat().st_mode & 0o777, 0o700)

    def test_write_size_limit_does_not_corrupt_state(self) -> None:
        self.seed_code("S8", loop=1)
        before = self.state_path.read_text(encoding="utf-8")
        result = self.core.feed_exec(
            ExecResult(exec_id="e1", ok=False, fingerprint="f" * (9 * 1024 * 1024))
        )
        self.assertTrue(result.ok)
        stored = self.core.store.snapshot()
        failure = stored.fields.get("review", {}).get("failure_state", {})
        self.assertLessEqual(len(str(failure.get("last_fingerprint", ""))), 256)
        self.assertEqual(len(failure.get("last_fingerprint", "")), 256)
        for item in failure.get("history", []):
            self.assertLessEqual(len(str(item)), 256)
        self.assertEqual(stored.quality.value, "strict")
        self.assertLessEqual(len(self.state_path.read_bytes()), 4 * 1024 * 1024)
        self.assertTrue(before)

    def test_complete_get_state_is_reference_only(self) -> None:
        self.seed_code("S13", status="complete")
        view = self.core.get_state()
        self.assertEqual(view.mode, "reference_only")
        self.assertIn("结束", view.next)
        self.assertNotIn("[Phase:", self.core.snapshot_task_zone())


if __name__ == "__main__":
    unittest.main()
