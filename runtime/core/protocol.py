"""协议一致性校验：代码表 ↔ Skill 事实源（副本不许裸信）。

事实源：
- engine/transition.md「机器可读转移表」+ 各节标题 Label + VC 码族
- engine/state-machine.md 状态定义表（Label）
- kernel.md §7（Loop 上限）
- engine/complexity-gate.md「Loop Depth」矩阵
- manifest.yaml `complexity.levels` / `tunable_parameters.safe_mode_triggers` / `cost.loop_max`

校验失败 → ``PROTOCOL_DRIFT``（CLI exit 3）。任何一条边/修饰符无法解析 →
``unparsed``（fail-closed，宁红不猜）。
"""

from __future__ import annotations

import contextlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from . import vc_codes
from .safemode import SAFE_MODE_ENFORCED, SAFE_MODE_OBSERVED, SAFE_MODE_SOURCES
from .state_machine import (
    ESCALATION_EDGES,
    INCREMENT_EDGES,
    INIT_EDGES,
    LEGAL_TRANSITIONS,
    LOOP_MAX_QUICK as _LOOP_MAX_QUICK,
    LOOP_MAX_STANDARD,
    LOOP_RULES,
    PAUSE,
    RESET_EDGES,
    RESUME,
    STATE_LABELS,
)

_BLOCK_RE = re.compile(r"<!--\s*vc:transitions\s+v(\d+)(.*?)-->", re.DOTALL)
_EDGE_RE = re.compile(r"^\s*([A-Za-z0-9_*]+)\s*->\s*(.+?)\s*$")
_TARGET_RE = re.compile(r"^(S\d{1,2}|ALL|pause)(?:\(([^)]*)\))?$", re.IGNORECASE)
_HEADING_RE = re.compile(r"^##\s+(.+)$")
_HEADING_SEG_RE = re.compile(r"^(S\d{1,2})\s+(.+)$")
_TABLE_ROW_RE = re.compile(r"^\|\s*(S\d{1,2})\s+([^|]+?)\s*\|")
_STAGE_ROW_RE = re.compile(r"^\|\s*S(\d{1,2})\b")


@dataclass(frozen=True)
class ProtocolReport:
    ok: bool
    drifts: tuple[dict[str, Any], ...] = ()
    unparsed: tuple[str, ...] = ()
    checks: int = 0

    @property
    def code(self) -> str:
        return "" if self.ok else vc_codes.PROTOCOL_DRIFT

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "ok": self.ok,
            "checks": self.checks,
            "drifts": [dict(item) for item in self.drifts],
            "unparsed": list(self.unparsed),
        }
        if not self.ok:
            data.update(
                vc_codes.make_code(
                    vc_codes.PROTOCOL_DRIFT,
                    f"代码表与事实源不一致（{len(self.drifts)} 处漂移，{len(self.unparsed)} 处不可解析）",
                ).to_dict()
            )
        return data


@dataclass
class _Collector:
    drifts: list[dict[str, Any]] = field(default_factory=list)
    unparsed: list[str] = field(default_factory=list)
    checks: int = 0

    def drift(self, kind: str, detail: str) -> None:
        self.drifts.append({"kind": kind, "detail": detail})

    def check(self) -> None:
        self.checks += 1


# ---------------------------------------------------------------------------
# 解析事实源
# ---------------------------------------------------------------------------
def _normalize_modifier(text: str | None) -> str | frozenset[str]:
    if not text:
        return "keep"
    parts = [part.strip() for part in text.split("/") if part.strip()]
    normalized: set[str] = set()
    for part in parts:
        low = part.lower()
        if low == "+1":
            normalized.add("inc")
        elif low == "loop=0":
            normalized.add("reset0")
        elif low == "loop=1":
            normalized.add("init1")
        elif low == "resume":
            normalized.add("resume")
        else:
            normalized.add(low)
    if len(normalized) == 1:
        return next(iter(normalized))
    return frozenset(normalized)


