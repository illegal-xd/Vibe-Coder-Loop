"""S0–S14 状态机：合法转换、升级弧、Loop 记账、出口证据校验。

事实源：skills/vibe-coder-loop/engine/transition.md（机器可读块）+ kernel.md §7。
本模块的 ``LEGAL_TRANSITIONS`` / ``LOOP_RULES`` 是事实源的**程序化镜像**；
``PROTOCOL_DRIFT`` 由 ``protocol.check_protocol`` 逐边 + 修饰符双向比对。
"""

from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal

from . import vc_codes
from .checkpoint import (
    STATE_SCHEMA_VERSION,
    CheckpointError,
    CheckpointStore,
    Snapshot,
    normalize_fields,
    now_to_minute,
    state_code,
)

PAUSE = "PAUSE"
RESUME = "RESUME"

STATE_LABELS: dict[str, str] = {
    "S0": "S0 Idle",
    "S1": "S1 Intent",
    "S2": "S2 Preflight",
    "S3": "S3 Decision",
    "S4": "S4 Router",
    "S5": "S5 Clarify",
    "S6": "S6 Design",
    "S7": "S7 Plan",
    "S8": "S8 Code",
    "S9": "S9 Test",
    "S10": "S10 Review",
    "S11": "S11 Reflection",
    "S12": "S12 Memory Evolution",
    "S13": "S13 Complete",
    "S14": "S14 Safe Mode",
}

# 合法后继表（transition.md「机器可读转移表」的程序化镜像）
LEGAL_TRANSITIONS: dict[str, set[str]] = {
    "S0": {"S1"},
    "S1": {"S2", PAUSE},
    "S2": {"S3", "S4"},
    "S3": {"S4", PAUSE},
    "S4": {"S5", "S8"},
    "S5": {"S6"},
    "S6": {"S7"},
    "S7": {"S8", "S10"},
    "S8": {"S9", "S13", "S8"},  # S8→S8 自环：同轮自检修复，Loop 不变
    "S9": {"S10", "S8"},
    "S10": {"S11", "S8", "S6", "S7", "S13"},
    "S11": {"S12"},
    "S12": {"S13"},
    "S13": {"S0", "S1"},
    "S14": {"S13", RESUME},
}

# 升级弧：任意状态 → S14（须 force + reason）
ESCALATION_EDGES: dict[str, set[str]] = {"*": {"S14"}}

# Loop 规则：inc = N+1；reset0 = 归 0；init1 = 初始化 1；keep = 维持
# 值为 set 表示该边允许多种 Loop 结果，调用方必须显式指定
LOOP_RULES: dict[tuple[str, str], str | frozenset[str]] = {
    ("S4", "S8"): "init1",
    ("S9", "S8"): "inc",
    ("S10", "S8"): "inc",
    ("S10", "S6"): "inc",
    ("S10", "S7"): frozenset({"inc", "reset0"}),
    ("S13", "S1"): "reset0",
}

INCREMENT_EDGES = frozenset(edge for edge, rule in LOOP_RULES.items() if rule == "inc")
RESET_EDGES = frozenset(edge for edge, rule in LOOP_RULES.items() if rule == "reset0")
INIT_EDGES = frozenset(edge for edge, rule in LOOP_RULES.items() if rule == "init1")
MULTI_LOOP_EDGES = frozenset(edge for edge, rule in LOOP_RULES.items() if isinstance(rule, frozenset))

LOOP_MAX_QUICK = 1
LOOP_MAX_STANDARD = 3


def loop_max(level: int, override: int | None = None) -> int:
    """L0/L1 = 1；L2+ = 3。项目覆盖只允许收紧。"""
    base = LOOP_MAX_QUICK if level in (0, 1) else LOOP_MAX_STANDARD
    if override is None:
        return base
    return min(base, max(1, int(override)))


def phase_label(code: str) -> str:
    return STATE_LABELS.get(code, code)


