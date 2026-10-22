"""WorkflowCore：host-agnostic 6 方法门面。

契约（docs/design/mvp-1-workflow-core.md §八）：
1. load_checkpoint()  → RecoveryResult
2. transition()       → TransitionResult
3. snapshot_task_zone()
4. feed_exec()        → FeedResult
5. repeat_check()     → RepeatResult
6. get_state()        → StateView
全部纯数据入参/出参；mutation 只经 transition（feed_exec 仅写 review.failure_state）。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal, Mapping

from . import vc_codes
from .artifacts import ArtifactStore
from .checkpoint import (
    CheckpointError,
    CheckpointStore,
    Snapshot,
    StateResolver,
    now_to_minute,
    parse_minute,
    state_code,
)
from .recovery import RecoveryResult, load_checkpoint as _load_checkpoint, verify_pending as _verify_pending
from .state_machine import (
    ExitChecklist,
    TransitionResult,
    transition as _transition,
)


@dataclass(frozen=True)
class ExecResult:
    exec_id: str = ""
    ok: bool = True
    exit_code: int = 0
    fingerprint: str = ""
    files_modified: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    plan_files: list[str] | None = None
    vc_violation: str = ""
    started_at: str = ""
    finished_at: str = ""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ExecResult":
        raw_ok = data.get("ok", data.get("exit", 0) == 0)
        if isinstance(raw_ok, bool):
            ok = raw_ok
        elif isinstance(raw_ok, int) and raw_ok in (0, 1):
            ok = bool(raw_ok)
        else:
            raise ValueError("ok 必须是 JSON true/false 或 0/1")
        raw_exit = data.get("exit_code", data.get("exit", 0))
        if isinstance(raw_exit, bool) or not isinstance(raw_exit, int):
            raise ValueError("exit_code 必须是整数")
        def _str_list(name: str) -> list[str]:
            raw = data.get(name, []) or []
            if not isinstance(raw, list):
                raise ValueError(f"{name} 必须是字符串数组")
            if not all(isinstance(item, str) for item in raw):
                raise ValueError(f"{name} 必须是字符串数组")
            return list(raw)

        return cls(
            exec_id=str(data.get("exec_id", "") or ""),
            ok=ok,
            exit_code=raw_exit,
            fingerprint=str(data.get("fingerprint", "") or ""),
            files_modified=_str_list("files_modified"),
            errors=_str_list("errors"),
            plan_files=(
                None
                if data.get("plan_files") is None
                else _str_list("plan_files")
            ),
            vc_violation=str(data.get("vc_violation", "") or ""),
            started_at=str(data.get("started_at", "") or ""),
            finished_at=str(data.get("finished_at", "") or ""),
        )


@dataclass(frozen=True)
class FeedResult:
    ok: bool
    rev: int = 0
    consecutive_count: int = 0
    no_progress: bool = False
    plan_drift: bool = False
    escalated: bool = False
    phase: str = ""
    code: str = ""
    message: str = ""
    next: str = ""
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "ok": self.ok,
            "rev": self.rev,
            "consecutive_count": self.consecutive_count,
            "no_progress": self.no_progress,
            "plan_drift": self.plan_drift,
            "escalated": self.escalated,
            "phase": self.phase,
        }
        if self.code:
            data.update(vc_codes.make_code(self.code, self.message, action=self.next).to_dict())
        if self.warnings:
            data["warnings"] = list(self.warnings)
        return data


@dataclass(frozen=True)
class RepeatResult:
    fingerprint: str
    consecutive_count: int
    no_progress: bool
    rev: int = 0
    code: str = ""
    message: str = ""
    next: str = ""

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "fingerprint": self.fingerprint,
            "consecutive_count": self.consecutive_count,
            "no_progress": self.no_progress,
            "rev": self.rev,
        }
        if self.code:
            data.update(vc_codes.make_code(self.code, self.message, action=self.next).to_dict())
        return data


@dataclass(frozen=True)
class StateView:
    mode: str
    status: str = ""
    phase: str = ""
    loop: int = 0
    level: int = 0
    current_step: str = ""
    rev: int = 0
    updated_at: str = ""
    completed_count: int = 0
    pending_count: int = 0
    code: str = ""
    next: str = ""
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "mode": self.mode,
            "status": self.status,
            "phase": self.phase,
            "loop": self.loop,
            "level": self.level,
            "current_step": _safe_text(self.current_step),
            "rev": self.rev,
            "updated_at": _safe_text(self.updated_at),
            "completed_count": self.completed_count,
            "pending_count": self.pending_count,
            "source": self.source,
            "next": self.next,
        }
        if self.code:
            data.update(vc_codes.make_code(self.code, self.mode, action=self.next or None).to_dict())
        return data


class WorkflowCore:
    def __init__(
        self,
        cwd: str | os.PathLike[str],
        *,
        memory_key: str | None = None,
        memory_db: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        import_legacy: bool = False,
        loop_max_override: int | None = None,
        ephemeral_index: Iterable[str] | None = None,
        skill_dir: str | os.PathLike[str] | None = None,
    ) -> None:
        env_map = dict(os.environ if env is None else env)
        if skill_dir is not None:
            env_map["VIBE_KERNEL_SKILL_DIR"] = str(skill_dir)
        self.resolver = StateResolver(env_map)
        self.resolved = self.resolver.resolve(cwd, memory_key=memory_key, memory_db=memory_db)
        self.store = CheckpointStore(self.resolved, import_legacy=import_legacy, env=env_map)
        self.artifacts = ArtifactStore(self.resolved.artifacts_dir, ephemeral_index=ephemeral_index)
        self.ephemeral_index = ephemeral_index
        self.loop_max_override = loop_max_override

    # 1 ------------------------------------------------------------------
    def load_checkpoint(
        self,
        *,
        expected_age_minutes: int = 1440,
        verify_pending: bool = True,
        plan_text: str | None = None,
        exec_results: Mapping[str, bool] | None = None,
    ) -> RecoveryResult:
        return _load_checkpoint(
            self.store,
            expected_age_minutes=expected_age_minutes,
            verify_pending_items=verify_pending,
            plan_text=plan_text,
            exec_results=exec_results,
            ephemeral_index=self.ephemeral_index,
        )

    # 2 ------------------------------------------------------------------
    def transition(
        self,
        to_state: str,
        *,
        loop: int | None = None,
        exit_checklist: ExitChecklist | Mapping[str, Any] | None = None,
        expected_rev: int | None = None,
        force: bool = False,
        reason: str = "",
        current_step: str | None = None,
        level: int | None = None,
        plan_files: list[str] | None = None,
        vc_violation: str = "",
    ) -> TransitionResult:
        return _transition(
            self.store,
            to_state,
            loop=loop,
            exit_checklist=exit_checklist,  # type: ignore[arg-type]
            expected_rev=expected_rev,
            force=force,
            reason=reason,
            current_step=current_step,
            level=level,
            plan_files=plan_files,
            vc_violation=vc_violation,
            loop_max_override=self.loop_max_override,
        )

    # 3 ------------------------------------------------------------------
    def snapshot_task_zone(self, *, detail: Literal["full", "pointer"] = "full") -> str:
        if detail not in ("full", "pointer"):
            raise ValueError("detail 必须是 'full' 或 'pointer'")
        view = self.get_state()
        if view.code or view.mode == "reference_only":
            reason = view.next or "状态仅可参考"
            code = view.code or vc_codes.CHECKPOINT_DEGRADED
            return f"[runtime] [{code}] 状态不可作为 TASK 区注入: {reason}\n[next] {reason}"
        try:
            snapshot = self.store.snapshot()
        except CheckpointError as exc:
            return f"[runtime] {exc.code} {exc}\n[next] {vc_codes.next_action(getattr(exc, 'code', ''))}"
        fields = snapshot.fields
        phase = _safe_text(fields.get("phase", "S0 Idle"))
        loop = int(fields.get("loop", 0) or 0)
        rev = snapshot.rev
        if detail == "pointer":
            return (
                f"phase={phase} | loop={loop} | rev={rev} | "
                f"next={_safe_text(fields.get('current_step', ''))} | "
                f"source={_safe_text(self.resolved.memory_key)}"
            )
        code = state_code(phase) or "S0"
        lines = [
            f"[Phase: {phase}] [Loop: {loop}] status={_safe_text(fields.get('status', ''))} "
            f"level={fields.get('level', 0)} rev={rev} updated_at={_safe_text(fields.get('updated_at', ''))}",
            f"goal: {_compact(fields.get('goal'))}",
            f"current_step: {_safe_text(fields.get('current_step', ''))}",
            f"completed: {_compact(fields.get('completed'))}",
            f"pending: {_compact(fields.get('pending'))}",
            f"decisions: {_compact(fields.get('decisions'))}",
            f"review: {_compact(fields.get('review'))}",
            f"user_decisions: {_compact(fields.get('user_decisions'))}",
            f"resume: {_compact(fields.get('resume'))}",
            f"state: {_safe_text(self.resolved.memory_key)}",
        ]
        return "\n".join(lines)

    # 4 ------------------------------------------------------------------
    def feed_exec(self, result: ExecResult | Mapping[str, Any]) -> FeedResult:
        if isinstance(result, Mapping):
            result = ExecResult.from_dict(result)
        if len(result.exec_id) > 256:
            return FeedResult(
                ok=False,
                code=vc_codes.INVALID_ARGUMENT,
                message="exec_id 超过 256 字符上限",
                next=vc_codes.next_action(vc_codes.INVALID_ARGUMENT),
            )
        if not result.exec_id:
            return FeedResult(
                ok=False,
                code=vc_codes.INVALID_ARGUMENT,
                message="ExecResult.exec_id 必填（幂等去重依赖它）",
                next=vc_codes.next_action(vc_codes.INVALID_ARGUMENT),
            )
        try:
            snapshot = self.store.snapshot()
        except CheckpointError as exc:
            return FeedResult(ok=False, code=exc.code, message=str(exc), next=vc_codes.next_action(exc.code))

        if snapshot.schema_invalid:
            return FeedResult(
                ok=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_CORRUPT,
                message="_schema 不是整数（只读不写）",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_CORRUPT),
            )
        if snapshot.schema_ahead:
            return FeedResult(
                ok=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_SCHEMA_AHEAD,
                message=f"_schema={snapshot.schema} 高于支持版本（只读不写）",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_SCHEMA_AHEAD),
            )
        if snapshot.owner and snapshot.owner != self.resolved.project_id:
            return FeedResult(
                ok=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_FOREIGN,
                message="_project_id 与当前项目不符",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_FOREIGN),
            )
        if snapshot.exists and str(snapshot.fields.get("status", "")) == "complete":
            return FeedResult(
                ok=False,
                rev=snapshot.rev,
                code=vc_codes.STATE_ILLEGAL_TRANSITION,
                message="任务已结束（status=complete），拒绝喂执行结果",
                next="新任务请先归档旧状态并从 S1 开始",
            )
        if snapshot.exists and not snapshot.numeric_valid:
            return FeedResult(
                ok=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_DEGRADED,
                message=f"loop/level 越界: loop={snapshot.fields.get('loop')!r} level={snapshot.fields.get('level')!r}",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
            )
        if snapshot.exists and not snapshot.phase_valid:
            return FeedResult(
                ok=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_DEGRADED,
                message=f"phase 非法: {snapshot.fields.get('phase')!r}，拒绝喂执行结果",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
            )
        if snapshot.exists and snapshot.quality.value == "degraded":
            return FeedResult(
                ok=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_DEGRADED,
                message="状态文件仅降级可读，先重建完整状态再喂执行结果",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
            )

        review = snapshot.fields.get("review")
        review_dict: dict[str, Any] = dict(review) if isinstance(review, dict) else {}
        failure = review_dict.get("failure_state")
        failure_dict: dict[str, Any] = dict(failure) if isinstance(failure, dict) else {}

        # 幂等：最近 20 个 exec_id 均去重（防乱序重放重复计数）
        recent = failure_dict.get("recent_exec_ids", [])
        recent = [str(x) for x in recent] if isinstance(recent, list) else []
        if result.exec_id and (
            failure_dict.get("last_exec_id") == result.exec_id or result.exec_id in recent
        ):
            count = _safe_int(failure_dict.get("consecutive_count"), 0)
            current_phase = str(snapshot.fields.get("phase", ""))
            return FeedResult(
                ok=True,
                rev=snapshot.rev,
                consecutive_count=count,
                no_progress=count >= 2,
                plan_drift=bool(failure_dict.get("last_plan_drift", False)),
                escalated=state_code(current_phase) == "S14",
                phase=current_phase,
            )

        if result.vc_violation:
            esc = self.transition(
                "S14",
                force=True,
                reason=result.vc_violation,
                expected_rev=snapshot.rev,
            )
            return FeedResult(
                ok=esc.ok,
                rev=esc.rev,
                plan_drift=False,
                escalated=esc.ok,
                phase=esc.phase,
                code=vc_codes.SCOPE_DENIED,
                message=f"硬约束违规已上报: {result.vc_violation}",
                next=vc_codes.next_action(vc_codes.SCOPE_DENIED),
            )

        # 计划漂移（S7 声明集合 → 实际修改集合）
        planned = result.plan_files
        if planned is None and isinstance(review_dict.get("plan_files"), list):
            planned = [str(x) for x in review_dict["plan_files"]]
        plan_drift = False
        if planned is not None:
            allowed = {str(item) for item in planned}
            actual = {str(item) for item in result.files_modified}
            plan_drift = bool(actual - allowed) if allowed or actual else False

        # 连续失败计数（持久化）
        count = _safe_int(failure_dict.get("consecutive_count"), 0)
        last_fp = str(failure_dict.get("last_fingerprint", "") or "")
        raw_history = failure_dict.get("history", [])
        history = [str(x) for x in raw_history] if isinstance(raw_history, list) else []
        if result.ok:
            count = 0
            last_fp = ""
            failure_dict["last_ok_at"] = now_to_minute()
        else:
            fingerprint = _bounded_fingerprint(result.fingerprint)
            if not fingerprint and result.errors:
                fingerprint = "fp:" + hashlib.sha256(
                    json.dumps(result.errors, ensure_ascii=False, sort_keys=True).encode("utf-8")
                ).hexdigest()[:16]
            if fingerprint:
                if fingerprint == last_fp:
                    count += 1
                else:
                    count = 1
                    last_fp = fingerprint
                    history.append(fingerprint)
                    history = history[-10:]
            else:
                # 缺失指纹：按设计「计数缺失 → 按 1 处理，不误触发」
                count = 1
                last_fp = ""
        failure_dict.update(
            {
                "last_fingerprint": last_fp,
                "consecutive_count": count,
                "history": history,
                "last_exec_id": result.exec_id or "",
                "last_plan_drift": plan_drift,
                "recent_exec_ids": (
                    [*recent, result.exec_id] if result.exec_id else recent
                )[-20:],
            }
        )
        if not failure_dict.get("round_started_at"):
            failure_dict["round_started_at"] = now_to_minute()

        review_dict["failure_state"] = failure_dict
        review_dict["result"] = "ok" if result.ok else "failed"
        if not result.ok and result.errors:
            review_dict["last_failure"] = "; ".join(result.errors)[:500]

        write = self.store.write({"review": review_dict}, expected_rev=snapshot.rev)
        if not write.ok:
            return FeedResult(
                ok=False,
                rev=write.rev,
                code=write.code,
                message=write.message,
                next=write.next,
            )

        codes = [vc_codes.PLAN_DRIFT] if plan_drift else []
        if count >= 2:
            codes.append(vc_codes.NO_PROGRESS)
        code = vc_codes.NO_PROGRESS if count >= 2 else (vc_codes.PLAN_DRIFT if plan_drift else "")
        message = ""
        nxt = ""
        escalated = False
        phase = str(snapshot.fields.get("phase", ""))
        if code == vc_codes.NO_PROGRESS:
            message = f"连续 {count} 次相同失败指纹"
            nxt = vc_codes.next_action(code)
            current_code = state_code(phase)
            if current_code != "S14":
                esc = self.transition(
                    "S14",
                    force=True,
                    reason="consecutive_same_failures",
                    expected_rev=write.rev,
                )
                escalated = esc.ok
                if esc.ok:
                    phase = esc.phase
                    write = type(write)(ok=True, rev=esc.rev, changed=True, warnings=write.warnings)
        elif code == vc_codes.PLAN_DRIFT:
            message = f"实际修改文件超出计划集合: {sorted(set(result.files_modified) - set(planned or []))}"
            nxt = vc_codes.next_action(code)
        return FeedResult(
            ok=True,
            rev=write.rev,
            consecutive_count=count,
            no_progress=count >= 2,
            plan_drift=plan_drift,
            escalated=escalated,
            phase=phase,
            code=code,
            message=message,
            next=nxt,
            warnings=write.warnings,
        )

    # 5 ------------------------------------------------------------------
    def repeat_check(self, fingerprint: str) -> RepeatResult:
        fingerprint = _bounded_fingerprint(fingerprint)
        if not fingerprint:
            return RepeatResult(
                fingerprint="",
                consecutive_count=0,
                no_progress=False,
                code=vc_codes.INVALID_ARGUMENT,
                message="fingerprint 不能为空",
                next=vc_codes.next_action(vc_codes.INVALID_ARGUMENT),
            )
        try:
            snapshot = self.store.snapshot()
        except CheckpointError as exc:
            return RepeatResult(
                fingerprint=fingerprint,
                consecutive_count=0,
                no_progress=False,
                code=exc.code,
                message=str(exc),
                next=vc_codes.next_action(exc.code),
            )
        if snapshot.schema_invalid:
            return RepeatResult(
                fingerprint=fingerprint,
                consecutive_count=0,
                no_progress=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_CORRUPT,
                message="_schema 不是整数（只读不写）",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_CORRUPT),
            )
        if snapshot.schema_ahead:
            return RepeatResult(
                fingerprint=fingerprint,
                consecutive_count=0,
                no_progress=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_SCHEMA_AHEAD,
                message=f"_schema={snapshot.schema} 高于支持版本（只读不写）",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_SCHEMA_AHEAD),
            )
        if snapshot.owner and snapshot.owner != self.resolved.project_id:
            return RepeatResult(
                fingerprint=fingerprint,
                consecutive_count=0,
                no_progress=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_FOREIGN,
                message="_project_id 与当前项目不符",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_FOREIGN),
            )
        if snapshot.exists and str(snapshot.fields.get("status", "")) == "complete":
            return RepeatResult(
                fingerprint=fingerprint,
                consecutive_count=0,
                no_progress=False,
                rev=snapshot.rev,
                code=vc_codes.STATE_ILLEGAL_TRANSITION,
                message="任务已结束（status=complete），拒绝重复检测",
                next="新任务请先归档旧状态并从 S1 开始",
            )
        if snapshot.exists and not snapshot.numeric_valid:
            return RepeatResult(
                fingerprint=fingerprint,
                consecutive_count=0,
                no_progress=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_DEGRADED,
                message=f"loop/level 越界: loop={snapshot.fields.get('loop')!r} level={snapshot.fields.get('level')!r}",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
            )
        if snapshot.exists and not snapshot.phase_valid:
            return RepeatResult(
                fingerprint=fingerprint,
                consecutive_count=0,
                no_progress=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_DEGRADED,
                message=f"phase 非法: {snapshot.fields.get('phase')!r}，拒绝检测",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
            )
        if snapshot.exists and snapshot.quality.value == "degraded":
            return RepeatResult(
                fingerprint=fingerprint,
                consecutive_count=0,
                no_progress=False,
                rev=snapshot.rev,
                code=vc_codes.CHECKPOINT_DEGRADED,
                message="状态文件仅降级可读，先重建完整状态再检测",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
            )

        review = snapshot.fields.get("review")
        review_dict: dict[str, Any] = dict(review) if isinstance(review, dict) else {}
        failure = review_dict.get("failure_state")
        failure_dict: dict[str, Any] = dict(failure) if isinstance(failure, dict) else {}
        last_fp = str(failure_dict.get("last_fingerprint", "") or "")
        count = _safe_int(failure_dict.get("consecutive_count"), 0)
        raw_history = failure_dict.get("history", [])
        history = [str(x) for x in raw_history] if isinstance(raw_history, list) else []
        if fingerprint == last_fp:
            new_count = count + 1
        else:
            new_count = 1
            history.append(fingerprint)
        failure_dict.update(
            {
                "last_fingerprint": fingerprint,
                "consecutive_count": new_count,
                "history": history[-10:],
            }
        )
        failure_dict.setdefault("round_started_at", now_to_minute())
        review_dict["failure_state"] = failure_dict
        write = self.store.write({"review": review_dict}, expected_rev=snapshot.rev)
        if not write.ok:
            return RepeatResult(
                fingerprint=fingerprint,
                consecutive_count=count,
                no_progress=count >= 2,
                rev=write.rev,
                code=write.code,
                message=write.message,
                next=write.next,
            )
        no_progress = new_count >= 2
        rev = write.rev
        if no_progress and state_code(snapshot.fields.get("phase")) != "S14":
            esc = self.transition(
                "S14",
                force=True,
                reason="consecutive_same_failures",
                expected_rev=write.rev,
            )
            if esc.ok:
                rev = esc.rev
        return RepeatResult(
            fingerprint=fingerprint,
            consecutive_count=new_count,
            no_progress=no_progress,
            rev=rev,
            code=vc_codes.NO_PROGRESS if no_progress else "",
            message=f"连续 {new_count} 次相同失败指纹" if no_progress else "",
            next=vc_codes.next_action(vc_codes.NO_PROGRESS) if no_progress else "",
        )

    # 6 ------------------------------------------------------------------
    def get_state(self) -> StateView:
        try:
            snapshot = self.store.snapshot()
        except CheckpointError as exc:
            return StateView(
                mode="reference_only",
                code=exc.code,
                next=vc_codes.next_action(exc.code),
                source=str(self.resolved.memory_key),
            )
        if not snapshot.exists:
            return StateView(
                mode="fresh_start",
                status="",
                phase="S0 Idle",
                rev=0,
                source=str(self.resolved.memory_key),
            )
        if snapshot.missing_required or not str(snapshot.raw.get("updated_at", "") or ""):
            return StateView(
                mode="reference_only",
                phase=str(snapshot.fields.get("phase", "")),
                rev=snapshot.rev,
                source=str(self.resolved.memory_key),
                code=vc_codes.CHECKPOINT_DEGRADED,
                next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
            )
        if not snapshot.numeric_valid:
            return StateView(
                mode="reference_only",
                phase=str(snapshot.fields.get("phase", "")),
                rev=snapshot.rev,
                source=str(self.resolved.memory_key),
                code=vc_codes.CHECKPOINT_DEGRADED,
                next="loop 必须 ≥0 且 level ∈ 0–4",
            )
        if not snapshot.phase_valid:
            return StateView(
                mode="reference_only",
                phase=str(snapshot.fields.get("phase", "")),
                rev=snapshot.rev,
                source=str(self.resolved.memory_key),
                code=vc_codes.CHECKPOINT_DEGRADED,
                next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
            )
        status_value = str(snapshot.fields.get("status", ""))
        if status_value not in ("active", "paused", "complete"):
            return StateView(
                mode="reference_only",
                phase=str(snapshot.fields.get("phase", "")),
                rev=snapshot.rev,
                source=str(self.resolved.memory_key),
                code=vc_codes.CHECKPOINT_DEGRADED,
                next="status 必须是 active/paused/complete",
            )
        if parse_minute(snapshot.fields.get("updated_at")) is None:
            return StateView(
                mode="reference_only",
                phase=str(snapshot.fields.get("phase", "")),
                rev=snapshot.rev,
                source=str(self.resolved.memory_key),
                code=vc_codes.CHECKPOINT_DEGRADED,
                next="updated_at 不可解析",
            )
        if status_value == "complete":
            return StateView(
                mode="reference_only",
                status=status_value,
                phase=str(snapshot.fields.get("phase", "")),
                loop=int(snapshot.fields.get("loop", 0) or 0),
                level=int(snapshot.fields.get("level", 0) or 0),
                current_step=str(snapshot.fields.get("current_step", "")),
                rev=snapshot.rev,
                updated_at=str(snapshot.fields.get("updated_at", "")),
                completed_count=len(snapshot.fields.get("completed", []) or []),
                pending_count=len(snapshot.fields.get("pending", []) or []),
                source=str(self.resolved.memory_key),
                next="任务已结束；新输入请先归档旧状态",
            )
        if snapshot.schema_invalid:
            return StateView(
                mode="reference_only",
                phase=str(snapshot.fields.get("phase", "")),
                rev=snapshot.rev,
                source=str(self.resolved.memory_key),
                code=vc_codes.CHECKPOINT_CORRUPT,
                next=vc_codes.next_action(vc_codes.CHECKPOINT_CORRUPT),
            )
        if snapshot.schema_ahead:
            return StateView(
                mode="reference_only",
                phase=str(snapshot.fields.get("phase", "")),
                rev=snapshot.rev,
                source=str(self.resolved.memory_key),
                code=vc_codes.CHECKPOINT_SCHEMA_AHEAD,
                next=vc_codes.next_action(vc_codes.CHECKPOINT_SCHEMA_AHEAD),
            )
        if snapshot.owner and snapshot.owner != self.resolved.project_id:
            return StateView(
                mode="reference_only",
                phase=str(snapshot.fields.get("phase", "")),
                rev=snapshot.rev,
                source=str(self.resolved.memory_key),
                code=vc_codes.CHECKPOINT_FOREIGN,
                next=vc_codes.next_action(vc_codes.CHECKPOINT_FOREIGN),
            )
        fields = snapshot.fields
        return StateView(
            mode="resume" if snapshot.quality.value == "strict" else "resume_degraded",
            status=str(fields.get("status", "")),
            phase=str(fields.get("phase", "")),
            loop=int(fields.get("loop", 0) or 0),
            level=int(fields.get("level", 0) or 0),
            current_step=str(fields.get("current_step", "")),
            rev=snapshot.rev,
            updated_at=str(fields.get("updated_at", "")),
            completed_count=len(fields.get("completed", []) or []),
            pending_count=len(fields.get("pending", []) or []),
            source=str(self.resolved.memory_key),
        )

    # 便捷封装 -----------------------------------------------------------
    def verify_pending(
        self,
        pending: Iterable[Any],
        *,
        round_started_at: str = "",
        exec_results: Mapping[str, bool] | None = None,
    ):
        return _verify_pending(
            list(pending),
            project_root=self.resolved.project_root,
            round_started_at=round_started_at,
            exec_results=exec_results,
        )


def _bounded_fingerprint(value: str) -> str:
    return str(value or "")[:256]


def _safe_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


_CONTROL_RE = re.compile(
    r"\x1b\[[0-9;]*[A-Za-z]|"
    r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]|"
    r"[\u2028\u2029\u202a-\u202e\u2066-\u2069]|"
    r"[\ud800-\udfff]"
)


def _safe_text(value: Any) -> str:
    text = str(value)
    text = _CONTROL_RE.sub(" ", text)
    text = "".join(" " if unicodedata.category(ch) in ("Cf", "Cs") else ch for ch in text)
    return text.replace("\r", " ").replace("\n", " ")[:400]


def _compact(value: Any) -> str:
    if isinstance(value, str):
        return _safe_text(value)
    try:
        return _safe_text(json.dumps(value, ensure_ascii=False, sort_keys=False))
    except (TypeError, ValueError):  # pragma: no cover
        return str(value)[:400]
