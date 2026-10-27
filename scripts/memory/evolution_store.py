"""经验进化闭环共享存储层（P1-1 / P1-2 / P1-3 只读侧）。

设计约束（见 docs/memory-layers.md）：
- **不新增表 / 列**：signal / feedback 记录复用 delx-memory 现有 `memory` 表。
- 两类记录固定 `layer=null` + `memory_category=state`，不进入 L0–L7 知识统计，
  也不参与升层 / 淘汰；它们只是**运行观测账本**。
- 原始记忆内容不被本模块改写：写入仅落在 `signal:` / `feedback:` 前缀的 key 上。
- 幂等由调用方的确定性 key 保证（同一 task + 事件 / 同一 task + memory 只有一条）。
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

SIGNAL_PREFIX = "signal:reflection:"
FEEDBACK_PREFIX = "feedback:memory:"

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ttl_expires_at INTEGER,
      tags TEXT,
      metadata TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_memory_ttl ON memory(ttl_expires_at) WHERE ttl_expires_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_memory_tags ON memory(tags)",
    "CREATE INDEX IF NOT EXISTS idx_memory_updated_at ON memory(updated_at)",
)

_FTS_SCHEMA = (
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        key, value, tags,
        content='memory',
        content_rowid='rowid',
        tokenize='porter unicode61 remove_diacritics 2'
    )
    """,
    """
    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, key, value, tags)
        VALUES (new.rowid, new.key, new.value, COALESCE(new.tags, ''));
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
        VALUES ('delete', old.rowid, old.key, old.value, COALESCE(old.tags, ''));
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
        VALUES ('delete', old.rowid, old.key, old.value, COALESCE(old.tags, ''));
        INSERT INTO memory_fts(rowid, key, value, tags)
        VALUES (new.rowid, new.key, new.value, COALESCE(new.tags, ''));
    END
    """,
)


class StoreUnavailable(RuntimeError):
    """记忆库不可用（路径非法 / 库不可读 / 写入失败）。"""


def default_db() -> Path:
    """与 memory_tool.py / memops.py 同口径。"""
    override = os.environ.get("DELX_MEMORY_DB")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".delx-memory" / "db.sqlite"


def resolve_db(value: str | os.PathLike[str] | None) -> Path:
    return Path(value).expanduser() if value else default_db()


def now_ms() -> int:
    return int(time.time() * 1000)


