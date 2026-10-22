"""恢复协议机械执行：freshness + 字段完整性 + pending 三态核验 + artifact 引用校验。

事实源：docs/design/mvp-1-workflow-core.md §5 / skills/vibe-coder-loop/engine/state-machine.md
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from . import vc_codes
from .artifacts import ArtifactStore
from .checkpoint import (
    GIT_SAFE_ARGS,
    _git_env,
    REQUIRED_FIELDS,
    STATE_SCHEMA_VERSION,
    CheckpointStore,
    CorruptCheckpoint,
    Snapshot,
    parse_minute,
)
from .state_parse import ParseQuality, SubsetParseError, parse_subset, scan_flat_scalars

DEFAULT_MAX_AGE_MINUTES = 1440

_SHA_RE = re.compile(r"sha256:([0-9a-fA-F]{64})")
_PATH_RE = re.compile(
    r"(?:^|[\s(（:：`'\"])"
    r"((?:\.{0,2}/)?[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,8})"
    r"(?=$|[\s)）`,，:：;；])"
)
_EXPLICIT_PATH_RE = re.compile(r"path:\s*([^\s,，;；]+)")
_CMD_RE = re.compile(r"(?:cmd|exec):\s*([^,，;；]+)")
_PENDING_NEGATIONS = (
    "未完成",
    "未落地",
    "待确认",
    "待办",
    "不要",
    "无需",
    "没有",
    "尚未",
    "没完成",
    "not done",
    "todo",
)
MAX_PENDING_ITEMS = 500
MAX_PATHS_PER_ITEM = 20
MAX_GIT_CALLS = 100
MAX_HASH_FILES = 200
MAX_HASH_BYTES = 64 * 1024 * 1024


_OUTPUT_CTRL = re.compile(
    r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]"
)


def _sanitize_output(value: Any, *, limit: int = 2000) -> Any:
    if isinstance(value, str):
        return _OUTPUT_CTRL.sub(" ", value).replace("\r", " ").replace("\n", " ")[:limit]
    if isinstance(value, list):
        return [_sanitize_output(item, limit=limit) for item in value[:200]]
    if isinstance(value, dict):
        return {str(key): _sanitize_output(item, limit=limit) for key, item in list(value.items())[:50]}
    return value


@dataclass(frozen=True)
class PendingCheck:
    item: str
    state: str  # verified | unverified | still_pending
    evidence: list[str] = field(default_factory=list)
    move_to_completed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "item": _sanitize_output(self.item),
            "state": self.state,
            "evidence": _sanitize_output(list(self.evidence)),
            "move_to_completed": self.move_to_completed,
        }


@dataclass(frozen=True)
class RecoveryResult:
    mode: str
    reason: str = ""
    status: str = ""
    phase: str = ""
    loop: int = 0
    level: int = 0
    current_step: str = ""
    completed: list[Any] = field(default_factory=list)
    pending: list[Any] = field(default_factory=list)
    rev: int = 0
    quality: ParseQuality = ParseQuality.CORRUPT
    code: str = ""
    next: str = ""
    missing: list[str] = field(default_factory=list)
    artifact_missing: list[dict[str, Any]] = field(default_factory=list)
    artifact_unverified: list[dict[str, Any]] = field(default_factory=list)
    pending_checks: list[PendingCheck] = field(default_factory=list)
    fields: dict[str, Any] = field(default_factory=dict)
    legacy_import: dict[str, str] | None = None

    @property
    def resumable(self) -> bool:
        return self.mode in ("resume", "resume_stale", "resume_degraded")

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "mode": self.mode,
            "reason": _sanitize_output(self.reason),
            "status": _sanitize_output(self.status),
            "phase": _sanitize_output(self.phase),
            "loop": self.loop,
            "level": self.level,
            "current_step": _sanitize_output(self.current_step),
            "completed": _sanitize_output(list(self.completed)),
            "pending": _sanitize_output(list(self.pending)),
            "rev": self.rev,
            "quality": self.quality.value,
            "missing": list(self.missing),
            "artifact_missing": list(self.artifact_missing),
            "artifact_unverified": list(self.artifact_unverified),
            "pending_checks": [check.to_dict() for check in self.pending_checks],
        }
        if self.code:
            data.update(vc_codes.make_code(self.code, self.reason, action=self.next or None).to_dict())
        if self.legacy_import:
            data["legacy_import"] = dict(self.legacy_import)
        return data


def age_minutes(updated_at: Any, *, now: datetime | None = None) -> int | None:
    stamp = parse_minute(updated_at)
    if stamp is None:
        return None
    current = now or datetime.now()
    return int((current - stamp).total_seconds() // 60)


def _result_from_snapshot(
    snapshot: Snapshot,
    *,
    mode: str,
    reason: str = "",
    code: str = "",
    nxt: str = "",
    missing: Sequence[str] = (),
) -> RecoveryResult:
    fields = snapshot.fields
    return RecoveryResult(
        mode=mode,
        reason=reason,
        status=str(fields.get("status", "")),
        phase=str(fields.get("phase", "")),
        loop=int(fields.get("loop", 0) or 0),
        level=int(fields.get("level", 0) or 0),
        current_step=str(fields.get("current_step", "")),
        completed=list(fields.get("completed", []) or []),
        pending=list(fields.get("pending", []) or []),
        rev=snapshot.rev,
        quality=snapshot.quality,
        code=code,
        next=nxt or (vc_codes.next_action(code) if code else ""),
        missing=list(missing),
        fields=dict(fields),
    )


def _load_checkpoint_impl(
    store: CheckpointStore,
    *,
    expected_age_minutes: int = DEFAULT_MAX_AGE_MINUTES,
    verify_pending_items: bool = True,
    plan_text: str | None = None,
    exec_results: Mapping[str, bool] | None = None,
    ephemeral_index: Iterable[str] | None = None,
    now: datetime | None = None,
) -> RecoveryResult:
    try:
        text = store.read_text()
    except CorruptCheckpoint as exc:
        archived = store.archive_state("corrupt")
        if archived is not None:
            store.clear()
        return RecoveryResult(
            mode="fresh_start" if archived else "reference_only",
            reason=(
                f"corrupt（已隔离为 {archived or '（隔离失败，条目保留）'}）: {exc}"
            ),
            code=vc_codes.CHECKPOINT_CORRUPT,
        )
    if text is None:
        return RecoveryResult(mode="fresh_start", reason="no_checkpoint")

    try:
        raw = parse_subset(text)
        quality = ParseQuality.STRICT
    except SubsetParseError:
        raw = scan_flat_scalars(text)
        if raw is None:
            archived = store.archive_state("corrupt")
            if archived is not None:
                store.clear()
            return RecoveryResult(
                mode="fresh_start" if archived else "reference_only",
                reason=f"corrupt（已隔离为 {archived or '（隔离失败，条目保留）'}）",
                code=vc_codes.CHECKPOINT_CORRUPT,
            )
        quality = ParseQuality.DEGRADED

    from .checkpoint import normalize_fields

    snapshot = Snapshot(fields=normalize_fields(raw), raw=raw, quality=quality, exists=True)

    # schema 非法/超前 → 只读
    schema = raw.get("_schema", STATE_SCHEMA_VERSION)
    if isinstance(schema, bool) or not isinstance(schema, int) or schema < 1:
        return _with_artifact_checks(
            _result_from_snapshot(
                snapshot,
                mode="reference_only",
                reason=f"_schema 非法: {schema!r}（必须是 ≥1 的整数）",
                code=vc_codes.CHECKPOINT_CORRUPT,
            ),
            store,
            ephemeral_index,
        )
    schema_int = schema
    if schema_int > STATE_SCHEMA_VERSION:
        result = _result_from_snapshot(
            snapshot,
            mode="reference_only",
            reason=f"_schema={schema_int} 高于支持版本 {STATE_SCHEMA_VERSION}",
            code=vc_codes.CHECKPOINT_SCHEMA_AHEAD,
        )
        return _with_artifact_checks(result, store, ephemeral_index)

    # 项目身份
    owner = str(raw.get("_project_id", "") or "")
    if owner and owner != store.resolved.project_id:
        return RecoveryResult(
            mode="reference_only",
            reason="_project_id 与当前项目不匹配（Checkpoint key 以项目绝对地址为唯一 ID，不覆盖）",
            code=vc_codes.CHECKPOINT_FOREIGN,
        )

    if quality is ParseQuality.DEGRADED:
        if not snapshot.numeric_valid:
            return _with_artifact_checks(
                _result_from_snapshot(
                    snapshot,
                    mode="reference_only",
                    reason=f"loop/level 越界: loop={raw.get('loop')!r} level={raw.get('level')!r}",
                    code=vc_codes.CHECKPOINT_DEGRADED,
                ),
                store,
                ephemeral_index,
            )
        if not snapshot.phase_valid:
            result = _result_from_snapshot(
                snapshot,
                mode="reference_only",
                reason=f"降级解析 phase 非法: {raw.get('phase')!r}",
                code=vc_codes.CHECKPOINT_DEGRADED,
            )
            return _with_artifact_checks(result, store, ephemeral_index)
        result = _result_from_snapshot(
            snapshot,
            mode="resume_degraded",
            reason="子集解析失败，仅恢复 phase/loop/level；列表字段需重新核验",
            code=vc_codes.CHECKPOINT_DEGRADED,
        )
        # 列表字段全部转 pending，交 LLM 重新核验（不猜测已完成）
        carry = [str(x) for x in (result.completed + result.pending)]
        result = RecoveryResult(
            **{
                **_as_kwargs(result),
                "completed": [],
                "pending": carry,
                "pending_checks": [
                    PendingCheck(item=item, state="still_pending", evidence=["降级恢复：列表字段不可信"])
                    for item in carry
                ],
            }
        )
        return _with_artifact_checks(result, store, ephemeral_index)

    if not snapshot.numeric_valid:
        return _with_artifact_checks(
            _result_from_snapshot(
                snapshot,
                mode="reference_only",
                reason=f"loop/level 越界: loop={raw.get('loop')!r} level={raw.get('level')!r}",
                code=vc_codes.CHECKPOINT_DEGRADED,
            ),
            store,
            ephemeral_index,
        )
    if not snapshot.phase_valid:
        return _with_artifact_checks(
            _result_from_snapshot(
                snapshot,
                mode="reference_only",
                reason=f"phase 非法: {raw.get('phase')!r}",
                code=vc_codes.CHECKPOINT_DEGRADED,
            ),
            store,
            ephemeral_index,
        )

    # 字段完整性（12 项，updated_at 单列 freshness）
    missing = [name for name in REQUIRED_FIELDS if name not in raw]
    if missing:
        result = _result_from_snapshot(
            snapshot,
            mode="reference_only",
            reason="缺必需字段: " + ", ".join(missing),
            code=vc_codes.CHECKPOINT_DEGRADED,
            missing=missing,
        )
        return _with_artifact_checks(result, store, ephemeral_index)

    status = str(raw.get("status", ""))
    if status == "complete":
        return _with_artifact_checks(
            _result_from_snapshot(
                snapshot,
                mode="reference_only",
                reason="status=complete：任务已结束，不恢复",
            ),
            store,
            ephemeral_index,
        )
    if status not in ("active", "paused"):
        return _with_artifact_checks(
            _result_from_snapshot(
                snapshot,
                mode="reference_only",
                reason=f"未知 status={status!r}",
                code=vc_codes.CHECKPOINT_DEGRADED,
            ),
            store,
            ephemeral_index,
        )

    age = age_minutes(raw.get("updated_at"), now=now)
    if age is None:
        return _with_artifact_checks(
            _result_from_snapshot(
                snapshot,
                mode="reference_only",
                reason="updated_at 缺失或不可解析",
                code=vc_codes.CHECKPOINT_DEGRADED,
            ),
            store,
            ephemeral_index,
        )

    round_started_at = ""
    review = raw.get("review")
    if isinstance(review, dict):
        failure_state = review.get("failure_state")
        if isinstance(failure_state, dict):
            round_started_at = str(failure_state.get("round_started_at", "") or "")

    result = _result_from_snapshot(
        snapshot,
        mode="resume_stale" if age > expected_age_minutes else "resume",
        reason=f"stale: {age} 分钟 > {expected_age_minutes}" if age > expected_age_minutes else f"fresh: {age} 分钟",
        code=vc_codes.CHECKPOINT_STALE if age > expected_age_minutes else "",
    )

    if verify_pending_items and result.pending:
        checks = verify_pending(
            result.pending,
            project_root=store.resolved.project_root,
            round_started_at=round_started_at,
            exec_results=exec_results,
            plan_text=plan_text,
            now=now,
        )
        result = RecoveryResult(**{**_as_kwargs(result), "pending_checks": checks})

    return _with_artifact_checks(result, store, ephemeral_index)


def _as_kwargs(result: RecoveryResult) -> dict[str, Any]:
    return {
        "mode": result.mode,
        "reason": result.reason,
        "status": result.status,
        "phase": result.phase,
        "loop": result.loop,
        "level": result.level,
        "current_step": result.current_step,
        "completed": result.completed,
        "pending": result.pending,
        "rev": result.rev,
        "quality": result.quality,
        "code": result.code,
        "next": result.next,
        "missing": result.missing,
        "artifact_missing": result.artifact_missing,
        "artifact_unverified": result.artifact_unverified,
        "pending_checks": result.pending_checks,
        "fields": result.fields,
        "legacy_import": result.legacy_import,
    }


def _with_artifact_checks(
    result: RecoveryResult,
    store: CheckpointStore,
    ephemeral_index: Iterable[str] | None,
) -> RecoveryResult:
    artifacts = ArtifactStore(store.resolved.artifacts_dir, ephemeral_index=ephemeral_index)
    checks = artifacts.validate_all(result.fields or {})
    missing = [check.to_dict() for check in checks if check.missing]
    unverified = [check.to_dict() for check in checks if check.ok is None]
    if not missing and not unverified:
        return result
    return RecoveryResult(
        **{
            **_as_kwargs(result),
            "artifact_missing": missing,
            "artifact_unverified": unverified,
        }
    )


# ---------------------------------------------------------------------------
# pending 三态核验
# ---------------------------------------------------------------------------
def _extract_paths(item: str) -> list[str]:
    seen: set[str] = set()
    paths: list[str] = []
    for match in _EXPLICIT_PATH_RE.finditer(item):
        candidate = match.group(1)
        if candidate not in seen:
            seen.add(candidate)
            paths.append(candidate)
    for match in _PATH_RE.finditer(item):
        candidate = match.group(1)
        if candidate not in seen:
            seen.add(candidate)
            paths.append(candidate)
    return paths[:MAX_PATHS_PER_ITEM]


def _git_commit_after(path: Path, project_root: Path, since: datetime | None) -> str | None:
    if since is None or not (project_root / ".git").exists():
        return None
    from .checkpoint import resolve_git_bin

    git_bin = resolve_git_bin(project_root)
    if git_bin is None:
        return None
    try:
        rel = os.path.relpath(path, project_root)
    except ValueError:
        return None
    try:
        proc = subprocess.run(
            [
                git_bin,
                *GIT_SAFE_ARGS,
                "-C",
                str(project_root),
                "log",
                "-1",
                "--no-show-signature",
                "--format=%ct",
                "--",
                rel,
            ],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=10,
            env=_git_env(),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    stamp = proc.stdout.strip()
    if not stamp.isdigit():
        return None
    try:
        threshold = int(since.timestamp())
    except (OverflowError, OSError, ValueError):
        return None
    return stamp if int(stamp) > threshold else None


def _hash_limited(path: Path, limit: int) -> tuple[str | None, int]:
    hasher = hashlib.sha256()
    total = 0
    with open(path, "rb") as handle:
        while total < limit:
            chunk = handle.read(min(1024 * 1024, limit - total))
            if not chunk:
                break
            total += len(chunk)
            hasher.update(chunk)
    if total != limit:
        return None, total
    return hasher.hexdigest(), total


def verify_pending(
    pending: Sequence[Any],
    *,
    project_root: Path,
    round_started_at: str | datetime = "",
    exec_results: Mapping[str, bool] | None = None,
    plan_text: str | None = None,
    now: datetime | None = None,
) -> list[PendingCheck]:
    """三态核验：只有强证据才允许 ``move_to_completed=True``。"""
    since: datetime | None
    if isinstance(round_started_at, datetime):
        since = round_started_at
    else:
        since = parse_minute(round_started_at)
    exec_results = exec_results or {}
    checks: list[PendingCheck] = []
    items = list(pending)
    if len(items) > MAX_PENDING_ITEMS:
        checks.append(
            PendingCheck(
                item=f"<truncated {len(items) - MAX_PENDING_ITEMS} items>",
                state="still_pending",
                evidence=["pending 条目超过预算，需人工确认"],
                move_to_completed=False,
            )
        )
        items = items[:MAX_PENDING_ITEMS]
    git_budget = MAX_GIT_CALLS
    hash_files = MAX_HASH_FILES
    hash_bytes = MAX_HASH_BYTES
    hashed_paths: set[str] = set()

    for raw_item in items:
        item = str(raw_item)
        evidence: list[str] = []
        verified = False
        weak = False
        if len(item) > 2000:
            checks.append(
                PendingCheck(
                    item=item[:200],
                    state="still_pending",
                    evidence=["pending 项过长，需人工确认"],
                    move_to_completed=False,
                )
            )
            continue
        negated = any(term.lower() in item.lower() for term in _PENDING_NEGATIONS)
        paths = _extract_paths(item)
        existing: list[Path] = []
        root = Path(os.path.realpath(str(project_root)))
        for token in paths:
            from .checkpoint import CheckpointLocationError, expand_home

            try:
                raw = expand_home(token)
            except (CheckpointLocationError, OSError, RuntimeError):
                evidence.append(f"path invalid: {token}")
                continue
            if raw.is_absolute():
                evidence.append(f"path outside project_root ignored: {token}")
                continue
            try:
                candidate = (root / raw).resolve()
            except (OSError, ValueError):
                evidence.append(f"path invalid: {token}")
                continue
            if candidate != root and root not in candidate.parents:
                evidence.append(f"path outside project_root ignored: {token}")
                continue
            if candidate.exists():
                if candidate == root or candidate.is_dir():
                    evidence.append(f"directory is not completion evidence: {token}")
                    continue
                existing.append(candidate)
                evidence.append(f"path exists: {token}")
            else:
                evidence.append(f"path missing: {token}")

        sha_match = _SHA_RE.search(item)
        if sha_match and existing:
            expected = sha_match.group(1).lower()
            for path in existing:
                key = str(path)
                if key in hashed_paths:
                    evidence.append(f"sha256 skipped duplicate: {path.name}")
                    continue
                if hash_files <= 0 or hash_bytes <= 0:
                    evidence.append("sha256 budget exhausted")
                    continue
                try:
                    info = path.lstat()
                    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                        evidence.append(f"sha256 skipped non-regular: {path.name}")
                        continue
                    if info.st_size > 256 * 1024 * 1024:
                        evidence.append(f"sha256 skipped too large: {path.name}")
                        continue
                    if info.st_size > hash_bytes:
                        evidence.append("sha256 budget exhausted")
                        continue
                    limit = info.st_size
                    actual, consumed = _hash_limited(path, limit)
                    if actual is None:
                        evidence.append("sha256 budget exhausted")
                        continue
                    hash_files -= 1
                    hash_bytes -= consumed
                    hashed_paths.add(key)
                except (OSError, RuntimeError):
                    continue
                if actual == expected:
                    verified = True
                    evidence.append(f"sha256 match: {actual[:16]}…")
                    break
            if not verified:
                evidence.append("sha256 mismatch")

        if not verified and existing:
            for path in existing:
                if git_budget <= 0:
                    evidence.append("git verification budget exhausted")
                    break
                git_budget -= 1
                stamp = _git_commit_after(path, root, since)
                if stamp:
                    verified = True
                    evidence.append(f"git commit after round start: {stamp}")
                    break

        if not verified:
            for match in _CMD_RE.finditer(item):
                command = match.group(1).strip()
                if exec_results.get(command) is True:
                    verified = True
                    evidence.append(f"exec ok: {command}")
                    break

        if not verified and existing:
            weak = True
            if since is not None:
                for path in existing:
                    try:
                        mtime = datetime.fromtimestamp(path.stat().st_mtime)
                    except OSError:
                        continue
                    if mtime > since:
                        evidence.append(f"mtime newer than round start: {path.name}")
                    else:
                        evidence.append(f"mtime not newer: {path.name}")
            evidence.append("weak evidence only: 文件存在 ≠ 任务完成")

        if negated:
            verified = False
            weak = False
            evidence.append("pending 文本含否定/未完成语义，不自动完成")

        if verified:
            state = "verified"
        elif weak:
            state = "unverified"
        else:
            state = "still_pending"
            if not paths:
                evidence.append("无可解析线索，需人工确认")
        checks.append(
            PendingCheck(
                item=item,
                state=state,
                evidence=evidence,
                move_to_completed=(state == "verified"),
            )
        )
    return checks


def load_checkpoint(
    store: CheckpointStore,
    *,
    expected_age_minutes: int = DEFAULT_MAX_AGE_MINUTES,
    verify_pending_items: bool = True,
    plan_text: str | None = None,
    exec_results: Mapping[str, bool] | None = None,
    ephemeral_index: Iterable[str] | None = None,
    now: datetime | None = None,
) -> RecoveryResult:
    """公开入口：先尝试旧路径只读导入，再机械执行恢复协议。"""
    from dataclasses import replace

    legacy = store.maybe_import_legacy()
    result = _load_checkpoint_impl(
        store,
        expected_age_minutes=expected_age_minutes,
        verify_pending_items=verify_pending_items,
        plan_text=plan_text,
        exec_results=exec_results,
        ephemeral_index=ephemeral_index,
        now=now,
    )
    if legacy and result.legacy_import is None:
        result = replace(result, legacy_import=legacy)
    return result
