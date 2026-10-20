"""跨平台整进程树终止。

事实源：MVP-2 §3.2.1

subprocess.run(timeout=…) 只杀直接子进程，孙进程会存活。
本模块建独立进程组（start_new_session），终止时 killpg 杀整树，
宽限 SIGTERM → SIGKILL，残留则标记 tree_leaked（不谎报已终止）。
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass


@dataclass
class KillResult:
    ok: bool
    tree_leaked: bool = False
    method: str = ""


def kill_process_tree(
    proc: subprocess.Popen,
    *,
    grace_ms: int = 3000,
    wait_after_kill_ms: int = 5000,
) -> KillResult:
    """终止整个进程树。返回是否成功 + 是否有残留。

    - POSIX：``start_new_session=True`` 时用 ``killpg(SIGTERM)`` → 宽限 → ``SIGKILL``。
    - Windows：``CREATE_NEW_PROCESS_GROUP`` + ``taskkill /T /F``，失败用 ``TerminateProcess``。
    """
    pid = proc.pid
    if pid <= 0:
        return KillResult(ok=True, method="noop")

    if sys.platform == "win32":
        return _kill_windows(proc, pid, grace_ms=grace_ms, wait_after_kill_ms=wait_after_kill_ms)
    return _kill_posix(proc, pid, grace_ms=grace_ms, wait_after_kill_ms=wait_after_kill_ms)


def _kill_posix(proc: subprocess.Popen, pid: int, *, grace_ms: int, wait_after_kill_ms: int) -> KillResult:
    try:
        pgid = os.getpgid(pid)
    except (ProcessLookupError, OSError):
        pgid = pid
    tree_leaked = False
    # 1. SIGTERM 整组
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    # 宽限
    deadline = time.monotonic() + grace_ms / 1000
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return KillResult(ok=True, method="sigterm_killpg")
        time.sleep(0.05)
    # 2. SIGKILL 整组
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    except OSError:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    # 等待回收
    wait_deadline = time.monotonic() + wait_after_kill_ms / 1000
    while time.monotonic() < wait_deadline:
        if proc.poll() is not None:
            return KillResult(ok=True, method="sigkill_killpg")
        time.sleep(0.05)
    # 仍存活 → tree_leaked（不谎报）
    if proc.poll() is None:
        tree_leaked = True
    return KillResult(ok=not tree_leaked, tree_leaked=tree_leaked, method="sigkill_killpg_leaked")


def _kill_windows(proc: subprocess.Popen, pid: int, *, grace_ms: int, wait_after_kill_ms: int) -> KillResult:
    # CREATE_NEW_PROCESS_GROUP 的进程不能用 CTRL_BREAK_EVENT 跨组；用 taskkill /T /F
    try:
        ret = subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(pid)],
            capture_output=True,
            timeout=max(5, wait_after_kill_ms / 1000),
        )
        if ret.returncode == 0 and proc.poll() is not None:
            return KillResult(ok=True, method="taskkill")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    # 兜底：TerminateProcess
    try:
        import _winapi  # type: ignore[import-not-found]

        _winapi.TerminateProcess(int(proc._handle), 1)  # type: ignore[attr-defined]
    except (ImportError, OSError):
        pass
    wait_deadline = time.monotonic() + wait_after_kill_ms / 1000
    while time.monotonic() < wait_deadline:
        if proc.poll() is not None:
            return KillResult(ok=True, method="terminate_process")
        time.sleep(0.05)
    return KillResult(ok=False, tree_leaked=True, method="terminate_leaked")
