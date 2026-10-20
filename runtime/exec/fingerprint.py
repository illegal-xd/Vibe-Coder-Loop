"""失败指纹（稳定、规范化、可解释）。

事实源：MVP-2 §5.1

四项缺陷修正：
- 内置 hash() 跨进程不稳定 → sha256；
- 集合包含代替"连续"判断 → 连续只由 last_fp + count 表达（Core 侧）；
- 连续计数只在内存 → 持久化（Core 侧）；
- 指纹含 stage 导致同错跨阶段被算两次 → **stage 不进指纹**。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
from typing import Any

FINGERPRINT_VERSION = 1

# 只影响冗长度的开关，不进指纹
_NOISE_FLAGS = {
    "-v", "-vv", "-vvv", "--verbose", "--quiet", "-q", "--no-header",
    "--color", "--no-color", "--tb=short", "--tb=long", "--tb=line",
}


def tool_identity(cmd: list[str]) -> str:
    """cmd[0] 的 basename（+ npm/pnpm 脚本名）。"""
    if not cmd:
        return "unknown"
    binary = cmd[0]
    base = os.path.basename(binary)
    # npm/pnpm/yarn run <script>
    if base in ("npm", "pnpm", "yarn") and len(cmd) >= 2:
        return f"{base}:{cmd[1]}"
    # python -m pytest
    if base in ("python", "python3", "py") and len(cmd) >= 3 and cmd[1] == "-m":
        return f"python:-m:{cmd[2]}"
    return base


def normalize_args(args: list[str], cwd: str) -> list[str]:
    """去掉 cwd 绝对路径前缀、去噪音开关、去临时输出路径。"""
    cwd_real = os.path.realpath(cwd)
    result: list[str] = []
    skip_next = False
    i = 0
    while i < len(args):
        arg = args[i]
        if skip_next:
            skip_next = False
            i += 1
            continue
        # 噪音开关
        if arg in _NOISE_FLAGS:
            i += 1
            continue
        # 带值的噪音开关
        if arg in ("--maxfail", "--timeout", "-x") and i + 1 < len(args):
            i += 2
            continue
        # 绝对路径 → 相对 cwd
        if os.path.isabs(arg):
            try:
                rel = os.path.relpath(arg, cwd_real)
                if not rel.startswith(".."):
                    arg = rel
            except ValueError:
                pass
        # 临时输出路径（--junitxml=..., --output=...）
        if "=" in arg and re.match(r"--?\w+", arg.split("=")[0]):
            key, _val = arg.split("=", 1)
            arg = key + "=<path>"
        result.append(arg)
        i += 1
    return result


def stable_digest(text: str) -> str:
    """stderr 前缀的稳定摘要（无失败项列表时的兜底）。"""
    if not text:
        return ""
    # 取末尾窗口的非空行
    lines = [ln.strip() for ln in text[-2000:].splitlines() if ln.strip()]
    payload = "\n".join(lines[-10:]).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def compute_fingerprint(
    cmd: list[str],
    exit_code: int,
    norm: Any,
    *,
    stderr_head: str = "",
    cwd: str = ".",
) -> str:
    """稳定指纹：同一失败重复出现可机械判定。

    规范化输入 = 一个 JSON 对象（键排序后序列化），不用字符串拼接。
    """
    digest = ""
    if norm is not None:
        digest = getattr(norm, "error_digest", "") or ""
    if not digest:
        digest = stable_digest(stderr_head)

    payload = {
        "v": FINGERPRINT_VERSION,
        "tool": tool_identity(cmd),
        "args": normalize_args(list(cmd[1:]), cwd),
        "exit": int(exit_code),
        "digest": digest,
    }
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return "fp:" + hashlib.sha256(canonical).hexdigest()
