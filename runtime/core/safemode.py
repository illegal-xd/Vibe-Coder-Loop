"""SAFE MODE（S14）触发判定。

原则（docs/design/mvp-1-workflow-core.md §3.4）：
- Phase 1 只强制**可确定性判定、可稳定测试**的触发条件；
- 统计型指标只观测、不切态。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from . import vc_codes
from .state_machine import loop_max

# Phase 1 强制触发（deterministic）
SAFE_MODE_ENFORCED: dict[str, int | bool] = {
    "consecutive_same_failures": 2,
    "loop_budget_exhausted": True,
    "hard_constraint_violation": 1,
}

# Phase 1 只观测（写入 metrics，不改变状态）
SAFE_MODE_OBSERVED: dict[str, int | float] = {
    "files_touched": 10,
    "hard_violation_repeats": 3,
    "failure_type_share": 0.15,
    "loops_vs_avg_ratio": 1.5,
}

# 强制触发键 ↔ manifest `tunable_parameters.safe_mode_triggers` 键的对照
# （值允许项目覆盖；键不允许单边新增——由 check-protocol 断言）
SAFE_MODE_SOURCES: dict[str, str] = {
    "consecutive_same_failures": "consecutive_loops",
    "loop_budget_exhausted": "loop_max",
    "hard_constraint_violation": "hard_violation_repeats",
}

SAFE_MODE_REASONS = (
    "consecutive_same_failures",
    "loop_budget_exhausted",
    "hard_constraint_violation",
)


@dataclass(frozen=True)
class SafeModeDecision:
    triggered: bool
    reason: str = ""
    vc_code: str = ""
    action: str = ""
    observed: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "triggered": self.triggered,
            "reason": self.reason,
            "observed": dict(self.observed),
        }
        if self.vc_code:
            data.update(vc_codes.make_code(self.vc_code, self.reason).to_dict())
        return data


def evaluate(
    *,
    consecutive_count: int = 0,
    loop: int = 0,
    level: int = 0,
    hard_constraint_violation: bool = False,
    loop_max_override: int | None = None,
    metrics: Mapping[str, Any] | None = None,
) -> SafeModeDecision:
    """确定性判定；统计型指标只随 observed 返回，不参与 triggered。"""
    observed = dict(metrics or {})
    if hard_constraint_violation:
        return SafeModeDecision(
            triggered=True,
            reason="hard_constraint_violation",
            vc_code=vc_codes.SCOPE_DENIED,
            action=vc_codes.next_action(vc_codes.SCOPE_DENIED),
            observed=observed,
        )
    limit = loop_max(level, loop_max_override)
    if loop > limit:
        return SafeModeDecision(
            triggered=True,
            reason="loop_budget_exhausted",
            vc_code=vc_codes.LOOP_BUDGET_EXHAUSTED,
            action=vc_codes.next_action(vc_codes.LOOP_BUDGET_EXHAUSTED),
            observed=observed,
        )
    threshold = int(SAFE_MODE_ENFORCED["consecutive_same_failures"])
    if consecutive_count >= threshold:
        return SafeModeDecision(
            triggered=True,
            reason="consecutive_same_failures",
            vc_code=vc_codes.NO_PROGRESS,
            action=vc_codes.next_action(vc_codes.NO_PROGRESS),
            observed=observed,
        )
    return SafeModeDecision(triggered=False, observed=observed)


def observed_keys() -> set[str]:
    return set(SAFE_MODE_OBSERVED)


def enforced_keys() -> set[str]:
    return set(SAFE_MODE_ENFORCED)
