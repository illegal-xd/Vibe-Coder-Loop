"""artifact 外置薄适配（复用 MVP-1 ArtifactStore）。

事实源：MVP-2 §3.5 / §八

设计原定 subprocess CLI 调 memory_tool.py（U10 定案），但本项目 MVP-1 已实现
干净的、无状态的 ``runtime.core.artifacts.ArtifactStore`` 类（put 时即回读校验、
内容寻址、永不返回坏 ref）。复用该类在进程内调用满足 U10 的解耦诉求
（① Core/Exec 崩溃不影响磁盘 artifact；② 无全局状态隐式耦合；③ 低频），
且更简单、零进程开销。若将来 feed_exec 变高频路径，再引入常驻 worker（Phase 4）。

契约（§3.5 生产侧规则）：
1. **先校验后返回**：put 后回读一次；失败 → 外置失败（ref=None）。
2. **内容寻址**：同内容重复执行不重复占盘。
3. **引用携带重建信息**：reproducible + regen_cmd + created_at + sha256。
4. **不删除任何产物**：回收归 Core state gc。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from runtime.core.artifacts import ArtifactStore


@dataclass(frozen=True)
class ArtifactPutResult:
    ok: bool
    ref: str | None = None  # 形如 "artifacts/abcd1234.log"，仅当回读校验通过
    bytes_written: int = 0
    sha256: str = ""
    created_at: str = ""
    error: str = ""

    def to_ref_dict(self) -> dict[str, Any] | None:
        """转成 Core 可引用的 ref 结构（validate 可校验）。仅 ok 时返回。"""
        if not self.ok or not self.ref:
            return None
        return {
            "tier": "pinned",
            "ref": self.ref,
            "sha256": self.sha256,
            "bytes": self.bytes_written,
            "created_at": self.created_at,
        }


class ArtifactSink:
    """把 Sink 的内存前缀 + spill 全文外置到 pinned artifact。"""

    def __init__(self, store: ArtifactStore) -> None:
        self.store = store

    def put_stream(
        self,
        head_text: str,
        spill_text: str | None,
        *,
        reproducible: bool = False,
        regen_cmd: list[str] | None = None,
        encoding: str = "utf-8",
    ) -> ArtifactPutResult:
        """把 head + spill 拼接后外置。回读校验失败 → ref=None。"""
        content = head_text + (spill_text or "")
        if not content:
            return ArtifactPutResult(ok=False, error="无内容可外置")
        ref = self.store.put(
            content,
            reproducible=reproducible,
            regen_cmd=regen_cmd or [],
            name=None,  # 内容寻址
        )
        if ref is None:
            return ArtifactPutResult(ok=False, error="artifact put 失败（磁盘满/权限/索引坏/超大小上限）")
        return ArtifactPutResult(
            ok=True,
            ref=ref.get("ref", ""),
            bytes_written=int(ref.get("bytes", 0)),
            sha256=ref.get("sha256", ""),
            created_at=ref.get("created_at", time.strftime("%Y-%m-%d %H:%M")),
        )

    def validate(self, ref_dict: dict[str, Any]) -> bool:
        """回读校验。"""
        check = self.store.validate(ref_dict)
        return check.ok is True

    def page(self, ref: str, *, offset: int = 0, limit: int = 100, max_bytes: int = 100_000) -> str:
        """分页取用（薄封装，透传给 ArtifactStore.path_for + 直接读文件）。"""
        try:
            path = self.store.path_for(ref)
        except ValueError as exc:
            return f"[runtime] [ARTIFACT_NOT_FOUND] {exc}\n[next] artifact list 核对；源在则重新 put"
        try:
            size = path.stat().st_size
        except OSError as exc:
            return f"[runtime] [ARTIFACT_NOT_FOUND] 读取失败: {exc}\n[next] artifact list 核对"
        if offset > size:
            return ""
        with open(path, "rb") as f:
            f.seek(offset)
            chunk = f.read(max_bytes)
        text = chunk.decode("utf-8", "replace")
        lines = text.splitlines(keepends=True)
        return "".join(lines[:limit])
