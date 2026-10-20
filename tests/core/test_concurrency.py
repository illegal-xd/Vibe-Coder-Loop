from __future__ import annotations

import multiprocessing as mp
import tempfile
import unittest
from pathlib import Path

from runtime.core import WorkflowCore
from runtime.core.state_machine import STATE_LABELS


def _write(root: str, fields: dict, expected_rev: int | None, out: mp.Queue) -> None:
    core = WorkflowCore(root, env={"HOME": str(Path(root) / "home")}, import_legacy=False)
    result = core.store.write(fields, expected_rev=expected_rev)
    out.put((result.ok, result.rev, result.code, fields))


class CrossProcessTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / ".git").mkdir()
        (self.root / "home").mkdir()
        self.core = WorkflowCore(
            self.root, env={"HOME": str(self.root / "home")}, import_legacy=False
        )
        self.seed = self.core.store.write({"phase": STATE_LABELS["S0"], "status": "active"})
        self.ctx = mp.get_context("spawn")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, fields: dict, expected_rev: int | None):
        queue = self.ctx.Queue()
        proc = self.ctx.Process(target=_write, args=(str(self.root), fields, expected_rev, queue))
        proc.start()
        proc.join(20)
        self.assertEqual(proc.exitcode, 0)
        return queue.get(timeout=5)

    def test_stale_rev_conflict_preserves_other_writer(self) -> None:
        stale = self.seed.rev
        other = self._run({"phase": STATE_LABELS["S2"]}, None)
        self.assertTrue(other[0])
        conflict = self._run({"phase": STATE_LABELS["S3"]}, stale)
        self.assertFalse(conflict[0])
        self.assertEqual(conflict[2], "STATE_REV_CONFLICT")
        self.assertEqual(self.core.get_state().phase, "S2 Preflight")

    def test_concurrent_append_union_no_loss(self) -> None:
        queue = self.ctx.Queue()
        procs = [
            self.ctx.Process(
                target=_write,
                args=(str(self.root), {"completed": [f"w{i}"]}, None, queue),
            )
            for i in range(4)
        ]
        for proc in procs:
            proc.start()
        for proc in procs:
            proc.join(30)
            self.assertEqual(proc.exitcode, 0)
        results = [queue.get(timeout=5) for _ in range(4)]
        self.assertTrue(all(item[0] for item in results))
        completed = self.core.store.snapshot().fields["completed"]
        for i in range(4):
            self.assertIn(f"w{i}", completed)

    def test_same_expected_rev_exactly_one_wins(self) -> None:
        rev = self.seed.rev
        queue = self.ctx.Queue()
        procs = [
            self.ctx.Process(
                target=_write,
                args=(str(self.root), {"current_step": f"w{i}"}, rev, queue),
            )
            for i in range(4)
        ]
        for proc in procs:
            proc.start()
        for proc in procs:
            proc.join(30)
            self.assertEqual(proc.exitcode, 0)
        results = [queue.get(timeout=5) for _ in range(4)]
        self.assertEqual(sum(1 for item in results if item[0]), 1)
        self.assertEqual(sum(1 for item in results if item[2] == "STATE_REV_CONFLICT"), 3)


if __name__ == "__main__":
    unittest.main()
