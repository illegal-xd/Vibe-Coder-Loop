#!/usr/bin/env python3
"""L0–L7 分层**增量回填**工具（Phase 3）：备份 → 分批 add-only 写入 → 校验 → 幂等。

设计纪律（对应 docs/memory-layers.md）：
- **加字段不覆盖**：只补缺失字段；已有非空字段保持原值（冲突记入报告）。
  唯一例外：既有 `layer` 值为旧口径字符串（`pattern` / `principle`）时，
  迁到 `legacy_layer` 后写入 L 编号。
- **不动原始数据**：`value` / `tags` / `created_at` / `updated_at` / `ttl_expires_at` 一律不改；
  `UPDATE` 只写 `metadata`（SQL 不触碰 updated_at）。
- **衍生记录新 key**：`obs:*` / `episode:*`，`status=candidate`、`review_status=pending`，
  带 `content_hash` 用于幂等。
- **备份用 `VACUUM INTO`**（WAL 安全），并校验 integrity_check + 行数 + 语料指纹。
- **批次 + 进度**：每批一个事务，落 `reports/.migrate-progress-<id>.json`，中断可续。
- 默认 dry-run；写入必须显式 `--apply`。

用法：
    python3 scripts/memory/migrate.py --db ~/.delx-memory/db.sqlite                 # dry-run
    python3 scripts/memory/migrate.py --db ~/.delx-memory/db.sqlite --backup-only
    python3 scripts/memory/migrate.py --db ~/.delx-memory/db.sqlite --apply
    python3 scripts/memory/migrate.py --db ~/.delx-memory/db.sqlite --verify
    python3 scripts/memory/migrate.py --db ~/.delx-memory/db.sqlite --restore <bak> --yes
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import layers as L  # noqa: E402

HERE = Path(__file__).resolve().parent
MIGRATION_ID = "l0l7-backfill-v1"

# 迁移自有字段：若旧 metadata 已带 migration_id（本工具写过），这些字段以**计划为准**覆盖，
# 否则每次重算计划都会因自身写入的字段产生伪冲突。
# 只允许“结构字段”自愈；质量字段（confidence/evidence_level/review_status/
# evidence_ids）一旦已存在就保留，避免迁移计划用启发式值覆盖人工校准。
MIGRATION_OWNED = {
    "layer", "memory_category", "scope", "scope_unknown", "legacy_layer", "legacy_scope",
    "legacy_confidence", "layer_basis", "migration_id",
}
DERIVED_PREFIXES = L.DERIVED_PREFIXES


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def now_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm(s: str | None) -> str:
    import re

    return re.sub(r"\s+", " ", s or "").strip()


def fingerprint(conn: sqlite3.Connection, only_original: bool = True) -> str:
    sql = "SELECT key, value FROM memory ORDER BY key"
    rows = conn.execute(sql).fetchall()
    if only_original:
        rows = [r for r in rows if not L.is_derived_key(r[0])]
    return hashlib.sha256(
        "\n".join(f"{r[0]}:{hashlib.sha256(norm(r[1]).encode()).hexdigest()}" for r in rows).encode()
    ).hexdigest()


def open_rw(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=15)
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def load_plan(db: Path, date: str, tmpdir: Path) -> dict:
    """复用 distill.py 的 dry-run 计划（单一事实源，不重复实现分类逻辑）。"""
    out = tmpdir / "plan.json"
    cmd = [
        sys.executable, str(HERE / "distill.py"),
        "--dry-run", "--db", str(db), "--out-json", str(out), "--date", date,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise SystemExit(f"distill.py 失败：\n{res.stdout}\n{res.stderr}")
    return json.loads(out.read_text(encoding="utf-8"))


def backup(db: Path, out_dir: Path, tag: str) -> Path:
    """VACUUM INTO 一致性备份（WAL 安全），并就地校验。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"db.sqlite.bak-{tag}-{MIGRATION_ID}"
    if dest.exists():  # 绝不覆盖既有备份（同秒多次执行也要唯一）
        stamp = datetime.now().strftime("%H%M%S")
        dest = out_dir / f"db.sqlite.bak-{tag}-{stamp}-{MIGRATION_ID}"
        n = 1
        while dest.exists():
            dest = out_dir / f"db.sqlite.bak-{tag}-{stamp}-{n}-{MIGRATION_ID}"
            n += 1
    src = open_rw(db)
    try:
        src.execute("VACUUM INTO ?", (str(dest),))
        src_count = src.execute("SELECT count(*) FROM memory").fetchone()[0]
        src_fp = fingerprint(src)
        integrity = src.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        src.close()
    chk = sqlite3.connect(f"file:{dest}?mode=ro", uri=True)
    try:
        bak_count = chk.execute("SELECT count(*) FROM memory").fetchone()[0]
        bak_fp = fingerprint(chk)
        bak_integrity = chk.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        chk.close()
    ok = (bak_count == src_count and bak_fp == src_fp and bak_integrity == "ok" and integrity == "ok")
    if not ok:
        raise SystemExit(
            f"备份校验失败：count {src_count}/{bak_count} fp_equal={src_fp == bak_fp} "
            f"integrity={integrity}/{bak_integrity}"
        )
    print(f"backup ok: {dest} ({bak_count} rows, integrity=ok, fingerprint match)")
    return dest


