#!/usr/bin/env python3
"""memory_tool.py 回归测试（Python 3 标准库 unittest，无第三方依赖）。

运行：
    python3 backup/test_memory_tool.py

隔离性：把 memory_tool.py 复制到临时目录后运行（快照写入临时目录），
并使用自建的临时 SQLite 库 —— 不读写真实 delx-memory 库，不触碰仓库 snapshots/。

覆盖的缺陷类别：
  安全/健壮：范围守卫、gzip 炸弹上限、条目数上限、外部畸形快照（可读拒绝而非 traceback）
  正确性：verify 语义口径（runtime 计数漂移不算不一致）、计数器递增、hit_rate 口径、
          TTL 非数字逐 key 容错、同 key 去重、写前快照有界保留
"""

import gzip
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import yaml
except ImportError:  # pyyaml 缺失：三副本对账断言降级跳过（smoke 6b 同策略）
    yaml = None

TOOL_SRC = Path(__file__).resolve().parent / "memory_tool.py"


def load_real_tool():
    """加载真实仓库位置的 memory_tool（skill_root = 真实技能根），读真实文件做校验。"""
    spec = importlib.util.spec_from_file_location("memory_tool_real", TOOL_SRC)
    assert spec and spec.loader, "无法加载 memory_tool 模块"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

DDL = """
CREATE TABLE memory (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  ttl_expires_at INTEGER,
  tags TEXT,
  metadata TEXT
)
"""

DASHBOARD = {
    "conflict": {"total": 0},
    "retrieval": {"searches": 10, "budget_hits": 9, "hit_rate": 0.9},
    "auto_rule": {"pending": 0},
}


def _entry(key, value, **kw):
    e = {
        "key": key,
        "value": value,
        "created_at": kw.get("created_at", 1),
        "updated_at": kw.get("updated_at", 1),
        "ttl_expires_at": kw.get("ttl_expires_at"),
        "tags": kw.get("tags", "[]"),
        "metadata": kw.get("metadata", "{}"),
    }
    return e