def parse_transition_block(text: str) -> tuple[int, dict[tuple[str, str], Any]]:
    match = _BLOCK_RE.search(text)
    if not match:
        raise ValueError("未找到 <!-- vc:transitions vN ... --> 机器块")
    version = int(match.group(1))
    body = match.group(2)
    edges: dict[tuple[str, str], Any] = {}
    for raw in body.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        edge = _EDGE_RE.match(line)
        if not edge:
            raise ValueError(f"无法解析转移行: {raw!r}")
        source = edge.group(1).strip()
        if source.upper() == "ALL":
            # 升级弧由正文的 “ALL -> S14” 表达，块内不承载
            raws = [item.strip() for item in edge.group(2).split(",")]
            for item in raws:
                target = _TARGET_RE.match(item)
                if not target:
                    raise ValueError(f"无法解析目标: {item!r}")
                continue
            continue
        targets_text = edge.group(2)
        parts: list[str] = []
        if "|" in targets_text:
            left, right = targets_text.split("|", 1)
            parts.extend(part.strip() for part in left.split(",") if part.strip())
            if right.strip():
                parts.append(right.strip())
        else:
            parts.extend(part.strip() for part in targets_text.split(",") if part.strip())
        for item in parts:
            target = _TARGET_RE.match(item)
            if not target:
                raise ValueError(f"无法解析目标: {item!r}")
            name = target.group(1).upper()
            target_code = PAUSE if name == "PAUSE" else (RESUME if name == "ALL" else name)
            modifier = _normalize_modifier(target.group(2))
            if name == "ALL":
                modifier = "resume"
            key = (source.upper(), target_code)
            if key in edges:
                raise ValueError(f"重复边: {key}")
            edges[key] = modifier
    return version, edges


def _expected_edges() -> dict[tuple[str, str], Any]:
    expected: dict[tuple[str, str], Any] = {}
    for source, targets in LEGAL_TRANSITIONS.items():
        for target in targets:
            if source == "S8" and target == "S8":
                continue  # 自环不列为边
            key = (source, target)
            if key == ("S14", RESUME):
                expected[key] = "resume"
            else:
                rule = LOOP_RULES.get(key, "keep")
                expected[key] = rule
    return expected


def _parse_heading_labels(text: str) -> dict[str, str]:
    labels: dict[str, str] = {}
    for line in text.splitlines():
        heading = _HEADING_RE.match(line)
        if not heading:
            continue
        for segment in re.split(r"[→/]", heading.group(1)):
            seg = segment.strip()
            parsed = _HEADING_SEG_RE.match(seg)
            if not parsed:
                continue
            label = re.sub(r"\[[^\]]*\]\s*$", "", parsed.group(2)).strip()
            labels.setdefault(parsed.group(1).upper(), label)
    return labels


def _parse_state_table_labels(text: str) -> dict[str, str]:
    labels: dict[str, str] = {}
    for line in text.splitlines():
        row = _TABLE_ROW_RE.match(line.strip())
        if not row:
            continue
        code = row.group(1).upper()
        label = row.group(2).strip()
        if code in STATE_LABELS:
            labels.setdefault(code, label)
    return labels


def _parse_kernel_loop_limits(text: str) -> dict[str, int | None]:
    standard = re.search(r"最多执行\s*(\d+)\s*轮", text)
    quick = re.search(r"Quick Loop（Level 0/1）上限\s*(\d+)\s*轮", text)
    return {
        "standard": int(standard.group(1)) if standard else None,
        "quick": int(quick.group(1)) if quick else None,
    }


def _parse_manifest_levels(text: str) -> dict[int, list[str]]:
    levels: dict[int, list[str]] = {}
    for match in re.finditer(r"-\s*level:\s*(\d+)(.*?)(?=\n\s*-\s*level:|\Z)", text, re.DOTALL):
        level = int(match.group(1))
        stages = re.search(r"stages:\s*\[([^\]]*)\]", match.group(2))
        if not stages:
            continue
        levels[level] = [item.strip() for item in stages.group(1).split(",") if item.strip()]
    return levels


