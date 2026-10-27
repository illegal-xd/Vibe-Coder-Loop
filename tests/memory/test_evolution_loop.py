"""P1 经验进化闭环测试：自主反思 / 记忆效用观测 / Skill 草稿生成。

覆盖任务书第八节 A/B/C 三类场景。所有测试使用临时 SQLite，不触碰真实库。
运行：python3 -m unittest tests.memory.test_evolution_loop -v
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "memory"))

import evolution_store as S  # noqa: E402
import memory_feedback  # noqa: E402
import memops  # noqa: E402
import migrate  # noqa: E402
import reflection_signals  # noqa: E402
import skill_draft  # noqa: E402

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
        conn.commit()
        conn.close()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def seed(
        self,
        key: str,
        value: str,
        *,
        layer: str | None = "L3",
        category: str = "knowledge",
        tags: tuple[str, ...] = (),
        meta: dict | None = None,
    ) -> None:
        metadata = {
            "layer": layer,
            "memory_category": category,
            "scope": "project",
            "status": "active",
            "review_status": "approved",
            "evidence_ids": ["anchor:seed"],
        }
        metadata.update(meta or {})
        tag_list = list(tags) + ([f"layer:{layer}"] if layer else [])
        conn = sqlite3.connect(str(self.db))
        conn.execute(
            "INSERT OR REPLACE INTO memory VALUES (?,?,?,?,?,?,?)",
            (
                key,
                jstr(value),
                TS,
                TS,
                None,
                f",{','.join(tag_list)}," if tag_list else "",
                json.dumps(metadata, ensure_ascii=False),
            ),
        )
        conn.commit()
        conn.close()

    def row(self, key: str) -> sqlite3.Row | None:
        conn = sqlite3.connect(str(self.db))
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM memory WHERE key=?", (key,)).fetchone()
        conn.close()
        return row

    def fingerprint(self) -> str:
        conn = sqlite3.connect(str(self.db))
        rows = conn.execute(
            "SELECT key,value,tags,metadata,created_at,updated_at,ttl_expires_at FROM memory ORDER BY key"
        ).fetchall()
        conn.close()
        payload = json.dumps([tuple(r) for r in rows], ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# A. 自主反思
# ---------------------------------------------------------------------------
class ReflectionSignalTests(Base):
    def test_no_signals_skips(self) -> None:
        report = reflection_signals.evaluate(self.db, task_id="task:none")
        self.assertEqual(report["decision"], "skip")
        self.assertFalse(report["promotion_authorized"])
        self.assertEqual(report["groups"], [])

    def test_user_correction_triggers(self) -> None:
        reflection_signals.record_signal(
            self.db,
            task_id="task:a",
            signal_type="user_correction",
            fingerprint="intent-misunderstanding:checkout",
            source="user",
            evidence_ids=["anchor:user-correction"],
            summary="用户否定了方案",
        )
        report = reflection_signals.evaluate(self.db, task_id="task:a")
        self.assertEqual(report["decision"], "reflect")
        self.assertEqual(report["groups"][0]["classification"], "new_experience")
        self.assertFalse(report["promotion_authorized"])

    def test_repeated_failure_aggregates_across_tasks(self) -> None:
        for task in ("task:a", "task:b"):
            reflection_signals.record_signal(
                self.db,
                task_id=task,
                signal_type="repeated_failure",
                fingerprint="boundary-missing:checkout",
                source="test",
                evidence_ids=[f"anchor:{task}"],
                summary="同类边界失败",
            )
        report = reflection_signals.evaluate(self.db, task_id="task:b")
        self.assertEqual(report["decision"], "reflect")
        self.assertEqual(len(report["groups"]), 1)
        group = report["groups"][0]
        self.assertEqual(group["occurrences"], 2)
        self.assertEqual(group["distinct_tasks"], 2)
        self.assertEqual(group["action"], "create")

    def test_same_task_duplicate_signal_is_one_group(self) -> None:
        for _ in range(3):
            reflection_signals.record_signal(
                self.db,
                task_id="task:a",
                signal_type="repeated_failure",
                fingerprint="boundary-missing:checkout",
                source="test",
                evidence_ids=["anchor:same"],
                summary="同一事件重复上报",
            )
        report = reflection_signals.evaluate(self.db, task_id="task:a")
        self.assertEqual(len(report["groups"]), 1)
        self.assertEqual(report["groups"][0]["occurrences"], 1)
        self.assertEqual(report["decision"], "skip")

    def test_same_task_distinct_rounds_aggregate(self) -> None:
        for token in ("round-1", "round-2"):
            reflection_signals.record_signal(
                self.db,
                task_id="task:a",
                signal_type="repeated_failure",
                fingerprint="boundary-missing:checkout",
                source="test",
                evidence_ids=[f"anchor:{token}"],
                summary=f"第 {token} 轮失败",
                dedupe_token=token,
            )
        report = reflection_signals.evaluate(self.db, task_id="task:a")
        self.assertEqual(report["decision"], "reflect")
        self.assertEqual(len(report["groups"]), 1)
        self.assertEqual(report["groups"][0]["occurrences"], 2)
        self.assertEqual(report["groups"][0]["distinct_tasks"], 1)

    def test_existing_lesson_used_but_failed(self) -> None:
        self.seed(
            "lesson:checkout-boundary",
            "# 结账边界\n\n- 提交前校验边界",
            layer="L3",
        )
        memory_feedback.record_feedback(
            self.db,
            task_id="task:a",
            retrieved=["lesson:checkout-boundary"],
            used=["lesson:checkout-boundary"],
            not_used=[],
            outcome="failure",
            attribution="partial",
            confidence="medium",
            evidence_ids=["anchor:commit"],
        )
        reflection_signals.record_signal(
            self.db,
            task_id="task:a",
            signal_type="verification_failure",
            fingerprint="boundary-missing:checkout-boundary",
            source="test",
            evidence_ids=["anchor:test"],
            summary="边界测试失败",
        )
        report = reflection_signals.evaluate(self.db, task_id="task:a")
        self.assertEqual(report["decision"], "reflect")
        group = report["groups"][0]
        self.assertEqual(group["classification"], "lesson_ineffective")
        self.assertEqual(group["action"], "conflict_check")
        self.assertIn("lesson:checkout-boundary", group["related_memories"])

    def test_stale_lesson_triggers_conflict_check(self) -> None:
        self.seed(
            "lesson:old-checkout-boundary",
            "# 旧结账边界\n\n已废弃：旧接口不再适用。",
            layer="L3",
        )
        reflection_signals.record_signal(
            self.db,
            task_id="task:a",
            signal_type="verification_failure",
            fingerprint="boundary-missing:old-checkout-boundary",
            source="test",
            evidence_ids=["anchor:test"],
            summary="旧经验失效",
        )
        report = reflection_signals.evaluate(self.db, task_id="task:a")
        self.assertEqual(report["decision"], "reflect")
        self.assertEqual(report["groups"][0]["classification"], "lesson_stale")
        self.assertEqual(report["groups"][0]["action"], "correct")

    def test_unverified_signal_does_not_pollute_confirmed_group(self) -> None:
        for task in ("task:a", "task:b"):
            reflection_signals.record_signal(
                self.db,
                task_id=task,
                signal_type="repeated_failure",
                fingerprint="boundary-missing:checkout",
                source="test",
                evidence_ids=[f"anchor:{task}"],
                summary="已确认失败",
            )
        reflection_signals.record_signal(
            self.db,
            task_id="task:a",
            signal_type="repeated_failure",
            fingerprint="boundary-missing:checkout",
            source="tool",
            evidence_ids=[],
            summary="猜测",
            verified=False,
            dedupe_token="guess",
        )
        report = reflection_signals.evaluate(self.db, task_id="task:b")
        group = report["groups"][0]
        self.assertEqual(report["decision"], "reflect")
        self.assertEqual(group["occurrences"], 2)
        self.assertEqual(group["unverified_signals"], 1)

    def test_unverified_signal_is_not_promoted(self) -> None:
        reflection_signals.record_signal(
            self.db,
            task_id="task:a",
            signal_type="verification_failure",
            fingerprint="guess:checkout",
            source="tool",
            evidence_ids=[],
            summary="模型猜测",
            verified=False,
        )
        report = reflection_signals.evaluate(self.db, task_id="task:a")
        self.assertEqual(report["decision"], "insufficient")
        self.assertEqual(report["groups"][0]["classification"], "insufficient_evidence")
        self.assertFalse(report["promotion_authorized"])

    def test_verified_signal_requires_evidence(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            rc = reflection_signals.main(
                [
                    "record",
                    "--db",
                    str(self.db),
                    "--task-id",
                    "task:a",
                    "--type",
                    "user_correction",
                    "--source",
                    "user",
                    "--fingerprint",
                    "x:y",
                ]
            )
        self.assertEqual(rc, 2)
        self.assertEqual(S.list_entries(self.db, S.SIGNAL_PREFIX), [])

    def test_evaluate_requires_task_id(self) -> None:
        """CLI 缺 --task-id 必须报参数错误；静默 skip 会被误读为「无需反思」。"""
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as ctx:
                reflection_signals.main(["evaluate", "--db", str(self.db)])
        self.assertEqual(ctx.exception.code, 2)

    def test_missing_db_degrades_without_blocking(self) -> None:
        report = reflection_signals.evaluate(self.dir / "missing.sqlite", task_id="task:a")
        self.assertEqual(report["decision"], "unavailable")
        self.assertTrue(report["degraded"])
        self.assertFalse(report["promotion_authorized"])

    def test_signal_record_is_state_not_knowledge(self) -> None:
        reflection_signals.record_signal(
            self.db,
            task_id="task:a",
            signal_type="high_cost_rework",
            fingerprint="architecture-conflict:checkout",
            source="review",
            evidence_ids=["anchor:review"],
            summary="结构性回退",
        )
        entry = S.fetch_entry(self.db, S.list_entries(self.db, S.SIGNAL_PREFIX)[0]["key"])
        assert entry is not None
        self.assertIsNone(entry["metadata"]["layer"])
        self.assertEqual(entry["metadata"]["memory_category"], "state")
        self.assertIn("reflection-signal", entry["tags"])
        self.assertIsNotNone(entry["ttl_expires_at"])


# ---------------------------------------------------------------------------
# B. 记忆效用观测
# ---------------------------------------------------------------------------
class MemoryFeedbackTests(Base):
    def setUp(self) -> None:
        super().setUp()
        self.seed(
            "lesson:checkout-boundary",
            "# 结账边界\n\n- 提交前校验边界",
            layer="L3",
        )

    def test_retrieval_use_and_outcome_are_independent(self) -> None:
        memory_feedback.record_feedback(
            self.db,
            task_id="task:a",
            retrieved=["lesson:checkout-boundary"],
            used=["lesson:checkout-boundary"],
            not_used=[],
            outcome="success",
            attribution="direct",
            confidence="high",
            evidence_ids=["anchor:diff"],
        )
        report = memory_feedback.build_report(self.db)
        item = report["memories"]["lesson:checkout-boundary"]
        self.assertEqual(item["tasks"], 1)
        self.assertEqual(item["retrieved"], 1)
        self.assertEqual(item["usage"]["used"], 1)
        self.assertEqual(item["outcomes"]["success"], 1)
        self.assertEqual(item["attribution"]["direct"], 1)
        self.assertEqual(item["confidence"]["high"], 1)
        self.assertNotIn("score", item)

    def test_unknown_outcome_stays_unknown(self) -> None:
        memory_feedback.record_feedback(
            self.db,
            task_id="task:a",
            retrieved=["lesson:checkout-boundary"],
            used=[],
            not_used=[],
            outcome="unknown",
            attribution="unknown",
            confidence="unknown",
            evidence_ids=[],
        )
        item = memory_feedback.build_report(self.db)["memories"]["lesson:checkout-boundary"]
        self.assertEqual(item["usage"]["unknown"], 1)
        self.assertEqual(item["outcomes"]["unknown"], 1)

    def test_failure_does_not_mark_memory_harmful(self) -> None:
        memory_feedback.record_feedback(
            self.db,
            task_id="task:a",
            retrieved=["lesson:checkout-boundary"],
            used=["lesson:checkout-boundary"],
            not_used=[],
            outcome="failure",
            attribution="partial",
            confidence="low",
            evidence_ids=["anchor:fail"],
        )
        item = memory_feedback.build_report(self.db)["memories"]["lesson:checkout-boundary"]
        self.assertEqual(item["outcomes"]["failure"], 1)
        self.assertNotIn("harmful", item)
        self.assertNotIn("score", item)

    def test_repeated_record_is_idempotent(self) -> None:
        for round_no in (1, 2):
            memory_feedback.record_feedback(
                self.db,
                task_id="task:a",
                retrieved=["lesson:checkout-boundary"],
                used=["lesson:checkout-boundary"],
                not_used=[],
                outcome="success",
                attribution="direct",
                confidence="high",
                evidence_ids=[f"anchor:round-{round_no}"],
            )
        report = memory_feedback.build_report(self.db)
        self.assertEqual(report["records"], 1)
        self.assertEqual(report["tasks"], 1)
        entry = S.fetch_entry(self.db, memory_feedback.feedback_key("task:a", "lesson:checkout-boundary"))
        assert entry is not None
        value = S.json_object(entry["value"])
        self.assertEqual(value["updates"], 2)

    def test_historical_memory_without_feedback_is_readable(self) -> None:
        report = memory_feedback.build_report(self.db)
        self.assertEqual(report["records"], 0)
        self.assertIsNotNone(S.fetch_entry(self.db, "lesson:checkout-boundary"))

    def test_original_memory_is_not_modified(self) -> None:
        before_row = self.row("lesson:checkout-boundary")
        assert before_row is not None
        before = tuple(before_row)
        memory_feedback.record_feedback(
            self.db,
            task_id="task:a",
            retrieved=["lesson:checkout-boundary"],
            used=["lesson:checkout-boundary"],
            not_used=[],
            outcome="success",
            attribution="direct",
            confidence="high",
            evidence_ids=["anchor:diff"],
        )
        after_row = self.row("lesson:checkout-boundary")
        assert after_row is not None
        self.assertEqual(before, tuple(after_row))

    def test_verify_detects_hash_drift_as_warning(self) -> None:
        memory_feedback.record_feedback(
            self.db,
            task_id="task:a",
            retrieved=["lesson:checkout-boundary"],
            used=["lesson:checkout-boundary"],
            not_used=[],
            outcome="success",
            attribution="direct",
            confidence="high",
            evidence_ids=["anchor:diff"],
        )
        conn = sqlite3.connect(str(self.db))
        conn.execute(
            "UPDATE memory SET value=? WHERE key=?",
            (jstr("# 结账边界\n\n- 内容已更新"), "lesson:checkout-boundary"),
        )
        conn.commit()
        conn.close()
        report = memory_feedback.verify_feedback(self.db)
        self.assertTrue(report["ok"])
        self.assertTrue(any("发生变化" in warning for warning in report["warnings"]))

    def test_verify_detects_invalid_enum(self) -> None:
        key = memory_feedback.feedback_key("task:x", "lesson:checkout-boundary")

        def build(_existing):
            return (
                {
                    "schema": "memory-feedback/v1",
                    "task_id": "task:x",
                    "memory_key": "lesson:checkout-boundary",
                    "usage": "bad",
                    "outcome": "unknown",
                    "attribution": "unknown",
                    "confidence": "unknown",
                    "evidence_ids": [],
                    "updates": 1,
                },
                {"layer": None, "memory_category": "state", "evidence_ids": []},
                ("memory-feedback",),
            )

        S.upsert_record(self.db, key, build=build, ttl_seconds=60)
        report = memory_feedback.verify_feedback(self.db)
        self.assertFalse(report["ok"])
        self.assertTrue(any("usage" in error for error in report["errors"]))

    def test_used_requires_evidence(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            rc = memory_feedback.main(
                [
                    "record",
                    "--db",
                    str(self.db),
                    "--task-id",
                    "task:a",
                    "--retrieved",
                    "lesson:checkout-boundary",
                    "--used",
                    "lesson:checkout-boundary",
                ]
            )
        self.assertEqual(rc, 2)
        self.assertEqual(S.list_entries(self.db, S.FEEDBACK_PREFIX), [])

    def test_used_must_be_subset_of_retrieved(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            rc = memory_feedback.main(
                [
                    "record",
                    "--db",
                    str(self.db),
                    "--task-id",
                    "task:a",
                    "--retrieved",
                    "lesson:checkout-boundary",
                    "--used",
                    "lesson:other",
                    "--evidence",
                    "anchor:x",
                ]
            )
        self.assertEqual(rc, 2)

    def test_empty_retrieval_is_noop(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            rc = memory_feedback.main(
                ["record", "--db", str(self.db), "--task-id", "task:a", "--retrieved", ""]
            )
        self.assertEqual(rc, 0)
        self.assertEqual(S.list_entries(self.db, S.FEEDBACK_PREFIX), [])


# ---------------------------------------------------------------------------
# C. Skill 草稿生成
# ---------------------------------------------------------------------------
class SkillDraftTests(Base):
    def seed_pattern(
        self,
        key: str = "pattern:async-state-race",
        *,
        recurrence: int = 3,
        refs: int = 3,
        projects: tuple[str, ...] = ("proj-a", "proj-b"),
        review_status: str = "approved",
        extra: str = "",
        evidence_ids: list[str] | None = None,
    ) -> None:
        value = (
            "# 异步状态竞态修复\n\n"
            "## 适用\n前端异步请求与状态更新交叉时\n\n"
            "## 步骤\n1. 定位状态写入点\n2. 校验请求代次\n3. 补 abort 测试\n\n"
            "## 验证\n- 连续切换筛选不出现旧响应覆盖新状态\n\n"
            "## 反例\n- 不要用 setTimeout 猜测时序\n"
            f"{extra}"
        )
        self.seed(
            key,
            value,
            layer="L5",
            tags=("pattern", "p_high"),
            meta={
                "scope": "global",
                "review_status": review_status,
                "recurrence_count": recurrence,
                "evidence_ids": evidence_ids
                or [f"memory:lesson:{i}" for i in range(refs)],
                "projects": list(projects),
            },
        )

    def test_generate_draft_with_required_sections(self) -> None:
        self.seed_pattern()
        out = self.dir / "drafts"
        report = skill_draft.generate(
            self.db, out_dir=out, skills_dir=ROOT / "skills", self_check_mode="auto"
        )
        self.assertEqual(report["candidates"][0]["status"], "drafted")
        skill_md = out / "async-state-race" / "SKILL.md"
        text = skill_md.read_text(encoding="utf-8")
        for section in skill_draft.REQUIRED_SECTIONS:
            self.assertIn(f"## {section}", text)
        self.assertIn('status: "draft"', text)
        self.assertIn("draft: true", text)
        self.assertIn('verification: "pending"', text)
        meta = json.loads((out / "async-state-race" / "draft.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["status"], "draft")
        self.assertEqual(meta["checks"]["self_check"], "pass")
        self.assertEqual(meta["revision"], 1)

    def test_insufficient_instances_deferred(self) -> None:
        self.seed_pattern(recurrence=2, refs=2)
        report = skill_draft.generate(
            self.db, out_dir=self.dir / "drafts", skills_dir=ROOT / "skills"
        )
        item = report["candidates"][0]
        self.assertEqual(item["status"], "deferred")
        self.assertIn("insufficient_instances", item["reasons"])
        self.assertFalse((self.dir / "drafts" / "async-state-race" / "SKILL.md").exists())

    def test_insufficient_task_evidence_deferred(self) -> None:
        self.seed_pattern(recurrence=5, refs=1)
        report = skill_draft.generate(
            self.db, out_dir=self.dir / "drafts", skills_dir=ROOT / "skills"
        )
        item = report["candidates"][0]
        self.assertEqual(item["status"], "deferred")
        self.assertIn("insufficient_task_evidence", item["reasons"])

    def test_existing_skill_overlap_generates_proposal(self) -> None:
        self.seed_pattern()
        skills = self.dir / "skills"
        target = skills / "async-state-race-helper"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text(
            "---\nname: async-state-race-helper\ndescription: 处理异步状态竞态\n---\n# helper\n",
            encoding="utf-8",
        )
        report = skill_draft.generate(
            self.db, out_dir=self.dir / "drafts", skills_dir=skills
        )
        item = report["candidates"][0]
        self.assertEqual(item["status"], "proposal")
        self.assertEqual(item["target_skill"], "async-state-race-helper")
        self.assertFalse((self.dir / "drafts" / "async-state-race" / "SKILL.md").exists())
        proposal = Path(item["paths"][0])
        self.assertTrue(proposal.exists())
        text = proposal.read_text(encoding="utf-8")
        self.assertIn('status: "proposal"', text)
        self.assertNotIn(str(self.dir), text)

    def test_bilingual_skill_overlap_generates_proposal(self) -> None:
        self.seed_pattern(
            key="pattern:memory-writeback-integrity",
            projects=("p1",),
        )
        skills = self.dir / "skills"
        target = skills / "vibe-coder-loop"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text(
            "---\nname: vibe-coder-loop\ndescription: 工程循环\n---\n"
            "# loop\n\n记忆消费回写与完整性。\n",
            encoding="utf-8",
        )
        report = skill_draft.generate(
            self.db, out_dir=self.dir / "drafts", skills_dir=skills
        )
        item = report["candidates"][0]
        self.assertEqual(item["status"], "proposal")
        self.assertEqual(item["target_skill"], "vibe-coder-loop")

    def test_rerun_updates_same_draft(self) -> None:
        self.seed_pattern()
        out = self.dir / "drafts"
        skill_draft.generate(self.db, out_dir=out, skills_dir=ROOT / "skills")
        report = skill_draft.generate(self.db, out_dir=out, skills_dir=ROOT / "skills")
        self.assertEqual(report["candidates"][0]["status"], "updated")
        self.assertEqual(report["candidates"][0]["revision"], 2)
        dirs = [p for p in out.iterdir() if p.is_dir()]
        self.assertEqual([p.name for p in dirs], ["async-state-race"])

    def test_manual_edits_are_preserved(self) -> None:
        self.seed_pattern()
        out = self.dir / "drafts"
        skill_draft.generate(self.db, out_dir=out, skills_dir=ROOT / "skills")
        skill_md = out / "async-state-race" / "SKILL.md"
        skill_md.write_text(skill_md.read_text(encoding="utf-8") + "\n人工补充\n", encoding="utf-8")
        report = skill_draft.generate(self.db, out_dir=out, skills_dir=ROOT / "skills")
        item = report["candidates"][0]
        self.assertEqual(item["status"], "manual_edits")
        self.assertIn("人工补充", skill_md.read_text(encoding="utf-8"))

    def test_self_check_failure_is_reported(self) -> None:
        self.seed_pattern()
        fake_core = self.dir / "fake-core.sh"
        fake_core.write_text("#!/usr/bin/env bash\necho forced failure\nexit 1\n", encoding="utf-8")
        old = os.environ.get("SKILL_DRAFT_SMOKE_CORE")
        os.environ["SKILL_DRAFT_SMOKE_CORE"] = str(fake_core)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                rc = skill_draft.main(
                    [
                        "generate",
                        "--db",
                        str(self.db),
                        "--out-dir",
                        str(self.dir / "drafts"),
                        "--skills-dir",
                        str(ROOT / "skills"),
                    ]
                )
        finally:
            if old is None:
                os.environ.pop("SKILL_DRAFT_SMOKE_CORE", None)
            else:
                os.environ["SKILL_DRAFT_SMOKE_CORE"] = old
        self.assertEqual(rc, 1)
        meta = json.loads(
            (self.dir / "drafts" / "async-state-race" / "draft.json").read_text(encoding="utf-8")
        )
        self.assertEqual(meta["verification"], "self-check-failed")
        self.assertEqual(meta["checks"]["self_check"], "fail")

    def test_table_fragment_is_flattened(self) -> None:
        text = "## 验证\n| 验证通过 | 自己重跑一次 |\n- 其他 |\n"
        picked = skill_draft._pick(text, ("验证",))
        self.assertNotIn("| 验证通过 |", picked)
        self.assertIn("- 验证通过 / 自己重跑一次", picked)

    def test_sanitize_redacts_home_paths_and_dates(self) -> None:
        sep = chr(92)
        raw = (
            "2026-10-27 "
            + "/" + "Users/alice/project "
            + "C:" + sep + "Users" + sep + "alice" + sep + "project"
        )
        cleaned = skill_draft.sanitize(raw)
        self.assertNotIn("2026-10-27", cleaned)
        self.assertNotIn("/" + "Users/", cleaned)
        self.assertNotIn("C:" + sep + "Users", cleaned)
        self.assertIn("[date]", cleaned)

    def test_refuses_to_write_into_formal_skill_dir(self) -> None:
        self.seed_pattern()
        skills = self.dir / "skills"
        formal = skills / "async-state-race"
        formal.mkdir(parents=True)
        marker = formal / "SKILL.md"
        marker.write_text("---\nname: async-state-race\n---\n# formal\n", encoding="utf-8")
        before = marker.read_text(encoding="utf-8")
        with self.assertRaises(ValueError):
            skill_draft.generate(self.db, out_dir=formal, skills_dir=skills)
        self.assertEqual(before, marker.read_text(encoding="utf-8"))

    def test_draft_is_not_routable_and_has_no_private_paths(self) -> None:
        self.seed_pattern()
        out = self.dir / "drafts"
        skill_draft.generate(self.db, out_dir=out, skills_dir=ROOT / "skills")
        skill_md = out / "async-state-race" / "SKILL.md"
        self.assertFalse(str(skill_md).startswith(str(ROOT / "skills")))
        text = skill_md.read_text(encoding="utf-8")
        self.assertNotIn("/Users/", text)
        self.assertNotIn("/home/", text)
        self.assertIn("status: \"draft\"", text)

    def test_evidence_dates_are_sanitized_in_body_but_kept_in_metadata(self) -> None:
        self.seed_pattern(
            evidence_ids=[
                "memory:lesson:a",
                "memory:lesson:b",
                "memory:archive:consolidation-2026-10-21#x",
            ]
        )
        out = self.dir / "drafts"
        skill_draft.generate(self.db, out_dir=out, skills_dir=ROOT / "skills")
        text = (out / "async-state-race" / "SKILL.md").read_text(encoding="utf-8")
        self.assertNotIn("2026-10-21", text)
        self.assertIn("[date]", text)
        meta = json.loads(
            (out / "async-state-race" / "draft.json").read_text(encoding="utf-8")
        )
        self.assertIn(
            "memory:archive:consolidation-2026-10-21#x", meta["evidence_ids"]
        )

    def test_index_file_has_no_private_absolute_paths(self) -> None:
        self.seed_pattern()
        out = self.dir / "drafts"
        skill_draft.generate(self.db, out_dir=out, skills_dir=ROOT / "skills")
        text = (out / "index.json").read_text(encoding="utf-8")
        self.assertNotIn(str(self.dir), text)
        self.assertNotIn("/Users/", text)
        data = json.loads(text)
        self.assertEqual(data["out_dir"], ".")
        self.assertEqual(data["db"], self.db.name)
        for item in data["candidates"]:
            for path in item.get("paths", []):
                self.assertFalse(Path(path).is_absolute())

    def test_generation_does_not_write_memory_or_promote_l6(self) -> None:
        self.seed_pattern()
        before = self.fingerprint()
        skill_draft.generate(
            self.db, out_dir=self.dir / "drafts", skills_dir=ROOT / "skills"
        )
        self.assertEqual(before, self.fingerprint())
        self.assertIsNone(S.fetch_entry(self.db, "skill:draft-async-state-race"))

    def test_dry_run_writes_nothing(self) -> None:
        self.seed_pattern()
        out = self.dir / "drafts"
        report = skill_draft.generate(
            self.db, out_dir=out, skills_dir=ROOT / "skills", dry_run=True
        )
        self.assertEqual(report["candidates"][0]["status"], "planned_create")
        self.assertFalse(out.exists())

    def test_no_patterns_is_noop(self) -> None:
        report = skill_draft.generate(
            self.db, out_dir=self.dir / "drafts", skills_dir=ROOT / "skills"
        )
        self.assertEqual(report["candidates"], [])


class LayerCompatibilityTests(Base):
    def test_signal_and_feedback_do_not_break_layer_validation(self) -> None:
        self.seed("lesson:checkout-boundary", "# 结账边界\n\n- 校验边界", layer="L3")
        reflection_signals.record_signal(
            self.db,
            task_id="task:a",
            signal_type="user_correction",
            fingerprint="intent-misunderstanding:checkout",
            source="user",
            evidence_ids=["anchor:user"],
            summary="用户纠正",
        )
        memory_feedback.record_feedback(
            self.db,
            task_id="task:a",
            retrieved=["lesson:checkout-boundary"],
            used=["lesson:checkout-boundary"],
            not_used=[],
            outcome="success",
            attribution="direct",
            confidence="high",
            evidence_ids=["anchor:diff"],
        )
        report = memops.validate_db(self.db)
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["totals"]["with_layer"], 1)
        self.assertNotIn("layer_missing", report["errors"])
        self.assertNotIn("invalid_category", report["errors"])

    def test_one_time_migration_skips_observation_records(self) -> None:
        meta = json.dumps({"layer": None, "memory_category": "state"})
        self.assertFalse(migrate._is_migration_target("signal:reflection:abc", meta))
        self.assertFalse(migrate._is_migration_target("feedback:memory:abc", meta))
        # 未分类的知识条目仍应进入迁移范围
        self.assertTrue(migrate._is_migration_target("lesson:new", meta))


if __name__ == "__main__":
    unittest.main()