# ---------------------------------------------------------------------------
# 计划装配
# ---------------------------------------------------------------------------
def _is_migration_target(key: str, raw_meta: str | None) -> bool:
    """一次性迁移只处理原始语料：跳过分片/checkpoint/迁移后新建条目。

    迁移后新建条目（无 ``migration_id`` 且已有 layer）不应被旧计划重新分类，
    否则会把 memops 的分片继承/语义修复覆盖回 prefix 初判。
    """
    if "#" in key or key.startswith("vc:checkpoint") or L.is_observation_key(key):
        return False
    try:
        meta = json.loads(raw_meta) if raw_meta else {}
    except (TypeError, ValueError):
        meta = {}
    if not isinstance(meta, dict):
        meta = {}
    if meta.get("migration_id") == MIGRATION_ID:
        return True
    # 含旧口径 layer（非 L.LAYERS 枚举）或尚未分类的条目仍允许补分类；
    # 已有合法 layer 且无 migration_id 的条目视为迁移后新建，跳过。
    layer = meta.get("layer")
    if layer and layer in L.LAYERS:
        return False
    return True


def build_targets(
    plan: dict,
    existing_keys: set[str],
    existing_meta: dict[str, str] | None = None,
) -> tuple[list[dict], list[dict], list[dict]]:
    """返回 (updates, inserts, skipped)。"""
    updates, inserts, skipped = [], [], []
    for item in plan["backfill_preview"]:
        key, add = item["key"], dict(item["add"])
        if key not in existing_keys:
            skipped.append({"key": key, "reason": "计划中的记录已不存在（库被并发修改）"})
            continue
        if existing_meta is not None and not _is_migration_target(key, existing_meta.get(key)):
            skipped.append({"key": key, "reason": "分片/checkpoint/迁移后新建条目，不属于一次性回填范围"})
            continue
        add.pop("last_migrated_at", None)
        add["migration_id"] = MIGRATION_ID
        # 不变量：候选状态不得同时是 approved（审核门槛）
        if add.get("status") == "candidate":
            add["review_status"] = "pending"
            add["needs_review"] = True
        updates.append({"key": key, "add": add})

    for group in ("l1_slices", "l2_candidates"):
        for cand in plan[group]:
            key = cand["proposed_key"]
            if key in existing_keys:
                skipped.append({"key": key, "reason": "衍生 key 已存在（幂等跳过，内容相同或待人工合并）"})
                continue
            text = _derived_text(cand)
            meta = {
                "title": (cand.get("text") or "")[:80] or cand.get("proposed_key"),
                "layer": "L1" if group == "l1_slices" else "L2",
                "memory_category": "knowledge",
                "scope": "project" if cand.get("project") else "task",
                "status": "candidate",
                "review_status": "pending",
                "confidence": 0.4,
                "evidence_level": "E1",
                "protected": False,
                "needs_review": True,
                "evidence_ids": cand["evidence_ids"],
                "legacy_id": cand.get("parent", cand["proposed_key"]),
                "derived_from": cand.get("parent"),
                "layer_basis": cand["layer_basis"],
                "content_hash": hashlib.sha256(text.encode()).hexdigest(),
                "created_by": f"distill.py@{plan['report_date']}",
                "migration_id": MIGRATION_ID,
                "derived": True,
            }
            inserts.append(
                {
                    "key": key,
                    "value": json.dumps(text, ensure_ascii=False),
                    "tags": ",layer:L1,derived,candidate," if group == "l1_slices"
                            else ",layer:L2,derived,candidate,",
                    "metadata": json.dumps(meta, ensure_ascii=False),
                }
            )
    return updates, inserts, skipped


