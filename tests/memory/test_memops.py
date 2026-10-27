"""memops.py 单元测试：validate / search / repair / split。

运行：python3 -m unittest tests.memory.test_memops -v
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "memory"))

import memops  # noqa: E402

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

TS = 1790000000000


def jstr(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.db = self.dir / "db.sqlite"
        conn = sqlite3.connect(str(self.db))
        conn.executescript(SCHEMA)
        archive = self.dir / "archive.md"
        archive.write_text("archived original", encoding="utf-8")
        self.add_entry(
            conn,
            "lesson:parent",
            f"# Lesson parent\n\n## 触发\nparent needle marker\n\n## 根因\nroot cause\n\n"
            f"> 已归档：`{archive}`\n",
            ",lesson,test,p_high,scope:global,",
            {
                "title": "parent",
                "layer": "L3",
                "memory_category": "knowledge",
                "scope": "global",
                "status": "active",
                "review_status": "approved",
                "confidence": 0.8,
                "evidence_level": "E3",
                "evidence_ids": ["anchor:value:date", "memory:lesson:missing-parent-evidence"],
            },
        )
        self.add_entry(
            conn,
            "lesson:parent#1-触发",
            "# 触发\nparent needle marker\n",
            ",lesson,test,p_high,scope:global,fragment,",
            {
                "title": "触发",
                "parent_key": "lesson:parent",
                "fragment": True,
                "part": 1,
                "of_parts": 2,
                "source_chars": 120,
                "status": "active",
                "review_status": "pending",
                "created_by": "memops-split@2026-10-23",
            },
        )
        self.add_entry(
            conn,
            "project:nav",
            "# nav\n\n纯导航，不存实质内容。\n",
            ",project,test,p_high,scope:project,",
            {"title": "nav", "layer": None, "memory_category": "navigation", "scope": "project", "status": "active", "review_status": "pending"},
        )
        self.add_entry(
            conn,
            "project:nav#1-详情",
            "# 详情\n导航细节\n",
            ",project,test,p_high,scope:project,fragment,",
            {"title": "详情", "parent_key": "project:nav", "fragment": True, "status": "active", "review_status": "pending"},
        )
        self.add_entry(
            conn,
            "vc:checkpoint:/tmp/demo",
            "phase: S2\n",
            ",vc-checkpoint,L0,scope:project,",
            {"title": "checkpoint", "layer": "L0", "memory_category": "state", "scope": "project", "status": "active"},
        )
        conn.commit()
        conn.close()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    @staticmethod
    def add_entry(conn, key, value, tags, meta) -> None:
        conn.execute(
            "INSERT INTO memory(key, value, created_at, updated_at, ttl_expires_at, tags, metadata) "
            "VALUES (?,?,?,?,NULL,?,?)",
            (key, jstr(value), TS, TS, tags, json.dumps(meta, ensure_ascii=False)),
        )

    def row(self, key: str) -> dict:
        conn = sqlite3.connect(str(self.db))
        conn.row_factory = sqlite3.Row
        r = conn.execute("SELECT key, tags, metadata, value FROM memory WHERE key=?", (key,)).fetchone()
        conn.close()
        assert r is not None
        return {"key": r["key"], "tags": r["tags"], "meta": json.loads(r["metadata"]), "value": json.loads(r["value"])}

    def rows(self) -> list[dict]:
        conn = sqlite3.connect(str(self.db))
        conn.row_factory = sqlite3.Row
        out = [
            {"key": r["key"], "tags": r["tags"], "meta": json.loads(r["metadata"]), "value": json.loads(r["value"])}
            for r in conn.execute("SELECT key, tags, metadata, value FROM memory ORDER BY key")
        ]
        conn.close()
        return out


class ValidateTests(Base):
    def test_validate_detects_fragment_and_checkpoint(self) -> None:
        report = memops.validate_db(self.db, max_examples=1)
        self.assertFalse(report["ok"])
        self.assertIn("fragment_missing_field", report["errors"])
        self.assertIn("fragment_layer_missing", report["errors"])
        self.assertIn("checkpoint_l0_conflict", report["errors"])
        self.assertIn("dangling_evidence", report["errors"])

    def test_search_excludes_fragments_by_default(self) -> None:
        default = memops.search_db(self.db, "needle")
        keys = [r["key"] for r in default]
        self.assertIn("lesson:parent", keys)
        self.assertNotIn("lesson:parent#1-触发", keys)
        with_frag = memops.search_db(self.db, "needle", include_fragments=True)
        self.assertIn("lesson:parent#1-触发", [r["key"] for r in with_frag])


class RepairTests(Base):
    def test_repair_inherits_and_is_idempotent(self) -> None:
        rows = memops.load_rows(memops.connect_ro(str(self.db)))
        plans, _ = memops.plan_repair(rows, ttl=True)
        self.assertTrue(plans)
        result = memops.apply_repair(self.db, plans, self.dir / "bk")
        self.assertEqual(result["updated"], len(plans))

        frag = self.row("lesson:parent#1-触发")
        self.assertEqual(frag["meta"]["layer"], "L3")
        self.assertEqual(frag["meta"]["memory_category"], "knowledge")
        self.assertEqual(frag["meta"]["review_status"], "approved")
        self.assertTrue(frag["meta"]["content_hash"])
        self.assertIn("layer:L3", frag["tags"])
        self.assertIn("file:", " ".join(frag["meta"]["evidence_ids"]))
        self.assertNotIn("memory:lesson:missing-parent-evidence", frag["meta"]["evidence_ids"])
        self.assertIn("memory:lesson:missing-parent-evidence", frag["meta"]["evidence_missing"])

        nav_frag = self.row("project:nav#1-详情")
        self.assertIn("layer", nav_frag["meta"])
        self.assertIsNone(nav_frag["meta"]["layer"])

        cp = self.row("vc:checkpoint:/tmp/demo")
        self.assertIsNone(cp["meta"]["layer"])
        self.assertEqual(cp["meta"]["memory_category"], "state")
        self.assertNotIn("L0", cp["tags"])
        self.assertIn("runtime-state", cp["tags"])

        report = memops.validate_db(self.db)
        self.assertTrue(report["ok"], report["errors"])

        rows2 = memops.load_rows(memops.connect_ro(str(self.db)))
        plans2, _ = memops.plan_repair(rows2, ttl=True)
        self.assertEqual(plans2, [], "二次 repair 必须幂等")


class SplitTests(Base):
    def test_split_preserves_content_and_inherits_layer(self) -> None:
        conn = sqlite3.connect(str(self.db))
        long_text = (
            "# 长条目\n\npreamble\n\n"
            "## 第一节\n" + "a" * 400 + "\n\n"
            "## 第二节\n" + "b" * 400 + "\n\n"
            "## 第三节\n" + "c" * 400 + "\n"
        )
        self.add_entry(
            conn,
            "project:long",
            long_text,
            ",project,test,p_high,scope:project,",
            {
                "title": "长条目",
                "layer": "L4",
                "memory_category": "knowledge",
                "scope": "project",
                "status": "active",
                "review_status": "approved",
                "evidence_ids": ["anchor:value:path"],
            },
        )
        conn.commit()
        conn.close()

        plan = memops.plan_split(self.db, "project:long", 500, self.dir / "archive")
        self.assertGreaterEqual(len(plan["parts"]), 2)
        result = memops.apply_split(self.db, plan, self.dir / "bk")
        self.assertEqual(result["fragments"], len(plan["parts"]))

        parent = self.row("project:long")
        self.assertIn("分片索引", parent["value"])
        self.assertIn("archive_ref", parent["meta"])
        joined = ""
        for part in plan["parts"]:
            frag = self.row(part["key"])
            self.assertEqual(frag["meta"]["layer"], "L4")
            self.assertEqual(frag["meta"]["memory_category"], "knowledge")
            self.assertIn("fragment", frag["tags"])
            self.assertIn("layer:L4", frag["tags"])
            self.assertTrue(frag["meta"]["content_hash"])
            self.assertIn("file:", " ".join(frag["meta"]["evidence_ids"]))
            joined += frag["value"] + "\n\n"
        self.assertIn("a" * 400, joined)
        self.assertIn("b" * 400, joined)
        self.assertIn("c" * 400, joined)

        with self.assertRaises(SystemExit):
            memops.apply_split(self.db, plan, self.dir / "bk")


if __name__ == "__main__":
    unittest.main()
