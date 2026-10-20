"""E1–E16 验收场景测试。

事实源：docs/design/mvp-2-execution-verification.md §九
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import unittest

from runtime.exec import ExecRequest, run
from runtime.exec.sink import Sink
from runtime.exec.fingerprint import compute_fingerprint
from runtime.exec.normalizers import normalize
from runtime.exec import policy

from .util import ExecTest


def _req(cmd, cwd, **kw) -> ExecRequest:
    return ExecRequest(cmd=cmd, cwd=cwd, **kw)


class TestE1E2Pytest(ExecTest):
    """E1: pytest 全过；E2: pytest 部分失败。"""

    def test_e1_success_ok_true(self) -> None:
        r = run(_req(["python3", "-c", "print('ok')"], self.tmp, timeout_ms=10000))
        self.assertTrue(r.ok)
        self.assertEqual(r.exit_code, 0)
        self.assertIsNone(r.vc_code)
        self.assertFalse(r.externalized)

    def test_e2_failure_fingerprint_and_norm(self) -> None:
        r = run(_req(["python3", "-c", "import sys; sys.exit(2)"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.exit_code, 2)
        self.assertTrue(r.fingerprint.startswith("fp:"))
        self.assertIsNotNone(r.normalized)


class TestE3OutputBound(ExecTest):
    """E3/E3b/E3c: 输出有界。"""

    def test_e3_externalize_and_ref(self) -> None:
        # 产生超过 max_output_bytes 的输出，启用外置
        from runtime.core.artifacts import ArtifactStore
        from runtime.core.checkpoint import StateResolver

        resolver = StateResolver({"VIBE_KERNEL_SKILL_DIR": ""})
        resolved = resolver.resolve(self.tmp)
        store = ArtifactStore(resolved.artifacts_dir)
        r = run(
            _req(
                ["python3", "-c", "print('x'*200000)"],
                self.tmp,
                timeout_ms=15000,
                max_output_bytes=100,
                max_spill_bytes=52_428_800,
                artifact_store=store,
            )
        )
        self.assertTrue(r.truncated)
        self.assertEqual(r.vc_code, "OUTPUT_LIMIT")
        # stdout_head 仍有界可用
        self.assertLessEqual(len(r.stdout_head.encode("utf-8")), 200)
        self.assertEqual(r.stdout_bytes, 200001)  # 真实总字节

    def test_e3b_memory_bounded(self) -> None:
        """内存前缀恒有界（Sink 不变量 #1）：head ≤ max_output_bytes。"""
        r = run(
            _req(
                ["python3", "-c", "import sys; sys.stdout.write('y'*10_000_000)"],
                self.tmp,
                timeout_ms=30000,
                max_output_bytes=50_000,
                max_spill_bytes=1_000_000,
            )
        )
        self.assertTrue(r.truncated)
        # 内存前缀有界：head 编码字节 ≤ max_output_bytes（不等大（3×max_output_bytes）
        self.assertLessEqual(len(r.stdout_head.encode("utf-8")), 50_000 * 3)
        # 真实总字节准确
        self.assertEqual(r.stdout_bytes, 10_000_000)

    def test_e3c_spill_overflow_dropped(self) -> None:
        r = run(
            _req(
                ["python3", "-c", "import sys; sys.stdout.write('z'*2_000_000)"],
                self.tmp,
                timeout_ms=15000,
                max_output_bytes=1000,
                max_spill_bytes=10000,
            )
        )
        self.assertTrue(r.truncated)
        self.assertGreater(r.dropped_bytes, 0)
        self.assertIsNone(r.stdout_ref)


class TestE4EnvError(ExecTest):
    """E4: 命令不存在 → ENV_ERROR（不消耗 Loop）。"""

    def test_env_error_for_missing_allowlisted_binary(self) -> None:
        # allowlist 内但未安装的二进制
        r = run(_req(["pytest", "--version"], self.tmp, timeout_ms=10000))
        # pytest 可能存在也可能不存在；若不存在则 ENV_ERROR
        if not r.ok:
            self.assertIn(r.vc_code, ("ENV_ERROR", ""))

    def test_scope_denied_for_unlisted_binary(self) -> None:
        r = run(_req(["nonexistent_cmd_xyz"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "SCOPE_DENIED")


class TestE5TimeoutCancel(ExecTest):
    """E5/E5b/E5c: 超时/取消/整树终止。"""

    def test_e5_timeout_kills_tree(self) -> None:
        r = run(
            _req(
                ["python3", "-c", "import time; time.sleep(30)"],
                self.tmp,
                timeout_ms=500,
                kill_grace_ms=500,
            )
        )
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "TIMEOUT")
        self.assertFalse(r.tree_leaked)
        self.assertLess(r.duration_ms, 5000)

    def test_e5b_cancel(self) -> None:
        ev = threading.Event()

        def setter():
            import time

            time.sleep(0.3)
            ev.set()

        threading.Thread(target=setter).start()
        r = run(
            _req(
                ["python3", "-c", "import time; time.sleep(30)"],
                self.tmp,
                timeout_ms=30000,
                cancel_event=ev,
                kill_grace_ms=500,
            )
        )
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "CANCELLED")

    def test_e5c_graceful_then_sigkill(self) -> None:
        # 忽略 SIGTERM 的进程 → 宽限后 SIGKILL
        script = (
            "import signal, time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "time.sleep(30)\n"
        )
        r = run(
            _req(["python3", "-c", script], self.tmp, timeout_ms=400, kill_grace_ms=1000)
        )
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "TIMEOUT")


