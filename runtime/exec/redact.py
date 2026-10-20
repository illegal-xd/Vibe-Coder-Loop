"""输出脱敏 pass。

事实源：MVP-2 §3.3 脱敏规则

只脱敏两类（宁可漏也不误伤，避免破坏 diff/哈希比对）：
1. 等于 env 中敏感变量实际值（精确匹配）；
2. 命中已知高熵前缀（sk-/ghp_/AKIA/eyJ 等）的串。
纯随机 base64 不脱敏。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .env import extract_redaction_targets

_REDACTED = "***REDACTED***"

# 已知密钥前缀 + 紧跟的典型 token 字符
_TOKEN_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"sk-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9]{36,}"),
    re.compile(r"gho_[A-Za-z0-9]{36,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"eyJ[A-Za-z0-9_\-]{20,}\.eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}"),  # JWT
    re.compile(r"xox[bp]-[A-Za-z0-9\-]{20,}"),
]

# .env 文件内容形态：KEY=value 且 KEY 像密钥
_ENV_LINE_RE = re.compile(
    r"(?m)^([A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|"
    r"CREDENTIAL|SESSION|COOKIE|AUTH)[A-Z_]*)=(.+)$"
)


@dataclass
class RedactResult:
    text: str
    redactions: int = 0
    patterns: list[str] = field(default_factory=list)


def redact_output(text: str, env: dict[str, str] | None = None) -> RedactResult:
    """对输出全文执行脱敏，返回替换后文本 + 计数。"""
    if not text:
        return RedactResult(text=text)
    count = 0
    out = text
    # 1. 精确匹配 env 敏感变量值
    if env:
        for value in extract_redaction_targets(env):
            if value and value in out:
                replaced = out.replace(value, _REDACTED)
                if replaced != out:
                    count += out.count(value)
                    out = replaced
    # 2. 高熵前缀串
    for pattern in _TOKEN_PATTERNS:
        new, n = pattern.subn(_REDACTED, out)
        if n:
            count += n
            out = new
    # 3. .env 文件内容形态（KEY=VALUE，KEY 像密钥）
    def _env_repl(m: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return f"{m.group(1)}={_REDACTED}"

    out = _ENV_LINE_RE.sub(_env_repl, out)
    return RedactResult(text=out, redactions=count)
