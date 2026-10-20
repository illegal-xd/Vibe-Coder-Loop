"""Diff 汇总：六类改动覆盖 + plan_drift 集合差异 + 非 git 基线快照。

事实源：MVP-2 §六

原设计四个缺陷修正：
- ``git diff`` 不含未跟踪文件 → 用 ``status --porcelain=v2`` 补；
- 没覆盖"已暂存"与"重命名" → ``--cached`` + ``--find-renames``；
- 非 git 降级没定义基线 → 显式 baseline.json 快照协议；
- ``plan_drift`` 用字符串 ``in`` 比较 → 两侧归一化 + glob + 同时报 missing。

关键语义：``plan_drift=None`` = 无法判定；``PlanDrift([],[])`` = 判定无漂移。
"""

from __future__ import annotations

import fnmatch
import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .pathnorm import FileEntry, norm_path

# 忽略的路径（非 git 降级 + plan_drift 都过滤）
IGNORE_DIRS: frozenset[str] = frozenset(
    {
        ".vibe-kernel",
        "node_modules",
        ".venv",
        "venv",
        "env",
        "dist",
        "build",
        "target",
        "__pycache__",
        ".git",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "coverage",
        ".next",
        ".turbo",
        ".cache",
    }
)
IGNORE_SUFFIXES: tuple[str, ...] = (".pyc", ".pyo", ".class", ".log")


@dataclass
class DiffSummary:
    added: list[FileEntry]
    modified: list[FileEntry]
    deleted: list[FileEntry]
    renamed: list[tuple[FileEntry, FileEntry]]
    untracked: list[FileEntry]
    high_risk_files: list[FileEntry]
    total_insertions: int
    total_deletions: int
    plan_drift: "PlanDrift | None"
    baseline: str  # "git:HEAD" | "snapshot:<ts>" | "none"
    degraded: bool
    degraded_reason: str | None

    def to_dict(self) -> dict[str, Any]:
        def _entries(lst: list[FileEntry]) -> list[dict[str, str]]:
            return [{"path": e.path, "key": e.key, "outside_cwd": e.outside_cwd} for e in lst]

        return {
            "added": _entries(self.added),
            "modified": _entries(self.modified),
            "deleted": _entries(self.deleted),
            "renamed": [
                {"from": f.path, "to": t.path} for f, t in self.renamed
            ],
            "untracked": _entries(self.untracked),
            "high_risk_files": _entries(self.high_risk_files),
            "total_insertions": self.total_insertions,
            "total_deletions": self.total_deletions,
            "plan_drift": (
                None if self.plan_drift is None
                else {
                    "unplanned": _entries(self.plan_drift.unplanned),
                    "missing": _entries(self.plan_drift.missing),
                    "renamed_unplanned": [
                        {"from": f.path, "to": t.path} for f, t in self.plan_drift.renamed_unplanned
                    ],
                }
            ),
            "baseline": self.baseline,
            "degraded": self.degraded,
            "degraded_reason": self.degraded_reason,
        }


@dataclass
class PlanDrift:
    unplanned: list[FileEntry]
    missing: list[FileEntry]
    renamed_unplanned: list[tuple[FileEntry, FileEntry]] = field(default_factory=list)


# 高风险域关键词（文件路径命中即标记）
# DL-13 修复："key" 过宽会匹配 keyboard/keymap/monkey 等，改为更精确的复合词
HIGH_RISK_PATH_KEYWORDS: tuple[str, ...] = (
    "auth", "login", "password", "credential", "session", "token",
    "payment", "billing", "invoice", "amount", "price",
    "migration", "deploy", "schema", "encrypt", "transaction",
    "secret", "api_key", "private_key", "public_key", "secret_key",
    "cert", "permission", "rbac", "acl", "crypto",
)


def _is_high_risk(path: str) -> bool:
    lower = path.lower()
    return any(kw in lower for kw in HIGH_RISK_PATH_KEYWORDS)