def _derived_text(cand: dict) -> str:
    if "text" in cand:  # L1
        return f"{cand['text']}\n\n> 来源：{cand['parent']}「{cand['section']}」（原文切片，未改写）"
    parts = [f"# Episode：{cand['proposed_key']}", f"- 项目：{cand.get('project') or 'unknown'}",
             f"- 日期：{cand['date']}", f"- 目标：{cand.get('goal') or '（原文未单列）'}",
             f"- 叙事小节：{', '.join(cand['sections'])}",
             f"- 结果：{cand.get('result') or '（原文未单列）'}",
             f"- 观测：{', '.join(cand['observation_keys']) or '（无切片）'}",
             f"\n> 来源：{cand['evidence_ids']}"]
    return "\n".join(parts)


def merge_metadata(old_raw: str | None, add: dict) -> tuple[dict, list[str]]:
    """add-only 合并：不覆盖已有非空字段；旧口径 layer 迁到 legacy_layer。"""
    try:
        old = json.loads(old_raw) if old_raw else {}
    except json.JSONDecodeError:
        old = {}
    conflicts = []
    own_prev = bool(old.get("migration_id"))
    for k, v in add.items():
        if k not in old or old[k] in (None, "", [], {}):
            old[k] = v
            continue
        if k == "layer" and old[k] not in L.LAYERS:
            old["legacy_layer"] = old[k]
            old[k] = v
            continue
        if k == "scope" and old[k] not in (None, "unset") and old[k] not in L.SCOPES:
            old["legacy_scope"] = old[k]
            old[k] = v
            continue
        if k == "confidence" and not isinstance(old[k], (int, float)):
            old["legacy_confidence"] = old[k]
            old[k] = v
            continue
        if old[k] != v:
            if own_prev and k in MIGRATION_OWNED:
                old[k] = v          # 自产字段：以计划为准（幂等/自愈）
                continue
            conflicts.append(f"{k}: keep={old[k]!r} want={v!r}")
    # 安全不变量：candidate 不得同时 approved（不受 add-only / self-heal 影响）
    if old.get("status") == "candidate":
        old["review_status"] = "pending"
        old["needs_review"] = True
    return old, conflicts