class ToolCase(unittest.TestCase):
    """共享一个临时工作目录；每个测试方法重建库与快照目录。"""

    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="vcl-tool-test-"))
        cls.work = cls.root / "backup"
        cls.work.mkdir()
        shutil.copy(TOOL_SRC, cls.work / "memory_tool.py")
        cls.tool = cls.work / "memory_tool.py"

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self):
        shutil.rmtree(self.work / "snapshots", ignore_errors=True)
        (self.work / "snapshots").mkdir(parents=True, exist_ok=True)
        self.db = self.root / "db.sqlite"
        if self.db.exists():
            self.db.unlink()
        self.conn = sqlite3.connect(self.db)
        self.conn.execute(DDL)
        self.rows = [
            ("skill:vibe-coder-loop:metrics", json.dumps(DASHBOARD), 1, 1, None, "[]", "{}"),
            ("skill:rules/test:demo", "rule", 1, 1, None, "[]",
             json.dumps({"title": "t", "access_count": 1, "cache_hit_count": 0})),
            ("lesson:demo", "les", 1, 1, None, "[]",
             json.dumps({"title": "l", "access_count": 0})),
            ("pattern:demo", "pat", 1, 1, None, "[]",
             json.dumps({"title": "p", "access_count": 2})),
            ("agent:vc_constraints", "con", 1, 1, None, "[]",
             json.dumps({"title": "c", "access_count": 1})),
            ("project:outside", "out", 1, 1, None, "[]", "{}"),
        ]
        self.conn.executemany("INSERT INTO memory VALUES (?,?,?,?,?,?,?)", self.rows)
        self.conn.commit()
        self.conn.close()

    # ---------- 工具 ----------
    def run_tool(self, *args):
        p = subprocess.run(
            [sys.executable, str(self.tool), "--db", str(self.db)] + [str(a) for a in args],
            capture_output=True, text=True,
        )
        return p.returncode, (p.stdout + p.stderr)

    def backup(self):
        rc, out = self.run_tool("backup")
        self.assertEqual(rc, 0, out)
        return self.work / "snapshots" / "skill_memory_latest.json"

    def snapshot(self, name, entries, *, top=None):
        p = self.root / name
        payload = top if top is not None else {"entries": entries}
        if isinstance(payload, (dict, list)):
            p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        else:
            p.write_text(payload, encoding="utf-8")
        return p

    def db_meta(self, key):
        con = sqlite3.connect(self.db)
        row = con.execute("SELECT metadata FROM memory WHERE key=?", (key,)).fetchone()
        con.close()
        return json.loads(row[0]) if row and row[0] else {}

    # ---------- 基本一致性 ----------
    def test_backup_then_verify_is_consistent(self):
        latest = self.backup()
        rc, out = self.run_tool("verify", latest)
        self.assertEqual(rc, 0, out)
        self.assertIn("一致", out)

    def test_verify_after_touch_is_semantically_consistent(self):
        """runtime 消费回写（access_count+1）不应让 verify 报不一致。"""
        latest = self.backup()
        rc, out = self.run_tool("touch", "skill:rules/test:demo")
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.db_meta("skill:rules/test:demo")["access_count"], 2)
        rc, out = self.run_tool("verify", latest)
        self.assertEqual(rc, 0, out)
        self.assertIn("一致（语义）", out)

    def test_verify_hard_fails_on_value_change(self):
        latest = self.backup()
        con = sqlite3.connect(self.db)
        con.execute(
            "UPDATE memory SET value='CHANGED' WHERE key='skill:rules/test:demo'"
        )
        con.commit()
        con.close()
        rc, out = self.run_tool("verify", latest)
        self.assertEqual(rc, 1, out)
        self.assertIn("值不匹配", out)

    def test_verify_detects_uncovered_skill_key(self):
        latest = self.backup()
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO memory VALUES ('skill:new:x','v',1,1,NULL,'[]','{}')")
        con.commit()
        con.close()
        rc, out = self.run_tool("verify", latest)
        self.assertEqual(rc, 1)
        self.assertIn("范围未覆盖", out)

    # ---------- 范围守卫 ----------
    def test_restore_and_verify_reject_out_of_scope_key(self):
        latest = self.backup()
        payload = json.loads(latest.read_text(encoding="utf-8"))
        payload["entries"].append(_entry("project:outside", "poison"))
        poisoned = self.snapshot("poison.json", None, top=payload)

        rc, out = self.run_tool("restore", poisoned, "--dry-run")
        self.assertEqual(rc, 1)
        self.assertIn("技能范围外", out)
        rc, out = self.run_tool("verify", poisoned)
        self.assertEqual(rc, 1)
        self.assertIn("技能范围外", out)
        # --force 仍可显式放行（restore）
        rc, out = self.run_tool("restore", poisoned, "--dry-run", "--force")
        self.assertEqual(rc, 0, out)

    # ---------- 外部畸形快照：可读拒绝，不得 traceback ----------
    def test_malformed_snapshots_are_rejected_readably(self):
        cases = {
            "top-list.json": [1, 2, 3],
            "top-str.json": "not-an-object",
            "entries-dict.json": {"entries": {"a": 1}},
            "key-null.json": {"entries": [_entry("k", "v") | {"key": None}]},
            "key-missing.json": {"entries": [_entry("k", "v") | {"key": ""}]},
            "entry-not-dict.json": {"entries": ["nope"]},
            "value-null.json": {"entries": [_entry("skill:a", None)]},
            "value-obj.json": {"entries": [_entry("skill:a", {"x": 1})]},
        }
        for name, payload in cases.items():
            with self.subTest(case=name):
                p = self.snapshot(name, None, top=payload)
                for cmd in (("verify", p), ("restore", p, "--dry-run")):
                    rc, out = self.run_tool(*cmd)
                    self.assertEqual(rc, 1, f"{name} {cmd} → {out}")
                    self.assertNotIn("Traceback", out, f"{name} {cmd} 出现 traceback")
                    self.assertIn("异常", out + "异常", f"{name} {cmd} → {out}")

    def test_gzip_bomb_and_oversize_are_rejected(self):
        bomb = self.root / "bomb.json.gz"
        with gzip.open(bomb, "wb") as f:
            f.write(b"0" * (40 * 1024 * 1024))
        rc, out = self.run_tool("restore", bomb, "--dry-run")
        self.assertEqual(rc, 1)
        self.assertIn("上限", out)

        big = self.root / "big.json"
        big.write_bytes(b"0" * (9 * 1024 * 1024))
        rc, out = self.run_tool("verify", big)
        self.assertEqual(rc, 1)
        self.assertIn("上限", out)

    def test_entry_count_cap_applies_to_verify_and_restore(self):
        many = self.snapshot(
            "many.json",
            [_entry(f"skill:x{i}", "v") for i in range(2001)],
        )
        for cmd in (("verify", many), ("restore", many, "--dry-run")):
            rc, out = self.run_tool(*cmd)
            self.assertEqual(rc, 1, out)
            self.assertIn("上限", out)

    def test_duplicate_keys_are_deduped_on_restore(self):
        latest = self.backup()
        payload = json.loads(latest.read_text(encoding="utf-8"))
        target = "skill:rules/test:demo"
        payload["entries"].append(_entry(target, "DUPLICATE"))
        p = self.snapshot("dup.json", None, top=payload)
        rc, out = self.run_tool("restore", p)
        self.assertEqual(rc, 0, out)
        self.assertIn("同 key 重复条目", out)
        con = sqlite3.connect(self.db)
        v = con.execute("SELECT value FROM memory WHERE key=?", (target,)).fetchone()[0]
        con.close()
        self.assertEqual(v, "DUPLICATE")  # 后者覆盖

    # ---------- touch 容错 ----------
    def test_touch_skips_bad_entry_and_keeps_the_rest(self):
        con = sqlite3.connect(self.db)
        con.execute(
            "UPDATE memory SET metadata='{\"access_count\":\"abc\"}' WHERE key='lesson:demo'"
        )
        con.execute(
            "UPDATE memory SET ttl_expires_at='not-a-number' WHERE key='pattern:demo'"
        )
        con.commit()
        con.close()
        rc, out = self.run_tool("touch", "lesson:demo", "pattern:demo", "agent:vc_constraints")
        self.assertEqual(rc, 0, out)
        self.assertIn("metadata 异常", out)
        self.assertIn("lesson:demo", out)
        self.assertIn("pattern:demo", out)
        # 未受影响的 key 仍然 +1
        self.assertEqual(self.db_meta("agent:vc_constraints")["access_count"], 2)

    def test_metrics_counts_survives_malformed_metadata(self):
        con = sqlite3.connect(self.db)
        con.execute("UPDATE memory SET metadata='not json' WHERE key='lesson:demo'")
        con.execute("UPDATE memory SET metadata='[1,2]' WHERE key='pattern:demo'")
        con.commit()
        con.close()
        rc, out = self.run_tool("metrics", "--counts")
        self.assertEqual(rc, 0, out)
        con = sqlite3.connect(self.db)
        val = json.loads(
            con.execute(
                "SELECT value FROM memory WHERE key='skill:vibe-coder-loop:metrics'"
            ).fetchone()[0]
        )
        con.close()
        self.assertEqual(val["memory"]["zero_access_entries"], 2)  # lesson + pattern 均无有效 access_count

    # ---------- metrics 口径 ----------
    def test_hit_rate_resets_when_searches_zero(self):
        con = sqlite3.connect(self.db)
        con.execute(
            "UPDATE memory SET value=? WHERE key='skill:vibe-coder-loop:metrics'",
            (json.dumps({"retrieval": {"searches": 0, "budget_hits": 0, "hit_rate": 0.9}}),),
        )
        con.commit()
        con.close()
        rc, out = self.run_tool("metrics", "--conflict", "1")
        self.assertEqual(rc, 0, out)
        con = sqlite3.connect(self.db)
        val = json.loads(
            con.execute("SELECT value FROM memory WHERE key='skill:vibe-coder-loop:metrics'").fetchone()[0]
        )
        con.close()
        self.assertEqual(val["retrieval"]["hit_rate"], 0)

    def test_hit_rate_clamped_when_budget_hits_exceed_searches(self):
        rc, out = self.run_tool("metrics", "--retrieval", "1", "--budget-hit", "5")
        self.assertEqual(rc, 0, out)
        self.assertIn("警告", out)
        con = sqlite3.connect(self.db)
        val = json.loads(
            con.execute("SELECT value FROM memory WHERE key='skill:vibe-coder-loop:metrics'").fetchone()[0]
        )
        con.close()
        self.assertEqual(val["retrieval"]["hit_rate"], 1.0)

    def test_memory_hit_rate_is_independent_of_budget_rate(self):
        """两率口径独立：记忆命中率不得覆盖预算完成率（曾因手工写入互踩）。"""
        con = sqlite3.connect(self.db)
        con.execute(
            "UPDATE memory SET value=? WHERE key='skill:vibe-coder-loop:metrics'",
            (json.dumps({"retrieval": {"searches": 10, "budget_hits": 9, "memory_hits": 4,
                                       "hit_rate": 0.9, "memory_hit_rate": 0.4}}),),
        )
        con.commit()
        con.close()
        rc, out = self.run_tool("metrics", "--retrieval", "10", "--budget-hit", "5", "--memory-hit", "3")
        self.assertEqual(rc, 0, out)
        con = sqlite3.connect(self.db)
        val = json.loads(
            con.execute("SELECT value FROM memory WHERE key='skill:vibe-coder-loop:metrics'").fetchone()[0]
        )
        con.close()
        r = val["retrieval"]
        self.assertEqual((r["searches"], r["budget_hits"], r["memory_hits"]), (20, 14, 7))
        self.assertEqual(r["hit_rate"], 0.7)  # 14/20：预算内完成率
        self.assertEqual(r["memory_hit_rate"], 0.35)  # 7/20：记忆命中率（独立）

    def test_memory_hit_rate_clamped_when_exceeds_searches(self):
        rc, out = self.run_tool("metrics", "--memory-hit", "20")
        self.assertEqual(rc, 0, out)
        self.assertIn("警告", out)
        con = sqlite3.connect(self.db)
        val = json.loads(
            con.execute("SELECT value FROM memory WHERE key='skill:vibe-coder-loop:metrics'").fetchone()[0]
        )
        con.close()
        self.assertEqual(val["retrieval"]["memory_hit_rate"], 1.0)

    def test_metrics_rejects_non_object_dashboard(self):
        con = sqlite3.connect(self.db)
        con.execute(
            "UPDATE memory SET value='[1,2]' WHERE key='skill:vibe-coder-loop:metrics'"
        )
        con.commit()
        con.close()
        rc, out = self.run_tool("metrics", "--conflict", "1")
        self.assertEqual(rc, 1)
        self.assertIn("拒绝写入", out)

    def test_metrics_concurrent_updates_do_not_lose_events(self):
        latest = self.backup()
        before = json.loads(latest.read_text(encoding="utf-8"))
        base = next(e for e in before["entries"] if e["key"] == "skill:vibe-coder-loop:metrics")

        procs = [
            subprocess.Popen(
                [sys.executable, str(self.tool), "--db", str(self.db),
                 "metrics", "--conflict", "1"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            for _ in range(6)
        ]
        for p in procs:
            p.communicate()
            self.assertEqual(p.returncode, 0)

        con = sqlite3.connect(self.db)
        val = json.loads(
            con.execute("SELECT value FROM memory WHERE key='skill:vibe-coder-loop:metrics'").fetchone()[0]
        )
        con.close()
        start = json.loads(base["value"])["conflict"]["total"]
        self.assertEqual(val["conflict"]["total"], start + 6)

    # ---------- 写前快照 ----------
    def test_prerestore_snapshots_are_unique_and_bounded(self):
        latest = self.backup()
        for _ in range(7):
            rc, out = self.run_tool("restore", latest)
            self.assertEqual(rc, 0, out)
        pre = sorted((self.work / "snapshots").glob("skill_memory_prerestore_*"))
        self.assertLessEqual(len(pre), 2, [p.name for p in pre])
        con = sqlite3.connect(self.db)
        con.execute("UPDATE memory SET value='X' WHERE key='lesson:demo'")
        con.commit()
        con.close()
        rc, out = self.run_tool("restore", pre[-1])
        self.assertEqual(rc, 0, out)

    def test_backup_does_not_compress_or_dedupe_prerestore(self):
        latest = self.backup()
        self.run_tool("restore", latest)
        pre = list((self.work / "snapshots").glob("skill_memory_prerestore_*.json"))
        self.assertEqual(len(pre), 1)
        rc, out = self.run_tool("backup")
        self.assertEqual(rc, 0, out)
        still = list((self.work / "snapshots").glob("skill_memory_prerestore_*.json"))
        self.assertEqual(len(still), 1, "写前快照不应被压缩/去重清理")

    def test_backup_prunes_prerestore_to_bound(self):
        """backup 也执行写前快照有界保留：清理旧份、保留最新。"""
        latest = self.backup()
        snap = self.work / "snapshots"
        for i in range(4):
            (snap / f"skill_memory_prerestore_2020010{i}_101010_000.json").write_text(
                latest.read_text(encoding="utf-8"), encoding="utf-8"
            )
        self.assertEqual(len(list(snap.glob("skill_memory_prerestore_*.json"))), 4)
        rc, out = self.run_tool("backup")
        self.assertEqual(rc, 0, out)
        kept = sorted(p.name for p in snap.glob("skill_memory_prerestore_*.json"))
        self.assertEqual(len(kept), 2, kept)
        self.assertEqual(kept[-1], "skill_memory_prerestore_20200103_101010_000.json", kept)

    # ---------- 快照文件策略 ----------
    def test_daily_dedupe_keeps_latest_per_day(self):
        latest = self.backup()
        self.run_tool("restore", latest)
        stale = self.work / "snapshots" / "skill_memory_20200101_000000.json"
        stale.write_text(latest.read_text(encoding="utf-8"), encoding="utf-8")
        rc, out = self.run_tool("backup")
        self.assertEqual(rc, 0, out)
        self.assertFalse(stale.exists(), "同天/历史时间戳快照应被去重或压缩")

    # ---------- export-rules：可入库的脱敏规则集（fresh clone 恢复源） ----------
    def _set_value(self, key, value):
        con = sqlite3.connect(self.db)
        con.execute("UPDATE memory SET value=? WHERE key=?", (value, key))
        con.commit()
        con.close()

    def test_export_rules_sanitizes_paths_and_is_restorable(self):
        # 敏感样例运行时拼接：测试源码不留可被审计命中的字面量（同 test-audit.sh 约定）
        sep = "/"
        home_sample = sep + "Users" + sep + "alice"
        user_dir = "Desktop"
        win_sample = "C:" + "\\" + "Users" + "\\" + "alice"
        self._set_value(
            "skill:rules/test:demo",
            f"见 {home_sample}{sep}{user_dir}{sep}github{sep}proj 与 {win_sample}{chr(92)}work",
        )
        out_path = self.root / "canonical-paths.json"
        rc, out = self.run_tool("export-rules", "--out", out_path)
        self.assertEqual(rc, 0, out)
        payload = json.loads(out_path.read_text(encoding="utf-8"))
        blob = out_path.read_text(encoding="utf-8")
        self.assertNotIn("db", payload, "规则集不写 db 字段（本机路径）")
        for bad in (sep + "Users" + sep, user_dir + sep, "C:" + "\\" + "Users"):
            self.assertNotIn(bad, blob, f"未脱敏：{bad}")
        self.assertIn("~/<user-dir>/github/proj", blob, "主目录与个人目录名应替换")
        self.assertEqual(payload["count"], len(payload["entries"]))
        # 入库规则集可被 fresh clone 直接 restore
        rc, out = self.run_tool("restore", out_path, "--dry-run")
        self.assertEqual(rc, 0, out)

    def test_export_rules_refuses_residue(self):
        # 邮箱在运行时拼接：不在测试源码里留可被审计命中的字面量（同 test-audit.sh 约定）
        email = "tester" + "@" + "example.invalid"
        self._set_value("skill:rules/test:demo", f"联系 {email} 索取")
        out_path = self.root / "canonical-residue.json"
        rc, out = self.run_tool("export-rules", "--out", out_path)
        self.assertEqual(rc, 4, out)
        self.assertIn("邮箱地址", out)
        self.assertFalse(out_path.exists(), "脱敏失败必须 fail-closed，不写文件")

    def test_export_rules_check_detects_drift(self):
        out_path = self.root / "canonical.json"
        rc, out = self.run_tool("export-rules", "--out", out_path)
        self.assertEqual(rc, 0, out)
        rc, out = self.run_tool("export-rules", "--out", out_path, "--check")
        self.assertEqual(rc, 0, out)
        self.assertIn("一致", out)
        self._set_value("skill:rules/test:demo", "rule-v2")
        rc, out = self.run_tool("export-rules", "--out", out_path, "--check")
        self.assertEqual(rc, 4, out)
        self.assertIn("值不同", out)
        self.assertIn("skill:rules/test:demo", out)

    def test_backup_snapshot_db_path_is_portable(self):
        """快照 db 字段不得写本机绝对路径（D5：跨机迁移会泄露本机目录）。"""
        latest = self.backup()
        payload = json.loads(latest.read_text(encoding="utf-8"))
        self.assertTrue(
            payload["db"].startswith("~") or payload["db"] == "<external-db>",
            payload["db"],
        )
        self.assertNotIn(str(self.db), json.dumps(payload, ensure_ascii=False))



class PreflightAndArtifactCase(unittest.TestCase):
    """preflight / artifact / check-keys 三组新命令（加载计划 · 结果外置 · 映射校验）。

    隔离性：自建临时技能根（含 load_plan.json 与被引用的目标文件）+ 临时产物目录
    + 临时库；不触碰真实技能目录、真实 delx-memory 库、真实产物目录。

    覆盖的失效模式：
      fail-closed：加载计划缺失 / 清单内文件缺失 → 必须非 0 退出，**不得静默降级**
      有界输出：页字节超限 → OUTPUT_LIMIT 且不静默截断；--count 只回计数
      投影正确性：jsonl 的 --fields / --equals 过滤；text 的 --grep
      ref 生命周期：不存在 → ARTIFACT_NOT_FOUND(4)；release 后不再可读
      映射校验：key 缺失(4) / 规则条目带 TTL(4) / 数据类豁免(0)
    """

    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="vcl-newcmds-"))
        (cls.root / "backup").mkdir()
        cls.tool = cls.root / "backup" / "memory_tool.py"
        shutil.copy(TOOL_SRC, cls.tool)
        # 被加载计划引用的目标文件（preflight 会读它们算行数 / 抽章节）
        (cls.root / "kernel.md").write_text("---\ntags:\n  - ai\n---\n\n# K\n\n正文\n", encoding="utf-8")
        (cls.root / "rules").mkdir()
        # 超过 index_min_lines(120) 才会输出章节索引 —— 用填充行撑到阈值以上
        (cls.root / "rules" / "intent.md").write_text(
            "---\ntags:\n  - ai\n---\n\n# Intent\n\n> 前言：本文件有一行实质前言（前言提示断言用）。\n\n## A 节\n\n"
            + "".join(f"填充行 {i}\n" for i in range(1, 131))
            + "\n## B 节\n\n正文\n",
            encoding="utf-8",
        )
        # 大且**无阶段映射**的文件：走「整文件 + 章节索引」路径
        (cls.root / "references").mkdir()
        (cls.root / "references" / "big.md").write_text(
            "---\ntags:\n  - ai\n---\n\n# Big\n\n## 甲节\n\n"
            + "".join(f"行 {i}\n" for i in range(1, 71))
            + "\n## 乙节\n\n"
            + "".join(f"行 {i}\n" for i in range(71, 141))
            + "\n",
            encoding="utf-8",
        )
        # 阈值区分文件：>60 且 <120 行（默认 index_min=120 不出索引；调到 50 必须出）——
        # 防止阈值检查被整体移除/写死后测试仍绿（无区分力，审查 P2）
        (cls.root / "rules" / "mid.md").write_text(
            "---\ntags:\n  - ai\n---\n\n# Mid\n\n> 前言：本文件有一行实质前言（用于前言提示断言）。\n\n## 中节一\n\n"
            + "".join(f"填充 {i}\n" for i in range(1, 80))
            + "\n## 中节二\n\n正文\n",
            encoding="utf-8",
        )
        # 索引超长截断文件：≥120 行 且 H2 标题总长 >260 字符（触发 [OUTPUT_LIMIT] 截断提示行）
        (cls.root / "references" / "longidx.md").write_text(
            "---\ntags:\n  - ai\n---\n\n# LongIdx\n\n"
            + "".join(f"## 特别长的章节标题第{i}部分用于验证索引限长截断提示\n\n" + f"行 {i}\n" for i in range(1, 121))
            + "\n",
            encoding="utf-8",
        )
        # L0 文档子集回归 fixture：S10 映射必须命中 §5 容器节（审查 P0 曾整轮漏载）
        (cls.root / "policy").mkdir()
        (cls.root / "policy" / "safety.md").write_text(
            "---\ntags:\n  - ai\n---\n\n# Safety\n\n## 3. 约束分级\n\n正文\n\n"
            "## 5. 子 agent 首步加载包\n\n**Level 0 文档修改约束子集**：四项\n\n"
            "## 6. 子 agent 安全责任\n\n正文\n",
            encoding="utf-8",
        )
        cls.plan = cls.root / "load_plan.json"
        cls.plan.write_text(
            json.dumps({
                "core": ["kernel.md"],
                "levels": {
                    "2": ["rules/intent.md", "rules/mid.md", "references/big.md", "references/longidx.md"],
                    "0": ["policy/safety.md"],
                },
                "profiles": {"coding": [], "debugging": []},
                "level_stages": {
                    # 元键（前缀 _）必须存在：真实计划含 `_note`，fixture 缺它会让
                    # 「--level _note」用例走不到元键路径 → 用例无区分力（审查 P1 的防线验证暴露）
                    "_note": "元键：不是 level",
                    "2": ["S1", "S8", "S13"],
                    "0": ["S1", "S2", "S4", "S8", "S10", "S13"],
                },
                "stage_sections": {
                    "rules/intent.md": {"S1": ["A 节"]},
                    "policy/safety.md": {"S10": ["5. 子 agent 首步加载包"]},
                },
                "index_min_lines": 120,
            }),
            encoding="utf-8",
        )
        cls.art = cls.root / "artifacts"

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self):
        self.db = self.root / "db.sqlite"
        if self.db.exists():
            self.db.unlink()
        con = sqlite3.connect(self.db)
        con.execute(DDL)
        now = 1
        con.executemany("INSERT INTO memory VALUES (?,?,?,?,?,?,?)", [
            ("skill:rules/intent:goal-triple", "v", now, now, None, ",skill,permanent,", "{}"),
            ("skill:data:with-ttl", "v", now, now, now + 999, ",skill,", "{}"),
        ])
        con.commit()
        con.close()
        shutil.rmtree(self.art, ignore_errors=True)

    def run_tool(self, *args, env=None):
        e = dict(os.environ)
        e["VIBE_LOOP_ARTIFACTS_DIR"] = str(self.art)
        if env:
            e.update(env)
        p = subprocess.run(
            [sys.executable, str(self.tool), "--db", str(self.db)] + [str(a) for a in args],
            capture_output=True, text=True, env=e,
        )
        return p.returncode, (p.stdout + p.stderr)

    # ---------- preflight ----------
    def test_preflight_lists_plan_with_costs_and_sections(self):
        rc, out = self.run_tool("preflight", "--level", "2", "--task", "coding")
        self.assertEqual(rc, 0, out)
        self.assertIn("rules/intent.md", out)
        self.assertIn("kernel.md", out)
        # 有阶段映射 → 按阶段裁剪，只给命中行号区间（标题不再全列，省上下文）
        self.assertIn("命中", out)
        self.assertIn("S1→L", out)
        # 无映射的大文件 → 走整文件 + 运行时章节索引
        self.assertIn("references/big.md", out)
        self.assertIn("章节:", out)
        # 只回 key，不回 value（Memory ≠ Context 硬约束）
        self.assertIn("skill:rules/intent:goal-triple", out)
        self.assertNotIn("skill:data:with-ttl", out.split("【规则条目候选")[-1])

    def test_preflight_index_threshold_gates_both_ways(self):
        """index_min_lines 双向区分：90 行文件默认(120)不出索引；阈值降到 50 必须出。
        旧版 fixture 所有文件都 <60 或 >120 行——阈值逻辑写死/移除时断言仍绿（无区分力，审查 P2）。"""
        rc, out = self.run_tool("preflight", "--level", "2")
        self.assertEqual(rc, 0, out)
        # kernel.md 8 行：小文件整读且无索引（原有负向断言保留）
        seg = out.split("【成本】")[0]
        self.assertIn("kernel.md", seg)
        kernel_block = seg.split("kernel.md", 1)[1].split("\n  ", 1)[0]
        self.assertNotIn("章节:", kernel_block)
        # mid.md ~90 行：默认 120 阈值下同样无索引
        self.assertIn("rules/mid.md", out)
        mid_block = self.block_of(out, "rules/mid.md")
        self.assertNotIn("章节:", mid_block)
        cur = json.loads(self.plan.read_text(encoding="utf-8"))
        cur["index_min_lines"] = 50
        self.plan.write_text(json.dumps(cur), encoding="utf-8")
        try:
            rc, out = self.run_tool("preflight", "--level", "2")
            self.assertEqual(rc, 0, out)
            mid_block = self.block_of(out, "rules/mid.md")
            self.assertIn("章节:", mid_block)   # 90 行 > 50 → 必须出
            self.assertIn("中节一", mid_block)
        finally:
            cur["index_min_lines"] = 120
            self.plan.write_text(json.dumps(cur), encoding="utf-8")

    def test_preflight_stage_override_changes_scope(self):
        """--stage 覆盖阶段集：去掉映射阶段 → 该文件回退整文件。"""
        rc, out = self.run_tool("preflight", "--stage", "S1")
        self.assertEqual(rc, 0, out)
        self.assertIn("阶段: S1", out)
        self.assertIn("命中", out)
        rc, out = self.run_tool("preflight", "--stage", "S8")
        self.assertEqual(rc, 0, out)
        # rules/intent.md 未映射 S8 → 整文件
        block = out.split("rules/intent.md", 1)[1].split("\n  ", 1)[0]
        self.assertIn("整文件", block)

    def test_preflight_failsafe_when_stage_pattern_stale(self):
        """映射失效（子串命中不到任何章节）→ 回退整文件，不静默漏读。"""
        cur = json.loads(self.plan.read_text(encoding="utf-8"))
        cur["stage_sections"]["rules/intent.md"] = {"S1": ["该章节已改名不复存在"]}
        self.plan.write_text(json.dumps(cur), encoding="utf-8")
        try:
            rc, out = self.run_tool("preflight", "--level", "2")
            self.assertEqual(rc, 0, out)
            block = out.split("rules/intent.md", 1)[1].split("\n  ", 1)[0]
            self.assertIn("整文件", block)
        finally:
            cur["stage_sections"]["rules/intent.md"] = {"S1": ["A 节"]}
            self.plan.write_text(json.dumps(cur), encoding="utf-8")

    def test_preflight_fails_closed_when_plan_missing(self):
        self.plan.rename(self.root / "load_plan.json.bak")
        try:
            rc, out = self.run_tool("preflight", "--level", "2")
            self.assertEqual(rc, 3, out)
            # 码义单一：plan 文件缺失用 LOAD_PLAN 族；RULE_STORE_MISSING 专指 skill:* 条目不可用
            self.assertIn("LOAD_PLAN_MISSING", out)
            self.assertNotIn("RULE_STORE_MISSING", out)
            self.assertIn("[next]", out, "错误码必须携带下一步动作")
        finally:
            (self.root / "load_plan.json.bak").rename(self.plan)

    def test_preflight_fails_closed_when_rule_store_empty(self):
        """DB 存在但 skill:rules/* 为 0 时必须 fail-closed（不得用骨架摘要继续）。"""
        con = sqlite3.connect(self.db)
        con.execute("DELETE FROM memory WHERE key LIKE 'skill:rules/%'")
        con.commit()
        con.close()
        rc, out = self.run_tool("preflight", "--level", "2")
        self.assertEqual(rc, 3, out)
        self.assertIn("RULE_STORE_MISSING", out)
        self.assertIn("[next]", out)
        # --files 是显式应急清单，仍允许执行（不属于静默降级）
        rc, out = self.run_tool("preflight", "--files", "kernel.md")
        self.assertEqual(rc, 0, out)

    def test_preflight_files_bypasses_missing_plan(self):
        """--files 显式清单不依赖 load_plan.json（fail-closed 的唯一恢复路径，曾失效）。"""
        self.plan.rename(self.root / "load_plan.json.bak")
        try:
            rc, out = self.run_tool("preflight", "--files", "kernel.md,rules/intent.md")
            self.assertEqual(rc, 0, out)
            self.assertIn("--files 显式指定", out)
            self.assertIn("kernel.md", out)
        finally:
            (self.root / "load_plan.json.bak").rename(self.plan)

    def test_preflight_fails_closed_when_listed_file_absent(self):
        rc, out = self.run_tool("preflight", "--files", "kernel.md,rules/nope.md")
        self.assertEqual(rc, 3, out)
        self.assertIn("RULE_NOT_FOUND", out)

    # ---------- 审查回修（独立 Critic FAIL 后照单修复的回归防线） ----------

    def block_of(self, out, name):
        """取清单中某文件的块（到下一条目为止；6 空格缩进的 digest/章节行属于本块）。"""
        return re.split(r"\n  (?=\S)", out.split(name, 1)[1], 1)[0]

    def test_preflight_stage_validation_rejects_bad_tokens(self):
        """--stage 校验 S1–S13：S99/S08/8/混用 → [INVALID_ARGUMENT] exit 3（fail closed）。
        曾静默把 transition.md 机械分支砍到只剩 VC 节（86% 裁剪无提示，审查 P1）。"""
        for bad in ("S99", "S08", "8", "S1,^S3", "^S3,S8"):
            rc, out = self.run_tool("preflight", "--stage", bad)
            self.assertEqual(3, rc, f"{bad!r} 应被拒绝: {out}")
            self.assertIn("[INVALID_ARGUMENT]", out)
            self.assertIn("[next]", out)
        for good in ("S1", "S13"):  # 边界合法值不误拒（S13 = 收尾义务）
            rc, out = self.run_tool("preflight", "--stage", good)
            self.assertEqual(0, rc, out)

    def test_preflight_stage_exclude_syntax(self):
        """^S<n> 排除语法：从默认集排除而非手抄全清单（手抄漏 S13 = 静默裁掉收尾义务，审查 P1）。"""
        rc, out = self.run_tool("preflight", "--level", "2", "--stage", "^S1")
        self.assertEqual(rc, 0, out)
        self.assertIn("阶段: S8 S13", out)                       # [S1,S8,S13] − S1，S13 保留
        self.assertIn("排除", out)
        rc, out = self.run_tool("preflight", "--level", "2", "--stage", "^S1,^S8,^S13")
        self.assertEqual(3, rc, out)                              # 排空 = 拒绝
        rc, out = self.run_tool("preflight", "--level", "5", "--stage", "^S3")
        self.assertEqual(3, rc, out)   # level 5 无 stage 集可用 ^ = 拒绝

    def test_preflight_stage_inclusion_lists_dropped_defaults(self):
        """列举法收窄必须显式提示被裁掉的默认阶段（含 S13 时点名收尾义务）。"""
        rc, out = self.run_tool("preflight", "--level", "2", "--stage", "S1")
        self.assertEqual(rc, 0, out)
        self.assertIn("收窄", out)
        self.assertIn("S13", out.split("阶段:")[1])               # 被裁默认集须点名

    def test_preflight_index_truncation_reports_output_limit(self):
        """索引超长截断必须显式报 [OUTPUT_LIMIT]（与命中节分支一致；审查 P1）。"""
        rc, out = self.run_tool("preflight", "--level", "2")
        self.assertEqual(rc, 0, out)
        block = self.block_of(out, "references/longidx.md")
        self.assertIn("[OUTPUT_LIMIT] 章节标题超长已截断", block)

    def test_preflight_l0_stage10_loads_doc_constraint_subset(self):
        """回归（审查 P0）：L0 阶段集含 S10 且 S10 映射命中 §5 容器节——
        「Level 0 文档修改约束子集」曾因只挂 S3（L0 不跑）而整轮漏载。"""
        rc, out = self.run_tool("preflight", "--level", "0")
        self.assertEqual(rc, 0, out)
        self.assertIn("阶段: S1 S2 S4 S8 S10 S13", out)
        block = self.block_of(out, "policy/safety.md")
        self.assertIn("命中", block)
        self.assertIn("S10→L", block)

    def test_preflight_files_mode_stage_line_not_misattributed(self):
        """--files 模式的「未指定阶段」行不得归因 level_stages 缺配置（审查 P2）。"""
        rc, out = self.run_tool("preflight", "--files", "kernel.md")
        self.assertEqual(rc, 0, out)
        self.assertIn("--files 模式无加载计划", out)
        self.assertNotIn("在 level_stages 无配置", out)
        # 第五轮 P2：#51 曾声称已如实，实际仍打印「按阶段裁剪」；且 --files+--stage 对
        # engine/transition.md 是**真裁剪**（机械分支不依赖 plan）→ 表头须披露混合模式
        rc, out = self.run_tool("preflight", "--files", "kernel.md", "--stage", "S8")
        self.assertEqual(rc, 0, out)
        head = out.splitlines()[2]
        self.assertIn("仅 engine/transition.md", head)
        self.assertNotIn("按阶段裁剪章节", head)

    def test_select_sections_transition_only_vc_falls_back_to_whole(self):
        """transition.md 机械分支 fail-safe：仅命中 VC 节（无 S<n> 对上）→ 回退整文件，
        不拿 34 行码表切片冒充该文件可用内容（审查 P1）。"""
        mod = load_real_tool()
        secs = [
            ("S1 Intent → S2 Preflight", 14, 28, 15),
            ("VC 错误码族（结构化自纠信号）", 205, 238, 34),
        ]
        pairs, mode = mod.select_sections("engine/transition.md", secs, {}, ["S99"])
        self.assertEqual(mode, "whole")
        self.assertEqual([], pairs)
        pairs, mode = mod.select_sections("engine/transition.md", secs, {}, ["S1"])
        self.assertEqual(mode, "partial")
        self.assertEqual(["S1", "all"], [st for st, _ in pairs])  # 阶段节 + VC 恒含
        # always_whole 优先于一切（R0：kernel.md 永不裁剪）
        pairs, mode = mod.select_sections(
            "engine/transition.md", secs, {"always_whole": ["engine/transition.md"]}, ["S1"]
        )
        self.assertEqual(mode, "whole")

    def test_read_text_cache_is_per_run_memo(self):
        """读盘合一（第六轮 #70）：同一路径重复读返回**同一对象**（未重复读盘）；
        清缓存后才重新读。防「每调用清缓存」导致 4 次读盘 / TOCTOU 回归。"""
        mod = load_real_tool()
        path = TOOL_SRC.resolve().parent.parent / "kernel.md"
        mod._READ_CACHE.clear()
        a = mod._read_text_cached(path)
        self.assertIsNotNone(a)
        self.assertIs(a, mod._read_text_cached(path))      # 命中缓存 → 同一对象
        mod._READ_CACHE.clear()
        self.assertIsNot(a, mod._read_text_cached(path))   # 清后重读 → 新对象

    def test_real_plan_stage_membership_and_matrix(self):
        """真实产物的**阶段归属**断言（审查 P1：变异测试证明删 level_stages[0].S10 或
        safety.md 的 S10→§5 时原有用例与 smoke-check 全绿 → P0 无防线）。"""
        root = TOOL_SRC.resolve().parent.parent
        plan = json.loads((root / "load_plan.json").read_text(encoding="utf-8"))
        ls = plan["level_stages"]
        self.assertEqual(
            set(k for k in ls if not k.startswith("_")),
            set(k for k in plan["levels"] if not k.startswith("_")),
            "level_stages 与 levels 键集必须一致（否则该 Level 会静默退回全整文件，审查 M7）",
        )
        for lvl in ("0", "0-doc", "1", "2", "3", "4"):
            self.assertIn("S13", ls[lvl], f"level {lvl} 缺 S13（收尾义务）")
        # 值域：S1–S13 规范 token、非空、无重复（第五轮 P1：双副本同错可全绿）
        import re as _re
        _ok = _re.compile(r"^S([1-9]|1[0-3])$")
        for lvl, val in ls.items():
            if lvl.startswith("_"):
                continue
            self.assertIsInstance(val, list, f"level_stages[{lvl}] 必须是列表")
            self.assertTrue(val, f"level_stages[{lvl}] 不得为空")
            for tok in val:
                self.assertRegex(tok, _ok, f"level_stages[{lvl}] 含非法 token {tok!r}")
            self.assertEqual(len(set(val)), len(val), f"level_stages[{lvl}] 含重复")
        # 人类矩阵必须覆盖机器副本用到的每个阶段（防「机器副本里有、矩阵不知道」的漂移）
        gate_src = (root / "engine/complexity-gate.md").read_text(encoding="utf-8")
        matrix_stages = set(_re.findall(r"(?m)^\| (S\d+) ", gate_src))
        used = {tok for lvl, val in ls.items() if not lvl.startswith("_") for tok in val}
        self.assertTrue(used <= matrix_stages, f"矩阵缺阶段行: {sorted(used - matrix_stages)}")
        for lvl in ("0", "0-doc"):
            self.assertIn("S10", ls[lvl], f"level {lvl} 缺 S10（内联文档子集检查）")
        self.assertIn(
            "5. 子 agent 首步加载包",
            plan["stage_sections"]["policy/safety.md"]["S10"],
            "S10 必须载入 safety §5（内含「Level 0 文档修改约束子集」）",
        )
        # 三副本：manifest.complexity.levels.stages 必须与 level_stages 逐 Level 等价（0–4）
        if yaml is None:
            self.skipTest("pyyaml 缺失：跳过三副本对账断言")
        manifest = yaml.safe_load((root / "manifest.yaml").read_text(encoding="utf-8"))
        for row in manifest["complexity"]["levels"]:
            self.assertEqual(
                sorted(ls[str(row["level"])]), sorted(row["stages"]),
                f"manifest L{row['level']} 与 load_plan.level_stages 不等价",
            )
        # 矩阵：S13 行存在；S10 行的 L0 列声明「内联文档子集」
        gate = (root / "engine/complexity-gate.md").read_text(encoding="utf-8")
        self.assertRegex(gate, r"(?m)^\| S13 Complete \|", "矩阵缺 S13 行")
        s10 = next(l for l in gate.splitlines() if l.startswith("| S10 Review |"))
        self.assertIn("内联文档子集", s10.split("|")[2], "矩阵 S10 的 L0 列未声明内联文档子集")

    def test_real_plan_stage_payload_and_profile_coverage(self):
        """阶段载荷 + per-level 文件清单 + profile 装配的覆盖断言（第三轮 R3-D1/D2/D3）。

        变异测试证明：删 S8 的 safety §1、删某 Level 的必需文件、删 always_whole、
        删 profile 的一行 Required —— 原有用例与 smoke-check **全绿**（无防线）。本用例补防。
        """
        root = TOOL_SRC.resolve().parent.parent
        plan = json.loads((root / "load_plan.json").read_text(encoding="utf-8"))

        # ① R0 宪法层永不裁剪
        self.assertEqual(
            ["kernel.md"], plan.get("always_whole"),
            "always_whole 必须只含 kernel.md（R0 不按节裁剪）",
        )
        self.assertIn("kernel.md", plan.get("core", []), "core 缺 kernel.md")

        # ② 阶段载荷：R1 不可逆清单必须在代码/审查阶段（R3-D1）
        safety = plan["stage_sections"]["policy/safety.md"]
        for stage in ("S8", "S10"):
            self.assertIn(
                "1. 不可逆操作清单", safety[stage],
                f"{stage} 必须载入 safety §1（不可逆操作清单）",
            )
        for section in ("3. 约束分级", "4. 归档注释格式", "5. 子 agent 首步加载包"):
            self.assertIn(section, safety["S8"], f"S8 缺 safety「{section}」")
        for section in ("3. 约束分级", "5. 子 agent 首步加载包", "6. 子 agent 安全责任"):
            self.assertIn(section, safety["S10"], f"S10 缺 safety「{section}」")
        confidence = plan["stage_sections"]["policy/confidence.md"]
        for stage in ("S8", "S10"):
            for section in ("Confidence 三档", "Evidence 五级"):
                self.assertIn(
                    section, confidence[stage],
                    f"{stage} 缺 confidence「{section}」",
                )

        # ③ per-level 文件清单：SKILL.md「分级加载」下限（R3-D2）
        common = (
            "policy/safety.md", "policy/confidence.md",
            "learning/memory/lifecycle.md", "learning/memory/retrieval.md",
            "learning/skill-metrics.md",
        )

        def required_for(level_key):
            n = 0 if level_key.startswith("0") else int(level_key)
            req = list(common)
            if n >= 1:
                req += ["rules/test.md", "rules/review.md"]
            if n >= 2:
                req += ["rules/design.md", "rules/plan.md", "learning/memory/promotion.md"]
            if n >= 3:
                req += ["rules/orchestration.md", "learning/evolution.md"]
            return req

        for level_key, files in plan["levels"].items():
            if level_key.startswith("_"):
                continue
            for need in required_for(level_key):
                self.assertIn(
                    need, files,
                    f"levels[{level_key}] 缺分级加载下限文件 {need}",
                )

        # ④ profile Required 覆盖 S2/S12/S13 强制文件（R3-D3；planning 不承担 S8–S13）
        for path in sorted((root / "profiles").glob("*.md")):
            text = path.read_text(encoding="utf-8")
            self.assertIn("Required:", text, f"{path.name} 无 Required 段")
            required = text.split("Required:", 1)[1].split("Optional:", 1)[0]
            self.assertIn(
                "learning/memory/retrieval.md", required,
                f"{path.name} 的 Required 缺 retrieval.md（S2 强制召回）",
            )
            if path.name != "planning.md":
                for need in ("learning/memory/lifecycle.md", "learning/skill-metrics.md"):
                    self.assertIn(
                        need, required,
                        f"{path.name} 的 Required 缺 {need}（S13 收尾义务）",
                    )

        # ⑤ kernel §5 必须登记「硬约束违规」强制触发（R3-D6）
        kernel_text = (root / "kernel.md").read_text(encoding="utf-8")
        section5 = kernel_text.split("## 5. SAFE MODE", 1)[1].split("### SAFE MODE 行为", 1)[0]
        self.assertIn("硬约束违规", section5, "kernel §5 缺「硬约束违规」触发行")

    def test_level_validation_rejects_unknown(self):
        """--level 与 --stage 同策略 fail closed（审查 P1：拼错 level 曾静默关闭全部裁剪 exit 0）。"""
        # _note：level_stages 的元键曾被当合法 level（逐字符成阶段集 → 只载 core 3 文件、exit 0）
        for bad in ("5", "9", "banana", "-1", "_note", ""):
            rc, out = self.run_tool("preflight", "--level", bad)
            self.assertEqual(3, rc, f"--level {bad!r} 应被拒绝: {out}")
            self.assertIn("[INVALID_ARGUMENT]", out)
        for good in ("0", "2"):
            rc, out = self.run_tool("preflight", "--level", good)
            self.assertEqual(0, rc, out)
        for blank in ("", " "):
            rc, out = self.run_tool("preflight", "--level", "2", "--stage", blank)
            self.assertEqual(3, rc, f"--stage {blank!r} 应与 `--stage ,` 同口径: {out}")
            self.assertIn("[INVALID_ARGUMENT]", out)

    def test_partial_pattern_miss_falls_back_to_whole(self):
        """逐子串 fail-safe（审查 P1）：某阶段**部分**子串未命中 → 整个文件回退整数读，
        不再静默丢节（原实现仅在全部子串未命中时回退）。"""
        cur = json.loads(self.plan.read_text(encoding="utf-8"))
        cur["stage_sections"]["rules/intent.md"] = {"S1": ["A 节", "已改名不存在的节"]}
        self.plan.write_text(json.dumps(cur), encoding="utf-8")
        try:
            rc, out = self.run_tool("preflight", "--level", "2")
            self.assertEqual(rc, 0, out)
            block = self.block_of(out, "rules/intent.md")
            self.assertIn("整文件", block)
        finally:
            cur["stage_sections"]["rules/intent.md"] = {"S1": ["A 节"]}
            self.plan.write_text(json.dumps(cur), encoding="utf-8")

    def test_preflight_task_validation(self):
        """--task 校验（第五轮 P1）：拼错会静默丢掉 profile 文件集且 exit 0，故须 fail closed。"""
        for bad in ("debuging", "nonsense", "coding,typo"):
            rc, out = self.run_tool("preflight", "--level", "2", "--task", bad)
            self.assertEqual(3, rc, f"--task {bad!r} 应被拒绝: {out}")
            self.assertIn("[INVALID_ARGUMENT]", out)
            self.assertIn("[next]", out)
        for good in ("coding", "coding,debugging", ""):
            rc, out = self.run_tool("preflight", "--level", "2", "--task", good)
            self.assertEqual(0, rc, out)

    def test_preflight_preamble_note_only_when_meaningful(self):
        """前言提示仅在「首个 H2 之前存在实质行」时出现（审查 P2：原判定被 frontmatter 计入而恒真）。"""
        rc, out = self.run_tool("preflight", "--level", "2")
        self.assertEqual(rc, 0, out)
        notes = [l for l in out.splitlines() if "前言" in l]
        self.assertEqual(len(notes), 1, out)
        self.assertIn("rules/intent.md", notes[0])        # 唯一「partial 且含实质前言」的文件
        self.assertNotIn("rules/mid.md", notes[0])        # 有前言但走整文件模式 → 不需提示
        self.assertNotIn("references/big.md", notes[0])
        rc, out0 = self.run_tool("preflight", "--level", "0")
        self.assertEqual(rc, 0, out0)
        self.assertNotIn("前言", out0)                    # partial 但 H1 后直接 H2（无实质前言）→ 不提示

    def test_real_plan_section_coverage_and_whitelist(self):
        """机械覆盖度判定（随 SELFTEST 每次 smoke-check 运行）：真实计划中被映射文件的
        每个 H2 必须命中某阶段映射 or 显式进 _unmapped_ok 白名单；白名单条目失效同样报错
        ——审查 P0（L0 欠读）的长期防线：结构性新增/改名不再可能静默漏载。"""
        mod = load_real_tool()
        root = TOOL_SRC.resolve().parent.parent
        plan = json.loads((root / "load_plan.json").read_text(encoding="utf-8"))
        ss = {k: v for k, v in plan["stage_sections"].items() if not k.startswith("_")}
        ok = {k for k in plan.get("_unmapped_ok", {}) if not k.startswith("_")}
        problems = []
        for rel, smap in ss.items():
            titles = [s[0] for s in mod.read_sections(rel)]
            pats = [p for st, pats in smap.items() if not st.startswith("_") for p in pats]
            for h2 in titles:
                if not any(p in h2 for p in pats) and f"{rel} :: {h2}" not in ok:
                    problems.append(f"未映射且未白名单: {rel} :: {h2}")
        for key in ok:
            rel, _, h2 = key.partition(" :: ")
            if not any(h2 == s[0] for s in mod.read_sections(rel)):
                problems.append(f"白名单失效（标题已改名/删除）: {key}")
        self.assertFalse(problems, "\n".join(problems))

    # ---------- artifact ----------
    def _put(self, name, content, kind="text"):
        src = self.root / name
        src.write_text(content, encoding="utf-8")
        rc, out = self.run_tool("artifact", "put", "--file", src, "--name", name, "--kind", kind)
        self.assertEqual(rc, 0, out)
        for tok in out.split():
            if tok.startswith("ref="):
                return tok.split("=", 1)[1]
        self.fail(f"put 未返回 ref: {out}")

    def test_artifact_put_page_count_and_release(self):
        ref = self._put("log.txt", "\n".join(f"line{i}" for i in range(1, 51)))
        rc, out = self.run_tool("artifact", "page", "--ref", ref, "--count")
        self.assertEqual(rc, 0, out)
        self.assertIn("count = 50", out)
        rc, out = self.run_tool("artifact", "page", "--ref", ref, "--limit", "3")
        self.assertEqual(rc, 0, out)
        self.assertIn("line1", out)
        self.assertIn("[next] offset=3", out)
        rc, out = self.run_tool("artifact", "release", "--ref", ref)
        self.assertEqual(rc, 0, out)
        rc, out = self.run_tool("artifact", "page", "--ref", ref)
        self.assertEqual(rc, 4, out)
        self.assertIn("ARTIFACT_NOT_FOUND", out)

    def test_artifact_jsonl_projection_and_filter(self):
        rows = "\n".join(
            json.dumps({"file": f"f{i}.ts", "line": i, "state": "failed" if i % 2 else "passed"})
            for i in range(1, 11)
        )
        ref = self._put("r.jsonl", rows, kind="jsonl")
        rc, out = self.run_tool(
            "artifact", "page", "--ref", ref, "--equals", "state=failed", "--fields", "file,line"
        )
        self.assertEqual(rc, 0, out)
        self.assertIn("f1.ts", out)
        self.assertNotIn("state", out.split("返回")[-1], "--fields 应做投影，不保留未选字段")
        rc, out = self.run_tool("artifact", "page", "--ref", ref, "--equals", "state=failed", "--count")
        self.assertEqual(rc, 0, out)
        self.assertIn("count = 5", out)

    def test_artifact_page_reports_output_limit_not_silent_truncation(self):
        ref = self._put("big.txt", "\n".join("x" * 200 for _ in range(50)))
        rc, out = self.run_tool(
            "artifact", "page", "--ref", ref, "--limit", "50", "--max-bytes", "512"
        )
        self.assertEqual(rc, 0, out)
        self.assertIn("OUTPUT_LIMIT", out, "达字节上限必须显式报告，不得静默截断")

    def test_artifact_put_rejects_missing_source(self):
        rc, out = self.run_tool("artifact", "put", "--file", str(self.root / "nope.txt"))
        self.assertEqual(rc, 3, out)
        self.assertIn("ARTIFACT_SOURCE_MISSING", out)

    def test_artifact_put_rejects_traversal_name(self):
        """--name 路径穿越必须被中和：要么拒绝，要么消毒后落盘在产物目录内（禁止任意写）。"""
        escape_dir = self.root / "escape"
        rc, out = self.run_tool(
            "artifact", "put", "--file", self.root / "kernel.md",
            "--name", f"../../../../{escape_dir.name}/pwned.txt",
        )
        self.assertIn(rc, (0, 3), out)
        self.assertNotIn(f"{escape_dir.name}/pwned.txt", out.replace("escape-pwned.txt", ""))
        self.assertFalse(escape_dir.exists(), "路径穿越写必须被中和")

    def test_artifact_release_rejects_forged_index_ref(self):
        """index.json 是普通本地文件不是可信来源：伪造 ref 不得触发界外 rmtree。"""
        ref = self._put("ok2.txt", "content\n")
        victim = self.root / "victim"
        victim.mkdir()
        (victim / "secret.txt").write_text("keep", encoding="utf-8")
        forged = f"../../../../{victim}"
        idx = self.art / "index.json"
        d = json.loads(idx.read_text(encoding="utf-8"))
        d[forged] = {"ref": forged, "name": "x", "kind": "text", "loop": 0,
                     "source": "y", "bytes": 1, "lines": 1, "created_at": 1}  # created_at=1 → 必过期，prune 也会碰它
        idx.write_text(json.dumps(d), encoding="utf-8")
        rc, out = self.run_tool("artifact", "release", "--ref", forged)
        self.assertEqual(rc, 3, out)
        self.assertIn("ARTIFACT_REF_INVALID", out)
        self.assertTrue((victim / "secret.txt").exists(), "界外目录必须完好无损")
        # list 触发的 prune 同样不得删除界外目录
        self.run_tool("artifact", "list")
        self.assertTrue((victim / "secret.txt").exists(), "prune 路径同样必须拒绝非法 ref")

    def test_artifact_page_rejects_negative_and_reports_clamp(self):
        ref = self._put("clamp.txt", "\n".join(f"L{i}" for i in range(1, 21)) + "\n")
        rc, out = self.run_tool("artifact", "page", "--ref", ref, "--limit", "-5")
        self.assertEqual(rc, 3, out)
        self.assertIn("INVALID_ARGUMENT", out)
        rc, out = self.run_tool("artifact", "page", "--ref", ref, "--limit", "1000000")
        self.assertEqual(rc, 0, out)
        self.assertIn("OUTPUT_LIMIT", out, "超上限 clamp 必须显式报告，不得静默")

    # ---------- check-keys ----------
    def test_check_keys_detects_missing_and_ttl_violation(self):
        keys = self.root / "keys.txt"
        keys.write_text(
            "skill:rules/intent:goal-triple\tC\n"
            "skill:data:with-ttl\tC\n"
            "skill:absent\tC\n",
            encoding="utf-8",
        )
        rc, out = self.run_tool("check-keys", "--files", keys)
        self.assertEqual(rc, 4, out)
        self.assertIn("MISSING\tskill:absent", out)
        self.assertIn("NOT_PERMANENT\tskill:data:with-ttl", out)

    def test_check_keys_exempts_data_entries_from_ttl_invariant(self):
        keys = self.root / "keys2.txt"
        keys.write_text("skill:data:with-ttl\t数据\n", encoding="utf-8")
        rc, out = self.run_tool("check-keys", "--files", keys)
        self.assertEqual(rc, 0, out)

if __name__ == "__main__":
    unittest.main(verbosity=2)
