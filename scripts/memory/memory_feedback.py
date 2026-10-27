#!/usr/bin/env python3
"""P1-2：记忆效用观测 — 检索 / 实际使用 / 任务结果的独立记录与报告。

关键口径（见 docs/memory-layers.md §6.8）：
- ``retrieved`` / ``used`` / ``not_used`` / ``unknown`` 描述**是否进入任务并被采用**，
  ``outcome`` 描述任务结果，``attribution`` 描述归因强度；**三者独立**。
- **不计算单一效用分数**，不因一次失败自动降权 / 归档 / 删除记忆。
- 同一 (task_id, memory_key) 只有一条记录：重复注入只增加 ``updates``，
  报告中仍按 1 个任务样本计（防重复样本放大）。
- 存储复用现有 `memory` 表：key ``feedback:memory:<digest>``，
  ``layer=null`` / ``memory_category=state``；不改动被观测记忆的 value/tags/metadata。

退出码：0 = 成功（含空结果）；1 = verify 发现错误；2 = 参数非法；3 = 记忆库异常。
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import evolution_store as S  # noqa: E402

USAGES = ("used", "not_used", "unknown")
OUTCOMES = ("success", "failure", "neutral", "unknown")
ATTRIBUTIONS = ("direct", "partial", "none", "unknown")
CONFIDENCES = ("high", "medium", "low", "unknown")
TTL_SECONDS = 180 * 24 * 60 * 60
TAGS = ("memory-feedback", "runtime-state", "scope:task", "p1-evolution")


def feedback_key(task_id: str, memory_key: str) -> str:
    return S.stable_key(S.FEEDBACK_PREFIX, task_id, memory_key)


def _metadata(evidence_ids: Iterable[str]) -> dict[str, Any]:
    return {
        "layer": None,
        "memory_category": "state",
        "scope": "task",
        "status": "active",
        "review_status": "approved",
        "evidence_ids": list(evidence_ids),
        "feedback_schema": "memory-feedback/v1",
    }


def _unique(items: Iterable[str]) -> list[str]:
    out: list[str] = []
    for item in items:
        if item and item not in out:
            out.append(item)
    return out


def _parse_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def record_feedback(
    db: Path,
    *,
    task_id: str,
    retrieved: list[str],
    used: list[str],
    not_used: list[str],
    outcome: str,
    attribution: str,
    confidence: str,
    evidence_ids: list[str],
    note: str = "",
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    now = S.now_ms()
    for memory_key in _unique(retrieved):
        usage = "used" if memory_key in used else "not_used" if memory_key in not_used else "unknown"
        effective_attribution = (
            attribution if usage == "used" else "none" if usage == "not_used" else "unknown"
        )
        entry = S.fetch_entry(db, memory_key)
        current_hash = S.content_hash(entry["value"]) if entry else None
        layer = (entry or {}).get("metadata", {}).get("layer")

        def build(
            existing: dict[str, Any] | None,
            *,
            memory_key: str = memory_key,
            usage: str = usage,
            effective_attribution: str = effective_attribution,
            current_hash: str | None = current_hash,
            layer: str | None = layer,
        ) -> tuple[dict[str, Any], dict[str, Any], Iterable[str]]:
            if existing is None:
                value = {
                    "schema": "memory-feedback/v1",
                    "task_id": task_id,
                    "memory_key": memory_key,
                    "memory_layer": layer,
                    "memory_value_hash": current_hash,
                    "last_value_hash": current_hash,
                    "retrieved": True,
                    "usage": usage,
                    "outcome": outcome,
                    "attribution": effective_attribution,
                    "confidence": confidence,
                    "evidence_ids": list(evidence_ids),
                    "note": note,
                    "recorded_at_ms": now,
                    "updated_at_ms": now,
                    "updates": 1,
                    "memory_missing": current_hash is None,
                }
            else:
                value = S.json_object(existing["value"])
                value.update(
                    {
                        "memory_layer": layer or value.get("memory_layer"),
                        "last_value_hash": current_hash,
                        "retrieved": True,
                        "usage": usage,
                        "outcome": outcome,
                        "attribution": effective_attribution,
                        "confidence": confidence,
                        "updated_at_ms": now,
                        "updates": int(value.get("updates", 1)) + 1,
                        "memory_missing": current_hash is None,
                    }
                )
                value["evidence_ids"] = _unique(
                    [*value.get("evidence_ids", []), *evidence_ids]
                )
                if note:
                    value["note"] = note
            return value, _metadata(value.get("evidence_ids", [])), TAGS

        result = S.upsert_record(
            db, feedback_key(task_id, memory_key), build=build, ttl_seconds=TTL_SECONDS
        )
        results.append(result)
    return results


def _iter_feedback(db: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for entry in S.list_entries(db, S.FEEDBACK_PREFIX):
        value = S.json_object(entry["value"])
        if value:
            value["_key"] = entry["key"]
            value["_updated_at"] = entry["updated_at"]
            out.append(value)
    return out


def _empty_report(db: Path) -> dict[str, Any]:
    return {
        "schema": "memory-feedback-report/v1",
        "db": str(db),
        "records": 0,
        "tasks": 0,
        "memories": {},
        "notes": [
            "观测不等于因果；报告不计算单一效用分数。",
            "不得仅凭检索次数、未使用次数或短期任务成败自动降权 / 归档 / 删除记忆。",
        ],
    }


def build_report(
    db: Path,
    *,
    memory_key: str | None = None,
    since_days: int | None = None,
) -> dict[str, Any]:
    records = _iter_feedback(db)
    if memory_key:
        records = [r for r in records if r.get("memory_key") == memory_key]
    if since_days and since_days > 0:
        cutoff = S.now_ms() - int(since_days) * 86400 * 1000
        records = [r for r in records if int(r.get("updated_at_ms", 0)) >= cutoff]
    if not records:
        return _empty_report(db)

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[str(record.get("memory_key", ""))].append(record)

    memories: dict[str, Any] = {}
    for key, items in grouped.items():
        entry = S.fetch_entry(db, key)
        current_hash = S.content_hash(entry["value"]) if entry else None
        usage_counts = {name: 0 for name in USAGES}
        outcome_counts = {name: 0 for name in OUTCOMES}
        attribution_counts = {name: 0 for name in ATTRIBUTIONS}
        confidence_counts = {name: 0 for name in CONFIDENCES}
        task_ids: set[str] = set()
        layers: set[str] = set()
        changed_records = 0
        missing_records = 0
        for item in items:
            task_ids.add(str(item.get("task_id", "")))
            usage = str(item.get("usage", "unknown"))
            usage_counts[usage if usage in usage_counts else "unknown"] += 1
            outcome = str(item.get("outcome", "unknown"))
            outcome_counts[outcome if outcome in outcome_counts else "unknown"] += 1
            attribution = str(item.get("attribution", "unknown"))
            attribution_counts[attribution if attribution in attribution_counts else "unknown"] += 1
            confidence = str(item.get("confidence", "unknown"))
            confidence_counts[confidence if confidence in confidence_counts else "unknown"] += 1
            layer = item.get("memory_layer")
            if layer:
                layers.add(str(layer))
            if item.get("memory_missing"):
                missing_records += 1
            last_hash = item.get("last_value_hash")
            if current_hash and last_hash and last_hash != current_hash:
                changed_records += 1
        memories[key] = {
            "layer": sorted(layers)[0] if layers else None,
            "tasks": len(task_ids),
            "retrieved": len(task_ids),
            "usage": usage_counts,
            "outcomes": outcome_counts,
            "attribution": attribution_counts,
            "confidence": confidence_counts,
            "memory_missing": entry is None,
            "missing_records": missing_records,
            "memory_changed": changed_records > 0,
            "changed_records": changed_records,
            "last_seen_ms": max(int(i.get("updated_at_ms", 0)) for i in items),
        }

    ordered = dict(
        sorted(memories.items(), key=lambda kv: (-kv[1]["tasks"], kv[0]))
    )
    return {
        "schema": "memory-feedback-report/v1",
        "db": str(db),
        "records": len(records),
        "tasks": len({str(r.get("task_id", "")) for r in records}),
        "memories": ordered,
        "notes": [
            "观测不等于因果；报告不计算单一效用分数。",
            "used 仅表示有证据表明被采用；unknown 表示无法判断。",
            "不得仅凭检索次数、未使用次数或短期任务成败自动降权 / 归档 / 删除记忆。",
        ],
    }


def verify_feedback(db: Path) -> dict[str, Any]:
    records = _iter_feedback(db)
    errors: list[str] = []
    warnings: list[str] = []
    seen: dict[tuple[str, str], str] = {}
    for record in records:
        key = str(record.get("_key", ""))
        task_id = str(record.get("task_id", ""))
        memory_key = str(record.get("memory_key", ""))
        if record.get("schema") != "memory-feedback/v1":
            errors.append(f"{key}: schema 非法")
        if not task_id or not memory_key:
            errors.append(f"{key}: task_id / memory_key 缺失")
            continue
        expected = feedback_key(task_id, memory_key)
        if key != expected:
            errors.append(f"{key}: key 与 (task_id, memory_key) 不匹配（期望 {expected}）")
        pair = (task_id, memory_key)
        if pair in seen:
            errors.append(f"{key}: 与 {seen[pair]} 重复记录同一 (task, memory)")
        seen[pair] = key
        usage = record.get("usage")
        outcome = record.get("outcome")
        attribution = record.get("attribution")
        confidence = record.get("confidence")
        if usage not in USAGES:
            errors.append(f"{key}: usage 非法 {usage!r}")
        if outcome not in OUTCOMES:
            errors.append(f"{key}: outcome 非法 {outcome!r}")
        if attribution not in ATTRIBUTIONS:
            errors.append(f"{key}: attribution 非法 {attribution!r}")
        if confidence not in CONFIDENCES:
            errors.append(f"{key}: confidence 非法 {confidence!r}")
        if usage == "used" and not record.get("evidence_ids"):
            errors.append(f"{key}: usage=used 但缺少 evidence_ids")
        if record.get("retrieved") is not True:
            warnings.append(f"{key}: 缺少 retrieved=true（历史/手工记录）")
        if int(record.get("updates", 0)) < 1:
            errors.append(f"{key}: updates 非法")
        for field in ("memory_value_hash", "last_value_hash"):
            value = record.get(field)
            if value is not None and (not isinstance(value, str) or len(value) != 64):
                errors.append(f"{key}: {field} 不是 sha256")
        if record.get("memory_missing"):
            warnings.append(f"{key}: 记录时记忆已缺失（{memory_key}）")
        entry = S.fetch_entry(db, memory_key)
        if entry is None:
            warnings.append(f"{key}: 当前记忆不存在（{memory_key}）")
        else:
            current_hash = S.content_hash(entry["value"])
            if record.get("last_value_hash") and record["last_value_hash"] != current_hash:
                warnings.append(f"{key}: 记忆内容在记录后发生变化（{memory_key}）")
    return {
        "schema": "memory-feedback-verify/v1",
        "db": str(db),
        "ok": not errors,
        "records": len(records),
        "errors": errors,
        "warnings": warnings,
    }


def _print_human_report(report: dict[str, Any]) -> None:
    print(
        f"[memory-feedback] records={report['records']} tasks={report['tasks']} "
        f"memories={len(report['memories'])}"
    )
    for key, item in report["memories"].items():
        usage = item["usage"]
        outcomes = item["outcomes"]
        attribution = item["attribution"]
        flags = []
        if item["memory_missing"]:
            flags.append("memory_missing")
        if item["memory_changed"]:
            flags.append("memory_changed")
        flag_text = f" flags={','.join(flags)}" if flags else ""
        print(
            f"  - {key} layer={item['layer'] or '-'} tasks={item['tasks']} "
            f"retrieved={item['retrieved']} used={usage['used']} not_used={usage['not_used']} "
            f"unknown={usage['unknown']} "
            f"success={outcomes['success']} failure={outcomes['failure']} "
            f"neutral={outcomes['neutral']} attribution=direct:{attribution['direct']}"
            f"/partial:{attribution['partial']}/none:{attribution['none']}"
            f"/unknown:{attribution['unknown']}{flag_text}"
        )
    for note in report["notes"]:
        print(f"  [note] {note}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="记忆效用反馈记录与报告（P1-2）")
    sub = parser.add_subparsers(dest="command", required=True)

    rec = sub.add_parser("record", help="记录一次任务的记忆检索/使用/结果（幂等）")
    rec.add_argument("--db", default=None)
    rec.add_argument("--task-id", required=True)
    rec.add_argument("--retrieved", default="", help="进入任务上下文的 memory key，逗号分隔")
    rec.add_argument("--used", default="", help="有证据表明被采用的 key，逗号分隔")
    rec.add_argument("--not-used", default="", help="明确未采用的 key，逗号分隔")
    rec.add_argument("--outcome", default="unknown", choices=OUTCOMES)
    rec.add_argument("--attribution", default="unknown", choices=ATTRIBUTIONS)
    rec.add_argument("--confidence", default="unknown", choices=CONFIDENCES)
    rec.add_argument("--evidence", action="append", default=[], help="证据引用（file:/memory:/anchor:）")
    rec.add_argument("--note", default="")
    rec.add_argument("--json", action="store_true")

    rep = sub.add_parser("report", help="按记忆聚合观测（只读；不评分）")
    rep.add_argument("--db", default=None)
    rep.add_argument("--memory", default=None)
    rep.add_argument("--since-days", type=int, default=None)
    rep.add_argument("--json", action="store_true")

    ver = sub.add_parser("verify", help="校验反馈记录完整性（只读）")
    ver.add_argument("--db", default=None)
    ver.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    db = S.resolve_db(getattr(args, "db", None))

    if args.command == "record":
        retrieved = _unique(_parse_csv(args.retrieved))
        used = _unique(_parse_csv(args.used))
        not_used = _unique(_parse_csv(args.not_used))
        if not retrieved:
            print("[memory-feedback] 本轮无检索记忆，未记录（no-op）")
            return 0
        invalid = (set(used) | set(not_used)) - set(retrieved)
        if invalid:
            print(
                f"[INVALID_ARGUMENT] used/not-used 必须是 retrieved 的子集: {', '.join(sorted(invalid))}",
                file=sys.stderr,
            )
            return 2
        if set(used) & set(not_used):
            print("[INVALID_ARGUMENT] 同一 key 不能同时标记 used 与 not_used", file=sys.stderr)
            return 2
        if used and not args.evidence:
            print(
                "[INVALID_ARGUMENT] usage=used 必须提供至少 1 条 --evidence（否则应记 unknown）",
                file=sys.stderr,
            )
            return 2
        try:
            results = record_feedback(
                db,
                task_id=args.task_id,
                retrieved=retrieved,
                used=used,
                not_used=not_used,
                outcome=args.outcome,
                attribution=args.attribution,
                confidence=args.confidence,
                evidence_ids=_unique(args.evidence),
                note=args.note,
            )
        except S.StoreUnavailable as exc:
            print(f"[FEEDBACK_DEGRADED] 反馈写入失败: {exc}", file=sys.stderr)
            return 3
        payload = {
            "schema": "memory-feedback/v1",
            "task_id": args.task_id,
            "recorded": len(results),
            "created": sum(1 for r in results if r["created"]),
            "updated": sum(1 for r in results if not r["created"]),
            "keys": [r["key"] for r in results],
        }
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        else:
            print(
                f"[memory-feedback] task={args.task_id} recorded={payload['recorded']} "
                f"created={payload['created']} updated={payload['updated']}"
            )
        return 0

    if args.command == "report":
        try:
            report = build_report(db, memory_key=args.memory, since_days=args.since_days)
        except S.StoreUnavailable as exc:
            print(f"[FEEDBACK_DEGRADED] 报告失败: {exc}", file=sys.stderr)
            return 3
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        else:
            _print_human_report(report)
        return 0

    # verify
    try:
        report = verify_feedback(db)
    except S.StoreUnavailable as exc:
        print(f"[FEEDBACK_DEGRADED] 校验失败: {exc}", file=sys.stderr)
        return 3
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(
            f"[memory-feedback] verify: {'PASS' if report['ok'] else 'FAIL'} "
            f"records={report['records']} errors={len(report['errors'])} warnings={len(report['warnings'])}"
        )
        for error in report["errors"]:
            print(f"  ✗ {error}")
        for warning in report["warnings"]:
            print(f"  ! {warning}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