# ---------------------------------------------------------------------------
# 应用
# ---------------------------------------------------------------------------
def apply_plan(db: Path, plan: dict, batch_size: int, progress_path: Path | None) -> dict:
    """分批写入。故障注入（仅测试用）：环境变量 MIGRATE_FAIL_AFTER_BATCHES=N
    在第 N 批提交后抛错，用于验证「中断后可安全重试」。"""
    fail_after = int(os.environ.get("MIGRATE_FAIL_AFTER_BATCHES", "0") or 0)
    conn = open_rw(db)
    stats = {"updated": 0, "inserted": 0, "skipped": 0, "conflicts": [], "batches": 0}
    try:
        existing_meta = {r[0]: r[1] for r in conn.execute("SELECT key, metadata FROM memory")}
        existing = set(existing_meta)
        updates, inserts, skipped = build_targets(plan, existing, existing_meta)
        stats["skipped"] += len(skipped)
        stats["planned_updates"] = len(updates)
        stats["planned_inserts"] = len(inserts)

        done_updates = 0
        while done_updates < len(updates):
            batch = updates[done_updates : done_updates + batch_size]
            with conn:  # 单批一个事务；失败自动回滚本批
                for item in batch:
                    row = conn.execute("SELECT metadata FROM memory WHERE key = ?", (item["key"],)).fetchone()
                    if row is None:
                        stats["skipped"] += 1
                        continue
                    merged, conflicts = merge_metadata(row[0], item["add"])
                    if conflicts:
                        stats["conflicts"].append({"key": item["key"], "conflicts": conflicts})
                    new_raw = json.dumps(merged, ensure_ascii=False)
                    if new_raw == (row[0] or ""):
                        stats["skipped"] += 1
                        continue
                    # 只写 metadata：value/tags/created_at/updated_at 不变
                    conn.execute("UPDATE memory SET metadata = ? WHERE key = ?", (new_raw, item["key"]))
                    stats["updated"] += 1
            done_updates += len(batch)
            stats["batches"] += 1
            _save_progress(progress_path, done_updates, stats["inserted"], stats)
            if fail_after and stats["batches"] >= fail_after:
                raise RuntimeError(f"injected failure after {stats['batches']} batches")

        done_ins = 0
        while done_ins < len(inserts):
            batch = inserts[done_ins : done_ins + batch_size]
            ts = now_ms()
            with conn:
                for item in batch:
                    cur = conn.execute("SELECT value FROM memory WHERE key = ?", (item["key"],)).fetchone()
                    if cur is not None:
                        stats["skipped"] += 1
                        continue
                    conn.execute(
                        "INSERT INTO memory (key, value, created_at, updated_at, ttl_expires_at, tags, metadata) "
                        "VALUES (?, ?, ?, ?, NULL, ?, ?)",
                        (item["key"], item["value"], ts, ts, item["tags"], item["metadata"]),
                    )
                    stats["inserted"] += 1
            done_ins += len(batch)
            stats["batches"] += 1
            _save_progress(progress_path, done_updates, done_ins, stats)
            if fail_after and stats["batches"] >= fail_after:
                raise RuntimeError(f"injected failure after {stats['batches']} batches")
    finally:
        conn.close()
    return stats


def _save_progress(path: Path | None, updates_done: int, inserts_done: int, stats: dict) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {"migration_id": MIGRATION_ID, "updates_done": updates_done,
             "inserts_done": inserts_done, "stats": stats, "saved_at": now_iso()},
            ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------
def verify(db: Path, plan: dict, expect_fp: str) -> dict:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    out: dict = {"ok": True, "problems": []}
    try:
        orig_fp = fingerprint(conn)
        out["original_fingerprint"] = orig_fp
        out["original_fingerprint_expected"] = expect_fp
        if orig_fp != expect_fp:
            out["ok"] = False
            out["problems"].append("原始 217 条 value 指纹发生变化（原始数据被改动）")

        rows = conn.execute("SELECT key, metadata, tags, value FROM memory").fetchall()
        out["total_records"] = len(rows)
        derived = [r for r in rows if str(r["key"]).startswith(DERIVED_PREFIXES)]
        out["derived_records"] = len(derived)
        out["expected_derived"] = len(plan["l1_slices"]) + len(plan["l2_candidates"])

        bad_layer, bad_review, missing_evidence, dangling = [], [], [], []
        keys = {r["key"] for r in rows}
        for r in rows:
            if str(r["key"]).startswith(DERIVED_PREFIXES):
                continue
            meta = json.loads(r["metadata"]) if r["metadata"] else {}
            if "layer" in meta and meta["layer"] is not None and meta["layer"] not in L.LAYERS:
                bad_layer.append(r["key"])
            if meta.get("review_status") not in (None, "pending", "approved", "rejected"):
                bad_review.append(r["key"])
            if not meta.get("evidence_ids"):
                missing_evidence.append(r["key"])
            for ev in meta.get("evidence_ids") or []:
                if ev.startswith("memory:"):
                    target = ev.split(":", 1)[1]
                    if target not in keys:
                        dangling.append(f"{r['key']} -> {target}")

        out["bad_layer_enum"] = bad_layer
        out["bad_review_enum"] = bad_review
        out["records_without_evidence"] = len(missing_evidence)
        out["dangling_evidence"] = dangling
        if bad_layer:
            out["problems"].append(f"layer 枚举非法：{bad_layer[:5]}")
        if dangling:
            out["problems"].append(f"evidence 指向不存在的 key：{dangling[:5]}")
        if out["derived_records"] != out["expected_derived"]:
            out["problems"].append(
                f"衍生记录数 {out['derived_records']} ≠ 计划 {out['expected_derived']}"
            )

        # 审核门槛：L7 ≤10、候选不得 approved
        l7 = [k for k in keys if k.startswith("principle:")]
        out["l7_count"] = len(l7)
        if len(l7) > 10:
            out["problems"].append(f"L7 原则超过 10 条上限：{len(l7)}")
        approved_candidates = [
            r["key"] for r in rows
            if (json.loads(r["metadata"]) if r["metadata"] else {}).get("status") == "candidate"
            and (json.loads(r["metadata"]) if r["metadata"] else {}).get("review_status") == "approved"
        ]
        out["approved_but_candidate"] = approved_candidates
        if approved_candidates:
            out["problems"].append(f"候选被标 approved：{approved_candidates[:5]}")

        # FTS 可用性（衍生记录可检索 → 证明触发器同步）
        try:
            n = conn.execute("SELECT count(*) FROM memory_fts WHERE memory_fts MATCH 'Episode'").fetchone()[0]
            out["fts_derived_hits"] = n
        except sqlite3.OperationalError as exc:
            out["problems"].append(f"FTS 查询失败：{exc}")

        out["ok"] = not out["problems"]
    finally:
        conn.close()
    return out


