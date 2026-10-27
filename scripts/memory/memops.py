#!/usr/bin/env python3
"""delx-memory 运维命令：validate / search / repair / split。

设计约束（见 docs/memory-layers.md、delx-memory-protocol/protocol.md）：
- `validate` / `search` 只读；`repair` / `split` 默认 dry-run，``--apply`` 才写。
- 写入前自动 `VACUUM INTO` 备份，且只改 metadata / tags / ttl，不改 value
  （`split` 例外：它显式重写父条目为分片入口）。
- 分片必须继承父条目的 layer/category/scope/evidence_ids；默认召回排除
  ``fragment`` tag 与 ``#`` key，避免父条目与分片重复占用上下文。
- 不猜语义：无法确定父条目或分类时保留原状并报告，不强行归类。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import layers as L  # noqa: E402
from audit_memory import classify, connect_ro  # noqa: E402

MEMOPS_VERSION = "memops-v1"
FRAGMENT_TAG = "fragment"
LAYER_TAG_PREFIX = "layer:"
CHECKPOINT_PREFIX = "vc:checkpoint"
RUNTIME_STATE_TAG = "runtime-state"

# TTL 默认值（秒）。只覆盖“应当过期”的类型；rule/skill/principle/global/
# preference/user/env/tooling/agent 永久保留，不在这里出现。
TTL_DEFAULTS: dict[str, int] = {
    "lesson": 90 * 86400,
    "reflection": 180 * 86400,
    "experience": 180 * 86400,
    "pattern": 365 * 86400,
    "project": 365 * 86400,
    "qa": 30 * 86400,
    "archive": 90 * 86400,
    "skill-metrics": 180 * 86400,
    "vc": 30 * 86400,
}

REQUIRED_FRAGMENT_FIELDS = (
    "layer",
    "memory_category",
    "scope",
    "status",
    "review_status",
    "evidence_ids",
)

CONVENTION_MARKERS = (
    "规范",
    "约定",
    "必须",
    "禁止",
    "不得",
    "统一",
    "convention",
    "standard",
    "规则",
)


def now_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def default_db() -> Path:
    return Path(os.environ.get("DELX_MEMORY_DB", str(Path.home() / ".delx-memory" / "db.sqlite"))).expanduser()


def decode_value(raw: Any) -> str:
    return L.decode_value(raw if isinstance(raw, str) else str(raw or ""))


def parse_metadata(raw: Any) -> dict:
    if isinstance(raw, dict):
        return dict(raw)
    try:
        data = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def split_tags(raw: Any) -> list[str]:
    return L.split_tags(raw) if isinstance(raw, str) else list(raw or [])


def norm_tags(tags: Iterable[str]) -> str:
    items = []
    for tag in tags:
        tag = str(tag).strip().strip(",")
        if tag and tag not in items:
            items.append(tag)
    return f",{','.join(items)}," if items else ""


def add_tag(tags: list[str], tag: str) -> bool:
    if tag not in tags:
        tags.append(tag)
        return True
    return False


def content_hash(value: str) -> str:
    return hashlib.sha256(re.sub(r"\s+", " ", value).strip().encode("utf-8")).hexdigest()


def prefix_of(key: str) -> str:
    return key.split(":", 1)[0] if ":" in key else ""


def is_fragment(key: str, meta: dict, tags: Iterable[str]) -> bool:
    return "#" in key or bool(meta.get("fragment")) or FRAGMENT_TAG in set(tags)


def parent_of(key: str, meta: dict) -> str | None:
    parent = meta.get("parent_key")
    if isinstance(parent, str) and parent:
        return parent
    if "#" in key:
        return key.split("#", 1)[0]
    return None


def layer_tag(layer: str | None) -> str | None:
    return f"{LAYER_TAG_PREFIX}{layer}" if layer else None


def strip_layer_tags(tags: list[str]) -> bool:
    kept = [t for t in tags if not t.startswith(LAYER_TAG_PREFIX)]
    changed = len(kept) != len(tags)
    tags[:] = kept
    return changed


def merge_basis(meta: dict, rule_ids: list[str], reasons: list[str]) -> bool:
    basis = meta.get("layer_basis")
    before = json.dumps(basis, sort_keys=True, ensure_ascii=False) if isinstance(basis, dict) else ""
    if not isinstance(basis, dict):
        basis = {}
    ids = list(basis.get("rule_ids") or [])
    rs = list(basis.get("reasons") or [])
    for rid in rule_ids:
        if rid not in ids:
            ids.append(rid)
    for reason in reasons:
        if reason not in rs:
            rs.append(reason)
    if ids != list(basis.get("rule_ids") or []) or rs != list(basis.get("reasons") or []):
        basis.update({"rule_ids": ids, "reasons": rs, "by": f"memops.py@{now_iso()[:10]}"})
        meta["layer_basis"] = basis
    return json.dumps(meta.get("layer_basis"), sort_keys=True, ensure_ascii=False) != before


def archive_refs(value: str) -> list[str]:
    """从父条目正文提取「已归档：`path`」引用，作为 fragment 的 L0 证据。"""
    out = []
    for match in re.finditer(r"已归档[：:]\s*`([^`]+)`", value or ""):
        path = match.group(1).strip()
        if path and path not in out:
            out.append(path)
    return out


def evidence_ref_exists(ref: str, keys: set[str]) -> bool:
    if ref.startswith("memory:"):
        return ref[len("memory:"):] in keys
    if ref.startswith(("file:", "archive:")):
        path = ref.split(":", 1)[1].split("#", 1)[0]
        return Path(path).expanduser().exists()
    if ref.startswith("anchor:"):
        return True
    # 无类型前缀的旧引用按 memory key 处理
    return ref in keys


def load_rows(conn: sqlite3.Connection) -> list[dict]:
    rows = []
    for row in conn.execute(
        "SELECT key, value, tags, metadata, created_at, updated_at, ttl_expires_at FROM memory ORDER BY key"
    ):
        meta = parse_metadata(row["metadata"])
        tags = split_tags(row["tags"])
        rows.append(
            {
                "key": row["key"],
                "value_raw": row["value"],
                "value": decode_value(row["value"]),
                "tags": tags,
                "meta": meta,
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "ttl": row["ttl_expires_at"],
            }
        )
    return rows


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?", (name,)
    ).fetchone() is not None


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------
def validate_db(db: Path, *, warnings_as_errors: bool = False, max_examples: int = 3) -> dict:
    conn = connect_ro(str(db))
    try:
        if not table_exists(conn, "memory"):
            raise SystemExit(f"memory 表不存在：{db}")
        rows = load_rows(conn)
    finally:
        conn.close()

    keys = {r["key"] for r in rows}
    by_key = {r["key"]: r for r in rows}
    errors: dict[str, list[str]] = defaultdict(list)
    warnings: dict[str, list[str]] = defaultdict(list)

    def add(bucket: dict[str, list[str]], code: str, key: str, detail: str = "") -> None:
        bucket[code].append(f"{key}" + (f" — {detail}" if detail else ""))

    for r in rows:
        key, meta, tags = r["key"], r["meta"], r["tags"]
        layer = meta.get("layer")
        category = meta.get("memory_category")
        fragment = is_fragment(key, meta, tags)

        if layer is not None and layer not in L.LAYERS:
            add(errors, "invalid_layer", key, str(layer))
        if category is not None and category not in L.CATEGORIES:
            add(errors, "invalid_category", key, str(category))
        if meta.get("status") is not None and meta.get("status") not in L.STATUSES:
            add(errors, "invalid_status", key, str(meta.get("status")))
        if meta.get("review_status") is not None and meta.get("review_status") not in L.REVIEW_STATUSES:
            add(errors, "invalid_review_status", key, str(meta.get("review_status")))

        if key.startswith(CHECKPOINT_PREFIX) and (layer == "L0" or "L0" in tags):
            add(errors, "checkpoint_l0_conflict", key, "checkpoint 应 category=state / layer=null")

        if "superseded_by" in meta:
            add(warnings, "superseded_by_in_metadata", key, "协议要求时序链写在 value，不写 metadata")

        if fragment:
            parent = parent_of(key, meta)
            if parent and parent not in by_key:
                add(errors, "fragment_missing_parent", key, parent)
            missing = [f for f in REQUIRED_FRAGMENT_FIELDS if f not in meta]
            if missing:
                add(errors, "fragment_missing_field", key, ",".join(missing))
            if layer is None and category in (None, "knowledge"):
                add(errors, "fragment_layer_missing", key)
            if FRAGMENT_TAG not in tags:
                add(errors, "fragment_not_tagged", key)
            if parent and parent in by_key:
                p = by_key[parent]
                if (
                    p["meta"].get("status") == "active"
                    and meta.get("status") == "active"
                    and "分片索引" not in p["value"]
                ):
                    add(warnings, "parent_fragment_duplicate", key, "父条目未改写成 router")
        else:
            if category in ("knowledge", None) and layer is None:
                add(errors, "layer_missing", key, str(category))

        if layer and layer_tag(layer) not in tags:
            add(errors, "layer_tag_missing", key, str(layer))

        if r["ttl"] is None and prefix_of(key) in TTL_DEFAULTS and not fragment:
            add(warnings, "ttl_missing", key, prefix_of(key))

        for ref in meta.get("evidence_ids") or []:
            if isinstance(ref, str) and not evidence_ref_exists(ref, keys):
                add(errors, "dangling_evidence", key, ref)

        if layer == "L6" and not meta.get("mirror_of"):
            add(warnings, "l6_mirror_without_pointer", key)

        if layer == "L4" and key.startswith(("project:", "reference:")):
            if not any(m in f"{meta.get('title', '')}\n{r['value']}" for m in CONVENTION_MARKERS):
                add(warnings, "project_knowledge_in_l4", key)

    pending = sum(1 for r in rows if r["meta"].get("review_status") == "pending")
    if pending > 50:
        warnings["review_backlog"].append(f"{pending} 条 pending（建议 L3/L4 有证据即自动批准，review 只保留 L5–L7）")

    def summary(bucket: dict[str, list[str]]) -> dict:
        return {
            code: {"count": len(items), "examples": items[:max_examples]}
            for code, items in sorted(bucket.items())
        }

    report = {
        "db": str(db),
        "generated_at": now_iso(),
        "totals": {
            "entries": len(rows),
            "fragments": sum(1 for r in rows if is_fragment(r["key"], r["meta"], r["tags"])),
            "with_layer": sum(1 for r in rows if r["meta"].get("layer")),
            "with_ttl": sum(1 for r in rows if r["ttl"] is not None),
            "pending_review": pending,
        },
        "errors": summary(errors),
        "warnings": summary(warnings),
        "ok": not errors and not (warnings_as_errors and warnings),
    }
    return report


def print_validate(report: dict) -> None:
    print(f"memops validate: {report['db']}")
    totals = report["totals"]
    print(
        f"  entries={totals['entries']} fragments={totals['fragments']} "
        f"with_layer={totals['with_layer']} with_ttl={totals['with_ttl']} pending={totals['pending_review']}"
    )
    for label, bucket in (("ERROR", report["errors"]), ("WARN", report["warnings"])):
        if not bucket:
            continue
        print(f"  {label}:")
        for code, item in bucket.items():
            print(f"    - {code}: {item['count']}")
            for ex in item["examples"]:
                print(f"        {ex}")
    print("  result:", "PASS" if report["ok"] else "FAIL")


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------
def fts_query(text: str) -> str:
    tokens = [t for t in re.split(r"\s+", text.strip()) if t]
    if not tokens:
        raise SystemExit("搜索词为空")
    return " AND ".join('"' + t.replace('"', '""') + '"' for t in tokens)


def search_db(
    db: Path,
    query: str,
    *,
    prefix: str = "",
    tag: str = "",
    limit: int = 5,
    include_fragments: bool = False,
) -> list[dict]:
    conn = connect_ro(str(db))
    try:
        if not table_exists(conn, "memory"):
            raise SystemExit(f"memory 表不存在：{db}")
        clauses = []
        params: list[Any] = []
        if table_exists(conn, "memory_fts"):
            sql = (
                "SELECT m.key, m.value, m.tags, m.metadata, bm25(memory_fts) AS score, "
                "snippet(memory_fts, 1, '[[', ']]', '…', 16) AS snip "
                "FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid "
                "WHERE memory_fts MATCH ?"
            )
            params.append(fts_query(query))
        else:
            sql = (
                "SELECT key, value, tags, metadata, 0.0 AS score, substr(value, 1, 240) AS snip "
                "FROM memory WHERE (key LIKE ? OR value LIKE ? OR tags LIKE ?)"
            )
            like = f"%{query}%"
            params.extend([like, like, like])
        if prefix:
            clauses.append("m.key LIKE ?" if table_exists(conn, "memory_fts") else "key LIKE ?")
            params.append(f"{prefix}%")
        if tag:
            clauses.append("m.tags LIKE ?" if table_exists(conn, "memory_fts") else "tags LIKE ?")
            params.append(f"%,{tag},%")
        if not include_fragments:
            if table_exists(conn, "memory_fts"):
                clauses.append("m.key NOT LIKE '%#%'")
                clauses.append("(m.tags IS NULL OR m.tags NOT LIKE '%,fragment,%')")
            else:
                clauses.append("key NOT LIKE '%#%'")
                clauses.append("(tags IS NULL OR tags NOT LIKE '%,fragment,%')")
        if clauses:
            sql += " AND " + " AND ".join(clauses)
        order = " ORDER BY score" if table_exists(conn, "memory_fts") else ""
        sql += order + " LIMIT ?"
        params.append(max(1, min(limit, 50)))
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()

    out = []
    for row in rows:
        meta = parse_metadata(row["metadata"])
        text = decode_value(row["value"])
        snip = str(row["snip"] or "").replace("\\n", " ").replace('\\"', '"')
        out.append(
            {
                "key": row["key"],
                "layer": meta.get("layer"),
                "category": meta.get("memory_category"),
                "tags": split_tags(row["tags"]),
                "score": row["score"],
                "snippet": snip or re.sub(r"\s+", " ", text)[:200],
                "text": text,
            }
        )
    return out


# ---------------------------------------------------------------------------
# repair
# ---------------------------------------------------------------------------
def plan_repair(
    rows: list[dict],
    *,
    ttl: bool = False,
    approve_inherited: bool = True,
) -> tuple[list[dict], list[str]]:
    by_key = {r["key"]: r for r in rows}
    plans: list[dict] = []
    notes: list[str] = []

    for r in rows:
        key, meta, tags = r["key"], dict(r["meta"]), list(r["tags"])
        changed = False
        note = ""
        ttl_override: int | None = None

        if key.startswith(CHECKPOINT_PREFIX):
            if meta.get("layer") is not None or "L0" in tags or meta.get("memory_category") != "state":
                meta["layer"] = None
                meta["memory_category"] = "state"
                meta["scope"] = meta.get("scope") or "project"
                meta["runtime_state"] = True
                strip_layer_tags(tags)
                tags[:] = [t for t in tags if t != "L0"]
                changed |= add_tag(tags, "vc-checkpoint")
                changed |= add_tag(tags, RUNTIME_STATE_TAG)
                changed |= add_tag(tags, "scope:project")
                changed = True
                note = "checkpoint → category=state / layer=null"
        elif is_fragment(key, meta, tags):
            changed |= add_tag(tags, FRAGMENT_TAG)
            parent_key = parent_of(key, meta)
            parent = by_key.get(parent_key) if parent_key else None
            if parent is None:
                notes.append(f"SKIP {key}: 父条目不存在，保持原状")
                continue
            pmeta = parent["meta"]
            ttl_override = parent["ttl"]
            for field in ("layer", "memory_category", "scope", "confidence", "evidence_level", "protected"):
                if field not in meta:
                    meta[field] = pmeta.get(field)
                    changed = True
                elif meta.get(field) is None and pmeta.get(field) is not None:
                    meta[field] = pmeta.get(field)
                    changed = True
            if not meta.get("status") and pmeta.get("status"):
                meta["status"] = pmeta["status"]
                changed = True
            if not meta.get("review_status") and pmeta.get("review_status"):
                meta["review_status"] = pmeta["review_status"]
                changed = True
            if (
                approve_inherited
                and pmeta.get("review_status") == "approved"
                and meta.get("review_status") == "pending"
                and str(meta.get("created_by", "")).startswith("memops-split")
                and meta.get("source_chars")
                and meta.get("part")
            ):
                meta["review_status"] = "approved"
                meta["review_basis"] = "parent-approved+lossless-split"
                meta["needs_review"] = False
                changed = True
            evidence = list(meta.get("evidence_ids") or [])
            for ref in list(pmeta.get("evidence_ids") or []):
                if ref not in evidence:
                    evidence.append(ref)
            for path in archive_refs(parent["value"]):
                ref = f"file:{path}#{parent_key}"
                if ref not in evidence:
                    evidence.append(ref)
            if evidence != list(meta.get("evidence_ids") or []):
                meta["evidence_ids"] = evidence
                changed = True
            elif "evidence_ids" not in meta:
                meta["evidence_ids"] = evidence
                changed = True
            if meta.get("parent_key") != parent_key:
                meta["parent_key"] = parent_key
                changed = True
            if not meta.get("derived_from"):
                meta["derived_from"] = parent_key
                changed = True
            if not meta.get("legacy_id"):
                meta["legacy_id"] = parent_key
                changed = True
            new_hash = content_hash(r["value"])
            if meta.get("content_hash") != new_hash:
                meta["content_hash"] = new_hash
                changed = True
            changed |= merge_basis(
                meta, ["fragment:inherit-parent"], ["分片继承父条目的分层/证据/作用域"]
            )
            if not meta.get("layer") and meta.get("memory_category") not in (None, "knowledge"):
                changed |= strip_layer_tags(tags)
            note = f"fragment inherit ← {parent_key}"
        elif "layer" not in meta:
            cls = classify(key, r["value"], meta, tags)
            meta["layer"] = cls["layer"]
            meta["memory_category"] = cls["category"]
            meta["needs_review"] = cls["needs_review"]
            merge_basis(meta, cls["rule_ids"], cls["reasons"])
            changed = True
            note = f"classify → {cls['layer']} / {cls['category']}"

        if meta.get("memory_category") == "experience":
            meta["memory_category"] = "knowledge"
            changed = True

        layer = meta.get("layer")
        if layer:
            changed |= add_tag(tags, layer_tag(layer) or "")
        else:
            changed |= strip_layer_tags(tags)

        # 悬空 evidence：不静默删除证据，移到 evidence_missing 供人工补证。
        refs = [ref for ref in (meta.get("evidence_ids") or []) if isinstance(ref, str)]
        known = set(by_key)
        missing = [ref for ref in refs if not evidence_ref_exists(ref, known)]
        if missing:
            meta["evidence_ids"] = [ref for ref in refs if ref not in missing]
            bucket = list(meta.get("evidence_missing") or [])
            for ref in missing:
                if ref not in bucket:
                    bucket.append(ref)
            meta["evidence_missing"] = bucket
            changed = True

        new_ttl = r["ttl"]
        if ttl and r["ttl"] is None and prefix_of(key) in TTL_DEFAULTS:
            meta["ttl_policy"] = f"{prefix_of(key)}:{TTL_DEFAULTS[prefix_of(key)] // 86400}d"
            new_ttl = (
                ttl_override
                if (ttl_override and ttl_override > now_ms())
                else (now_ms() + TTL_DEFAULTS[prefix_of(key)] * 1000)
            )
            changed = True

        if changed:
            plans.append(
                {
                    "key": key,
                    "metadata": meta,
                    "tags": tags,
                    "ttl_expires_at": new_ttl,
                    "note": note,
                }
            )
    return plans, notes


def backup_db(db: Path, out_dir: Path, tag: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = out_dir / f"db.sqlite.bak-{tag}-{stamp}-{MEMOPS_VERSION}"
    n = 1
    while dest.exists():
        dest = out_dir / f"db.sqlite.bak-{tag}-{stamp}-{n}-{MEMOPS_VERSION}"
        n += 1
    conn = sqlite3.connect(str(db), timeout=15)
    try:
        conn.execute("VACUUM INTO ?", (str(dest),))
        count = conn.execute("SELECT count(*) FROM memory").fetchone()[0]
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        conn.close()
    chk = sqlite3.connect(f"file:{dest}?mode=ro", uri=True)
    try:
        bak_count = chk.execute("SELECT count(*) FROM memory").fetchone()[0]
        bak_integrity = chk.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        chk.close()
    if count != bak_count or integrity != "ok" or bak_integrity != "ok":
        raise SystemExit(f"备份校验失败：{dest}")
    return dest


def apply_repair(db: Path, plans: list[dict], backup_dir: Path) -> dict:
    if not plans:
        return {"backup": None, "updated": 0}
    bak = backup_db(db, backup_dir, "memops-repair")
    conn = sqlite3.connect(str(db), timeout=15)
    conn.execute("PRAGMA busy_timeout = 15000")
    try:
        conn.execute("BEGIN IMMEDIATE")
        for plan in plans:
            conn.execute(
                "UPDATE memory SET metadata=?, tags=?, ttl_expires_at=? WHERE key=?",
                (
                    json.dumps(plan["metadata"], ensure_ascii=False),
                    norm_tags(plan["tags"]),
                    plan["ttl_expires_at"],
                    plan["key"],
                ),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {"backup": str(bak), "updated": len(plans)}


# ---------------------------------------------------------------------------
# split
# ---------------------------------------------------------------------------
def split_sections(text: str) -> tuple[str, list[tuple[str, str]]]:
    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if line.startswith("## ")]
    if not starts:
        return text.strip(), []
    preamble = "\n".join(lines[: starts[0]]).strip()
    sections = []
    for idx, start in enumerate(starts):
        end = starts[idx + 1] if idx + 1 < len(starts) else len(lines)
        heading = lines[start][3:].strip()
        block = "\n".join(lines[start:end]).strip()
        sections.append((heading, block))
    return preamble, sections


def group_sections(
    preamble: str, sections: list[tuple[str, str]], max_chars: int
) -> list[list[tuple[str, str]]]:
    parts: list[list[tuple[str, str]]] = []
    current: list[tuple[str, str]] = []
    size = len(preamble)
    for heading, block in sections:
        if current and size + len(block) > max_chars:
            parts.append(current)
            current, size = [], 0
        current.append((heading, block))
        size += len(block)
    if current:
        parts.append(current)
    return parts


def slugify(text: str) -> str:
    slug = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", text or "").strip("-")
    return (slug[:24] or "part").strip("-")


def archive_original(archive_dir: Path, key: str, text: str) -> str:
    archive_dir.mkdir(parents=True, exist_ok=True)
    path = archive_dir / "split-originals.md"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(f"\n## {key}\n\n```text\n{text}\n```\n")
    return str(path)


def build_router(key: str, title: str, parts: list[dict], archive_ref: str) -> str:
    rows = "\n".join(f"| `{p['key']}` | {p['topic']} | {p['chars']} |" for p in parts)
    return (
        f"# {title or key}\n\n"
        f"> 本条目为分片入口；原文完整归档：`{archive_ref}`\n\n"
        "## 分片索引\n\n"
        "| 分片 | 主题 | 字符 |\n"
        "|---|---|---|\n"
        f"{rows}\n\n"
        "> 读取策略：先读索引；需要细节时 `memory_get(\"<分片键>\")`。\n"
        "> 分片由 `memops.py split` 生成；默认召回排除 `fragment`。\n"
    )


def plan_split(db: Path, key: str, max_chars: int, archive_dir: Path) -> dict:
    conn = connect_ro(str(db))
    try:
        row = conn.execute(
            "SELECT key, value, tags, metadata, ttl_expires_at FROM memory WHERE key=?", (key,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise SystemExit(f"条目不存在：{key}")
    meta = parse_metadata(row["metadata"])
    tags = split_tags(row["tags"])
    text = decode_value(row["value"])
    preamble, sections = split_sections(text)
    if len(sections) < 2:
        raise SystemExit(f"{key} 没有可拆分的 H2 小节（至少需要 2 节）")
    groups = group_sections(preamble, sections, max_chars)
    if len(groups) < 2:
        raise SystemExit(f"{key} 在 max_chars={max_chars} 下无需拆分")
    parts = []
    for idx, group in enumerate(groups, 1):
        body = "\n\n".join(block for _, block in group)
        if idx == 1 and preamble:
            body = f"{preamble}\n\n{body}"
        topic = group[0][0] if len(group) == 1 else f"{group[0][0]} 等 {len(group)} 节"
        parts.append(
            {
                "key": f"{key}#{idx}-{slugify(topic)}",
                "topic": topic,
                "chars": len(body),
                "value": body,
            }
        )
    parent_layer = meta.get("layer")
    parent_status = meta.get("status") or "active"
    parent_review = meta.get("review_status") or "pending"
    archive_ref = str(archive_dir / "split-originals.md")
    router = build_router(key, str(meta.get("title") or key), parts, archive_ref)

    fragment_meta = dict(meta)
    fragment_meta.update(
        {
            "fragment": True,
            "parent_key": key,
            "derived_from": key,
            "legacy_id": meta.get("legacy_id") or key,
            "status": parent_status,
            "review_status": parent_review,
            "content_hash": None,
            "created_by": f"memops.py@{now_iso()[:10]}",
            "source_chars": len(text),
        }
    )
    if parent_layer is None and fragment_meta.get("memory_category") in (None, "knowledge"):
        fragment_meta["memory_category"] = "knowledge"
    fragment_tags = list(tags)
    add_tag(fragment_tags, FRAGMENT_TAG)
    if parent_layer:
        add_tag(fragment_tags, layer_tag(parent_layer) or "")

    parent_meta = dict(meta)
    parent_meta.update(
        {
            "fragment_keys": [p["key"] for p in parts],
            "split_at": now_iso(),
            "original_content_hash": content_hash(text),
            "archive_ref": archive_ref,
            "split_version": 1,
        }
    )
    merge_basis(parent_meta, ["fragment:split-parent"], ["父条目改写为分片入口，原文归档"])

    return {
        "db": str(db),
        "key": key,
        "archive_dir": str(archive_dir),
        "archive_ref": archive_ref,
        "original": text,
        "parent_value": router,
        "parent_meta": parent_meta,
        "parent_tags": tags,
        "fragment_meta": fragment_meta,
        "fragment_tags": fragment_tags,
        "parts": parts,
        "ttl": row["ttl_expires_at"],
    }


def apply_split(db: Path, plan: dict, backup_dir: Path, force: bool = False) -> dict:
    conn_rw = sqlite3.connect(str(db), timeout=15)
    conn_rw.execute("PRAGMA busy_timeout = 15000")
    try:
        existing = [
            r[0]
            for r in conn_rw.execute(
                "SELECT key FROM memory WHERE key LIKE ?", (plan["key"] + "#%",)
            ).fetchall()
        ]
        if existing and not force:
            raise SystemExit(f"已存在 {len(existing)} 个分片；如需重建请加 --force")
    finally:
        conn_rw.close()

    bak = backup_db(db, backup_dir, "memops-split")
    archive_dir = Path(plan["archive_dir"])
    archive_path = archive_original(archive_dir, plan["key"], plan["original"])
    archive_ref = f"file:{archive_path}#{plan['key']}"
    now = now_ms()
    ttl = plan["ttl"]
    if ttl is None and prefix_of(plan["key"]) in TTL_DEFAULTS:
        ttl = now + TTL_DEFAULTS[prefix_of(plan["key"])] * 1000

    conn = sqlite3.connect(str(db), timeout=15)
    conn.execute("PRAGMA busy_timeout = 15000")
    try:
        conn.execute("BEGIN IMMEDIATE")
        for part in plan["parts"]:
            meta = dict(plan["fragment_meta"])
            meta["part"] = int(part["key"].rsplit("#", 1)[1].split("-", 1)[0])
            meta["of_parts"] = len(plan["parts"])
            meta["title"] = part["topic"][:100]
            meta["content_hash"] = content_hash(part["value"])
            meta["source_chars"] = len(part["value"])
            evidence = list(meta.get("evidence_ids") or [])
            if archive_ref not in evidence:
                evidence.append(archive_ref)
            meta["evidence_ids"] = evidence
            merge_basis(meta, ["fragment:split"], ["从父条目按 H2 小节无损切分"])
            conn.execute(
                "INSERT INTO memory (key, value, created_at, updated_at, ttl_expires_at, tags, metadata) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    part["key"],
                    json.dumps(part["value"], ensure_ascii=False),
                    now,
                    now,
                    ttl,
                    norm_tags(plan["fragment_tags"]),
                    json.dumps(meta, ensure_ascii=False),
                ),
            )
        parent_meta = dict(plan["parent_meta"])
        parent_meta["archive_ref"] = archive_ref
        conn.execute(
            "UPDATE memory SET value=?, metadata=?, tags=?, updated_at=? WHERE key=?",
            (
                json.dumps(plan["parent_value"], ensure_ascii=False),
                json.dumps(parent_meta, ensure_ascii=False),
                norm_tags(plan["parent_tags"]),
                now,
                plan["key"],
            ),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {"backup": str(bak), "fragments": len(plan["parts"]), "archive": archive_ref}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="delx-memory 运维命令（validate/search/repair/split）")
    p.add_argument("--db", default=str(default_db()), help="记忆库路径（默认 DELX_MEMORY_DB 或 ~/.delx-memory/db.sqlite）")
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("validate", help="只读检查分层/分片/TTL/证据引用")
    v.add_argument("--json", action="store_true")
    v.add_argument("--warnings-as-errors", action="store_true")
    v.add_argument("--max-examples", type=int, default=3)

    s = sub.add_parser("search", help="FTS 关键词检索（默认排除分片）")
    s.add_argument("query")
    s.add_argument("--prefix", default="")
    s.add_argument("--tag", default="")
    s.add_argument("--limit", type=int, default=5)
    s.add_argument("--include-fragments", action="store_true")
    s.add_argument("--json", action="store_true")

    r = sub.add_parser("repair", help="回填分片继承/checkpoint 语义/分层 tag（默认 dry-run）")
    r.add_argument("--apply", action="store_true")
    r.add_argument("--ttl", action="store_true", help="同时补齐缺失的默认 TTL")
    r.add_argument("--no-approve-inherited", action="store_true", help="不自动批准父条目已批准的机械分片")
    r.add_argument("--backup-dir", default=str(Path.home() / ".delx-memory" / "backups"))
    r.add_argument("--json", action="store_true")

    sp = sub.add_parser("split", help="按 H2 小节拆分长条目（默认 dry-run）")
    sp.add_argument("key")
    sp.add_argument("--max-chars", type=int, default=1800)
    sp.add_argument("--archive-dir", default=str(Path.home() / ".delx-memory" / "archive" / "memops-split"))
    sp.add_argument("--apply", action="store_true")
    sp.add_argument("--force", action="store_true")
    sp.add_argument("--backup-dir", default=str(Path.home() / ".delx-memory" / "backups"))
    sp.add_argument("--json", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    db = Path(args.db).expanduser()

    if args.cmd == "validate":
        report = validate_db(db, warnings_as_errors=args.warnings_as_errors, max_examples=args.max_examples)
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print_validate(report)
        return 0 if report["ok"] else 1

    if args.cmd == "search":
        rows = search_db(
            db,
            args.query,
            prefix=args.prefix,
            tag=args.tag,
            limit=args.limit,
            include_fragments=args.include_fragments,
        )
        if args.json:
            print(json.dumps(rows, ensure_ascii=False, indent=2))
        else:
            for row in rows:
                layer = row["layer"] or "-"
                print(f"- [{layer}] {row['key']}")
                print(f"    {row['snippet'][:240]}")
        return 0

    if args.cmd == "repair":
        conn = connect_ro(str(db))
        try:
            rows = load_rows(conn)
        finally:
            conn.close()
        plans, notes = plan_repair(
            rows,
            ttl=args.ttl,
            approve_inherited=not args.no_approve_inherited,
        )
        result = {
            "db": str(db),
            "dry_run": not args.apply,
            "planned": len(plans),
            "notes": notes,
            "changes": [
                {"key": p["key"], "note": p["note"], "layer": p["metadata"].get("layer")}
                for p in plans
            ],
        }
        if args.apply:
            result.update(apply_repair(db, plans, Path(args.backup_dir).expanduser()))
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(
                f"memops repair: {'DRY-RUN' if result['dry_run'] else 'APPLIED'} "
                f"planned={result['planned']} updated={result.get('updated', 0)}"
            )
            if result.get("backup"):
                print(f"  backup: {result['backup']}")
            for note in notes[:10]:
                print(f"  {note}")
            for change in result["changes"][:20]:
                print(f"  - {change['key']}  {change['note']}")
            if len(result["changes"]) > 20:
                print(f"  … 另有 {len(result['changes']) - 20} 条")
        return 0

    if args.cmd == "split":
        plan = plan_split(db, args.key, args.max_chars, Path(args.archive_dir).expanduser())
        if args.apply:
            result = apply_split(db, plan, Path(args.backup_dir).expanduser(), force=args.force)
        else:
            result = {
                "db": str(db),
                "dry_run": True,
                "key": args.key,
                "fragments": len(plan["parts"]),
                "keys": [p["key"] for p in plan["parts"]],
                "archive_ref": plan["archive_ref"],
            }
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(f"memops split: {'DRY-RUN' if result.get('dry_run') else 'APPLIED'} {args.key}")
            print(f"  fragments={result['fragments']}")
            for key in result.get("keys", []):
                print(f"  - {key}")
            if result.get("backup"):
                print(f"  backup: {result['backup']}")
            if result.get("archive"):
                print(f"  archive: {result['archive']}")
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
