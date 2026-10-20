"""Workflow Core CLI（单行 JSON + exit code 语义）。

Exit code：
- 0 成功
- 2 参数错误（argparse）
- 3 ``PROTOCOL_DRIFT``（CI 门禁）
- 4 运行时错误 / fail-closed 拒绝
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from . import vc_codes
from .checkpoint import (
    REQUIRED_FIELDS,
    STATE_SCHEMA_VERSION,
    CheckpointError,
    CheckpointLocationError,
    CheckpointStore,
    StateResolver,
)
from .core import ExecResult, WorkflowCore
from .protocol import check_protocol
from .state_parse import ParseQuality, SubsetParseError, parse_subset, scan_flat_scalars
from .state_machine import STATE_LABELS, ExitChecklist


def _emit(data: Any, *, pretty: bool = False) -> None:
    if pretty:
        print(json.dumps(data, ensure_ascii=True, indent=2))
    else:
        print(json.dumps(data, ensure_ascii=True, separators=(",", ":")))


def _error(code: str, fact: str, *, action: str | None = None) -> dict[str, Any]:
    return {"ok": False, **vc_codes.make_code(code, fact, action=action).to_dict()}


def _core(args: argparse.Namespace) -> WorkflowCore:
    return WorkflowCore(
        args.cwd,
        state_dir=getattr(args, "state_dir", None),
        state_path=getattr(args, "state_path", None),
        import_legacy=getattr(args, "import_legacy", False),
    )


def _result_exit(result: Any) -> int:
    ok_value = getattr(result, "ok", None)
    code = str(getattr(result, "code", "") or "")
    ok = bool(ok_value) if ok_value is not None else (not code)
    return 0 if ok and not vc_codes.is_fail_closed(code) else 4


def _read_json_arg(inline: str | None, file: str | None) -> Any:
    if file:
        import os
        import stat

        path = Path(file)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, flags)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("--result-file 必须是普通文件")
            if info.st_size > 4 * 1024 * 1024:
                raise ValueError("--result-file 超过 4 MiB")
            data = b""
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                data += chunk
        finally:
            os.close(fd)
        return json.loads(data.decode("utf-8"))
    if inline:
        return json.loads(inline)
    return None


def cmd_check_protocol(args: argparse.Namespace) -> int:
    report = check_protocol()
    _emit(report.to_dict(), pretty=args.pretty)
    return 0 if report.ok else 3


def cmd_state_check(args: argparse.Namespace) -> int:
    try:
        core = _core(args)
        text = core.store.read_text()
    except CheckpointError as exc:
        _emit(_error(exc.code, str(exc)), pretty=args.pretty)
        return 4
    if text is None:
        _emit(
            {
                "ok": True,
                "exists": False,
                "quality": "absent",
                "state_path": str(core.resolved.state_path),
            },
            pretty=args.pretty,
        )
        return 0
    try:
        raw = parse_subset(text)
        quality = ParseQuality.STRICT
    except SubsetParseError:
        raw = scan_flat_scalars(text)
        quality = ParseQuality.DEGRADED
    if raw is None:
        _emit(
            _error(vc_codes.CHECKPOINT_CORRUPT, f"状态文件不可解析: {core.resolved.state_path}"),
            pretty=args.pretty,
        )
        return 4
    missing = [name for name in REQUIRED_FIELDS if name not in raw]
    if "updated_at" not in raw:
        missing.append("updated_at")
    schema = raw.get("_schema", STATE_SCHEMA_VERSION)
    issues: list[str] = []
    if isinstance(schema, bool) or not isinstance(schema, int):
        schema_int = STATE_SCHEMA_VERSION
        issues.append("_schema 必须是整数")
    else:
        schema_int = schema
    if schema_int < 1:
        issues.append(f"_schema 必须 ≥1: {schema_int}")
    schema_ahead = schema_int > STATE_SCHEMA_VERSION
    owner = raw.get("_project_id")
    if owner and str(owner) != core.resolved.project_id:
        issues.append(f"_project_id 与当前项目不匹配: {owner!r}")

    phase = raw.get("phase")
    from .checkpoint import state_code

    if state_code(phase) not in STATE_LABELS:
        issues.append(f"phase 非法: {phase!r}（必须是 S0–S14 + Label）")
    status = raw.get("status")
    if status not in ("active", "paused", "complete"):
        issues.append(f"status 非法: {status!r}")
    for name, low, high in (("loop", 0, None), ("level", 0, 4)):
        value = raw.get(name)
        if isinstance(value, bool) or not isinstance(value, int):
            issues.append(f"{name} 必须是整数")
            continue
        if value < low or (high is not None and value > high):
            issues.append(f"{name} 越界: {value}")
    if "_rev" in raw:
        rev = raw.get("_rev")
        if isinstance(rev, bool) or not isinstance(rev, int) or rev < 0:
            issues.append("_rev 必须是非负整数")
    for name in ("completed", "pending", "decisions", "user_decisions"):
        if name in raw and not isinstance(raw.get(name), list):
            issues.append(f"{name} 必须是数组")
    for name in ("goal", "review"):
        if name in raw and not isinstance(raw.get(name), dict):
            issues.append(f"{name} 必须是映射")
    if "updated_at" in raw:
        from .recovery import age_minutes

        if age_minutes(raw.get("updated_at")) is None:
            issues.append(f"updated_at 不可解析: {raw.get('updated_at')!r}")

    ok = quality is ParseQuality.STRICT and not missing and not schema_ahead and not issues
    data: dict[str, Any] = {
        "ok": ok,
        "exists": True,
        "quality": quality.value,
        "schema": schema_int,
        "missing": missing,
        "issues": issues,
        "state_path": str(core.resolved.state_path),
    }
    if schema_ahead:
        data.update(
            vc_codes.make_code(
                vc_codes.CHECKPOINT_SCHEMA_AHEAD,
                f"_schema={schema_int} 高于支持版本 {STATE_SCHEMA_VERSION}",
            ).to_dict()
        )
    elif missing or issues:
        data.update(
            vc_codes.make_code(
                vc_codes.CHECKPOINT_DEGRADED,
                "状态校验失败: " + ", ".join(missing + issues),
            ).to_dict()
        )
    _emit(data, pretty=args.pretty)
    return 0 if ok else 4


def cmd_state_gc(args: argparse.Namespace) -> int:
    try:
        core = _core(args)
        with core.store.lock():
            return _gc_locked(core, args)
    except (CheckpointError, OSError) as exc:
        code = getattr(exc, "code", vc_codes.CHECKPOINT_WRITE_FAILED)
        _emit(_error(code, str(exc)), pretty=args.pretty)
        return 4


def _gc_locked(core: WorkflowCore, args: argparse.Namespace) -> int:
    try:
        snapshot = core.store.snapshot()
    except CheckpointError as exc:
        _emit(_error(exc.code, str(exc)), pretty=args.pretty)
        return 4
    if not snapshot.exists:
        _emit(
            _error(vc_codes.CHECKPOINT_LOCATION_UNRESOLVED, "没有状态文件，拒绝 GC（无法确定引用集合）"),
            pretty=args.pretty,
        )
        return 4
    if snapshot.missing_required:
        _emit(
            _error(
                vc_codes.CHECKPOINT_DEGRADED,
                "缺必需字段: " + ", ".join(snapshot.missing_required),
            ),
            pretty=args.pretty,
        )
        return 4
    if not snapshot.phase_valid:
        _emit(
            _error(vc_codes.CHECKPOINT_DEGRADED, "phase 非法，拒绝 GC"),
            pretty=args.pretty,
        )
        return 4
    if not core.resolved.allow_move and not getattr(args, "allow_external", False):
        _emit(
            _error(
                vc_codes.INVALID_ARGUMENT,
                "状态目录在项目 .vibe-kernel 之外，GC 需显式 --allow-external",
            ),
            pretty=args.pretty,
        )
        return 4
    if snapshot.quality is not ParseQuality.STRICT:
        _emit(
            _error(vc_codes.CHECKPOINT_DEGRADED, "状态文件降级可读，引用集合不可信，拒绝 GC"),
            pretty=args.pretty,
        )
        return 4
    if snapshot.schema_invalid:
        _emit(
            _error(vc_codes.CHECKPOINT_CORRUPT, "_schema 非法，拒绝 GC"),
            pretty=args.pretty,
        )
        return 4
    if snapshot.schema_ahead:
        _emit(
            _error(vc_codes.CHECKPOINT_SCHEMA_AHEAD, "_schema 超前，拒绝 GC"),
            pretty=args.pretty,
        )
        return 4
    if snapshot.owner and snapshot.owner != core.resolved.project_id:
        _emit(
            _error(vc_codes.CHECKPOINT_FOREIGN, "_project_id 不匹配，拒绝 GC"),
            pretty=args.pretty,
        )
        return 4
    if str(snapshot.fields.get("status", "")) not in ("active", "paused", "complete"):
        _emit(
            _error(vc_codes.CHECKPOINT_DEGRADED, f"status 非法: {snapshot.fields.get('status')!r}，拒绝 GC"),
            pretty=args.pretty,
        )
        return 4
    result = core.artifacts.gc(
        snapshot.fields,
        retention_days=args.retention_days,
        dry_run=args.dry_run,
    )
    _emit(result.to_dict(), pretty=args.pretty)
    return 0 if result.ok else 4


def cmd_get_state(args: argparse.Namespace) -> int:
    try:
        core = _core(args)
    except CheckpointError as exc:
        _emit(_error(exc.code, str(exc)), pretty=args.pretty)
        return 4
    view = core.get_state()
    _emit(view.to_dict(), pretty=args.pretty)
    return 0 if not view.code else 4


def cmd_load(args: argparse.Namespace) -> int:
    try:
        core = _core(args)
    except CheckpointError as exc:
        _emit(_error(exc.code, str(exc)), pretty=args.pretty)
        return 4
    result = core.load_checkpoint(
        expected_age_minutes=args.expected_age_minutes,
        verify_pending=not args.no_verify_pending,
    )
    _emit(result.to_dict(), pretty=args.pretty)
    if result.mode in ("fresh_start", "foreign_start", "reference_only") and result.code:
        return 4
    return 0


def cmd_transition(args: argparse.Namespace) -> int:
    try:
        core = _core(args)
    except CheckpointError as exc:
        _emit(_error(exc.code, str(exc)), pretty=args.pretty)
        return 4
    checklist = None
    try:
        raw_checklist = _read_json_arg(args.checklist, args.checklist_file)
        if raw_checklist is not None:
            if not isinstance(raw_checklist, dict):
                raise ValueError("exit_checklist 必须是 JSON 对象")
            checklist = ExitChecklist.from_dict(raw_checklist)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        _emit(_error(vc_codes.INVALID_ARGUMENT, f"exit_checklist 解析失败: {exc}"), pretty=args.pretty)
        return 4
    result = core.transition(
        args.to,
        loop=args.loop,
        exit_checklist=checklist,
        expected_rev=args.rev,
        force=args.force,
        reason=args.reason,
        current_step=args.current_step,
        level=args.level,
        plan_files=(
            None
            if args.plan_files is None
            else [item for item in args.plan_files.split(",") if item]
        ),
        vc_violation=args.vc_violation,
    )
    _emit(result.to_dict(), pretty=args.pretty)
    return _result_exit(result)


def cmd_snapshot(args: argparse.Namespace) -> int:
    try:
        core = _core(args)
    except CheckpointError as exc:
        _emit(_error(exc.code, str(exc)), pretty=args.pretty)
        return 4
    text = core.snapshot_task_zone(detail=args.detail)
    print(text)
    return 4 if text.startswith("[runtime]") else 0


def cmd_feed_exec(args: argparse.Namespace) -> int:
    try:
        core = _core(args)
    except CheckpointError as exc:
        _emit(_error(exc.code, str(exc)), pretty=args.pretty)
        return 4
    try:
        payload = _read_json_arg(args.result, args.result_file)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        _emit(_error(vc_codes.INVALID_ARGUMENT, f"ExecResult 解析失败: {exc}"), pretty=args.pretty)
        return 4
    if not isinstance(payload, dict):
        _emit(_error(vc_codes.INVALID_ARGUMENT, "ExecResult 必须是 JSON 对象"), pretty=args.pretty)
        return 4
    try:
        exec_result = ExecResult.from_dict(payload)
    except ValueError as exc:
        _emit(_error(vc_codes.INVALID_ARGUMENT, f"ExecResult 非法: {exc}"), pretty=args.pretty)
        return 4
    result = core.feed_exec(exec_result)
    _emit(result.to_dict(), pretty=args.pretty)
    return _result_exit(result)


def cmd_repeat_check(args: argparse.Namespace) -> int:
    try:
        core = _core(args)
    except CheckpointError as exc:
        _emit(_error(exc.code, str(exc)), pretty=args.pretty)
        return 4
    result = core.repeat_check(args.fingerprint)
    _emit(result.to_dict(), pretty=args.pretty)
    return _result_exit(result)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="core", description="Vibe Kernel Workflow Core CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p: argparse.ArgumentParser, *, cwd_required: bool = True) -> None:
        p.add_argument("--cwd", required=cwd_required, help="项目工作目录（必填）")
        p.add_argument("--state-dir", default=None, help="显式状态目录")
        p.add_argument("--state-path", default=None, help="显式状态文件路径")
        p.add_argument("--pretty", action="store_true", help="缩进输出（默认单行 JSON）")

    p = sub.add_parser("check-protocol", help="校验代码表与 Skill 事实源一致")
    p.add_argument("--pretty", action="store_true")
    p.set_defaults(func=cmd_check_protocol)

    p = sub.add_parser("state", help="状态文件操作")
    state_sub = p.add_subparsers(dest="state_command", required=True)
    check = state_sub.add_parser("check", help="校验状态文件语法 + schema")
    add_common(check)
    check.set_defaults(func=cmd_state_check)
    gc = state_sub.add_parser("gc", help="清理未被引用的 pinned artifact")
    add_common(gc)
    gc.add_argument("--retention-days", type=int, default=7)
    gc.add_argument("--dry-run", action="store_true")
    gc.add_argument("--allow-external", action="store_true")
    gc.set_defaults(func=cmd_state_gc)

    p = sub.add_parser("get-state", help="只读状态快照")
    add_common(p)
    p.set_defaults(func=cmd_get_state)

    p = sub.add_parser("load-checkpoint", help="恢复协议机械执行")
    add_common(p)
    p.add_argument("--expected-age-minutes", type=int, default=1440)
    p.add_argument("--no-verify-pending", action="store_true")
    p.add_argument("--import-legacy", dest="import_legacy", action="store_true")
    p.set_defaults(import_legacy=False, func=cmd_load)

    p = sub.add_parser("transition", help="状态转换（唯一 mutation 入口）")
    add_common(p)
    p.add_argument("--to", required=True)
    p.add_argument("--loop", type=int, default=None)
    p.add_argument("--rev", type=int, default=None)
    p.add_argument("--force", action="store_true")
    p.add_argument("--reason", default="")
    p.add_argument("--level", type=int, default=None)
    p.add_argument("--current-step", default=None)
    p.add_argument("--checklist", default=None, help="ExitChecklist JSON 字符串")
    p.add_argument("--checklist-file", default=None, help="ExitChecklist JSON 文件")
    p.add_argument("--plan-files", default=None, help="逗号分隔的计划文件集合")
    p.add_argument("--vc-violation", default="")
    p.set_defaults(import_legacy=False, func=cmd_transition)

    p = sub.add_parser("snapshot-task-zone", help="TASK 区快照")
    add_common(p)
    p.add_argument("--detail", choices=("full", "pointer"), default="full")
    p.set_defaults(func=cmd_snapshot)

    p = sub.add_parser("feed-exec", help="喂执行结果（失败指纹/计划漂移）")
    add_common(p)
    p.add_argument("--result", default=None, help="ExecResult JSON 字符串")
    p.add_argument("--result-file", default=None)
    p.set_defaults(func=cmd_feed_exec)

    p = sub.add_parser("repeat-check", help="重复失败检测（同指纹连续调用会计数）")
    add_common(p)
    p.add_argument("--fingerprint", required=True)
    p.set_defaults(func=cmd_repeat_check)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except CheckpointLocationError as exc:
        _emit(_error(exc.code, str(exc)), pretty=getattr(args, "pretty", False))
        return 4
    except CheckpointError as exc:
        _emit(_error(exc.code, str(exc)), pretty=getattr(args, "pretty", False))
        return 4
    except (OSError, ValueError, TypeError, RecursionError, UnicodeError, RuntimeError) as exc:
        _emit(
            _error(vc_codes.INVALID_ARGUMENT, f"输入非法: {exc}"),
            pretty=getattr(args, "pretty", False),
        )
        return 4


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
