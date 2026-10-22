"""命令策略：allowlist + 高风险拒绝 + 危险模式检出。

事实源：MVP-2 §3.3.2 行为层

两层声明清楚：
- 注入层（shell=False + argv）已解决；
- 行为层：cwd 不是沙箱；命令本身可干危险事，需显式 allowlist + 高风险拒绝。

**不承诺穷尽**——这是防手滑，不是防对抗。
"""

from __future__ import annotations

import os
import shlex
import sys
from dataclasses import dataclass, field
from typing import Mapping

# 项目工具链 allowlist（只读 git 子命令 + 测试/lint/build）
DEFAULT_ALLOWLIST: frozenset[str] = frozenset(
    {
        # 测试
        "pytest", "vitest", "jest", "cargo", "go", "make",
        # Python 解释器（python -m pytest / python -m unittest / python -m mypy）
        "python", "python3", "py",
        # 包管理器（仅限本地操作子命令）
        "npm", "pnpm", "yarn",
        # lint / 类型检查
        "eslint", "tsc", "ruff", "mypy", "flake8", "pylint",
        # 只读 git 子命令
        "git",
    }
)

# git 子命令白名单（只读）
GIT_READONLY_SUBCMDS: frozenset[str] = frozenset(
    {"status", "diff", "log", "show", "rev-parse", "ls-files", "name-rev", "blame", "ls-tree"}
)

# 高风险命令（默认拒绝）
HIGH_RISK_BINARIES: frozenset[str] = frozenset(
    {
        "rm", "rmdir", "mv", "dd", "truncate", "chmod", "chown",
        "docker", "kubectl", "helm",
    }
)

HIGH_RISK_GIT_SUBCMDS: frozenset[str] = frozenset(
    {"push", "reset", "clean", "checkout", "rebase", "merge", "cherry-pick", "filter-branch"}
)

HIGH_RISK_NPM_SUBCMDS: frozenset[str] = frozenset({"publish", "unpublish"})

# 危险 argv 模式（防手滑）
_DANGER_PATTERNS: list[tuple[str, ...]] = [
    ("sh", "-c",),
    ("bash", "-c",),
    ("rm", "-rf", "/"),
    ("rm", "-rf", "~"),
    ("rm", "-fr", "/"),
    ("chmod", "777", "/"),
]


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    code: str = ""  # "" | SCOPE_DENIED | ENV_ERROR
    reason: str = ""
    next: str = ""
    high_risk: bool = False

    def to_dict(self) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "code": self.code,
            "reason": self.reason,
            "next": self.next,
            "high_risk": self.high_risk,
        }


def _which(cmd: str, env: Mapping[str, str] | None = None) -> str | None:
    """跨平台 which/shutil.which，但用受控 env 而非 os.environ。"""
    path_env = env.get("PATH") if env else os.environ.get("PATH")
    if not path_env:
        return None
    # Windows：PATHEXT
    pathext = ""
    if sys.platform == "win32":
        pathext = (env.get("PATHEXT") if env else os.environ.get("PATHEXT", "")) or ""
    for directory in path_env.split(os.pathsep):
        candidate = os.path.join(directory, cmd)
        if sys.platform == "win32":
            if os.path.isfile(candidate):
                return candidate
            for ext in pathext.split(os.pathsep):
                cand_ext = candidate + ext
                if os.path.isfile(cand_ext):
                    return cand_ext
        elif os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def is_command_available(cmd: str, *, env: Mapping[str, str] | None = None) -> str | None:
    """返回命令的完整路径，不可用则 None。"""
    if os.path.isabs(cmd) or os.path.sep in cmd:
        return cmd if os.path.isfile(cmd) and os.access(cmd, os.X_OK) else None
    return _which(cmd, env)


