"""artifact 引用与两层生命周期（ephemeral / pinned）。

事实源：docs/design/mvp-1-workflow-core.md §7.3
- ``ephemeral``：memory_tool.py 的 24h 会话缓存，允许过期。
- ``pinned``：``~/.vibe-loop/artifacts/<project_id>/pinned/``，Checkpoint 引用期间不删除。
- GC 永不删除被当前 Checkpoint 引用的 pinned 文件；``status=active`` 时拒绝 GC。
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

from . import vc_codes

DEFAULT_RETENTION_DAYS = 7


@dataclass(frozen=True)
class ArtifactCheck:
    ok: bool | None
    tier: str
    ref: str
    reason: str = ""
    regen_cmd: list[str] = field(default_factory=list)

    @property
    def missing(self) -> bool:
        return self.ok is False

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "tier": self.tier,
            "ref": self.ref,
            "ok": self.ok,
            "reason": self.reason,
        }
        if self.regen_cmd:
            data["regen_cmd"] = list(self.regen_cmd)
        return data


@dataclass(frozen=True)
class GCResult:
    ok: bool
    deleted: tuple[str, ...] = ()
    kept: tuple[str, ...] = ()
    referenced: tuple[str, ...] = ()
    code: str = ""
    message: str = ""
    next: str = ""

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "ok": self.ok,
            "deleted": list(self.deleted),
            "kept": list(self.kept),
            "referenced": list(self.referenced),
        }
        if self.code:
            data.update(vc_codes.make_code(self.code, self.message, action=self.next).to_dict())
        return data


def iter_refs(value: Any) -> list[dict[str, Any]]:
    """递归收集形如 ``{tier, ref, ...}`` 的引用结构（去重）。"""
    found: list[dict[str, Any]] = []
    seen: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if isinstance(node.get("tier"), str) and isinstance(node.get("ref"), str):
                key = f"{node.get('tier')}::{node.get('ref')}"
                if key not in seen:
                    seen.add(key)
                    found.append(dict(node))
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(value)
    return found


MAX_ARTIFACT_BYTES = 256 * 1024 * 1024


class ArtifactStore:
    def __init__(self, artifacts_dir: Path, *, ephemeral_index: Iterable[str] | None = None) -> None:
        self.artifacts_dir = Path(artifacts_dir)
        self._ephemeral_index = set(ephemeral_index) if ephemeral_index is not None else None

    def _dir_is_safe(self) -> bool:
        try:
            if self.artifacts_dir.is_symlink():
                return False
            if self.artifacts_dir.exists() and not self.artifacts_dir.is_dir():
                return False
        except OSError:
            return False
        return True

    def _resolve_pinned(self, ref: str) -> Path | None:
        if not ref or "\x00" in ref:
            return None
        try:
            rel = Path(ref)
        except (ValueError, OSError):
            return None
        if rel.is_absolute() or ".." in rel.parts:
            return None
        if rel.parts and rel.parts[0] == "artifacts":
            rel = Path(*rel.parts[1:])
        if len(rel.parts) != 1 or not rel.name:
            return None
        candidate = self.artifacts_dir / rel.name
        try:
            root = self.artifacts_dir.resolve()
            resolved = candidate.resolve()
            if resolved != root and root not in resolved.parents:
                return None
        except (OSError, ValueError):
            return None
        return candidate

    # -- pinned 写入 -----------------------------------------------------
    def put(
        self,
        content: str | bytes,
        *,
        reproducible: bool = False,
        regen_cmd: Iterable[str] = (),
        name: str | None = None,
    ) -> dict[str, Any] | None:
        data = content.encode("utf-8") if isinstance(content, str) else bytes(content)
        if len(data) > MAX_ARTIFACT_BYTES:
            return None
        digest = hashlib.sha256(data).hexdigest()
        base = name or digest[:16]
        if "\x00" in base:
            return None
        if base.endswith(".log"):
            base = base[:-4]
        filename = base + ".log"
        if "/" in filename or "\\" in filename or filename.startswith("."):
            return None
        if len(filename.encode("utf-8")) > 200:
            return None
        if not self._dir_is_safe():
            return None
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        if not self._dir_is_safe():
            return None
        target = self.artifacts_dir / filename
        if target.exists():
            try:
                info = target.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ARTIFACT_BYTES:
                    return None
                if _hash_file(target) != digest:
                    return None  # 同名不同内容：拒绝静默覆盖
            except OSError:
                return None
        if len(data) > MAX_ARTIFACT_BYTES:
            return None
        fd, tmp = tempfile.mkstemp(dir=str(self.artifacts_dir), prefix=".artifact.", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, target)
            _fsync_dir(self.artifacts_dir)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

        # 回读校验通过后才写出引用（永不返回不存在的 ref）
        try:
            readback_digest = _hash_file(target)
        except OSError:
            return None
        if readback_digest != digest:
            return None
        return {
            "tier": "pinned",
            "ref": f"artifacts/{filename}",
            "sha256": digest,
            "bytes": len(data),
            "created_at": time.strftime("%Y-%m-%d %H:%M"),
            "reproducible": bool(reproducible),
            "regen_cmd": list(regen_cmd),
        }

    def path_for(self, ref: str) -> Path:
        resolved = self._resolve_pinned(ref)
        if resolved is None:
            raise ValueError(f"非法 artifact ref: {ref!r}")
        return resolved

    # -- 校验 ------------------------------------------------------------
    def validate(self, ref: Mapping[str, Any], *, hash_limit: int | None = None) -> ArtifactCheck:
        tier = str(ref.get("tier", ""))
        ref_path = str(ref.get("ref", ""))
        regen = [str(x) for x in ref.get("regen_cmd", []) or []]
        if tier == "pinned":
            if not self._dir_is_safe():
                return ArtifactCheck(False, tier, ref_path, "artifacts 目录是软链或非目录", regen)
            path = self._resolve_pinned(ref_path)
            if path is None:
                return ArtifactCheck(False, tier, ref_path, "ref 越界或形态非法", regen)
            try:
                info = path.lstat()
            except FileNotFoundError:
                return ArtifactCheck(False, tier, ref_path, "pinned artifact 不存在", regen)
            except OSError as exc:
                return ArtifactCheck(False, tier, ref_path, f"stat 失败: {exc}", regen)
            if stat.S_ISLNK(info.st_mode):
                return ArtifactCheck(False, tier, ref_path, "pinned artifact 是软链", regen)
            if not stat.S_ISREG(info.st_mode):
                return ArtifactCheck(False, tier, ref_path, "pinned artifact 不是普通文件", regen)
            if info.st_size > MAX_ARTIFACT_BYTES:
                return ArtifactCheck(False, tier, ref_path, "pinned artifact 超过大小上限", regen)
            if ref.get("sha256"):
                try:
                    digest = _hash_file(path, limit=hash_limit or MAX_ARTIFACT_BYTES)
                except OSError as exc:
                    return ArtifactCheck(False, tier, ref_path, f"读取失败: {exc}", regen)
                if digest != str(ref["sha256"]):
                    return ArtifactCheck(False, tier, ref_path, "sha256 不匹配", regen)
            return ArtifactCheck(True, tier, ref_path)
        if tier == "ephemeral":
            if self._ephemeral_index is None:
                # 没有索引时无法机械判定，不谎报“已核对”
                return ArtifactCheck(None, tier, ref_path, "无 ephemeral 索引，未校验")
            ok = ref_path in self._ephemeral_index
            return ArtifactCheck(
                ok,
                tier,
                ref_path,
                "" if ok else "ephemeral ref 已过期或不存在（>24h）",
                regen,
            )
        return ArtifactCheck(None, tier or "unknown", ref_path, "未知 artifact tier")

    def validate_all(
        self,
        fields: Mapping[str, Any],
        *,
        max_refs: int = 200,
        max_bytes: int = 64 * 1024 * 1024,
    ) -> list[ArtifactCheck]:
        checks: list[ArtifactCheck] = []
        seen: set[str] = set()
        remaining = max_bytes
        for ref in iter_refs(fields):
            tier = str(ref.get("tier", ""))
            ref_path = str(ref.get("ref", ""))
            resolved = self._resolve_pinned(ref_path) if tier == "pinned" else None
            key = str(resolved) if resolved is not None else f"{tier}::{ref_path}"
            if key in seen:
                checks.append(ArtifactCheck(None, tier, ref_path, "重复引用已去重"))
                continue
            seen.add(key)
            if len(checks) >= max_refs:
                checks.append(ArtifactCheck(None, tier, ref_path, "artifact 校验条目超过预算，已截断"))
                break
            if resolved is not None:
                try:
                    size = resolved.lstat().st_size
                except OSError:
                    size = 0
                if size > remaining:
                    checks.append(ArtifactCheck(None, tier, ref_path, "artifact 校验预算耗尽"))
                    continue
                remaining -= max(0, size)
            checks.append(self.validate(ref, hash_limit=remaining if resolved is not None else None))
        return checks

    # -- GC --------------------------------------------------------------
    def gc(
        self,
        fields: Mapping[str, Any],
        *,
        retention_days: int = DEFAULT_RETENTION_DAYS,
        now: float | None = None,
        dry_run: bool = False,
    ) -> GCResult:
        if int(retention_days) < 0:
            return GCResult(
                ok=False,
                code=vc_codes.INVALID_ARGUMENT,
                message="retention_days 不能为负",
                next=vc_codes.next_action(vc_codes.INVALID_ARGUMENT),
            )
        if str(fields.get("status", "")) == "active":
            return GCResult(
                ok=False,
                code=vc_codes.STATE_ILLEGAL_TRANSITION,
                message="status=active 时禁止 GC（任务可能正在引用产物）",
                next="等任务完成或显式在 S13 后执行 state gc",
            )
        if not self._dir_is_safe():
            return GCResult(
                ok=False,
                code=vc_codes.CHECKPOINT_LOCATION_UNRESOLVED,
                message="artifacts 目录是软链或非目录，拒绝 GC",
                next="把 artifacts 恢复为普通目录后重试",
            )
        if not self.artifacts_dir.exists():
            return GCResult(ok=True)
        refs = iter_refs(fields)
        referenced_paths: set[str] = set()
        for ref in refs:
            if ref.get("tier") != "pinned":
                continue
            resolved = self._resolve_pinned(str(ref.get("ref", "")))
            if resolved is not None:
                referenced_paths.add(str(resolved.resolve()))
        threshold = (now or time.time()) - max(0, int(retention_days)) * 86400
        deleted: list[str] = []
        kept: list[str] = []
        referenced: list[str] = []
        for path in sorted(self.artifacts_dir.iterdir()):
            if path.suffix != ".log":
                continue
            try:
                info = path.lstat()
            except OSError:
                continue
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                kept.append(path.name)
                continue
            key = str(path.resolve())
            if key in referenced_paths:
                referenced.append(path.name)
                continue
            try:
                mtime = info.st_mtime
            except OSError:
                continue
            if mtime < threshold:
                if not dry_run:
                    try:
                        path.unlink()
                    except OSError:
                        kept.append(path.name)
                        continue
                deleted.append(path.name)
            else:
                kept.append(path.name)
        return GCResult(
            ok=True,
            deleted=tuple(deleted),
            kept=tuple(kept),
            referenced=tuple(referenced),
        )


def _hash_file(path: Path, *, limit: int = MAX_ARTIFACT_BYTES) -> str:
    """分块哈希，避免把大 artifact 整体读入内存。"""
    hasher = hashlib.sha256()
    total = 0
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise OSError("artifact 超过大小上限")
            hasher.update(chunk)
    return hasher.hexdigest()


def _fsync_dir(directory: Path) -> None:
    if os.name == "nt":
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


def refs_as_json(refs: Iterable[Mapping[str, Any]]) -> str:
    return json.dumps(list(refs), ensure_ascii=False, sort_keys=True)