def normalize_target(to_state: str) -> str:
    """接受 ``S1`` / ``S1 Intent`` / ``PAUSE`` / ``RESUME``。"""
    if not isinstance(to_state, str):
        return ""
    text = to_state.strip()
    if text.upper() in (PAUSE, RESUME):
        return text.upper()
    code = state_code(text)
    return code if code in STATE_LABELS else ""


def _machine_allows(current: str, target: str) -> bool:
    if target == "S14":
        return current != "S14"
    return target in LEGAL_TRANSITIONS.get(current, set())


# ---------------------------------------------------------------------------
# 出口清单
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ExitChecklist:
    stage: str
    referenced_outputs: list[str] = field(default_factory=list)
    checked_items: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExitChecklist":
        if not isinstance(data, dict):
            raise ValueError("exit_checklist 必须是对象")

        def _strings(name: str) -> list[str]:
            raw = data.get(name, []) or []
            if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
                raise ValueError(f"{name} 必须是字符串数组")
            return list(raw)

        return cls(
            stage=str(data.get("stage", "")),
            referenced_outputs=_strings("referenced_outputs"),
            checked_items=_strings("checked_items"),
        )

    def all_text(self) -> str:
        return "\n".join([self.stage, *self.referenced_outputs, *self.checked_items])


_PATH_SUFFIX_RE = re.compile(r"\.[A-Za-z0-9]{1,8}$")
_STEP_RE = re.compile(r"^(?:step\s+\d+|s\d{1,2})$", re.IGNORECASE)


def _reference_verifiable(
    item: str,
    *,
    project_root: Path,
    snapshot: Snapshot,
    plan_text: str,
) -> bool:
    text = item.strip()
    if not text:
        return False
    if text.startswith("path:"):
        candidate = text[len("path:") :].strip()
        return _project_relative_exists(candidate, project_root)
    if text.startswith("user:"):
        ident = text[len("user:") :].strip()
        return any(
            isinstance(entry, dict) and str(entry.get("id", "")) == ident
            for entry in snapshot.fields.get("user_decisions", [])
        )
    if text.startswith(("sym:", "fn:")):
        needle = text.split(":", 1)[1].strip()
        return bool(needle and plan_text and needle in plan_text)
    if _STEP_RE.match(text):
        done = " ".join(str(x) for x in snapshot.fields.get("completed", []))
        return bool((plan_text and text.lower() in plan_text.lower()) or text.lower() in done.lower())
    # 看起来像项目内相对路径
    if "/" in text or _PATH_SUFFIX_RE.search(text):
        return _project_relative_exists(text, project_root)
    return False


def _project_relative_exists(candidate: str, project_root: Path) -> bool:
    if not candidate or "\x00" in candidate:
        return False
    try:
        from .checkpoint import expand_home

        path = expand_home(candidate)
    except (CheckpointError, RuntimeError, OSError):
        return False
    if path.is_absolute():
        return False  # 出口引用只允许项目内相对路径
    try:
        resolved = (project_root / path).resolve()
        root = project_root.resolve()
        return (resolved == root or root in resolved.parents) and resolved.exists()
    except OSError:
        return False


def validate_exit_checklist(
    checklist: ExitChecklist,
    *,
    current_code: str,
    snapshot: Snapshot,
    project_root: Path,
) -> tuple[bool, list[str], list[str]]:
    """只校验「该有的项是否勾选 + 引用是否可机械解析」，不校验内容正确性。"""
    missing: list[str] = []
    evidence: list[str] = []
    stage_code = state_code(checklist.stage)
    if not stage_code:
        missing.append("stage")
    elif stage_code != current_code:
        missing.append(f"stage={checklist.stage}（期望 {current_code}）")
    if not checklist.checked_items:
        missing.append("checked_items")
    if not checklist.referenced_outputs:
        missing.append("referenced_outputs")
    plan_text = _plan_text_for(project_root)
    for item in checklist.referenced_outputs:
        if _reference_verifiable(
            item,
            project_root=project_root,
            snapshot=snapshot,
            plan_text=plan_text,
        ):
            evidence.append(item)
    if checklist.referenced_outputs and not evidence:
        missing.append("referenced_outputs 无一项可机械验证")
    return (not missing, missing, evidence)