def _is_ignored(rel_path: str) -> bool:
    parts = rel_path.split("/")
    if any(p in IGNORE_DIRS for p in parts):
        return True
    return any(rel_path.endswith(suf) for suf in IGNORE_SUFFIXES)


# ---------------------------------------------------------------------------
# Git 路径
# ---------------------------------------------------------------------------

def _git(args: list[str], cwd: str) -> str:
    """运行只读 git 子命令，返回 stdout。失败返回空串。"""
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
            shell=False,
        )
        return result.stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _parse_porcelain_v2(status_out: str) -> tuple[dict[str, str], list[tuple[str, str]]]:
    """解析 ``git status --porcelain=v2 -z`` 输出。

    返回 (entries, rename_pairs)：
    - entries: {path: xy_status}
    - rename_pairs: [(old_path, new_path)] — rename/copy 对
    """
    entries: dict[str, str] = {}
    renames: list[tuple[str, str]] = []
    parts = status_out.split("\0") if "\0" in status_out else status_out.splitlines()
    i = 0
    while i < len(parts):
        line = parts[i]
        if not line:
            i += 1
            continue
        tokens = line.split(" ")
        if not tokens:
            i += 1
            continue
        kind = tokens[0]
        if kind == "1":
            if len(tokens) >= 9:
                xy = tokens[1]
                path = " ".join(tokens[8:])
                entries[path] = xy
        elif kind == "2":
            # rename/copy：path 在 tokens[8:]，origPath 在下一个 \0 段
            if len(tokens) >= 9:
                xy = tokens[1]
                path = " ".join(tokens[8:])
                i += 1
                orig = parts[i] if i < len(parts) else ""
                if xy[0] == "R":
                    entries[path] = "R"
                    if orig:
                        entries[orig] = "R0"
                        renames.append((orig, path))
                elif xy[0] == "C":
                    entries[path] = "C"
                    if orig:
                        entries[orig] = "C0"
                        renames.append((orig, path))
                else:
                    entries[path] = xy
        elif kind == "u":
            if len(tokens) >= 11:
                xy = tokens[1]
                path = " ".join(tokens[10:])
                entries[path] = xy
        elif kind == "?":
            path = " ".join(tokens[1:])
            entries[path] = "??"
        i += 1
    return entries, renames


def _parse_name_status(diff_out: str) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """解析 ``git diff --name-status -z`` 输出。

    返回 (entries, renames)：
    - entries: [(status, path)] — M/A/D/T 等普通改动
    - renames: [(old_path, new_path)] — R/C 重命名/复制对
    """
    entries: list[tuple[str, str]] = []
    renames: list[tuple[str, str]] = []

    if "\0" in diff_out:
        # -z 格式：status\0path\0status\0path\0... rename 时 status\0old\0new\0
        parts = diff_out.split("\0")
        i = 0
        while i < len(parts):
            status = parts[i]
            if not status:
                i += 1
                continue
            i += 1
            if i >= len(parts):
                break
            path = parts[i]  # git -z: 第一个路径是 old_path（rename 时）或普通文件路径
            i += 1
            if status.startswith("R") or status.startswith("C"):
                # rename/copy：path 是 old_path，还需读 new_path
                if i < len(parts):
                    new_path = parts[i]
                    i += 1
                    renames.append((path, new_path))  # (old, new) ✓
                else:
                    renames.append(("", path))
            else:
                entries.append((status, path))
    else:
        # 非 -z 格式：每行 "status\tpath" 或 "R<score>\told\tnew"
        for line in diff_out.splitlines():
            if not line.strip():
                continue
            t = line.split("\t")
            if len(t) >= 3 and (t[0].startswith("R") or t[0].startswith("C")):
                renames.append((t[1], t[2]))
            elif len(t) >= 2:
                entries.append((t[0], t[1]))
    return entries, renames


