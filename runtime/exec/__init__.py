"""Vibe Kernel Execution & Verification（MVP-2）。

事实源：docs/design/mvp-2-execution-verification.md

职责：本地命令执行 + 结果归一化 + Diff 汇总 + 重复失败检测。
原则：纯函数为主，可独立于 Core 测试；输出有界（执行期即有界）。
"""

from .runner import ExecRequest, ExecResult, run
from .sink import Sink
from .env import build_env, BASE_ENV_ALLOWLIST, SECRET_NAME_RE
from .redact import redact_output, RedactResult
from .policy import PolicyDecision, check_policy, is_command_available
from .proc_tree import kill_process_tree
from .normalizers import NormalizedResult, normalize
from .fingerprint import compute_fingerprint, FINGERPRINT_VERSION
from .pathnorm import norm_path, FileEntry, detect_case_insensitive_fs
from .diff import DiffSummary, FileEntry as DiffFileEntry, PlanDrift, summarize_diff
from .artifact_io import ArtifactSink, ArtifactPutResult

__all__ = [
    "ExecRequest",
    "ExecResult",
    "run",
    "Sink",
    "build_env",
    "BASE_ENV_ALLOWLIST",
    "SECRET_NAME_RE",
    "redact_output",
    "RedactResult",
    "PolicyDecision",
    "check_policy",
    "is_command_available",
    "kill_process_tree",
    "NormalizedResult",
    "normalize",
    "compute_fingerprint",
    "FINGERPRINT_VERSION",
    "norm_path",
    "FileEntry",
    "detect_case_insensitive_fs",
    "DiffSummary",
    "DiffFileEntry",
    "PlanDrift",
    "summarize_diff",
    "ArtifactSink",
    "ArtifactPutResult",
]
