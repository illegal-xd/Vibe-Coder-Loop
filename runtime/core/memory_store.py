"""delx-memory 存储适配层（Checkpoint 唯一持久化后端）。

事实源：
- skills/vibe-coder-loop/engine/state-machine.md「Workflow Checkpoint（delx-memory）」
- delx-memory-protocol skill `protocol.md`（命名空间 / Tag / TTL / 元数据口径）

设计约束：
- **不在项目目录创建任何文件**：状态以记忆条目承载，key = ``vc:checkpoint:<项目绝对地址>``。
- **runtime-state 独立 tag**：条目固定携带 `vc-checkpoint` / `runtime-state` / `scope:project`，
  与 L1–L7 经验/规则记忆分开召回，不被 Preflight 当规则条目加载。
  **Checkpoint 不是 L0**：`metadata.layer=null`、`metadata.memory_category=state`；
  L0 只保留给原始证据（见 `docs/memory-layers.md`）。
- 与 ``skills/vibe-coder-loop/backup/memory_tool.py`` 使用同一个 SQLite 库与表结构
  （``memory`` + FTS5 触发器），因此 MCP 的 ``memory_get`` / ``memory_set`` 与本层
  看到的是同一条记录。
- 并发：写路径使用 ``BEGIN IMMEDIATE`` 事务（替代已删除的文件锁）。
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

CHECKPOINT_KEY_PREFIX = "vc:checkpoint:"
CHECKPOINT_QUARANTINE_PREFIX = "vc:checkpoint-quarantine:"
CHECKPOINT_TAGS = ("vc-checkpoint", "runtime-state", "scope:project")
CHECKPOINT_LAYER = None
CHECKPOINT_TITLE = "vibe-kernel workflow checkpoint"
CHECKPOINT_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 天；每次写入重新锚定
MAX_KEY_LENGTH = 512
_BUSY_TIMEOUT_MS = 5000

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


class MemoryStoreError(RuntimeError):
    """记忆后端不可用（路径非法 / 库不可读 / 写入失败）。"""


_UNSET: Any = object()


def checkpoint_key(project_root: Path | str) -> str:
    """项目绝对地址（realpath）即唯一 ID。"""
    real = os.path.realpath(str(project_root))
    return f"{CHECKPOINT_KEY_PREFIX}{real}"


def default_db_path(env: Mapping[str, str] | None = None) -> Path:
    """与 memory_tool.py 同口径：``DELX_MEMORY_DB`` > ``~/.delx-memory/db.sqlite``。"""
    env_map = os.environ if env is None else env
    override = env_map.get("DELX_MEMORY_DB")
    if override:
        return Path(override).expanduser()
    home = env_map.get("HOME") or str(Path.home())
    return Path(home) / ".delx-memory" / "db.sqlite"


def normalize_tags(tags: Iterable[str]) -> str:
    """delx-memory 的 tags 列口径：``,a,b,``（空集合为空串）。"""
    items = [str(tag).strip() for tag in tags if str(tag).strip()]
    return f",{','.join(items)}," if items else ""


def parse_tags(raw: Any) -> tuple[str, ...]:
    if not isinstance(raw, str) or not raw.strip(","):
        return ()
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def parse_metadata(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return {}
        return data if isinstance(data, dict) else {}
    return {}


@dataclass(frozen=True)
class MemoryEntry:
    key: str
    value: str
    tags: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: int = 0
    updated_at: int = 0
    ttl_expires_at: int | None = None

    @property
    def expired(self) -> bool:
        return self.ttl_expires_at is not None and self.ttl_expires_at <= int(time.time() * 1000)


class MemoryStore:
    """最小读写面：``get`` / ``set`` / ``transaction``（不实现检索与淘汰）。"""

    def __init__(self, db_path: Path | str, *,
                 tags: Iterable[str] = CHECKPOINT_TAGS,
                 ttl_seconds: int | None = CHECKPOINT_TTL_SECONDS) -> None:
        self.db_path = Path(db_path)
        self.tags = tuple(tags)
        self.ttl_seconds = ttl_seconds

    # -- 连接 -----------------------------------------------------------
    def _connect(self, *, create: bool) -> sqlite3.Connection | None:
        if not create and not self.db_path.exists():
            return None
        if create:
            try:
                self.db_path.parent.mkdir(parents=True, exist_ok=True)
                if os.name != "nt":
                    with _suppress_oserror():
                        os.chmod(self.db_path.parent, 0o700)
            except OSError as exc:
                raise MemoryStoreError(f"无法创建记忆库目录: {self.db_path.parent} ({exc})") from exc
        try:
            conn = sqlite3.connect(str(self.db_path), timeout=_BUSY_TIMEOUT_MS / 1000)
        except sqlite3.Error as exc:
            raise MemoryStoreError(f"无法打开记忆库: {self.db_path} ({exc})") from exc
        conn.row_factory = sqlite3.Row
        with _suppress_sqlite():
            conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
        return conn

    def _table_exists(self, conn: sqlite3.Connection) -> bool:
        try:
            row = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory'"
            ).fetchone()
        except sqlite3.Error:
            return False
        return row is not None

    def _ensure_schema(self, conn: sqlite3.Connection) -> None:
        try:
            for statement in _SCHEMA:
                conn.execute(statement)
            # FTS 是检索侧能力；建不出来时主表仍可用（宁可检索降级，不阻断状态读写）
            with _suppress_sqlite():
                conn.execute(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                        key, value, tags,
                        content='memory',
                        content_rowid='rowid',
                        tokenize='porter unicode61 remove_diacritics 2'
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory BEGIN
                        INSERT INTO memory_fts(rowid, key, value, tags)
                        VALUES (new.rowid, new.key, new.value, COALESCE(new.tags, ''));
                    END
                    """
                )
                conn.execute(
                    """
                    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory BEGIN
                        INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
                        VALUES ('delete', old.rowid, old.key, old.value, COALESCE(old.tags, ''));
                    END
                    """
                )
                conn.execute(
                    """
                    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory BEGIN
                        INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
                        VALUES ('delete', old.rowid, old.key, old.value, COALESCE(old.tags, ''));
                        INSERT INTO memory_fts(rowid, key, value, tags)
                        VALUES (new.rowid, new.key, new.value, COALESCE(new.tags, ''));
                    END
                    """
                )
        except sqlite3.Error as exc:
            raise MemoryStoreError(f"记忆库结构不可用: {self.db_path} ({exc})") from exc

    # -- 读 -------------------------------------------------------------
    def get(self, key: str, *, include_expired: bool = False) -> MemoryEntry | None:
        conn = self._connect(create=False)
        if conn is None:
            return None
        try:
            if not self._table_exists(conn):
                return None
            row = conn.execute(
                "SELECT key, value, tags, metadata, created_at, updated_at, ttl_expires_at "
                "FROM memory WHERE key = ?",
                (key,),
            ).fetchone()
        except sqlite3.Error as exc:
            raise MemoryStoreError(f"读取记忆失败: {key} ({exc})") from exc
        finally:
            conn.close()
        if row is None:
            return None
        entry = _row_to_entry(row)
        if entry.expired and not include_expired:
            return None
        return entry

    def exists(self, key: str) -> bool:
        return self.get(key) is not None

    def keys(self, prefix: str = "") -> list[str]:
        """按前缀列出 key（只回 key，不取值；供隔离/归档核验与测试使用）。"""
        conn = self._connect(create=False)
        if conn is None:
            return []
        try:
            if not self._table_exists(conn):
                return []
            rows = conn.execute(
                "SELECT key FROM memory WHERE substr(key, 1, ?) = ? ORDER BY key",
                (len(prefix), prefix),
            ).fetchall()
        except sqlite3.Error as exc:
            raise MemoryStoreError(f"列出记忆 key 失败: {prefix!r} ({exc})") from exc
        finally:
            conn.close()
        return [str(row["key"]) for row in rows]

    # -- 写 -------------------------------------------------------------
    def set(
        self,
        key: str,
        value: str,
        *,
        metadata: Mapping[str, Any] | None = None,
        tags: Iterable[str] | None = None,
        ttl_seconds: int | None | object = _UNSET,
        conn: sqlite3.Connection | None = None,
    ) -> bool:
        """upsert；返回是否新建。调用方传 ``conn`` 时复用事务，不单独提交。"""
        if not key or "\x00" in key:
            raise MemoryStoreError("记忆 key 非法")
        if len(key) > MAX_KEY_LENGTH:
            raise MemoryStoreError(f"记忆 key 超过 {MAX_KEY_LENGTH} 字符")
        own = conn is None
        connection = conn or self._connect(create=True)
        if connection is None:  # pragma: no cover - create=True 必返回连接
            raise MemoryStoreError("记忆库连接不可用")
        try:
            if own:
                connection.execute("BEGIN IMMEDIATE")
            if own:
                self._ensure_schema(connection)
            now_ms = int(time.time() * 1000)
            row = connection.execute(
                "SELECT created_at, metadata FROM memory WHERE key = ?", (key,)
            ).fetchone()
            created = row is None
            created_at = now_ms if created else int(row["created_at"])
            merged_meta = parse_metadata(row["metadata"]) if row is not None else {}
            merged_meta.update(dict(metadata or {}))
            ttl = self.ttl_seconds if ttl_seconds is _UNSET else ttl_seconds
            expires = None if ttl is None else now_ms + int(ttl) * 1000  # type: ignore[arg-type]
            connection.execute(
                "INSERT INTO memory(key, value, created_at, updated_at, ttl_expires_at, tags, metadata) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, "
                "ttl_expires_at=excluded.ttl_expires_at, tags=excluded.tags, metadata=excluded.metadata",
                (
                    key,
                    value,
                    created_at,
                    now_ms,
                    expires,
                    normalize_tags(self.tags if tags is None else tags),
                    json.dumps(merged_meta, ensure_ascii=False, sort_keys=True),
                ),
            )
            if own:
                connection.commit()
            return created
        except sqlite3.Error as exc:
            if own:
                with _suppress_sqlite():
                    connection.rollback()
            raise MemoryStoreError(f"写入记忆失败: {key} ({exc})") from exc
        finally:
            if own:
                connection.close()

    def delete(self, key: str, *, conn: sqlite3.Connection | None = None) -> bool:
        """删除单条（runtime-state 轮换用；调用方须先留可回滚副本）。"""
        own = conn is None
        connection = conn or self._connect(create=False)
        if connection is None:
            return False
        try:
            if own:
                connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute("DELETE FROM memory WHERE key = ?", (key,))
            deleted = cursor.rowcount > 0
            if own:
                connection.commit()
            return deleted
        except sqlite3.Error as exc:
            if own:
                with _suppress_sqlite():
                    connection.rollback()
            raise MemoryStoreError(f"删除记忆失败: {key} ({exc})") from exc
        finally:
            if own:
                connection.close()

    # -- 事务 -----------------------------------------------------------
    def transaction(self):
        return _MemoryTransaction(self)