def iso_ms(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def stable_key(prefix: str, *parts: str) -> str:
    raw = "\x00".join(str(p) for p in parts)
    return prefix + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def decode_value(raw: Any) -> str:
    """兼容 delx-memory 的 JSON 字符串 / 裸文本两种存量格式。"""
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raw = str(raw)
    try:
        val = json.loads(raw)
    except (ValueError, TypeError):
        return raw
    return val if isinstance(val, str) else raw


def json_object(raw: Any) -> dict[str, Any]:
    """把 signal / feedback 的 value 解析为对象；损坏时返回空 dict（不猜测）。"""
    if isinstance(raw, Mapping):
        return dict(raw)
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        val = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return val if isinstance(val, dict) else {}


def parse_metadata(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            val = json.loads(raw)
        except (ValueError, TypeError):
            return {}
        return val if isinstance(val, dict) else {}
    return {}


def split_tags(raw: Any) -> list[str]:
    if not isinstance(raw, str):
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def norm_tags(tags: Iterable[str]) -> str:
    items = [str(tag).strip() for tag in tags if str(tag).strip()]
    return f",{','.join(items)}," if items else ""


def _table_exists(conn: sqlite3.Connection, name: str = "memory") -> bool:
    try:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?", (name,)
        ).fetchone()
    except sqlite3.Error:
        return False
    return row is not None


def ensure_schema(conn: sqlite3.Connection) -> None:
    try:
        for statement in _SCHEMA:
            conn.execute(statement)
        # FTS 是检索侧增强；建不出来时主表仍可用（宁可检索降级，不阻断记录）
        try:
            for statement in _FTS_SCHEMA:
                conn.execute(statement)
        except sqlite3.Error:
            pass
    except sqlite3.Error as exc:
        raise StoreUnavailable(f"记忆库结构不可用: {exc}") from exc


def connect_ro(db: Path | str) -> sqlite3.Connection:
    """只读连接（URI mode=ro）；报告 / 扫描路径无法意外写入。"""
    path = Path(db).expanduser().resolve()
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def connect_rw(db: Path | str, *, create: bool = True) -> sqlite3.Connection:
    path = Path(db).expanduser()
    if not path.exists() and not create:
        raise StoreUnavailable(f"记忆库不存在: {path}")
    if create:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if os.name != "nt":
                try:
                    os.chmod(path.parent, 0o700)
                except OSError:
                    pass
        except OSError as exc:
            raise StoreUnavailable(f"无法创建记忆库目录: {path.parent} ({exc})") from exc
    try:
        conn = sqlite3.connect(str(path), timeout=15)
    except sqlite3.Error as exc:
        raise StoreUnavailable(f"无法打开记忆库: {path} ({exc})") from exc
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=15000")
    if create:
        ensure_schema(conn)
    return conn


def _row_entry(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "key": str(row["key"]),
        "value": decode_value(row["value"]),
        "raw_value": str(row["value"]),
        "tags": split_tags(row["tags"]),
        "metadata": parse_metadata(row["metadata"]),
        "created_at": int(row["created_at"]),
        "updated_at": int(row["updated_at"]),
        "ttl_expires_at": (
            int(row["ttl_expires_at"]) if row["ttl_expires_at"] is not None else None
        ),
    }


def list_entries(db: Path | str, prefix: str) -> list[dict[str, Any]]:
    path = Path(db).expanduser()
    if not path.exists():
        return []
    try:
        conn = connect_ro(path)
    except sqlite3.Error as exc:
        raise StoreUnavailable(f"无法打开记忆库: {path} ({exc})") from exc
    try:
        if not _table_exists(conn):
            return []
        rows = conn.execute(
            "SELECT key, value, tags, metadata, created_at, updated_at, ttl_expires_at "
            "FROM memory WHERE substr(key, 1, ?) = ? ORDER BY updated_at, key",
            (len(prefix), prefix),
        ).fetchall()
    except sqlite3.Error as exc:
        raise StoreUnavailable(f"读取记录失败: {prefix} ({exc})") from exc
    finally:
        conn.close()
    return [_row_entry(row) for row in rows]


def fetch_entry(db: Path | str, key: str) -> dict[str, Any] | None:
    path = Path(db).expanduser()
    if not path.exists():
        return None
    try:
        conn = connect_ro(path)
    except sqlite3.Error as exc:
        raise StoreUnavailable(f"无法打开记忆库: {path} ({exc})") from exc
    try:
        if not _table_exists(conn):
            return None
        row = conn.execute(
            "SELECT key, value, tags, metadata, created_at, updated_at, ttl_expires_at "
            "FROM memory WHERE key = ?",
            (key,),
        ).fetchone()
    except sqlite3.Error as exc:
        raise StoreUnavailable(f"读取记录失败: {key} ({exc})") from exc
    finally:
        conn.close()
    return _row_entry(row) if row is not None else None


def upsert_record(
    db: Path | str,
    key: str,
    *,
    build: Callable[[dict[str, Any] | None], tuple[dict[str, Any], dict[str, Any], Iterable[str]]],
    ttl_seconds: int | None,
) -> dict[str, Any]:
    """读-改-写一条记录；``build(existing)`` 返回 (value, metadata, tags)。

    ``existing`` 为 None 表示新建；否则含 value(已解码)/metadata/tags/created_at。
    并发写使用 ``BEGIN IMMEDIATE``；value/tags/metadata 三列整体回传。
    """
    conn = connect_rw(db, create=True)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT value, tags, metadata, created_at FROM memory WHERE key = ?", (key,)
        ).fetchone()
        existing = (
            {
                "value": decode_value(row["value"]),
                "tags": split_tags(row["tags"]),
                "metadata": parse_metadata(row["metadata"]),
                "created_at": int(row["created_at"]),
            }
            if row is not None
            else None
        )
        value_obj, metadata_obj, tags = build(existing)
        now = now_ms()
        created = row is None
        created_at = now if created else int(row["created_at"])
        expires = None if ttl_seconds is None else now + int(ttl_seconds) * 1000
        conn.execute(
            "INSERT INTO memory(key, value, created_at, updated_at, ttl_expires_at, tags, metadata) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, "
            "ttl_expires_at=excluded.ttl_expires_at, tags=excluded.tags, metadata=excluded.metadata",
            (
                key,
                json.dumps(value_obj, ensure_ascii=False, sort_keys=True),
                created_at,
                now,
                expires,
                norm_tags(tags),
                json.dumps(metadata_obj, ensure_ascii=False, sort_keys=True),
            ),
        )
        conn.commit()
        return {
            "key": key,
            "created": created,
            "created_at": created_at,
            "updated_at": now,
            "value": value_obj,
            "metadata": metadata_obj,
            "tags": list(tags),
        }
    except sqlite3.Error as exc:
        conn.rollback()
        raise StoreUnavailable(f"写入记录失败: {key} ({exc})") from exc
    finally:
        conn.close()
