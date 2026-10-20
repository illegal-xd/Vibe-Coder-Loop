"""VC 错误码：协议码与运行时扩展码两族分离。

事实源：
- 协议码：skills/vibe-coder-loop/engine/transition.md「VC 错误码族」
- 运行时码：同文件「运行时扩展码」表（使用 ``[runtime]`` 前缀）

铁律：不带 ``[next]`` 的输出不构成错误码。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

# ---------------------------------------------------------------------------
# 协议码（语义不得由 Core 改动）
# ---------------------------------------------------------------------------
RULE_NOT_LOADED = "RULE_NOT_LOADED"
RULE_NOT_FOUND = "RULE_NOT_FOUND"
LOAD_PLAN_MISSING = "LOAD_PLAN_MISSING"
RULE_STORE_MISSING = "RULE_STORE_MISSING"
EVIDENCE_INSUFFICIENT = "EVIDENCE_INSUFFICIENT"
SCOPE_DENIED = "SCOPE_DENIED"
PLAN_DRIFT = "PLAN_DRIFT"
NO_PROGRESS = "NO_PROGRESS"
LOOP_BUDGET_EXHAUSTED = "LOOP_BUDGET_EXHAUSTED"
OUTPUT_LIMIT = "OUTPUT_LIMIT"
ARTIFACT_NOT_FOUND = "ARTIFACT_NOT_FOUND"

# Tool 层运维码（补充登记，非工作流判定）
INVALID_ARGUMENT = "INVALID_ARGUMENT"
ARTIFACT_SOURCE_MISSING = "ARTIFACT_SOURCE_MISSING"
ARTIFACT_NAME_INVALID = "ARTIFACT_NAME_INVALID"
ARTIFACT_REF_INVALID = "ARTIFACT_REF_INVALID"
DB_NOT_FOUND = "DB_NOT_FOUND"
KEYS_CHECK_INPUT_MISSING = "KEYS_CHECK_INPUT_MISSING"

# ---------------------------------------------------------------------------
# 运行时扩展码（Core 新增，输出时带 [runtime] 前缀）
# ---------------------------------------------------------------------------
STATE_ILLEGAL_TRANSITION = "STATE_ILLEGAL_TRANSITION"
STATE_REV_CONFLICT = "STATE_REV_CONFLICT"
EXIT_CHECKLIST_INCOMPLETE = "EXIT_CHECKLIST_INCOMPLETE"
CHECKPOINT_LOCATION_UNRESOLVED = "CHECKPOINT_LOCATION_UNRESOLVED"
CHECKPOINT_FOREIGN = "CHECKPOINT_FOREIGN"
CHECKPOINT_STALE = "CHECKPOINT_STALE"
CHECKPOINT_DEGRADED = "CHECKPOINT_DEGRADED"
CHECKPOINT_CORRUPT = "CHECKPOINT_CORRUPT"
CHECKPOINT_SCHEMA_AHEAD = "CHECKPOINT_SCHEMA_AHEAD"
CHECKPOINT_WRITE_FAILED = "CHECKPOINT_WRITE_FAILED"
PROTOCOL_DRIFT = "PROTOCOL_DRIFT"
PHASE_TRANSITION_MISSING = "PHASE_TRANSITION_MISSING"

# 运行期警告（非 fail-closed，未登记为正式 VC 码）
STATE_TRACKED_BY_GIT = "STATE_TRACKED_BY_GIT"

# Exec 层运行时码（runtime/exec 产生；非工作流判定，不消耗 Loop）
ENV_ERROR = "ENV_ERROR"
TIMEOUT = "TIMEOUT"
CANCELLED = "CANCELLED"

PROTOCOL_CODES = frozenset(
    {
        RULE_NOT_LOADED,
        RULE_NOT_FOUND,
        LOAD_PLAN_MISSING,
        RULE_STORE_MISSING,
        EVIDENCE_INSUFFICIENT,
        SCOPE_DENIED,
        PLAN_DRIFT,
        NO_PROGRESS,
        LOOP_BUDGET_EXHAUSTED,
        OUTPUT_LIMIT,
        ARTIFACT_NOT_FOUND,
    }
)

RUNTIME_CODES = frozenset(
    {
        STATE_ILLEGAL_TRANSITION,
        STATE_REV_CONFLICT,
        EXIT_CHECKLIST_INCOMPLETE,
        CHECKPOINT_LOCATION_UNRESOLVED,
        CHECKPOINT_FOREIGN,
        CHECKPOINT_STALE,
        CHECKPOINT_DEGRADED,
        CHECKPOINT_CORRUPT,
        CHECKPOINT_SCHEMA_AHEAD,
        CHECKPOINT_WRITE_FAILED,
        PROTOCOL_DRIFT,
        PHASE_TRANSITION_MISSING,
        STATE_TRACKED_BY_GIT,
        ENV_ERROR,
        TIMEOUT,
        CANCELLED,
    }
)

# fail-closed 码集合（不得降级继续）
FAIL_CLOSED = frozenset(
    {
        RULE_NOT_FOUND,
        LOAD_PLAN_MISSING,
        RULE_STORE_MISSING,
        SCOPE_DENIED,
        NO_PROGRESS,
        LOOP_BUDGET_EXHAUSTED,
        STATE_ILLEGAL_TRANSITION,
        STATE_REV_CONFLICT,
        EXIT_CHECKLIST_INCOMPLETE,
        CHECKPOINT_LOCATION_UNRESOLVED,
        CHECKPOINT_WRITE_FAILED,
        CHECKPOINT_CORRUPT,
        CHECKPOINT_SCHEMA_AHEAD,
        CHECKPOINT_DEGRADED,
        CHECKPOINT_FOREIGN,
        PROTOCOL_DRIFT,
    }
)

# 每码唯一确定的下一个动作（[next]）
NEXT_ACTIONS: dict[str, str] = {
    RULE_NOT_LOADED: "加载对应文件后重跑本阶段出口",
    RULE_NOT_FOUND: "从 git 恢复该文件，或修正 load_plan.json",
    LOAD_PLAN_MISSING: "从 git 恢复；临时应急用 --files 显式给出清单",
    RULE_STORE_MISSING: "执行 memory_tool.py restore；仍不可用则停止",
    EVIDENCE_INSUFFICIENT: "补 E2+ 证据（read / grep / codegraph），或降级为追问",
    SCOPE_DENIED: "输出 Conflict Card 或「🗑 待删除清单」，止步",
    PLAN_DRIFT: "补记偏离理由；范围变更则回 S7 重规划",
    NO_PROGRESS: "进 S14 SAFE MODE，输出风险报告",
    LOOP_BUDGET_EXHAUSTED: "停止并建议升级 Loop 深度或人工介入",
    OUTPUT_LIMIT: "分页续取（artifact page --offset）",
    ARTIFACT_NOT_FOUND: "artifact list 核对；源在则重新 put",
    INVALID_ARGUMENT: "修正参数后重试",
    ARTIFACT_SOURCE_MISSING: "核对源文件路径",
    ARTIFACT_NAME_INVALID: "改用纯文件名（不含路径分隔符）",
    ARTIFACT_REF_INVALID: "核验 artifact index 是否被篡改",
    DB_NOT_FOUND: "显式传 --db 或设置 DELX_MEMORY_DB",
    KEYS_CHECK_INPUT_MISSING: "用 stdin 或 --files 传入 key 清单",
    STATE_ILLEGAL_TRANSITION: "回退执行当前阶段出口清单",
    STATE_REV_CONFLICT: "重新读取状态后重放本次转换",
    EXIT_CHECKLIST_INCOMPLETE: "补齐缺项后重试",
    CHECKPOINT_LOCATION_UNRESOLVED: "显式传 --cwd / --state-dir 或设 VIBE_KERNEL_STATE_DIR",
    CHECKPOINT_FOREIGN: "备份该文件，按全新任务开始",
    CHECKPOINT_STALE: "核验 pending 后续跑；与用户输入冲突以用户为准",
    CHECKPOINT_DEGRADED: "仅按 phase/loop 续跑，列表字段重新核验",
    CHECKPOINT_CORRUPT: "备份旧文件后全新开始",
    CHECKPOINT_SCHEMA_AHEAD: "按新版协议手动恢复；Core 不写入",
    CHECKPOINT_WRITE_FAILED: "检查目录权限或磁盘后重试；可手动维护状态",
    PROTOCOL_DRIFT: "同步代码表或修正事实源，再跑 check-protocol",
    PHASE_TRANSITION_MISSING: "若已出口则调用 vc_transition 并传 exit_checklist",
    STATE_TRACKED_BY_GIT: "git rm --cached 该状态文件（Core 不执行 git 写操作）",
    ENV_ERROR: "命令不存在或环境不可用；修正命令/PATH 后重试（不消耗 Loop）",
    TIMEOUT: "命令超时，整进程树已终止；缩小范围或提高 timeout 后重试（不消耗 Loop）",
    CANCELLED: "执行被取消（用户中断/Adapter Esc），整树已终止；确认是否继续该步骤",
}


def is_runtime(code: str) -> bool:
    return code in RUNTIME_CODES


def is_fail_closed(code: str) -> bool:
    return code in FAIL_CLOSED


def next_action(code: str, default: str = "按错误事实修复后重试") -> str:
    return NEXT_ACTIONS.get(code, default)


@dataclass(frozen=True)
class VCCode:
    """结构化错误码：事实 + 唯一确定的下一个动作。"""

    code: str
    fact: str
    action: str
    fail_closed: bool = False
    details: Mapping[str, Any] = field(default_factory=dict)

    @property
    def runtime(self) -> bool:
        return is_runtime(self.code)

    @property
    def tag(self) -> str:
        return f"[{self.code}]"

    @property
    def message(self) -> str:
        prefix = "[runtime] " if self.runtime else ""
        return f"{self.tag} {self.fact}" if not prefix else f"{prefix}{self.tag} {self.fact}"

    def format(self) -> str:
        return f"{self.message}\n[next] {self.action}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "next": self.action,
            "runtime": self.runtime,
            "fail_closed": self.fail_closed,
            **({"details": dict(self.details)} if self.details else {}),
        }


def make_code(
    code: str,
    fact: str,
    *,
    action: str | None = None,
    details: Mapping[str, Any] | None = None,
) -> VCCode:
    return VCCode(
        code=code,
        fact=fact,
        action=action or next_action(code),
        fail_closed=is_fail_closed(code),
        details=details or {},
    )
