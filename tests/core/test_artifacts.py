from __future__ import annotations

import os
import time
import unittest

from runtime.core.artifacts import ArtifactStore, iter_refs

from .util import CoreTest


class ArtifactTests(CoreTest):
    def setUp(self) -> None:
        super().setUp()
        self.store = ArtifactStore(self.core.resolved.artifacts_dir)

    def test_put_and_validate_pinned(self) -> None:
        ref = self.store.put("hello\n", reproducible=True, regen_cmd=["pytest"])
        self.assertIsNotNone(ref)
        assert ref is not None
        self.assertEqual(ref["tier"], "pinned")
        self.assertEqual(ref["bytes"], 6)
        check = self.store.validate(ref)
        self.assertTrue(check.ok)

    def test_invalid_name_rejected(self) -> None:
        self.assertIsNone(self.store.put("x", name="a/b"))
        self.assertIsNone(self.store.put("x", name="../x"))

    def test_sha_mismatch_detected(self) -> None:
        ref = self.store.put("hello\n")
        assert ref is not None
        tampered = {**ref, "sha256": "0" * 64}
        self.assertFalse(self.store.validate(tampered).ok)

    def test_missing_pinned(self) -> None:
        check = self.store.validate({"tier": "pinned", "ref": "artifacts/nope.log"})
        self.assertTrue(check.missing)
        self.assertEqual(check.reason, "pinned artifact 不存在")

    def test_v25_gc_refuses_active(self) -> None:
        result = self.store.gc({"status": "active"})
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "STATE_ILLEGAL_TRANSITION")

    def test_gc_keeps_referenced_and_deletes_old_unreferenced(self) -> None:
        referenced = self.store.put("keep me\n", name="keep")
        stale = self.store.put("delete me\n", name="stale")
        assert referenced is not None and stale is not None
        stale_path = self.store.path_for(stale["ref"])
        old = time.time() - 30 * 86400
        os.utime(stale_path, (old, old))
        result = self.store.gc(
            {"status": "complete", "review": {"last_failure_ref": referenced}},
            retention_days=7,
        )
        self.assertTrue(result.ok)
        self.assertIn("keep.log", result.referenced)
        self.assertIn("stale.log", result.deleted)
        self.assertTrue(self.store.path_for(referenced["ref"]).exists())
        self.assertFalse(stale_path.exists())

    def test_gc_dry_run_keeps_file(self) -> None:
        stale = self.store.put("x\n", name="stale")
        assert stale is not None
        path = self.store.path_for(stale["ref"])
        old = time.time() - 30 * 86400
        os.utime(path, (old, old))
        result = self.store.gc({"status": "complete"}, retention_days=7, dry_run=True)
        self.assertIn("stale.log", result.deleted)
        self.assertTrue(path.exists())

    def test_ephemeral_index(self) -> None:
        store = ArtifactStore(self.core.resolved.artifacts_dir, ephemeral_index={"b3f1"})
        self.assertTrue(store.validate({"tier": "ephemeral", "ref": "b3f1"}).ok)
        self.assertFalse(store.validate({"tier": "ephemeral", "ref": "gone"}).ok)
        unknown = ArtifactStore(self.core.resolved.artifacts_dir)
        self.assertIsNone(unknown.validate({"tier": "ephemeral", "ref": "b3f1"}).ok)

    def test_iter_refs_nested(self) -> None:
        refs = iter_refs(
            {
                "review": {
                    "a": {"tier": "pinned", "ref": "artifacts/x.log"},
                    "b": [{"tier": "ephemeral", "ref": "r1"}],
                }
            }
        )
        self.assertEqual(len(refs), 2)


if __name__ == "__main__":
    unittest.main()
