"""各框架归一化器（纯函数，只吃有界内存前缀）。

事实源：MVP-2 §四

契约：
- 只解析「退出码 + 统计行 + 失败项名」三类，**不解析完整堆栈**。
- 模式匹配容错：解析失败 → 返回 None（降级为 unknown），不裸抛。
- ``truncated=True`` 时不得报"0 failed"这类假结论——宁可 None。
- ``error_digest`` = sha256 稳定摘要（见 fingerprint.py）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

# 高风险域关键词（auth/金额/删除/迁移/部署/schema/加密/事务）
HIGH_RISK_KEYWORDS: tuple[str, ...] = (
    "auth", "login", "password", "credential", "session", "token",
    "payment", "billing", "invoice", "amount", "price",
    "delete", "drop", "truncate", "migration", "migrate",
    "deploy", "schema", "encrypt", "decrypt", "sign",
    "transaction", "commit", "rollback",
)


def scan_high_risk(items: list[str]) -> bool:
    """检测失败项是否触及高风险域。"""
    text = " ".join(items).lower()
    return any(kw in text for kw in HIGH_RISK_KEYWORDS)


def stable_digest(items: list[str]) -> str:
    """失败项集合的稳定摘要（sha256），供指纹。"""
    import hashlib

    if not items:
        return ""
    payload = "\n".join(items).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


@dataclass
class NormalizedResult:
    kind: str  # test / lint / build / diff / generic
    pass_count: int | None = None
    fail_count: int | None = None
    skip_count: int | None = None
    error_summaries: list[str] = field(default_factory=list)
    error_digest: str = ""
    high_risk_hit: bool = False
    stats_raw: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "pass_count": self.pass_count,
            "fail_count": self.fail_count,
            "skip_count": self.skip_count,
            "error_summaries": list(self.error_summaries),
            "error_digest": self.error_digest,
            "high_risk_hit": self.high_risk_hit,
            "stats_raw": self.stats_raw,
        }


def infer_lang(cmd: list[str]) -> str:
    """按 cmd[0] basename + 子命令推断归一化器。"""
    if not cmd:
        return "generic"
    binary = cmd[0]
    base = binary.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if base == "pytest" or base == "python" and any("pytest" in a for a in cmd[1:]):
        return "pytest"
    if base == "vitest" or (base in ("npm", "pnpm", "yarn") and "vitest" in cmd[1:]):
        return "vitest"
    if base in ("jest",) or (base in ("npm", "pnpm", "yarn") and "jest" in cmd[1:]):
        return "jest"
    if base == "cargo":
        return "cargo"
    if base == "eslint":
        return "eslint"
    if base in ("tsc",):
        return "tsc"
    if base == "git":
        return "git_diff"
    if base == "ruff" or base == "flake8" or base == "pylint" or base == "mypy":
        return base
    return "generic"


def normalize(
    lang: str,
    head_out: str,
    head_err: str,
    exit_code: int,
    cmd: list[str],
    *,
    truncated: bool = False,
) -> NormalizedResult | None:
    """归一化入口。只吃有界内存前缀，不引入内存放大。"""
    if lang == "auto":
        lang = infer_lang(cmd)
    fn = DISPATCH.get(lang)
    return fn(head_out, head_err, exit_code, truncated) if fn else None


# ---------------------------------------------------------------------------
# pytest
# ---------------------------------------------------------------------------

_PYTEST_STATS_RE = re.compile(
    r"(\d+) passed(?:[,\s]+(\d+) failed)?(?:[,\s]+(\d+)[\s\w]*skip(?:ped)?)?"
    r"|(?:^|\s)(\d+) failed(?:[,\s]+(\d+) passed)?"
    r"|(?:^|\s)(\d+) skipped",
    re.M,
)
_PYTEST_FAILED_RE = re.compile(r"^(?:FAILED|ERROR)\s+(.+?)(?:\s+-\s+.*)?$", re.M)


def _norm_pytest(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    tail = head_out[-4000:] if head_out else ""
    passed = failed = skipped = None
    m = _PYTEST_STATS_RE.search(tail)
    if m:
        if m.group(1) is not None:
            passed = int(m.group(1))
            failed = int(m.group(2)) if m.group(2) else 0
            skipped = int(m.group(3)) if m.group(3) else 0
        elif m.group(4) is not None:
            failed = int(m.group(4))
            passed = int(m.group(5)) if m.group(5) else 0
            skipped = 0
        elif m.group(6) is not None:
            skipped = int(m.group(6))
    if m is None and truncated:
        # 统计行可能已被截断 → 不猜
        return None
    if m is None:
        # 无统计行：按 exit code 判定
        if exit_code == 0:
            return NormalizedResult(kind="test", pass_count=0, fail_count=0, stats_raw="ok")
        return None
    fails = [line.strip().split("::")[0] if "::" not in line else line.strip()
             for line in _PYTEST_FAILED_RE.findall(head_out)]
    fails = _PYTEST_FAILED_RE.findall(head_out)
    fails = [f.strip() for f in fails[:10]]
    return NormalizedResult(
        kind="test",
        pass_count=passed,
        fail_count=failed,
        skip_count=skipped,
        error_summaries=fails,
        error_digest=stable_digest(fails),
        high_risk_hit=scan_high_risk(fails),
        stats_raw=m.group(0).strip(),
    )


# ---------------------------------------------------------------------------
# vitest / jest（输出格式接近）
# ---------------------------------------------------------------------------

_VITEST_STATS_RE = re.compile(
    r"Tests?\s+(\d+)\s+(?:failed|fail)(?:.*?(\d+)\s+passed)?", re.I | re.S
)
_VITEST_PASSED_RE = re.compile(r"Tests?\s+(\d+)\s+passed", re.I)
_JEST_STATS_RE = re.compile(
    r"Tests?\s*:\s*(?:(\d+)\s+failed)?[,\s]*(?:(\d+)\s+passed)?[,\s]*(?:(\d+)\s+total)?",
    re.I,
)
_FAIL_NAME_RE = re.compile(r"(?:FAIL|✕|✗|failed)\s+(.+?)(?:\s|$)", re.M)


def _norm_vitest(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    text = (head_out or "")[-4000:]
    failed = passed = None
    m = _VITEST_STATS_RE.search(text)
    if m:
        failed = int(m.group(1))
        passed = int(m.group(2)) if m.group(2) else 0
    if failed is None or passed is None:
        mp = _VITEST_PASSED_RE.search(text)
        if mp:
            passed = int(mp.group(1))
            if failed is None:
                failed = 0
    if failed is None and passed is None:
        if truncated:
            return None
        if exit_code == 0:
            return NormalizedResult(kind="test", pass_count=0, fail_count=0, stats_raw="ok")
        return None
    fails = [f.strip() for f in _FAIL_NAME_RE.findall(head_out)[:10]]
    return NormalizedResult(
        kind="test",
        pass_count=passed,
        fail_count=failed,
        error_summaries=fails,
        error_digest=stable_digest(fails),
        high_risk_hit=scan_high_risk(fails),
        stats_raw=(m.group(0).strip() if m else "ok"),
    )


def _norm_jest(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    text = (head_out or "")[-4000:]
    m = _JEST_STATS_RE.search(text)
    failed = passed = total = None
    if m:
        failed = int(m.group(1)) if m.group(1) else 0
        passed = int(m.group(2)) if m.group(2) else 0
        total = int(m.group(3)) if m.group(3) else None
    if m is None and truncated:
        return None
    if m is None:
        if exit_code == 0:
            return NormalizedResult(kind="test", pass_count=0, fail_count=0, stats_raw="ok")
        return None
    fails = [f.strip() for f in _FAIL_NAME_RE.findall(head_out)[:10]]
    return NormalizedResult(
        kind="test",
        pass_count=passed,
        fail_count=failed,
        skip_count=(total - passed - failed) if total is not None and passed is not None and failed is not None else None,
        error_summaries=fails,
        error_digest=stable_digest(fails),
        high_risk_hit=scan_high_risk(fails),
        stats_raw=m.group(0).strip(),
    )


# ---------------------------------------------------------------------------
# cargo
# ---------------------------------------------------------------------------

_CARGO_STATS_RE = re.compile(
    r"test result: (\w+)\.+\s+(\d+) passed(?:.*?(\d+) failed)?(?:.*?(\d+) ignored)?",
    re.I,
)
_CARGO_FAIL_RE = re.compile(r"^test .* FAILED", re.M)


def _norm_cargo(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    text = (head_out or "") + (head_err or "")
    matches = list(_CARGO_STATS_RE.finditer(text[-4000:]))
    if not matches and truncated:
        return None
    if not matches:
        if exit_code == 0:
            return NormalizedResult(kind="test", pass_count=0, fail_count=0, stats_raw="ok")
        return None
    total_pass = sum(int(m.group(2)) for m in matches)
    total_fail = sum(int(m.group(3)) if m.group(3) else 0 for m in matches)
    total_ign = sum(int(m.group(4)) if m.group(4) else 0 for m in matches)
    fails = [line.strip() for line in _CARGO_FAIL_RE.findall(head_out)[:10]]
    return NormalizedResult(
        kind="test",
        pass_count=total_pass,
        fail_count=total_fail,
        skip_count=total_ign,
        error_summaries=fails,
        error_digest=stable_digest(fails),
        high_risk_hit=scan_high_risk(fails),
        stats_raw=matches[-1].group(0).strip(),
    )


# ---------------------------------------------------------------------------
# eslint
# ---------------------------------------------------------------------------

_ESLINT_STATS_RE = re.compile(
    r"(\d+)\s+(?:problem|error|warning)s?", re.I
)
_ESLINT_ERROR_RE = re.compile(r"^\s*(\S+)\n\s+\d+:\d+\s+(error|warning)\s+(.+)$", re.M)


def _norm_eslint(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    text = head_out or ""
    # eslint 输出：✖ N problems (M errors, K warnings)
    m = re.search(r"(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)", text, re.I)
    if not m and truncated:
        return None
    if not m:
        if exit_code == 0:
            return NormalizedResult(kind="lint", pass_count=0, fail_count=0, stats_raw="ok")
        return None
    errors = int(m.group(2))
    warnings = int(m.group(3))
    fails = [f"error: {line.strip()}" for line in re.findall(r"\d+:\d+\s+error\s+(.+)$", text, re.M)[:10]]
    return NormalizedResult(
        kind="lint",
        pass_count=0,
        fail_count=errors,
        skip_count=warnings,
        error_summaries=fails,
        error_digest=stable_digest(fails),
        high_risk_hit=scan_high_risk(fails),
        stats_raw=m.group(0).strip(),
    )


# ---------------------------------------------------------------------------
# tsc
# ---------------------------------------------------------------------------

_TSC_ERROR_RE = re.compile(r"^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$", re.M)


def _norm_tsc(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    text = head_err or head_out
    errors = _TSC_ERROR_RE.findall(text)
    if not errors and truncated:
        return None
    if not errors:
        if exit_code == 0:
            return NormalizedResult(kind="build", pass_count=0, fail_count=0, stats_raw="ok")
        return None
    fails = [f"TS{e[3]}: {e[4].strip()} ({e[0]}:{e[1]})" for e in errors[:10]]
    return NormalizedResult(
        kind="build",
        pass_count=0,
        fail_count=len(errors),
        error_summaries=fails,
        error_digest=stable_digest(fails),
        high_risk_hit=scan_high_risk(fails),
        stats_raw=f"{len(errors)} errors",
    )


# ---------------------------------------------------------------------------
# ruff / flake8 / pylint / mypy
# ---------------------------------------------------------------------------

def _norm_ruff(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    text = head_out or ""
    # ruff: "Found N errors"
    m = re.search(r"Found\s+(\d+)\s+error", text, re.I)
    fails = [line.strip() for line in text.splitlines() if ":" in line and re.search(r"[A-Z]\d+", line)][:10]
    if not m and not fails:
        if truncated:
            return None
        if exit_code == 0:
            return NormalizedResult(kind="lint", fail_count=0, stats_raw="ok")
        return None
    count = int(m.group(1)) if m else len(fails)
    return NormalizedResult(
        kind="lint",
        fail_count=count,
        error_summaries=fails,
        error_digest=stable_digest(fails),
        high_risk_hit=scan_high_risk(fails),
        stats_raw=(m.group(0).strip() if m else f"{count} issues"),
    )


def _norm_flake8(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    text = head_out or ""
    # flake8: file:line:col: CODE message
    fails = [line.strip() for line in text.splitlines() if re.match(r"^.+?:\d+:\d+: ", line)][:10]
    if not fails and truncated:
        return None
    if not fails and exit_code == 0:
        return NormalizedResult(kind="lint", fail_count=0, stats_raw="ok")
    return NormalizedResult(
        kind="lint",
        fail_count=len(fails),
        error_summaries=fails,
        error_digest=stable_digest(fails),
        high_risk_hit=scan_high_risk(fails),
        stats_raw=f"{len(fails)} issues",
    )


_norm_pylint = _norm_flake8  # 格式兼容


def _norm_mypy(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    text = head_out or ""
    fails = [line.strip() for line in text.splitlines() if re.match(r"^.+?:\d+: error:", line)][:10]
    m = re.search(r"Found\s+(\d+)\s+error", text, re.I)
    if not fails and not m and truncated:
        return None
    if not fails and not m:
        if exit_code == 0:
            return NormalizedResult(kind="build", fail_count=0, stats_raw="ok")
        return None
    count = int(m.group(1)) if m else len(fails)
    return NormalizedResult(
        kind="build",
        fail_count=count,
        error_summaries=fails,
        error_digest=stable_digest(fails),
        high_risk_hit=scan_high_risk(fails),
        stats_raw=(m.group(0).strip() if m else f"{count} errors"),
    )


# ---------------------------------------------------------------------------
# git diff（降级用，主路径见 diff.py）
# ---------------------------------------------------------------------------

def _norm_git_diff(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    # diff.py 负责 DiffSummary；这里仅作 generic 降级
    return NormalizedResult(
        kind="diff",
        stats_raw="git diff（详见 DiffSummary）",
    )


# ---------------------------------------------------------------------------
# generic
# ---------------------------------------------------------------------------

def _norm_generic(head_out: str, head_err: str, exit_code: int, truncated: bool) -> NormalizedResult | None:
    """未知框架降级：只报 exit code 语义，不猜统计。"""
    if exit_code == 0:
        return NormalizedResult(kind="generic", pass_count=0, fail_count=0, stats_raw="ok" if not truncated else "ok（输出已截断）")
    # 失败：取 stderr 末尾几行作为摘要
    tail = (head_err or head_out or "")[-1000:]
    lines = [ln.strip() for ln in tail.splitlines() if ln.strip()][-10:]
    return NormalizedResult(
        kind="generic",
        fail_count=1,
        error_summaries=lines,
        error_digest=stable_digest(lines),
        stats_raw="输出已截断" if truncated else (lines[-1] if lines else "failed"),
    )


DISPATCH: dict[str, Callable[..., NormalizedResult | None]] = {
    "pytest": _norm_pytest,
    "vitest": _norm_vitest,
    "jest": _norm_jest,
    "cargo": _norm_cargo,
    "eslint": _norm_eslint,
    "tsc": _norm_tsc,
    "ruff": _norm_ruff,
    "flake8": _norm_flake8,
    "pylint": _norm_pylint,
    "mypy": _norm_mypy,
    "git_diff": _norm_git_diff,
    "generic": _norm_generic,
}
