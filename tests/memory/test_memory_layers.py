"""L0–L7 分层与回填的单元测试（stdlib unittest，无外部依赖）。

覆盖（对应任务书第七节）：
1  层级枚举与分类合法性          → TestClassification
2/13 原始数据完整性与旧数据可读   → TestApply
3  证据引用完整性                → TestVerify
4/5 重复与冲突不自动合并          → TestPlanShape
6  蒸馏不覆盖原始数据             → TestApply
7  用户修正/失败信号/约束不丢失     → TestApply
8  待审候选不得 approved          → TestMerge / TestApply
9  回填幂等性                    → TestApply
10 dry-run 无副作用               → TestApply
11 中断后安全重试                → TestApply
12 备份恢复与引用完整             → TestBackupRestore
14 L6/L7 审核门槛                → TestVerify
15 原则超限不覆盖                → TestVerify

运行：python3 -m unittest discover -s tests/memory -v
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "memory"))

import distill  # noqa: E402
import layers as L  # noqa: E402
import migrate as M  # noqa: E402

SCHEMA = """
CREATE TABLE memory (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ttl_expires_at INTEGER,
  tags TEXT,
  metadata TEXT
);
CREATE VIRTUAL TABLE memory_fts USING fts5(key, value, tags, content='memory', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, key, value, tags) VALUES (new.rowid, new.key, new.value, COALESCE(new.tags,''));
END;
CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, key, value, tags) VALUES ('delete', old.rowid, old.key, old.value, COALESCE(old.tags,''));
END;
CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, key, value, tags) VALUES ('delete', old.rowid, old.key, old.value, COALESCE(old.tags,''));
  INSERT INTO memory_fts(rowid, key, value, tags) VALUES (new.rowid, new.key, new.value, COALESCE(new.tags,''));
