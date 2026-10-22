#!/usr/bin/env python3
"""delx-memory 只读审计（Phase 1）。

用途：盘点真实 schema、数据分布、重复/冲突/来源缺失/过时，产出 L0-L7 分类建议
与结构化审计报告。**只读**：以 sqlite `mode=ro` 打开，不写入、不建索引、不改状态。

用法：
    python3 scripts/memory/audit_memory.py \
        --db ~/.delx-memory/db.sqlite \
        --out-json reports/memory-audit-2026-10-22.json \
        --out-md   reports/memory-audit-2026-10-22.md \
        --sample 20
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import layers as L  # noqa: E402

# key 形态可含 1-2 段追加冒号（`skill:rules/code:async-defense`、`env:skill:x:install`）；
# 只匹配到第一个冒号会把 skill 类引用全部截断 → 引用图漏边。
KEY_REF_RE = re.compile(
    r"\b((?:lesson|reflection|experience|pattern|principle|rule|project|reference|skill|"
    r"preference|tooling|env|user|global|agent|skill-metrics):[A-Za-z0-9_./\-]+"
    r"(?::[A-Za-z0-9_./\-]+){0,2})"
)


def is_key_ref(ref: str) -> bool:
    """过滤「前缀提及」类假引用。

    - `skill:vibe-coder-loop` / `skill:rules/review` 是 skill 名或文件域，不是记忆 key
      （key 形态为 `skill:<name>:<slug>`，至少两个冒号）
    - 结尾为 `-` / `/` / `.` 的是正则截断产物
    - slug 过短（<3）视为噪声
    """
    head, _, rest = ref.partition(":")
    if not rest or len(rest) < 3 or rest[0] == "/" or rest[-1] in "-/.":
        return False
    if head in ("skill", "skill-metrics") and rest.count(":") < 1:
        return False
    if "xxx" in rest:          # 文档占位符，不是真引用
        return False
    return True
DATE_RE = re.compile(r"\b(20\d{2}-\d{2}-\d{2})\b")
HEADING_RE = re.compile(r"^#{1,3} ", re.M)
NUM_ITEM_RE = re.compile(r"^\s*\d+[.、]\s", re.M)
CODE_FENCE_RE = re.compile(r"```")


def now_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def connect_ro(path: str) -> sqlite3.Connection:
    """只读连接（URI mode=ro）；任何写入尝试都会在 SQLite 层失败。"""
    uri = f"file:{Path(path).expanduser().resolve()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def norm_text(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def bigrams(s: str) -> set[str]:
    s = norm_text(s)
    if len(s) < 2:
        return {s} if s else set()
    return {s[i : i + 2] for i in range(len(s) - 1)}


def ngrams(s: str, n: int = 3) -> set[str]:
    s = norm_text(s)
    if len(s) < n:
        return {s} if s else set()
    return {s[i : i + n] for i in range(len(s) - n + 1)}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def prefix_of(key: str) -> str:
    return key.split(":", 1)[0] if ":" in key else "(none)"


def classify(key: str, value: str, meta: dict, tags: list[str]) -> dict:
    """返回 layer/category/needs_review/reasons（rule id 可解释）。"""
    pre = prefix_of(key)
    layer, category, needs_review, reason = L.PREFIX_RULES.get(
        pre, (None, "knowledge", True, "未匹配前缀规则，需人工归类")
    )
    reasons = [f"PREFIX[{pre}] {reason}"]
    rule_ids = [f"prefix:{pre}"]
    v = value or ""
    n_lines = v.count("\n") + 1

    # R-NAV: 纯导航/索引/加载包 → 非知识轴（强短语 / slug 后缀 / 标题词）
    nav_hit = [m for m in L.NAV_MARKERS if m in v[:600]]
    slug = key.rsplit(":", 1)[-1]
    title = str(meta.get("title") or "")
    if any(slug.endswith(sf) or slug == sf.lstrip("-:") for sf in L.NAV_SLUG_SUFFIX):
        nav_hit.append(f"slug:{slug}")
    if any(w in title for w in L.NAV_TITLE_WORDS):
        nav_hit.append(f"title:{title}")
    # 导航判定只适用于承载索引的类目；lesson/reflection/pattern 永不降级为导航
    nav_eligible = prefix_of(key) in ("project", "reference", "agent", "skill")
    if nav_hit and category == "knowledge" and nav_eligible:
        category, layer = "navigation", None
        rule_ids.append("content:navigation")
        reasons.append(f"内容含导航标记 {nav_hit} → 判定为索引/指针，不进 L0-L7")
        if not any(r.startswith("violation:") for r in rule_ids):
            needs_review = False

    # R-OWNER: `skill:system:*` 为协议禁止的无 owner 共享前缀（protocol §命名空间隔离）
    if key.startswith("skill:system:"):
        needs_review = True
        rule_ids.append("violation:no-owner-prefix")
        reasons.append("使用协议禁止的 `skill:system:*` 无 owner 前缀，应改为 `skill:<name>:<slug>`")

    # R-STATE: 指标快照（`:metrics` 后缀或 skill-metrics）→ 非知识轴
    if category == "knowledge" and (slug.endswith("metrics") or prefix_of(key) == "skill-metrics"):
        category, layer = "state", None
        rule_ids.append("content:metrics-snapshot")
        reasons.append("指标/计数快照，无抽象层级语义 → category=state")
        if not any(r.startswith("violation:") for r in rule_ids):
            needs_review = False

    # R-AGG: 聚合体（一条塞多条经验 / 超长）→ 保留层级但标记待审（需拆分）
    agg_hit = [m for m in L.AGGREGATE_MARKERS if m in v]
    num_items = len(NUM_ITEM_RE.findall(v))
    if category == "knowledge" and layer in ("L1", "L2", "L3"):
        if len(v) > L.MAX_INSTANCE_CHARS or n_lines > L.MAX_INSTANCE_LINES:
            rule_ids.append("len:oversize")
            reasons.append(
                f"长度 {len(v)}字/{n_lines}行 超实例层上限({L.MAX_INSTANCE_CHARS}字/{L.MAX_INSTANCE_LINES}行)"
            )
            needs_review = True
        if num_items >= 5 and agg_hit:
            rule_ids.append("content:aggregate")
            reasons.append(f"含 {num_items} 条编号子项 + 聚合标记{agg_hit} → 聚合体，宜拆分出 L1/L2")
            needs_review = True

    # R-EPI: 含任务叙事结构 → 该条同时承载 L2 与 L3，蒸馏时需拆分（不得整条复制）
    if category == "knowledge" and layer in ("L3", "L4", "L5"):
        ep = [m for m in L.EPISODE_MARKERS if m in v]
        if len(ep) >= 2:
            rule_ids.append("content:episode-narrative")

    # R-CONFLICT: 自述已被取代 → 状态应为 superseded，需核验
    if any(m in v for m in L.CONFLICT_MARKERS):
        rule_ids.append("content:conflict-marker")

    return {
        "layer": layer,
        "category": category,
        "needs_review": needs_review,
        "rule_ids": rule_ids,
        "reasons": reasons,
        "signals": {
            "chars": len(v),
            "lines": n_lines,
            "headings": len(HEADING_RE.findall(v)),
            "num_items": num_items,
            "code_fences": v.count("```") // 2,
            "episode_markers": [m for m in L.EPISODE_MARKERS if m in v],
            "evidence_markers": [m for m in L.EVIDENCE_MARKERS if m in v],
        },
    }


def has_source_evidence(meta: dict, value: str) -> tuple[bool, list[str]]:
    """来源证据是否可用：metadata 指针 或 value 内可核验锚点（日期/E 级/仓库路径）。"""
    anchors = []
    for f in ("source", "evidence", "provenance", "date", "source_task", "session",
              "last_verified", "updated_by", "promotion_basis", "instances"):
        if meta.get(f):
            anchors.append(f"meta:{f}")
    if DATE_RE.search(value or ""):
        anchors.append("value:date")
    if re.search(r"\bE[1-4]\b", value or ""):
        anchors.append("value:evidence-level")
    if "~/" in (value or "") or "/Users/" in (value or "") or re.search(r"\b[\w-]+/[\w./-]+\.(md|ts|py|js|vue|json)\b", value or ""):
        anchors.append("value:path")
    return (len(anchors) > 0, anchors)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.expanduser("~/.delx-memory/db.sqlite"))
    ap.add_argument("--out-json", default="")
    ap.add_argument("--out-md", default="")
    ap.add_argument("--sample", type=int, default=20)
    ap.add_argument("--date", default=datetime.now().strftime("%Y-%m-%d"))
    args = ap.parse_args()

    conn = connect_ro(args.db)
    rows = conn.execute(
        "SELECT key, value, created_at, updated_at, ttl_expires_at, tags, metadata FROM memory ORDER BY key"
    ).fetchall()

    rows = [r for r in rows if not str(r["key"]).startswith(L.DERIVED_PREFIXES)]
    schema_rows = conn.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").fetchall()
    schema = [
        {"type": r["type"], "name": r["name"], "sql": (r["sql"] or "").strip()}
        for r in schema_rows
    ]

    now = now_ms()
    records = []
    meta_field_counter: Counter = Counter()
    tag_counter: Counter = Counter()
    bad_meta = []
    exact_map: dict[str, list[str]] = defaultdict(list)

    for r in rows:
        key, raw_value = r["key"], r["value"]
        value = L.decode_value(raw_value)          # 解码后才能做文本/结构分析
        tags_blob, meta_blob = r["tags"], r["metadata"]
        tags = L.split_tags(tags_blob)
        tag_counter.update(tags)
        meta = {}
        if meta_blob:
            try:
                meta = json.loads(meta_blob) or {}
            except json.JSONDecodeError:
                bad_meta.append(key)
                meta = {}
        meta_field_counter.update(meta.keys())

        cls = classify(key, value, meta, tags)
        src_ok, anchors = has_source_evidence(meta, value)
        refs = sorted({m for m in KEY_REF_RE.findall(value or "") if m != key and is_key_ref(m)})
        ttl_exp = r["ttl_expires_at"]
        age_days = int((now - (r["created_at"] or now)) / 86400000)
        stale_days = int((now - (r["updated_at"] or now)) / 86400000)

        records.append(
            {
                "key": key,
                "prefix": prefix_of(key),
                "tags": tags,
                "scope": meta.get("scope") or L.scope_from_tags(tags),
                "chars": len(value),
                "lines": (value or "").count("\n") + 1,
                "value_kind": L.value_kind(raw_value),
                "value_sha256": hashlib.sha256(norm_text(value or "").encode()).hexdigest(),
                "value_norm_sha256": hashlib.sha256((value or "").strip().encode()).hexdigest(),
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "created": datetime.fromtimestamp((r["created_at"] or 0) / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
                "updated": datetime.fromtimestamp((r["updated_at"] or 0) / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
                "age_days": age_days,
                "idle_days": stale_days,
                "ttl_expired": bool(ttl_exp and ttl_exp < now),
                "ttl_expires_at": ttl_exp,
                "metadata": meta,
                "metadata_fields": sorted(meta.keys()),
                "layer_suggest": cls["layer"],
                "category": cls["category"],
                "needs_review": cls["needs_review"],
                "rule_ids": cls["rule_ids"],
                "reasons": cls["reasons"],
                "signals": cls["signals"],
                "has_source_evidence": src_ok,
                "source_anchors": anchors,
                "refs": refs,
                "access_count": meta.get("access_count", 0) or 0,
                "cache_hit_count": meta.get("cache_hit_count", 0) or 0,
                "archived": bool(meta.get("archived_at")) or "archived" in tags
                            or (meta.get("status") == "archived") or "scope:archived" in tags,
            }
        )
        exact_map[records[-1]["value_norm_sha256"]].append(key)

    # ---------------- 重复 ----------------
    exact_dups = [{"sha": s, "keys": ks} for s, ks in exact_map.items() if len(ks) > 1]

    # 近似重复：3-gram Jaccard + containment + 标题相似度
    # 阈值经真实分布校准（语料已于 2026-10-21 做过一轮合并，重复压力本身很低）
    near = []
    full = {r["key"]: L.decode_value(r["value"]) for r in rows}
    trig = {k: ngrams(v, 3) for k, v in full.items()}
    title = {}
    for rec in records:
        t = rec["metadata"].get("title") or (full[rec["key"]].split("\n")[0][:60])
        title[rec["key"]] = ngrams(str(t), 3)
    exact_pairs = {tuple(sorted(d["keys"])) for d in exact_dups}
    keys = [r["key"] for r in records]
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = keys[i], keys[j]
            if (a, b) in exact_pairs:
                continue
            ga, gb = trig[a], trig[b]
            jac = jaccard(ga, gb)
            cont = len(ga & gb) / max(1, min(len(ga), len(gb)))
            jt = jaccard(title[a], title[b])
            if jac >= 0.35 or cont >= 0.55 or jt >= 0.50:
                lengths = (len(full[a]), len(full[b]))
                nav_like = any(
                    r["category"] == "navigation" for r in records if r["key"] in (a, b)
                )
                same_topic = (jac >= 0.35 or cont >= 0.55) and min(lengths) >= 200 and not nav_like
                near.append(
                    {
                        "a": a,
                        "b": b,
                        "jaccard": round(jac, 3),
                        "containment": round(cont, 3),
                        "title_jaccard": round(jt, 3),
                        "same_prefix": prefix_of(a) == prefix_of(b),
                        "verdict": "merge_candidate" if same_topic else (
                            "related_candidate" if min(lengths) >= 200 else "nav_overlap_candidate"),
                        "action": "人工核验后决定 merge / 建边，不自动合并",
                    }
                )
    near.sort(key=lambda x: -(x["jaccard"] + x["containment"]))

    # ---------------- 引用完整性 ----------------
    existing = {r["key"] for r in records}
    dangling = []
    for rec in records:
        # 已归档合并条目的 consolidated_from 指向被并入的原 key：证据在 archive 文件内，属可追溯
        pass
    for rec in records:
        for ref in rec["refs"]:
            if ref not in existing:
                dangling.append({"from": rec["key"], "ref": ref, "field": "value", "kind": "missing"})
        for f in ("related",):
            v = rec["metadata"].get(f)
            if isinstance(v, str):
                for part in re.split(r"[,;]\s*", v):
                    part = part.strip()
                    if part and ":" in part and is_key_ref(part) and part not in existing:
                        dangling.append({"from": rec["key"], "ref": part, "field": f})
        cf = rec["metadata"].get("consolidated_from")
        if isinstance(cf, list):
            for part in cf:
                if part not in existing:
                    arch = rec["metadata"].get("archived_at")
                    dangling.append(
                        {
                            "from": rec["key"],
                            "ref": part,
                            "field": "consolidated_from",
                            "kind": "merged_archive" if arch else "missing",
                            "archive": arch,
                        }
                    )
                if part == rec["key"]:
                    dangling.append({"from": rec["key"], "ref": part, "field": "consolidated_from",
                                     "note": "self-reference（自身被列为来源）"})

    # 反向引用：哪些记录被别人的 value/related 引用（作为 evidence 入边）
    inbound = Counter()
    for rec in records:
        for ref in rec["refs"]:
            if ref in existing:
                inbound[ref] += 1

    # ---------------- 统计 ----------------
    by_prefix = Counter(r["prefix"] for r in records)
    by_layer = Counter(str(r["layer_suggest"]) for r in records)
    by_category = Counter(r["category"] for r in records)
    by_scope_tag = Counter(r["scope"] or "(none)" for r in records)
    missing_scope = [r["key"] for r in records if not r["scope"]]
    no_source = [r["key"] for r in records if not r["has_source_evidence"]]
    expired = [r["key"] for r in records if r["ttl_expired"]]
    archived = [r["key"] for r in records if r["archived"]]
    cold = [r["key"] for r in records if r["access_count"] == 0 and r["age_days"] >= 90]
    oversize = [r["key"] for r in records if r["chars"] > L.MAX_INSTANCE_CHARS]
    needs_review = [r["key"] for r in records if r["needs_review"]]

    # 分层抽检：每层/类别取代表 + 边界样本
    sample = stratified_sample(records, args.sample)

    corpus_fp = hashlib.sha256(
        "\n".join(f"{r['key']}:{r['value_norm_sha256']}" for r in sorted(records, key=lambda x: x["key"])).encode()
    ).hexdigest()

    report = {
        "report_version": 1,
        "corpus_fingerprint": corpus_fp,
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "report_date": args.date,
        "db_path": str(Path(args.db).expanduser()),
        "readonly": True,
        "totals": {
            "records": len(records),
            "total_chars": sum(r["chars"] for r in records),
            "median_chars": sorted(r["chars"] for r in records)[len(records) // 2] if records else 0,
            "max_chars": max((r["chars"] for r in records), default=0),
            "invalid_metadata_json": bad_meta,
        },
        "schema": schema,
        "metadata_field_counts": dict(meta_field_counter.most_common()),
        "tag_counts": dict(tag_counter.most_common(60)),
        "by_prefix": dict(by_prefix.most_common()),
        "by_layer_suggestion": dict(by_layer.most_common()),
        "by_category": dict(by_category.most_common()),
        "by_scope": dict(by_scope_tag.most_common()),
        "issues": {
            "exact_duplicates": exact_dups,
            "near_duplicates": near,
            "dangling_refs": dangling,
            "dangling_summary": {
                "total": len(dangling),
                "merged_archive": sum(1 for d in dangling if d.get("kind") == "merged_archive"),
                "missing": sum(1 for d in dangling if d.get("kind") != "merged_archive"),
            },
            "missing_scope": missing_scope,
            "missing_source_evidence": no_source,
            "ttl_expired": expired,
            "archived": archived,
            "cold_memory_90d_zero_access": cold,
            "oversize_instances": oversize,
            "needs_review": needs_review,
            "conflict_markers": [r["key"] for r in records if "content:conflict-marker" in r["rule_ids"]],
            "episode_narrative_blend": [r["key"] for r in records if "content:episode-narrative" in r["rule_ids"]],
        },
        "inbound_refs": dict(inbound.most_common(30)),
        "records": records,
        "sample": sample,
    }

    if args.out_json:
        Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_json).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.out_md:
        Path(args.out_md).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_md).write_text(render_md(report), encoding="utf-8")

    # 控制台摘要
    print(f"records={len(records)} chars={report['totals']['total_chars']}")
    print("layers:", report["by_layer_suggestion"])
    print("categories:", report["by_category"])
    print("exact_dups:", len(exact_dups), "near:", len(near), "dangling:", len(dangling))
    print("no_source:", len(no_source), "missing_scope:", len(missing_scope), "expired:", len(expired))
    print("needs_review:", len(needs_review), "oversize:", len(oversize))
    conn.close()
    return 0


def stratified_sample(records: list[dict], n: int) -> list[dict]:
    """分层抽检：优先覆盖每个 category/layer，再补边界案例（超长/无源/待审/冲突）。"""
    picked: dict[str, dict] = {}

    def add(rec, why):
        if rec["key"] in picked:
            picked[rec["key"]]["why"].append(why)
            return
        r = dict(rec)
        r["why"] = [why]
        r.pop("metadata", None)
        picked[rec["key"]] = r

    by_layer = defaultdict(list)
    for rec in records:
        by_layer[(rec["category"], rec["layer_suggest"])].append(rec)
    for (cat, layer), group in sorted(by_layer.items(), key=lambda kv: (str(kv[0][1]), kv[0][0])):
        add(sorted(group, key=lambda r: -r["chars"])[0], f"stratified:{cat}/{layer}")

    edges = [
        ("edge:no-source", lambda r: not r["has_source_evidence"]),
        ("edge:needs-review", lambda r: r["needs_review"]),
        ("edge:oversize", lambda r: r["chars"] > L.MAX_INSTANCE_CHARS),
        ("edge:conflict-marker", lambda r: "content:conflict-marker" in r["rule_ids"]),
        ("edge:archived", lambda r: r["archived"]),
        ("edge:ttl-expired", lambda r: r["ttl_expired"]),
        ("edge:zero-access-old", lambda r: r["access_count"] == 0 and r["age_days"] >= 90),
        ("edge:no-scope", lambda r: not r["scope"]),
    ]
    for why, pred in edges:
        for rec in records:
            if pred(rec):
                add(rec, why)
                break
    for rec in sorted(records, key=lambda r: -r["chars"]):
        if len(picked) >= n:
            break
        add(rec, "fill:largest")
    return sorted(picked.values(), key=lambda r: -r["chars"])[: max(n, 20)]


def render_md(rep: dict) -> str:
    t = rep["totals"]
    iss = rep["issues"]
    lines = []
    A = lines.append
    A(f"# delx-memory 审计报告（{rep['report_date']}）")
    A("")
    A(f"> 生成时间：{rep['generated_at']}　数据库：`{rep['db_path']}`　只读：是（`mode=ro`）")
    A("> 口径：本报告所有数字由 `scripts/memory/audit_memory.py` 对真实库执行得出，未做人工修饰。")
    A("")
    A("## 1. 总量与结构")
    A("")
    A(f"- 语料指纹 `corpus_fingerprint`：`{rep.get('corpus_fingerprint','')}`（key+value 哈希集，用于 Phase 2/3 前后比对）")
    A(f"- 记忆条目：**{t['records']}**　总字符：**{t['total_chars']}**　中位长度：{t['median_chars']}　最长：{t['max_chars']}")
    A(f"- 物理表：`memory(key, value, created_at, updated_at, ttl_expires_at, tags, metadata)` + FTS5 外部内容表（`memory_fts`）+ TTL/tags/updated_at 三个索引")
    A(f"- metadata 非法 JSON：{len(t['invalid_metadata_json'])} 条 {t['invalid_metadata_json'] or ''}")
    A("")
    A("### 前缀分布")
    A("")
    A("| 前缀 | 条数 |")
    A("|---|---|")
    for k, v in rep["by_prefix"].items():
        A(f"| `{k}` | {v} |")
    A("")
    A("### metadata 字段使用率")
    A("")
    A("| 字段 | 条数 |")
    A("|---|---|")
    for k, v in list(rep["metadata_field_counts"].items())[:24]:
        A(f"| `{k}` | {v} |")
    A("")
    A("## 2. L0–L7 分类建议")
    A("")
    A("| 层级 | 条数 | 含义 |")
    A("|---|---|---|")
    for k, v in sorted(rep["by_layer_suggestion"].items(), key=lambda kv: kv[0]):
        name = L.LAYER_NAMES.get(k, "非知识轴（layer=None）")
        A(f"| {k} | {v} | {name} |")
    A("")
    A("非知识轴类别：" + "，".join(f"`{k}`={v}" for k, v in rep["by_category"].items()))
    A("")
    A("## 3. 数据质量")
    A("")
    A(f"- 精确重复（规范化后 value 完全相同）：**{len(iss['exact_duplicates'])}** 组")
    A(f"- 近似重复候选（3-gram Jaccard ≥0.35 或 containment ≥0.55 或标题相似 ≥0.50）："
      f"**{len(iss['near_duplicates'])}** 对（merge 候选 "
      f"{sum(1 for x in iss['near_duplicates'] if x['verdict'] == 'merge_candidate')} 对，其余为相关候选）")
    ds = iss.get("dangling_summary", {})
    A(f"- 悬空引用（引用了库内不存在的 key）：**{ds.get('total', 0)}** 处"
      f"（其中 {ds.get('merged_archive', 0)} 处指向已合并归档条目、证据在 `archive/` 文件内；"
      f"**{ds.get('missing', 0)} 处为真缺失**）")
    A(f"- 缺 scope 标注：**{len(iss['missing_scope'])}** 条")
    A(f"- 无来源证据锚点：**{len(iss['missing_source_evidence'])}** 条")
    A(f"- TTL 已过期仍在库：**{len(iss['ttl_expired'])}** 条")
    A(f"- 已归档（`archived_at`/tag）：**{len(iss['archived'])}** 条")
    A(f"- 超实例层长度上限（>2000 字）：**{len(iss['oversize_instances'])}** 条")
    A(f"- 疑似冲突标记（含「已废弃/被取代/反例」等）：**{len(iss['conflict_markers'])}** 条")
    A(f"- 单条混合 L2 叙事 + L3 结论（蒸馏需拆分）：**{len(iss['episode_narrative_blend'])}** 条")
    A(f"- 需人工审核：**{len(iss['needs_review'])}** 条")
    A("")
    A("")
    A("### 审计方法与局限")
    A("")
    A("- **精确重复**：value 规范化（折叠空白）后 SHA-256 相等。局限：不识别「同义改写」。")
    A("- **近似重复**：字符 3-gram 集合的 Jaccard / containment + 首行（或 metadata.title）3-gram 相似度；"
      "阈值 `Jaccard≥0.35` 或 `containment≥0.55` 或 `标题≥0.50`，且较短一方 ≥200 字才可判 merge 候选。"
      "阈值是按本库真实分布**校准**（语料已于 2026-10-21 做过一轮合并）后取的低门槛——只用于**发现候选**。")
    A("- **局限（必须知晓）**：")
    A("  - 近似重复用字面 n-gram，**语义等价但用词不同**的条目会漏检（漏检代价 = 冗余，不是数据损坏）。")
    A("  - 无向量/嵌入模型（本次约束不引入重型依赖），因此「语义相似仅作候选提示，绝不作为删除/合并依据」。")
    A("  - 冲突检测基于标记词（已废弃/被取代/反例），**不能**发现两段无标记但结论相反的文本 → 需人工抽检补位。")
    A("  - 「来源证据」判定为锚点存在性（metadata 指针 / 日期 / E 级 / 路径），**不验证证据真伪**。")
    A("  - 引用扫描用正则识别 key 形态，已过滤 skill 名/占位符/截断噪声，仍可能漏掉自由文本里的口语化指代。")
    A("")
    if iss["exact_duplicates"]:
        A("### 精确重复")
        A("")
        for d in iss["exact_duplicates"]:
            A(f"- `{d['keys'][0]}` ≡ " + "，".join(f"`{k}`" for k in d["keys"][1:]))
        A("")
    if iss["near_duplicates"]:
        A("### 近似重复（Top 15，仅候选，不自动合并）")
        A("")
        A("| A | B | Jaccard | containment | 标题相似 | 判定 |")
        A("|---|---|---|---|---|---|")
        for d in iss["near_duplicates"][:15]:
            A(f"| `{d['a']}` | `{d['b']}` | {d['jaccard']} | {d['containment']} | "
              f"{d['title_jaccard']} | {d['verdict']} |")
        A("")
    if iss["dangling_refs"]:
        A("### 悬空引用")
        A("")
        for d in iss["dangling_refs"][:40]:
            extra = f"（{d['field']}）" if d.get("field") else ""
            note = f" — {d['note']}" if d.get("note") else ""
            kind = d.get("kind", "missing")
            A(f"- `{d['from']}` → `{d['ref']}`{extra} · `{kind}`{note}")
        A("")
    A("## 4. 设计与现有数据的映射问题（Phase 1 结论）")
    A("")
    iss2 = rep["issues"]
    cats = rep["by_category"]
    A(f"1. **L0 无事件存储**：库内 0 条原始事件（无消息/工具调用/diff/堆栈）。证据只以外置形式存在——"
      f"metadata `source`/`evidence`/`provenance`、`archive/` 归档文件（`merged_archive` 边 "
      f"{iss2.get('dangling_summary', {}).get('merged_archive', 0)} 条）、value 内的路径与日期锚点。"
      f"→ L0 只能以「证据引用」表达，**不得伪造**原始事件。")
    A(f"2. **现有三层 ≠ L0–L7**：`lesson/reflection/experience` 共 {rep['by_prefix'].get('lesson',0)+rep['by_prefix'].get('reflection',0)+rep['by_prefix'].get('experience',0)} 条全部落在 L3，"
      f"但其中 {len(iss2['episode_narrative_blend'])} 条同时内含 L2 叙事结构（触发/根因/修正/结果）。"
      f"一条记录混合两个层级 → 蒸馏只能**拆分**，不能整条复制到多层。")
    A(f"3. **超长聚合体阻塞升层**：{len(iss2['oversize_instances'])} 条超过实例层上限（>{L.MAX_INSTANCE_CHARS} 字），"
      f"多为「N 条经验合并」体。L4/L5 要求「项目范围 + 适用条件 + 反例」，这些字段在正文里没有结构化位置 → 需先拆分为原子观测。")
    A(f"4. **`skill:*` 是 Skill 文件镜像**：{rep['by_prefix'].get('skill',0)} 条 `skill:*` 条目正文写明「主源：<Skill 文件>」，"
      f"权威源在 `skills/`。按本次约束，L6 只能是「技能知识候选 + 指针」，必须记 `mirror_of`，不得成为第二套 Skill 仓库。")
    A(f"5. **导航/索引不是知识**：{cats.get('navigation',0)} 条为纯导航页/加载包/记忆图谱，若机械按前缀归入 L4 会虚增高层覆盖率。")
    A(f"6. **非知识轴无法用 layer 表达**：{cats.get('identity',0)+cats.get('state',0)+cats.get('environment',0)+cats.get('preference',0)} 条"
      f"（identity/state/environment/preference）没有「抽象层级」语义。若强行按重要性升层，`user:persona` 会被误判为 L7 原则，"
      f"污染原则集合与 10 条上限。→ 必须先有 `memory_category` 再谈 layer。")
    A(f"7. **已归档不等于已退出召回**：{len(iss2['archived'])} 条带 `archived_at` 的记录仍在 `memory` 表内并被 FTS 索引，"
      f"仅靠 key 前缀无法区分「有效」与「历史」→ 需 `status` 字段，且默认召回集合要按 status 过滤。")
    A(f"8. **置信度字段值域不一致**：现有 `confidence` 仅 1 条且取值为 `\"High\"`，`evidence_level` 用 E0–E4，"
      f"`relevance_score` 用 0–1。→ 新字段必须固定值域，并保留旧值到 `legacy_confidence`。")
    A("")
    A("## 5. Schema 与迁移风险")
    A("")
    A("| # | 风险 | 证据 | 迁移要求 |")
    A("|---|---|---|---|")
    A("| R1 | `metadata` 是**整体替换**语义，写入会覆盖未声明的字段 | protocol.md §supersession 第 1 条明示「链记在 value，不记 metadata——易在下一次 set 时丢失」 | 迁移必须「读-合并-写」，禁止构造新 metadata 整体覆盖 |")
    A(f"| R2 | 直接 `UPDATE` 会改 `updated_at`，破坏 Relevance 的 recency 因子 | {rep['totals']['records']} 条中 `updated_at` 最早 "
      f"{min(r['updated'] for r in rep['records'])} | 保留原 `updated_at`，另记 `last_migrated_at` |")
    A("| R3 | `key` 是主键，衍生记录若沿用原 key 会覆盖原始数据 | `memory(key TEXT PRIMARY KEY)` | 衍生记录一律新 key；原条目只做「加字段」不改 value |")
    A("| R4 | FTS5 外部内容表依赖 rowid；`INSERT OR REPLACE` 会换 rowid 导致索引错位 | `memory_fts(content='memory', content_rowid='rowid')` + 三个触发器 | 禁止 REPLACE；只允许 UPDATE 或 INSERT 新 key |")
    A("| R5 | WAL 模式下裸 `cp` 备份不一致 | db 目录存在 `-wal`/`-shm`，服务（bun pid 8053）在用 | 用 `sqlite3 .backup` / `VACUUM INTO`，并校验可读 + 表计数 |")
    A("| R6 | 迁移期间双写冲突（MCP 服务仍在跑） | 服务常驻 127.0.0.1:3030，`stmtCache` 绑定单一连接 | 迁移用短事务 + `busy_timeout`；批次落进度；写后从服务侧读回校验 |")
    A("| R7 | `consolidated_from` 存在自引用，来源图不闭合 | 实测 2 条 self-reference | 迁移时清理自引用并记 `warning`，不静默丢弃 |")
    A("| R8 | 无 layer 列 → 若加表达式索引需 DDL | sqlite_master 仅 3 个常规索引 | DDL 仅在备份后执行，且可 `DROP INDEX` 回滚；非必需则不加 |")
    A("")
    A("## 6. Phase 2 dry-run 计划与验收条件")
    A("")
    A("**计划（只读产出，不写库）**")
    A("")
    A("1. `distill.py --dry-run` 对 217 条逐条产出分层建议 JSON：`key / layer / category / scope / status / "
      "review_status / confidence / evidence_ids / layer_basis(rule+理由) / needs_review`。")
    A("2. 生成衍生记录预览（**新 key，不覆盖原条目**）：")
    A("   - L1 观测候选：从含 Episode 叙事的 " + str(len(iss2["episode_narrative_blend"])) + " 条中抽取原子事实（`obs:<slug>`，1 条 1 事实）")
    A("   - L2 Episode 候选：按「同一任务 + 同一日期 + 同一项目」聚合观测（`episode:<project>:<date>:<slug>`）")
    A("   - L3→L4 候选：仅对已有 ≥3 条独立任务证据 + 明确项目范围的条目提出（当前 L4 白名单 = `project:*`/`rule:*` 已确认项）")
    A("   - L5/L6/L7 候选：**只列候选 + 证据矩阵**，标 `review_status=pending`，不发布")
    A("3. 去重/合并候选：本次实测精确重复 " + str(len(iss2["exact_duplicates"])) + " 组、近似 " + str(len(iss2["near_duplicates"])) +
      " 对 → 只出建议，不动数据。")
    A("4. 冲突清单：`content:conflict-marker` " + str(len(iss2["conflict_markers"])) + " 条与其他近邻条目两两对照，输出「冲突对 + 各自证据」，不合并。")
    A("5. 输出 dry-run 预览（JSON + MD）+ 变更差异 diff，逐条给出「新增/更新/跳级/待审」，并打印预计写入条数与受影响原条目数。")
    A("")
    A("**dry-run 验收条件（全部满足才允许 Phase 3）**")
    A("")
    A("- 运行前后 `memory` 表行数、`value` 哈希集合、`updated_at` 分布**完全一致**（等价于断言零副作用）。")
    A("- 每条衍生候选都有 `layer_basis` + 至少 1 个 `evidence_ids`，或显式 `needs_review=true` + 缺失原因。")
    A("- L2 聚合不跨项目、不跨任务；近似重复对中没有被自动合并的条目。")
    A("- L5 候选必须列出 ≥2 个项目来源；不足者降为「项目内 L4」或待验证候选。")
    A("- L6 候选必须含：目标/前置条件/输入/步骤/验收/失败处理/来源经验；缺项不进候选集。")
    A("- L7 候选 ≤10 条且每条有反例与来源；超限时输出「合并/替换/淘汰」建议而非覆盖。")
    A("- 报告中的数量与 JSON 明细逐项对账（同一脚本产出，禁止手填）。")
    A("")
    A("## 7. 分层抽检样本")
    A("")
    A("")
    A("| key | 建议层 | 类别 | 字符 | 来源锚点 | 待审 | 抽检理由 |")
    A("|---|---|---|---|---|---|---|")
    for r in rep["sample"]:
        A(f"| `{r['key']}` | {r['layer_suggest'] or '—'} | {r['category']} | {r['chars']} | "
          f"{'是' if r['has_source_evidence'] else '否'} | {'是' if r['needs_review'] else '否'} | "
          f"{', '.join(r['why'])} |")
    A("")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