def _plan_text_for(project_root: Path) -> str:
    for path in (project_root / ".vibe-kernel" / "plan.md",):
        try:
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                continue
            if info.st_size > 1024 * 1024:
                continue
            return path.read_bytes().decode("utf-8")
        except (OSError, UnicodeError):
            continue
    return ""


_NEGATIONS = (
    "不",
    "别",
    "勿",
    "未",
    "无需",
    "不要",
    "不能",
    "无法",
    "取消",
    "拒绝",
    "算了",
    "否",
    "没",
    "甭",
    "never",
    "do not",
    "not ",
)
_NEGATION_RE = re.compile(
    r"\b(?:can|won|don|doesn|isn|aren|didn|wouldn|shouldn|couldn)'?t\b|"
    r"\bcannot\b|\bno\s+need\b|\bnot\s+really\b|"
    r"\b(?:no|nope|nah|none|nothing|reject|decline|deny|cancel|abort|negative|refuse)\b",
    re.IGNORECASE,
)


def _normalize_quotes(text: str) -> str:
    return (
        text.replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u02bc", "'")
        .replace("\uff07", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
    )


def _has_negation(text: str) -> bool:
    normalized = _normalize_quotes(text)
    return any(neg in normalized for neg in _NEGATIONS) or bool(
        _NEGATION_RE.search(normalized)
    )


def _mentions_word(text: str, word: str) -> bool:
    if not word:
        return False
    if word.isascii():
        return bool(re.search(rf"(?<![a-z]){re.escape(word.lower())}(?![a-z])", text))
    return word in text


_CONFIRM_PREFIX = re.compile(
    r"^(?:用户说|用户表示|用户确认|user\s+says|user|ok|okay|好的?|yes)[\s:：,，!！.。]*",
    re.IGNORECASE,
)


_DEFERRAL = ("later", "tomorrow", "if ", "unless", "等待", "等", "暂停", "稍后", "以后", "回头")


def _exact_confirmation(text: str, words: Iterable[str]) -> bool:
    normalized = _normalize_quotes(text).strip().strip("\"'“”‘’ \t")
    if any(mark in normalized for mark in ("？", "?")) or normalized.rstrip("。.!！ ").endswith("吗"):
        return False
    if any(term in normalized.lower() for term in _DEFERRAL):
        return False
    cleaned = _CONFIRM_PREFIX.sub("", normalized)
    cleaned = cleaned.strip(" \t,，.。!！;；:：")
    lowered = cleaned.lower()
    if any(lowered == word.lower() for word in words):
        return True
    for word in words:
        pattern = rf"^please\s+{re.escape(word.lower())}(?![a-z])" if word.isascii() else rf"^请?{re.escape(word)}"
        if re.match(pattern, lowered) and not _has_negation(lowered):
            return True
    return False


def _user_confirmed(
    checklist: ExitChecklist | None,
    *,
    snapshot: Snapshot,
    words: Iterable[str],
) -> bool:
    """只认结构化 user_decisions 或显式 checked_items，不接受 stage 文本。"""
    if checklist is None:
        return False
    candidates: list[str] = []
    for item in checklist.referenced_outputs:
        if item.startswith("user:"):
            ident = item[len("user:") :].strip()
            for entry in snapshot.fields.get("user_decisions", []):
                if isinstance(entry, dict) and str(entry.get("id", "")) == ident:
                    said = str(entry.get("user_says", "") or "").strip()
                    if said:
                        candidates.append(said)
    candidates.extend(str(item) for item in checklist.checked_items)

    for text in candidates:
        if _exact_confirmation(text, words):
            return True
    return False


# ---------------------------------------------------------------------------
# 转换
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class TransitionResult:
    ok: bool
    from_state: str
    to_state: str
    phase: str
    loop: int
    rev: int
    status: str = ""
    code: str = ""
    message: str = ""
    next: str = ""
    changed: bool = False
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "ok": self.ok,
            "from": self.from_state,
            "to": self.to_state,
            "phase": self.phase,
            "loop": self.loop,
            "rev": self.rev,
            "status": self.status,
            "changed": self.changed,
        }
        if self.code:
            data.update(vc_codes.make_code(self.code, self.message, action=self.next).to_dict())
        if self.warnings:
            data["warnings"] = list(self.warnings)
        return data


