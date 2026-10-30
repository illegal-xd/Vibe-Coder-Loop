#!/usr/bin/env python3
"""导出 Token 用量卡片数据：~/.config/opencode/token-usage/token-usage*.jsonl → tools/token-usage-card/token-usage-data.js。

卡片页是静态 HTML，file:// 下无法 fetch 本地 jsonl，因此由本脚本生成可直接 <script> 加载的快照。
只保留卡片需要的字段，并按 schema 语义归一：
- 输入总量：v3 = input_tokens；v2 = input_tokens + cached_input_tokens + cache_write_tokens
- 输出总量：v3 = output_tokens；v2 = output_tokens + reasoning_tokens
- 每条策略记录 [removed_tokens, scanned_records, candidate_items, removed_items,
+  eligible_items, marked_items]（后两项对旧记录回退为 candidate_items/removed_items）；
  该次请求没有该策略时记 null，卡片据此区分“未采集”与“采集到 0”。
跨文件逐字节相同的行只计一次（与 readUsageLog 口径一致），损坏行跳过并计数。
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Central archive shared by every project. Env overrides let the UI
# consistency test run against a temporary fixture without touching it.
DATA_DIR = os.path.expanduser(
    os.environ.get("VIBE_TOKEN_USAGE_DATA_DIR")
    or os.environ.get("VIBE_TOKEN_USAGE_HOME")
    or "~/.config/opencode/token-usage"
)
OUT_FILE = os.environ.get("VIBE_TOKEN_USAGE_OUT_FILE") or os.path.join(
    ROOT, "tools", "token-usage-card", "token-usage-data.js"
)
FILE_RE = re.compile(r"^token-usage(-\d{4}-\d{2}-\d{2})?\.jsonl$")
# 与 .opencode/context-dedup/token-usage.js 的 pruning.order 对齐：即使历史记录尚未采集
# 某条策略，卡片也保留该行（值为 0），避免策略在界面上“消失”。
CANONICAL_STRATEGIES = (
    "deduplication",
    "error_purge",
    "supersede_writes",
    "tool_descriptions",
    "compact_read",
    "line_range_edit",
)
LABELS = {
    "deduplication": "Deduplication",
    "error_purge": "Error Purge",
    "supersede_writes": "Supersede Writes",
    "tool_descriptions": "Tool Descriptions",
    "compact_read": "Compact Read",
    "line_range_edit": "Line Range Edit",
}


def value_of(holder) -> int:
    if isinstance(holder, dict):
        value = holder.get("value")
        if isinstance(value, (int, float)):
            return int(value)
    return 0


def total_input(record: dict) -> int:
    if int(record.get("schema_version") or 0) >= 3:
        return value_of(record.get("input_tokens"))
    return (
        value_of(record.get("input_tokens"))
        + value_of(record.get("cached_input_tokens"))
        + value_of(record.get("cache_write_tokens"))
    )


def total_output(record: dict) -> int:
    if int(record.get("schema_version") or 0) >= 3:
        return value_of(record.get("output_tokens"))
    return value_of(record.get("output_tokens")) + value_of(record.get("reasoning_tokens"))


def strategy_keys_of(record: dict) -> list[str]:
    pruning = record.get("pruning") or {}
    keys = []
    for key in pruning.get("order") or []:
        if isinstance(key, str) and key not in keys:
            keys.append(key)
    for key, payload in pruning.items():
        if isinstance(payload, dict) and "removed_tokens" in payload and key not in keys:
            keys.append(key)
    return keys


def main() -> int:
    if not os.path.isdir(DATA_DIR):
        print(f"数据目录不存在：{DATA_DIR}", file=sys.stderr)
        return 1

    files = sorted(
        os.path.join(DATA_DIR, name)
        for name in os.listdir(DATA_DIR)
        if FILE_RE.match(name)
    )
    if not files:
        print(f"未找到 token-usage*.jsonl：{DATA_DIR}", file=sys.stderr)
        return 1

    records: list[dict] = []
    seen_lines: set[str] = set()
    invalid_lines = 0
    strategy_keys: list[str] = list(CANONICAL_STRATEGIES)

    for path in files:
        with open(path, encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line in seen_lines:
                    continue
                seen_lines.add(line)
                try:
                    record = json.loads(line)
                    timestamp = datetime.fromisoformat(
                        str(record["timestamp"]).replace("Z", "+00:00")
                    )
                    if timestamp.tzinfo is None:
                        raise ValueError("timestamp 缺少时区")
                except (ValueError, KeyError, TypeError):
                    invalid_lines += 1
                    continue
                record["_ts_ms"] = int(timestamp.timestamp() * 1000)
                records.append(record)
                for key in strategy_keys_of(record):
                    if key not in strategy_keys:
                        strategy_keys.append(key)

    records.sort(key=lambda record: record["_ts_ms"])

    compact = []
    for record in records:
        pruning = record.get("pruning") or {}
        per_strategy = []
        for key in strategy_keys:
            summary = pruning.get(key)
            if not isinstance(summary, dict):
                # 该次请求的日志还没有这条策略（旧版插件），卡片据此显示“未记录”。
                per_strategy.append(None)
                continue
            candidate_items = int(summary.get("candidate_items") or 0)
            removed_items = int(summary.get("removed_items") or 0)
            per_strategy.append(
                [
                    value_of(summary.get("removed_tokens")),
                    int(summary.get("scanned_records") or 0),
                    candidate_items,
                    removed_items,
                    int(summary.get("eligible_items", candidate_items) or 0),
                    int(summary.get("marked_items", removed_items) or 0),
                ]
            )
        removed_total = value_of(pruning.get("total_removed_tokens"))
        removed = removed_total or sum(row[0] for row in per_strategy if row)
        compact.append(
            [
                record["_ts_ms"],
                total_input(record),
                total_output(record),
                value_of(record.get("cached_input_tokens")),
                removed,
                per_strategy,
            ]
        )

    payload = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "sourceFiles": [os.path.basename(path) for path in files],
        "strategies": [{"key": key, "label": LABELS.get(key, key)} for key in strategy_keys],
        "records": compact,
    }

    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as handle:
        handle.write("/* 自动生成，勿手改：python3 scripts/token-usage/export_card_data.py */\n")
        handle.write(f"window.TOKEN_USAGE_DATA = {body};\n")

    print(f"来源文件 {len(files)} 个：{', '.join(payload['sourceFiles'])}")
    print(f"记录 {len(compact)} 条（损坏行 {invalid_lines} 条）→ {os.path.relpath(OUT_FILE, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
