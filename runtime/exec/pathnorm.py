"""跨平台路径归一化。

事实源：MVP-2 §6.4

- 显示用 ``path``（保留大小写）；比较用 ``key``（统一 POSIX 分隔符 + 大小写折叠）。
- 仓库外路径（``../x``）标记，不静默吞掉。
"""

from __future__ import annotations

import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

_CACHE: bool | None = None


def detect_case_insensitive_fs() -> bool:
    """探测文件系统是否大小写不敏感。探测失败按 sys.platform 保守默认。"""
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    if sys.platform == "win32":
        _CACHE = True
        return True
    if sys.platform == "darwin":
        # macOS 默认卷（APFS 默认大小写敏感=False，但用户可配）；保守探测
        try:
            d = tempfile.mkdtemp(prefix="vibe_ci_")
            lower = os.path.join(d, "probe_lowercase_test")
            upper = os.path.join(d, "PROBE_LOWERCASE_TEST")
            try:
                with open(lower, "w") as f:
                    f.write("x")
                _CACHE = os.path.exists(upper) and os.path.samefile(lower, upper)
            except OSError:
                _CACHE = False
            finally:
                try:
                    os.unlink(lower)
                except OSError:
                    pass
                try:
                    os.rmdir(d)
                except OSError:
                    pass
        except OSError:
            _CACHE = False
        return _CACHE
    _CACHE = False
    return False


@dataclass(frozen=True)
class FileEntry:
    """归一化路径条目。

    ``path`` 保留大小写供人读；``key`` 供跨平台比较。
    """

    path: str
    key: str
    outside_cwd: bool = False


def norm_path(abs_or_rel: str, root: str | os.PathLike[str]) -> FileEntry:
    """把任意路径归一化为相对 ``root`` 的 POSIX 路径 + 比较键。

    相对路径按 ``root`` 解析（不是 Python 进程 cwd）。
    """
    root_real = os.path.realpath(os.fspath(root))
    p = os.fspath(abs_or_rel)
    # 相对路径 → 按 root 解析
    if not os.path.isabs(p):
        target_real = os.path.realpath(os.path.join(root_real, p))
    else:
        try:
            target_real = os.path.realpath(p)
        except (OSError, ValueError):
            target_real = os.path.abspath(p)
    try:
        rel = os.path.relpath(target_real, root_real)
    except ValueError:
        # 不同盘符（Windows）
        rel = target_real
    posix = rel.replace(os.sep, "/")
    if posix.startswith("../") or posix == ".." or "/../" in posix:
        outside = True
    else:
        outside = posix.startswith("..") or posix.startswith("/")
    key = posix.casefold() if detect_case_insensitive_fs() else posix
    return FileEntry(path=posix, key=key, outside_cwd=outside)
