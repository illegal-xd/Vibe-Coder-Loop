from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _run(args: list[str], *, env: dict[str, str] | None = None):
    return subprocess.run(
        [sys.executable, "-m", "runtime.core.cli", *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        env=env,
    )


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "proj"
        self.root.mkdir()
        (self.root / ".git").mkdir()
        self.home = Path(self._tmp.name) / "home"
        self.home.mkdir()
        self.env = {**os.environ, "HOME": str(self.home)}

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_check_protocol_exit_zero(self) -> None:
        proc = _run(["check-protocol"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["ok"])

    def test_transition_then_get_state(self) -> None:
        proc = _run(["transition", "--cwd", str(self.root), "--to", "S1"], env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["to"], "S1")

        proc = _run(["get-state", "--cwd", str(self.root)], env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        state = json.loads(proc.stdout)
        self.assertEqual(state["phase"], "S1 Intent")
        self.assertEqual(state["loop"], 0)

    def test_illegal_transition_exit_four_with_code(self) -> None:
        _run(["transition", "--cwd", str(self.root), "--to", "S1"], env=self.env)
        proc = _run(["transition", "--cwd", str(self.root), "--to", "S8"], env=self.env)
        self.assertEqual(proc.returncode, 4)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["code"], "STATE_ILLEGAL_TRANSITION")
        self.assertTrue(payload["next"])
        self.assertIn("[STATE_ILLEGAL_TRANSITION]", payload["message"])
        self.assertTrue(payload["runtime"])

    def test_state_check(self) -> None:
        _run(["transition", "--cwd", str(self.root), "--to", "S1"], env=self.env)
        proc = _run(["state", "check", "--cwd", str(self.root)], env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["quality"], "strict")

    def test_snapshot_pointer(self) -> None:
        _run(["transition", "--cwd", str(self.root), "--to", "S1"], env=self.env)
        proc = _run(
            ["snapshot-task-zone", "--cwd", str(self.root), "--detail", "pointer"],
            env=self.env,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertIn("phase=S1 Intent", proc.stdout)
        self.assertIn("loop=0", proc.stdout)

    def test_checkpoint_location_error(self) -> None:
        proc = _run(["get-state", "--cwd", str(self.root / "missing")], env=self.env)
        self.assertEqual(proc.returncode, 4)
        self.assertEqual(json.loads(proc.stdout)["code"], "CHECKPOINT_LOCATION_UNRESOLVED")


if __name__ == "__main__":
    unittest.main()
