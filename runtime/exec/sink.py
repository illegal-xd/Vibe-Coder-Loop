"""有界缓冲 + spill 落盘 + 硬上限丢弃记账。

事实源：MVP-2 §3.2 ``Sink`` 契约。

三条不变量（单元测试直接断言）：
1. 内存占用 ≤ ``cap``（单流）——与命令输出总量无关；
2. ``total_bytes`` 始终等于真实总字节（含外置 + 丢弃）；
3. ``dropped_bytes > 0`` → ``truncated=True``，决策信息不丢。
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Sink:
    """前 ``cap`` 字节留内存；超出写 spill 文件；超 ``max_spill`` 丢弃并记账。

    内存恒有界：绝不累积超过 ``cap`` 的字节在内存中。
    """

    cap: int
    max_spill: int
    buf: bytearray = field(default_factory=bytearray)
    in_memory: int = 0
    spill_file: object | None = None  # BinaryIO
    spill_path: str | None = None
    spilled: int = 0
    dropped: int = 0
    total_bytes: int = 0
    _closed: bool = False

    def __post_init__(self) -> None:
        if self.cap < 0:
            raise ValueError("cap 不能为负")
        if self.max_spill < 0:
            raise ValueError("max_spill 不能为负")

    @property
    def truncated(self) -> bool:
        return self.spilled > 0 or self.dropped > 0

    def write(self, chunk: bytes) -> None:
        if self._closed or not chunk:
            return
        self.total_bytes += len(chunk)
        # 1. 尽量填内存
        if self.in_memory < self.cap:
            take = min(self.cap - self.in_memory, len(chunk))
            self.buf.extend(chunk[:take])
            self.in_memory += take
            chunk = chunk[take:]
        if not chunk:
            return
        # 2. 剩余写 spill（不超过硬上限）
        if self.spilled + len(chunk) > self.max_spill:
            # 尽量写满 max_spill，其余丢弃
            room = max(0, self.max_spill - self.spilled)
            if room:
                self._ensure_spill()
                assert self.spill_file is not None
                self.spill_file.write(chunk[:room])
                self.spilled += room
            self.dropped += len(chunk) - room
        else:
            self._ensure_spill()
            assert self.spill_file is not None
            self.spill_file.write(chunk)
            self.spilled += len(chunk)

    def _ensure_spill(self) -> None:
        if self.spill_file is None:
            fd, path = tempfile.mkstemp(prefix="vibe_spill_", suffix=".log")
            self.spill_path = path
            self.spill_file = os.fdopen(fd, "wb")

    def head_text(self, *, encoding: str = "utf-8", errors: str = "replace") -> str:
        return bytes(self.buf).decode(encoding, errors)

    def spill_content(self, *, encoding: str = "utf-8", errors: str = "replace") -> str | None:
        """读取 spill 文件全部内容。落盘量大时慎用。"""
        if self.spill_path is None or self.spill_file is None:
            return None
        try:
            self.spill_file.flush()
            with open(self.spill_path, "rb") as f:
                return f.read().decode(encoding, errors)
        except OSError:
            return None

    def full_text(self, *, encoding: str = "utf-8", errors: str = "replace") -> str:
        """内存前缀 + spill 全文（仅供测试/小输出，勿用于大输出）。"""
        head = self.head_text(encoding=encoding, errors=errors)
        tail = self.spill_content(encoding=encoding, errors=errors) or ""
        return head + tail

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self.spill_file is not None:
            try:
                self.spill_file.close()
            except OSError:
                pass
        # spill 文件由调用方（ArtifactSink）或 close 时清理
        if self.spill_path is not None:
            try:
                os.unlink(self.spill_path)
            except OSError:
                pass
            self.spill_path = None

    def __del__(self) -> None:  # noqa: B027 - 兜底防 fd 泄漏
        try:
            self.close()
        except Exception:
            pass
