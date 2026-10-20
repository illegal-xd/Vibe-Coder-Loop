"""受控环境继承 + 敏感变量名匹配。

事实源：MVP-2 §3.3 env 策略

修正原设计 ``env=req.env`` 的语义错误：subprocess 的 env 是整体替换，
传 {FOO:1} 会让子进程没有 PATH。定案 allowlist 继承 + env_passthrough + env_extra。
"""

from __future__ import annotations

import re
import sys
from typing import Any, Mapping

# 基础 allowlist：跨平台必需项
BASE_ENV_ALLOWLIST: list[str] = [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    # Windows 必需项
    "SystemRoot",
    "SystemDrive",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
]

SECRET_NAME_RE = re.compile(
    r"(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|"
    r"CREDENTIAL|SESSION|COOKIE|AUTH)",
    re.I,
)

# 高熵串常见前缀（脱敏用，不穷尽）
_HIGH_ENTROPY_PREFIXES = ("sk-", "ghp_", "gho_", "github_pat_", "AKIA", "eyJ", "xoxb-", "xoxp-")


def is_secret_name(name: str) -> bool:
    """判断环境变量名是否像密钥。"""
    return bool(SECRET_NAME_RE.search(name))


def build_env(
    req_env_extra: Mapping[str, str] | None = None,
    *,
    env_passthrough: list[str] | tuple[str, ...] = (),
    host_env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """构造子进程环境：allowlist 继承 + passthrough + extra。

    extra 中的密钥类变量会出现在子进程环境里（供命令使用），但脱敏 pass
    会从输出里抹掉它们的值。
    """
    source = dict(host_env if host_env is not None else __import__("os").environ)
    env: dict[str, str] = {}
    for key in BASE_ENV_ALLOWLIST:
        if key in source:
            env[key] = source[key]
    for key in env_passthrough:
        if key in source:
            env[key] = source[key]
    if req_env_extra:
        for key, value in req_env_extra.items():
            env[str(key)] = str(value)
    # 强制保证 PATH 存在（Windows 缺 PATH 大量工具异常）
    if "PATH" not in env and sys.platform == "win32":
        # 兜底：从 host 取
        if "PATH" in source:
            env["PATH"] = source["PATH"]
    return env


def collect_secret_values(env: Mapping[str, str]) -> list[str]:
    """收集 env 中所有密钥类变量的实际值（供脱敏精确匹配）。"""
    values: list[str] = []
    for key, value in env.items():
        if is_secret_name(key) and value:
            values.append(value)
    return values


def extract_redaction_targets(env: Mapping[str, str]) -> list[str]:
    """合并：密钥变量实际值 + 高熵前缀串。未命中不猜。"""
    targets = collect_secret_values(env)
    return [t for t in targets if len(t) >= 8]  # 太短的值不脱敏（易误伤）