def check_policy(
    cmd: list[str],
    *,
    allow_high_risk: bool = False,
    extra_allowlist: list[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> PolicyDecision:
    """检查命令是否被策略允许。``cmd`` 是 argv 数组（shell=False 形态）。"""
    if not cmd:
        return PolicyDecision(False, code="ENV_ERROR", reason="命令为空", next="修正命令后重试")
    binary = os.path.basename(cmd[0])

    # 危险模式检出（防手滑，非穷尽）
    for pattern in _DANGER_PATTERNS:
        if len(cmd) >= len(pattern) and tuple(cmd[: len(pattern)]) == pattern:
            if pattern[0] in ("sh", "bash") and len(cmd) >= 3 and "rm" in cmd[2:]:
                return PolicyDecision(
                    False,
                    code="SCOPE_DENIED",
                    reason=f"危险模式检出：{' '.join(pattern[:2])} + rm",
                    next="输出 Conflict Card 或🗑 待删除清单，止步",
                    high_risk=True,
                )
            if pattern[0] == "rm" and pattern[2] in ("/", "~"):
                return PolicyDecision(
                    False,
                    code="SCOPE_DENIED",
                    reason=f"危险模式检出：rm -rf 根/家目录",
                    next="输出 Conflict Card 或🗑 待删除清单，止步",
                    high_risk=True,
                )
            if pattern[0] == "chmod" and pattern[2] == "/":
                return PolicyDecision(
                    False,
                    code="SCOPE_DENIED",
                    reason="危险模式检出：chmod 777 根目录",
                    next="输出 Conflict Card 或🗑 待删除清单，止步",
                    high_risk=True,
                )

    allowlist = DEFAULT_ALLOWLIST | frozenset(extra_allowlist or [])

    # git 子命令细分
    if binary == "git":
        if len(cmd) < 2:
            return PolicyDecision(
                False, code="ENV_ERROR", reason="git 缺少子命令", next="补全子命令后重试"
            )
        sub = cmd[1]
        if sub in HIGH_RISK_GIT_SUBCMDS:
            if not allow_high_risk:
                return PolicyDecision(
                    False,
                    code="SCOPE_DENIED",
                    reason=f"高风险 git 子命令 git {sub}（需 allow_high_risk + 用户授权）",
                    next="经宿主 permission.ask 取得用户授权后设置 allow_high_risk=True",
                    high_risk=True,
                )
            return PolicyDecision(True, high_risk=True)
        if sub in GIT_READONLY_SUBCMDS:
            return PolicyDecision(True)
        # 其他 git 子命令（如 fetch/pull/clone/stash）：默认拒绝（fail-closed）
        # git pull 可执行 hooks 并修改工作区，git clone 可下载任意代码
        return PolicyDecision(
            False, code="SCOPE_DENIED", reason=f"git 子命令 {sub} 未在只读白名单", next="改用只读 git 子命令"
        )

    # npm/pnpm/yarn 子命令细分
    if binary in ("npm", "pnpm", "yarn"):
        if len(cmd) >= 2 and cmd[1] in HIGH_RISK_NPM_SUBCMDS:
            if not allow_high_risk:
                return PolicyDecision(
                    False,
                    code="SCOPE_DENIED",
                    reason=f"高风险 npm 子命令 {binary} {cmd[1]}",
                    next="经宿主 permission.ask 取得用户授权后设置 allow_high_risk=True",
                    high_risk=True,
                )
            return PolicyDecision(True, high_risk=True)
        if binary in allowlist:
            return PolicyDecision(True)
        return PolicyDecision(
            False, code="SCOPE_DENIED", reason=f"{binary} 未在 allowlist", next="扩展 config allowlist"
        )

    # 高风险二进制
    if binary in HIGH_RISK_BINARIES:
        if not allow_high_risk:
            return PolicyDecision(
                False,
                code="SCOPE_DENIED",
                reason=f"高风险命令 {binary}（需 allow_high_risk + 用户授权）",
                next="经宿主 permission.ask 取得用户授权后设置 allow_high_risk=True",
                high_risk=True,
            )
        return PolicyDecision(True, high_risk=True)

    # 通用 allowlist
    if binary in allowlist:
        return PolicyDecision(True)

    # 兜底：拒绝（不做"任意放行"开关）
    return PolicyDecision(
        False,
        code="SCOPE_DENIED",
        reason=f"命令 {binary} 不在 allowlist（项目工具链二进制 / 只读 git 子命令）",
        next="经宿主配置扩展 allowlist，或改用受支持工具",
    )


def parse_command_string(s: str) -> list[str]:
    """把命令字符串拆成 argv（shlex），用于用户从 CLI 传入的场景。"""
    return shlex.split(s, posix=(sys.platform != "win32"))
