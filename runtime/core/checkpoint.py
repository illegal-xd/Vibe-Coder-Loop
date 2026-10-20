"""Checkpoint（``.state.md``）定位、解析、原子写入与并发版本控制。

事实源：
- skills/vibe-coder-loop/engine/state-machine.md「Workflow Checkpoint（.state.md）」
- docs/design/mvp-1-workflow-core.md §4 / §7

关键约束：
- 运行时状态属于项目，不属于 Skill 安装目录；落在 Skill 目录内 → fail-closed。
- 13 语义字段 + 保留键（``_schema`` / ``_rev`` / ``_project_id`` / ``_resume_from``）。
- 原子写：锁住读-改-写全程 → 临时文件 → flush + fsync → ``os.replace`` → fsync 目录。
- 乐观并发：``expected_rev`` 不匹配 → ``STATE_REV_CONFLICT``，不落盘。
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

from . import vc_codes
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
MAX_CONFIG_BYTES = 64 * 1024
STATE_FILENAME = ".state.md"
LOCK_FILENAME = ".state.lock"
STATE_DIRNAME = ".vibe-kernel"
CONFIG_FILENAME = "config.json"

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
_GIT_SAFE_ARGS = GIT_SAFE_ARGS

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
    state_path: Path
    state_dir: Path
    lock_path: Path
    artifacts_dir: Path
    project_id: str
    source: str
    allow_move: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {
            "cwd": str(self.cwd),
            "project_root": str(self.project_root),
            "state_path": str(self.state_path),
            "project_id": self.project_id,
            "source": self.source,
            "allow_move": self.allow_move,
        }


def _skill_dirs(env: Mapping[str, str] | None = None) -> list[Path]:
    env = env or os.environ
    out: list[Path] = []
    explicit = env.get("VIBE_KERNEL_SKILL_DIR")
    if explicit:
        out.append(Path(explicit))
    repo = Path(__file__).resolve().parents[2] / "skills" / "vibe-coder-loop"
    if (repo / "SKILL.md").exists():
        out.append(repo)
    home = env.get("HOME") or str(Path.home())
    if home:
        out.append(Path(home) / ".agents" / "skills" / "vibe-coder-loop")
        out.append(Path(home) / ".config" / "opencode" / "skills" / "vibe-coder-loop")
    resolved: list[Path] = []
    for path in out:
        with contextlib.suppress(OSError):
            if path.exists():
                resolved.append(Path(os.path.realpath(str(path))))
    return resolved


def _installed_skill_dirs(env: Mapping[str, str] | None = None) -> list[Path]:
    """只认“安装态” Skill 目录，避免把仓库开发目录的状态导进任意项目。"""
    env = env or os.environ
    out: list[Path] = []
    explicit = env.get("VIBE_KERNEL_SKILL_DIR")
    if explicit:
        out.append(Path(explicit))
    home = env.get("HOME") or str(Path.home())
    if home:
        out.append(Path(home) / ".agents" / "skills" / "vibe-coder-loop")
        out.append(Path(home) / ".config" / "opencode" / "skills" / "vibe-coder-loop")
    return [p for p in out if p.exists()]


def _norm_path(path: Path | str) -> str:
    text = os.path.normcase(str(path))
    if os.name == "nt" or sys.platform == "darwin":
        text = text.casefold()
    return text


def _is_within(path: Path, parent: Path) -> bool:
    try:
        parent_text = _norm_path(parent).rstrip(os.sep)
        path_text = _norm_path(path)
        return path_text == parent_text or path_text.startswith(parent_text + os.sep)
    except OSError:  # pragma: no cover
        return False


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


class StateResolver:
    """按协议顺序解析状态文件位置，并做对称保护（拒绝落在 Skill 目录）。"""

    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        self.env = dict(os.environ if env is None else env)

    def resolve(
        self,
        cwd: str | os.PathLike[str],
        *,
        state_dir: str | os.PathLike[str] | None = None,
        state_path: str | os.PathLike[str] | None = None,
    ) -> ResolvedState:
        if any("\x00" in str(value) for value in (cwd, state_dir or "", state_path or "")):
            raise CheckpointLocationError("路径含 NUL 字符，拒绝使用")
        cwd_path = expand_home(cwd)
        try:
            cwd_real = Path(os.path.realpath(str(cwd_path)))
        except OSError as exc:
            raise CheckpointLocationError(f"cwd 无法解析: {cwd_path}") from exc
        if not cwd_real.exists() or not cwd_real.is_dir():
            raise CheckpointLocationError(f"cwd 不存在或不是目录: {cwd_real}")

        project_root = find_project_root(cwd_real)

        explicit_path = state_path or self.env.get("VIBE_KERNEL_STATE_PATH")
        explicit_dir = state_dir or self.env.get("VIBE_KERNEL_STATE_DIR")
        source = "state_path" if explicit_path else ""

        config = project_root / STATE_DIRNAME / CONFIG_FILENAME
        config_data: dict[str, Any] = {}
        config_origin = False
        if not explicit_path and not explicit_dir and config.exists():
            try:
                config_data = json.loads(_read_small_text(config, MAX_CONFIG_BYTES, "config.json"))
                if not isinstance(config_data, dict):
                    config_data = {}
            except (OSError, ValueError, UnicodeError, RecursionError, json.JSONDecodeError):
                config_data = {}
            if isinstance(config_data.get("state_path"), str):
                explicit_path = config_data["state_path"]
                source = "config"
                config_origin = True
            elif isinstance(config_data.get("state_dir"), str):
                explicit_dir = config_data["state_dir"]
                source = "config"
                config_origin = True

        if config_origin:
            for raw in (explicit_path, explicit_dir):
                if not raw:
                    continue
                candidate = expand_home(raw)
                if candidate.is_absolute() or str(raw).startswith("~"):
                    raise CheckpointLocationError(
                        "config.json 的 state_path/state_dir 必须是项目根内的相对路径"
                    )

        if explicit_path:
            if "\x00" in str(explicit_path):
                raise CheckpointLocationError("state_path 含 NUL 字符，拒绝使用")
            path = expand_home(explicit_path)
            if not path.is_absolute():
                path = (project_root if config_origin else cwd_real) / path
            state_file = Path(os.path.realpath(str(path)))
            state_directory = state_file.parent
            source = source or "state_path"
        elif explicit_dir:
            if "\x00" in str(explicit_dir):
                raise CheckpointLocationError("state_dir 含 NUL 字符，拒绝使用")
            directory = expand_home(explicit_dir)
            if not directory.is_absolute():
                directory = (project_root if config_origin else cwd_real) / directory
            directory = Path(os.path.realpath(str(directory)))
            # 兼容把 --state-dir 指到文件的情况
            if directory.suffix == ".md":
                state_file = directory
                state_directory = directory.parent
            else:
                state_file = directory / STATE_FILENAME
                state_directory = directory
            source = source or "state_dir"
        else:
            raw_default = project_root / STATE_DIRNAME
            if raw_default.is_symlink():
                raise CheckpointLocationError("默认 .vibe-kernel 是软链，拒绝使用")
            if raw_default.exists() and not raw_default.is_dir():
                raise CheckpointLocationError("默认 .vibe-kernel 不是目录")
            state_directory = Path(os.path.realpath(str(raw_default)))
            state_file = state_directory / STATE_FILENAME
            source = "default"

        for skill_dir in _skill_dirs(self.env):
            if _is_within(state_directory, skill_dir) or _is_within(state_file, skill_dir):
                raise CheckpointLocationError(
                    f"状态路径落在 Skill 安装目录内，拒绝写入: {state_file}"
                )

        if config_origin and not _is_within(state_directory, project_root / STATE_DIRNAME):
            raise CheckpointLocationError(
                "config.json 的 state_path/state_dir 必须位于 .vibe-kernel/ 内"
            )

        return ResolvedState(
            cwd=cwd_real,
            project_root=project_root,
            state_path=state_file,
            state_dir=state_directory,
            lock_path=state_directory / LOCK_FILENAME,
            artifacts_dir=state_directory / "artifacts",
            project_id=project_id_for(project_root),
            source=source,
            allow_move=(
                _is_within(state_file, project_root / STATE_DIRNAME)
                and state_file.name == STATE_FILENAME
            ),
        )


# ---------------------------------------------------------------------------
# 锁
# ---------------------------------------------------------------------------
class _FileLock:
    """跨平台读写锁：POSIX flock / Windows msvcrt / O_EXCL 兜底。"""

    def __init__(self, path: Path, *, timeout: float = 5.0) -> None:
        self.path = path
        self.timeout = timeout
        self._fd: int | None = None
        self._fallback_path: Path | None = None
        self.mode = "none"

    def __enter__(self) -> "_FileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            import fcntl  # POSIX
        except ImportError:
            fcntl = None  # type: ignore[assignment]
        try:
            import msvcrt  # Windows
        except ImportError:
            msvcrt = None  # type: ignore[assignment]

        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        try:
            self._fd = os.open(str(self.path), flags, 0o600)
        except OSError as exc:
            raise LockTimeout(f"无法打开锁文件: {self.path} ({exc})") from exc
        try:
            info = os.fstat(self._fd)
            if not stat.S_ISREG(info.st_mode):
                os.close(self._fd)
                self._fd = None
                raise LockTimeout(f"锁文件不是普通文件: {self.path}")
        except OSError:
            pass
        deadline = time.monotonic() + self.timeout
        if fcntl is not None:
            self.mode = "flock"
            while True:
                try:
                    fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return self
                except OSError:
                    if time.monotonic() >= deadline:
                        os.close(self._fd)
                        self._fd = None
                        raise LockTimeout(f"加锁超时: {self.path}")
                    time.sleep(0.02)
        locking = getattr(msvcrt, "locking", None) if msvcrt is not None else None
        if locking is not None:  # pragma: no cover - CI 覆盖
            self.mode = "msvcrt"
            nb_lock = getattr(msvcrt, "LK_NBLCK", 2)
            while True:
                try:
                    os.lseek(self._fd, 0, os.SEEK_SET)
                    locking(self._fd, nb_lock, 1)
                    return self
                except OSError:
                    if time.monotonic() >= deadline:
                        os.close(self._fd)
                        self._fd = None
                        raise LockTimeout(f"加锁超时: {self.path}")
                    time.sleep(0.02)
        return self._enter_fallback(deadline)

    def _enter_fallback(self, deadline: float) -> "_FileLock":  # pragma: no cover - Windows 兜底
        self.mode = "best_effort"
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None
        self._fallback_path = self.path.with_suffix(self.path.suffix + ".excl")
        while True:
            try:
                fd = os.open(
                    str(self._fallback_path),
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
                os.write(fd, f"{os.getpid()} {time.time()}".encode("ascii"))
                os.close(fd)
                return self
            except FileExistsError:
                with contextlib.suppress(OSError):
                    age = time.time() - self._fallback_path.stat().st_mtime
                    if age > 30:
                        self._fallback_path.unlink()
                if time.monotonic() >= deadline:
                    raise LockTimeout(f"加锁超时: {self.path}")
                time.sleep(0.02)

    def __exit__(self, *exc: object) -> None:
        if self._fd is not None:
            with contextlib.suppress(OSError):
                try:
                    import fcntl

                    fcntl.flock(self._fd, fcntl.LOCK_UN)
                except (ImportError, OSError):
                    pass
            with contextlib.suppress(OSError):
                try:
                    import msvcrt

                    locking = getattr(msvcrt, "locking", None)
                    if locking is not None:
                        os.lseek(self._fd, 0, os.SEEK_SET)
                        locking(self._fd, getattr(msvcrt, "LK_UNLCK", 0), 1)
                except (ImportError, OSError):
                    pass
            with contextlib.suppress(OSError):
                os.close(self._fd)
            self._fd = None
        if self._fallback_path is not None:
            with contextlib.suppress(OSError):
                self._fallback_path.unlink()
            self._fallback_path = None


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
    def __init__(
        self,
        resolved: ResolvedState,
        *,
        import_legacy: bool = True,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self.resolved = resolved
        self.import_legacy = import_legacy
        self.env = dict(os.environ if env is None else env)

    # -- 路径与初始化 ----------------------------------------------------
    @property
    def state_path(self) -> Path:
        return self.resolved.state_path

    @property
    def state_dir(self) -> Path:
        return self.resolved.state_dir

    def lock(self, timeout: float = 5.0):
        created = not self.state_dir.exists()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if created:
            with contextlib.suppress(OSError):
                os.chmod(self.state_dir, 0o700)
        return _FileLock(self.resolved.lock_path, timeout=timeout)

    def ensure_layout(self) -> tuple[str, ...]:
        warnings: list[str] = []
        created = not self.state_dir.exists()
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            if created:
                with contextlib.suppress(OSError):
                    os.chmod(self.state_dir, 0o700)
        except OSError as exc:
            raise CheckpointError(f"无法创建状态目录: {self.state_dir} ({exc})") from exc
        warnings.extend(self._ensure_gitignore())
        warnings.extend(self._git_tracked_warnings())
        return tuple(warnings)

    def _ensure_gitignore(self) -> list[str]:
        warnings: list[str] = []
        gitignore = self.resolved.project_root / ".gitignore"
        entry = f"{STATE_DIRNAME}/"
        fallback = self.state_dir / ".gitignore"
        if gitignore.is_symlink():
            warnings.append("gitignore_symlink_skipped")
            _write_private(fallback, "*\n")
            return warnings
        try:
            existing = ""
            if gitignore.exists():
                existing = _read_small_text(gitignore, MAX_CONFIG_BYTES, ".gitignore")
            lines = existing.splitlines()
            if entry not in {ln.strip() for ln in lines}:
                block = ""
                if existing and not existing.endswith("\n"):
                    block += "\n"
                block += f"# vibe-kernel runtime state\n{entry}\n"
                if not _write_private(gitignore, existing + block):
                    raise OSError("unsafe .gitignore")
        except (OSError, ValueError, UnicodeError):
            warnings.append("gitignore_write_failed")
            if not _write_private(fallback, "*\n"):
                warnings.append("gitignore_fallback_failed")
        return warnings

    def _git_tracked_warnings(self) -> list[str]:
        if not (self.resolved.project_root / ".git").exists():
            return []
        try:
            git_bin = resolve_git_bin(self.resolved.project_root)
            if git_bin is None:
                return []
            with contextlib.suppress(OSError):
                rel = os.path.relpath(self.state_path, self.resolved.project_root)
                proc = subprocess.run(
                    [
                        git_bin,
                        *_GIT_SAFE_ARGS,
                        "-C",
                        str(self.resolved.project_root),
                        "ls-files",
                        "--error-unmatch",
                        "--",
                        rel,
                    ],
                    capture_output=True,
                    text=True,
                    errors="replace",
                    timeout=10,
                    env=_git_env(),
                )
                if proc.returncode == 0:
                    return [vc_codes.STATE_TRACKED_BY_GIT]
        except (OSError, subprocess.SubprocessError):
            pass
        return []

    # -- 读取 ------------------------------------------------------------
    def read_text(self) -> str | None:
        try:
            info = os.lstat(self.state_path)
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise CheckpointError(f"读取状态文件失败: {self.state_path} ({exc})") from exc
        if stat.S_ISLNK(info.st_mode):
            raise CorruptCheckpoint(f"状态文件是软链，拒绝读取: {self.state_path}")
        if not stat.S_ISREG(info.st_mode):
            raise CorruptCheckpoint(f"状态文件不是普通文件: {self.state_path}")
        if info.st_size > MAX_STATE_BYTES:
            raise CorruptCheckpoint(f"状态文件超过 {MAX_STATE_BYTES} 字节上限")
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            fd = os.open(str(self.state_path), flags)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_STATE_BYTES:
                    raise CorruptCheckpoint(f"状态文件不是普通文件或超限: {self.state_path}")
                chunks: list[bytes] = []
                while True:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    chunks.append(chunk)
                data = b"".join(chunks)
            finally:
                os.close(fd)
        except CorruptCheckpoint:
            raise
        except OSError as exc:
            raise CheckpointError(f"读取状态文件失败: {self.state_path} ({exc})") from exc
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise CorruptCheckpoint(f"状态文件不是 UTF-8: {self.state_path}") from exc

    def load_raw(self) -> tuple[dict[str, Any], ParseQuality]:
        text = self.read_text()
        if text is None:
            return {}, ParseQuality.CORRUPT
        try:
            return parse_subset(text), ParseQuality.STRICT
        except SubsetParseError:
            flat = scan_flat_scalars(text)
            if flat is None:
                raise CorruptCheckpoint(f"状态文件不可解析: {self.state_path}")
            return flat, ParseQuality.DEGRADED

    def snapshot(self) -> Snapshot:
        text = self.read_text()
        if text is None:
            return Snapshot(fields=normalize_fields({}), raw={}, quality=ParseQuality.CORRUPT, exists=False)
        try:
            raw = parse_subset(text)
            quality = ParseQuality.STRICT
        except SubsetParseError:
            flat = scan_flat_scalars(text)
            if flat is None:
                raise CorruptCheckpoint(f"状态文件不可解析: {self.state_path}")
            raw, quality = flat, ParseQuality.DEGRADED
        return Snapshot(fields=normalize_fields(raw), raw=raw, quality=quality, exists=True)

    def _read_unlocked(self) -> Snapshot:
        try:
            return self.snapshot()
        except CorruptCheckpoint:
            return Snapshot(
                fields=normalize_fields({}),
                raw={},
                quality=ParseQuality.CORRUPT,
                exists=self.state_path.exists(),
            )

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
            warnings = self.ensure_layout()
        except CheckpointError as exc:
            return WriteResult(ok=False, code=exc.code, message=str(exc), next=vc_codes.next_action(exc.code))

        try:
            with _FileLock(self.resolved.lock_path):
                current = self._read_unlocked()
                if current.exists and current.quality is ParseQuality.CORRUPT:
                    backup_file(
                        self.state_path,
                        "corrupt",
                        move=(
                            self.resolved.allow_move
                            and self.state_path.parent == self.state_dir
                        ),
                    )
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.CHECKPOINT_CORRUPT,
                        message="状态文件损坏，已备份且拒绝覆盖",
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_CORRUPT),
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
                if (
                    expected_rev is not None
                    and current.rev != expected_rev
                    and not (
                        archive_kind
                        and self.resolved.allow_move
                        and current.exists
                        and str(current.fields.get("status", "")) == "complete"
                    )
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
                        message="状态文件仅降级可读，拒绝覆盖；请先重建完整状态",
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_DEGRADED),
                    )
                if (
                    current.exists
                    and current.owner
                    and current.owner != self.resolved.project_id
                ):
                    return WriteResult(
                        ok=False,
                        rev=current.rev,
                        code=vc_codes.CHECKPOINT_FOREIGN,
                        message="_project_id 与当前项目不符，拒绝写入",
                        next=vc_codes.next_action(vc_codes.CHECKPOINT_FOREIGN),
                    )
                if (
                    archive_kind
                    and current.exists
                    and str(current.fields.get("status", "")) == "complete"
                ):
                    archived = backup_file(
                        self.state_path,
                        archive_kind,
                        move=self.resolved.allow_move,
                    )
                    if archived is None:
                        return WriteResult(
                            ok=False,
                            rev=current.rev,
                            code=vc_codes.CHECKPOINT_WRITE_FAILED,
                            message="完成任务归档失败，拒绝覆盖旧状态",
                            next=vc_codes.next_action(vc_codes.CHECKPOINT_WRITE_FAILED),
                        )
                    if self.resolved.allow_move:
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
                    return WriteResult(ok=True, rev=current.rev, changed=False, warnings=warnings)

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
                self._atomic_write(payload)
                return WriteResult(
                    ok=True,
                    rev=int(merged["_rev"]),
                    changed=True,
                    warnings=warnings,
                )
        except LockTimeout as exc:
            return WriteResult(
                ok=False,
                code=vc_codes.CHECKPOINT_WRITE_FAILED,
                message=str(exc),
                next=vc_codes.next_action(vc_codes.CHECKPOINT_WRITE_FAILED),
            )
        except (OSError, UnicodeError) as exc:
            return WriteResult(
                ok=False,
                code=vc_codes.CHECKPOINT_WRITE_FAILED,
                message=f"写入状态失败: {exc}",
                next=vc_codes.next_action(vc_codes.CHECKPOINT_WRITE_FAILED),
            )

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

    def _atomic_write(self, payload: str) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.state_dir), prefix=".state.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self.state_path)
            _fsync_dir(self.state_dir)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise

    def archive_state(self, kind: str = "complete") -> Path | None:
        if not self.state_path.exists():
            return None
        return backup_file(self.state_path, kind, move=self.resolved.allow_move)

    # -- 兼容：旧路径只读导入 -------------------------------------------
    def maybe_import_legacy(self) -> dict[str, str] | None:
        if not self.import_legacy or self.state_path.exists():
            return None
        for legacy in _installed_skill_dirs(self.env):
            candidate = legacy / ".state.md"
            if not candidate.exists() or candidate == self.state_path:
                continue
            try:
                info = os.lstat(candidate)
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                    continue
                if info.st_size > MAX_STATE_BYTES:
                    continue
                text = candidate.read_bytes().decode("utf-8")
            except (OSError, UnicodeError):
                continue
            try:
                raw = parse_subset(text)
            except SubsetParseError:
                flat = scan_flat_scalars(text)
                if flat is None:
                    continue
                raw = flat
            try:
                if int(raw.get("_schema", STATE_SCHEMA_VERSION)) > STATE_SCHEMA_VERSION:
                    continue
            except (TypeError, ValueError, OverflowError):
                continue
            legacy_fields = dict(raw)
            legacy_fields.pop("_project_id", None)
            result = self.write(legacy_fields)
            if not result.ok:
                continue
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            target = candidate.with_name(f"{candidate.name}.legacy-{ts}")
            with contextlib.suppress(OSError):
                candidate.rename(target)
            return {"from": str(candidate), "to": str(self.state_path), "legacy": str(target)}
        return None


def _write_private(path: Path, text: str) -> bool:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        info = None
    except OSError:
        return False
    if info is not None and (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode)):
        return False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            if info is not None:
                with contextlib.suppress(OSError):
                    os.chmod(tmp, stat.S_IMODE(info.st_mode))
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
        return True
    except (OSError, UnicodeError):
        return False


def _read_small_text(path: Path, limit: int, label: str) -> str:
    if "\x00" in str(path):
        raise ValueError(f"{label} 路径含 NUL")
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        raise ValueError(f"{label} 是软链")
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"{label} 不是普通文件")
    if info.st_size > limit:
        raise ValueError(f"{label} 超过 {limit} 字节上限")
    return path.read_bytes().decode("utf-8")


def backup_file(path: Path, kind: str, *, move: bool = True) -> Path | None:
    """备份状态文件；``move=False`` 时复制（用于项目外显式路径，绝不改名用户文件）。"""
    ts = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    target = path.with_name(f"{path.name}.{kind}-{ts}")
    counter = 1
    while target.exists():
        target = path.with_name(f"{path.name}.{kind}-{ts}-{counter}")
        counter += 1
    try:
        info = os.lstat(path)
        if not move:
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                return None  # 只复制普通文件，避免读 /dev/zero 或 FIFO
        if move:
            os.replace(path, target)
        else:
            shutil.copy2(path, target)
        return target
    except OSError:
        return None


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


def _fsync_dir(directory: Path) -> None:
    if os.name == "nt":  # pragma: no cover - Windows 无目录 fsync
        return
    try:
        fd = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
