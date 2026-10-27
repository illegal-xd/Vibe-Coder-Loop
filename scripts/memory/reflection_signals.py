#!/usr/bin/env python3
"""P1-1：自主反思触发 — 真实执行信号的记录、去重聚合与门控判定。

设计口径（见 skills/vibe-coder-loop/engine/transition.md S11）：
- 只记录**可确认的执行事件**（用户纠正 / 验证失败 / 重复失败 / 高代价返工）；
  模型猜测一律 ``--unverified``，不进入强制反思。
- 触发反思 ≠ 晋升长期记忆：输出固定 ``promotion_authorized=false``；
  晋升仍走 ``learning/memory/promotion.md`` 的质量闸门与阈值。
- 同一任务只产生**一个聚合判定**；同一 fingerprint 的多个信号合并为一个 group。
- 低价值 / 证据不足的事件只保留信号（``decision=skip|insufficient``），不蒸馏。
- 存储复用 delx-memory 现有 `memory` 表：key ``signal:reflection:<digest>``，
  ``layer=null`` / ``memory_category=state``，不进入 L0–L7 统计。

退出码：0 = 已给出判定（含 skip / insufficient / unavailable）；
        2 = 参数非法；3 = 记忆库异常（调用方标注降级并继续，不阻塞工程循环）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import evolution_store as S  # noqa: E402

SIGNAL_TYPES = ("user_correction", "repeated_failure", "high_cost_rework", "verification_failure")
SOURCES = ("user", "test", "review", "tool", "build")
RELATED_PREFIXES = ("lesson:", "reflection:", "pattern:", "principle:", "experience:")
HARD_CONFLICT_MARKERS = ("已废弃", "不再适用", "被取代", "superseded", "冲突未解决")
TTL_SECONDS = 90 * 24 * 60 * 60
TAGS = ("reflection-signal", "runtime-state", "scope:task", "p1-evolution")


def signal_key(task_id: str, signal_type: str, fingerprint: str, dedupe_token: str) -> str:
    return S.stable_key(S.SIGNAL_PREFIX, task_id, signal_type, fingerprint, dedupe_token)


def _metadata(evidence_ids: Iterable[str], verified: bool) -> dict[str, Any]:
    return {
        "layer": None,
        "memory_category": "state",
        "scope": "task",
        "status": "active",
        "review_status": "approved",
        "needs_review": not verified,
        "evidence_ids": list(evidence_ids),
        "signal_schema": "reflection-signal/v1",
    }


def _unique(items: Iterable[Any]) -> list[Any]:
    out: list[Any] = []
    for item in items:
        if item is None:
            continue
        if item not in out:
            out.append(item)
    return out


def record_signal(
    db: Path,
    *,
    task_id: str,
    signal_type: str,
    fingerprint: str,
    source: str,
    evidence_ids: list[str],
    summary: str,
    verified: bool = True,
    dedupe_token: str = "",
    loop: int = 0,
    cost: dict[str, int] | None = None,
) -> dict[str, Any]:
    token = dedupe_token or fingerprint
    key = signal_key(task_id, signal_type, fingerprint, token)
    now = S.now_ms()

    def build(existing: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any], Iterable[str]]:
        if existing is None:
            value = {
                "schema": "reflection-signal/v1",
                "signal_type": signal_type,
                "task_id": task_id,
                "source": source,
                "fingerprint": fingerprint,
                "dedupe_token": token,
                "summary": summary,
                "summaries": [summary],
                "verified": bool(verified),
                "evidence_ids": list(evidence_ids),
                "loop": int(loop),
                "cost": dict(cost or {}),
                "occurrence_count": 1,
                "report_count": 1,
                "first_seen_at_ms": now,
                "last_seen_at_ms": now,
            }
        else:
            value = S.json_object(existing["value"])
            # 同一确定性 key 的重复上报 = 同一事件，不放大 occurrence_count；
            # 不同 dedupe_token 才是独立轮次（各自一条记录，聚合时相加）。
            value["occurrence_count"] = int(value.get("occurrence_count", 1))
            value["report_count"] = int(value.get("report_count", 1)) + 1
            value["last_seen_at_ms"] = now
            value["verified"] = bool(value.get("verified", False) or verified)
            value["evidence_ids"] = _unique([*value.get("evidence_ids", []), *evidence_ids])
            value["summaries"] = _unique([*value.get("summaries", []), summary])[-5:]
            value["summary"] = summary or value.get("summary", "")
            if loop:
                value["loop"] = int(loop)
            if cost:
                value["cost"] = {**value.get("cost", {}), **cost}
        return value, _metadata(value.get("evidence_ids", []), bool(value.get("verified"))), TAGS

    result = S.upsert_record(db, key, build=build, ttl_seconds=TTL_SECONDS)
    return result


def load_signals(db: Path) -> list[dict[str, Any]]:
    signals: list[dict[str, Any]] = []
    for entry in S.list_entries(db, S.SIGNAL_PREFIX):
        value = S.json_object(entry["value"])
        if not value:
            continue
        value["_key"] = entry["key"]
        value["_updated_at"] = entry["updated_at"]
        signals.append(value)
    return signals


def _find_related(db: Path, fingerprint: str) -> list[str]:
    """FTS 优先；不可用时用 key 前缀 + 子串回退。只返回经验/模式类 key。"""
    tokens = [t for t in fingerprint.replace(":", " ").replace("-", " ").split() if t]
    query = " ".join(tokens) or fingerprint
    related: list[str] = []
    try:
        from memops import search_db  # 复用现有 FTS 检索实现

        for item in search_db(db, query, limit=8):
            key = str(item.get("key", ""))
            if key.startswith(RELATED_PREFIXES):
                related.append(key)
    except (Exception, SystemExit):
        related = []
    if related:
        return _unique(related)[:5]

    stop = {
        "test", "verification", "failure", "repeated", "high", "cost",
        "rework", "user", "correction", "missing", "error",
    }
    tokens = [
        token
        for token in re.split(r"[^\w\u4e00-\u9fff]+", fingerprint.lower())
        if len(token) >= 3 and token not in stop
    ]
    for prefix in RELATED_PREFIXES:
        for entry in S.list_entries(db, prefix):
            haystack = f"{entry['key']} {entry['value']}".lower()
            if any(token in haystack for token in tokens):
                related.append(entry["key"])
    return _unique(related)[:5]


def _feedback_index(db: Path) -> dict[tuple[str, str], dict[str, Any]]:
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in S.list_entries(db, S.FEEDBACK_PREFIX):
        value = S.json_object(entry["value"])
        if value:
            out[(str(value.get("task_id", "")), str(value.get("memory_key", "")))] = value
    return out


def _memory_is_stale(entry: dict[str, Any] | None) -> bool:
    if entry is None:
        return False
    meta = entry.get("metadata", {})
    if meta.get("status") == "superseded":
        return True
    text = f"{entry.get('value', '')}\n{meta}"
    return any(marker in text for marker in HARD_CONFLICT_MARKERS)


def evaluate(db: Path, *, task_id: str | None = None) -> dict[str, Any]:
    if not Path(db).expanduser().exists():
        return {
            "schema": "reflection-gate/v1",
            "task_id": task_id,
            "decision": "unavailable",
            "degraded": True,
            "reason": "memory_store_missing",
            "promotion_authorized": False,
            "groups": [],
            "note": "反思门控不可用（记忆库缺失）；按静态清单兜底，不阻塞循环。",
        }

    signals = load_signals(db)
    if not signals:
        return {
            "schema": "reflection-gate/v1",
            "task_id": task_id,
            "decision": "skip",
            "reason": "no_signals",
            "promotion_authorized": False,
            "groups": [],
            "note": "本轮未记录真实执行信号，不启动深度反思。",
        }

    current = [s for s in signals if not task_id or s.get("task_id") == task_id]
    if task_id and not current:
        return {
            "schema": "reflection-gate/v1",
            "task_id": task_id,
            "decision": "skip",
            "reason": "no_signals_for_task",
            "promotion_authorized": False,
            "groups": [],
            "note": "当前任务未记录信号；不因其他任务的信号误触发本任务反思。",
        }

    fingerprints = _unique(s.get("fingerprint", "") for s in current)
    feedback = _feedback_index(db)
    groups: list[dict[str, Any]] = []
    for fingerprint in fingerprints:
        members = [s for s in signals if s.get("fingerprint") == fingerprint]
        confirmed = [
            s for s in members if bool(s.get("verified")) and bool(s.get("evidence_ids"))
        ]
        # 未确认信号只作透明记录，不参与重复计数，也不否定同组内已确认事件
        counting = confirmed or members
        occurrences = sum(max(1, int(s.get("occurrence_count", 1))) for s in counting)
        tasks = _unique(s.get("task_id", "") for s in counting)
        types = _unique(s.get("signal_type", "") for s in counting)
        evidence = _unique(
            ref for s in counting for ref in s.get("evidence_ids", []) if isinstance(ref, str)
        )
        verified = bool(confirmed)
        related = _find_related(db, fingerprint)

        if not verified:
            classification, action, reflect, detail = (
                "insufficient_evidence",
                "record_only",
                False,
                "信号未验证或缺少证据，只保留记录，不蒸馏。",
            )
        else:
            classification, action, detail = _classify(
                db, feedback, task_id, related, fingerprint
            )
            reflect = _should_reflect(types, occurrences, related, classification)
            if not reflect:
                if classification == "new_experience":
                    classification = "sporadic"
                action = "record_only"
                detail = f"{detail} 尚未达到触发阈值，只记录信号。"

        groups.append(
            {
                "fingerprint": fingerprint,
                "signal_types": types,
                "occurrences": occurrences,
                "distinct_tasks": len(tasks),
                "task_ids": tasks,
                "evidence_ids": evidence,
                "verified": verified,
                "unverified_signals": len(members) - len(confirmed),
                "classification": classification,
                "action": action,
                "detail": detail,
                "related_memories": related,
                "reflect": reflect,
            }
        )

    if any(g["reflect"] for g in groups):
        decision = "reflect"
    elif groups and all(g["classification"] == "insufficient_evidence" for g in groups):
        decision = "insufficient"
    else:
        decision = "skip"

    return {
        "schema": "reflection-gate/v1",
        "task_id": task_id,
        "decision": decision,
        "reason": _decision_reason(groups),
        "promotion_authorized": False,
        "groups": groups,
        "note": "触发反思不等于晋升长期记忆；晋升按 promotion.md 的质量闸门独立判定。",
    }


def _decision_reason(groups: list[dict[str, Any]]) -> str:
    if not groups:
        return "no_groups"
    reasons = []
    for group in groups:
        if group.get("reflect"):
            reasons.append(str(group.get("classification")))
    return ",".join(_unique(reasons)) or "low_value_signals"


def _should_reflect(
    types: list[str], occurrences: int, related: list[str], classification: str
) -> bool:
    if "user_correction" in types:
        return True
    if "high_cost_rework" in types:
        return True
    if "repeated_failure" in types and occurrences >= 2:
        return True
    if "verification_failure" in types and occurrences >= 2:
        return True
    # 单次验证失败只有在「已有经验已失效」时才值得深度反思；
    # 「已有经验未被遵守」需重复出现才触发（避免一次失误就蒸馏）。
    if classification in ("lesson_stale", "lesson_ineffective"):
        return True
    return False


def _classify(
    db: Path,
    feedback: dict[tuple[str, str], dict[str, Any]],
    task_id: str | None,
    related: list[str],
    fingerprint: str,
) -> tuple[str, str, str]:
    if not related:
        return "new_experience", "create", "未找到同类经验；若达到复用阈值，按新经验处理。"
    for key in related:
        if _memory_is_stale(S.fetch_entry(db, key)):
            return "lesson_stale", "correct", f"相关经验可能失效或存在冲突：{key}；先纠错/冲突检查。"
    for key in related:
        record = feedback.get((task_id or "", key))
        if record is None:
            continue
        usage = record.get("usage")
        if usage == "used":
            return (
                "lesson_ineffective",
                "conflict_check",
                f"相关经验 {key} 已被使用但未阻止问题；检查适用条件或冲突。",
            )
        if usage in ("not_used", "unknown"):
            return (
                "lesson_not_followed",
                "supplement",
                f"相关经验 {key} 已检索但未被采用；补充未遵守原因与执行约束。",
            )
    return (
        "lesson_not_followed",
        "supplement",
        f"存在同类经验 {related[0]} 但本轮未检索/使用；补充召回与适用条件。",
    )


def _parse_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _print_report(report: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        return
    print(
        f"[REFLECTION_GATE] decision={report.get('decision')} "
        f"task={report.get('task_id') or '-'} reason={report.get('reason')}"
    )
    for group in report.get("groups", []):
        print(
            f"  - fingerprint={group['fingerprint']} occurrences={group['occurrences']} "
            f"tasks={group['distinct_tasks']} classification={group['classification']} "
            f"action={group['action']} reflect={'yes' if group['reflect'] else 'no'}"
        )
        if group.get("related_memories"):
            print(f"    related={', '.join(group['related_memories'])}")
    print(f"  [note] {report.get('note')}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="反思信号记录与门控判定（P1-1）")
    sub = parser.add_subparsers(dest="command", required=True)

    rec = sub.add_parser("record", help="记录一条真实执行信号（幂等）")
    rec.add_argument("--db", default=None, help="记忆库路径（默认 DELX_MEMORY_DB / ~/.delx-memory/db.sqlite）")
    rec.add_argument("--task-id", required=True, help="本轮任务标识（S1 生成，跨轮任务不复用）")
    rec.add_argument("--type", dest="signal_type", required=True, choices=SIGNAL_TYPES)
    rec.add_argument("--source", required=True, choices=SOURCES)
    rec.add_argument("--fingerprint", required=True, help="同类问题指纹，如 test-insufficient:checkout")
    rec.add_argument("--evidence", action="append", default=[], help="证据引用（file:/memory:/anchor:）")
    rec.add_argument("--summary", default="", help="一句话事实")
    rec.add_argument("--dedupe-token", default="", help="同一任务内区分不同轮次；缺省等于 fingerprint")
    rec.add_argument("--loop", type=int, default=0)
    rec.add_argument("--cost-files", type=int, default=0)
    rec.add_argument("--cost-loops", type=int, default=0)
    rec.add_argument("--unverified", action="store_true", help="模型判断/未确认事件；不进入强制反思")
    rec.add_argument("--json", action="store_true")

    ev = sub.add_parser("evaluate", help="聚合本任务信号并判定是否反思")
    ev.add_argument("--db", default=None)
    ev.add_argument(
        "--task-id",
        required=True,
        help="本轮任务标识（必填；缺省会跨任务聚合，导致误判 skip）",
    )
    ev.add_argument("--json", action="store_true")

    show = sub.add_parser("list", help="列出已记录信号（只读）")
    show.add_argument("--db", default=None)
    show.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    db = S.resolve_db(getattr(args, "db", None))
    if args.command == "record":
        evidence = _parse_csv(",".join(args.evidence))
        if args.unverified is False and not evidence:
            print("[INVALID_ARGUMENT] verified 信号必须提供至少 1 条 --evidence", file=sys.stderr)
            return 2
        summary = args.summary or f"{args.signal_type}:{args.fingerprint}"
        try:
            result = record_signal(
                db,
                task_id=args.task_id,
                signal_type=args.signal_type,
                fingerprint=args.fingerprint,
                source=args.source,
                evidence_ids=evidence,
                summary=summary,
                verified=not args.unverified,
                dedupe_token=args.dedupe_token,
                loop=args.loop,
                cost={"files": args.cost_files, "loops": args.cost_loops},
            )
        except S.StoreUnavailable as exc:
            print(f"[REFLECTION_DEGRADED] 信号写入失败: {exc}", file=sys.stderr)
            return 3
        payload = {
            "schema": "reflection-signal/v1",
            "key": result["key"],
            "created": result["created"],
            "occurrence_count": result["value"].get("occurrence_count"),
            "report_count": result["value"].get("report_count"),
            "verified": result["value"].get("verified"),
        }
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        else:
            action = "recorded" if result["created"] else "aggregated"
            print(
                f"[reflection-signal] {action}: {result['key']} "
                f"occurrence={payload['occurrence_count']} verified={payload['verified']}"
            )
        return 0

    if args.command == "evaluate":
        try:
            report = evaluate(db, task_id=args.task_id)
        except S.StoreUnavailable as exc:
            print(f"[REFLECTION_DEGRADED] 门控不可用: {exc}", file=sys.stderr)
            return 3
        _print_report(report, as_json=args.json)
        return 0

    # list
    try:
        signals = load_signals(db)
    except S.StoreUnavailable as exc:
        print(f"[REFLECTION_DEGRADED] 读取失败: {exc}", file=sys.stderr)
        return 3
    if args.json:
        print(json.dumps(signals, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"[reflection-signal] count={len(signals)}")
        for signal in signals:
            print(
                f"  {signal.get('task_id')} {signal.get('signal_type')} "
                f"{signal.get('fingerprint')} x{signal.get('occurrence_count', 1)} "
                f"verified={signal.get('verified')}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