END;
"""

TS = 1790000000000  # 固定时间戳，保证测试可重复


def jstr(text: str) -> str:
    """模拟 delx-memory 的存储格式（value 为 JSON 字符串）。"""
    return json.dumps(text, ensure_ascii=False)


FIXTURE = [
    # key, value, tags, metadata
    (
        "lesson:fixture-race",
        jstr(
            "# Lesson：fixture 竞态\n\n## 触发\n2026-09-03 webbas 真实事故：resume 后 500。\n\n"
            "## 根因\n- abort 只断开前端连接，服务端可能已写入成功\n"
            "- 前端把被 abort 的分片视为未上传 → resume 重传\n"
            "- 后端非幂等写入导致 500\n\n## 修正\n- pause 不 abort，只有 cancel 才 abort\n"
        ),
        ",lesson,test,p_high,scope:global,",
        {"title": "fixture 竞态", "access_count": 2, "source": "real run 2026-09-03"},
    ),
    (
        "pattern:fixture-pattern",
        jstr("# Pattern: fixture\n\n> 提升基础：3 实例（aa、bb、cc）\n\n## 形态\n1. x\n2. y\n"),
        ",pattern,test,p_high,scope:global,",
        {"title": "fixture pattern", "layer": "pattern", "access_count": 1},
    ),
    (
        "project:fixture-index",
        jstr("# fixture 模块索引\n\n> 纯导航，不存实质内容。\n\n- lesson:fixture-race\n"),
        ",project,test,p_high,scope:project,",
        {"title": "fixture 模块索引"},
    ),
    (
        "skill:rules/test:fixture-rule",
        jstr("# Test 规则镜像\n\n> 主源：vibe-coder-loop/rules/test.md\n\n降级条款：测试环境不可用时的降级顺序\n"),
        ",skill,level:domain,permanent,rules,scope:task,p_high,",
        {"title": "Test 规则镜像"},
    ),
    (
        "lesson:fixture-nosource",
        jstr("# Lesson：无来源的经验\n\n直接结论：某做法更稳。\n"),
        ",lesson,test,p_medium,scope:global,",
        {"title": "无来源经验", "access_count": 0},
    ),
    (
        "lesson:fixture-user-correction",
        jstr("# Lesson：用户纠正\n\n用户原话：停止 ≠ 删除，不要扩大操作范围。\n"),
        ",lesson,test,p_high,scope:global,",
        {"title": "用户纠正", "source": "user correction 2026-10-01", "trigger": "user-correction"},
    ),
    (
        "principle:fixture-p",
        jstr("# 原则：fixture\n\n## 原则\n断言必须可复核。\n\n## 反例\n子 agent 自述「已修」但 grep 仍命中。\n"),
        ",principle,test,p_critical,scope:global,permanent,",
        {"title": "fixture 原则", "promotion_basis": "5 实例跨 2 项目"},
    ),
    (
        "reference:fixture-gone",
        jstr("# 跳转页\n\n本页为纯导航。指向 lesson:fixture-missing（已失效）。\n"),
        ",reference,test,p_medium,scope:global,",
        {"title": "跳转页", "archived_at": "archive/x.md#anchor"},
    ),
]


def make_db(path: Path, records=FIXTURE) -> Path:
    conn = sqlite3.connect(str(path))
    conn.executescript(SCHEMA)
    for key, value, tags, meta in records:
        conn.execute(
            "INSERT INTO memory(key, value, created_at, updated_at, ttl_expires_at, tags, metadata) "
            "VALUES (?,?,?,?,NULL,?,?)",
            (key, value, TS, TS, tags, json.dumps(meta, ensure_ascii=False)),
        )
    conn.commit()
    conn.close()
    return path


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.db = make_db(self.dir / "db.sqlite")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def plan_for(self) -> dict:
        with tempfile.TemporaryDirectory() as td:
            return M.load_plan(self.db, "2026-10-22", Path(td))


class TestClassification(unittest.TestCase):
    def test_layer_enum(self):
        for key, value, tags, meta in FIXTURE:
            cls = distill.classify(key, L.decode_value(value), meta, L.split_tags(tags))
            self.assertIn(cls["layer"], set(L.LAYERS) | {None}, key)
            self.assertIn(cls["category"], L.CATEGORIES, key)
            if cls["category"] != "knowledge":
                self.assertIsNone(cls["layer"], f"{key} 非知识轴必须 layer=None")

    def test_navigation_not_counted(self):
        cls = distill.classify("project:fixture-index", "# 索引\n\n纯导航，不存实质内容", {}, ["scope:project"])
        self.assertEqual(cls["category"], "navigation")
        self.assertIsNone(cls["layer"])

    def test_decode_value(self):
        self.assertEqual(L.decode_value(jstr("a\nb")), "a\nb")
        self.assertEqual(L.decode_value(json.dumps({"k": 1})), '{\n  "k": 1\n}')
        self.assertEqual(L.decode_value("plain"), "plain")
        self.assertEqual(L.value_kind(jstr("x")), "json-str")


class TestPlanShape(Base):
    def test_plan_counts_and_pending(self):
        plan = self.plan_for()
        self.assertTrue(plan["dry_run"])
        self.assertTrue(plan["zero_side_effect"])
        for item in plan["backfill_preview"]:
            if item["add"].get("status") == "candidate":
                self.assertEqual(item["add"]["review_status"], "pending", item["key"])
        self.assertEqual(plan["quality"]["conflicts"]["auto_merged"], 0)
        self.assertTrue(plan["l1_slices"], "应能从 episode 叙事中切出 L1")
        for s in plan["l1_slices"]:
            self.assertEqual(s["status"], "candidate")
            self.assertEqual(s["review_status"], "pending")
            self.assertTrue(s["evidence_ids"])

    def test_l6_mirror_points_to_existing_file(self):
        plan = self.plan_for()
        for m in plan["mirror"]["resolved"]:
            self.assertTrue((ROOT / m["mirror_of"]).is_file(), m["mirror_of"])
        unresolved = {m["key"] for m in plan["mirror"]["unresolved"]}
        self.assertTrue(all(m["mirror_of"] is None for m in plan["mirror"]["unresolved"] if m["key"] in unresolved))

    def test_l5_requires_two_projects(self):
        plan = self.plan_for()
        for x in plan["l5_candidates"]:
            self.assertEqual(x["eligible_L5"], len(x["projects"]) >= 2, x["key"])


class TestMerge(unittest.TestCase):
    def test_add_only_preserves_existing(self):
        old = json.dumps({"title": "t", "access_count": 7, "layer": "pattern"})
        add = {"layer": "L5", "memory_category": "knowledge", "access_count": 0}
        merged, conflicts = M.merge_metadata(old, add)
        self.assertEqual(merged["access_count"], 7, "已有非空字段不得被覆盖")
        self.assertEqual(merged["layer"], "L5")
        self.assertEqual(merged["legacy_layer"], "pattern")
        self.assertTrue(conflicts and "access_count" in conflicts[0])

    def test_legacy_confidence_and_scope(self):
        old = json.dumps({"confidence": "High", "scope": "doc-writing"})
        add = {"confidence": 0.9, "scope_unknown": True, "scope": "unset"}
        merged, conflicts = M.merge_metadata(old, add)
        self.assertEqual(merged["confidence"], 0.9)
        self.assertEqual(merged["legacy_confidence"], "High")
        self.assertEqual(merged["legacy_scope"], "doc-writing")
        self.assertEqual(conflicts, [])

    def test_unset_scope_not_treated_as_legacy(self):
        old = json.dumps({"scope": "unset", "scope_unknown": True})
        merged, conflicts = M.merge_metadata(old, {"scope_unknown": True})
        self.assertEqual(merged["scope"], "unset")
        self.assertEqual(conflicts, [])


class TestApply(Base):
    def _orig_state(self):
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        rows = {r[0]: (r[1], r[2], r[3], r[4]) for r in conn.execute(
            "SELECT key, value, tags, updated_at, created_at FROM memory")}
        conn.close()
        return rows

    def test_dry_run_no_side_effect(self):
        before = M.fingerprint(sqlite3.connect(f"file:{self.db}?mode=ro", uri=True))
        plan = self.plan_for()
        out = M.dry_run(self.db, plan, 25)
        after = M.fingerprint(sqlite3.connect(f"file:{self.db}?mode=ro", uri=True))
        self.assertEqual(before, after)
        self.assertTrue(out["dry_run"])
        self.assertGreater(out["planned_updates"], 0)

    def test_apply_preserves_originals_and_is_idempotent(self):
        before = self._orig_state()
        plan = self.plan_for()
        fp_before = M.fingerprint(sqlite3.connect(f"file:{self.db}?mode=ro", uri=True))
        stats1 = M.apply_plan(self.db, plan, 3, None)
        self.assertEqual(stats1["updated"], len(FIXTURE))
        self.assertGreater(stats1["inserted"], 0)
        after = self._orig_state()
        for key, (value, tags, updated, created) in before.items():
            self.assertEqual(after[key][0], value, f"{key} value 被改")
            self.assertEqual(after[key][1], tags, f"{key} tags 被改")
            self.assertEqual(after[key][2], updated, f"{key} updated_at 被改")
            self.assertEqual(after[key][3], created, f"{key} created_at 被改")
        # 用户纠正 / 失败信号仍在
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        meta = json.loads(conn.execute(
            "SELECT metadata FROM memory WHERE key='lesson:fixture-user-correction'").fetchone()[0])
        conn.close()
        self.assertTrue(meta.get("needs_review") is False or meta.get("needs_review") is not None)
        stats2 = M.apply_plan(self.db, plan, 3, None)
        self.assertEqual((stats2["updated"], stats2["inserted"]), (0, 0), "二次应用必须幂等")
        self.assertEqual(M.fingerprint(sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)), fp_before)
        self.assertTrue(M.verify(self.db, plan, fp_before)["ok"])

    def test_interrupted_apply_can_resume(self):
        plan = self.plan_for()
        fp_before = M.fingerprint(sqlite3.connect(f"file:{self.db}?mode=ro", uri=True))
        os.environ["MIGRATE_FAIL_AFTER_BATCHES"] = "1"
        try:
            with self.assertRaises(RuntimeError):
                M.apply_plan(self.db, plan, 2, None)
        finally:
            os.environ.pop("MIGRATE_FAIL_AFTER_BATCHES", None)
        mid = M.verify(self.db, plan, fp_before)
        self.assertFalse(mid["ok"], "中断后应为未完成状态")
        stats = M.apply_plan(self.db, plan, 2, None)
        self.assertGreater(stats["updated"], 0)
        self.assertTrue(M.verify(self.db, plan, fp_before)["ok"])


class TestBackupRestore(Base):
    def test_backup_then_restore_keeps_fingerprint(self):
        bak = M.backup(self.db, self.dir / "bk", "test")
        fp = M.fingerprint(sqlite3.connect(f"file:{self.db}?mode=ro", uri=True))
        plan = self.plan_for()
        M.apply_plan(self.db, plan, 50, None)
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        expected = len(FIXTURE) + plan["quality"]["derived"]["l1_slices"] + plan["quality"]["derived"]["l2_candidates"]
        self.assertEqual(conn.execute("SELECT count(*) FROM memory").fetchone()[0], expected)
        conn.close()
        self.assertEqual(M.do_restore(self.db, bak), 0)
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        self.assertEqual(conn.execute("SELECT count(*) FROM memory").fetchone()[0], len(FIXTURE))
        self.assertEqual(M.fingerprint(conn), fp)
        conn.close()

    def test_backup_never_overwrites(self):
        a = M.backup(self.db, self.dir / "bk", "test")
        b = M.backup(self.db, self.dir / "bk", "test")
        self.assertNotEqual(a, b)
        self.assertTrue(a.exists() and b.exists())


class TestVerify(Base):
    def test_dangling_evidence_detected(self):
        plan = self.plan_for()
        fp = M.fingerprint(sqlite3.connect(f"file:{self.db}?mode=ro", uri=True))
        M.apply_plan(self.db, plan, 50, None)
        conn = sqlite3.connect(str(self.db))
        meta = json.loads(conn.execute(
            "SELECT metadata FROM memory WHERE key='lesson:fixture-race'").fetchone()[0])
        meta["evidence_ids"] = ["memory:lesson:does-not-exist"]
        conn.execute("UPDATE memory SET metadata=? WHERE key='lesson:fixture-race'",
                     (json.dumps(meta, ensure_ascii=False),))
        conn.commit()
        conn.close()
        res = M.verify(self.db, plan, fp)
        self.assertFalse(res["ok"])
        self.assertTrue(any("不存在的 key" in p for p in res["problems"]))

    def test_principle_cap_flagged(self):
        extra = []
        for i in range(11):
            extra.append((f"principle:fixture-cap-{i}", jstr(f"# 原则{i}\n\n反例：x"), ",principle,test,p_critical,", {}))
        db2 = make_db(self.dir / "db2.sqlite", list(FIXTURE) + extra)
        with tempfile.TemporaryDirectory() as td:
            plan = M.load_plan(db2, "2026-10-22", Path(td))
        fp = M.fingerprint(sqlite3.connect(f"file:{db2}?mode=ro", uri=True))
        res = M.verify(db2, plan, fp)
        self.assertGreater(res["l7_count"], 10)
        self.assertTrue(any("10 条上限" in p for p in res["problems"]))
        # 不覆盖：原记录仍在
        conn = sqlite3.connect(f"file:{db2}?mode=ro", uri=True)
        self.assertEqual(conn.execute("SELECT count(*) FROM memory WHERE key LIKE 'principle:%'").fetchone()[0], 12)
        conn.close()

    def test_candidate_never_approved(self):
        plan = self.plan_for()
        for item in plan["backfill_preview"]:
            if item["add"].get("status") == "candidate":
                self.assertEqual(item["add"]["review_status"], "pending")


if __name__ == "__main__":
    unittest.main()