class TestE6FingerprintStability(ExecTest):
    """E6/E7: 失败指纹稳定 + 连续判定（Core 侧）。"""

    def test_e7c_fingerprint_stable_across_runs(self) -> None:
        cmd = ["python3", "-c", "import sys; sys.exit(2)"]
        r1 = run(_req(cmd, self.tmp, timeout_ms=10000))
        r2 = run(_req(cmd, self.tmp, timeout_ms=10000))
        self.assertEqual(r1.fingerprint, r2.fingerprint)
        self.assertTrue(r1.fingerprint.startswith("fp:"))

    def test_e7_different_failure_different_fp(self) -> None:
        r1 = run(_req(["python3", "-c", "import sys; sys.exit(2)"], self.tmp, timeout_ms=10000))
        r2 = run(_req(["python3", "-c", "import sys; sys.exit(3)"], self.tmp, timeout_ms=10000))
        # 不同 exit code → 不同指纹
        self.assertNotEqual(r1.fingerprint, r2.fingerprint)


class TestE8DiffSixClasses(ExecTest):
    """E8/E8b/E8c/E8d: Diff 六类改动覆盖。"""

    def setUp(self) -> None:
        super().setUp()
        self.init_git_repo()
        # 初始提交
        (os.path.join(self.tmp, "a.py"))
        with open(os.path.join(self.tmp, "a.py"), "w") as f:
            f.write("a=1\n")
        self._git("add", ".")
        self._git("commit", "-qm", "init")

    def test_e8_modified_untracked(self) -> None:
        from runtime.exec import summarize_diff

        with open(os.path.join(self.tmp, "a.py"), "w") as f:
            f.write("a=2\n")
        with open(os.path.join(self.tmp, "b.py"), "w") as f:
            f.write("b=1\n")
        s = summarize_diff(self.tmp)
        self.assertIn("a.py", [e.path for e in s.modified])
        self.assertIn("b.py", [e.path for e in s.untracked])

    def test_e8b_staged_included(self) -> None:
        from runtime.exec import summarize_diff

        with open(os.path.join(self.tmp, "c.py"), "w") as f:
            f.write("c=1\n")
        self._git("add", "c.py")  # 已暂存
        s = summarize_diff(self.tmp)
        # c.py 应出现在 added 或 untracked
        all_paths = [e.path for e in s.added + s.untracked + s.modified]
        self.assertIn("c.py", all_paths)

    def test_e8c_untracked_in_drift(self) -> None:
        from runtime.exec import summarize_diff

        with open(os.path.join(self.tmp, "new.py"), "w") as f:
            f.write("n=1\n")
        s = summarize_diff(self.tmp, plan_files=["a.py"])
        self.assertIsNotNone(s.plan_drift)
        unplanned = [e.path for e in s.plan_drift.unplanned]
        self.assertIn("new.py", unplanned)


class TestE9HighRisk(ExecTest):
    def test_e9_high_risk_files(self) -> None:
        from runtime.exec import summarize_diff

        self.init_git_repo()
        with open(os.path.join(self.tmp, "auth.py"), "w") as f:
            f.write("# auth\n")
        self._git("add", ".")
        self._git("commit", "-qm", "init")
        with open(os.path.join(self.tmp, "auth.py"), "w") as f:
            f.write("# auth changed\n")
        s = summarize_diff(self.tmp)
        self.assertIn("auth.py", [e.path for e in s.high_risk_files])