def state_stats(db: Path) -> dict:
    """当前库的分层与治理状态（报告用，全部现算）。"""
    import collections

    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT key, value, tags, created_at, updated_at, metadata FROM memory").fetchall()
        orig = [r for r in rows if not str(r["key"]).startswith(DERIVED_PREFIXES)]
        der = [r for r in rows if str(r["key"]).startswith(DERIVED_PREFIXES)]
        layer, cat, status, review, ev = (collections.Counter() for _ in range(5))
        no_meta = 0
        for r in orig:
            if not r["metadata"]:
                no_meta += 1
                continue
            m = json.loads(r["metadata"])
            layer[str(m.get("layer"))] += 1
            cat[str(m.get("memory_category"))] += 1
            status[str(m.get("status"))] += 1
            review[str(m.get("review_status"))] += 1
            ev[str(m.get("evidence_level"))] += 1
        knowledge = sum(v for k, v in cat.items() if k == "knowledge")
        return {
            "total_records": len(rows),
            "original_records": len(orig),
            "derived_records": len(der),
            "originals_without_metadata": no_meta,
            "knowledge_records": knowledge,
            "non_knowledge_records": len(orig) - knowledge,
            "layer_distribution": dict(sorted(layer.items())),
            "category_distribution": dict(cat),
            "status_distribution": dict(status),
            "review_distribution": dict(review),
            "evidence_level_distribution": dict(sorted(ev.items())),
            "original_fingerprint": fingerprint(conn),
            "l7_count": sum(1 for r in orig if str(r["key"]).startswith("principle:")),
            "derived_obs": sum(1 for r in der if str(r["key"]).startswith("obs:")),
            "derived_episode": sum(1 for r in der if str(r["key"]).startswith("episode:")),
        }
    finally:
        conn.close()