def _parse_manifest_scalars(text: str, block: str, indent: int = 2) -> dict[str, Any]:
    lines = text.splitlines()
    result: dict[str, Any] = {}
    in_block = False
    block_indent = indent
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        current_indent = len(line) - len(line.lstrip(" "))
        bare = stripped.split("#", 1)[0].strip()
        if bare == f"{block}:":
            in_block = True
            block_indent = current_indent
            continue
        if in_block:
            if current_indent <= block_indent:
                break
            item = re.match(r"^([a-z_]+):\s*([0-9.]+)\s*(?:#.*)?$", stripped)
            if item:
                raw = item.group(2)
                result[item.group(1)] = float(raw) if "." in raw else int(raw)
    return result


def _parse_complexity_matrix(text: str) -> tuple[dict[int, set[str]], list[str]]:
    """从 Loop Depth 矩阵推导每个 Level 的激活阶段集合；未知单元格 fail-closed。"""
    import re as _re

    header_idx = text.find("Loop Depth — 流程深度控制")
    if header_idx < 0:
        raise ValueError("未找到「Loop Depth — 流程深度控制」节")
    section = text[header_idx:]
    result: dict[int, set[str]] = {0: set(), 1: set(), 2: set(), 3: set(), 4: set()}
    unknown: list[str] = []
    for line in section.splitlines():
        if not line.strip().startswith("|"):
            if result[0] and not line.strip().startswith("|") and "|" not in line:
                # 允许表后解释文字，但表行必须连续；遇到非表行且已开始后停止
                if line.strip() and not line.strip().startswith((">", "**", "###", "本表")):
                    break
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 5:
            continue
        stage = _re.match(r"^S(\d{1,2})\b", cells[0])
        if not stage:
            continue
        code = f"S{int(stage.group(1))}"
        for idx, level in enumerate((0, 1, 2, 3)):
            cell = cells[idx + 1]
            if "跳过" in cell:
                active = False
            elif "✓" in cell:
                active = True
            elif "轻量" in cell or "内联" in cell:
                active = True
            elif "条件触发" in cell:
                # L2+ 的条件触发阶段仍属于激活阶段集合
                active = level >= 2
            elif "完整" in cell:
                active = True
            else:
                unknown.append(f"Level {level} {code} 单元格无法识别: {cell!r}")
                active = False
            if active:
                result[level].add(code)
                if level == 3:
                    result[4].add(code)
    return result, unknown