def _parse_numstat(numstat_out: str) -> tuple[int, int]:
    """解析 ``git diff --numstat`` 为 (insertions, deletions)。"""
    ins = dels = 0
    if "\0" in numstat_out:
        # -z 格式：stat\0path\0stat\0path\0... stat = "added\tdeleted"
        parts = numstat_out.split("\0")
        i = 0
        while i < len(parts):
            stat = parts[i]
            i += 1
            if i < len(parts):
                i += 1  # consume path
            if "\t" not in stat:
                continue
            nums = stat.split("\t")
            if len(nums) >= 2:
                try:
                    ins += int(nums[0]) if nums[0] != "-" else 0
                    dels += int(nums[1]) if nums[1] != "-" else 0
                except ValueError:
                    pass
        return ins, dels
    for line in numstat_out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            try:
                i = int(parts[0]) if parts[0] != "-" else 0
                d = int(parts[1]) if parts[1] != "-" else 0
                ins += i
                dels += d
            except ValueError:
                continue
    return ins, dels


def _collect_git(cwd: str, base: str) -> DiffSummary | None:
    """Git 路径：一次拿全六类改动。"""
    toplevel = _git(["rev-parse", "--show-toplevel"], cwd)
    if not toplevel.strip():
        return None

    status_out = _git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], cwd)
    staged_out = _git(["diff", "--name-status", "-z", "--find-renames", "--cached", base], cwd)
    worktree_out = _git(["diff", "--name-status", "-z", "--find-renames", base], cwd)
    numstat_out = _git(["diff", "--numstat", "-z", base], cwd)

    porcelain, porcelain_renames = _parse_porcelain_v2(status_out)
    staged_entries, staged_renames = _parse_name_status(staged_out)
    worktree_entries, worktree_renames = _parse_name_status(worktree_out)
    ins, dels = _parse_numstat(numstat_out)

    root_real = os.path.realpath(cwd)
    added: list[FileEntry] = []
    modified: list[FileEntry] = []
    deleted: list[FileEntry] = []
    renamed: list[tuple[FileEntry, FileEntry]] = []
    untracked: list[FileEntry] = []
    seen_keys: set[str] = set()

    def _add(entry: FileEntry, category: list[FileEntry]) -> None:
        if entry.key not in seen_keys and not _is_ignored(entry.path):
            seen_keys.add(entry.key)
            category.append(entry)

    # 收集 rename 对（porcelain + staged + worktree 三路合并去重）
    rename_seen: set[str] = set()
    for old, new in porcelain_renames + staged_renames + worktree_renames:
        old_e = _make_entry(old, root_real)
        new_e = _make_entry(new, root_real)
        if old_e and new_e and new_e.key not in rename_seen:
            rename_seen.add(new_e.key)
            renamed.append((old_e, new_e))

    # 处理 porcelain（含 untracked + 冲突态）
    for path, xy in porcelain.items():
        if xy == "??":
            entry = _make_entry(path, root_real)
            if entry:
                _add(entry, untracked)
        elif xy.startswith("R") or xy.startswith("C"):
            pass  # rename 已在上面处理
        elif xy in ("AA", "UU", "DU", "UD", "AU", "UA"):
            entry = _make_entry(path, root_real)
            if entry:
                _add(entry, modified)
        elif len(xy) >= 2 and (xy[0] in ("M", "A", "D", "T", "C") or xy[1] in ("M", "A", "D", "T", "C")):
            entry = _make_entry(path, root_real)
            if entry:
                first = xy[0] if xy[0] != "." else xy[1]
                if first == "A":
                    _add(entry, added)
                elif first == "D":
                    _add(entry, deleted)
                else:
                    _add(entry, modified)

    # 处理 staged diff（已暂存 vs 基线）
    for status, path in staged_entries:
        entry = _make_entry(path, root_real)
        if not entry:
            continue
        if status == "A":
            _add(entry, added)
        elif status == "D":
            _add(entry, deleted)
        elif status in ("M", "T"):
            _add(entry, modified)

    # 处理 worktree diff（未暂存 vs 基线）
    for status, path in worktree_entries:
        entry = _make_entry(path, root_real)
        if not entry:
            continue
        if status == "A":
            _add(entry, added)
        elif status == "D":
            _add(entry, deleted)
        elif status in ("M", "T"):
            _add(entry, modified)

    # 高风险文件
    all_paths = added + modified + deleted + untracked
    high_risk = [e for e in all_paths if _is_high_risk(e.path)]

    return DiffSummary(
        added=added,
        modified=modified,
        deleted=deleted,
        renamed=renamed,
        untracked=untracked,
        high_risk_files=high_risk,
        total_insertions=ins,
        total_deletions=dels,
        plan_drift=None,
        baseline=f"git:{base}",
        degraded=False,
        degraded_reason=None,
    )