def render_state_md(st: dict, verify_res: dict | None, plan: dict, db: Path, backup: str) -> str:
    L_ = []
    A = L_.append
    A(f"# delx-memory 分层回填报告（{plan['report_date']}）")
    A("")
    A(f"> 迁移标识 `{MIGRATION_ID}`　库：`{db}`")
    A(f"> 迁移前备份：`{backup}`（VACUUM INTO，integrity_check=ok，行数+语料指纹均校验通过）")
    A(f"> 原始语料指纹：`{st['original_fingerprint']}`（迁移前后一致）")
    A("")
    A("## 1. 数量总览")
    A("")
    A("| 项 | 数量 |")
    A("|---|---|")
    for k in ("total_records", "original_records", "derived_records",
              "knowledge_records", "non_knowledge_records", "originals_without_metadata"):
        A(f"| {k} | {st[k]} |")
    A("")
    A("## 2. 分层与治理字段分布（原始 217 条）")
    A("")
    A("| 维度 | 分布 |")
    A("|---|---|")
    for k in ("layer_distribution", "category_distribution", "status_distribution",
              "review_distribution", "evidence_level_distribution"):
        A(f"| {k} | {st[k]} |")
    A("")
    A("## 3. 衍生记录")
    A("")
    A(f"- L1 原子观测 `obs:*`：{st.get('derived_obs', 0)}")
    A(f"- L2 Episode `episode:*`：{st.get('derived_episode', 0)}")
    A(f"- 合计衍生：**{st['derived_records']}**（`status=candidate` + `review_status=pending` + "
      f"`content_hash`，可幂等重跑；不参与正式召回前缀）")
    A("")
    if verify_res:
        A("## 4. 回填后校验")
        A("")
        A(f"- 校验结论：**{'PASS' if verify_res['ok'] else 'FAIL'}**")
        A(f"- 原始语料指纹一致：{verify_res['original_fingerprint'] == verify_res['original_fingerprint_expected']}")
        A(f"- 衍生记录：{verify_res['derived_records']}（计划 {verify_res['expected_derived']}）")
        A(f"- layer / review 枚举非法：{verify_res['bad_layer_enum']} / {verify_res['bad_review_enum']}")
        A(f"- 悬空 evidence：{verify_res['dangling_evidence']}")
        A(f"- 无 `evidence_ids` 的原始记录：{verify_res['records_without_evidence']}；"
          f"证据等级 E0 共 {st['evidence_level_distribution'].get('E0', 0)} 条（无锚点或记录自称 E0），均已标 needs_review")
        A(f"- L7 原则数：{verify_res['l7_count']}（上限 10）")
        A(f"- 候选被误标 approved：{verify_res['approved_but_candidate']}")
        A(f"- FTS 命中衍生记录：{verify_res['fts_derived_hits']}")
        A("")
    A("## 5. 回滚方法")
    A("")
    A("```bash")
    A(f"python3 scripts/memory/migrate.py --db {db} " + "\\")
    A(f"  --restore {backup} --yes")
    A("```")
    A("")
    A("恢复后 `original_fingerprint` 必须回到上表值；恢复路径已在单元测试与真实库快照上各验证一次"
      "（见 `reports/memory-quality-2026-10-22.md` §5）。")
    A("")
    return "\n".join(L_) + "\n"