def _fail(
    code: str,
    fact: str,
    snapshot: Snapshot,
    *,
    current_code: str,
    to_code: str,
    action: str | None = None,
) -> TransitionResult:
    return TransitionResult(
        ok=False,
        from_state=current_code,
        to_state=to_code,
        phase=str(snapshot.fields.get("phase", "")),
        loop=int(snapshot.fields.get("loop", 0) or 0),
        rev=snapshot.rev,
        status=str(snapshot.fields.get("status", "")),
        code=code,
        message=fact,
        next=action or vc_codes.next_action(code),
    )


def transition(
    store: CheckpointStore,
    to_state: str,
    *,
    loop: int | None = None,
    exit_checklist: ExitChecklist | dict[str, Any] | None = None,
    expected_rev: int | None = None,
    force: bool = False,
    reason: str = "",
    current_step: str | None = None,
    level: int | None = None,
    plan_files: list[str] | None = None,
    vc_violation: str = "",
    loop_max_override: int | None = None,
) -> TransitionResult:
    if isinstance(exit_checklist, dict):
        exit_checklist = ExitChecklist.from_dict(exit_checklist)

    try:
        if store.read_text() is None:
            store.maybe_import_legacy()
        snapshot = store.snapshot()
    except CheckpointError as exc:  # 读取/损坏 -> fail-closed
        return TransitionResult(
            ok=False,
            from_state="",
            to_state=normalize_target(to_state),
            phase="",
            loop=0,
            rev=0,
            code=getattr(exc, "code", vc_codes.CHECKPOINT_CORRUPT),
            message=str(exc),
            next=vc_codes.next_action(vc_codes.CHECKPOINT_CORRUPT),
        )

    # 0. 只读/归属保护：schema 超前/非法或他人项目文件一律不写
    if snapshot.schema_invalid:
        return _fail(
            vc_codes.CHECKPOINT_CORRUPT,
            f"_schema 不是整数: {snapshot.raw.get('_schema')!r}",
            snapshot,
            current_code=state_code(snapshot.fields.get("phase")) or "S0",
            to_code=normalize_target(to_state),
        )
    if snapshot.schema_ahead:
        return _fail(
            vc_codes.CHECKPOINT_SCHEMA_AHEAD,
            f"_schema={snapshot.schema} 高于支持版本 {STATE_SCHEMA_VERSION}（只读不写）",
            snapshot,
            current_code=state_code(snapshot.fields.get("phase")) or "S0",
            to_code=normalize_target(to_state),
        )
    if snapshot.owner and snapshot.owner != store.resolved.project_id:
        return _fail(
            vc_codes.CHECKPOINT_FOREIGN,
            "_project_id 与当前项目不符（不跨项目写入）",
            snapshot,
            current_code=state_code(snapshot.fields.get("phase")) or "S0",
            to_code=normalize_target(to_state),
        )
    if snapshot.exists and snapshot.quality.value == "degraded":
        return _fail(
            vc_codes.CHECKPOINT_DEGRADED,
            "状态文件仅降级可读；先按当前会话重建完整状态再转换",
            snapshot,
            current_code=state_code(snapshot.fields.get("phase")) or "S0",
            to_code=normalize_target(to_state),
        )

    raw_code = state_code(snapshot.fields.get("phase"))
    if snapshot.exists and raw_code not in STATE_LABELS:
        return _fail(
            vc_codes.STATE_ILLEGAL_TRANSITION,
            f"无法识别 phase: {snapshot.fields.get('phase')!r}",
            snapshot,
            current_code=raw_code or "?",
            to_code=normalize_target(to_state),
            action="把 phase 修正为 S0–S14 + Label 后重试",
        )
    current_code = raw_code or "S0"
    current_loop = int(snapshot.fields.get("loop", 0) or 0)
    current_level = int(snapshot.fields.get("level", 0) or 0)
    if snapshot.exists and not snapshot.numeric_valid:
        return _fail(
            vc_codes.CHECKPOINT_DEGRADED,
            f"loop/level 越界: loop={current_loop} level={current_level}",
            snapshot,
            current_code=current_code,
            to_code=normalize_target(to_state),
        )
    current_status = str(snapshot.fields.get("status", "paused"))

    # 0. 硬约束违规上报 → 强制升级弧（不猜测，调用方明确上报才触发）
    if vc_violation:
        to_state = "S14"
        force = True
        reason = reason or "hard_constraint_violation"

    target = normalize_target(to_state)
    if not target:
        return _fail(
            vc_codes.INVALID_ARGUMENT,
            f"无法识别的目标状态: {to_state!r}",
            snapshot,
            current_code=current_code,
            to_code=str(to_state),
        )

    # 1. 版本校验
    if expected_rev is not None and expected_rev != snapshot.rev:
        return _fail(
            vc_codes.STATE_REV_CONFLICT,
            f"expected_rev={expected_rev} 与当前 _rev={snapshot.rev} 不符",
            snapshot,
            current_code=current_code,
            to_code=target,
        )

    # 2/3. 合法性 + 升级弧
    escalation = target == "S14"
    if escalation:
        if current_code == "S14" or not _machine_allows(current_code, "S14"):
            return _fail(
                vc_codes.STATE_ILLEGAL_TRANSITION,
                "已在 S14 或当前状态不允许升级",
                snapshot,
                current_code=current_code,
                to_code=target,
                action="S14 是暂停态：只能经用户确认「继续」或「停止/接受」离开",
            )
        if not force or not reason.strip():
            return _fail(
                vc_codes.STATE_ILLEGAL_TRANSITION,
                "进入 S14 须 force=True 且 reason 非空",
                snapshot,
                current_code=current_code,
                to_code=target,
                action="补齐 force/reason（风险原因）后重试",
            )
    elif not _machine_allows(current_code, target):
        return _fail(
            vc_codes.STATE_ILLEGAL_TRANSITION,
            f"非法转换: {current_code} → {target}",
            snapshot,
            current_code=current_code,
            to_code=target,
        )

    # 4. 出口证据（S14 出口必须含用户原话证据）
    if current_code == "S14":
        words = ("继续", "continue", "resume") if target == RESUME else ("停止", "接受", "stop", "accept")
        if not _user_confirmed(exit_checklist, snapshot=snapshot, words=words):
            return _fail(
                vc_codes.EXIT_CHECKLIST_INCOMPLETE,
                "离开 S14 缺少用户确认证据（原话或 user_decisions 条目 id）",
                snapshot,
                current_code=current_code,
                to_code=target,
                action="追加用户原话证据后重试",
            )
    elif exit_checklist is not None:
        ok, missing, _evidence = validate_exit_checklist(
            exit_checklist,
            current_code=current_code,
            snapshot=snapshot,
            project_root=store.resolved.project_root,
        )
        if not ok:
            return _fail(
                vc_codes.EXIT_CHECKLIST_INCOMPLETE,
                "出口清单不完整: " + ", ".join(missing),
                snapshot,
                current_code=current_code,
                to_code=target,
                action=f"补齐 {', '.join(missing)} 后重试",
            )

    if target == RESUME and current_code == "S14":
        resume_phase = str(snapshot.fields.get("_resume_from", "") or "")
        if not resume_phase:
            return _fail(
                vc_codes.STATE_ILLEGAL_TRANSITION,
                "S14 缺少 _resume_from，只能经「停止/接受」走 S13",
                snapshot,
                current_code=current_code,
                to_code=target,
            )
        new_code = state_code(resume_phase)
        if new_code not in STATE_LABELS or new_code == "S14":
            return _fail(
                vc_codes.STATE_ILLEGAL_TRANSITION,
                f"_resume_from 不是合法 phase: {resume_phase!r}",
                snapshot,
                current_code=current_code,
                to_code=target,
                action="修正 _resume_from 后重试",
            )
        new_phase = resume_phase
        new_loop = current_loop
        new_status = "active"
    elif target == PAUSE:
        new_code = current_code
        new_phase = str(snapshot.fields.get("phase", ""))
        new_loop = current_loop
        new_status = "paused"
    else:
        new_code = target
        new_phase = phase_label(target)
        if target == "S13" or (target == "S0" and current_code == "S13"):
            new_status = "complete"
        elif target == "S14":
            new_status = "paused"
        else:
            new_status = "active"
        # 5. Loop 记账
        rule = LOOP_RULES.get((current_code, target), "keep")
        if isinstance(rule, frozenset):
            if loop is None:
                return _fail(
                    vc_codes.INVALID_ARGUMENT,
                    f"{current_code}→{target} 允许多种 Loop 结果，必须显式传 loop",
                    snapshot,
                    current_code=current_code,
                    to_code=target,
                    action="指明是补充调查(N+1)还是重新调查(0)",
                )
            allowed = {current_loop + 1 if r == "inc" else 0 for r in rule}
            if loop not in allowed:
                return _fail(
                    vc_codes.INVALID_ARGUMENT,
                    f"loop={loop} 不在该边允许集 {sorted(allowed)} 内",
                    snapshot,
                    current_code=current_code,
                    to_code=target,
                )
            new_loop = loop
        elif rule == "inc":
            expected = current_loop + 1
            if loop is not None and loop != expected:
                return _fail(
                    vc_codes.INVALID_ARGUMENT,
                    f"{current_code}→{target} 的 loop 必须为 N+1={expected}，收到 {loop}",
                    snapshot,
                    current_code=current_code,
                    to_code=target,
                )
            new_loop = expected
        elif rule == "reset0":
            if loop is not None and loop != 0:
                return _fail(
                    vc_codes.INVALID_ARGUMENT,
                    f"{current_code}→{target} 的 loop 必须归 0，收到 {loop}",
                    snapshot,
                    current_code=current_code,
                    to_code=target,
                )
            new_loop = 0
        elif rule == "init1":
            if loop is not None and loop != 1:
                return _fail(
                    vc_codes.INVALID_ARGUMENT,
                    f"{current_code}→{target} 的 loop 必须初始化为 1，收到 {loop}",
                    snapshot,
                    current_code=current_code,
                    to_code=target,
                )
            new_loop = 1
        else:
            if loop is not None and loop != current_loop:
                return _fail(
                    vc_codes.INVALID_ARGUMENT,
                    f"{current_code}→{target} 不改变 Loop，期望 {current_loop}，收到 {loop}",
                    snapshot,
                    current_code=current_code,
                    to_code=target,
                )
            new_loop = current_loop

    # 6. 预算守卫（fail-closed；仅对「增加预算」的边生效，S13/S14 必须可达）
    if level is not None:
        try:
            level_int = int(level)
        except (TypeError, ValueError, OverflowError):
            level_int = -1
        if not 0 <= level_int <= 4:
            return _fail(
                vc_codes.INVALID_ARGUMENT,
                f"level 必须是 0–4，收到 {level!r}",
                snapshot,
                current_code=current_code,
                to_code=target,
            )
    effective_level = current_level if level is None else int(level)
    if new_loop > current_loop and new_loop > loop_max(effective_level, loop_max_override):
        return _fail(
            vc_codes.LOOP_BUDGET_EXHAUSTED,
            f"loop={new_loop} 超过 Level {effective_level} 的 loop_max={loop_max(effective_level, loop_max_override)}",
            snapshot,
            current_code=current_code,
            to_code=target,
        )

    # 7. 组装写入字段
    updates: dict[str, Any] = {
        "phase": new_phase,
        "loop": new_loop,
        "status": new_status,
    }
    if level is not None:
        updates["level"] = int(level)
    if current_step is not None:
        updates["current_step"] = current_step
    if target in (PAUSE, "S14"):
        updates["current_step"] = str(snapshot.fields.get("current_step", ""))
    elif target != RESUME:
        updates.setdefault("current_step", phase_label(new_code))

    if target not in (RESUME, PAUSE, "S14") and not (current_code == target == "S8"):
        done_entry = phase_label(current_code)
        step = str(snapshot.fields.get("current_step", "") or "").strip()
        if step and step != phase_label(current_code):
            done_entry += f": {step}"
        updates["completed"] = list(snapshot.fields.get("completed", [])) + [done_entry]
    elif target == RESUME:
        updates["_resume_from"] = ""

    if escalation:
        updates["_resume_from"] = str(snapshot.fields.get("phase", ""))
    if target == "S13":
        resume = str(snapshot.fields.get("resume", "") or "").strip()
        if not resume:
            step = str(snapshot.fields.get("current_step", "") or "").strip()
            goal = snapshot.fields.get("goal")
            goal_text = ""
            if isinstance(goal, dict):
                goal_text = str(goal.get("explicit", "") or "")
            resume = f"S13 complete: {goal_text or step or 'task finished'}"
        pending_items = [str(item) for item in (snapshot.fields.get("pending", []) or []) if str(item).strip()]
        if pending_items:
            resume += "\n未落地 pending: " + "; ".join(pending_items)
        updates["resume"] = resume

    review = snapshot.fields.get("review")
    review_dict: dict[str, Any] = dict(review) if isinstance(review, dict) else {}
    plan_set = plan_files
    if plan_set is None and current_code == "S7" and exit_checklist is not None:
        plan_set = [
            item[len("path:") :].strip() if item.startswith("path:") else item
            for item in exit_checklist.referenced_outputs
            if "/" in item or _PATH_SUFFIX_RE.search(item)
        ]
    if plan_set:
        review_dict["plan_files"] = [str(p) for p in plan_set]
    if escalation:
        failure_state = review_dict.get("failure_state")
        failure_state = dict(failure_state) if isinstance(failure_state, dict) else {}
        failure_state["safe_mode_reason"] = reason
        failure_state["safe_mode_entered_at"] = now_to_minute()
        review_dict["failure_state"] = failure_state
    if review_dict and review_dict != review:
        updates["review"] = review_dict

    # 8. 写入（仅字段变化时落盘；追加型数组并集保序）
    archived = current_status == "complete" and target == "S1"
    if archived:
        defaults = normalize_fields({})
        for key in (
            "completed",
            "pending",
            "decisions",
            "user_decisions",
            "goal",
            "resume",
            "review",
            "_resume_from",
        ):
            updates[key] = defaults.get(key, [] if key != "resume" else "")
        updates["_resume_from"] = ""
    expected_for_write = (
        (0 if store.resolved.allow_move else snapshot.rev)
        if archived
        else (snapshot.rev if expected_rev is None else expected_rev)
    )
    result = store.write(
        updates,
        expected_rev=expected_for_write,
        archive_kind="complete" if archived else None,
        replace_keys=(
            (
                "completed",
                "pending",
                "decisions",
                "user_decisions",
                "goal",
                "resume",
                "review",
                "_resume_from",
            )
            if archived
            else ()
        ),
    )
    if not result.ok:
        return TransitionResult(
            ok=False,
            from_state=current_code,
            to_state=target,
            phase=str(snapshot.fields.get("phase", "")),
            loop=current_loop,
            rev=result.rev or snapshot.rev,
            status=current_status,
            code=result.code,
            message=result.message,
            next=result.next,
        )

    final = store.snapshot()
    code = ""
    message = ""
    nxt = ""
    if vc_violation:
        code = vc_codes.SCOPE_DENIED
        message = f"硬约束违规已上报，已进入 S14: {vc_violation}"
        nxt = vc_codes.next_action(vc_codes.SCOPE_DENIED)
    return TransitionResult(
        ok=True,
        from_state=current_code,
        to_state=target,
        phase=str(final.fields.get("phase", new_phase)),
        loop=new_loop,
        rev=result.rev,
        status=str(final.fields.get("status", new_status)),
        code=code,
        message=message,
        next=nxt,
        changed=result.changed,
        warnings=result.warnings,
    )