def _parse_loop_table(text: str) -> dict[str, str]:
    start = text.find("## 循环计数规则")
    if start < 0:
        return {}
    table: dict[str, str] = {}
    for line in text[start:].splitlines()[1:]:
        if line.startswith("## "):
            break
        if not line.strip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 2 and cells[0] not in ("规则", "---"):
            table[cells[0]] = cells[1]
    return table


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------
def check_protocol(
    *,
    skill_dir: str | Path | None = None,
    transition_text: str | None = None,
    state_machine_text: str | None = None,
    kernel_text: str | None = None,
    complexity_text: str | None = None,
    manifest_text: str | None = None,
) -> ProtocolReport:
    root = Path(skill_dir) if skill_dir else Path(__file__).resolve().parents[2] / "skills" / "vibe-coder-loop"
    collector = _Collector()

    def read(name: str, injected: str | None) -> str | None:
        if injected is not None:
            return injected
        path = root / name
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            collector.unparsed.append(f"无法读取事实源: {path}")
            return None

    transition_text = read("engine/transition.md", transition_text)
    state_machine_text = read("engine/state-machine.md", state_machine_text)
    kernel_text = read("kernel.md", kernel_text)
    complexity_text = read("engine/complexity-gate.md", complexity_text)
    manifest_text = read("manifest.yaml", manifest_text)

    # 1. 转移边集合 + 修饰符
    if transition_text is not None:
        try:
            version, edges = parse_transition_block(transition_text)
        except ValueError as exc:
            collector.unparsed.append(f"机器可读转移块不可解析: {exc}")
        else:
            if version != 1:
                collector.drift("block-version", f"机器块语法版本 v{version}，校验器仅支持 v1")
            expected = _expected_edges()
            for key in sorted(set(expected) | set(edges)):
                collector.check()
                if key not in edges:
                    collector.drift("missing-edge", f"{key[0]} -> {key[1]} 缺失于机器块")
                    continue
                if key not in expected:
                    collector.drift("extra-edge", f"{key[0]} -> {key[1]} 不在代码表")
                    continue
                want, got = expected[key], edges[key]
                if isinstance(want, frozenset) or isinstance(got, frozenset):
                    want_set = set(want) if isinstance(want, frozenset) else {want}
                    got_set = set(got) if isinstance(got, frozenset) else {got}
                    if want_set != got_set:
                        collector.drift(
                            "modifier",
                            f"{key[0]} -> {key[1]} 修饰符 {sorted(got_set)} ≠ 代码表 {sorted(want_set)}",
                        )
                elif want != got:
                    collector.drift(
                        "modifier",
                        f"{key[0]} -> {key[1]} 修饰符 {got!r} ≠ 代码表 {want!r}",
                    )
            # 升级弧：正文须显式表达 ALL -> S14
            collector.check()
            if not re.search(r"ALL\s*->\s*S14", transition_text):
                collector.drift("escalation", "正文未声明 ALL -> S14 升级弧")
            collector.check()
            if ESCALATION_EDGES != {"*": {"S14"}}:
                collector.drift("escalation", "ESCALATION_EDGES 必须为 {'*': {'S14'}}")

            # 机器块与代码表的 Loop 集合必须一致
            for label, edges_set in (
                ("INCREMENT_EDGES", INCREMENT_EDGES),
                ("RESET_EDGES", RESET_EDGES),
                ("INIT_EDGES", INIT_EDGES),
            ):
                collector.check()
                source_set = {
                    key
                    for key, mod in expected.items()
                    if (
                        (label == "INCREMENT_EDGES" and mod == "inc")
                        or (label == "RESET_EDGES" and mod == "reset0")
                        or (label == "INIT_EDGES" and mod == "init1")
                    )
                }
                if source_set != set(edges_set):
                    collector.drift("loop-edges", f"{label} 与机器块不一致: {sorted(set(edges_set) ^ source_set)}")

    # 2. Label 文本
    if transition_text is not None:
        for code, label in _parse_heading_labels(transition_text).items():
            collector.check()
            expected_label = STATE_LABELS.get(code)
            if expected_label is None:
                collector.drift("label", f"未知状态码 {code}")
            elif label != expected_label.split(" ", 1)[1]:
                collector.drift("label", f"{code} 标题 Label {label!r} ≠ 代码表 {expected_label!r}")
    if state_machine_text is not None:
        table = _parse_state_table_labels(state_machine_text)
        for code in (f"S{i}" for i in range(15)):
            collector.check()
            if code not in table:
                collector.drift("label", f"状态表缺少 {code} 的 Label")
            else:
                expected_label = STATE_LABELS.get(code, "")
                short = expected_label.split(" ", 1)[1] if " " in expected_label else expected_label
                if table[code] != short:
                    collector.drift("label", f"{code} 状态表 Label {table[code]!r} ≠ 代码表 {expected_label!r}")

    # 3. Loop 上限
    if kernel_text is not None:
        limits = _parse_kernel_loop_limits(kernel_text)
        collector.check()
        if limits["standard"] is None:
            collector.unparsed.append("kernel.md 未解析到标准 Loop 上限")
        elif limits["standard"] != LOOP_MAX_STANDARD:
            collector.drift("loop-max", f"kernel.md 标准上限 {limits['standard']} ≠ 代码 {LOOP_MAX_STANDARD}")
        collector.check()
        if limits["quick"] is None:
            collector.unparsed.append("kernel.md 未解析到 Quick Loop 上限")
        elif limits["quick"] != _LOOP_MAX_QUICK:
            collector.drift("loop-max", f"kernel.md Quick 上限 {limits['quick']} ≠ 代码 {_LOOP_MAX_QUICK}")

    # 4. 复杂度矩阵 ↔ manifest
    if complexity_text is not None and manifest_text is not None:
        try:
            matrix, unknown_cells = _parse_complexity_matrix(complexity_text)
        except ValueError as exc:
            collector.unparsed.append(f"复杂度矩阵不可解析: {exc}")
        else:
            for cell in unknown_cells:
                collector.unparsed.append(cell)
            manifest_levels = _parse_manifest_levels(manifest_text)
            if not manifest_levels:
                collector.unparsed.append("manifest.yaml 未解析到 complexity.levels")
            for level in range(5):
                collector.check()
                if level not in manifest_levels:
                    collector.drift("complexity", f"manifest 缺少 Level {level}")
                    continue
                got = {item.upper() for item in manifest_levels[level]}
                want = matrix.get(level, set())
                if got != want:
                    collector.drift(
                        "complexity",
                        f"Level {level} 激活阶段 manifest={sorted(got)} ≠ 矩阵={sorted(want)}",
                    )

    # 4b. state-machine.md 循环计数表（递增/不递增/上限）
    if state_machine_text is not None:
        rules = _parse_loop_table(state_machine_text)
        collector.check()
        if not rules:
            collector.unparsed.append("state-machine.md 未解析到「循环计数规则」表")
        else:
            start_rule = rules.get("Loop 计数起点", "")
            collector.check()
            if "Loop = 1" not in start_rule or ("S4", "S8") not in INIT_EDGES:
                collector.drift("loop-table", "起点规则与 INIT_EDGES 不一致")
            inc_rule = rules.get("递增条件", "")
            collector.check()
            if not all(code in inc_rule for code in ("S9", "S10")) or not {
                ("S9", "S8"),
                ("S10", "S8"),
                ("S10", "S6"),
            }.issubset(INCREMENT_EDGES):
                collector.drift("loop-table", "递增条件与 INCREMENT_EDGES 不一致")
            keep_rule = rules.get("不递增条件", "")
            collector.check()
            if not all(code in keep_rule for code in ("S6", "S7")):
                collector.drift("loop-table", "不递增条件未覆盖 S6/S7")
            upper_rule = rules.get("上限", "")
            upper = re.search(r"Loop\s*(\d+)", upper_rule)
            collector.check()
            if not upper:
                collector.unparsed.append("循环计数表「上限」行无法解析")
            elif int(upper.group(1)) != LOOP_MAX_STANDARD:
                collector.drift("loop-table", f"上限 {upper.group(1)} ≠ {LOOP_MAX_STANDARD}")

    # 5. Safe Mode 键集合与取值
    if manifest_text is not None:
        triggers = _parse_manifest_scalars(manifest_text, "safe_mode_triggers", indent=2)
        cost = _parse_manifest_scalars(manifest_text, "cost", indent=0)
        collector.check()
        if not triggers:
            collector.unparsed.append("manifest.yaml 未解析到 safe_mode_triggers")
        else:
            expected_keys = set(SAFE_MODE_OBSERVED) | {"consecutive_loops"}
            collector.check()
            if set(triggers) != expected_keys:
                collector.drift(
                    "safe-mode-keys",
                    f"manifest 触发键 {sorted(triggers)} ≠ 期望 {sorted(expected_keys)}（键不允许单边新增）",
                )
            collector.check()
            if float(triggers.get("consecutive_loops", -1)) != float(SAFE_MODE_ENFORCED["consecutive_same_failures"]):
                collector.drift(
                    "safe-mode-value",
                    "consecutive_loops 与 SAFE_MODE_ENFORCED['consecutive_same_failures'] 不一致",
                )
            collector.check()
            if float(triggers.get("hard_violation_repeats", 0)) < float(SAFE_MODE_ENFORCED["hard_constraint_violation"]):
                collector.drift("safe-mode-value", "hard_violation_repeats 小于单次硬约束触发阈值")
            for key, source in SAFE_MODE_SOURCES.items():
                collector.check()
                if source == "loop_max":
                    if "loop_max" not in cost:
                        collector.drift("safe-mode-source", "cost.loop_max 缺失")
                    elif int(cost["loop_max"]) != LOOP_MAX_STANDARD:
                        collector.drift("loop-max", f"manifest cost.loop_max={cost['loop_max']} ≠ {LOOP_MAX_STANDARD}")
                elif source not in triggers:
                    collector.drift("safe-mode-source", f"{key} 的事实源键 {source} 缺失")

    return ProtocolReport(
        ok=not collector.drifts and not collector.unparsed,
        drifts=tuple(collector.drifts),
        unparsed=tuple(collector.unparsed),
        checks=collector.checks,
    )
