"""Vibe Kernel Workflow Core（MVP-1）。

只负责状态：合法转换校验、Checkpoint 原子读写、恢复协议机械执行、VC 码判定。
判断（架构方案 / 审查结论 / 下一步动作）仍归 LLM。
"""

from . import vc_codes
from .artifacts import ArtifactCheck, ArtifactStore, GCResult
from .checkpoint import (
    REQUIRED_FIELDS,
    RESERVED_KEYS,
    SEMANTIC_FIELDS,
    STATE_SCHEMA_VERSION,
    CheckpointError,
    CheckpointLocationError,
    CheckpointStore,
    CorruptCheckpoint,
    ResolvedState,
    Snapshot,
    StateResolver,
    WriteResult,
    normalize_fields,
    state_code,
)
from .core import ExecResult, FeedResult, RepeatResult, StateView, WorkflowCore
from .protocol import ProtocolReport, check_protocol
from .recovery import PendingCheck, RecoveryResult, age_minutes, load_checkpoint, verify_pending
from .safemode import SAFE_MODE_ENFORCED, SAFE_MODE_OBSERVED, SafeModeDecision, evaluate
from .state_machine import (
    ESCALATION_EDGES,
    LEGAL_TRANSITIONS,
    LOOP_RULES,
    PAUSE,
    RESUME,
    STATE_LABELS,
    ExitChecklist,
    TransitionResult,
    loop_max,
    transition,
)

__all__ = [
    "vc_codes",
    "ArtifactCheck",
    "ArtifactStore",
    "GCResult",
    "REQUIRED_FIELDS",
    "RESERVED_KEYS",
    "SEMANTIC_FIELDS",
    "STATE_SCHEMA_VERSION",
    "CheckpointError",
    "CheckpointLocationError",
    "CheckpointStore",
    "CorruptCheckpoint",
    "ResolvedState",
    "Snapshot",
    "StateResolver",
    "WriteResult",
    "normalize_fields",
    "state_code",
    "ExecResult",
    "FeedResult",
    "RepeatResult",
    "StateView",
    "WorkflowCore",
    "ProtocolReport",
    "check_protocol",
    "PendingCheck",
    "RecoveryResult",
    "age_minutes",
    "load_checkpoint",
    "verify_pending",
    "SAFE_MODE_ENFORCED",
    "SAFE_MODE_OBSERVED",
    "SafeModeDecision",
    "evaluate",
    "ESCALATION_EDGES",
    "LEGAL_TRANSITIONS",
    "LOOP_RULES",
    "PAUSE",
    "RESUME",
    "STATE_LABELS",
    "ExitChecklist",
    "TransitionResult",
    "loop_max",
    "transition",
]
