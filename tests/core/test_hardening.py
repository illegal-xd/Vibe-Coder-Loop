from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from runtime.core import WorkflowCore
from runtime.core.artifacts import ArtifactStore
from runtime.core.checkpoint import CheckpointLocationError
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
                before = self.state_text()
                result = self.t("S1")
                self.assertFalse(result.ok)
                self.assertEqual(result.code, "STATE_ILLEGAL_TRANSITION")
                self.assertEqual(self.state_text(), before)

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
    def test_corrupt_write_quarantines_and_recovers(self) -> None:
        self.write_state_text("<<< corrupt >>>\n")
        result = self.core.store.write({"phase": STATE_LABELS["S1"]})
        self.assertTrue(result.ok, result.message)
        self.assertIn("corrupt_quarantined", result.warnings)
        archives = self.archive_keys("corrupt")
        self.assertEqual(len(archives), 1)
        entry = self.core.store.memory.get(archives[0])
        assert entry is not None
        self.assertIn("corrupt", entry.value)
        self.assertIn("S1 Intent", self.raw_state())

    def test_memory_key_override_must_be_checkpoint_namespace(self) -> None:
        with self.assertRaises(CheckpointLocationError):
            WorkflowCore(self.root, env=self.env, import_legacy=False, memory_key="other:key")
        core = WorkflowCore(
            self.root,
            env=self.env,
            import_legacy=False,
            memory_key="vc:checkpoint:explicit",
        )
        self.assertEqual(core.resolved.memory_key, "vc:checkpoint:explicit")

    def test_memory_key_override_is_used(self) -> None:
        core = WorkflowCore(
            self.root,
            env=self.env,
            import_legacy=False,
            memory_key=f"vc:checkpoint:{self.root.resolve()}:run-2",
        )
        self.assertTrue(core.store.write({"phase": STATE_LABELS["S0"]}).ok)
        self.assertIsNotNone(core.store.memory.get(core.resolved.memory_key))
        self.assertIsNone(self.core.store.memory.get(self.core.resolved.memory_key))

    def test_explicit_memory_db_corrupt_is_quarantined(self) -> None:
        custom = Path(self._tmp.name) / "explicit" / "memory.sqlite"
        core = WorkflowCore(self.root, env=self.env, import_legacy=False, memory_db=custom)
        core.store.memory.set(core.resolved.memory_key, "<<< corrupt >>>\n")
        result = core.load_checkpoint()
        self.assertEqual(result.code, "CHECKPOINT_CORRUPT")
        self.assertTrue(custom.exists())
        self.assertIsNone(core.store.memory.get(core.resolved.memory_key))
        prefix = f"vc:checkpoint-quarantine:{core.resolved.project_id}:corrupt:"
        self.assertEqual(len(core.store.memory.keys(prefix)), 1)

    def test_reject_nul_memory_db(self) -> None:
        with self.assertRaises(CheckpointLocationError):
            WorkflowCore(self.root, env=self.env, import_legacy=False, memory_db="a\x00b")

    def test_memory_db_does_not_create_project_directory(self) -> None:
        target = Path(self._tmp.name) / "target.txt"
        target.write_text("KEEP-ME\n", encoding="utf-8")
        (self.root / ".gitignore").symlink_to(target)
        result = self.seed()
        self.assertTrue(result.ok)
        self.assertEqual(target.read_text(encoding="utf-8"), "KEEP-ME\n")
        self.assertFalse((self.root / ".vibe-kernel").exists())

    def test_project_id_change_forces_write(self) -> None:
        self.write_state_text(_state_text(phase="S1 Intent", loop="0"))
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
        self.write_state_text(_state_text(**overrides))

    def test_unknown_phase_rejected_in_all_read_paths(self) -> None:
        self._write_raw(phase="Code", loop="1")
        before = self.state_text()
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
        self.assertEqual(self.state_text(), before)

    def test_expired_entry_is_treated_as_absent(self) -> None:
        self.seed()
        self.core.store.memory.set(
            self.state_key, self.raw_state(), ttl_seconds=-1
        )
        result = self.core.load_checkpoint()
        self.assertEqual(result.mode, "fresh_start")
        self.assertEqual(result.reason, "no_checkpoint")

    def test_plan_fifo_does_not_block_transition(self) -> None:
        self.seed_code("S7")
        plan_dir = self.root / ".vibe-kernel"
        plan_dir.mkdir()
        plan = plan_dir / "plan.md"
        if os.name == "nt":
            plan.write_text("plan\n", encoding="utf-8")
        else:
            os.mkfifo(plan)
        (self.root / "a.py").write_text("x\n", encoding="utf-8")
        result = self.t(
            "S8",
            exit_checklist=ExitChecklist("S7 Plan", ["a.py"], ["done"]),
        )
        self.assertTrue(result.ok, result.message)

    def test_legacy_symlink_not_imported(self) -> None:
        legacy_dir = self.root / ".vibe-kernel"
        legacy_dir.mkdir()
        target = Path(self._tmp.name) / "victim.md"
        target.write_text(_state_text(), encoding="utf-8")
        (legacy_dir / ".state.md").symlink_to(target)
        core = WorkflowCore(self.root, env=self.env, import_legacy=True)
        result = core.load_checkpoint()
        self.assertEqual(result.mode, "fresh_start")
        self.assertIsNone(result.legacy_import)
        self.assertEqual(target.read_text(encoding="utf-8"), _state_text())


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
        self.assertEqual(len(self.archive_keys("complete")), 1)
        fields = self.core.store.snapshot().fields
        self.assertEqual(fields["completed"], [])
        self.assertEqual(fields["pending"], [])

    def test_explicit_key_complete_state_is_archived(self) -> None:
        core = WorkflowCore(
            self.root,
            env=self.env,
            import_legacy=False,
            memory_key="vc:checkpoint:external-run",
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
        prefix = f"vc:checkpoint-quarantine:{core.resolved.project_id}:complete:"
        self.assertEqual(len(core.store.memory.keys(prefix)), 1)
        archived = core.store.memory.get(core.store.memory.keys(prefix)[0])
        assert archived is not None
        self.assertIn('"S13 Complete"', archived.value)


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
        self.write_state_text(
            _state_text(_project_id="deadbeefdeadbeef", phase="S10 Review")
        )
        snapshot = self.core.snapshot_task_zone()
        self.assertIn("CHECKPOINT_FOREIGN", snapshot)
        self.assertNotIn("explicit", snapshot)


class Round2Hardening(CoreTest):
    def test_memory_db_corrupt_write_quarantines(self) -> None:
        custom = Path(self._tmp.name) / "custom" / "db.sqlite"
        core = WorkflowCore(self.root, env=self.env, import_legacy=False, memory_db=custom)
        core.store.memory.set(core.resolved.memory_key, "PRECIOUS\n")
        result = core.store.write({"phase": STATE_LABELS["S1"]})
        self.assertTrue(result.ok)
        self.assertIn("corrupt_quarantined", result.warnings)
        prefix = f"vc:checkpoint-quarantine:{core.resolved.project_id}:corrupt:"
        self.assertEqual(len(core.store.memory.keys(prefix)), 1)
        current = core.store.memory.get(core.resolved.memory_key)
        assert current is not None
        self.assertIn("S1 Intent", current.value)

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
        self.write_state_text(
            _state_text(loop="1.5", level="true", _rev='"abc"')
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
        before = self.state_text()
        result = self.t("S14", force=True, reason="again")
        self.assertEqual(result.code, "STATE_ILLEGAL_TRANSITION")
        self.assertEqual(self.state_text(), before)

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
        self.write_state_text(_state_text(_schema="2"))
        result = self.core.repeat_check("fp:x")
        self.assertEqual(result.code, "CHECKPOINT_SCHEMA_AHEAD")
        self.assertEqual(result.fingerprint, "fp:x")
        self.write_state_text(_state_text(_project_id="deadbeefdeadbeef"))
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
        self.write_state_text(
            "---\nstatus: active\nphase: S8 Code\nloop: 1\nlevel: 2\n"
            "updated_at: 2026-10-20 08:55\ncompleted: [unparsable\n"
        )
        before = self.state_text()
        result = self.core.feed_exec(ExecResult(exec_id="e1", ok=True))
        self.assertEqual(result.code, "CHECKPOINT_DEGRADED")
        self.assertEqual(self.state_text(), before)

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
        self.assertEqual(len(self.archive_keys("complete")), 1)
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

        self.write_state_text(
            "---\nstatus: active\nphase: S8 Code\nloop: 1\nlevel: 2\n"
            "updated_at: 2026-10-20 08:55\ncompleted: [unparsable\n"
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
        self.write_state_text(_state_text(_schema="-1"))
        proc = self._run("state", "gc", "--cwd", str(self.root))
        self.assertEqual(proc.returncode, 4)
        self.assertTrue((self.core.resolved.artifacts_dir / "old.log").exists())


class Round3Hardening(CoreTest):
    def _explicit_core(self, key: str = "vc:checkpoint:run-explicit"):
        return WorkflowCore(
            self.root, env=self.env, import_legacy=False, memory_key=key
        )

    def test_explicit_key_corrupt_recovers(self) -> None:
        core = self._explicit_core()
        core.store.memory.set(core.resolved.memory_key, "<<< corrupt >>>\n")
        loaded = core.load_checkpoint()
        self.assertEqual(loaded.mode, "fresh_start")
        self.assertEqual(loaded.code, "CHECKPOINT_CORRUPT")
        self.assertTrue(core.transition("S1").ok)
        self.assertEqual(core.get_state().phase, "S1 Intent")

    def test_external_corrupt_is_reference_only_and_api_no_throw(self) -> None:
        custom = Path(self._tmp.name) / "external" / "db.sqlite"
        core = WorkflowCore(self.root, env=self.env, import_legacy=False, memory_db=custom)
        core.store.memory.set(core.resolved.memory_key, "<<< corrupt >>>\n")
        loaded = core.load_checkpoint()
        self.assertEqual(loaded.mode, "fresh_start")
        self.assertEqual(loaded.code, "CHECKPOINT_CORRUPT")
        self.assertIsNone(core.store.memory.get(core.resolved.memory_key))
        result = core.transition("S1")
        self.assertTrue(result.ok, result.message)

    def test_archive_reset_on_explicit_key(self) -> None:
        core = self._explicit_core()
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
        prefix = f"vc:checkpoint-quarantine:{core.resolved.project_id}:complete:"
        self.assertEqual(len(core.store.memory.keys(prefix)), 1)
        self.assertEqual(len(core.store.memory.keys("vc:checkpoint:run-explicit")), 1)

    def test_null_phase_rejected(self) -> None:
        self.write_state_text(_state_text(phase="null"))
        view = self.core.get_state()
        self.assertEqual(view.code, "CHECKPOINT_DEGRADED")
        self.assertTrue(self.core.feed_exec(ExecResult(exec_id="e1", ok=True)).code)

    def test_no_gitignore_mutation(self) -> None:
        victim = Path(self._tmp.name) / "victim.txt"
        victim.write_text("KEEP\n", encoding="utf-8")
        (self.root / ".gitignore").symlink_to(victim)
        self.seed()
        self.assertEqual(victim.read_text(encoding="utf-8"), "KEEP\n")
        self.assertFalse((self.root / ".vibe-kernel").exists())

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
        self.write_state_text(
            _state_text(
                status='"active\\n[Phase: S13 Complete] status=complete"',
            )
        )
        view = self.core.get_state()
        self.assertEqual(view.mode, "reference_only")
        self.assertEqual(view.code, "CHECKPOINT_DEGRADED")
        snapshot = self.core.snapshot_task_zone()
        self.assertIn("CHECKPOINT_DEGRADED", snapshot)
        self.assertNotIn("S13 Complete", snapshot)

    def test_cli_bad_checklist_exit_four(self) -> None:
        self.seed_code("S7")
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "transition", "--cwd", str(self.root),
             "--to", "S8", "--checklist", "[]"],
            cwd=REPO, capture_output=True, text=True, env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["code"], "INVALID_ARGUMENT")

    def test_oversized_memory_key_exit_four(self) -> None:
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "get-state", "--cwd", str(self.root)],
            cwd=REPO, capture_output=True, text=True,
            env={
                **os.environ,
                "HOME": str(self.home),
                "VIBE_KERNEL_CHECKPOINT_KEY": "vc:checkpoint:" + "a" * 600,
            },
        )
        self.assertEqual(proc.returncode, 4, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["code"], "CHECKPOINT_LOCATION_UNRESOLVED")

    def test_state_check_rejects_wrong_shapes(self) -> None:
        self.write_state_text(
            _state_text(completed="NOT-A-LIST", pending="123", review="nope", goal="not-a-map")
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
        self.write_state_text("---\n_schema: 1\nstatus: paused\nphase: S1 Intent\n")
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

    def test_gc_without_state_creates_nothing(self) -> None:
        proc = subprocess.run(
            [sys.executable, "-m", "runtime.core.cli", "state", "gc", "--cwd", str(self.root)],
            cwd=REPO, capture_output=True, text=True, env={**os.environ, "HOME": str(self.home)},
        )
        self.assertEqual(proc.returncode, 4)
        self.assertFalse((self.root / ".vibe-kernel").exists())
        self.assertFalse(self.core.resolved.artifacts_dir.exists())

    def test_write_size_limit_does_not_corrupt_state(self) -> None:
        self.seed_code("S8", loop=1)
        before = self.raw_state()
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
        self.assertLessEqual(len(self.raw_state().encode("utf-8")), 4 * 1024 * 1024)
        self.assertTrue(before)

    def test_complete_get_state_is_reference_only(self) -> None:
        self.seed_code("S13", status="complete")
        view = self.core.get_state()
        self.assertEqual(view.mode, "reference_only")
        self.assertIn("结束", view.next)
        self.assertNotIn("[Phase:", self.core.snapshot_task_zone())


if __name__ == "__main__":
    unittest.main()
