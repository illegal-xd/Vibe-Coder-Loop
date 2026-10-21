"""Exec CLI：exec run / exec diff / exec baseline / exec kill。

Exit code 语义同 Core CLI：
- 0 成功
- 2 参数错误
- 4 运行时错误 / fail-closed 拒绝（SCOPE_DENIED）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from pathlib import Path
from typing import Any, Sequence

from runtime.core import vc_codes
from runtime.core.artifacts import ArtifactStore
from runtime.core.checkpoint import StateResolver

from .diff import summarize_diff
from .policy import parse_command_string, DEFAULT_ALLOWLIST
from .runner import ExecRequest, run


def _emit(data: Any, *, pretty: bool = False) -> None:
    if pretty:
        print(json.dumps(data, ensure_ascii=False, indent=2, default=str))
    else:
        print(json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str))


def _result_exit(result: Any) -> int:
    ok_value = getattr(result, "ok", None)
    code = str(getattr(result, "vc_code", "") or getattr(result, "code", "") or "")
    ok = bool(ok_value) if ok_value is not None else (not code)
    return 0 if ok and not vc_codes.is_fail_closed(code) else 4


def _build_artifact_store(args: argparse.Namespace) -> ArtifactStore | None:
    if not getattr(args, "externalize", False):
        return None
    cwd = os.path.abspath(args.cwd)
    resolver = StateResolver({"VIBE_KERNEL_SKILL_DIR": ""})
    resolved = resolver.resolve(cwd)
    return ArtifactStore(resolved.artifacts_dir)


def cmd_run(args: argparse.Namespace) -> int:
    # 解析命令
    if args.cmd_str:
        cmd = parse_command_string(args.cmd_str)
    else:
        cmd = list(args.cmd_argv)
    if not cmd:
        _emit({"ok": False, "code": "INVALID_ARGUMENT", "message": "命令为空（用 --cmd 或位置参数）"})
        return 2
    if args.timeout_ms <= 0:
        _emit({"ok": False, "code": "INVALID_ARGUMENT", "message": f"--timeout-ms 须为正整数（收到 {args.timeout_ms}）"})
        return 2
    if args.max_output < 0:
        _emit({"ok": False, "code": "INVALID_ARGUMENT", "message": f"--max-output 不能为负（收到 {args.max_output}）"})
        return 2
    cancel_event = threading.Event()
    req = ExecRequest(
        cmd=cmd,
        cwd=os.path.abspath(args.cwd),
        timeout_ms=args.timeout_ms,
        max_output_bytes=args.max_output,
        max_spill_bytes=args.max_spill,
        lang=args.lang,
        stage=args.stage,
        allow_high_risk=args.allow_high_risk,
        extra_allowlist=args.extra_allowlist,
        kill_grace_ms=args.kill_grace,
        artifact_store=_build_artifact_store(args),
    )
    result = run(req)
    _emit(result.to_dict(), pretty=args.pretty)
    return _result_exit(result)


def cmd_diff(args: argparse.Namespace) -> int:
    plan_files: list[str] | None = None
    if args.plan:
        plan_files = [p.strip() for p in args.plan.split(",") if p.strip()]
    summary = summarize_diff(
        os.path.abspath(args.cwd),
        plan_files=plan_files,
        base=args.base,
    )
    _emit(summary.to_dict(), pretty=args.pretty)
    drift = summary.plan_drift
    if drift and (drift.unplanned or drift.missing):
        return 4
    return 0


def cmd_baseline(args: argparse.Namespace) -> int:
    """显式建立/刷新非 git 基线快照。"""
    from .diff import _create_snapshot, _save_baseline
    cwd = os.path.abspath(args.cwd)
    snap = _create_snapshot(cwd)
    if snap is None:
        _emit({"ok": False, "code": "ENV_ERROR", "message": "扫描失败"})
        return 4
    if not _save_baseline(cwd, snap):
        _emit({"ok": False, "code": "CHECKPOINT_WRITE_FAILED", "message": "基线写入失败（只读/权限）"})
        return 4
    _emit({"ok": True, "baseline": f"snapshot:{snap['created_at']}", "files": len(snap["entries"])})
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="runtime.exec.cli",
        description="Vibe Kernel Execution & Verification",
    )
    sub = p.add_subparsers(dest="command", required=True)

    # run
    pr = sub.add_parser("run", help="执行命令并归一化结果")
    pr.add_argument("--cmd", dest="cmd_str", default=None, help="命令字符串（shlex 拆分）")
    pr.add_argument("cmd_argv", nargs="*", help="命令 argv（直接形式）")
    pr.add_argument("--cwd", default=os.getcwd(), help="项目根")
    pr.add_argument("--timeout-ms", type=int, default=300_000, dest="timeout_ms")
    pr.add_argument("--max-output", type=int, default=100_000, dest="max_output")
    pr.add_argument("--max-spill", type=int, default=52_428_800, dest="max_spill")
    pr.add_argument("--lang", default="auto")
    pr.add_argument("--stage", default="")
    pr.add_argument("--allow-high-risk", action="store_true", dest="allow_high_risk")
    pr.add_argument("--extra-allowlist", nargs="*", default=[], dest="extra_allowlist")
    pr.add_argument("--kill-grace", type=int, default=3000, dest="kill_grace")
    pr.add_argument("--externalize", action="store_true", help="超限时外置到 artifact")
    pr.add_argument("--pretty", action="store_true")
    pr.set_defaults(func=cmd_run)

    # diff
    pd = sub.add_parser("diff", help="汇总工作区改动")
    pd.add_argument("--cwd", default=os.getcwd())
    pd.add_argument("--plan", default=None, help="逗号分隔的计划文件集")
    pd.add_argument("--base", default=None, help="git 基线（缺省 HEAD）")
    pd.add_argument("--pretty", action="store_true")
    pd.set_defaults(func=cmd_diff)

    # baseline
    pb = sub.add_parser("baseline", help="建立/刷新非 git 基线快照")
    pb.add_argument("--cwd", default=os.getcwd())
    pb.set_defaults(func=cmd_baseline)

    return p


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
