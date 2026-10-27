"""delx-memory 适配层单测（Checkpoint 的持久化后端）。"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from runtime.core.memory_store import (
    CHECKPOINT_QUARANTINE_PREFIX,
    CHECKPOINT_TAGS,
    MemoryStore,
    MemoryStoreError,
    checkpoint_key,
    normalize_tags,
    parse_tags,
)


class MemoryStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.db = self.root / "memory.sqlite"
        self.store = MemoryStore(self.db)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_missing_db_read_does_not_create_file(self) -> None:
        self.assertIsNone(self.store.get("vc:checkpoint:x"))
        self.assertEqual(self.store.keys("vc:checkpoint:"), [])
        self.assertFalse(self.db.exists())

    def test_set_get_roundtrip_and_tags(self) -> None:
        created = self.store.set(
            "vc:checkpoint:x",
            "value: 1\n",
            metadata={"layer": None, "memory_category": "state"},
        )
        self.assertTrue(created)
        entry = self.store.get("vc:checkpoint:x")
        assert entry is not None
        self.assertEqual(entry.value, "value: 1\n")
        self.assertEqual(entry.tags, CHECKPOINT_TAGS)
        self.assertNotIn("L0", entry.tags)
        self.assertIsNone(entry.metadata.get("layer"))
        self.assertEqual(entry.metadata.get("memory_category"), "state")
        self.assertIsNotNone(entry.ttl_expires_at)

    def test_second_set_preserves_created_at_and_merges_metadata(self) -> None:
        self.store.set("k", "a", metadata={"one": 1})
        first = self.store.get("k")
        assert first is not None
        self.store.set("k", "b", metadata={"two": 2})
        second = self.store.get("k")
        assert second is not None
        self.assertEqual(first.created_at, second.created_at)
        self.assertEqual(second.value, "b")
        self.assertEqual(second.metadata.get("one"), 1)
        self.assertEqual(second.metadata.get("two"), 2)

    def test_ttl_expiry_treated_as_absent(self) -> None:
        self.store.set("k", "a", ttl_seconds=-1)
        self.assertIsNone(self.store.get("k"))
        self.assertIsNotNone(self.store.get("k", include_expired=True))

    def test_no_ttl_means_permanent(self) -> None:
        self.store.set("k", "a", ttl_seconds=None)
        entry = self.store.get("k")
        assert entry is not None
        self.assertIsNone(entry.ttl_expires_at)

    def test_delete_and_keys_prefix(self) -> None:
        self.store.set("vc:checkpoint:a", "1")
        self.store.set("vc:checkpoint:b", "2")
        self.store.set("other", "3")
        self.assertEqual(self.store.keys("vc:checkpoint:"), ["vc:checkpoint:a", "vc:checkpoint:b"])
        self.assertTrue(self.store.delete("vc:checkpoint:a"))
        self.assertFalse(self.store.delete("vc:checkpoint:a"))
        self.assertEqual(self.store.keys(CHECKPOINT_QUARANTINE_PREFIX), [])

    def test_transaction_rollback_on_error(self) -> None:
        self.store.set("k", "before")
        with self.assertRaises(RuntimeError):
            with self.store.transaction() as tx:
                tx.set("k", "after")
                raise RuntimeError("boom")
        entry = self.store.get("k")
        assert entry is not None
        self.assertEqual(entry.value, "before")

    def test_fts_trigger_indexes_value(self) -> None:
        self.store.set("k", "checkpointvaluemarker")
        conn = sqlite3.connect(str(self.db))
        try:
            rows = conn.execute(
                "SELECT key FROM memory_fts WHERE memory_fts MATCH ?",
                ("checkpointvaluemarker",),
            ).fetchall()
        finally:
            conn.close()
        self.assertEqual([row[0] for row in rows], ["k"])

    def test_checkpoint_key_uses_realpath(self) -> None:
        link = self.root / "link"
        target = self.root / "target"
        target.mkdir()
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest("平台不支持软链")
        self.assertEqual(checkpoint_key(link), checkpoint_key(target))

    def test_oversized_key_rejected(self) -> None:
        with self.assertRaises(MemoryStoreError):
            self.store.set("k" * 513, "x")

    def test_tag_serialization_matches_delx_format(self) -> None:
        self.assertEqual(normalize_tags(("a", "b")), ",a,b,")
        self.assertEqual(normalize_tags(()), "")
        self.assertEqual(parse_tags(",a,b,"), ("a", "b"))
        self.assertEqual(parse_tags(None), ())


if __name__ == "__main__":
    unittest.main()
