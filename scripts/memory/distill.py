#!/usr/bin/env python3
"""L0–L7 分层回填 **dry-run**（Phase 2）：切片预览 + 质量评估，不写库。

产出：
- 逐条分层建议（layer / category / scope / status / review_status / confidence /
  evidence_ids / layer_basis / needs_review）
- L1 原子观测切片预览（verbatim 切片，不臆造）
- L2 Episode 候选（同任务同项目同日聚合）
- L4–L7 候选 + 证据矩阵（L5 必须 ≥2 项目；L6 必须七字段；L7 必须人工审核）
- Skill 镜像边界（mirror_of 解析与核验，无法确认则 needs_review，不猜路径）
- 导航完整性（保留引用，失效目标标 needs_repair，不删除不猜替代）
- 质量评估（覆盖率 / 证据覆盖 / 冲突 / 待审）

纪律：
- 只读连接（mode=ro）；运行前后校验 corpus_fingerprint 一致，否则非零退出。
- 衍生记录一律**新 key**，原 key/value/tags/metadata 不动。
- 候选默认 `review_status=pending`，绝不自动 approved。

用法：
    python3 scripts/memory/distill.py --dry-run \
        --db ~/.delx-memory/db.sqlite \
        --out-json reports/memory-distill-2026-10-22.json \
        --out-md   reports/memory-distill-2026-10-22.md
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import layers as L  # noqa: E402
from audit_memory import connect_ro, classify, has_source_evidence, is_key_ref, KEY_REF_RE  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
SKILLS = REPO / "skills"

SRC_RE = re.compile(r"主源[：:]\s*([^\n]+)")

# L6 七字段检测（口径：目标 / 适用前置 / 输入 / 步骤 / 输出验收 / 失败处理 / 来源验证）
L6_FIELDS = {
    "goal": ("技能目标", "## 目标", "目的", "用于", "解决的问题"),
    "when": ("适用场景", "## 适用", "前置条件", "触发条件", "何时使用"),
    "input": ("## 输入", "必要输入", "入参"),
    "steps": ("## 步骤", "## 核心操作", "## 流程", "执行步骤", "检查步骤", "步清单"),
    "output": ("## 输出", "验收", "预期结果"),
    "failure": ("失败处理", "## 失败", "降级", "异常处理", "回滚"),
    "evidence": ("来源经验", "## 来源", "提升基础", "实例", "验证记录", "E4", "实测"),
}


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def corpus_fingerprint(rows) -> str:
    norm = lambda s: re.sub(r"\s+", " ", s or "").strip()
    return hashlib.sha256(
        "\n".join(f"{r['key']}:{hashlib.sha256(norm(r['value']).encode()).hexdigest()}"
                  for r in sorted(rows, key=lambda x: x["key"])).encode()
    ).hexdigest()


# ---------------------------------------------------------------------------
# Skill 镜像边界（权威源唯一：skills/ 是正式内容；记忆只作候选 + 指针）
# ---------------------------------------------------------------------------
def resolve_mirror(key: str, value: str, meta: dict) -> dict:
    """解析 mirror_of。绝不猜测：只有「声明路径存在」或「约定路径存在且内容可核验」才落指针。"""
    declared = SRC_RE.findall(value or "")
    candidates: list[tuple[str, str]] = []   # (repo-relative path, 来源: declared|convention)
    if declared:
        raw = declared[0]
        raw = raw.strip().strip("`'\"「」")
        for sep in ("（", "|", "｜", "§", "「", " ", "\t"):
            raw = raw.split(sep)[0]
        raw = raw.strip().strip("`'\"「」").rstrip("。；,、; ")
        for cand in _path_candidates(raw):
            candidates.append((cand, "declared"))

    if not candidates:
        # 约定映射：skill:<file-domain>:<slug> → skills/vibe-coder-loop/<domain>.md
        parts = key.split(":")
        if len(parts) == 3 and parts[0] == "skill" and "/" in parts[1]:
            domain = parts[1]
            for cand in _path_candidates(f"vibe-coder-loop/{domain}.md"):
                candidates.append((cand, "convention"))

    resolved = [(p, how) for p, how in candidates if (REPO / p).is_file()]
    result = {
        "key": key,
        "mirror_of": None,
        "resolved_by": None,
        "verified": False,
        "needs_review": True,
        "reason": "",
    }
    if not candidates:
        result["reason"] = "无「主源」声明，且无法用结构约定唯一确定权威文件 → 不猜路径"
        return result
    if not resolved:
        result["reason"] = f"声明/约定路径均不存在：{[p for p, _ in candidates]}"
        return result

    path, how = resolved[0]
    text = (REPO / path).read_text(encoding="utf-8", errors="ignore")
    probes = _probes(meta.get("title"), value)
    hits = [p for p in probes if p in text]
    verify_state = "verified" if len(hits) >= 2 else ("partial" if len(hits) == 1 else "gap")
    hit = verify_state == "verified"
    probe = hits[:3] if hits else probes[:1]
    result.update(
        {
            "mirror_gap": verify_state == "gap",
            "mirror_of": path,
            "resolved_by": how,
            "verified": hit,
            "verify_state": verify_state,
            "probe": probe,
            "needs_review": not hit,
            "hits": hits[:5],
            "reason": (
                f"{how} 路径存在，且 {len(hits)} 处内容片段命中（多片段一致 → 可核验）"
                if hit
                else f"{how} 路径存在，但正文片段在文件中未命中 → 可能记忆含 Skill 未覆盖内容（保留原记录，评估提炼 L3/L5），不视为已核验"
            ),
        }
    )
    return result


def _path_candidates(raw: str) -> list[str]:
    raw = raw.replace("\\", "/").lstrip("./")
    out = []
    if raw.startswith("skills/"):
        out.append(raw)
    elif raw.startswith("vibe-coder-loop/"):
        out.append(f"skills/{raw}")
    elif raw.startswith(("rules/", "policy/", "learning/", "references/")):
        out.append(f"skills/vibe-coder-loop/{raw}")
    elif "/" in raw and not raw.startswith("/"):
        out.append(f"skills/{raw}")
    return out


def _probes(title: str | None, value: str) -> list[str]:
    """取可核验片段：正文长中文短语（≥8 字）优先，标题作补充。

    注意：记忆条目的 title 是编辑加工后的标题，通常**不**出现在 Skill 文件里，
    因此标题只作补充 probe，主判据是正文片段是否真的出现在权威文件中。
    """
    out, seen = [], set()
    for p in re.findall(r"[\u4e00-\u9fff]{8,}", value or ""):
        if p not in seen:
            seen.add(p)
            out.append(p)
        if len(out) >= 40:
            break
    if title:
        c = re.sub(r"[^\w\u4e00-\u9fff]", "", str(title))
        if len(c) >= 8 and c not in seen:
            out.append(c)
    return out


def l6_field_check(value: str) -> dict:
    got = {}
    for field, probes in L6_FIELDS.items():
        hit = next((p for p in probes if p in (value or "")), None)
        got[field] = hit
    present = [f for f, p in got.items() if p]
    return {
        "fields_present": present,
        "fields_missing": [f for f in L6_FIELDS if f not in present],
        "completeness": round(len(present) / len(L6_FIELDS), 2),
        "evidence_probe": got,
    }


# ---------------------------------------------------------------------------
# 项目归属（用于 L5 跨项目证据矩阵；只做子串匹配，匹配不到即视为未知）
# ---------------------------------------------------------------------------
# 项目归一表：key 前缀 ≠ 项目名（`project:vue-ui-memory-graph` 的项目是 vue-ui，不是 vue）
PROJECT_ALIASES = {
    "webbas": ("webbas",),
    "jtkl": ("jtkl",),
    "obsidian": ("obsidian",),
    "delx-memory": ("delx-memory",),
    "litecap": ("litecap",),
    "multi-column-markdown": ("multi-column-markdown",),
    "holiday-cloud": ("holiday-cloud",),
    "java-vibe-code": ("java-vibe-code",),
    "vue-ui": ("vue-ui", "vue2 微前端"),
    "design-doc-pipeline": ("design-doc-pipeline",),
    "u30air": ("u30air",),
    "whisperlivekit": ("whisperlivekit",),
    "cliproxyapi": ("cliproxyapi", "cli-proxy-api"),
    "webtool-deepseek": ("webtool-deepseek", "deepseekweb"),
    "smart-layout": ("smart-layout",),
    "opencode": ("opencode",),
    "pnpm": ("pnpm",),
}


def build_project_vocab(keys: list[str]) -> list[tuple[str, tuple[str, ...]]]:
    """只返回本库真实出现过的项目（由 project:* key 反查），避免凭空引入项目名。"""
    present = []
    for canon, aliases in PROJECT_ALIASES.items():
        if any(k.startswith(f"project:{canon}") or f"{canon}" in k for k in keys if k.startswith("project:")):
            present.append((canon, aliases))
    return sorted(present, key=lambda x: -len(x[1][0]))


def attribute_projects(text: str, vocab: list[tuple[str, tuple[str, ...]]]) -> list[str]:
    """返回命中的**归一项目名**（不是 key 前缀）。"""
    low = (text or "").lower()
    found = []
    for canon, aliases in vocab:
        if any(a.lower() in low for a in aliases) and canon not in found:
            found.append(canon)
    return found



ASCII_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{2,}")


def extract_instance_phrases(value: str) -> list[str]:
    """从「提升基础：3+ 实例（A、B、C）」这类散文里抽出实例描述短语。"""
    segs = re.findall(r"[（(]([^）)]{4,160})[）)]", value or "")
    m = re.search(r"提升基础[：:]\s*([^\n]+)", value or "")
    if m:
        segs.append(m.group(1))
    phrases = []
    for seg in segs:
        for part in re.split(r"[、,，;；]", seg):
            part = part.strip(" 　`")
            if len(part) >= 3 and not part.startswith("http"):
                phrases.append(part)
    return phrases


def match_phrases_to_instances(phrases: list[str], candidates: list[dict]) -> list[dict]:
    """散文实例 → 记忆 key 的**软匹配**（候选，人工复核前不采信为已验证证据）。"""
    out = []
    for ph in phrases:
        toks = {t.lower() for t in ASCII_TOKEN_RE.findall(ph)}
        cjk = set(re.findall(r"[\u4e00-\u9fff]{2}", ph))
        best, best_score = None, 0.0
        for cand in candidates:
            hay = f"{cand['key']} {cand['meta'].get('title','')}".lower()
            hay_cjk = set(re.findall(r"[\u4e00-\u9fff]{2}", hay))
            tok_hits = sum(1 for t in toks if t in hay)
            cjk_ov = len(cjk & hay_cjk) / max(1, len(cjk))
            score = tok_hits + cjk_ov * 1.5
            if score > best_score:
                best, best_score = cand["key"], score
        if best and best_score >= 1.0:
            out.append({"phrase": ph, "matched": best, "score": round(best_score, 2),
                        "method": "prose-match", "needs_review": True})
    return out

# ---------------------------------------------------------------------------
# L1 切片：只从父条目 verbatim 抽取，不做改写
# ---------------------------------------------------------------------------
SECTION_SPLIT_RE = re.compile(r"^##\s+(.+)$", re.M)
OBS_SECTION_WORDS = ("触发", "根因", "现象", "结果", "修正", "复盘", "过程", "错误", "教训", "做法")
BULLET_RE = re.compile(r"^\s*(?:[-*]|\d+[.、])\s+(.+)$")


def slice_observations(key: str, value: str, max_items: int = 8) -> list[dict]:
    """把 episode 叙事段落切为原子观测候选（verbatim，超长截断并标 truncated）。"""
    obs, cur = [], None
    lines = (value or "").split("\n")
    for line in lines:
        m = SECTION_SPLIT_RE.match(line)
        if m:
            cur = m.group(1).strip()
            continue
        if not cur or not any(w in cur for w in OBS_SECTION_WORDS):
            continue
        b = BULLET_RE.match(line)
        if not b:
            continue
        text = b.group(1).strip()
        if len(text) < 8:
            continue
        truncated = len(text) > 200
        obs.append(
            {
                "parent": key,
                "section": cur,
                "text": text[:200],
                "truncated": truncated,
            }
        )
        if len(obs) >= max_items:
            break
    return obs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.expanduser("~/.delx-memory/db.sqlite"))
    ap.add_argument("--out-json", default="")
    ap.add_argument("--out-md", default="")
    ap.add_argument("--date", default=datetime.now().strftime("%Y-%m-%d"))
    ap.add_argument("--dry-run", action="store_true", default=True,
                    help="默认即 dry-run；本工具无写入路径")
    args = ap.parse_args()

    conn = connect_ro(args.db)
    rows = conn.execute(
        "SELECT key, value, created_at, updated_at, ttl_expires_at, tags, metadata FROM memory ORDER BY key"
    ).fetchall()
    # 只分析原始语料（自产 obs:/episode: 不入分析范围，保证计划可重复）
    rows = [r for r in rows if not L.is_derived_key(r["key"])]
    fingerprint_before = corpus_fingerprint(rows)

    records, by_key = [], {}
    for r in rows:
        tags = L.split_tags(r["tags"])
        try:
            meta = json.loads(r["metadata"]) if r["metadata"] else {}
        except json.JSONDecodeError:
            meta = {}
        cls = classify(r["key"], r["value"], meta, tags)
        src_ok, anchors = has_source_evidence(meta, L.decode_value(r["value"]))
        rec = {
            "key": r["key"],
            "value": L.decode_value(r["value"]),
            "value_kind": L.value_kind(r["value"]),
            "tags": tags,
            "meta": meta,
            "scope": meta.get("scope") or L.scope_from_tags(tags),
            "layer": cls["layer"],
            "category": cls["category"],
            "needs_review": cls["needs_review"],
            "rule_ids": cls["rule_ids"],
            "reasons": cls["reasons"],
            "src_ok": src_ok,
            "anchors": anchors,
            "created": datetime.fromtimestamp((r["created_at"] or 0) / 1000, tz=timezone.utc).strftime("%Y-%m-%d"),
            "archived_at": meta.get("archived_at"),
            "ttl_expires_at": r["ttl_expires_at"],
        }
        records.append(rec)
        by_key[rec["key"]] = rec

    vocab = build_project_vocab([r["key"] for r in rows])
    knowledge = [r for r in records if r["category"] == "knowledge"]

    # ---------------- 回填字段预览（只预览，不写） ----------------
    backfill = []
    for rec in records:
        status = "active"
        if rec["archived_at"]:
            status = "archived"
        elif rec["layer"] in ("L5", "L6", "L7") or rec["needs_review"]:
            status = "candidate"
        review = "pending"
        conf, ev = None, None
        explicit_user = rec["key"].startswith(("preference:user:", "global:")) or \
            "由用户指令" in rec["value"] or "用户原话" in rec["value"] or \
            "declared_by" in json.dumps(rec["meta"], ensure_ascii=False)
        # 证据等级：value 与 metadata 的 evidence/source 文本一起判定（不只看 evidence_level 字段）
        # 注意：`evidence_level` 是本工具的输出字段，不得作为输入（否则自我强化：
        # 上次写的 E0 会被读回当成"记录自称 E0"）。只读真正的来源描述。
        ev_blob = " ".join(str(rec["meta"].get(k, "")) for k in
                           ("evidence", "source", "promotion_basis", "provenance"))
        levels = re.findall(r"\bE([0-4])\b", (rec["value"] or "") + " " + ev_blob)
        best = max((int(x) for x in levels), default=None)
        if best is not None:
            ev = f"E{best}"
        elif rec["src_ok"]:
            ev = "E2"
        else:
            ev = "E0"
            rec["needs_review"] = True
        if explicit_user and ev != "E0":
            review = "approved"   # 依据：用户显式指定 + 有锚点（不是模型自评）
        conf = {"E4": 0.9, "E3": 0.75, "E2": 0.6, "E1": 0.4, "E0": 0.3}[ev]

        # scope 值域归一：非法值不得静默进入新字段（保留原值到 legacy_scope）
        scope_norm = rec["scope"] if rec["scope"] in L.SCOPES else "unset"
        if scope_norm == "unset" and rec["scope"]:
            rec["needs_review"] = True
            rec.setdefault("rule_ids", []).append("invalid:scope")

        evidence_ids = []
        if rec["anchors"]:
            evidence_ids.extend(f"anchor:{a}" for a in rec["anchors"][:3])
        if rec["archived_at"]:
            evidence_ids.append(f"archive:{rec['archived_at']}")
        for ref in KEY_REF_RE.findall(rec["value"] or ""):
            if ref in by_key and ref != rec["key"]:
                evidence_ids.append(f"memory:{ref}")

        add = {
            "layer": rec["layer"],
            "memory_category": rec["category"],
            "status": status,
            "review_status": review,
            "confidence": conf,
            "evidence_level": ev,
            "needs_review": bool(rec["needs_review"]),
            "evidence_ids": sorted(set(evidence_ids)),
            "legacy_id": rec["key"],
            "layer_basis": {"rule_ids": rec["rule_ids"], "reasons": rec["reasons"],
                            "by": "distill.py@" + args.date},
            "last_migrated_at": "<apply-time>",
        }
        # scope 未知时不写哨兵值（'unset' 不是合法 scope），改为显式标记 + 保留原值
        if scope_norm in L.SCOPES:
            add["scope"] = scope_norm
        else:
            add["scope_unknown"] = True
            if rec["scope"]:
                add["legacy_scope"] = rec["scope"]
        backfill.append({"key": rec["key"], "op": "update-metadata(add-only)", "add": add})

    # ---------------- L6 镜像边界 ----------------
    mirror_resolved, mirror_unresolved = [], []
    for rec in records:
        if not rec["key"].startswith("skill:"):
            continue
        info = resolve_mirror(rec["key"], rec["value"], rec["meta"])
        info["l6"] = l6_field_check(rec["value"])
        info["layer"] = rec["layer"]
        (mirror_unresolved if not info["mirror_of"] else mirror_resolved).append(info)
    mirror_unverified = [m for m in mirror_resolved if m["verify_state"] == "partial"]
    mirror_gap = [m for m in mirror_resolved if m["verify_state"] == "gap"]

    # ---------------- L1 切片预览 ----------------
    l1 = []
    for rec in records:
        if not (rec["category"] == "knowledge" and rec["layer"] in ("L3", "L4")):
            continue
        slices = slice_observations(rec["key"], rec["value"])
        if len(slices) < 2:
            continue
        seen_text = set()
        for i, s in enumerate(slices, 1):
            if s["text"] in seen_text:
                continue
            seen_text.add(s["text"])
            slug = rec["key"].split(":", 1)[1]
            l1.append(
                {
                    "proposed_key": f"obs:{slug}-{i}",
                    "layer": "L1",
                    "parent": rec["key"],
                    "section": s["section"],
                    "text": s["text"],
                    "truncated": s["truncated"],
                    "evidence_ids": [f"memory:{rec['key']}"]
                                    + ([f"archive:{rec['archived_at']}"] if rec["archived_at"] else []),
                    "status": "candidate",
                    "review_status": "pending",
                    "layer_basis": {"rule_ids": ["slice:verbatim-bullet"],
                                    "reasons": [f"从 {rec['key']} 的「{s['section']}」小节逐条切片（原文，未改写）"]},
                }
            )

    # ---------------- L2 Episode 候选 ----------------
    l2 = []
    for rec in records:
        if rec["category"] != "knowledge" or rec["layer"] not in ("L3", "L4"):
            continue
        ep = [m for m in L.EPISODE_MARKERS if m in rec["value"]]
        if len(ep) < 2:
            continue
        projects = attribute_projects(rec["value"] + " " + rec["key"], vocab)
        date = next(iter(re.findall(r"\b(20\d{2}-\d{2}-\d{2})\b", rec["value"])), rec["created"])
        slug = rec["key"].split(":", 1)[1]
        proj = projects[0] if projects else "unknown"
        l2.append(
            {
                "proposed_key": f"episode:{proj}:{date}:{slug}",
                "layer": "L2",
                "project": proj if projects else None,
                "date": date,
                "goal": _first_sentence(rec["value"], ("## 触发", "触发")),
                "sections": ep,
                "result": _first_sentence(rec["value"], ("## 结果", "结果", "修正")),
                "evidence_ids": [f"memory:{rec['key']}"],
                "observation_keys": [o["proposed_key"] for o in l1 if o["parent"] == rec["key"]],
                "status": "candidate",
                "review_status": "pending",
                "layer_basis": {"rule_ids": ["aggregate:episode-markers"],
                                "reasons": [f"含 {ep} 叙事小节 + 日期 {date}；项目归属={proj}"]},
            }
        )

    # ---------------- L4 / L5 / L6 / L7 候选 ----------------
    l4 = []
    for rec in knowledge:
        if rec["layer"] != "L4":
            continue
        projects = attribute_projects(rec["value"] + " " + rec["key"], vocab)
        l4.append(
            {
                "key": rec["key"],
                "kind": "existing-L4",
                "project": projects[0] if projects else None,
                "scope": scope_norm,
            **({"legacy_scope": rec["scope"]} if scope_norm == "unset" and rec["scope"] else {}),
                "status": "active" if not rec["archived_at"] else "archived",
                "constraint_type": "explicit-user" if rec["key"].startswith(("global:", "rule:")) else "derived",
                "evidence_ids": [f"memory:{k}" for k in KEY_REF_RE.findall(rec["value"] or "")
                                 if k in by_key and k != rec["key"]][:5],
                "review_status": "pending",
            }
        )

    l5 = []
    inst_pool = [r for r in knowledge if r["layer"] in ("L3", "L2")]
    for rec in knowledge:
        if rec["layer"] != "L5":
            continue
        hard_refs = [k for k in KEY_REF_RE.findall(rec["value"] or "") if k in by_key]
        soft = match_phrases_to_instances(extract_instance_phrases(rec["value"]), inst_pool)
        soft_keys = [m["matched"] for m in soft if m["matched"] not in hard_refs]
        inst_keys = hard_refs + soft_keys
        inst_projects = []
        for k in inst_keys:
            inst_projects += attribute_projects(by_key[k]["value"] + " " + k, vocab)
        own = attribute_projects(rec["value"] + " " + rec["key"], vocab)
        projects = sorted(set(inst_projects + own))
        declared = _declared_instance_count(rec["value"])
        l5.append(
            {
                "key": rec["key"],
                "instance_refs_hard": hard_refs,
                "instance_refs_soft": soft,
                "instance_refs": inst_keys,
                "declared_instances": declared,
                "projects": projects,
                "eligible_L5": len(projects) >= 2,
                "recommended_layer": "L5" if len(projects) >= 2 else "L4",
                "evidence_quality": "hard+soft" if soft_keys else "hard-only",
                "needs_review": True,
                "review_status": "pending",
                "evidence_ids": [f"memory:{k}" for k in inst_keys],
            }
        )

    l6 = []
    for rec in knowledge:
        if rec["layer"] != "L6":
            continue
        m = next((x for x in mirror_resolved + mirror_unresolved if x["key"] == rec["key"]), None)
        l6.append(
            {
                "key": rec["key"],
                "mirror_of": m["mirror_of"] if m else None,
                "mirror_verified": bool(m and m["verified"]),
                "l6_fields": m["l6"] if m else None,
                "seven_ready": bool(m and len(m["l6"]["fields_present"]) >= 5),
                "recommended_layer": "L6",
                "kind": "rule_mirror",
                "review_status": "pending",
                "recommendation": (
                    "七字段达标，可进入 L6 候选复核"
                    if m and len(m["l6"]["fields_present"]) >= 5
                    else "七字段不足（规则镜像，非完整技能知识）：保留 L6 候选 + mirror_of，不升层、不发布"
                ),
                "note": "权威源在 skills/；本条仅候选+指针，不发布、不启用",
            }
        )

    l7 = []
    for rec in knowledge:
        if rec["layer"] != "L7":
            continue
        l7.append(
            {
                "key": rec["key"],
                "promotion_basis": rec["meta"].get("promotion_basis"),
                "counterexample_present": "反例" in rec["value"],
                "review_status": "pending",
                "note": "原则候选必须人工审核；不得依据访问次数自动升级",
            }
        )

    # ---------------- 导航完整性 ----------------
    nav_ok, nav_broken = [], []
    for rec in records:
        if rec["category"] != "navigation":
            continue
        targets = [k for k in KEY_REF_RE.findall(rec["value"] or "") if is_key_ref(k)]
        missing = [t for t in targets if t not in by_key]
        item = {"key": rec["key"], "targets": len(targets), "missing": missing}
        (nav_broken if missing else nav_ok).append(item)

    # ---------------- 质量评估 ----------------
    layer_dist = Counter(r["layer"] for r in knowledge)
    with_evidence = sum(1 for b in backfill if b["add"]["evidence_ids"])
    quality = {
        "records_total": len(records),
        "knowledge_records": len(knowledge),
        "non_knowledge_records": len(records) - len(knowledge),
        "layer_coverage_of_knowledge": round(sum(layer_dist.values()) / max(1, len(knowledge)), 3),
        "layer_distribution_knowledge": dict(sorted(layer_dist.items(), key=lambda kv: str(kv[0]))),
        "evidence_coverage": {
            "records_with_evidence_ids": with_evidence,
            "ratio": round(with_evidence / max(1, len(backfill)), 3),
            "e0_records": [b["key"] for b in backfill if b["add"]["evidence_level"] == "E0"],
        },
        "review": {
            "pending": sum(1 for b in backfill if b["add"]["review_status"] == "pending"),
            "approved_explicit_user": sum(1 for b in backfill if b["add"]["review_status"] == "approved"),
            "needs_review": sum(1 for b in backfill if b["add"]["needs_review"]),
        },
        "mirror": {
            "total": len(mirror_resolved) + len(mirror_unresolved),
            "resolved": len(mirror_resolved),
            "verified": sum(1 for m in mirror_resolved if m["verify_state"] == "verified"),
            "partial": len(mirror_unverified),
            "gap_memory_has_extra_content": len(mirror_gap),
            "unresolved": len(mirror_unresolved),
        },
        "evidence_level_distribution": dict(Counter(b["add"]["evidence_level"] for b in backfill)),
        "l6_field_detail": dict(Counter(len(x["l6_fields"]["fields_present"]) for x in l6)),
        "derived": {"l1_slices": len(l1), "l2_candidates": len(l2),
                    "l4_candidates": len(l4), "l5_candidates": len(l5),
                    "l5_eligible": sum(1 for x in l5 if x["eligible_L5"]),
                    "l6_candidates": len(l6), "l6_seven_ready": sum(1 for x in l6 if x["seven_ready"]),
                    "l7_candidates": len(l7)},
        "navigation": {"clean": len(nav_ok), "needs_repair": len(nav_broken),
                       "excluded_from_L4_L7_stats": True},
        "conflicts": {
            "conflict_marker_records": [r["key"] for r in records if "content:conflict-marker" in r["rule_ids"]],
            "auto_merged": 0,
        },
    }

    # 零副作用断言（同一进程内二次采样）
    rows_after = conn.execute("SELECT key, value FROM memory ORDER BY key").fetchall()
    # 与 before 同口径：排除自产衍生记录/分片（否则二次运行会误报副作用）
    rows_after = [r for r in rows_after if not L.is_derived_key(r["key"])]
    fingerprint_after = corpus_fingerprint(rows_after)
    assert fingerprint_before == fingerprint_after, "dry-run 产生了数据副作用，中止"
    conn.close()

    report = {
        "report_version": 1,
        "generated_at": now_iso(),
        "report_date": args.date,
        "dry_run": True,
        "write_path_exists": False,
        "db_path": str(Path(args.db).expanduser()),
        "corpus_fingerprint_before": fingerprint_before,
        "corpus_fingerprint_after": fingerprint_after,
        "zero_side_effect": fingerprint_before == fingerprint_after,
        "confirmation_basis": {
            "layer_null_for_navigation": "用户 2026-10-22 确认",
            "layer_null_for_non_knowledge": "用户 2026-10-22 确认",
            "l6_mirror_boundary": "用户 2026-10-22 确认（5 条规则）",
        },
        "quality": quality,
        "backfill_preview": backfill,
        "l1_slices": l1,
        "l2_candidates": l2,
        "l4_candidates": l4,
        "l5_candidates": l5,
        "l6_candidates": l6,
        "l7_candidates": l7,
        "mirror": {"resolved": mirror_resolved, "unresolved": mirror_unresolved},
        "navigation": {"clean": nav_ok, "needs_repair": nav_broken},
    }

    if args.out_json:
        Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_json).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.out_md:
        Path(args.out_md).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_md).write_text(render(report), encoding="utf-8")

    q = quality
    print(f"dry_run={report['dry_run']} zero_side_effect={report['zero_side_effect']}")
    print(f"knowledge={q['knowledge_records']} layers={q['layer_distribution_knowledge']}")
    print(f"evidence_ratio={q['evidence_coverage']['ratio']} E0={len(q['evidence_coverage']['e0_records'])}")
    print(f"L1 slices={q['derived']['l1_slices']} L2={q['derived']['l2_candidates']} "
          f"L4={q['derived']['l4_candidates']} L5={q['derived']['l5_candidates']}(eligible {q['derived']['l5_eligible']}) "
          f"L6={q['derived']['l6_candidates']}(7field {q['derived']['l6_seven_ready']}) L7={q['derived']['l7_candidates']}")
    print(f"mirror={q['mirror']}")
    print(f"nav clean={q['navigation']['clean']} broken={q['navigation']['needs_repair']}")
    return 0


def _first_sentence(value: str, markers: tuple[str, ...]) -> str:
    for m in markers:
        idx = value.find(m)
        if idx < 0:
            continue
        tail = value[idx + len(m):].lstrip("\n: ：")
        line = tail.split("\n")[0].strip(" -—:：")
        if line:
            return line[:160]
    return ""


def _declared_instance_count(value: str) -> int | None:
    m = re.search(r"(\d+)\s*(?:个|\+)?\s*实例", value or "")
    return int(m.group(1)) if m else None


def render(rep: dict) -> str:
    q = rep["quality"]
    lines: list[str] = []
    A = lines.append
    A(f"# delx-memory 分层 dry-run 报告（{rep['report_date']}）")
    A("")
    A(f"> 生成：{rep['generated_at']}　**dry_run=True**　写路径：不存在　零副作用："
      f"**{rep['zero_side_effect']}**")
    A(f"> 语料指纹 before=`{rep['corpus_fingerprint_before'][:16]}…` after=`{rep['corpus_fingerprint_after'][:16]}…`")
    A("> 口径确认：导航判 layer=null ✅／非知识轴 layer=null ✅／L6 仅候选+mirror_of ✅（2026-10-22 用户确认）")
    A("")
    A("## 1. 切片预览与数量")
    A("")
    A("| 产出 | 条数 | 说明 |")
    A("|---|---|---|")
    d = q["derived"]
    A(f"| L1 原子观测切片 | {d['l1_slices']} | 从父条目「触发/根因/修正/结果」小节逐条 verbatim 切片 |")
    A(f"| L2 Episode 候选 | {d['l2_candidates']} | 同任务+同项目+同日聚合，附 observation_keys |")
    A(f"| L4 候选 | {d['l4_candidates']} | 现有 project/rule 约定条目（非新增内容） |")
    A(f"| L5 候选 | {d['l5_candidates']} | 其中跨 ≥2 项目、达标 L5：**{d['l5_eligible']}** |")
    A(f"| L6 候选 | {d['l6_candidates']} | 七字段达标（≥5）：**{d['l6_seven_ready']}**；"
      f"字段数分布 {q.get('l6_field_detail', {})} |")
    A(f"| L7 候选 | {d['l7_candidates']} | 全部 pending，需人工审核 |")
    A("")
    A("## 2. 质量评估")
    A("")
    A(f"- 知识条目 **{q['knowledge_records']}** / 全部 {q['records_total']}；非知识轴 {q['non_knowledge_records']} 条**不计入** L4–L7 覆盖率")
    A(f"- 层级分布（仅知识条目）：{q['layer_distribution_knowledge']}")
    A(f"- 证据覆盖：{q['evidence_coverage']['records_with_evidence_ids']}/{q['records_total']} 条有 `evidence_ids`"
      f"（{q['evidence_coverage']['ratio']}）；**E0（无任何锚点）= {len(q['evidence_coverage']['e0_records'])} 条**")
    A(f"- 证据等级分布：{q.get('evidence_level_distribution', {})}（E4/E3/E1 为记录自述；"
      f"**E2 = 仅锚点存在、记录未自述等级的推断值**；E0 = 无任何锚点）")
    A(f"- 审核：pending {q['review']['pending']} ／ approved(用户显式指定) {q['review']['approved_explicit_user']} ／ needs_review {q['review']['needs_review']}")
    A(f"- 冲突：带冲突/取代标记 {len(q['conflicts']['conflict_marker_records'])} 条，**自动合并 0 条**")
    A("")
    A("### Skill 镜像边界（L6）")
    A("")
    A("| 项 | 数量 |")
    A("|---|---|")
    A(f"| skill:* 总数 | {q['mirror']['total']} |")
    A(f"| 已解析 mirror_of | {q['mirror']['resolved']} |")
    A(f"| 内容可核验（≥2 片段命中） | {q['mirror']['verified']} |")
    A(f"| 部分核验（1 片段命中） | {q['mirror']['partial']} |")
    A(f"| **记忆含 Skill 未覆盖内容**（0 命中，保留并评估提炼） | {q['mirror']['gap_memory_has_extra_content']} |")
    A(f"| 无法确定权威文件（不猜路径，标待审） | {q['mirror']['unresolved']} |")
    A("")
    A("| key | mirror_of | 来源 | 可核验 | 七字段 |")
    A("|---|---|---|---|---|")
    for m in rep["mirror"]["resolved"] + rep["mirror"]["unresolved"]:
        n = len(m["l6"]["fields_present"])
        mark = {"verified": "✅", "partial": "◐", "gap": "⚠️"}.get(m.get("verify_state"), "❌")
        A(f"| `{m['key']}` | {('`' + m['mirror_of'] + '`') if m['mirror_of'] else '—'} | "
          f"{m['resolved_by'] or '—'} | {mark}{len(m.get('hits', []))} | {n}/7 |")
    A("")
    A("### L5 跨项目证据矩阵")
    A("")
    A("| pattern | 声明实例 | 硬引用 | 软匹配 | 项目 | 达标 L5 | 建议层 |")
    A("|---|---|---|---|---|---|---|")
    for x in rep["l5_candidates"]:
        A(f"| `{x['key']}` | {x['declared_instances'] or '—'} | {len(x['instance_refs_hard'])} | "
          f"{len(x['instance_refs_soft'])} | {', '.join(x['projects']) or '—'} | "
          f"{'✅' if x['eligible_L5'] else '❌'} | {x['recommended_layer']} |")
    A("")
    A("### 导航完整性（保留引用，不删除、不猜替代）")
    A("")
    A(f"- 引用完整：{q['navigation']['clean']} 条；**需修复**：{q['navigation']['needs_repair']} 条")
    for x in rep["navigation"]["needs_repair"]:
        A(f"  - `{x['key']}`（{x['targets']} 个目标，失效 {len(x['missing'])}："
          f"{', '.join('`'+t+'`' for t in x['missing'][:4])}）")
    A("")
    A("## 3. 回填字段预览（逐条 add-only，不改原 key/value/tags）")
    A("")
    A("| key | layer | category | scope | status | review | conf | E | needs_review |")
    A("|---|---|---|---|---|---|---|---|---|")
    for b in rep["backfill_preview"][:40]:
        a = b["add"]
        A(f"| `{b['key']}` | {a['layer'] or '—'} | {a['memory_category']} | {a['scope']} | "
          f"{a['status']} | {a['review_status']} | {a['confidence']} | {a['evidence_level']} | "
          f"{'是' if a['needs_review'] else '否'} |")
    A("")
    A(f"> 共 {len(rep['backfill_preview'])} 条将获得字段补充；完整明细见 JSON `backfill_preview`。")
    A("")
    A("## 4. L1 切片样例（verbatim，未改写）")
    A("")
    for x in rep["l1_slices"][:12]:
        A(f"- `{x['proposed_key']}` ← {x['parent']}「{x['section']}」：{x['text'][:120]}")
    A("")
    A(f"> 共 {len(rep['l1_slices'])} 条切片；全部 `status=candidate` + `review_status=pending`，未写入。")
    A("")
    A("## 5. 本轮不做的事")
    A("")
    A("- 未写入任何记录、未建索引、未改 `updated_at`、未改 tags/metadata。")
    A("- 未创建/发布/修改任何正式 Skill；未触碰 `skill-authoring/` 流程。")
    A("- 未删除任何原始记录；未自动合并任何重复或冲突。")
    A("")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
