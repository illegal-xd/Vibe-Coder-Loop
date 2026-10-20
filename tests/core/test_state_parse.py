from __future__ import annotations

import unittest

from runtime.core.state_parse import (
    SubsetParseError,
    parse_subset,
    render_subset,
    scan_flat_scalars,
)


SAMPLE = {
    "_schema": 1,
    "_rev": 3,
    "status": "active",
    "updated_at": "2026-10-20 08:55",
    "phase": "S8 Code",
    "loop": 2,
    "level": 2,
    "goal": {
        "explicit": "实现 MVP-1",
        "constraints": ["零依赖", "不改 Skill 语义"],
        "risk": [],
    },
    "current_step": "写原子写",
    "completed": ["S1 Intent", "**强调项**", "S4 Router: done"],
    "pending": ["path: src/a.py", "人工确认项"],
    "decisions": [
        {"id": "D1", "what": "存储", "value": "YAML", "evidence": "设计 §7"},
    ],
    "review": {
        "result": "failed",
        "last_review": "none",
        "last_failure": "pytest: 2 failed",
        "issues": [],
        "failure_state": {
            "last_fingerprint": "fp:9f2c",
            "consecutive_count": 2,
            "history": ["fp:9a1", "fp:9f2c"],
        },
    },
    "user_decisions": [{"id": "U1", "what": "继续", "user_says": "继续"}],
    "resume": "上一轮完成写入\n下一步：跑测试\n",
    "unknown_key": {"nested": ["a", "b"]},
}


class ParseTests(unittest.TestCase):
    def test_round_trip_and_idempotent(self) -> None:
        rendered = render_subset(SAMPLE)
        parsed = parse_subset(rendered)
        self.assertEqual(parsed["completed"], SAMPLE["completed"])
        self.assertEqual(parsed["decisions"], SAMPLE["decisions"])
        self.assertEqual(parsed["resume"], SAMPLE["resume"])
        self.assertEqual(parsed["unknown_key"], SAMPLE["unknown_key"])
        self.assertEqual(render_subset(parsed), rendered)

    def test_quote_trap(self) -> None:
        data = {**SAMPLE, "pending": ["**重要**", "*强调*", "#不是注释"]}
        rendered = render_subset(data)
        parsed = parse_subset(rendered)
        self.assertEqual(parsed["pending"], data["pending"])
        self.assertIn('"**重要**"', rendered)

    def test_inline_comment_and_hash_in_quote(self) -> None:
        parsed = parse_subset('---\nphase: "S1 Intent" # comment\nresume: "a # b"\n')
        self.assertEqual(parsed["phase"], "S1 Intent")
        self.assertEqual(parsed["resume"], "a # b")

    def test_reject_flow_collection(self) -> None:
        with self.assertRaises(SubsetParseError):
            parse_subset("pending: [a, b]\n")

    def test_reject_anchor_alias_tag(self) -> None:
        for text in ("a: &x 1\n", "a: *x\n", "a: !!str 1\n"):
            with self.assertRaises(SubsetParseError):
                parse_subset(text)

    def test_reject_multi_document(self) -> None:
        with self.assertRaises(SubsetParseError):
            parse_subset("---\na: 1\n---\nb: 2\n")

    def test_reject_complex_key(self) -> None:
        with self.assertRaises(SubsetParseError):
            parse_subset("? key\n: value\n")

    def test_degraded_scan(self) -> None:
        text = """---
status: active
phase: S8 Code
loop: 1
level: 2
updated_at: 2026-10-20 08:55
completed: [unparsable
"""
        with self.assertRaises(SubsetParseError):
            parse_subset(text)
        flat = scan_flat_scalars(text)
        self.assertIsNotNone(flat)
        assert flat is not None
        self.assertEqual(flat["phase"], "S8 Code")
        self.assertEqual(flat["loop"], 1)

    def test_degraded_scan_garbage(self) -> None:
        self.assertIsNone(scan_flat_scalars("<<<>>>"))

    def test_missing_front_matter_accepted(self) -> None:
        self.assertEqual(parse_subset("phase: S0 Idle\n"), {"phase": "S0 Idle"})

    def test_empty_containers(self) -> None:
        parsed = parse_subset("a: []\nb: {}\n")
        self.assertEqual(parsed, {"a": [], "b": {}})

    def test_literal_block_preserves_comment_like_lines(self) -> None:
        data = {"a": "# 不是注释\n第二行\n"}
        self.assertEqual(parse_subset(render_subset(data)), data)

    def test_block_scalar_trailing_newlines_preserved(self) -> None:
        for value in ("a\n", "a\n\n", "a\n\n\n", "a\n \nb"):
            with self.subTest(value=value):
                data = {"a": value}
                self.assertEqual(parse_subset(render_subset(data)), data)

    def test_multiline_in_mapping_list_item_round_trips(self) -> None:
        data = {"items": [{"k": "v", "m": "x\ny\n"}]}
        self.assertEqual(parse_subset(render_subset(data)), data)

    def test_multiline_chomping(self) -> None:
        parsed = parse_subset("a: |\n  x\n  y\nb: |-\n  x\n")
        self.assertEqual(parsed["a"], "x\ny\n")
        self.assertEqual(parsed["b"], "x")


if __name__ == "__main__":
    unittest.main()
