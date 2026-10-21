"""E1–E16 验收场景测试（审查强化版）。

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
from runtime.exec.normalizers import normalize, infer_lang
from runtime.exec import policy
from runtime.exec.diff import summarize_diff

from .util import ExecTest


def _req(cmd, cwd, **kw) -> ExecRequest:
    return ExecRequest(cmd=cmd, cwd=cwd, **kw)


class TestE1E2Pytest(ExecTest):
    """E1: pytest 全过；E2: pytest 部分失败。用真实 pytest 格式输出。"""

    PYTEST_PASS = (
        "============================= test session starts ==============================\n"
        "collected 3 items\n\n"
        "tests/test_a.py ... [100%]\n\n"
        "============================== 3 passed in 0.50s ==============================\n"
    )
    PYTEST_FAIL = (
        "============================= test session starts ==============================\n"
        "collected 4 items\n\n"
        "tests/test_a.py ...F [100%]\n\n"
        "=================================== FAILURES ===================================\n"
        "tests/test_a.py::test_d\n"
        "    assert 1 == 2\n"
        "E   assert 1 == 2\n"
        "=========================== short test summary info ===========================\n"
        "FAILED tests/test_a.py::test_d - assert 1 == 2\n"
        "=========================== 3 passed, 1 failed in 0.50s ========================\n"
    )

    def test_e1_success_ok_true(self) -> None:
        r = run(_req(["python3", "-c", "print('ok')"], self.tmp, timeout_ms=10000))
        self.assertTrue(r.ok)
        self.assertEqual(r.exit_code, 0)
        self.assertIsNone(r.vc_code)
        self.assertFalse(r.externalized)

    def test_e1_pytest_normalize_pass(self) -> None:
        """验证 pytest 归一化器正确解析 pass_count。"""
        norm = normalize("pytest", self.PYTEST_PASS, "", 0, ["pytest"])
        self.assertIsNotNone(norm)
        self.assertEqual(norm.kind, "test")
        self.assertEqual(norm.pass_count, 3)
        self.assertEqual(norm.fail_count, 0)

    def test_e2_pytest_normalize_fail(self) -> None:
        """验证 pytest 归一化器正确解析 fail_count + error_summaries。"""
        norm = normalize("pytest", self.PYTEST_FAIL, "", 1, ["pytest"])
        self.assertIsNotNone(norm)
        self.assertEqual(norm.pass_count, 3)
        self.assertEqual(norm.fail_count, 1)
        self.assertTrue(len(norm.error_summaries) > 0)

    def test_e2_failure_fingerprint_and_norm(self) -> None:
        r = run(_req(["python3", "-c", "import sys; sys.exit(2)"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.exit_code, 2)
        self.assertTrue(r.fingerprint.startswith("fp:"))
        self.assertIsNotNone(r.normalized)

    def test_e2_python3_m_pytest_recognized(self) -> None:
        """DL-04 修复：python3 -m pytest 应被 infer_lang 识别为 pytest。"""
        self.assertEqual(infer_lang(["python3", "-m", "pytest", "-x"]), "pytest")
        self.assertEqual(infer_lang(["python", "-m", "pytest"]), "pytest")
        self.assertEqual(infer_lang(["pytest", "-v"]), "pytest")


class TestE3OutputBound(ExecTest):
    """E3/E3b/E3c: 输出有界。"""

    def test_e3_externalize_and_ref(self) -> None:
        """TS-10 强化：断言 ref + externalized + artifact_error。"""
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
        self.assertLessEqual(len(r.stdout_head.encode("utf-8")), 100)
        self.assertEqual(r.stdout_bytes, 200001)
        # TS-10 强化断言
        self.assertTrue(r.externalized)
        self.assertIsNotNone(r.stdout_ref)
        self.assertIsNone(r.artifact_error)

    def test_e3_no_store_truncated_sets_output_limit(self) -> None:
        """TS-01 修复验证：无 artifact_store 时 truncated 仍设 OUTPUT_LIMIT。"""
        r = run(
            _req(
                ["python3", "-c", "print('x'*10000)"],
                self.tmp,
                timeout_ms=15000,
                max_output_bytes=100,
                max_spill_bytes=100000,
            )
        )
        self.assertTrue(r.truncated)
        self.assertEqual(r.vc_code, "OUTPUT_LIMIT")
        self.assertFalse(r.externalized)
        self.assertIsNone(r.stdout_ref)

    def test_e3b_memory_bounded(self) -> None:
        """E3b 必测项：head ≤ max_output_bytes（严格 1× 上限）。"""
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
        # 严格断言：head 编码字节 ≤ max_output_bytes
        self.assertLessEqual(len(r.stdout_head.encode("utf-8")), 50_000)
        self.assertEqual(r.stdout_bytes, 10_000_000)
        self.assertGreater(r.dropped_bytes, 0)

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
        self.assertEqual(r.vc_code, "OUTPUT_LIMIT")
        self.assertIsNone(r.stdout_ref)


class TestE4EnvError(ExecTest):
    """E4: 命令不存在 → ENV_ERROR/SCOPE_DENIED。"""

    def test_e4_scope_denied_unlisted(self) -> None:
        """不在 allowlist 的二进制 → SCOPE_DENIED（无条件断言）。"""
        r = run(_req(["nonexistent_cmd_xyz"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "SCOPE_DENIED")

    def test_e4_env_error_allowlisted_missing(self) -> None:
        """在 allowlist 但 PATH 中不存在 → ENV_ERROR（无条件断言）。"""
        r = run(_req(["vitest", "--version"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "ENV_ERROR")


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
        # TS-16 强化：验证进程被终止
        self.assertFalse(r.tree_leaked)

    def test_e5c_graceful_then_sigkill(self) -> None:
        """E5c 必测项：忽略 SIGTERM → 宽限后 SIGKILL；tree_leaked=False。"""
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
        # TS-12 强化：SIGKILL 必须生效，tree_leaked=False
        self.assertFalse(r.tree_leaked)

    def test_e5c_subprocess_tree_killed(self) -> None:
        """验证孙进程也被终止（整树 killpg）。"""
        script = (
            "import subprocess, time\n"
            "p = subprocess.Popen(['python3', '-c', 'import time; time.sleep(60)'])\n"
            "time.sleep(30)\n"
        )
        r = run(
            _req(["python3", "-c", script], self.tmp, timeout_ms=400, kill_grace_ms=500)
        )
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "TIMEOUT")
        self.assertFalse(r.tree_leaked)


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
        self.assertNotEqual(r1.fingerprint, r2.fingerprint)

    def test_e6_consecutive_to_core(self) -> None:
        """E6: 连续 2 次同指纹 → Core repeat_check 触发 NO_PROGRESS。"""
        from runtime.core import WorkflowCore, transition

        os.environ["HOME"] = self.tmp
        core = WorkflowCore(self.tmp)
        core.transition("S1", reason="start")
        core.transition("S8", loop=1)

        cmd = ["python3", "-c", "import sys; sys.exit(2)"]
        r1 = run(_req(cmd, self.tmp, timeout_ms=10000))
        fr1 = core.feed_exec(r1.to_core_result())
        self.assertFalse(fr1.no_progress)

        r2 = run(_req(cmd, self.tmp, timeout_ms=10000))
        fr2 = core.feed_exec(r2.to_core_result())
        self.assertTrue(fr2.no_progress)
        self.assertEqual(fr2.consecutive_count, 2)

    def test_e6d_aba_no_progress(self) -> None:
        """E6d：A→B→A 三次失败 → 不触发 NO_PROGRESS（连续 ≠ 集合包含）。"""
        from runtime.core import WorkflowCore

        os.environ["HOME"] = self.tmp
        core = WorkflowCore(self.tmp)
        core.transition("S1", reason="start")
        core.transition("S8", loop=1)

        # fp:A → count=1
        r_a = run(_req(["python3", "-c", "import sys; sys.exit(2)"], self.tmp, timeout_ms=10000))
        fr_a = core.feed_exec(r_a.to_core_result())
        self.assertFalse(fr_a.no_progress)
        self.assertEqual(fr_a.consecutive_count, 1)

        # fp:B → count=1（重置）
        r_b = run(_req(["python3", "-c", "import sys; sys.exit(3)"], self.tmp, timeout_ms=10000))
        fr_b = core.feed_exec(r_b.to_core_result())
        self.assertFalse(fr_b.no_progress)
        self.assertEqual(fr_b.consecutive_count, 1)

        # fp:A again → count=1（不等于3，不触发 NO_PROGRESS）
        r_a2 = run(_req(["python3", "-c", "import sys; sys.exit(2)"], self.tmp, timeout_ms=10000))
        fr_a2 = core.feed_exec(r_a2.to_core_result())
        self.assertFalse(fr_a2.no_progress)
        self.assertEqual(fr_a2.consecutive_count, 1)


class TestE7bCrossStageSameFp(unittest.TestCase):
    """E7b: 同错跨 S8/S9 同指纹。"""

    def test_e7b_same_fp_different_stage(self) -> None:
        from runtime.exec.normalizers import NormalizedResult

        norm = NormalizedResult(kind="test", fail_count=1, error_summaries=["e"])
        cmd = ["python3", "-c", "x"]
        fp_s8 = compute_fingerprint(cmd, 2, norm, stderr_head="err", cwd="/tmp")
        fp_s9 = compute_fingerprint(cmd, 2, norm, stderr_head="err", cwd="/tmp")
        self.assertEqual(fp_s8, fp_s9)


class TestE8DiffSixClasses(ExecTest):
    """E8/E8b/E8c/E8d: Diff 六类改动覆盖。"""

    def setUp(self) -> None:
        super().setUp()
        self.init_git_repo()
        with open(os.path.join(self.tmp, "a.py"), "w") as f:
            f.write("a=1\n")
        with open(os.path.join(self.tmp, "a_orig.py"), "w") as f:
            f.write("orig=1\n")
        self._git("add", ".")
        self._git("commit", "-qm", "init")

    def test_e8_modified_untracked_deleted(self) -> None:
        """E8 必测项：三类 git diff 改动（modified + untracked + deleted）。"""
        with open(os.path.join(self.tmp, "a.py"), "w") as f:
            f.write("a=2\n")
        with open(os.path.join(self.tmp, "b.py"), "w") as f:
            f.write("b=1\n")
        os.remove(os.path.join(self.tmp, "a_orig.py"))
        s = summarize_diff(self.tmp)
        self.assertIn("a.py", [e.path for e in s.modified])
        self.assertIn("b.py", [e.path for e in s.untracked])
        # E8 缺 deleted 补全：删除的文件应出现在 deleted
        deleted_paths = [e.path for e in s.deleted]
        self.assertTrue(len(deleted_paths) > 0, f"expected deleted files, got {deleted_paths}")
        self.assertTrue(any("a_orig" in p for p in deleted_paths),
                        f"expected a_orig.py in deleted, got {deleted_paths}")

    def test_e8b_staged_in_added(self) -> None:
        """TS-19 强化：staged 新增应出现在 added（修复 -z 解析后）。"""
        with open(os.path.join(self.tmp, "c.py"), "w") as f:
            f.write("c=1\n")
        self._git("add", "c.py")
        s = summarize_diff(self.tmp)
        self.assertIn("c.py", [e.path for e in s.added])

    def test_e8c_untracked_in_drift(self) -> None:
        with open(os.path.join(self.tmp, "new.py"), "w") as f:
            f.write("n=1\n")
        s = summarize_diff(self.tmp, plan_files=["a.py"])
        self.assertIsNotNone(s.plan_drift)
        unplanned = [e.path for e in s.plan_drift.unplanned]
        self.assertIn("new.py", unplanned)

    def test_e8d_rename_detected(self) -> None:
        """E8d：重命名被记为 rename，不算成删+增。"""
        os.rename(os.path.join(self.tmp, "a.py"), os.path.join(self.tmp, "a_renamed.py"))
        self._git("add", "-A")
        s = summarize_diff(self.tmp)
        renamed_paths = [(f.path, t.path) for f, t in s.renamed]
        self.assertTrue(
            any("a.py" in f and "a_renamed" in t for f, t in renamed_paths),
            f"expected rename a.py → a_renamed.py, got {renamed_paths}",
        )
        # rename 不算成 deleted + added
        added_paths = [e.path for e in s.added]
        deleted_paths = [e.path for e in s.deleted]
        self.assertNotIn("a_renamed.py", added_paths)
        self.assertNotIn("a.py", deleted_paths)

    def test_e8_numstat_correct(self) -> None:
        """DL-03 修复验证：numstat 正确解析 insertions/deletions。"""
        with open(os.path.join(self.tmp, "a.py"), "w") as f:
            f.write("a=2\nb=3\n")
        s = summarize_diff(self.tmp)
        self.assertGreater(s.total_insertions, 0)
        self.assertGreater(s.total_deletions, 0)


class TestE9HighRisk(ExecTest):
    def test_e9_high_risk_files(self) -> None:
        self.init_git_repo()
        with open(os.path.join(self.tmp, "auth.py"), "w") as f:
            f.write("# auth\n")
        self._git("add", ".")
        self._git("commit", "-qm", "init")
        with open(os.path.join(self.tmp, "auth.py"), "w") as f:
            f.write("# auth changed\n")
        s = summarize_diff(self.tmp)
        self.assertIn("auth.py", [e.path for e in s.high_risk_files])

    def test_e9_key_not_false_positive(self) -> None:
        """DL-13 修复：keyboard.py 不触发高风险。"""
        self.init_git_repo()
        with open(os.path.join(self.tmp, "keyboard.py"), "w") as f:
            f.write("# keyboard\n")
        self._git("add", ".")
        self._git("commit", "-qm", "init")
        with open(os.path.join(self.tmp, "keyboard.py"), "w") as f:
            f.write("# keyboard v2\n")
        s = summarize_diff(self.tmp)
        self.assertNotIn("keyboard.py", [e.path for e in s.high_risk_files])

    def test_e9_api_key_is_high_risk(self) -> None:
        self.init_git_repo()
        with open(os.path.join(self.tmp, "api_key.py"), "w") as f:
            f.write("# key\n")
        self._git("add", ".")
        self._git("commit", "-qm", "init")
        with open(os.path.join(self.tmp, "api_key.py"), "w") as f:
            f.write("# changed\n")
        s = summarize_diff(self.tmp)
        self.assertIn("api_key.py", [e.path for e in s.high_risk_files])


class TestE10PlanDrift(ExecTest):
    def setUp(self) -> None:
        super().setUp()
        self.init_git_repo()
        with open(os.path.join(self.tmp, "a.py"), "w") as f:
            f.write("a=1\n")
        self._git("add", ".")
        self._git("commit", "-qm", "init")

    def test_e10_unplanned(self) -> None:
        with open(os.path.join(self.tmp, "a.py"), "w") as f:
            f.write("a=2\n")
        with open(os.path.join(self.tmp, "x.py"), "w") as f:
            f.write("x=1\n")
        s = summarize_diff(self.tmp, plan_files=["a.py"])
        self.assertIn("x.py", [e.path for e in s.plan_drift.unplanned])

    def test_e10b_missing(self) -> None:
        s = summarize_diff(self.tmp, plan_files=["a.py", "declared_but_unchanged.py"])
        self.assertIn("declared_but_unchanged.py", [e.path for e in s.plan_drift.missing])


class TestE11NonGitBaseline(ExecTest):
    def test_e11_first_call_creates_baseline(self) -> None:
        with open(os.path.join(self.tmp, "x.py"), "w") as f:
            f.write("x=1\n")
        s = summarize_diff(self.tmp)
        self.assertTrue(s.degraded)
        self.assertIsNone(s.plan_drift)  # DL-12: first_run → None

    def test_e11_second_call_detects_changes(self) -> None:
        with open(os.path.join(self.tmp, "x.py"), "w") as f:
            f.write("x=1\n")
        summarize_diff(self.tmp)
        with open(os.path.join(self.tmp, "y.py"), "w") as f:
            f.write("y=1\n")
        s = summarize_diff(self.tmp)
        self.assertIn("y.py", [e.path for e in s.added])

    def test_e11_first_run_plan_drift_none(self) -> None:
        """DL-12 修复：first_run 且有 plan_files → plan_drift=None（非全 missing）。"""
        s = summarize_diff(self.tmp, plan_files=["a.py", "b.py"])
        self.assertIsNone(s.plan_drift)


class TestE12TruncatedNoFalseZero(unittest.TestCase):
    """E12: truncated=True 且无统计行 → None（不报 0 failed）。"""

    def test_e12_pytest_truncated_no_stats(self) -> None:
        norm = normalize("pytest", "no stats here", "", 1, ["pytest"], truncated=True)
        self.assertIsNone(norm)

    def test_e12_generic_truncated_still_works(self) -> None:
        norm = normalize("generic", "some output", "", 1, ["cmd"], truncated=True)
        self.assertIsNotNone(norm)


class TestE14EnvRedact(ExecTest):
    """E14/E14b: 环境隔离 + 脱敏。"""

    def test_e14_env_isolation(self) -> None:
        """E14: 宿主敏感 env 变量不传递到子进程。"""
        os.environ["SECRET_TOKEN_TEST"] = "supersecret123"
        try:
            r = run(
                _req(
                    ["python3", "-c", "import os; print(os.environ.get('SECRET_TOKEN_TEST', 'ABSENT'))"],
                    self.tmp,
                    timeout_ms=10000,
                )
            )
            self.assertTrue(r.ok)
            self.assertIn("ABSENT", r.stdout_head)
            self.assertNotIn("supersecret123", r.stdout_head)
        finally:
            del os.environ["SECRET_TOKEN_TEST"]

    def test_e14b_secret_redacted(self) -> None:
        """E14b 必测项：env 中的 token 值若被打到输出 → 被脱敏。"""
        os.environ["GITHUB_TOKEN"] = "ghp_" + "a" * 36
        try:
            r = run(
                _req(
                    ["python3", "-c", "import os; v=os.environ.get('GITHUB_TOKEN',''); print(f'GITHUB_TOKEN={v}')"],
                    self.tmp,
                    timeout_ms=10000,
                    env_passthrough=["GITHUB_TOKEN"],
                )
            )
            self.assertTrue(r.ok)
            self.assertGreaterEqual(r.env_redactions, 1)
            self.assertNotIn("ghp_aaaa", r.stdout_head)
            self.assertIn("REDACTED", r.stdout_head)
        finally:
            del os.environ["GITHUB_TOKEN"]


class TestE15PolicyDeny(ExecTest):
    def test_e15_rm_rf_denied(self) -> None:
        r = run(_req(["rm", "-rf", "/"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "SCOPE_DENIED")

    def test_e15_unlisted_binary_denied(self) -> None:
        r = run(_req(["curl", "http://x"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "SCOPE_DENIED")

    def test_e15_git_fetch_denied(self) -> None:
        """TS-05 修复：非只读 git 子命令被拒绝。"""
        r = run(_req(["git", "fetch"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "SCOPE_DENIED")

    def test_e15_git_pull_denied(self) -> None:
        r = run(_req(["git", "pull"], self.tmp, timeout_ms=10000))
        self.assertFalse(r.ok)
        self.assertEqual(r.vc_code, "SCOPE_DENIED")

    def test_e15_git_readonly_allowed(self) -> None:
        """只读 git 子命令（status/log/diff）仍允许。"""
        self.init_git_repo()
        with open(os.path.join(self.tmp, "a.txt"), "w") as f:
            f.write("a\n")
        self._git("add", ".")
        self._git("commit", "-qm", "init")
        r = run(_req(["git", "status"], self.tmp, timeout_ms=10000))
        self.assertTrue(r.ok)
        self.assertIsNone(r.vc_code)


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
        sink.write(b"x" * 300)
        self.assertEqual(sink.dropped, 150)
        self.assertEqual(sink.in_memory, 50)
        self.assertEqual(sink.spilled, 100)
        self.assertEqual(sink.total_bytes, 300)
        sink.close()

    def test_spill_content_max_bytes(self) -> None:
        """DL-07 修复：spill_content 支持 max_bytes 限制读取量。"""
        sink = Sink(cap=50, max_spill=10_000)
        sink.write(b"x" * 5000)
        full = sink.spill_content()
        self.assertEqual(len(full), 4950)  # 5000 - 50 in memory
        limited = sink.spill_content(max_bytes=100)
        self.assertEqual(len(limited), 100)
        sink.close()


class TestFingerprint(unittest.TestCase):
    def test_stage_not_in_fingerprint(self) -> None:
        from runtime.exec.normalizers import NormalizedResult

        norm = NormalizedResult(kind="test", fail_count=1, error_summaries=["e"])
        cmd = ["python3", "-c", "x"]
        fp1 = compute_fingerprint(cmd, 2, norm, stderr_head="err", cwd="/tmp")
        fp2 = compute_fingerprint(cmd, 2, norm, stderr_head="err", cwd="/tmp")
        self.assertEqual(fp1, fp2)

    def test_env_failures_no_fingerprint(self) -> None:
        """环境类失败 fingerprint="" （不进指纹计数）。"""
        # TIMEOUT/CANCELLED 由 runner 设 fingerprint=""，这里验证 compute_fingerprint 本身
        # 正常退出 0 + no norm → 仍可算（非环境类）
        fp = compute_fingerprint(["cmd"], 0, None, stderr_head="", cwd="/tmp")
        self.assertTrue(fp.startswith("fp:"))


class TestE12Eslint(unittest.TestCase):
    """E12: eslint 0 error → ok=True, kind=lint；truncated → None。"""

    def test_e12_eslint_zero_errors(self) -> None:
        """E12 设计场景：eslint 0 error → ok=True。"""
        norm = normalize("eslint", "0 problems", "", 0, ["eslint"])
        self.assertIsNotNone(norm)
        self.assertEqual(norm.kind, "lint")
        self.assertEqual(norm.fail_count, 0)

    def test_e12_eslint_with_errors(self) -> None:
        out = (
            "\n  1:5  error  Expected \'foo\'  no-undef\n\n"
            "✖ 1 problem (1 error, 0 warnings)\n"
        )
        norm = normalize("eslint", out, "", 1, ["eslint"])
        self.assertIsNotNone(norm)
        self.assertEqual(norm.kind, "lint")
        self.assertEqual(norm.fail_count, 1)

    def test_e12_truncated_no_false_zero(self) -> None:
        norm = normalize("pytest", "no stats here", "", 1, ["pytest"], truncated=True)
        self.assertIsNone(norm)


class TestE13ArtifactPaging(ExecTest):
    """E13/E13b: artifact 分页读取 + put 失败处理。"""

    def test_e13_artifact_page(self) -> None:
        """E13: artifact page 分页取 stdout。"""
        from runtime.core.artifacts import ArtifactStore
        from runtime.core.checkpoint import StateResolver
        from runtime.exec.artifact_io import ArtifactSink

        resolver = StateResolver({"VIBE_KERNEL_SKILL_DIR": ""})
        resolved = resolver.resolve(self.tmp)
        store = ArtifactStore(resolved.artifacts_dir)
        asink = ArtifactSink(store)

        data = b"line1\nline2\nline3\nline4\nline5\n"
        put = asink.put_stream(data.decode(), None, reproducible=False, regen_cmd=["test"])
        self.assertTrue(put.ok)
        self.assertIsNotNone(put.ref)

        # 分页读取
        page_result = asink.page(put.ref, offset=6, limit=10)
        self.assertIsNotNone(page_result)
        self.assertIn("line2", page_result)

    def test_e13b_put_failure(self) -> None:
        """E13b: artifact put 失败 → ref=None + artifact_error。"""
        from runtime.core.artifacts import ArtifactStore
        from runtime.core.checkpoint import StateResolver

        resolver = StateResolver({"VIBE_KERNEL_SKILL_DIR": ""})
        resolved = resolver.resolve(self.tmp)
        # 用一个文件路径作为 artifact dir（不是目录）→ put 失败
        bad_path = os.path.join(self.tmp, "not_a_dir")
        with open(bad_path, "w") as f:
            f.write("block")
        store = ArtifactStore(bad_path)
        r = run(
            _req(
                ["python3", "-c", "import sys; sys.stdout.write('x'*200000)"],
                self.tmp,
                timeout_ms=15000,
                max_output_bytes=100,
                max_spill_bytes=52_428_800,
                artifact_store=store,
            )
        )
        self.assertTrue(r.truncated)
        self.assertEqual(r.vc_code, "OUTPUT_LIMIT")
        # put 失败 → ref=None, artifact_error != None
        self.assertIsNone(r.stdout_ref)
        self.assertIsNotNone(r.artifact_error)


class TestSinkExceptionCleanup(unittest.TestCase):
    """TS-06: spill 临时文件在异常路径也被清理。"""

    def test_sink_close_deletes_spill(self) -> None:
        """Sink.close() 删除 spill 临时文件。"""
        sink = Sink(cap=50, max_spill=1000)
        sink.write(b"x" * 500)
        self.assertIsNotNone(sink.spill_path)
        self.assertTrue(os.path.exists(sink.spill_path))
        spill_path = sink.spill_path
        sink.close()
        self.assertFalse(os.path.exists(spill_path))

    def test_sink_del_fallback(self) -> None:
        """Sink.__del__ 作为 fd 清理回退。"""
        sink = Sink(cap=50, max_spill=1000)
        sink.write(b"x" * 500)
        spill_path = sink.spill_path
        del sink  # 触发 __del__
        self.assertFalse(os.path.exists(spill_path))


class TestNormalizers(unittest.TestCase):
    def test_pytest_parse(self) -> None:
        out = (
            "=== 3 passed, 1 failed, 2 skipped in 0.5s ===\n"
            "FAILED tests/test_a.py::test_x\n"
        )
        norm = normalize("pytest", out, "", 1, ["pytest"])
        self.assertIsNotNone(norm)
        self.assertEqual(norm.fail_count, 1)
        self.assertEqual(norm.pass_count, 3)

    def test_truncated_no_false_zero(self) -> None:
        norm = normalize("pytest", "no stats here", "", 1, ["pytest"], truncated=True)
        self.assertIsNone(norm)

    def test_infer_lang_python3_variants(self) -> None:
        """DL-04 修复：所有 python 变体 + -m pytest/vitest/mypy 被识别。"""
        self.assertEqual(infer_lang(["python3", "-m", "pytest"]), "pytest")
        self.assertEqual(infer_lang(["python", "-m", "pytest", "-x"]), "pytest")
        self.assertEqual(infer_lang(["py", "-m", "pytest"]), "pytest")
        self.assertEqual(infer_lang(["python3", "-m", "mypy", "."]), "mypy")
        self.assertEqual(infer_lang(["npm", "run", "vitest"]), "vitest")
        self.assertEqual(infer_lang(["npx", "jest"]), "jest")


class TestArgValidation(ExecTest):
    """参数校验：非法超时/输出上限必须是 INVALID_ARGUMENT，不得误报 TIMEOUT。"""

    def test_request_rejects_invalid_limits(self) -> None:
        with self.assertRaises(ValueError):
            _req(["python3", "-c", "print(1)"], self.tmp, timeout_ms=0)
        with self.assertRaises(ValueError):
            _req(["python3", "-c", "print(1)"], self.tmp, max_output_bytes=-1)

    def test_cli_rejects_negative_timeout(self) -> None:
        import io
        from contextlib import redirect_stdout

        from runtime.exec.cli import main as exec_main

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = exec_main(
                ["run", "--cwd", self.tmp, "--timeout-ms", "-5", "--", "python3", "-c", "print(1)"]
            )
        self.assertEqual(rc, 2, buf.getvalue())
        self.assertIn("INVALID_ARGUMENT", buf.getvalue())

    def test_cli_rejects_negative_max_output(self) -> None:
        import io
        from contextlib import redirect_stdout

        from runtime.exec.cli import main as exec_main

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = exec_main(
                ["run", "--cwd", self.tmp, "--max-output", "-1", "--", "python3", "-c", "print(1)"]
            )
        self.assertEqual(rc, 2, buf.getvalue())
        self.assertIn("INVALID_ARGUMENT", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
