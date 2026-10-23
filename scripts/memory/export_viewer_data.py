#!/usr/bin/env python3
"""导出 delx-memory 数据供 tools/memory-viewer 静态页面使用。

用法:
    python3 scripts/memory/export_viewer_data.py                # 默认输出 tools/memory-viewer/memory-data.json
    python3 scripts/memory/export_viewer_data.py --out /tmp/m.json [--db ~/.delx-memory/db.sqlite]

只读：不写数据库。生成的 JSON 含本机路径与记忆正文，已加入 .gitignore，勿提交。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time


def decode_value(raw: str) -> str:
    """delx-memory 的 value 列存的是 JSON 字符串（含引号与转义），这里还原为纯文本。"""
    if raw and raw[0] == '"':
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw
    return raw


def decode_meta(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def split_tags(raw: str | None) -> list[str]:
    # tags 列是 ",a,b," 形式的逗号串（见 lesson:delx-memory-tags-storage-format）
    return [t for t in (raw or "").split(",") if t]


def build_payload(db_path: str) -> dict:
    if not os.path.exists(db_path):
        raise SystemExit(f"数据库不存在: {db_path}")
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "select key,value,tags,metadata,created_at,updated_at,ttl_expires_at from memory"
    ).fetchall()
    con.close()

    entries = []
    for row in rows:
        text = decode_value(row["value"])
        meta = decode_meta(row["metadata"])
        tags = split_tags(row["tags"])
        key = row["key"]
        entries.append(
            {
                "key": key,
                "type": key.split(":")[0],
                "fragment": "#" in key,
                "parent": key.split("#")[0] if "#" in key else None,
                "value": text,
                "tags": tags,
                "metadata": meta,
                "size": len(text),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "ttl_expires_at": row["ttl_expires_at"],
                "status": meta.get("status"),
                "layer": meta.get("layer"),
                "weight": next((t for t in tags if t.startswith("p_")), None),
            }
        )
    entries.sort(key=lambda e: e["updated_at"], reverse=True)

    types: dict[str, int] = {}
    for e in entries:
        types[e["type"]] = types.get(e["type"], 0) + 1

    return {
        "generated_at": int(time.time() * 1000),
        "source": db_path,
        "total": len(entries),
        "total_chars": sum(e["size"] for e in entries),
        "types": types,
        "entries": entries,
    }


def main(argv: list[str]) -> int:
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap = argparse.ArgumentParser(description="导出 delx-memory 数据为查看器 JSON（只读）")
    ap.add_argument("--db", default=os.path.expanduser("~/.delx-memory/db.sqlite"))
    ap.add_argument("--out", default=os.path.join(repo_root, "tools/memory-viewer/memory-data.json"))
    ap.add_argument("--pretty", action="store_true", help="缩进输出（体积约翻倍，便于 diff）")
    args = ap.parse_args(argv)

    payload = build_payload(args.db)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False,
                  indent=1 if args.pretty else None,
                  separators=None if args.pretty else (",", ":"))
    print(
        f"导出 {payload['total']} 条 / {payload['total_chars']} 字符 -> {args.out} "
        f"({os.path.getsize(args.out)} bytes)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