def _make_entry(path: str, root_real: str) -> FileEntry | None:
    if not path:
        return None
    abs_path = os.path.join(root_real, path) if not os.path.isabs(path) else path
    return norm_path(abs_path, root_real)


# ---------------------------------------------------------------------------
# 非 Git 降级：基线快照
# ---------------------------------------------------------------------------

def _baseline_path(cwd: str) -> Path:
    return Path(cwd) / ".vibe-kernel" / "baseline.json"


def _create_snapshot(cwd: str) -> dict[str, Any] | None:
    """扫描项目目录，生成基线快照。"""
    root = os.path.realpath(cwd)
    entries: dict[str, dict[str, Any]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
        for fname in filenames:
            if any(fname.endswith(suf) for suf in IGNORE_SUFFIXES):
                continue
            full = os.path.join(dirpath, fname)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if _is_ignored(rel):
                continue
            try:
                st = os.stat(full)
                entries[rel] = {"mtime_ns": st.st_mtime_ns, "size": st.st_size}
            except OSError:
                continue
    return {"created_at": time.strftime("%Y-%m-%d %H:%M"), "root": root, "entries": entries}


def _save_baseline(cwd: str, snapshot: dict[str, Any]) -> bool:
    """原子写基线快照。失败返回 False。"""
    path = _baseline_path(cwd)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        return True
    except OSError:
        return False


def _load_baseline(cwd: str) -> dict[str, Any] | None:
    path = _baseline_path(cwd)
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _collect_snapshot(cwd: str) -> DiffSummary:
    """非 git 路径：基线快照对比。"""
    root_real = os.path.realpath(cwd)
    baseline = _load_baseline(cwd)
    if baseline is None:
        # 首次：创建基线
        snap = _create_snapshot(cwd)
        if snap is None:
            return DiffSummary(
                added=[], modified=[], deleted=[], renamed=[], untracked=[],
                high_risk_files=[], total_insertions=0, total_deletions=0,
                plan_drift=None,
                baseline="none", degraded=True, degraded_reason="no_baseline",
            )
        if not _save_baseline(cwd, snap):
            return DiffSummary(
                added=[], modified=[], deleted=[], renamed=[], untracked=[],
                high_risk_files=[], total_insertions=0, total_deletions=0,
                plan_drift=None,
                baseline="none", degraded=True, degraded_reason="no_baseline",
            )
        return DiffSummary(
            added=[], modified=[], deleted=[], renamed=[], untracked=[],
            high_risk_files=[], total_insertions=0, total_deletions=0,
            plan_drift=None,
            baseline=f"snapshot:{snap['created_at']}",
            degraded=True, degraded_reason="first_run",
        )

    # 对比基线
    now_snap = _create_snapshot(cwd)
    if now_snap is None:
        return DiffSummary(
            added=[], modified=[], deleted=[], renamed=[], untracked=[],
            high_risk_files=[], total_insertions=0, total_deletions=0,
            plan_drift=None,
            baseline="none", degraded=True, degraded_reason="scan_failed",
        )
    base_entries: dict[str, dict[str, Any]] = baseline.get("entries", {})
    now_entries: dict[str, dict[str, Any]] = now_snap.get("entries", {})

    added: list[FileEntry] = []
    modified: list[FileEntry] = []
    deleted: list[FileEntry] = []

    for rel, now_info in now_entries.items():
        abs_path = os.path.join(root_real, rel)
        entry = norm_path(abs_path, root_real)
        if rel not in base_entries:
            added.append(entry)
        else:
            base_info = base_entries[rel]
            if now_info.get("mtime_ns") != base_info.get("mtime_ns") or now_info.get("size") != base_info.get("size"):
                modified.append(entry)
    for rel in base_entries:
        if rel not in now_entries:
            abs_path = os.path.join(root_real, rel)
            deleted.append(norm_path(abs_path, root_real))

    high_risk = [e for e in added + modified + deleted if _is_high_risk(e.path)]
    ts = baseline.get("created_at", "")

    is_git = _git(["rev-parse", "--is-inside-work-tree"], cwd).strip()
    reason = "not_a_repo" if is_git != "true" else "no_commits"

    return DiffSummary(
        added=added,
        modified=modified,
        deleted=deleted,
        renamed=[],
        untracked=[],
        high_risk_files=high_risk,
        total_insertions=0,
        total_deletions=0,
        plan_drift=None,
        baseline=f"snapshot:{ts}",
        degraded=True,
        degraded_reason=reason,
    )


# ---------------------------------------------------------------------------
# plan_drift 计算
# ---------------------------------------------------------------------------

def compute_drift(
    actual: list[FileEntry],
    renamed_pairs: list[tuple[FileEntry, FileEntry]],
    plan: list[str],
    root: str,
) -> PlanDrift:
    """计算计划漂移（集合差异，不是字符串不等）。"""
    plan_entries = [norm_path(p, root) for p in plan]
    plan_globs = [e.key for e in plan_entries if any(c in e.path for c in "*?[")]
    plan_exact = {e.key for e in plan_entries if not any(c in e.path for c in "*?[")}

    def declared(key: str) -> bool:
        if key in plan_exact:
            return True
        return any(fnmatch.fnmatch(key, g) for g in plan_globs)

    unplanned = [e for e in actual if not declared(e.key)]
    actual_keys = {a.key for a in actual}
    missing = [
        e for e in plan_entries
        if not any(c in e.path for c in "*?[") and e.key not in actual_keys
    ]
    renamed_unplanned = [
        (f, t) for f, t in renamed_pairs if not declared(t.key)
    ]
    return PlanDrift(
        unplanned=unplanned,
        missing=missing,
        renamed_unplanned=renamed_unplanned,
    )


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def summarize_diff(
    cwd: str,
    *,
    plan_files: list[str] | None = None,
    base: str | None = None,
) -> DiffSummary:
    """汇总工作区改动。``base`` 缺省 HEAD。"""
    base = base or "HEAD"

    is_git = _git(["rev-parse", "--is-inside-work-tree"], cwd).strip()
    has_commits = bool(_git(["rev-parse", "--verify", base], cwd).strip())

    summary: DiffSummary | None = None
    if is_git == "true" and has_commits:
        summary = _collect_git(cwd, base)

    if summary is None:
        summary = _collect_snapshot(cwd)

    # 注入 plan_drift
    # DL-12 修复：first_run / no_baseline 时 plan_drift = None（无法判定）
    if plan_files is not None and not summary.degraded:
        all_actual = summary.added + summary.modified + summary.deleted + summary.untracked
        summary.plan_drift = compute_drift(
            all_actual, summary.renamed, plan_files, cwd
        )
    elif plan_files is not None and summary.degraded:
        if summary.degraded_reason in ("first_run", "no_baseline"):
            summary.plan_drift = None  # 无法判定
        else:
            # 快照模式有基线 → 仍可算 drift
            all_actual = summary.added + summary.modified + summary.deleted
            summary.plan_drift = compute_drift(all_actual, summary.renamed, plan_files, cwd)

    return summary