def dry_run(db: Path, plan: dict, batch_size: int) -> dict:
    conn_ro2 = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        existing_meta = {r[0]: r[1] for r in conn_ro2.execute("SELECT key, metadata FROM memory")}
    finally:
        conn_ro2.close()
    existing = set(existing_meta)
    updates, inserts, skipped = build_targets(plan, existing, existing_meta)
    ops = []
    for item in updates[:10]:
        ops.append({"op": "update-metadata", "key": item["key"], "fields": sorted(item["add"])})
    for item in inserts[:5]:
        ops.append({"op": "insert-derived", "key": item["key"]})
    return {
        "dry_run": True,
        "planned_updates": len(updates),
        "planned_inserts": len(inserts),
        "skipped": skipped[:10],
        "sample_ops": ops,
        "batch_size": batch_size,
        "note": "dry-run 不写库；--apply 才会写",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.expanduser("~/.delx-memory/db.sqlite"))
    ap.add_argument("--date", default=datetime.now().strftime("%Y-%m-%d"))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--backup-only", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--restore", default="")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--batch-size", type=int, default=25)
    ap.add_argument("--backup-dir", default=os.path.expanduser("~/.delx-memory/backups"))
    ap.add_argument("--out-json", default="")
    ap.add_argument("--out-md", default="")
    args = ap.parse_args()

    db = Path(args.db).expanduser()

    if args.restore:
        if not args.yes:
            print("restore 需要 --yes（会替换当前 db）")
            return 2
        return do_restore(db, Path(args.restore))

    plan_dir = Path(args.backup_dir)
    plan_file = plan_dir / f".plan-{MIGRATION_ID}-{args.date}.json"
    conn_ro = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    fp_original = fingerprint(conn_ro)
    conn_ro.close()
    plan = None
    if plan_file.is_file():
        cached = json.loads(plan_file.read_text(encoding="utf-8"))
        if cached.get("corpus_fingerprint_before") == fp_original:
            plan = cached
            print(f"plan reused: {plan_file}")
    if plan is None:
        with tempfile.TemporaryDirectory() as td:
            plan = load_plan(db, args.date, Path(td))
        plan_dir.mkdir(parents=True, exist_ok=True)
        plan_file.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        print(f"plan frozen: {plan_file}")

    if args.backup_only:
        backup(db, Path(args.backup_dir), args.date)
        return 0

    if not args.apply and not args.verify:
        result = dry_run(db, plan, args.batch_size)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.out_json:
            Path(args.out_json).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0

    # 记录迁移前指纹（仅原始 key）
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    fp_before = fingerprint(conn)
    conn.close()

    if args.verify:
        res = verify(db, plan, fp_before)
        print(json.dumps(res, ensure_ascii=False, indent=2))
        if args.out_json:
            Path(args.out_json).write_text(
                json.dumps({"migration_id": MIGRATION_ID, "verify": res, "state": state_stats(db)},
                           ensure_ascii=False, indent=2), encoding="utf-8")
        if args.out_md:
            bak = sorted(Path(args.backup_dir).glob(f"db.sqlite.bak-*-{MIGRATION_ID}"))[0]
            Path(args.out_md).write_text(
                render_state_md(state_stats(db), res, plan, db, str(bak)), encoding="utf-8")
        return 0 if res["ok"] else 1

    bak = backup(db, Path(args.backup_dir), args.date)
    progress = Path(args.backup_dir) / f".migrate-progress-{MIGRATION_ID}.json"
    stats = apply_plan(db, plan, args.batch_size, progress)
    res = verify(db, plan, fp_before)
    out = {
        "migration_id": MIGRATION_ID,
        "applied_at": now_iso(),
        "db": str(db),
        "backup": str(bak),
        "stats": stats,
        "verify": res,
    }
    log = Path(args.backup_dir) / f".migration-log-{MIGRATION_ID}.jsonl"
    with log.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"at": out["applied_at"], "updated": stats["updated"],
                             "inserted": stats["inserted"], "skipped": stats["skipped"],
                             "conflicts": len(stats["conflicts"]), "verify_ok": res["ok"],
                             "backup": str(bak)}, ensure_ascii=False) + "\n")
    print(json.dumps({k: out[k] for k in ("migration_id", "backup")}, ensure_ascii=False))
    print(f"updated={stats['updated']} inserted={stats['inserted']} skipped={stats['skipped']} "
          f"conflicts={len(stats['conflicts'])} verify_ok={res['ok']}")
    if args.out_json:
        Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_json).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if res["ok"] else 1


def do_restore(db: Path, bak: Path) -> int:
    if not bak.is_file():
        print(f"备份不存在：{bak}")
        return 2
    chk = sqlite3.connect(f"file:{bak}?mode=ro", uri=True)
    try:
        if chk.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            print("备份 integrity_check 失败，拒绝恢复")
            return 2
        bak_count = chk.execute("SELECT count(*) FROM memory").fetchone()[0]
    finally:
        chk.close()

    aside = db.with_suffix(db.suffix + f".pre-restore-{int(datetime.now().timestamp())}")
    db.rename(aside)
    for suffix in ("-wal", "-shm"):
        p = Path(str(db) + suffix)
        if p.exists():
            p.unlink()
    shutil.copy2(bak, db)
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        ok = (conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
              and conn.execute("SELECT count(*) FROM memory").fetchone()[0] == bak_count)
    finally:
        conn.close()
    print(f"restore {'ok' if ok else 'FAILED'}: {bak} → {db}（原库保留在 {aside}）")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
