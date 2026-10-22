"""Checkpoint（delx-memory 记忆条目）定位、解析与并发版本控制。

事实源：
- skills/vibe-coder-loop/engine/state-machine.md「Workflow Checkpoint（delx-memory）」
- delx-memory-protocol skill `protocol.md`

关键约束：
- **项目目录不再创建任何状态文件**。状态以记忆条目承载：
  key = ``vc:checkpoint:<项目绝对地址>``（realpath 即唯一 ID），
  固定 tags = ``vc-checkpoint`` / ``L0`` / ``scope:project``。
- 13 语义字段 + 保留键（``_schema`` / ``_rev`` / ``_project_id`` / ``_resume_from``）。
- 并发：写路径使用 SQLite ``BEGIN IMMEDIATE`` 事务；``expected_rev`` 不匹配 →
  ``STATE_REV_CONFLICT``，不落盘。
- 旧版 ``<project_root>/.vibe-kernel/.state.md`` 仅作**只读导入**来源，导入后不改名、不删除。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

from . import vc_codes
from .memory_store import (
    CHECKPOINT_KEY_PREFIX,
    CHECKPOINT_LAYER,
    CHECKPOINT_QUARANTINE_PREFIX,
    CHECKPOINT_TITLE,
    MemoryEntry,
    MemoryStore,
    MemoryStoreError,
    _MemoryTransaction,
    checkpoint_key,
    default_db_path,
)
from .state_parse import (
    ParseQuality,
    SubsetParseError,
    parse_subset,
    render_subset,
    scan_flat_scalars,
)

STATE_SCHEMA_VERSION = 1
VALID_STATE_CODES = frozenset(f"S{i}" for i in range(15))
MAX_STATE_BYTES = 4 * 1024 * 1024
STATE_FILENAME = ".state.md"
STATE_DIRNAME = ".vibe-kernel"  # 仅用于旧版状态只读导入

_PROJECT_MARKERS = (".git", STATE_DIRNAME, "pyproject.toml", "package.json", "go.mod")
GIT_SAFE_ARGS = (
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "log.showSignature=false",
    "-c",
    "gpg.program=/bin/false",
    "-c",
    "core.pager=cat",
)

# 13 个语义字段（顺序即渲染顺序）
SEMANTIC_FIELDS = (
    "status",
    "updated_at",
    "phase",
    "loop",
    "level",
    "goal",
    "current_step",
    "completed",
    "pending",
    "decisions",
    "review",
    "user_decisions",
    "resume",
)
# freshness 字段单列，因此完整性校验要求其余 12 项
REQUIRED_FIELDS = tuple(f for f in SEMANTIC_FIELDS if f != "updated_at")
RESERVED_KEYS = ("_schema", "_rev", "_project_id", "_resume_from")

_TOP_LEVEL_ORDER = (
    "_schema",
    "_rev",
    "_project_id",
    "_resume_from",
    *SEMANTIC_FIELDS,
)
_APPEND_KEYS = frozenset({"completed", "decisions", "user_decisions"})
_REPLACE_KEYS = frozenset({"pending"})

_TIME_FMT = "%Y-%m-%d %H:%M"


class CheckpointError(RuntimeError):
    code = vc_codes.CHECKPOINT_WRITE_FAILED


def expand_home(value: str | os.PathLike[str]) -> Path:
    try:
        return Path(value).expanduser()
    except (RuntimeError, KeyError) as exc:
        raise CheckpointLocationError(f"无法展开路径 {value!r}: {exc}") from exc


class CheckpointLocationError(CheckpointError):
    code = vc_codes.CHECKPOINT_LOCATION_UNRESOLVED


class CorruptCheckpoint(CheckpointError):
    code = vc_codes.CHECKPOINT_CORRUPT


class LockTimeout(CheckpointError):
    code = vc_codes.CHECKPOINT_WRITE_FAILED


# ---------------------------------------------------------------------------
# 字段工具
# ---------------------------------------------------------------------------
def now_to_minute() -> str:
    return datetime.now().strftime(_TIME_FMT)


def parse_minute(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    for fmt in (_TIME_FMT, "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    return None


def default_fields() -> dict[str, Any]:
    return {
        "_schema": STATE_SCHEMA_VERSION,
        "_rev": 0,
        "_project_id": "",
        "status": "paused",
        "updated_at": "",
        "phase": "S0 Idle",
        "loop": 0,
        "level": 0,
        "goal": {"explicit": "", "constraints": [], "risk": []},
        "current_step": "",
        "completed": [],
        "pending": [],
        "decisions": [],
        "review": {
            "result": "none",
            "last_review": "none",
            "last_failure": "none",
            "issues": [],
        },
        "user_decisions": [],
        "resume": "",
    }


def normalize_fields(raw: Mapping[str, Any]) -> dict[str, Any]:
    """补齐缺失语义字段（缺失即缺省），原样保留未知键。"""
    out: dict[str, Any] = dict(raw)
    defaults = default_fields()
    for key, value in defaults.items():
        if key == "_rev":
            if not isinstance(out.get(key), int):
                out[key] = 0
            continue
        if key == "_schema":
            out.setdefault(key, STATE_SCHEMA_VERSION)
            continue
        if key == "_project_id":
            out.setdefault(key, "")
            continue
        if key not in out or out[key] is None:
            out[key] = _clone(value)
            continue
        if key == "loop" or key == "level":
            try:
                out[key] = int(out[key])
            except (TypeError, ValueError, OverflowError):
                out[key] = 0
        elif key in ("completed", "pending", "decisions", "user_decisions"):
            if not isinstance(out[key], list):
                out[key] = []
        elif key in ("goal", "review"):
            if not isinstance(out[key], dict):
                out[key] = _clone(value)
            else:
                merged = _clone(value)
                merged.update(out[key])
                out[key] = merged
        elif key in ("status", "phase", "current_step", "resume", "updated_at"):
            out[key] = str(out[key])
    if not out.get("_project_id"):
        out.setdefault("_project_id", "")
    return _order_fields(out)


def _clone(value: Any) -> Any:
    return json.loads(json.dumps(value))


def _order_fields(fields: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in _TOP_LEVEL_ORDER:
        if key in fields:
            out[key] = fields[key]
    for key, value in fields.items():
        if key not in out:
            out[key] = value
    return out


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def state_code(phase: Any) -> str:
    """从 ``S1 Intent`` / ``S1`` 提取状态码，无法识别返回 ``""``。"""
    if not isinstance(phase, str):
        return ""
    m = re.match(r"^\s*(S\d{1,2})\b", phase)
    return m.group(1) if m else ""


def project_id_for(project_root: Path) -> str:
    real = os.path.realpath(str(project_root))
    return hashlib.sha256(real.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# 定位
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ResolvedState:
    cwd: Path
    project_root: Path
    project_id: str
    memory_key: str
    memory_db: Path
    artifacts_dir: Path
    legacy_state_path: Path
    source: str

    @property
    def location(self) -> str:
        return self.memory_key

    def as_dict(self) -> dict[str, Any]:
        return {
            "cwd": str(self.cwd),
            "project_root": str(self.project_root),
            "project_id": self.project_id,
            "memory_key": self.memory_key,
            "memory_db": str(self.memory_db),
            "artifacts_dir": str(self.artifacts_dir),
            "legacy_state_path": str(self.legacy_state_path),
            "source": self.source,
        }


def _norm_path(path: Path | str) -> str:
    text = os.path.normcase(str(path))
    if os.name == "nt" or sys.platform == "darwin":
        text = text.casefold()
    return text


def find_project_root(cwd: Path) -> Path:
    """最近 .git 优先（worktree/子模块各自隔离）；无 .git 时取最高非 git 标记。"""
    git_hits: list[Path] = []
    other_hits: list[Path] = []
    cur = cwd
    while True:
        if (cur / ".git").exists():
            git_hits.append(cur)
        elif any((cur / marker).exists() for marker in _PROJECT_MARKERS if marker != ".git"):
            other_hits.append(cur)
        if cur.parent == cur:
            break
        cur = cur.parent
    if git_hits:
        return git_hits[0]  # 最近 .git
    return other_hits[-1] if other_hits else cwd


def default_artifacts_dir(project_id: str, env: Mapping[str, str] | None = None) -> Path:
    """pinned artifact 落用户缓存目录（项目目录不再创建运行态文件）。"""
    env_map = os.environ if env is None else env
    explicit = env_map.get("VIBE_KERNEL_ARTIFACTS_DIR")
    if explicit:
        return Path(explicit).expanduser()
    home = env_map.get("HOME") or str(Path.home())
    return Path(home) / ".vibe-loop" / "artifacts" / project_id / "pinned"


class StateResolver:
    """解析 Checkpoint 的记忆条目位置。

    项目绝对地址（realpath）即唯一 ID：``vc:checkpoint:<realpath>``。
    ``memory_key`` / ``memory_db`` 仅作测试与运维显式覆盖，默认值由协议推导。
    """

    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        self.env = dict(os.environ if env is None else env)

    def resolve(
        self,
        cwd: str | os.PathLike[str],
        *,
        memory_key: str | None = None,
        memory_db: str | os.PathLike[str] | None = None,
    ) -> ResolvedState:
        if any("\x00" in str(value) for value in (cwd, memory_key or "", memory_db or "")):
            raise CheckpointLocationError("路径含 NUL 字符，拒绝使用")
        cwd_path = expand_home(cwd)
        try:
            cwd_real = Path(os.path.realpath(str(cwd_path)))
        except OSError as exc:
            raise CheckpointLocationError(f"cwd 无法解析: {cwd_path}") from exc
        if not cwd_real.exists() or not cwd_real.is_dir():
            raise CheckpointLocationError(f"cwd 不存在或不是目录: {cwd_real}")

        project_root = find_project_root(cwd_real)
        project_id = project_id_for(project_root)

        explicit_key = memory_key or self.env.get("VIBE_KERNEL_CHECKPOINT_KEY")
        key = explicit_key or checkpoint_key(project_root)
        if not isinstance(key, str) or not key:
            raise CheckpointLocationError("Checkpoint key 不能为空")
        if not key.startswith(CHECKPOINT_KEY_PREFIX):
            raise CheckpointLocationError(
                f"Checkpoint key 必须以 {CHECKPOINT_KEY_PREFIX!r} 开头: {key!r}"
            )
        if len(key) > 512:
            raise CheckpointLocationError("Checkpoint key 超过 512 字符")
        source = "memory_key" if explicit_key else "default"

        raw_db = memory_db or self.env.get("DELX_MEMORY_DB")
        db_path = Path(raw_db).expanduser() if raw_db else default_db_path(self.env)
        try:
            db_path = Path(os.path.realpath(str(db_path)))
        except OSError as exc:
            raise CheckpointLocationError(f"记忆库路径无法解析: {db_path}") from exc
        if db_path.exists() and db_path.is_dir():
            raise CheckpointLocationError(f"记忆库路径是目录，拒绝使用: {db_path}")

        return ResolvedState(
            cwd=cwd_real,
            project_root=project_root,
            project_id=project_id,
            memory_key=key,
            memory_db=db_path,
            artifacts_dir=default_artifacts_dir(project_id, self.env),
            legacy_state_path=project_root / STATE_DIRNAME / STATE_FILENAME,
            source=source,
        )


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Snapshot:
    fields: dict[str, Any]
    raw: dict[str, Any]
    quality: ParseQuality
    exists: bool

    @property
    def rev(self) -> int:
        value = self.fields.get("_rev", 0)
        return value if type(value) is int and value >= 0 else 0

    @property
    def missing_required(self) -> list[str]:
        return [f for f in REQUIRED_FIELDS if f not in self.raw]

    @property
    def schema(self) -> int:
        try:
            return int(self.raw.get("_schema", STATE_SCHEMA_VERSION))
        except (TypeError, ValueError, OverflowError):
            return -1

    @property
    def schema_invalid(self) -> bool:
        if "_schema" not in self.raw:
            return False
        value = self.raw.get("_schema")
        if isinstance(value, bool) or not isinstance(value, int):
            return True
        return value < 1

    @property
    def schema_ahead(self) -> bool:
        return self.schema > STATE_SCHEMA_VERSION

    @property
    def owner(self) -> str:
        return str(self.raw.get("_project_id", "") or "")

    @property
    def rev_valid(self) -> bool:
        if "_rev" not in self.raw:
            return True
        value = self.raw.get("_rev")
        return type(value) is int and value >= 0

    @property
    def numeric_valid(self) -> bool:
        def _pick(key: str) -> Any:
            if key in self.raw:
                return self.raw.get(key)
            return self.fields.get(key, 0)

        loop = _pick("loop")
        level = _pick("level")
        if isinstance(loop, bool) or not isinstance(loop, int) or loop < 0:
            return False
        if isinstance(level, bool) or not isinstance(level, int) or not 0 <= level <= 4:
            return False
        return True

    @property
    def phase_valid(self) -> bool:
        if "phase" in self.raw:
            raw_phase = self.raw.get("phase")
            return isinstance(raw_phase, str) and state_code(raw_phase) in VALID_STATE_CODES
        return state_code(self.fields.get("phase")) in VALID_STATE_CODES


@dataclass(frozen=True)
class WriteResult:
    ok: bool
    rev: int = 0
    changed: bool = False
    code: str = ""
    message: str = ""
    next: str = ""
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"ok": self.ok, "rev": self.rev, "changed": self.changed}
        if self.code:
            data.update(make_error_dict(self.code, self.message, self.next))
        if self.warnings:
            data["warnings"] = list(self.warnings)
        return data


def make_error_dict(code: str, fact: str, action: str = "") -> dict[str, Any]:
    vc = vc_codes.make_code(code, fact, action=action or None)
    return vc.to_dict()


def _git_env() -> dict[str, str]:
    allow = {"PATH", "HOME", "LANG", "LC_ALL", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP"}
    return {key: value for key, value in os.environ.items() if key in allow}


def resolve_git_bin(project_root: Path) -> str | None:
    import shutil

    found = shutil.which("git")
    if not found:
        return None
    try:
        root = Path(project_root).resolve()
        lexical = Path(os.path.abspath(found))
        resolved = lexical.resolve()
        parent = lexical.parent.resolve()
        for candidate in (parent, resolved):
            if candidate == root or root in candidate.parents:
                return None
    except (OSError, ValueError):
        return None
    return str(Path(os.path.abspath(found)))


class CheckpointStore:
    """Checkpoint 逻辑（字段/校验/合并）与 delx-memory 持久化的唯一桥接层。"""

    def __init__(
        self,
        resolved: ResolvedState,
        *,
        import_legacy: bool = True,
        env: Mapping[str, str] | None = None,
        memory: MemoryStore | None = None,
    ) -> None:
        self.resolved = resolved
        self.import_legacy = import_legacy
        self.env = dict(os.environ if env is None else env)
        self.memory = memory or MemoryStore(resolved.memory_db)

    # -- 位置 ------------------------------------------------------------
    @property
    def memory_key(self) -> str:
        return self.resolved.memory_key

    @property
    def location(self) -> str:
        return self.resolved.memory_key

    @property
    def artifacts_dir(self) -> Path:
        return self.resolved.artifacts_dir

    def metadata(self) -> dict[str, Any]:
        return {
            "title": CHECKPOINT_TITLE,
            "layer": CHECKPOINT_LAYER,
            "memory_category": "state",
            "status": "active",
            "scope": "project",
            "project_root": str(self.resolved.project_root),
            "project_id": self.resolved.project_id,
        }

    # -- 读取 ------------------------------------------------------------
    def _entry(self, *, include_expired: bool = False) -> MemoryEntry | None:
        try:
            return self.memory.get(self.memory_key, include_expired=include_expired)
        except MemoryStoreError as exc:
            raise CheckpointError(f"读取 Checkpoint 记忆失败: {exc}") from exc

    def read_text(self) -> str | None:
        entry = self._entry()
        if entry is None:
            return None
        if len(entry.value.encode("utf-8")) > MAX_STATE_BYTES:
            raise CorruptCheckpoint(f"Checkpoint 条目超过 {MAX_STATE_BYTES} 字节上限")
        return entry.value

    def load_raw(self) -> tuple[dict[str, Any], ParseQuality]:
        text = self.read_text()
        if text is None:
            return {}, ParseQuality.CORRUPT
        try:
            return parse_subset(text), ParseQuality.STRICT
        except SubsetParseError:
            flat = scan_flat_scalars(text)
            if flat is None:
                raise CorruptCheckpoint("Checkpoint 条目不可解析")
            return flat, ParseQuality.DEGRADED

    def _snapshot_from_entry(self, entry: MemoryEntry | None) -> Snapshot:
        if entry is None:
            return Snapshot(
                fields=normalize_fields({}),
                raw={},
                quality=ParseQuality.CORRUPT,
                exists=False,
            )
        if len(entry.value.encode("utf-8")) > MAX_STATE_BYTES:
            return Snapshot(
                fields=normalize_fields({}),
                raw={},
                quality=ParseQuality.CORRUPT,
                exists=True,
            )
        try:
            raw = parse_subset(entry.value)
            quality = ParseQuality.STRICT
        except SubsetParseError:
            flat = scan_flat_scalars(entry.value)
            if flat is None:
                return Snapshot(
                    fields=normalize_fields({}),
                    raw={},
                    quality=ParseQuality.CORRUPT,
                    exists=True,
                )
            raw, quality = flat, ParseQuality.DEGRADED
        return Snapshot(fields=normalize_fields(raw), raw=raw, quality=quality, exists=True)

    def snapshot(self) -> Snapshot:
        text = self.read_text()
        if text is None:
            return Snapshot(
                fields=normalize_fields({}),
                raw={},
                quality=ParseQuality.CORRUPT,
                exists=False,
            )
        return self._snapshot_from_entry(MemoryEntry(key=self.memory_key, value=text))

    def _read_unlocked(self) -> Snapshot:
        return self._snapshot_from_entry(self._entry())

    # -- 写入 ------------------------------------------------------------
    def write(
        self,
        fields: Mapping[str, Any],
        *,
        expected_rev: int | None = None,
        replace_keys: Iterable[str] = (),
        archive_kind: str | None = None,
    ) -> WriteResult:
        replace = set(replace_keys) | {k for k in _REPLACE_KEYS if k in fields}
        try:
            with self.memory.transaction() as tx:
                entry = tx.get(self.memory_key)
                current = self._snapshot_from_entry(entry)
                warnings: list[str] = []
                if current.exists and current.quality is ParseQuality.CORRUPT:
                    archived = None
                    if entry is not None:
                        archived = self._copy_to_archive(entry, "corrupt", tx=tx)
                    if entry is not None and archived is None:
                        return WriteResult(
                            ok=False,
                            rev=current.rev,
                            code=vc_codes.CHECKPOINT_WRITE_FAILED,
                            message="Checkpoint 条目损坏且隔离失败，拒绝覆盖",
                            next=vc_codes.next_action(vc_codes.CHECKPOINT_WRITE_FAILED),
                        )
                    tx.delete(self.memory_key)
                    warnings.append("corrupt_quarantined")
                    current = Snapshot(
                        fields=normalize_fields({}),
                        raw={},
                        quality=ParseQuality.CORRUPT,
                        exists=False,
                    )
                if current.exists and current.schema_invalid:
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.CHECKPOINT_CORRUPT,
                        message="_schema 不是整数，拒绝写入",
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_CORRUPT),
                    )
                if current.exists and current.schema_ahead:
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.CHECKPOINT_SCHEMA_AHEAD,
                        message=f"_schema={current.schema} 高于支持版本 {STATE_SCHEMA_VERSION}（只读不写）",
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_SCHEMA_AHEAD),
                    )
                if expected_rev is not None and current.rev != expected_rev and not (
                    archive_kind
                    and current.exists
                    and str(current.fields.get("status", "")) == "complete"
                ):
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.STATE_REV_CONFLICT,
                        message=f"expected_rev={expected_rev} 与当前 _rev={current.rev} 不符",
                        next=vc_codes.next_action(vc_codes.STATE_REV_CONFLICT),
                    )
                if current.exists and not current.rev_valid:
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.CHECKPOINT_DEGRADED,
                        message=f"_rev 非法: {current.raw.get('_rev')!r}（必须是非负整数）",
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
                    )
                if current.exists and not current.numeric_valid:
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.CHECKPOINT_DEGRADED,
                        message=f"loop/level 越界: loop={current.fields.get('loop')!r} level={current.fields.get('level')!r}",
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
                    )
                if current.exists and current.missing_required:
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.CHECKPOINT_DEGRADED,
                        message="缺必需字段: " + ", ".join(current.missing_required),
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
                    )
                if current.exists and not current.phase_valid:
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.CHECKPOINT_DEGRADED,
                        message=f"phase 非法: {current.fields.get('phase')!r}，拒绝写入",
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
                    )
                if current.exists and current.quality is ParseQuality.DEGRADED:
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.CHECKPOINT_DEGRADED,
                        message="Checkpoint 条目仅降级可读，拒绝覆盖；请先重建完整状态",
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
                    )
                if current.exists and current.owner and current.owner != self.resolved.project_id:
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.CHECKPOINT_FOREIGN,
                        message="_project_id 与当前项目不符，拒绝写入",
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_FOREIGN),
                    )
                if archive_kind and current.exists and str(
                    current.fields.get("status", "")
                ) == "complete":
                    if entry is None or self._copy_to_archive(entry, archive_kind, tx=tx) is None:
                        return WriteResult(
                            ok=False,
                            rev=current.rev,
                            code=vc_codes.CHECKPOINT_WRITE_FAILED,
                            message="完成任务归档失败，拒绝覆盖旧状态",
                            next=vc_codes.next_action(vc_codes.CHECKPOINT_WRITE_FAILED),
                        )
                    current = Snapshot(
                        fields=normalize_fields({}),
                        raw={},
                        quality=ParseQuality.CORRUPT,
                        exists=False,
                    )
                merged = self._merge(current.fields, fields, replace)
                merged = normalize_fields(merged)
                try:
                    merged["_schema"] = int(merged.get("_schema") or STATE_SCHEMA_VERSION)
                except (TypeError, ValueError, OverflowError):
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.INVALID_ARGUMENT,
                        message=f"_schema 必须是整数: {merged.get('_schema')!r}",
                        next=vc_codes.next_action(vc_codes.INVALID_ARGUMENT),
                    )
                merged["_project_id"] = self.resolved.project_id

                if current.exists and _semantic_equal(current.fields, merged):
                    return WriteResult(
                        ok=True, rev=current.rev, changed=False, warnings=tuple(warnings)
                    )

                merged["_rev"] = current.rev + 1
                merged["updated_at"] = now_to_minute()
                merged = _order_fields(merged)
                payload = render_subset(merged, front_matter=True)
                if len(payload.encode("utf-8")) > MAX_STATE_BYTES:
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.INVALID_ARGUMENT,
                        message=f"状态超过 {MAX_STATE_BYTES} 字节上限，拒绝写入",
                        next=vc_codes.next_action(vc_codes.INVALID_ARGUMENT),
                    )
                try:
                    parse_subset(payload)
                except SubsetParseError as exc:
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.INVALID_ARGUMENT,
                        message=f"写入内容无法被严格解析，拒绝落盘: {exc}",
                        next=vc_codes.next_action(vc_codes.INVALID_ARGUMENT),
                    )
                tx.set(self.memory_key, payload, metadata=self.metadata())
                return WriteResult(
                    ok=True,
                    rev=int(merged["_rev"]),
                    changed=True,
                    warnings=tuple(warnings),
                )
        except MemoryStoreError as exc:
            return WriteResult(
                ok=False,
                code=vc_codes.CHECKPOINT_WRITE_FAILED,
                message=f"写入 Checkpoint 记忆失败: {exc}",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_WRITE_FAILED),
            )

    def _copy_to_archive(
        self,
        entry: MemoryEntry,
        kind: str,
        *,
        tx: "_MemoryTransaction | None" = None,
    ) -> str | None:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        key = f"{CHECKPOINT_QUARANTINE_PREFIX}{self.resolved.project_id}:{kind}:{ts}"
        metadata = {
            "title": f"{CHECKPOINT_TITLE} ({kind} archive)",
            "layer": CHECKPOINT_LAYER,
            "memory_category": "state",
            "status": "archived",
            "scope": "project",
            "project_root": str(self.resolved.project_root),
            "project_id": self.resolved.project_id,
            "archived_from": self.memory_key,
            "kind": kind,
        }
        try:
            if tx is not None:
                tx.set(key, entry.value, metadata=metadata, ttl_seconds=None)
            else:
                self.memory.set(key, entry.value, metadata=metadata, ttl_seconds=None)
            return key
        except MemoryStoreError:
            return None

    def archive_state(self, kind: str = "complete") -> str | None:
        entry = self._entry()
        if entry is None:
            return None
        return self._copy_to_archive(entry, kind)

    def clear(self) -> None:
        """清空主条目（调用方须先 archive_state 留下可回滚副本）。"""
        try:
            self.memory.delete(self.memory_key)
        except MemoryStoreError as exc:
            raise CheckpointError(f"清理 Checkpoint 条目失败: {exc}") from exc

    # -- 兼容：旧版项目状态文件只读导入 -------------------------------
    def maybe_import_legacy(self) -> dict[str, str] | None:
        if not self.import_legacy or self._entry() is not None:
            return None
        candidate = self.resolved.legacy_state_path
        try:
            info = os.lstat(candidate)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                return None
            if info.st_size > MAX_STATE_BYTES:
                return None
            text = candidate.read_bytes().decode("utf-8")
        except (OSError, UnicodeError):
            return None
        try:
            raw = parse_subset(text)
        except SubsetParseError:
            flat = scan_flat_scalars(text)
            if flat is None:
                return None
            raw = flat
        try:
            if int(raw.get("_schema", STATE_SCHEMA_VERSION)) > STATE_SCHEMA_VERSION:
                return None
        except (TypeError, ValueError, OverflowError):
            return None
        legacy_fields = dict(raw)
        legacy_fields.pop("_project_id", None)
        result = self.write(legacy_fields)
        if not result.ok:
            return None
        return {
            "from": str(candidate),
            "to": self.memory_key,
            "note": "旧状态文件保留为审计（未改名、未删除）",
        }

    def _merge(
        self,
        current: Mapping[str, Any],
        incoming: Mapping[str, Any],
        replace: set[str],
    ) -> dict[str, Any]:
        merged: dict[str, Any] = _clone(dict(current))
        for key, value in incoming.items():
            if key in ("_rev", "updated_at", "_project_id"):
                continue
            if key in replace:
                merged[key] = _clone(value)
                continue
            if key in _APPEND_KEYS and isinstance(value, list):
                old = merged.get(key)
                merged[key] = _union(old if isinstance(old, list) else [], value)
                continue
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key] = _merge_mapping(merged[key], value)
                continue
            merged[key] = _clone(value)
        return merged


def _semantic_equal(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    if str(a.get("_project_id", "") or "") != str(b.get("_project_id", "") or ""):
        return False
    for key in SEMANTIC_FIELDS:
        if key == "updated_at":
            continue
        if _canonical(a.get(key)) != _canonical(b.get(key)):
            return False
    known = set(_TOP_LEVEL_ORDER)
    for key in set(a) | set(b):
        if key in known:
            continue
        if _canonical(a.get(key)) != _canonical(b.get(key)):
            return False
    return True


def _merge_mapping(old: Mapping[str, Any], new: Mapping[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = _clone(dict(old))
    for key, value in new.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge_mapping(merged[key], value)
        else:
            merged[key] = _clone(value)
    return merged


def _union(old: list[Any], new: list[Any]) -> list[Any]:
    out = [_clone(item) for item in old]
    seen = {_canonical(item) for item in out}
    for item in new:
        key = _canonical(item)
        if key not in seen:
            seen.add(key)
            out.append(_clone(item))
    return out
