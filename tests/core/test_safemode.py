from __future__ import annotations

import unittest

from runtime.core.safemode import (
    SAFE_MODE_ENFORCED,
    SAFE_MODE_OBSERVED,
    SAFE_MODE_SOURCES,
    evaluate,
)


class SafeModeTests(unittest.TestCase):
    def test_enforced_consecutive_failures(self) -> None:
        decision = evaluate(consecutive_count=2)
        self.assertTrue(decision.triggered)
        self.assertEqual(decision.reason, "consecutive_same_failures")
        self.assertEqual(decision.vc_code, "NO_PROGRESS")

    def test_enforced_loop_budget_by_level(self) -> None:
        self.assertFalse(evaluate(loop=1, level=1).triggered)
        decision = evaluate(loop=2, level=1)
        self.assertTrue(decision.triggered)
        self.assertEqual(decision.reason, "loop_budget_exhausted")
        self.assertTrue(evaluate(loop=3, level=2).triggered is False)
        self.assertTrue(evaluate(loop=4, level=2).triggered)

    def test_enforced_hard_constraint_single_report(self) -> None:
        decision = evaluate(hard_constraint_violation=True)
        self.assertTrue(decision.triggered)
        self.assertEqual(decision.reason, "hard_constraint_violation")
        self.assertEqual(decision.vc_code, "SCOPE_DENIED")

    def test_observed_metrics_never_trigger(self) -> None:
        decision = evaluate(metrics={"files_touched": 999, "failure_type_share": 0.99})
        self.assertFalse(decision.triggered)
        self.assertEqual(decision.observed["files_touched"], 999)
        self.assertEqual(set(SAFE_MODE_OBSERVED), {
            "files_touched",
            "hard_violation_repeats",
            "failure_type_share",
            "loops_vs_avg_ratio",
        })

    def test_sources_mapping(self) -> None:
        self.assertEqual(SAFE_MODE_SOURCES["consecutive_same_failures"], "consecutive_loops")
        self.assertEqual(SAFE_MODE_SOURCES["loop_budget_exhausted"], "loop_max")
        self.assertEqual(SAFE_MODE_SOURCES["hard_constraint_violation"], "hard_violation_repeats")
        self.assertEqual(SAFE_MODE_ENFORCED["consecutive_same_failures"], 2)


if __name__ == "__main__":
    unittest.main()
