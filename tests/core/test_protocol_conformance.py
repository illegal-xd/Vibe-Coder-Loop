from __future__ import annotations

import unittest
from pathlib import Path

from runtime.core.protocol import check_protocol

SKILL = Path(__file__).resolve().parents[2] / "skills" / "vibe-coder-loop"


def _read(name: str) -> str:
    return (SKILL / name).read_text(encoding="utf-8")


class ProtocolConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.transition = _read("engine/transition.md")
        cls.state_machine = _read("engine/state-machine.md")
        cls.kernel = _read("kernel.md")
        cls.complexity = _read("engine/complexity-gate.md")
        cls.manifest = _read("manifest.yaml")

    def check(self, **overrides: str):
        texts = {
            "transition_text": self.transition,
            "state_machine_text": self.state_machine,
            "kernel_text": self.kernel,
            "complexity_text": self.complexity,
            "manifest_text": self.manifest,
        }
        texts.update(overrides)
        return check_protocol(**texts)

    def test_repository_sources_are_consistent(self) -> None:
        report = self.check()
        self.assertTrue(report.ok, list(report.drifts) + list(report.unparsed))
        self.assertGreater(report.checks, 50)

    def test_v26_missing_edge_detected(self) -> None:
        mutated = self.transition.replace("S11 -> S12\n", "")
        report = self.check(transition_text=mutated)
        self.assertFalse(report.ok)
        self.assertEqual(report.code, "PROTOCOL_DRIFT")
        self.assertTrue(any(d["kind"] == "missing-edge" and "S11" in d["detail"] for d in report.drifts))

    def test_extra_edge_detected(self) -> None:
        mutated = self.transition.replace("S11 -> S12\n", "S11 -> S12, S13\n")
        report = self.check(transition_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "extra-edge" for d in report.drifts))

    def test_v35_modifier_drift_detected(self) -> None:
        mutated = self.transition.replace("S10 -> S7(+1/loop=0)", "S10 -> S7(loop=0)")
        report = self.check(transition_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "modifier" and "S10" in d["detail"] for d in report.drifts))

    def test_v35_increment_to_reset_detected(self) -> None:
        mutated = self.transition.replace("S9  -> S10, S8(+1)", "S9  -> S10, S8(loop=0)")
        report = self.check(transition_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "modifier" for d in report.drifts))

    def test_standard_loop_init_modifier_drift_detected(self) -> None:
        mutated = self.transition.replace("S7  -> S8(loop=init)", "S7  -> S8")
        report = self.check(transition_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "modifier" and "S7" in d["detail"] for d in report.drifts))

    def test_code_declares_standard_loop_init_edge(self) -> None:
        from runtime.core.state_machine import INIT_IF_ZERO_EDGES

        self.assertIn(("S7", "S8"), INIT_IF_ZERO_EDGES)

    def test_unparsable_block_fail_closed(self) -> None:
        mutated = self.transition.replace("S11 -> S12", "S11 => S12")
        report = self.check(transition_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(report.unparsed)

    def test_missing_escalation_declaration(self) -> None:
        mutated = self.transition.replace("ALL -> S14", "任何状态 -> S14 的升级入口")
        report = self.check(transition_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "escalation" for d in report.drifts))

    def test_label_drift_detected(self) -> None:
        mutated = self.state_machine.replace("| S5 Clarify |", "| S5 Rename |")
        report = self.check(state_machine_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "label" for d in report.drifts))

    def test_kernel_loop_limit_drift_detected(self) -> None:
        mutated = self.kernel.replace("最多执行 3 轮", "最多执行 5 轮")
        report = self.check(kernel_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "loop-max" for d in report.drifts))

    def test_complexity_drift_detected(self) -> None:
        mutated = self.manifest.replace(
            "stages: [S1, S2, S4, S8, S10, S13]",
            "stages: [S1, S2, S4, S8, S10, S13, S5]",
        )
        report = self.check(manifest_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "complexity" for d in report.drifts))

    def test_complexity_unknown_cell_fail_closed(self) -> None:
        mutated = self.complexity.replace("| 完整 | 完整 |", "| 神秘形态 | 完整 |", 1)
        report = self.check(complexity_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any("单元格无法识别" in item for item in report.unparsed))

    def test_loop_table_drift_detected(self) -> None:
        mutated = self.state_machine.replace("| 上限 | Loop 3 仍未通过", "| 上限 | Loop 5 仍未通过")
        report = self.check(state_machine_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "loop-table" for d in report.drifts))

    def test_safe_mode_key_drift_detected(self) -> None:
        mutated = self.manifest.replace("    consecutive_loops: 2", "    consecutive_loops_x: 2")
        report = self.check(manifest_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "safe-mode-keys" for d in report.drifts))

    def test_safe_mode_value_drift_detected(self) -> None:
        mutated = self.manifest.replace("    consecutive_loops: 2", "    consecutive_loops: 3")
        report = self.check(manifest_text=mutated)
        self.assertFalse(report.ok)
        self.assertTrue(any(d["kind"] == "safe-mode-value" for d in report.drifts))


if __name__ == "__main__":
    unittest.main()
