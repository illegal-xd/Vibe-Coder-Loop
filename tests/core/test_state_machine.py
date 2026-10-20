from __future__ import annotations

import unittest

from runtime.core.state_machine import ExitChecklist, loop_max

from .util import CoreTest


class TransitionTests(CoreTest):
    def test_v1_legal_forward_chain(self) -> None:
        for target in ("S1", "S2", "S4"):
            result = self.t(target, level=2 if target == "S4" else None)
            self.assertTrue(result.ok, result.message)
        for target in ("S8", "S9", "S10", "S13", "S0"):
            result = self.t(target)
            self.assertTrue(result.ok, result.message)
        state = self.core.get_state()
        self.assertEqual(state.phase, "S0 Idle")
        self.assertEqual(state.loop, 1)
        fields = self.core.store.snapshot().fields
        self.assertEqual(
            [item.split(":")[0] for item in fields["completed"]],
            ["S0 Idle", "S1 Intent", "S2 Preflight", "S4 Router", "S8 Code", "S9 Test", "S10 Review", "S13 Complete"],
        )
        # 收尾必写 resume
        self.assertTrue(fields["resume"])

    def test_v2_illegal_jump_does_not_touch_file(self) -> None:
        self.seed_code("S1")
        before = self.state_path.read_bytes()
        result = self.t("S8")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "STATE_ILLEGAL_TRANSITION")
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_v3_retry_increments_loop(self) -> None:
        self.seed_code("S9", loop=1)
        result = self.t("S8")
        self.assertTrue(result.ok)
        self.assertEqual(result.loop, 2)

    def test_v3b_case_b_increments_once(self) -> None:
        self.seed_code("S10", loop=1)
        first = self.t("S6", loop=2)
        self.assertTrue(first.ok, first.message)
        second = self.t("S7")
        self.assertTrue(second.ok)
        third = self.t("S8")
        self.assertTrue(third.ok)
        self.assertEqual((first.loop, second.loop, third.loop), (2, 2, 2))

    def test_v4_budget_exhausted(self) -> None:
        self.seed_code("S10", loop=3, level=2)
        result = self.t("S8")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "LOOP_BUDGET_EXHAUSTED")
        self.assertEqual(result.rev, 1)

    def test_v4b_loop_max_by_level(self) -> None:
        self.assertEqual(loop_max(0), 1)
        self.assertEqual(loop_max(1), 1)
        self.assertEqual(loop_max(2), 3)
        self.seed_code("S9", loop=1, level=0)
        self.assertEqual(self.t("S8").code, "LOOP_BUDGET_EXHAUSTED")
        self.seed_code("S9", loop=2, level=2)
        self.assertTrue(self.t("S8").ok)

    def test_v5_follow_up_resets_loop(self) -> None:
        self.seed_code("S13", loop=2)
        result = self.t("S1", loop=0)
        self.assertTrue(result.ok)
        self.assertEqual(result.loop, 0)
        self.assertEqual(self.core.get_state().status, "active")

    def test_v27_escalation_requires_force_and_reason(self) -> None:
        self.seed_code("S4")
        denied = self.t("S14")
        self.assertFalse(denied.ok)
        self.assertEqual(denied.code, "STATE_ILLEGAL_TRANSITION")
        ok = self.t("S14", force=True, reason="hard_constraint_violation")
        self.assertTrue(ok.ok)
        self.assertEqual(ok.to_state, "S14")
        self.assertEqual(self.core.store.snapshot().fields["_resume_from"], "S4 Router")

    def test_v28_leave_s14_needs_user_evidence(self) -> None:
        self.seed_code("S14", status="paused", _resume_from="S8 Code")
        result = self.t("S13")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "EXIT_CHECKLIST_INCOMPLETE")

    def test_v30_resume_keeps_loop(self) -> None:
        self.seed_code("S14", loop=2, status="paused", _resume_from="S8 Code")
        checklist = ExitChecklist("S14", ["user:U1"], ["用户说：继续"])
        result = self.t("RESUME", exit_checklist=checklist)
        self.assertTrue(result.ok, result.message)
        state = self.core.get_state()
        self.assertEqual(state.phase, "S8 Code")
        self.assertEqual(state.loop, 2)
        self.assertEqual(self.core.store.snapshot().fields["_resume_from"], "")

    def test_v31_stop_from_s14(self) -> None:
        self.seed_code("S14", loop=2, status="paused", _resume_from="S8 Code")
        checklist = ExitChecklist("S14", [], ["用户说：接受当前代码"])
        result = self.t("S13", exit_checklist=checklist)
        self.assertTrue(result.ok, result.message)
        self.assertEqual(self.core.get_state().status, "complete")

    def test_v32_investigation_multi_loop_requires_explicit_value(self) -> None:
        self.seed_code("S10", loop=2)
        missing = self.t("S7")
        self.assertEqual(missing.code, "INVALID_ARGUMENT")
        incremented = self.t("S7", loop=3)
        self.assertTrue(incremented.ok)
        self.assertEqual(incremented.loop, 3)
        self.seed_code("S10", loop=2)
        reset = self.t("S7", loop=0)
        self.assertTrue(reset.ok)
        self.assertEqual(reset.loop, 0)

    def test_v33_investigation_rejects_out_of_set(self) -> None:
        self.seed_code("S10", loop=2)
        result = self.t("S7", loop=4)
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "INVALID_ARGUMENT")

    def test_v34_quick_loop_initializes_to_one(self) -> None:
        self.seed_code("S4", loop=0, level=0)
        result = self.t("S8")
        self.assertTrue(result.ok)
        self.assertEqual(result.loop, 1)

    def test_pause_keeps_phase_and_sets_status(self) -> None:
        self.seed_code("S1")
        result = self.t("PAUSE")
        self.assertTrue(result.ok)
        state = self.core.get_state()
        self.assertEqual(state.phase, "S1 Intent")
        self.assertEqual(state.status, "paused")

    def test_s8_self_loop_legal_and_keeps_loop(self) -> None:
        self.seed_code("S8", loop=2)
        result = self.t("S8")
        self.assertTrue(result.ok)
        self.assertEqual(result.loop, 2)

    def test_unknown_target_is_invalid_argument(self) -> None:
        self.seed_code("S1")
        self.assertEqual(self.t("wat").code, "INVALID_ARGUMENT")

    def test_loop_argument_cannot_bypass_budget(self) -> None:
        self.seed_code("S9", loop=1, level=2)
        result = self.t("S8", loop=1)
        self.assertEqual(result.code, "INVALID_ARGUMENT")

    def test_exit_checklist_unverifiable_reference_rejected(self) -> None:
        self.seed_code("S7")
        before = self.state_path.read_bytes()
        checklist = ExitChecklist("S7 Plan", ["not/a/real/file.py"], ["done"])
        result = self.t("S8", exit_checklist=checklist)
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "EXIT_CHECKLIST_INCOMPLETE")
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_exit_checklist_verified_reference_and_plan_files(self) -> None:
        self.seed_code("S7")
        (self.root / "src").mkdir()
        (self.root / "src" / "a.py").write_text("x = 1\n", encoding="utf-8")
        checklist = ExitChecklist("S7 Plan", ["path:src/a.py"], ["step completed"])
        result = self.t("S8", exit_checklist=checklist)
        self.assertTrue(result.ok, result.message)
        review = self.core.store.snapshot().fields["review"]
        self.assertEqual(review["plan_files"], ["src/a.py"])

    def test_exit_checklist_stage_mismatch(self) -> None:
        self.seed_code("S7")
        (self.root / "a.py").write_text("x\n", encoding="utf-8")
        result = self.t("S8", exit_checklist=ExitChecklist("S6 Design", ["a.py"], ["done"]))
        self.assertEqual(result.code, "EXIT_CHECKLIST_INCOMPLETE")

    def test_vc_violation_escalates_to_s14(self) -> None:
        self.seed_code("S8", loop=1)
        result = self.t("S9", vc_violation="touched protected asset")
        self.assertTrue(result.ok)
        self.assertEqual(self.core.get_state().phase, "S14 Safe Mode")
        self.assertEqual(result.code, "SCOPE_DENIED")


if __name__ == "__main__":
    unittest.main()