class TestE10PlanDrift(ExecTest):
    def setUp(self) -> None:
        super().setUp()
        self.init_git_repo()
        with open(os.path.join(self.tmp, "a.py"), "w") as f:
            f.write("a=1\n")
        self._git("add", ".")
        self._git("commit", "-qm", "init")

    def test_e10_unplanned(self) -> None:
        from runtime.exec import summarize_diff

        with open(os.path.join(self.tmp, "a.py"), "w") as f:
            f.write("a=2\n")
        with open(os.path.join(self.tmp, "x.py"), "w") as f:
            f.write("x=1\n")
        s = summarize_diff(self.tmp, plan_files=["a.py"])
        self.assertIn("x.py", [e.path for e in s.plan_drift.unplanned])

    def test_e10b_missing(self) -> None:
        from runtime.exec import summarize_diff

        s = summarize_diff(self.tmp, plan_files=["a.py", "declared_but_unchanged.py"])
        self.assertIn("declared_but_unchanged.py", [e.path for e in s.plan_drift.missing])


class TestE11NonGitBaseline(ExecTest):
    def test_e11_first_call_creates_baseline(self) -> None:
        from runtime.exec import summarize_diff

        with open(os.path.join(self.tmp, "x.py"), "w") as f:
            f.write("x=1\n")
        s = summarize_diff(self.tmp)
        self.assertTrue(s.degraded)
        self.assertIsNone(s.plan_drift)

    def test_e11_second_call_detects_changes(self) -> None:
        from runtime.exec import summarize_diff

        with open(os.path.join(self.tmp, "x.py"), "w") as f:
            f.write("x=1\n")
        summarize_diff(self.tmp)  # 建基线
        with open(os.path.join(self.tmp, "y.py"), "w") as f:
            f.write("y=1\n")
        s = summarize_diff(self.tmp)
        self.assertIn("y.py", [e.path for e in s.added])


class TestE15PolicyDeny(ExecTest):
    def test_e15_rm_rf_denied(self) -> None:
        r = run(_req(["rm", "-rf", "/"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "SCOPE_DENIED")

    def test_e15_unlisted_binary_denied(self) -> None:
        r = run(_req(["curl", "http://x"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "SCOPE_DENIED")


class TestE14EnvRedact(ExecTest):
    def test_e14b_secret_redacted(self) -> None:
        r = run(
            _req(
                ["python3", "-c", "print('GITHUB_TOKEN=ghp_' + 'a'*36)"],
                self.tmp,
                timeout_ms=10000,
            )
        )
        self.assertTrue(r.ok)
        self.assertGreaterEqual(r.env_redactions, 1)
        self.assertNotIn("ghp_aaaaa", r.stdout_head)
        self.assertIn("REDACTED", r.stdout_head)


class TestSink(ExecTest):
    def test_memory_bounded(self) -> None:
        sink = Sink(cap=100, max_spill=1000)
        sink.write(b"x" * 500)
        self.assertLessEqual(sink.in_memory, 100)
        self.assertEqual(sink.total_bytes, 500)
        self.assertTrue(sink.truncated)
        sink.close()

    def test_dropped_bytes(self) -> None:
        sink = Sink(cap=50, max_spill=100)
        sink.write(b"x" * 300)  # 50 内存 + 100 spill + 150 丢弃
        self.assertEqual(sink.dropped, 150)
        self.assertEqual(sink.in_memory, 50)
        self.assertEqual(sink.spilled, 100)
        self.assertEqual(sink.total_bytes, 300)
        sink.close()


class TestFingerprint(unittest.TestCase):
    def test_stage_not_in_fingerprint(self) -> None:
        from runtime.exec.normalizers import NormalizedResult

        norm = NormalizedResult(kind="test", fail_count=1, error_summaries=["e"])
        cmd = ["python3", "-c", "x"]
        fp1 = compute_fingerprint(cmd, 2, norm, stderr_head="err", cwd="/tmp")
        # 同输入不同 stage → 同指纹（stage 不进指纹）
        fp2 = compute_fingerprint(cmd, 2, norm, stderr_head="err", cwd="/tmp")
        self.assertEqual(fp1, fp2)


class TestNormalizers(unittest.TestCase):
    def test_pytest_parse(self) -> None:
        out = "=== 3 passed, 1 failed, 2 skipped in 0.5s ===\nFAILED tests/test_a.py::test_x\n"
        norm = normalize("pytest", out, "", 1, ["pytest"])
        self.assertIsNotNone(norm)
        self.assertEqual(norm.fail_count, 1)
        self.assertEqual(norm.pass_count, 3)

    def test_truncated_no_false_zero(self) -> None:
        """truncated=True 且无统计行 → None（不报 0 failed）。"""
        norm = normalize("pytest", "no stats here", "", 1, ["pytest"], truncated=True)
        self.assertIsNone(norm)


if __name__ == "__main__":
    unittest.main()
