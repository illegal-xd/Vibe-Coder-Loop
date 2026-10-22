from __future__ import annotations

import unittest

from runtime.core import ExecResult, WorkflowCore
from runtime.core.state_machine import STATE_LABELS

from .util import CoreTest


class CoreApiTests(CoreTest):
    def test_get_state_does_not_create_state(self) -> None:
        self.assertFalse((self.root / ".vibe-kernel").exists())
        view = self.core.get_state()
        self.assertEqual(view.mode, "fresh_start")
        self.assertFalse(self.state_exists())
        self.assertFalse((self.root / ".vibe-kernel").exists())

    def test_v12_repeated_failure_triggers_no_progress(self) -> None:
        self.seed_code("S8", loop=1)
        ok = self.core.feed_exec(ExecResult(exec_id="e1", ok=True))
        self.assertEqual(ok.consecutive_count, 0)
        first = self.core.feed_exec(
            ExecResult(exec_id="e2", ok=False, exit_code=1, fingerprint="fp:a", errors=["boom"])
        )
        self.assertEqual(first.consecutive_count, 1)
        self.assertFalse(first.no_progress)
        second = self.core.feed_exec(
            ExecResult(exec_id="e3", ok=False, exit_code=1, fingerprint="fp:a", errors=["boom"])
        )
        self.assertEqual(second.consecutive_count, 2)
        self.assertTrue(second.no_progress)
        self.assertEqual(second.code, "NO_PROGRESS")
        self.assertTrue(second.escalated)
        state = self.core.store.snapshot().fields
        self.assertEqual(state["phase"], "S14 Safe Mode")
        self.assertEqual(state["_resume_from"], "S8 Code")
        self.assertEqual(state["review"]["failure_state"]["consecutive_count"], 2)

    def test_feed_exec_is_idempotent_by_exec_id(self) -> None:
        self.seed_code("S8", loop=1)
        payload = ExecResult(exec_id="same", ok=False, fingerprint="fp:x", errors=["e"])
        first = self.core.feed_exec(payload)
        second = self.core.feed_exec(payload)
        self.assertEqual(first.consecutive_count, 1)
        self.assertEqual(second.consecutive_count, 1)
        self.assertEqual(second.rev, first.rev)

    def test_success_resets_consecutive_count(self) -> None:
        self.seed_code("S8", loop=1)
        self.core.feed_exec(ExecResult(exec_id="e1", ok=False, fingerprint="fp:a"))
        reset = self.core.feed_exec(ExecResult(exec_id="e2", ok=True))
        self.assertEqual(reset.consecutive_count, 0)

    def test_different_fingerprint_resets_to_one(self) -> None:
        self.seed_code("S8", loop=1)
        self.core.feed_exec(ExecResult(exec_id="e1", ok=False, fingerprint="fp:a"))
        second = self.core.feed_exec(ExecResult(exec_id="e2", ok=False, fingerprint="fp:b"))
        self.assertEqual(second.consecutive_count, 1)

    def test_v13_plan_drift(self) -> None:
        self.seed_code("S8", loop=1, review={"plan_files": ["src/a.py"]})
        result = self.core.feed_exec(
            ExecResult(exec_id="e1", ok=True, files_modified=["src/a.py", "src/b.py"])
        )
        self.assertTrue(result.plan_drift)
        self.assertEqual(result.code, "PLAN_DRIFT")

    def test_plan_drift_not_reported_within_plan(self) -> None:
        self.seed_code("S8", loop=1, review={"plan_files": ["src/a.py", "src/b.py"]})
        result = self.core.feed_exec(ExecResult(exec_id="e1", ok=True, files_modified=["src/a.py"]))
        self.assertFalse(result.plan_drift)

    def test_repeat_check_accumulates_same_fingerprint(self) -> None:
        self.seed_code("S8", loop=1)
        first = self.core.repeat_check("fp:1")
        self.assertEqual(first.consecutive_count, 1)
        again = self.core.repeat_check("fp:1")
        self.assertEqual(again.consecutive_count, 2)
        self.assertTrue(again.no_progress)
        self.assertEqual(again.code, "NO_PROGRESS")
        third = self.core.repeat_check("fp:1")
        self.assertEqual(third.consecutive_count, 3)
        second = self.core.repeat_check("fp:2")
        self.assertEqual(second.consecutive_count, 1)

    def test_repeat_check_empty_invalid(self) -> None:
        self.assertEqual(self.core.repeat_check("").code, "INVALID_ARGUMENT")

    def test_v29_snapshot_pointer(self) -> None:
        self.seed_code("S4", loop=2)
        pointer = self.core.snapshot_task_zone(detail="pointer")
        self.assertIn("phase=S4 Router", pointer)
        self.assertIn("loop=2", pointer)
        self.assertIn("source=", pointer)
        self.assertNotIn("\n", pointer)

    def test_snapshot_full_contains_task_zone(self) -> None:
        self.seed_code("S8", loop=1, pending=["p1"], resume="resume text")
        full = self.core.snapshot_task_zone()
        for key in (
            "[Phase: S8 Code]",
            "level=",
            "updated_at=",
            "goal:",
            "current_step:",
            "completed:",
            "pending:",
            "resume:",
        ):
            self.assertIn(key, full)

    def test_snapshot_invalid_detail(self) -> None:
        with self.assertRaises(ValueError):
            self.core.snapshot_task_zone(detail="bad")  # type: ignore[arg-type]

    def test_transition_respects_rev(self) -> None:
        seeded = self.seed_code("S1")
        conflict = self.t("S2", expected_rev=seeded.rev - 1)
        self.assertEqual(conflict.code, "STATE_REV_CONFLICT")

    def test_exec_result_from_dict_accepts_exit(self) -> None:
        result = ExecResult.from_dict({"exec_id": "x", "exit": 1, "errors": ["e"]})
        self.assertFalse(result.ok)
        self.assertEqual(result.exit_code, 1)

    def test_loop_max_override_only_tightens(self) -> None:
        strict = WorkflowCore(
            self.root,
            env=self.env,
            import_legacy=False,
            loop_max_override=1,
        )
        strict.store.write(
            {"phase": STATE_LABELS["S9"], "loop": 1, "level": 2, "status": "active"}
        )
        result = strict.transition("S8")
        self.assertEqual(result.code, "LOOP_BUDGET_EXHAUSTED")


if __name__ == "__main__":
    unittest.main()