class _MemoryTransaction:
    """``BEGIN IMMEDIATE`` 读-改-写事务；替代原状态文件锁。"""

    def __init__(self, store: MemoryStore) -> None:
        self.store = store
        self.conn: sqlite3.Connection | None = None

    def __enter__(self) -> "_MemoryTransaction":
        self.conn = self.store._connect(create=True)
        if self.conn is None:  # pragma: no cover
            raise MemoryStoreError("记忆库连接不可用")
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            self.store._ensure_schema(self.conn)
        except sqlite3.Error as exc:
            self.conn.close()
            self.conn = None
            raise MemoryStoreError(f"记忆库事务不可用: {exc}") from exc
        return self

    def get(self, key: str) -> MemoryEntry | None:
        assert self.conn is not None
        row = self.conn.execute(
            "SELECT key, value, tags, metadata, created_at, updated_at, ttl_expires_at "
            "FROM memory WHERE key = ?",
            (key,),
        ).fetchone()
        if row is None:
            return None
        entry = _row_to_entry(row)
        return None if entry.expired else entry

    def set(self, key: str, value: str, **kwargs: Any) -> bool:
        assert self.conn is not None
        return self.store.set(key, value, conn=self.conn, **kwargs)

    def delete(self, key: str) -> bool:
        assert self.conn is not None
        return self.store.delete(key, conn=self.conn)

    def commit(self) -> None:
        if self.conn is not None:
            self.conn.commit()

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.conn is None:
            return
        try:
            if exc_type is None:
                self.conn.commit()
            else:
                with _suppress_sqlite():
                    self.conn.rollback()
        finally:
            self.conn.close()
            self.conn = None


def _row_to_entry(row: sqlite3.Row) -> MemoryEntry:
    return MemoryEntry(
        key=str(row["key"]),
        value=str(row["value"]),
        tags=parse_tags(row["tags"]),
        metadata=parse_metadata(row["metadata"]),
        created_at=int(row["created_at"]),
        updated_at=int(row["updated_at"]),
        ttl_expires_at=(
            int(row["ttl_expires_at"]) if row["ttl_expires_at"] is not None else None
        ),
    )


class _suppress_oserror:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *exc: object) -> bool:
        return isinstance(exc[0], OSError)


class _suppress_sqlite:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *exc: object) -> bool:
        return isinstance(exc[0], sqlite3.Error)
