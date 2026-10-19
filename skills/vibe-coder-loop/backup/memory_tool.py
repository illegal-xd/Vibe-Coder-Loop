#!/usr/bin/env python3
"""
vibe-coder-loop 记忆 Tool（跨平台：macOS / Linux / Windows）

两组子命令（**Skill 只向 Agent 暴露 runtime 组**）：

  runtime —— Agent 调用，确定性执行（协议见 ../learning/memory/lifecycle.md「回写契约」）
    touch <key>... [--hit]          消费回写：access_count+1（--hit 时 cache_hit_count+1）
    metrics [--<delta> ...] ...     仪表盘 upsert：读当前值 → 叠加本轮 delta → 完整回写
    preflight [--level N] [--task T] [--stage S8,S9| ^S3] [--files a,b]
                                    加载计划：一次调用替代 N 次导航读取。输出 =
                                    加载清单 + **按阶段裁剪的命中节（含实测行号）** + 成本对比
                                    （整文件口径 → 按阶段命中，省 N%）+ 记忆候选。
                                    阶段集缺省取 load_plan.json level_stages[level]；`--stage` 收窄：
                                    `S8` = 只保留所列（循环中单阶段重读）；`^S3` = 从默认集**排除**
                                    （S1 冲突预检无冲突时用，免手抄全清单——手抄漏 S13 = 静默裁掉收尾义务）。
                                    阶段 token 校验 S1–S13，非法 `[INVALID_ARGUMENT]` exit 3。
                                    映射失效自动回退整文件（fail-safe，不静默漏读）；
                                    transition.md 机械分支仅命中 VC 节时同样回退整文件。
                                    只回 key 不回 value（Memory ≠ Context 硬约束）。
                                    退出码 0 正常 / 3 = 计划缺失（[LOAD_PLAN_MISSING]，
                                    --files 可绕过）或清单内文件缺失（[RULE_NOT_FOUND]），
                                    均 fail closed 不静默降级
    artifact put --file F [--name N] [--kind text|jsonl] [--loop N]
                                    结果外置：大产物落盘，回 ref（24h TTL，put 时顺带回收过期）。
                                    --name 会消毒（去路径分隔符/首尾点），非法直接拒绝不落盘
    artifact page --ref R [--offset N] [--limit N] [--max-bytes N]
                  [--fields a,b] [--equals k=v] [--grep RE] [--count]
                                    分页取用：投影 + 过滤 + 字节上限；clamp（--limit>上限）
                                    显式报 [OUTPUT_LIMIT] 不静默；--count 只回计数
    artifact list                  列出当前工作区产物与剩余 TTL
    artifact release --ref R...    释放产物（ref 形态/边界非法一律拒绝，不信任 index.json）
                                    退出码：3 = 源缺失/参数非法/[ARTIFACT_NAME|REF]_INVALID；
                                    4 = ref 不存在或已过期（均可经 [next] 行自纠）
                                    产物目录 = $VIBE_LOOP_ARTIFACTS_DIR，
                                    缺省 ~/.vibe-loop/artifacts/<workspace-hash>/

  maintenance —— 技能迭代时调用，非运行时路径
    backup / restore / verify / list   技能相关记忆的快照导出 / 恢复 / 校验 / 列举

  自测 —— 标准库 unittest（自建临时库，不触碰真实库）：
    python3 test_memory_tool.py

备份范围（仅技能相关联的数据记忆，不备份其他项目记忆）：
  - 前缀 skill:* 的全部条目（规则条目 / 仪表盘 / 指标 / 回滚锚点；计数以 memory_list 实时核对）
  - 显式关联条目（SKILL_LINKED_KEYS 常量，清单与数量以该常量 + backup/README.md「备份范围」为准，不在注释内重复枚举）
  - 合计条目数每次以实际库为准：python3 memory_tool.py list

维护约定（技能迭代时必守）：
  - 新增/删除技能相关记忆 key → 同步更新 SKILL_LINKED_KEYS 与 backup/README.md 备份范围说明
  - 技能规则/关联内容更新后 → 重新执行 python3 memory_tool.py backup（快照含 skill_version + changelog_top 溯源）
  - 迭代历史唯一事实源 = ../CHANGELOG.md；版本号唯一事实源 = ../manifest.yaml version

数据库路径解析优先级：
  1. --db 参数
  2. 环境变量 DELX_MEMORY_DB
  3. backup/config.json 的 db_path 字段（手动修改，或让 agent 调整）
  4. 自动探测：~/.delx-memory/db.sqlite（macOS/Linux）、
     %USERPROFILE%\\.delx-memory\\db.sqlite（Windows）

用法（Python 3 标准库，无第三方依赖）：
  python3 memory_tool.py backup             # 备份到 snapshots/（时间戳快照 + latest），并自动压缩历史快照
  python3 memory_tool.py restore <file> [--dry-run] [--force]
        # 从备份文件更新数据库（upsert，保留 created_at；支持 .json.gz）
        # 范围守卫：备份内出现非 skill:* / SKILL_LINKED_KEYS 的越界 key → 默认拒绝执行
        # 写前快照：实际写入前，先把当前库状态落到 snapshots/skill_memory_prerestore_<ts>.json
        # --dry-run 只打印将发生的变更（不写库）；--force 放行越界 key（须自行确认范围）
  python3 memory_tool.py verify <file>      # 校验备份/数据库一致性（支持 .json.gz）
        # 硬校验：缺失/值/tags/metadata/created_at/ttl_expires_at + 范围完整性（库内技能 key 是否都进过备份）
  python3 memory_tool.py list               # 列出技能相关 key 与当前数据库路径

运行时写入（确定性执行，属 Skill 的 Tool 侧；Skill 只声明「何时调用」）：
  python3 memory_tool.py touch <key>... [--hit]
        # Memory 消费回写：access_count+1（--hit 同时 cache_hit_count+1）
        # 不变量：value 不改、tags 不动、metadata 其余字段原样保留、有限 TTL 按剩余时长重锚
  python3 memory_tool.py metrics [--conflict N --by-user N --by-level N
                                 --retrieval N --budget-hit N --memory-hit N --over-budget N
                                 --auto-promoted N --auto-demoted N --auto-deleted N --auto-pending N
                                 --rollback N --skeleton-entries N --skeleton-bytes N
                                 --counts] [--note TEXT]
        # 仪表盘 upsert：读 DASHBOARD_KEY → 叠加本轮 delta → 完整回写（两个 rate 重算）
        # 两个 rate 语义不同、互不替代（详见 METRIC_FIELDS 注释）：
        #   hit_rate        = budget_hits / searches   → 检索「在红线预算内完成」的比率
        #   memory_hit_rate = memory_hits / searches   → 检索「确有召回结果」的比率
        # --counts 时机械重算 memory.* 条目计数；未触及字段 / tags / metadata 原样保留

历史快照策略：
  - 按天去重：每天只保留一份最新时间戳快照（多余清理，用户要求）
  - 历史时间戳快照自动压缩为 .json.gz（gzip level 9），删除原 .json
  - 幂等：已存在对应 .json.gz 的跳过（扩展名即"是否已压缩"判断）；latest 永不压缩（restore/verify 主入口）
"""

import argparse
import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import re
import subprocess
import sys
import time
import zlib
from pathlib import Path

# 技能相关记忆的显式关联 key（前缀 skill:* 之外）
# 注意：修改本列表必须同步 backup/README.md「备份范围」说明，并重新执行 backup
SKILL_LINKED_KEYS = [
    "rule:skill-iteration-manifest",
    "lesson:skill-edit-date-residue",
    "lesson:access-writeback-trigger-gap",
    "lesson:memory-metadata-overwrite",
    "lesson:runtime-message-timing",
    "lesson:hard-constraint-bypass",
    "lesson:checkpoint-instance-growth",
    "lesson:fail-closed-over-silent-degradation",
    "lesson:context-cost-lever-is-tool-surface",
    "pattern:memory-writeback-integrity",
    "agent:vc_constraints",
    "reference:memory-navigation",
    "reference:memory-access-tracking",
    "reference:skill-context-cost-baseline",
    "project:opencode-model-limits",
    "preference:user:memory-autonomy",
]

SKILL_PREFIX = "skill:"

# 仪表盘键：**必须 Skill 专属**（命名规范 `skill:<skill-name>:<slug>`）。
# `skill:system:*` 是跨 skill 共用命名空间，实测被他 skill 覆盖（v1.17.0 D8）；
# 旧键处置：skill:system:rollback_point 已按用户指令删除；skill:system:metrics **仍保留不删**
# （owner:audio-kernel，含他 skill 数据，删除须先确认归属）。
DASHBOARD_KEY = "skill:vibe-coder-loop:metrics"

# 快照读取上限（防解压炸弹 / 异常大文件打爆内存）
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024  # 解压后上限 8 MiB
MAX_SNAPSHOT_ENTRIES = 2000  # 条目数上限

RESTORE_PRE_SNAPSHOT_PREFIX = "skill_memory_prerestore_"
PRERESTORE_KEEP = 2  # 写前快照保留份数（超出删最旧）；同一调试日的中间产物通常只有最近 1-2 份有回退价值

# 由 runtime 回写改变的字段 / 条目——verify 只作「漂移提示」，不计为不一致：
#   - metadata 的计数三件套（touch 每次 +1）
#   - 仪表盘 value（活计数器，metrics 每次叠加）
COUNTER_FIELDS = ("access_count", "cache_hit_count")
VALUE_VOLATILE_KEYS = (DASHBOARD_KEY,)


def read_skill_version():
    """从 manifest.yaml 读取 skill 版本（快照溯源用；缺失不阻塞，标记 unknown）。"""
    manifest = Path(__file__).resolve().parent.parent / "manifest.yaml"
    try:
        for line in manifest.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("version:"):
                return line.split(":", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return "unknown"


def read_changelog_top():
    """从 CHANGELOG.md 读取最新版本条目标题（溯源用；缺失不阻塞，标记 unknown）。"""
    changelog = Path(__file__).resolve().parent.parent / "CHANGELOG.md"
    try:
        for line in changelog.read_text(encoding="utf-8").splitlines():
            if line.startswith("## v"):
                return line.strip("# ").strip()
    except OSError:
        pass
    return "unknown"


def default_db_path():
    """自动探测 delx-memory 数据库路径（跨平台）。"""
    home = Path.home()
    candidates = [
        home / ".delx-memory" / "db.sqlite",  # macOS / Linux
        Path(os.environ.get("USERPROFILE", str(home)))
        / ".delx-memory"
        / "db.sqlite",  # Windows
    ]
    for p in candidates:
        if p.exists():
            return p
    return candidates[0]


def config_path():
    return Path(__file__).resolve().parent / "config.json"


def resolve_db_path(args_db):
    """数据库路径解析：--db > DELX_MEMORY_DB > config.json > 自动探测。"""
    if args_db:
        return Path(args_db)
    env = os.environ.get("DELX_MEMORY_DB")
    if env:
        return Path(env)
    cfg = config_path()
    if cfg.exists():
        try:
            data = json.loads(cfg.read_text(encoding="utf-8"))
            p = data.get("db_path")
            if p:
                return Path(p).expanduser()
        except (json.JSONDecodeError, OSError):
            pass
    return default_db_path()


def connect(db):
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def select_skill_keys(conn):
    """返回技能相关 key 集合：skill: 前缀 + 显式关联 key（存在才加入）。"""
    rows = conn.execute(
        "SELECT key FROM memory WHERE key LIKE ?", (SKILL_PREFIX + "%",)
    ).fetchall()
    keys = {r[0] for r in rows}
    for k in SKILL_LINKED_KEYS:
        exists = conn.execute("SELECT 1 FROM memory WHERE key = ?", (k,)).fetchone()
        if exists:
            keys.add(k)
    return sorted(keys)


def fetch_entries(conn, keys):
    """按 key 批量取条目（单条 IN 查询，避免 N+1）。"""
    if not keys:
        return []
    placeholders = ",".join("?" * len(keys))
    rows = conn.execute(
        "SELECT key, value, created_at, updated_at, ttl_expires_at, tags, metadata"
        f" FROM memory WHERE key IN ({placeholders})",
        tuple(keys),
    ).fetchall()
    return [
        {
            "key": r[0],
            "value": r[1],
            "created_at": r[2],
            "updated_at": r[3],
            "ttl_expires_at": r[4],
            "tags": r[5],
            "metadata": r[6],
        }
        for r in rows
    ]


_DATE_RE = re.compile(r"^skill_memory_(\d{8})_")


def _snapshot_day(name):
    """从文件名解析 YYYYMMDD；无法解析返回 None（不按偏移硬切，避免误判 prerestore_*）。"""
    m = _DATE_RE.match(name)
    return m.group(1) if m else None


def prune_prerestore_snapshots(keep=PRERESTORE_KEEP):
    """写前快照只保留最新 keep 份（每次 restore 新增一份，需有界）。返回删除的文件名。"""
    snap_dir = Path(__file__).resolve().parent / "snapshots"
    if not snap_dir.exists():
        return []
    files = sorted(snap_dir.glob(f"{RESTORE_PRE_SNAPSHOT_PREFIX}*"))
    removed = []
    for p in files[:-keep] if keep > 0 else files:
        p.unlink()
        removed.append(p.name)
    return removed


def dedupe_daily_snapshots():
    """按天去重：每天只保留一份最新时间戳快照（含 .json 与 .json.gz），删除同天其余。

    保留规则：文件名最大者（时间戳字典序 = 时间序，当天最新状态）。
    写前快照（prerestore_*）不参与按天去重，由 prune_prerestore_snapshots 有界保留。
    返回被删除的文件名列表。
    """
    snap_dir = Path(__file__).resolve().parent / "snapshots"
    if not snap_dir.exists():
        return []
    by_day = {}
    for p in list(snap_dir.glob("skill_memory_20*.json")) + list(
        snap_dir.glob("skill_memory_20*.json.gz")
    ):
        day = _snapshot_day(p.name)
        if day is None:
            continue
        by_day.setdefault(day, []).append(p)
    removed = []
    for day, paths in sorted(by_day.items()):
        if len(paths) <= 1:
            continue
        keep = max(paths, key=lambda p: p.name)
        for p in paths:
            if p != keep:
                p.unlink()
                removed.append(p.name)
    return removed


def compress_history_snapshots():
    """压缩历史时间戳快照（skill_memory_*.json → .json.gz），幂等。

    - 跳过：latest、写前快照（prerestore_*，需保持可直接读取回退）、已存在 .json.gz 的
    - 压缩成功 → 删除原 .json（内容完整保留于 .gz）
    - 返回 (压缩数, 跳过数, 节省字节)
    """
    snap_dir = Path(__file__).resolve().parent / "snapshots"
    if not snap_dir.exists():
        return 0, 0, 0
    compressed, skipped, saved = 0, 0, 0
    for p in sorted(snap_dir.glob("skill_memory_*.json")):
        if p.name == "skill_memory_latest.json" or p.name.startswith(
            RESTORE_PRE_SNAPSHOT_PREFIX
        ):
            continue
        gz = p.with_suffix(".json.gz")
        if gz.exists():
            skipped += 1  # 已压缩过（幂等判断），不重复处理
            continue
        raw = p.read_bytes()
        with gzip.open(gz, "wb", compresslevel=9) as f:
            f.write(raw)
        saved += len(raw) - gz.stat().st_size
        p.unlink()
        compressed += 1
    return compressed, skipped, saved


def load_snapshot(src):
    """读取快照 JSON（支持 .json.gz 自动解压），带解压/体积上限。

    上限目的：备份文件可能来自外部（跨机同步 / 他人提供），需防 gzip 炸弹与超大文件。
    超限抛 ValueError，由调用方统一转为可读错误。
    """
    if src.suffix == ".gz":
        blob = src.read_bytes()
        try:
            raw = zlib.decompressobj(zlib.MAX_WBITS | 16).decompress(
                blob, MAX_SNAPSHOT_BYTES + 1
            )
        except zlib.error as e:
            raise ValueError(f"快照 gzip 解压失败: {e}") from e
        if len(raw) > MAX_SNAPSHOT_BYTES:
            raise ValueError(
                f"快照解压后超过上限 {MAX_SNAPSHOT_BYTES} 字节（疑似 gzip 炸弹或文件损坏）"
            )
    else:
        size = src.stat().st_size
        if size > MAX_SNAPSHOT_BYTES:
            raise ValueError(f"快照文件超过上限 {MAX_SNAPSHOT_BYTES} 字节（{size} 字节）")
        raw = src.read_bytes()
    return json.loads(raw.decode("utf-8"))


def out_of_scope_keys(entries):
    """返回不在技能范围内的 key 列表（非 skill:* 且不在 SKILL_LINKED_KEYS）。

    防「记忆投毒」：restore 会 upsert 备份内的任意 key，若备份夹带其他项目记忆，
    会静默覆盖本机同 key 条目。范围外的 key 一律先拦下。
    """
    allowed = set(SKILL_LINKED_KEYS)
    return [
        e.get("key", "")
        for e in entries
        if not (e.get("key", "").startswith(SKILL_PREFIX) or e.get("key", "") in allowed)
    ]


def parse_metadata(raw):
    """解析 metadata 字符串。返回 (is_json_obj, obj)；非 JSON 对象时 is_json_obj=False。"""
    try:
        obj = json.loads(raw) if raw else {}
    except (json.JSONDecodeError, TypeError, ValueError):
        return False, raw
    if not isinstance(obj, dict):
        return False, raw
    return True, obj


def metadata_equal(a, b):
    """语义比较 metadata：计数三件套漂移不算差异（touch 每次 +1 属正常 runtime 回写）。

    非 JSON 对象（畸形）时退化为原始字符串比较，不做语义放行。
    """
    ok_a, obj_a = parse_metadata(a)
    ok_b, obj_b = parse_metadata(b)
    if not (ok_a and ok_b):
        return a == b

    def strip(d):
        return {k: v for k, v in d.items() if k not in COUNTER_FIELDS}

    return strip(obj_a) == strip(obj_b)


def validate_entries(raw):
    """归一化 + 校验快照条目，返回 (entries, problems)。

    外部/畸形快照必须给出可读拒绝，不得裸抛异常：
    非 dict 条目、key 缺失或非非空字符串、value 非字符串 → 记入 problems 并跳过。
    """
    if not isinstance(raw, list):
        return [], [f"entries 不是数组（实际 {type(raw).__name__}）"]
    entries, problems = [], []
    for i, e in enumerate(raw):
        if not isinstance(e, dict):
            problems.append(f"#{i} 条目不是对象（{type(e).__name__}）")
            continue
        key = e.get("key")
        if not isinstance(key, str) or not key:
            problems.append(f"#{i} key 缺失/非非空字符串（{key!r}）")
            continue
        value = e.get("value")
        if not isinstance(value, str):
            problems.append(f"#{i} {key}: value 非字符串（{type(value).__name__}）")
            continue
        entries.append(
            {
                "key": key,
                "value": value,
                "created_at": e.get("created_at"),
                "updated_at": e.get("updated_at"),
                "ttl_expires_at": e.get("ttl_expires_at"),
                "tags": e.get("tags"),
                "metadata": e.get("metadata"),
            }
        )
    return entries, problems


def load_payload(src, label):
    """读取快照 + 顶层结构校验。返回 (payload, error_message)。"""
    try:
        payload = load_snapshot(src)
    except (json.JSONDecodeError, OSError, ValueError, UnicodeDecodeError) as e:
        return None, f"[{label}] 备份文件解析失败: {e}"
    if not isinstance(payload, dict):
        return None, f"[{label}] 备份文件顶层不是 JSON 对象（实际 {type(payload).__name__}）"
    return payload, None


def build_snapshot_payload(db):
    """采集技能相关记忆并构造快照 payload（backup 与 restore 写前快照共用）。

    无技能相关条目时返回 None（调用方决定如何提示）。
    """
    conn = connect(db)
    try:
        entries = fetch_entries(conn, select_skill_keys(conn))
    finally:
        conn.close()
    if not entries:
        return None
    return {
        "scope": "vibe-coder-loop skill memories",
        "skill_version": read_skill_version(),
        "changelog_top": read_changelog_top(),
        "db": str(db),
        "exported_at": int(time.time() * 1000),
        "count": len(entries),
        "entries": entries,
    }


def cmd_backup(args, db):
    payload = build_snapshot_payload(db)
    if payload is None:
        print(f"[backup] 未找到技能相关记忆（db={db}），无输出。")
        return 1
    entries = payload["entries"]
    snap_dir = Path(__file__).resolve().parent / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    hist = snap_dir / f"skill_memory_{ts}.json"
    latest = snap_dir / "skill_memory_latest.json"
    for target in (hist, latest):
        target.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    print(f"[backup] 技能相关记忆 {len(entries)} 条已备份")
    print(f"[backup] 时间戳快照: {hist}")
    print(f"[backup] 最新快照:   {latest}（跨机器同步请提交 git）")
    removed = dedupe_daily_snapshots()
    if removed:
        print(f"[backup] 按天去重: 清理同天多余快照 {len(removed)} 个")
        for name in removed:
            print(f"  - 删除: {name}")
    compressed, skipped, saved = compress_history_snapshots()
    if compressed or skipped:
        print(
            f"[backup] 历史快照压缩: 压缩 {compressed} 个，跳过 {skipped} 个（已压缩），"
            f"节省 {saved / 1024:.0f} KB"
        )
    pruned = prune_prerestore_snapshots()
    if pruned:
        print(f"[backup] 写前快照有界保留（keep={PRERESTORE_KEEP}）: 清理 {len(pruned)} 个")
        for name in pruned:
            print(f"  - 删除: {name}")
    return 0


def _entry_matches(row, e):
    """row = (value, updated_at, ttl_expires_at, tags, metadata)；与备份条目逐字段比对。"""
    return (
        row[0] == e["value"]
        and row[1] == e["updated_at"]
        and row[2] == e["ttl_expires_at"]
        and row[3] == e["tags"]
        and row[4] == e["metadata"]
    )


def cmd_restore(args, db):
    src = Path(args.file)
    if not src.exists():
        print(f"[restore] 备份文件不存在: {src}")
        return 1
    payload, err = load_payload(src, "restore")
    if err or payload is None:
        print(err or "[restore] 备份内容为空。")
        return 1
    raw_entries = payload.get("entries", [])
    if not isinstance(raw_entries, list) or len(raw_entries) > MAX_SNAPSHOT_ENTRIES:
        shown = len(raw_entries) if isinstance(raw_entries, list) else type(raw_entries).__name__
        print(f"[restore] 备份条目数异常（{shown}），上限 {MAX_SNAPSHOT_ENTRIES}，拒绝执行。")
        return 1
    entries, problems = validate_entries(raw_entries)
    if problems:
        print(f"[restore] 备份条目异常 {len(problems)} 处:")
        for p in problems[:10]:
            print(f"  - {p}")
        if not args.force:
            print("[restore] 拒绝执行；确认备份可信时可加 --force 跳过异常条目。")
            return 1
        print(f"[restore] --force：跳过异常条目，继续处理 {len(entries)} 条")
    # 同 key 重复条目 → 后者覆盖（防同一条被写两次导致计数虚报）
    deduped = {e["key"]: e for e in entries}
    if len(deduped) != len(entries):
        print(f"[restore] 备份含同 key 重复条目 {len(entries) - len(deduped)} 条，已按后者取值")
    entries = list(deduped.values())
    if not entries:
        print("[restore] 备份文件无可写入条目。")
        return 1

    # 范围守卫：备份不得夹带技能范围外的 key（否则会静默覆盖本机其他项目记忆）
    strays = out_of_scope_keys(entries)
    if strays and not args.force:
        print(
            f"[restore] 拒绝执行：备份含 {len(strays)} 条技能范围外的 key"
            f"（非 {SKILL_PREFIX}* 且不在 SKILL_LINKED_KEYS）"
        )
        for k in strays[:10]:
            print(f"  - 越界: {k}")
        if len(strays) > 10:
            print(f"  - ...（其余 {len(strays) - 10} 条略）")
        print("[restore] 确认该备份可信时可加 --force 放行（会覆盖本机同 key 条目）。")
        return 1

    if args.dry_run:
        conn = connect(db)
        try:
            planning = []
            for e in entries:
                row = conn.execute(
                    "SELECT value, updated_at, ttl_expires_at, tags, metadata"
                    " FROM memory WHERE key = ?",
                    (e["key"],),
                ).fetchone()
                if row is None:
                    planning.append(("新增", e["key"]))
                elif not _entry_matches(row, e):
                    planning.append(("更新", e["key"]))
        finally:
            conn.close()
        changes = planning
        print(
            f"[restore] --dry-run：将写入 {len(changes)} 条"
            f"（无变化 {len(entries) - len(changes)} 条），未修改数据库"
        )
        for action, k in changes:
            print(f"  - {action}: {k}")
        return 0

    # 写前快照：把当前库状态落盘，使本次 restore 可回退
    # 命名带毫秒：同一秒内连续 restore 不会互相覆盖（否则回退点会被后一次抹掉）
    snap_dir = Path(__file__).resolve().parent / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    now = time.time()
    stamp = time.strftime("%Y%m%d_%H%M%S", time.localtime(now))
    pre = snap_dir / f"{RESTORE_PRE_SNAPSHOT_PREFIX}{stamp}_{int(now * 1000) % 1000:03d}.json"
    pre_payload = build_snapshot_payload(db)
    if pre_payload is None:
        print("[restore] 警告：当前库无技能相关记忆，跳过写前快照。")
    else:
        pre.write_text(
            json.dumps(pre_payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"[restore] 写前快照: {pre}（可用它回退本次写入）")
        for name in prune_prerestore_snapshots():
            print(f"  - 写前快照超保留上限，清理: {name}")

    conn = connect(db)
    updated, inserted = 0, 0
    try:
        # BEGIN IMMEDIATE：立刻取写锁，使 busy_timeout 对并发写（MCP 等其他进程）真正生效
        conn.execute("BEGIN IMMEDIATE")
        for e in entries:
            cur = conn.execute(
                "SELECT 1 FROM memory WHERE key = ?", (e["key"],)
            ).fetchone()
            if cur is None:
                conn.execute(
                    "INSERT INTO memory"
                    " (key, value, created_at, updated_at, ttl_expires_at, tags, metadata)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (
                        e["key"],
                        e["value"],
                        e["created_at"],
                        e["updated_at"],
                        e["ttl_expires_at"],
                        e["tags"],
                        e["metadata"],
                    ),
                )
                inserted += 1
            else:
                conn.execute(
                    "UPDATE memory SET value=?, updated_at=?, ttl_expires_at=?,"
                    " tags=?, metadata=? WHERE key=?",
                    (
                        e["value"],
                        e["updated_at"],
                        e["ttl_expires_at"],
                        e["tags"],
                        e["metadata"],
                        e["key"],
                    ),
                )
                updated += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(f"[restore] 更新完成：新增 {inserted} 条，更新 {updated} 条（db={db}）")
    print("[restore] FTS 索引由数据库触发器自动维护，无需额外操作")
    return 0


def cmd_verify(args, db):
    src = Path(args.file)
    if not src.exists():
        print(f"[verify] 备份文件不存在: {src}")
        return 1
    payload, err = load_payload(src, "verify")
    if err or payload is None:
        print(err or "[verify] 备份内容为空。")
        return 1
    raw_entries = payload.get("entries", [])
    if not isinstance(raw_entries, list) or len(raw_entries) > MAX_SNAPSHOT_ENTRIES:
        shown = len(raw_entries) if isinstance(raw_entries, list) else type(raw_entries).__name__
        print(f"[verify] 备份条目数异常（{shown}），上限 {MAX_SNAPSHOT_ENTRIES}，拒绝执行。")
        return 1
    entries, problems = validate_entries(raw_entries)
    if problems:
        print(f"[verify] 备份条目异常 {len(problems)} 处（备份不合法，无法比对）:")
        for p in problems[:10]:
            print(f"  - {p}")
        return 1
    # 范围守卫（与 restore 对齐）：备份夹带范围外 key 时，restore 会拒绝 → verify 不应报「一致」
    strays = out_of_scope_keys(entries)
    if strays:
        print(f"[verify] 不一致：备份含 {len(strays)} 条技能范围外的 key（restore 会拒绝该备份）")
        for k in strays[:10]:
            print(f"  - 越界: {k}")
        return 1

    conn = connect(db)
    try:
        db_rows = {
            r[0]: r[1:]
            for r in conn.execute(
                "SELECT key, value, created_at, updated_at, ttl_expires_at, tags, metadata"
                " FROM memory"
            ).fetchall()
        }
        db_skill_keys = set(select_skill_keys(conn))
    finally:
        conn.close()

    backup_keys = {e["key"] for e in entries}
    missing = [e["key"] for e in entries if e["key"] not in db_rows]
    mismatch, meta_diff, tags_diff, created_diff, ttl_diff = [], [], [], [], []
    value_drift, updated_drift = [], []
    for e in entries:
        row = db_rows.get(e["key"])
        if row is None:
            continue
        key = e["key"]
        # row = (value, created_at, updated_at, ttl_expires_at, tags, metadata)
        if row[0] != e["value"]:
            # 仪表盘 value 是活计数器（metrics 每轮叠加）→ 只作漂移提示
            (value_drift if key in VALUE_VOLATILE_KEYS else mismatch).append(key)
        if row[4] != e["tags"]:
            tags_diff.append(key)
        if not metadata_equal(row[5], e["metadata"]):
            meta_diff.append(key)
        if row[1] != e["created_at"]:
            created_diff.append(key)
        if row[3] != e["ttl_expires_at"]:
            ttl_diff.append(key)
        if row[2] != e["updated_at"]:
            updated_drift.append(key)
    # 范围完整性：库内属于技能范围的 key 必须都进过备份（漏一条 = 快照未随库重生成）
    uncovered = sorted(db_skill_keys - backup_keys)

    findings = (
        ("缺失", missing),
        ("值不匹配", mismatch),
        ("tags 不一致", tags_diff),
        ("metadata 不一致（计数三件套以外的字段被改写）", meta_diff),
        ("created_at 差异（不可变字段被改写，需排查写入方）", created_diff),
        ("ttl_expires_at 差异", ttl_diff),
        ("范围未覆盖（库内技能 key 未进备份，请重新 backup）", uncovered),
    )
    if any(keys for _, keys in findings):
        print(
            "[verify] 不一致："
            + "，".join(
                f"{label.split('（')[0]} {len(keys)} 条" for label, keys in findings if keys
            )
        )
        for label, keys in findings:
            for k in keys:
                print(f"  - {label}: {k}")
        return 1
    soft = []
    if value_drift:
        soft.append(f"仪表盘 value 漂移 {len(value_drift)} 条")
    if updated_drift:
        soft.append(f"updated_at 落后 {len(updated_drift)} 条")
    if soft:
        print(
            f"[verify] 一致（语义）：备份 {len(entries)} 条与库匹配；"
            + "，".join(soft)
            + " —— runtime 回写（touch/metrics）所致，非错误；如需快照对齐请重新 backup"
        )
        print("  注：restore 按备份值精确写入，会把这部分计数/仪表盘回退到快照时刻（可先 --dry-run 查看）")
        return 0
    print(f"[verify] 一致：备份 {len(entries)} 条全部与数据库匹配（db={db}）")
    return 0


def cmd_touch(args, db):
    """Memory 消费回写（确定性执行）。

    不变量（与 Skill 的「记忆访问计数与元数据协议」一致）：
      - value 不改（只动 metadata / updated_at / ttl_expires_at）
      - metadata 其余字段（title / note / relevance_score 等）原样保留
      - tags 列不触碰（避免整体替换语义导致 tag 丢失）
      - 有限 TTL 按「剩余时长」重锚，防续期漂移

    逐 key 容错：单条 metadata 畸形（非 JSON / 非对象 / access_count 非数字）只跳过该条，
    不拖垮整批（原实现会裸抛异常 + 整批回滚，且不指出是哪条 key）。
    """
    conn = connect(db)
    now_ms = int(time.time() * 1000)
    touched, missing, failed = [], [], []
    try:
        # BEGIN IMMEDIATE：立刻取写锁，使 busy_timeout 对并发写（MCP 等其他进程）真正生效
        conn.execute("BEGIN IMMEDIATE")
        for k in args.keys:
            row = conn.execute(
                "SELECT metadata, ttl_expires_at FROM memory WHERE key = ?", (k,)
            ).fetchone()
            if row is None:
                missing.append(k)
                continue
            try:
                meta = json.loads(row[0]) if row[0] else {}
                if not isinstance(meta, dict):
                    raise ValueError(f"metadata 不是 JSON 对象（实际 {type(meta).__name__}）")
                meta["access_count"] = int(meta.get("access_count") or 0) + 1
                if args.hit:
                    meta["cache_hit_count"] = int(meta.get("cache_hit_count") or 0) + 1
                # TTL 绝对值保持不变（既不续期也不提前过期）；非数字 → 视为畸形条目
                ttl = int(row[1]) if row[1] is not None else None
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                failed.append((k, f"{type(e).__name__}: {e}"))
                continue
            conn.execute(
                "UPDATE memory SET metadata=?, updated_at=?, ttl_expires_at=?"
                " WHERE key=?",
                (json.dumps(meta, ensure_ascii=False), now_ms, ttl, k),
            )
            touched.append(
                "{k} (access={a}, hit={h})".format(
                    k=k, a=meta["access_count"], h=meta.get("cache_hit_count", "-")
                )
            )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"[touch] 数据库错误：{e}")
        return 1
    finally:
        conn.close()
    for t in touched:
        print(f"[touch] {t}")
    if missing:
        print(f"[touch] 未找到（跳过 {len(missing)} 条）: {', '.join(missing)}")
    if failed:
        print(f"[touch] metadata 异常（跳过 {len(failed)} 条）:")
        for k, err in failed:
            print(f"  - {k}: {err}")
    return 0 if touched else 1


# (argparse dest, 仪表盘分组, 字段名, 是否计入该组「事件数」)
# 事件数只统计该组的主计数器——by_user/by_level 是 total 的子集，budget_hits / memory_hits 是 searches
# 的子集，不可重复计入（否则显示「事件: {conflict: 2}」这类子集/超集混淆）。
#
# retrieval 组两个「率」不可混用（曾因手工把命中率写进 hit_rate 字段导致口径互踩）：
#   budget_hits      → hit_rate：检索「在红线预算内完成」的比率（Agent 行为配额合规）
#   memory_hits      → memory_hit_rate：检索「确有召回结果」的比率（召回有效性）
#   两者都由 Tool 重算；降级路径禁止手写任何 rate（见 learning/skill-metrics.md）
METRIC_FIELDS = [
    ("conflict", "conflict", "total", True),
    ("by_user", "conflict", "by_user", False),
    ("by_level", "conflict", "by_level", False),
    ("retrieval", "retrieval", "searches", True),
    ("budget_hit", "retrieval", "budget_hits", False),
    ("memory_hit", "retrieval", "memory_hits", False),
    ("over_budget", "retrieval", "over_budget", False),
    ("auto_generated", "auto_rule", "generated", True),
    ("auto_promoted", "auto_rule", "promoted", True),
    ("auto_demoted", "auto_rule", "demoted", True),
    ("auto_deleted", "auto_rule", "deleted", True),
    ("auto_pending", "auto_rule", "pending", True),
    ("rollback", "rollback", "count", True),
    ("skeleton_entries", "skeleton", "entries", True),
    ("skeleton_bytes", "skeleton", "bytes_saved", False),
]

# 分组事件备注模板（0 事件也显式标注，防「只抄旧值 + 只改 note」）
NOTE_MAP = {
    "conflict": "本轮 {n} 冲突事件",
    "retrieval": "本轮 {n} 次记忆检索",
    "auto_rule": "本轮 {n} 观察期事件",
    "rollback": "本轮 {n} 回滚事件",
    "skeleton": "本轮 {n} 骨架化事件",
}


def _recount_memory(conn):
    """机械重算 memory.* 条目计数。

    口径（与仪表盘字段语义对齐，勿混用）：
      - `total_entries`：全库行数
      - `lesson/pattern/principle/reflection_count`：按 key 前缀统计（三层体系 + reflection）
      - `zero_access_entries`：**仅三层体系**（lesson / pattern / principle / reflection）中 access_count=0 的条数
        —— 同基线语义。**不按全库统计**：全库含大量从未消费的 project:/rule: 条目，
        会让该字段恒超其 `>5` 触发线，失去「存而不用」的预警意义。
    """
    exp_prefixes = (
        ("lesson:", "lesson_count"),
        ("pattern:", "pattern_count"),
        ("principle:", "principle_count"),
        ("reflection:", "reflection_count"),
    )
    counts = {
        "total_entries": 0,
        "lesson_count": 0,
        "pattern_count": 0,
        "principle_count": 0,
        "reflection_count": 0,
        "zero_access_entries": 0,
        "note": "由 memory_tool metrics --counts 机械重算（zero_access 限三层体系，不含 rule:/project:）",
    }
    for key, meta in conn.execute("SELECT key, metadata FROM memory").fetchall():
        counts["total_entries"] += 1
        is_experience = False
        for prefix, field in exp_prefixes:
            if key.startswith(prefix):
                counts[field] += 1
                is_experience = True
        if not is_experience:
            continue
        try:
            d = json.loads(meta) if meta else {}
        except (json.JSONDecodeError, TypeError, ValueError):
            d = {}
        if not isinstance(d, dict):
            d = {}
        try:
            access = int(d.get("access_count") or 0)
        except (TypeError, ValueError):
            access = 0  # 畸形 access_count 记为 0（计入「存而不用」而非打挂整个统计）
        if access == 0:
            counts["zero_access_entries"] += 1
    return counts


def cmd_metrics(args, db):
    """仪表盘 upsert（确定性执行）：读取 → 叠加本轮 delta → 完整回写。

    不变量：value 内未触及字段（memory.* / verify.* 等）原样保留；tags / metadata 原样保留；
    hit_rate / memory_hit_rate 分别由 budget_hits / memory_hits 除以 searches 重算（口径独立）；
    有限 TTL 按剩余时长重锚。
    """
    conn = connect(db)
    now_ms = int(time.time() * 1000)
    events: dict = {}
    warn: list = []
    try:
        # 读改写同一事务（BEGIN IMMEDIATE 前置）：立刻取写锁，
        # 使 busy_timeout 对并发写（delx-memory MCP 等其他进程）真正生效，防互相覆盖
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT value, ttl_expires_at FROM memory WHERE key = ?", (DASHBOARD_KEY,)
        ).fetchone()
        if row is None:
            conn.rollback()
            print(f"[metrics] 仪表盘条目不存在: {DASHBOARD_KEY}（请先在 delx-memory 创建）")
            return 1
        val = json.loads(row[0]) if row[0] else {}
        if not isinstance(val, dict):
            conn.rollback()
            print(
                f"[metrics] 仪表盘 value 不是 JSON 对象（实际 {type(val).__name__}），"
                "拒绝写入以免覆盖"
            )
            return 1
        events = {}
        for dest, group, field, primary in METRIC_FIELDS:
            n = getattr(args, dest, None)
            if not n:
                continue
            grp = val.setdefault(group, {})
            grp[field] = int(grp.get(field) or 0) + int(n)
            if primary:
                events[group] = events.get(group, 0) + int(n)
        r = val.setdefault("retrieval", {})
        try:
            s = int(r.get("searches") or 0)
            bh = int(r.get("budget_hits") or 0)
            mh = int(r.get("memory_hits") or 0)
        except (TypeError, ValueError):
            conn.rollback()
            print(
                "[metrics] retrieval 计数非数字（searches / budget_hits / memory_hits），"
                "拒绝写入（请先修正仪表盘）"
            )
            return 1
        # 两个率口径独立重算，互不替代（语义见 METRIC_FIELDS 注释）
        for field, value, label in (
            ("hit_rate", bh, "budget_hits"),
            ("memory_hit_rate", mh, "memory_hits"),
        ):
            if s <= 0:
                r[field] = 0  # searches=0 → 比率无意义；置 0，不留旧值
            elif value > s:
                r[field] = 1.0  # 子集不可能超过总数 → 裁剪并告警
                warn.append(f"{label}({value}) > searches({s})，{field} 已裁剪为 1.0")
            else:
                r[field] = round(value / s, 3)
        for group, tpl in NOTE_MAP.items():
            grp = val.get(group)
            if isinstance(grp, dict):
                grp["note"] = tpl.format(n=events.get(group, 0))
        if args.counts:
            val["memory"] = _recount_memory(conn)
        if args.note:
            val["note"] = args.note
        ttl = int(row[1]) if row[1] is not None else None  # TTL 绝对值保持不变
        conn.execute(
            "UPDATE memory SET value=?, updated_at=?, ttl_expires_at=? WHERE key=?",
            (json.dumps(val, ensure_ascii=False), now_ms, ttl, DASHBOARD_KEY),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(f"[metrics] 仪表盘已更新（事件: {events if events else '本轮 0 事件'}）")
    for w in warn:
        print(f"[metrics] 警告：{w}")
    print(
        "  conflict={c} | retrieval={s}(budget {h} / memory {mh}) | auto_pending={ap}"
        " | rollback={rb} | skeleton={sk}e/{sb}B".format(
            c=val.get("conflict", {}).get("total"),
            s=r.get("searches"),
            h=r.get("hit_rate"),
            mh=r.get("memory_hit_rate"),
            ap=val.get("auto_rule", {}).get("pending"),
            rb=val.get("rollback", {}).get("count"),
            sk=val.get("skeleton", {}).get("entries"),
            sb=val.get("skeleton", {}).get("bytes_saved"),
        )
    )
    return 0


def cmd_list(args, db):
    conn = connect(db)
    try:
        keys = select_skill_keys(conn)
    finally:
        conn.close()
    print(f"数据库: {db}")
    print(f"技能相关记忆: {len(keys)} 条")
    for k in keys:
        print(f"  - {k}")
    return 0


# ============================================================================
# maintenance: check-keys —— 映射表声明的 key 是否真实存在
# ============================================================================
#
# 用途：供 smoke-check 的 governance 映射一致性检查调用。把「映射表里写的 key」
# 从**声明**变成**可校验事实** —— 规则条目改名/删除后映射表未同步，是最常见的
# 死指针来源（改名后只改一处，其余引用静默存活多轮）。
#
# 输入行格式（制表符分隔，类型可省略）：
#   <key>                → 只校验存在性
#   <key>\t<canonical>   → 额外校验：canonical ≠ 数据 时 tags 必须含 permanent
#
# 为什么不变量是「permanent」：Canonical 类型 A/C 表示该条目承担规则事实源职责，
# 一旦带 TTL，到期后规则会**凭空消失**并静默降级到文件内摘要 —— 属于不可接受的失效模式。
# 数据条目（仪表盘 / 回滚锚点）不参与此约束。
#
# 输出：每行一个违规项，前缀 `MISSING\t` 或 `NOT_PERMANENT\t`。
# 退出码：0 = 全部通过；4 = 有违规；3 = 输入问题。

CANONICAL_DATA = "数据"


def cmd_check_keys(args, db):
    raw = []
    if args.files:
        for f in args.files:
            try:
                raw.extend(Path(f).read_text(encoding="utf-8").splitlines())
            except OSError as e:
                print(f"[KEYS_CHECK_INPUT_MISSING] 无法读取 {f}: {e}")
                print("[next] 确认 key 清单文件路径后重试，或改用 stdin 逐行输入。")
                return 3
    else:
        raw.extend(sys.stdin.read().splitlines())

    pairs = {}
    for line in raw:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        key = parts[0].strip()
        ctype = parts[1].strip() if len(parts) > 1 else ""
        if key:
            pairs[key] = ctype

    if not pairs:
        print("[KEYS_CHECK_INPUT_MISSING] 未收到任何 key")
        print("[next] 经 stdin 逐行传入 `key` 或 `key<TAB>类型`，或用 --files 指定清单文件。")
        return 3

    uniq = sorted(pairs)
    conn = connect(db)
    try:
        placeholders = ",".join("?" * len(uniq))
        found = {
            r[0]: (r[1] or "")
            for r in conn.execute(
                f"SELECT key, tags FROM memory WHERE key IN ({placeholders})", tuple(uniq)
            ).fetchall()
        }
    finally:
        conn.close()

    problems = 0
    for k in uniq:
        if k not in found:
            print(f"MISSING\t{k}")
            problems += 1
            continue
        ctype = pairs[k]
        if ctype and ctype != CANONICAL_DATA:
            if "permanent" not in found[k]:
                print(f"NOT_PERMANENT\t{k}（canonical={ctype}，tags 无 permanent）")
                problems += 1

    if problems:
        return 4
    if not args.quiet:
        typed = sum(1 for v in pairs.values() if v)
        print(f"  ✓ {len(uniq)} 个声明 key 全部存在（其中 {typed} 个带 Canonical 类型并满足 TTL 不变量）")
    return 0


# ============================================================================
# runtime: preflight —— 加载计划（一次调用替代 N 次导航读取）
# ============================================================================
#
# 设计要点（对齐 dsh-ops 的「渐进式披露 + 动态渲染」）：
#   1. 章节索引在**运行时扫描生成**，不写死行号 —— 行号漂移不会造成死指针
#   2. 输出有界：章节数、key 数均有上限，超出显式标注（不静默截断）
#   3. **只回 key 名与计数，不回 value** —— 遵守 engine/state-machine.md
#      「Memory ≠ Context」硬约束（记忆按需检索命中才进入上下文）
#
# 加载清单事实源 = SKILL.md「加载时机索引」+「分级加载」表；
# backup/load_plan.json 是等价机器副本（冲突以 SKILL.md 为准）。

LOAD_PLAN_NAME = "load_plan.json"
FRONTMATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.S)
DIGEST_RE = re.compile(r"^digest:\s*(.+)$", re.M)
HEADING_RE = re.compile(r"^(#{2,3})\s+(.+?)\s*$")
MAX_HEADINGS_PER_FILE = 14
PREFLIGHT_KEY_CAP = 60
DEFAULT_INDEX_MIN_LINES = 120  # 小于此值不出章节索引（小文件直接整读；索引本身也是上下文成本）
# 阶段合法域 = engine/transition.md 的 H2 阶段号全集（S1–S13）。manifest 另声明 S14:safe-mode
# ＝止血档（无 sections / 不属 level_stages，不可加载），故拒绝 S14 为正确行为。
# 校验防 --stage S99/S08/8
# 静默把 transition.md 机械分支砍到只剩 VC 节（86% 裁剪无提示的欠读事故，审查 P1）
KNOWN_STAGE_MAX = 13
STAGE_TOKEN_RE = re.compile(r"^\^?S(\d+)$")


def skill_root():
    """技能根目录（memory_tool.py 位于 backup/ 下）。"""
    return Path(__file__).resolve().parent.parent


def load_plan_path():
    """加载计划：技能根优先，回退 backup/（兼容旧布局）。"""
    for p in (skill_root() / LOAD_PLAN_NAME, Path(__file__).resolve().parent / LOAD_PLAN_NAME):
        if p.exists():
            return p
    return None


def read_load_plan():
    p = load_plan_path()
    if p is None:
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


_READ_CACHE = {}


def _read_text_cached(path):
    """读文件文本，按 (path, mtime_ns, size) 记忆化。

    同一轮 preflight 内 `file_stats` / `read_sections` / 前言判据 / 成本统计**共享同一快照**：
    每个文件从 4 次读盘降为 1 次，并消除「两次读之间文件被改」导致的跨度与提示不一致
    （审查 LOW-3 / D25 的理论 TOCTOU）。缓存按轮清理（`_READ_CACHE.clear()`），不跨调用复用。
    """
    try:
        st = path.stat()
    except OSError:
        return None
    key = (str(path), st.st_mtime_ns, st.st_size)
    if key in _READ_CACHE:
        return _READ_CACHE[key]
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    _READ_CACHE[key] = text
    return text


def _truncate(s, n):
    s = s.strip()
    return s if len(s) <= n else s[: n - 1] + "…"


FRONTMATTER_MAX_LINES = 40  # 第 2 个 --- 超过此行数 → 判为"整文件被首尾 --- 包裹"（如 .state.md），不当作 frontmatter


def _frontmatter_end(lines):
    """frontmatter 结束行号（正文起点）；首行 --- 且第 2 个 --- 出现在前 40 行内才算。

    防整文件被当成一个 frontmatter（.state.md 实例首尾各一个 ---，贪婪匹配会把全文吞掉，
    导致 digest/headings 全空）。"""
    if not lines or lines[0].strip() != "---":
        return 0
    for i in range(1, min(len(lines), FRONTMATTER_MAX_LINES)):
        if lines[i].strip() == "---":
            return i + 1
    return 0


def file_stats(rel):
    """返回 (行数, 字符数, digest, headings, sections_overflow)；文件缺失返回 None。

    章节索引跳过围栏代码块内的 `#` 行（否则 shell/代码示例会被误判为标题）。
    digest 回退链（避免"人工维护但没人维护"）：frontmatter `digest:` → H1 标题 → 正文首行散文。
    `sections_overflow` = 被上限截断的章节数（>0 时调用方必须显式标注，不静默丢弃）。
    """
    path = skill_root() / rel
    text = _read_text_cached(path)
    if text is None:
        return None
    lines = text.splitlines()
    digest = ""
    body_start = _frontmatter_end(lines)  # 正文起始行号（防 `type: note` 被当成摘要回退）
    if body_start:
        fm_text = "\n".join(lines[:body_start])
        dm = DIGEST_RE.search(fm_text)
        if dm:
            digest = dm.group(1).strip().strip('"').strip("'")

    all_headings = []
    in_fence = False
    fallback = ""
    h1 = ""
    for i, line in enumerate(lines, 1):
        if i <= body_start:
            continue
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if stripped.startswith("# ") and not h1:
            h1 = stripped[2:].strip()
            continue
        hm = HEADING_RE.match(line)
        if hm:
            all_headings.append((_truncate(hm.group(2), 26), i))
            continue
        if not fallback and stripped and not stripped.startswith(("|", "-", ">", "#", "---", "tags:")):
            fallback = stripped

    if not digest:
        # 优先 H1 标题（准确且零维护），其次正文首行散文
        base = h1 or fallback
        base = re.sub(r"\s*[（(]骨架版[）)]\s*$", "", base)
        digest = _truncate(base, 72) if base else "(无 digest)"
    sections_overflow = max(0, len(all_headings) - MAX_HEADINGS_PER_FILE)
    return len(lines), len(text), digest, all_headings[:MAX_HEADINGS_PER_FILE], sections_overflow


def read_sections(rel):
    """H2 章节 + 行号跨度 → [(title, start_line, end_line, lines)]；无章节返回 []。

    只认 H2（H3 归入其父节，避免跨度重叠导致重复计行）；跳过围栏代码块内的 `##`。"""
    path = skill_root() / rel
    text = _read_text_cached(path)
    if text is None:
        return []
    lines = text.splitlines()
    body = _frontmatter_end(lines)
    idx, in_fence = [], False
    for i, l in enumerate(lines):
        if i < body:
            continue
        s = l.strip()
        if s.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if l.startswith("## "):
            idx.append((i, l[3:].strip()))
    return [
        (t, i + 1, (idx[k + 1][0] if k + 1 < len(idx) else len(lines)), (idx[k + 1][0] if k + 1 < len(idx) else len(lines)) - i)
        for k, (i, t) in enumerate(idx)
    ]


def _preamble_meaningful_lines(rel):
    """首个 H2 之前的**实质行**数（排除 frontmatter / 空行 / H1 / 围栏标记与围栏内行）。

    用于「前言未列入命中集」提示的判据：0 = 该文件没有需要补读的前言（不提示）。
    """
    path = skill_root() / rel
    text = _read_text_cached(path)
    if text is None:
        return 0
    lines = text.splitlines()
    body = _frontmatter_end(lines)
    count, in_fence = 0, False
    for i, l in enumerate(lines):
        if i < body:
            continue
        s = l.strip()
        if l.startswith("## "):
            break
        if s.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not s or l.startswith("# "):
            continue
        count += 1
    return count


TRANS_STAGE_RE = re.compile(r"^S(\d+)\b")
TRANS_ALWAYS_SUBSTR = "VC 错误码族"


def select_sections(rel, sections, plan, stages):
    """按阶段裁剪章节。返回 (pairs, mode)：pairs = [(stage_label, section), ...]（按 stage 序去重）。

    mode = 'partial' | 'whole'。整文件（whole）在以下任一情形成立（**fail-safe 优先**）：
      ① 文件在 `always_whole`；② 无 `stage_sections` 映射；③ 无章节；④ 无 stages（无 Level 信息）；
      ⑤ 某个已映射阶段的**任一**子串未命中真实章节标题（映射可能失效 → 宁可整读，不静默漏读）。
         粒度是「任一」而非「全部」：只在全部未命中时回退会把**部分**失效变成静默丢节。
    """
    if not sections or not stages or rel in (plan.get("always_whole") or []):
        return [], "whole"

    if rel == "engine/transition.md":
        # 标题自带阶段号 → 机械匹配，无需人工映射维护；VC 码表恒含（每阶段出口都可能用到）。
        # fail-safe：仅命中 VC 节（无任何 S<n> 节）= 阶段号与标题全未对上 → 回退整文件，
        # 不拿 34 行的码表切片冒充该文件的可用内容（审查 P1：静默砍 86% 无提示）。
        pairs, seen, stage_hit = [], set(), False
        for st in stages:
            n = st[1:] if st.startswith("S") else ""
            for s in sections:
                m = TRANS_STAGE_RE.match(s[0])
                if (m and m.group(1) == n) or TRANS_ALWAYS_SUBSTR in s[0]:
                    if s[1] not in seen:
                        seen.add(s[1])
                        pairs.append((st if m and m.group(1) == n else "all", s))
                    if m and m.group(1) == n:
                        stage_hit = True
        if not stage_hit:
            return [], "whole"
        return pairs, "partial"

    smap = (plan.get("stage_sections") or {}).get(rel)
    if not smap:
        return [], "whole"

    pairs, seen, missed = [], set(), False
    for st in stages:
        pats = smap.get(st)
        if not pats:
            continue
        # 逐子串判定：任一 pattern 未命中即视映射可能失效 → 该文件回退整文件。
        # 原实现只在「该阶段全部子串都未命中」时回退，导致**部分**失效时静默丢节
        # （实测：改名单个映射节 → 命中集静默少 20 行且无提示）；方向恒为过读，安全侧。
        if any(not any(p in s[0] for s in sections) for p in pats):
            missed = True
        hit = [s for s in sections if any(p in s[0] for p in pats)]
        for s in hit:
            if s[1] not in seen:
                seen.add(s[1])
                pairs.append((st, s))
    if missed or not pairs:
        return [], "whole"
    return pairs, "partial"


def resolve_stages(plan, level, explicit=None):
    """解析阶段集。返回 (stages, note)——note 为给 Agent 的收窄提示行（可为 None）。

    语义：
      - 缺省：level_stages[level] 原样返回
      - `S8,S9`   → 只保留所列（收窄重读）
      - `^S3`     → 从默认集**排除**（免手抄全清单；手抄漏 S13 = 静默裁掉收尾义务）
      - 两种语法不得混用
    校验：token 必须形如 S<n>/^S<n> 且 1≤n≤KNOWN_STAGE_MAX；
    非法 → ValueError（cmd 层转 [INVALID_ARGUMENT] exit 3，fail closed 不静默忽略）。
    """
    default = (plan or {}).get("level_stages", {}).get(str(level)) or []
    if not isinstance(default, list):
        # 守卫：level_stages 的值必须是阶段列表（防注释键/畸形计划被当阶段集逐字符展开）
        raise ValueError(f"level_stages[{level!r}] 不是阶段列表（得到 {type(default).__name__}）")
    if not explicit:
        return list(default), None
    stages, excludes, bad = [], [], []
    for tok in (t.strip().upper() for t in explicit.split(",") if t.strip()):
        m = STAGE_TOKEN_RE.match(tok)
        n = m.group(1) if m else ""
        # n != str(int(n))：拒绝非规范写法（S08 这类前导零——拼写事故不静默当 S8 处理）
        if not m or n != str(int(n)) or not (1 <= int(n) <= KNOWN_STAGE_MAX):
            bad.append(tok)
        elif tok.startswith("^"):
            excludes.append("S" + m.group(1))
        else:
            stages.append("S" + m.group(1))
    if bad:
        raise ValueError(
            f"非法阶段 token: {', '.join(bad)}（合法 S1–S{KNOWN_STAGE_MAX}；排除用 ^S<n>）"
        )
    if excludes and stages:
        raise ValueError("排除（^S<n>）与列举（S<n>）不得混用；排除法基于 --level 默认集")
    if not stages and not excludes:
        raise ValueError("--stage 未给出有效阶段（空列表）")
    if excludes:
        if not default:
            raise ValueError("^ 排除语法需要 --level 的默认阶段集（level_stages 缺该 level）")
        order = lambda s: int(s[1:])
        stages = sorted((s for s in default if s not in excludes), key=order)
        if not stages:
            raise ValueError("排除后阶段集为空")
        note = "从默认集排除: " + ", ".join(f"^{s}" for s in sorted(excludes, key=order))
        noop = [s for s in excludes if s not in default]
        if noop:
            note += f"（其中 {', '.join(noop)} 本不在默认集，为 no-op）"
        if "S13" in excludes:
            note += "（含 S13 收尾义务被排除，除单阶段重读外须补回）"
        return stages, note + "；需要被排除阶段的内容时重跑 preflight 补回"
    # 列举法收窄：提示默认集里被裁掉的阶段（S13 漏掉 = 收尾义务被静默跳过，须显式可见）
    dropped = [s for s in default if s not in stages]
    note = None
    if dropped:
        note = f"收窄（列举法）：默认集未含 {', '.join(dropped)}"
        if "S13" in dropped:
            note += " —— 含 S13（收尾义务）被裁掉，除单阶段重读外须补回"
    return sorted(set(stages), key=lambda s: int(s[1:])), note


def resolve_plan(plan, level, task):
    """按 level + task 解析文件清单（保序去重）。"""
    out = []
    seen = set()

    def add(items):
        for rel in items or []:
            if rel not in seen:
                seen.add(rel)
                out.append(rel)

    add(plan.get("core"))
    add((plan.get("levels") or {}).get(str(level)))
    for key in (task or "").split(","):
        key = key.strip()
        if key:
            add((plan.get("profiles") or {}).get(key))
    return out


def cmd_preflight(args, db):
    """打印加载计划 + 成本 + 章节索引 + 记忆候选（只回 key，不回 value）。

    退出码：0 = 正常；3 = 无可用加载计划（fail closed，不静默降级到"残缺清单"继续推断）。
    `--files` 显式指定时**不依赖** load_plan.json（计划缺失时的唯一恢复路径）。
    """
    _READ_CACHE.clear()  # 缓存按轮隔离：跨调用复用会读到陈旧文本
    if args.files:
        files = [f.strip() for f in args.files.split(",") if f.strip()]
        source = "--files 显式指定"
        plan = None
    else:
        plan = read_load_plan()
        if plan is None:
            # 码语义：RULE_STORE_MISSING 专指"已下沉的 skill:* 条目不可用"（见 engine/transition.md）；
            # 计划文件缺失属加载计划域，用独立码，与 smoke-check 的 LOAD_PLAN_* 同族
            print("[LOAD_PLAN_MISSING] backup/load_plan.json 缺失或不可解析。")
            print("[next] 从 git 恢复 load_plan.json；临时应急可改用 --files 显式给出加载清单。")
            return 3
        # 元键（_note 等，前缀 _）不是 level —— 曾因未过滤导致 `--level _note` 取到字符串注释键、
        # list(str) 逐字符成阶段集 → 只载 core 三文件，静默欠读且 exit 0（审查 P1，与 P0 同族）
        known_levels = sorted(
            k for k in (set((plan.get("levels") or {}).keys())
                        | set((plan.get("level_stages") or {}).keys()))
            if not k.startswith("_")
        )
        if args.level not in known_levels:
            # 与 --stage 同策略 fail closed：level 拼错曾静默关闭全部按阶段裁剪且 exit 0
            print(
                f"[INVALID_ARGUMENT] --level {args.level!r} 不在加载计划内"
                f"（合法值: {', '.join(known_levels)}）"
            )
            print(f"[next] 修正 --level（{' / '.join(known_levels)}），或改用 --files 显式给出清单。")
            return 3
        # P1（第五轮）：--task 无校验时拼错会静默丢掉 profile 文件集（exit 0 且原样回显错拼）
        known_tasks = sorted(k for k in (plan.get("profiles") or {}) if not k.startswith("_"))
        bad_tasks = [
            tok for tok in (t.strip() for t in (args.task or "").split(","))
            if tok and tok not in known_tasks
        ]
        if bad_tasks:
            print(
                f"[INVALID_ARGUMENT] --task 不在加载计划内: {', '.join(bad_tasks)}"
                f"（合法值: {', '.join(known_tasks)}）"
            )
            print(f"[next] 修正 --task（{' / '.join(known_tasks)}，多个用逗号），或省略该参数。")
            return 3
        files = resolve_plan(plan, args.level, args.task)
        if files == list(plan.get("core") or []):
            # 运行期提示：level 无文件条目时只会得到 core 3 文件（过读侧无害，但须可见）
            print(f"  ⚠ level={args.level} 在加载计划中无文件条目 —— 本次仅加载 core（{len(files)} 文件）")
        source = f"load_plan.json (level={args.level} task={args.task or '-'})"

    index_min = int(
        (plan.get("index_min_lines") if plan else None) or DEFAULT_INDEX_MIN_LINES
    )
    if args.stage is not None and not args.stage.strip():
        # 与 `--stage ,`（空 token → 报错）口径统一；None（未提供）才走默认集
        print("[INVALID_ARGUMENT] --stage 为空字符串（如需默认阶段集请省略该参数）")
        print("[next] 省略 --stage 用默认集；收窄用 S8（只此阶段）或 ^S3（从默认集排除）。")
        return 3
    try:
        stages, stage_note = resolve_stages(plan, args.level, args.stage or None)
    except ValueError as e:
        print(f"[INVALID_ARGUMENT] --stage 解析失败：{e}")
        print("[next] 修正 token（S1–S13；排除用 ^S<n>，如 --stage ^S3）后重试。")
        return 3

    rows, missing = [], []
    total_lines = total_chars = hit_lines = hit_chars = 0
    for rel in files:
        st = file_stats(rel)
        if st is None:
            missing.append(rel)
            continue
        nlines, nchars, digest, headings, overflow = st
        pairs, mode = select_sections(rel, read_sections(rel), plan or {}, stages)
        sel_lines = sum(s[3] for _, s in pairs) if mode == "partial" else nlines
        sel_chars = int(nchars * sel_lines / nlines) if nlines else 0
        rows.append((rel, nlines, nchars, digest, headings, overflow, pairs, mode, sel_lines, sel_chars))
        total_lines += nlines
        total_chars += nchars
        hit_lines += sel_lines
        hit_chars += sel_chars

    print(f"📋 Preflight 加载计划")
    print(f"  来源: {source}")
    if stages:
        if args.files:
            # plan=None，但 engine/transition.md 的机械分支不依赖 plan → 该文件仍按阶段裁剪（混合模式）
            print(f"  阶段: {' '.join(stages)}（--files 模式：仅 engine/transition.md 依 `S<n>` 机械匹配裁剪，其余文件整读）")
        else:
            print(f"  阶段: {' '.join(stages)}（按阶段裁剪章节；--stage 可收窄：S8=只此阶段，^S3=从默认集排除）")
        if stage_note:
            print(f"  ⚠ {stage_note}")
    elif args.files:
        print("  阶段: 未指定（--files 模式无加载计划 → 不按阶段裁剪，实际全部整文件）")
    else:
        print(f"  阶段: 未指定（level={args.level} 在 level_stages 无配置）→ 全部整文件；可用 --stage 显式给出")
    print(f"  数据库: {db}")
    print()

    if missing:
        for rel in missing:
            print(f"  ✗ [RULE_NOT_FOUND] 清单内文件缺失: {rel}")
        print("  → [next] 加载计划与磁盘不一致；恢复文件或修正 load_plan.json 后重试（不降级继续）。")
        print()

    print("【加载清单 · 行号为运行时实测；标「命中」的文件按阶段只读所列节】")
    for rel, nlines, nchars, digest, headings, overflow, pairs, mode, sel_lines, sel_chars in rows:
        if mode == "partial":
            save = 100 - (100 * sel_lines // nlines) if nlines else 0
            print(f"  {rel}  ({nlines} 行 → 命中 {sel_lines} 行, 省 {save}%)")
            seg = " · ".join(f"{st}→L{s[1]}-{s[2]}" for st, s in pairs)
            print(f"      节: {_truncate(seg, 200)}")
            if len(seg) > 200:
                print(f"      [OUTPUT_LIMIT] 命中节列表已截断显示；完整跨度用 read 该文件查看")
        else:
            print(f"  {rel}  ({nlines} 行, 整文件)")
            print(f"      {digest}")
            if nlines >= index_min and headings:
                idx = " · ".join(f"L{ln} {t}" for t, ln in headings)
                print(f"      章节: {_truncate(idx, 260)}")
                if len(idx) > 260:
                    print(f"      [OUTPUT_LIMIT] 章节标题超长已截断显示；完整标题 read 该文件可见")
                if overflow:
                    print(f"      [OUTPUT_LIMIT] 章节索引仅显示前 {len(headings)} 节，另有 {overflow} 节（read 该文件可见）")
    # 前言（首个 H2 之前）不在命中节内。仅当存在**实质行**（排除 frontmatter/空行/H1/围栏）时提示——
    # 原判定 `min(start)-1 >= 3` 被 frontmatter 计入而恒真（恒触发=噪音，审查 P2）。
    pre_files = [
        r[0] for r in rows
        if r[7] == "partial" and r[6] and _preamble_meaningful_lines(r[0]) > 0
    ]
    if pre_files:
        print(f"  （前言（首个 H2 之前）未列入命中集: {', '.join(pre_files)}——需要时按 read 补读，行范围见各文件）")
    print()

    # 成本对比口径 = 与 smoke-check「规则文件合计」一致：
    # .md + .yaml，排除 .state.md（实例，防"实例增长被误报成规则膨胀"，见 lesson:checkpoint-instance-growth）、
    # CHANGELOG、backup/、scripts/、.git/
    grand_lines = 0
    for p in sorted(skill_root().rglob("*")):
        if p.suffix not in (".md", ".yaml", ".yml") or not p.is_file():
            continue
        s = str(p.relative_to(skill_root()))
        if (
            s == ".state.md"
            or s == "CHANGELOG.md"
            or s.startswith(("backup", "scripts", ".git"))
        ):
            continue
        _text = _read_text_cached(p)
        if _text is not None:
            grand_lines += len(_text.splitlines())
    pct = (100 * hit_lines // grand_lines) if grand_lines else 0
    print(
        f"【成本】整文件口径 {len(rows)} 文件 / {total_lines} 行 / {total_chars} 字符"
        f"  →  按阶段命中 {hit_lines} 行 / {hit_chars} 字符"
        f"（省 {100 - (100 * hit_chars // total_chars) if total_chars else 0}%；字符按行占比折算，行数为实测）"
    )
    print(f"         全量规则 {grand_lines} 行（.md+.yaml，不含 .state.md 实例）  |  命中占比 {pct}%")
    print()

    # 记忆候选：只列 key 与计数，不注入 value（Memory ≠ Context 硬约束）
    conn = connect(db)
    try:
        rule_keys = [
            r[0]
            for r in conn.execute(
                "SELECT key FROM memory WHERE key LIKE ? ORDER BY key", ("skill:rules/%",)
            ).fetchall()
        ]
        counts = {}
        for prefix in ("lesson", "reflection", "pattern", "principle", "experience", "project"):
            counts[prefix] = conn.execute(
                "SELECT COUNT(*) FROM memory WHERE key LIKE ?", (prefix + ":%",)
            ).fetchone()[0]
    finally:
        conn.close()

    print("【规则条目候选 · 命中域才 memory_get】")
    if rule_keys:
        for k in rule_keys[:PREFLIGHT_KEY_CAP]:
            print(f"  - {k}")
        if len(rule_keys) > PREFLIGHT_KEY_CAP:
            print(f"  … 另有 {len(rule_keys) - PREFLIGHT_KEY_CAP} 条（超出显示上限，用 memory_list 取全量）")
    else:
        print("  （无 skill:rules/* 条目 —— 骨架化规则不可用，按文件内摘要降级并标注）")
    print()

    print("【经验候选 · 按 retrieval.md 路由表命中才 memory_search，勿全量拉取】")
    print("  " + "  ".join(f"{p}:* {c} 条" for p, c in counts.items()))
    print()
    print("【下一步】对实际消费的 key 执行: python3 backup/memory_tool.py touch <key>...")

    return 3 if missing else 0


# ============================================================================
# runtime: artifact —— 结果外置（大产出落盘，上下文只留 Ref + 投影视图）
# ============================================================================
#
# 对齐 dsh-ops 的 ops_result（put / page / release）：
#   - 大产出（全量测试日志 / 逐项 Review 结果 / 状态矩阵）写盘，不进上下文
#   - 回流只带 Ref + 投影视图（--fields / --grep / --equals / --limit / --max-bytes）
#   - --count 等价 outputMode:count（先摸规模再决定是否取内容）
#   - 24h TTL，put 时顺带回收过期产物
#
# 落盘位置：$VIBE_LOOP_ARTIFACTS_DIR，缺省 ~/.vibe-loop/artifacts/<workspace-hash>/
#   （namespace 口径与 delx-memory 一致：git 仓库根路径哈希，无仓库则用 cwd）

ARTIFACT_TTL_SECONDS = 24 * 3600
ARTIFACT_DEFAULT_MAX_BYTES = 4096
ARTIFACT_MAX_BYTES_CAP = 65536
ARTIFACT_DEFAULT_LIMIT = 20
ARTIFACT_LIMIT_CAP = 200
ARTIFACT_INDEX_NAME = "index.json"


def _workspace_namespace():
    """命名空间 = git 仓库根路径的哈希（无仓库回退 cwd），与 delx-memory 口径同源。"""
    root = None
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            cwd=os.getcwd(),
        )
        if r.returncode == 0 and r.stdout.strip():
            root = r.stdout.strip()
    except OSError:
        pass
    if not root:
        root = os.getcwd()
    return hashlib.sha1(root.encode("utf-8")).hexdigest()[:12]


def artifact_base():
    env = os.environ.get("VIBE_LOOP_ARTIFACTS_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".vibe-loop" / "artifacts" / _workspace_namespace()


def _artifact_index_path(base):
    return base / ARTIFACT_INDEX_NAME


def _artifact_read_index(base):
    p = _artifact_index_path(base)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _artifact_write_index(base, index):
    base.mkdir(parents=True, exist_ok=True)
    tmp = _artifact_index_path(base).with_suffix(".tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _artifact_index_path(base))


def _artifact_prune(base, index):
    """回收过期产物（24h TTL）。返回 (回收的 ref, 跳过的非法 ref)。

    ref 一律先过 `_artifact_safe_dir` 边界校验 —— index.json 只是普通本地文件，
    不是可信来源（对齐 dsh-ops："references are not capability tokens"）；
    未校验即拼路径 rmtree = 越界删除用户目录的敞口。
    """
    now = time.time()
    expired = [ref for ref, meta in index.items() if now - meta.get("created_at", 0) > ARTIFACT_TTL_SECONDS]
    reclaimed, skipped = [], []
    for ref in expired:
        try:
            d = _artifact_safe_dir(base, ref)
        except ValueError:
            skipped.append(ref)
            continue
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
        index.pop(ref, None)
        reclaimed.append(ref)
    return reclaimed, skipped


ARTIFACT_REF_RE = re.compile(r"a[0-9a-f]{10}\Z")


def _artifact_safe_dir(base, ref):
    """ref 的唯一合法形态 = `a` + 10 位十六进制；目录必须解析在 base 之下。

    防 index.json 被篡改 / CLI 传入 `../../x` 后越界 rmtree；对齐 dsh-ops 的
   capability 边界（capability-relative handles 防目录逃逸）。"""
    if not ARTIFACT_REF_RE.fullmatch(str(ref)):
        raise ValueError(f"非法 ref 形态: {ref!r}")
    d = (base / ref).resolve()
    if d.parent != base.resolve():
        raise ValueError(f"ref 越界: {ref!r}")
    return d


def _artifact_slug(name):
    """落盘文件名消毒：去路径分隔符、去首尾 `.`/`-`（防 `..`）。

    展示名与落盘名解耦：meta['name'] 存清洗后的安全名（page 本来就只回行内容，
    原名对模型无信息增量；如需原名，meta 里有 source）。"""
    s = re.sub(r"[/\\]+", "-", name or "artifact")
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-.")
    s = re.sub(r"\.{2,}", ".", s)
    return (s or "artifact")[:48]


def cmd_artifact_put(args, db):
    base = artifact_base()
    src = Path(args.file)
    if not src.is_file():
        print(f"[ARTIFACT_SOURCE_MISSING] 源文件不存在: {src}")
        print("[next] 确认源文件路径后重试（可先 artifact list 看是否已落盘过）。")
        return 3
    try:
        raw = src.read_bytes()
    except OSError as e:
        print(f"[ARTIFACT_SOURCE_MISSING] 无法读取 {src}: {e}")
        print("[next] 确认源文件可读后重试。")
        return 3

    base.mkdir(parents=True, exist_ok=True)
    index = _artifact_read_index(base)
    _artifact_prune(base, index)

    ref = "a" + hashlib.sha1(f"{time.time()}{src}".encode("utf-8")).hexdigest()[:10]
    d = _artifact_safe_dir(base, ref)
    d.mkdir(parents=True, exist_ok=True)
    safe_name = _artifact_slug(args.name or src.name)
    dest = d / safe_name
    # 双保险：即便 slug 未来被改坏，也不允许写出产物目录
    if not str(dest.resolve()).startswith(str(d.resolve()) + os.sep):
        print(f"[ARTIFACT_NAME_INVALID] --name 拒绝（非法名称）: {args.name!r}")
        print("[next] 改用不含路径分隔符的名称重试。")
        if d.exists() and not any(d.iterdir()):
            d.rmdir()
        return 3
    dest.write_bytes(raw)

    text = raw.decode("utf-8", errors="replace")
    meta = {
        "ref": ref,
        "name": dest.name,
        "kind": args.kind,
        "loop": args.loop,
        "source": str(src),
        "bytes": len(raw),
        "lines": text.count("\n") + (1 if text and not text.endswith("\n") else 0),
        "created_at": time.time(),
    }
    index[ref] = meta
    _artifact_write_index(base, index)

    print(f"📄 artifact put  ref={ref}")
    print(f"  {meta['name']}  ({meta['bytes']} 字节 / {meta['lines']} 行, kind={meta['kind']})")
    print(f"  路径: {dest}")
    print(f"  TTL: 24h（过期后 put 时自动回收）")
    print(f"[next] 分页取用: python3 backup/memory_tool.py artifact page --ref {ref} --limit 20")
    print("[warn] 上下文只保留本 Ref 与投影视图；不要把全量内容读进上下文。")
    return 0


def _artifact_rows(text, kind, fields, equals):
    """把产物解析为行列表；kind=jsonl 时按 fields/equals 投影。"""
    if kind != "jsonl":
        return [ln for ln in text.splitlines()]
    rows = []
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            obj = json.loads(ln)
        except json.JSONDecodeError:
            rows.append(ln)
            continue
        if not isinstance(obj, dict):
            rows.append(ln)
            continue
        if equals:
            if any(str(obj.get(k)) != v for k, v in equals.items()):
                continue
        if fields:
            obj = {k: obj.get(k) for k in fields}
        rows.append(json.dumps(obj, ensure_ascii=False))
    return rows


def cmd_artifact_page(args, db):
    base = artifact_base()
    index = _artifact_read_index(base)
    meta = index.get(args.ref)
    if not meta:
        print(f"[ARTIFACT_NOT_FOUND] ref 不存在或已过期: {args.ref}")
        print(f"[hint] 已有 ref: {', '.join(sorted(index)) or '(空)'}")
        print("[next] 用 artifact list 核对 ref；源仍文件在则重新 put。")
        return 4

    try:
        d = _artifact_safe_dir(base, args.ref)
    except ValueError as e:
        # index 命中但 ref 形态非法 → index.json 不可信（被篡改/损坏），fail closed
        print(f"[ARTIFACT_REF_INVALID] {e}")
        print("[next] 检查产物目录 index.json 是否被外部修改；可信来源重建后重试。")
        return 3
    target = d / _artifact_slug(meta.get("name") or "")
    if not str(target.resolve()).startswith(str(d.resolve()) + os.sep) or not target.is_file():
        if not target.is_file() and str(target.resolve()).startswith(str(d.resolve()) + os.sep):
            print(f"[ARTIFACT_NOT_FOUND] 产物文件丢失: {target}")
            print("[next] 从源文件重新 put（refs 不是持久承诺，TTL 24h）。")
            return 4
        print(f"[ARTIFACT_REF_INVALID] meta.name 越界: {meta.get('name')!r}")
        print("[next] 检查 index.json 完整性后重建产物。")
        return 3

    text = target.read_text(encoding="utf-8", errors="replace")
    fields = [f.strip() for f in args.fields.split(",") if f.strip()] if args.fields else None
    equals = None
    if args.equals:
        equals = {}
        for pair in args.equals.split(","):
            if "=" in pair:
                k, v = pair.split("=", 1)
                equals[k.strip()] = v.strip()

    rows = _artifact_rows(text, meta.get("kind"), fields, equals)

    if args.grep:
        try:
            rx = re.compile(args.grep)
        except re.error:
            rx = re.compile(re.escape(args.grep))
        rows = [r for r in rows if rx.search(r)]

    total = len(rows)
    if args.count:
        print(f"📄 artifact {args.ref}  {meta['name']}  kind={meta.get('kind')}")
        print(f"  count = {total}" + ("  (已应用 --grep/--equals 过滤)" if args.grep or equals else ""))
        print("[next] 需要内容时按 --limit/--max_bytes 分页取用，勿全量拉取。")
        return 0

    # 参数校验 + clamp 显式报告（本技能纪律：超限必须可见，不得静默截断）
    raw_limit = args.limit if args.limit is not None else ARTIFACT_DEFAULT_LIMIT
    if raw_limit <= 0:
        print(f"[INVALID_ARGUMENT] --limit 须为正整数（收到 {raw_limit}）")
        print("[next] 修正 --limit 后重试；只摸规模用 --count。")
        return 3
    limit = raw_limit
    if limit > ARTIFACT_LIMIT_CAP:
        print(f"[OUTPUT_LIMIT] --limit {limit} 超过单页上限 {ARTIFACT_LIMIT_CAP}，按上限执行（显式 clamp，不静默）")
        limit = ARTIFACT_LIMIT_CAP
    raw_mb = args.max_bytes if args.max_bytes is not None else ARTIFACT_DEFAULT_MAX_BYTES
    if raw_mb <= 0:
        print(f"[INVALID_ARGUMENT] --max-bytes 须为正整数（收到 {raw_mb}）")
        print("[next] 修正 --max-bytes 后重试。")
        return 3
    max_bytes = raw_mb
    if max_bytes > ARTIFACT_MAX_BYTES_CAP:
        print(f"[OUTPUT_LIMIT] --max-bytes {max_bytes} 超过单页字节上限 {ARTIFACT_MAX_BYTES_CAP}，按上限执行（显式 clamp，不静默）")
        max_bytes = ARTIFACT_MAX_BYTES_CAP
    offset = max(0, args.offset or 0)

    page, used, truncated = [], 0, False
    for row in rows[offset : offset + limit]:
        ln = len(row.encode("utf-8"))
        if used + ln > max_bytes and page:
            truncated = True
            break
        page.append(row)
        used += ln

    print(f"📄 artifact {args.ref}  {meta['name']}  kind={meta.get('kind')}")
    print(f"  {meta['bytes']} 字节 / {meta['lines']} 行  |  过滤后 {total} 行")
    print(f"  offset={offset} limit={limit} → 返回 {len(page)} 行 / {used} 字节")
    if truncated:
        print(f"  [OUTPUT_LIMIT] 已达 max_bytes={max_bytes}，本页提前结束（未静默截断）")
    print()
    for row in page:
        print(row)
    nxt = offset + len(page)
    print()
    if nxt < total:
        print(f"[next] offset={nxt}（剩余 {total - nxt} 行）")
    else:
        print("[next] 已到末尾；确认不再需要时: artifact release --ref " + args.ref)
    return 0


def cmd_artifact_list(args, db):
    base = artifact_base()
    index = _artifact_read_index(base)
    _artifact_prune(base, index)
    print(f"产物目录: {base}")
    if not index:
        print("(空)")
        return 0
    now = time.time()
    print(f"{'ref':<14}{'name':<28}{'kind':<8}{'bytes':>10}  {'剩余TTL':>8}")
    for ref, m in sorted(index.items(), key=lambda kv: kv[1].get("created_at", 0), reverse=True):
        remain = max(0, int(ARTIFACT_TTL_SECONDS - (now - m.get("created_at", 0))))
        print(f"{ref:<14}{m.get('name', '')[:27]:<28}{str(m.get('kind', '')):<8}{m.get('bytes', 0):>10}  {remain//3600:>6}h")
    return 0


def cmd_artifact_release(args, db):
    base = artifact_base()
    index = _artifact_read_index(base)
    refs = args.ref if isinstance(args.ref, list) else [args.ref]
    released, rejected = [], []
    for ref in refs:
        if ref not in index:
            continue
        try:
            d = _artifact_safe_dir(base, ref)
        except ValueError as e:
            # index.json 是普通本地文件，不是可信来源；非法 ref 一律拒绝而非拼路径
            rejected.append(f"{ref}（{e}）")
            continue
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
        index.pop(ref, None)
        released.append(ref)
    _artifact_write_index(base, index)
    if released:
        print(f"🗑 已释放: {', '.join(released)}")
    if rejected:
        print(f"[ARTIFACT_REF_INVALID] 拒绝释放（ref 形态/边界非法，先核验 index.json）: {'; '.join(rejected)}")
        print("[next] 确认产物 index 是否被外部篡改后手工清理。")
        return 3
    if not released:
        print("🗑 已释放: (无命中)")
        print("[next] 用 artifact list 核对现有 ref。")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="vibe-coder-loop 技能相关记忆 备份/更新工具（跨平台）"
    )
    parser.add_argument(
        "--db",
        help="delx-memory 数据库路径（优先级最高；其次 DELX_MEMORY_DB 环境变量、config.json、自动探测）",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("backup", help="备份技能相关记忆到 snapshots/")
    p_restore = sub.add_parser("restore", help="从备份文件更新数据库（upsert）")
    p_restore.add_argument("file", help="备份 JSON 文件路径")
    p_restore.add_argument(
        "--dry-run", action="store_true", help="只打印将发生的变更，不写库"
    )
    p_restore.add_argument(
        "--force", action="store_true", help="放行技能范围外的 key（默认拒绝，谨慎使用）"
    )
    p_verify = sub.add_parser("verify", help="校验备份文件与数据库一致性")
    p_verify.add_argument("file", help="备份 JSON 文件路径")
    sub.add_parser("list", help="列出技能相关 key 与当前数据库路径")
    p_ck = sub.add_parser("check-keys", help="校验给定 key 是否存在（stdin 每行一个；缺 → 退出码 4）")
    p_ck.add_argument("--files", nargs="*", default=None, help="改从文件读取 key（每行一个）")
    p_ck.add_argument("--quiet", action="store_true", help="只输出缺失项，不打印通过信息")
    p_touch = sub.add_parser("touch", help="Memory 消费回写（access_count+1）")
    p_touch.add_argument("keys", nargs="+", metavar="KEY", help="被消费的记忆 key")
    p_touch.add_argument(
        "--hit", action="store_true", help="同时 cache_hit_count+1（内容经 E2+ 验证与事实一致）"
    )
    p_metrics = sub.add_parser("metrics", help="仪表盘 upsert（叠加本轮 delta）")
    for flag, help_text in (
        ("--conflict", "冲突仲裁次数"),
        ("--by-user", "其中用户裁决"),
        ("--by-level", "其中规则层级裁决"),
        ("--retrieval", "记忆检索次数"),
        ("--budget-hit", "其中预算内完成"),
        ("--memory-hit", "其中确有召回结果（记忆命中）"),
        ("--over-budget", "超预算次数"),
        ("--auto-generated", "观察期新增自动规则"),
        ("--auto-promoted", "观察期晋升"),
        ("--auto-demoted", "观察期降级"),
        ("--auto-deleted", "观察期删除"),
        ("--auto-pending", "观察期待定"),
        ("--rollback", "回滚次数"),
        ("--skeleton-entries", "骨架化条目数"),
        ("--skeleton-bytes", "骨架化节省字节"),
    ):
        p_metrics.add_argument(flag, type=int, default=0, dest=flag[2:].replace("-", "_"), help=help_text)
    p_metrics.add_argument("--counts", action="store_true", help="机械重算 memory.* 条目计数")
    p_metrics.add_argument("--note", default="", help="写入仪表盘顶层 note（本轮摘要）")

    # ---- runtime: preflight（加载计划） ----
    p_pre = sub.add_parser(
        "preflight", help="打印加载计划 + 成本 + 章节索引 + 记忆候选（一次调用替代 N 次导航读取）"
    )
    p_pre.add_argument("--level", default="2", help="Complexity Level（0 / 0-doc / 1 / 2 / 3 / 4）")
    p_pre.add_argument(
        "--stage",
        default=None,
        help="收窄阶段集：S8,S9=只保留所列；^S3=从默认集排除（免手抄全清单）；token 校验 S1–S13，非法 exit 3",
    )
    p_pre.add_argument(
        "--task",
        default="",
        help="任务 profile（coding/debugging/refactoring/planning/review/skill-maintenance；多个用逗号分隔）",
    )
    p_pre.add_argument("--files", default="", help="绕过 load_plan.json，显式给出逗号分隔的加载清单")

    # ---- runtime: artifact（结果外置） ----
    p_art = sub.add_parser("artifact", help="结果外置：大产出落盘，上下文只留 Ref + 投影视图")
    art = p_art.add_subparsers(dest="artifact_command", required=True)
    p_ap = art.add_parser("put", help="落盘一个产物并返回 ref")
    p_ap.add_argument("--file", required=True, help="源文件路径")
    p_ap.add_argument("--name", default="", help="产物显示名（缺省用源文件名）")
    p_ap.add_argument("--kind", default="text", choices=["text", "jsonl"], help="产物类型（jsonl 支持 --fields/--equals 投影）")
    p_ap.add_argument("--loop", type=int, default=0, help="关联的 Loop 编号（仅记元数据）")
    p_ag = art.add_parser("page", help="分页取用产物（带投影与字节上限）")
    p_ag.add_argument("--ref", required=True, help="产物 ref")
    p_ag.add_argument("--offset", type=int, default=0, help="起始行")
    p_ag.add_argument("--limit", type=int, default=ARTIFACT_DEFAULT_LIMIT, help=f"最多返回行数（上限 {ARTIFACT_LIMIT_CAP}）")
    p_ag.add_argument("--max-bytes", type=int, default=ARTIFACT_DEFAULT_MAX_BYTES, dest="max_bytes", help=f"单页字节上限（上限 {ARTIFACT_MAX_BYTES_CAP}）")
    p_ag.add_argument("--fields", default="", help="字段投影（逗号分隔，仅 kind=jsonl）")
    p_ag.add_argument("--equals", default="", help="顶层等值过滤 k=v,k=v（仅 kind=jsonl）")
    p_ag.add_argument("--grep", default="", help="行过滤正则（文本/JSONL 均可用）")
    p_ag.add_argument("--count", action="store_true", help="只回过滤后的行数（等价 outputMode:count，先摸规模）")
    art.add_parser("list", help="列出当前工作区的产物与剩余 TTL")
    p_ar = art.add_parser("release", help="释放产物（可多个）")
    p_ar.add_argument("--ref", nargs="+", required=True, help="产物 ref（可多个）")

    args = parser.parse_args()

    db = resolve_db_path(args.db)

    # artifact 组不依赖 delx-memory 库（纯文件系统产物），先分发以免被库检查拦住
    artifact_handlers = {
        "put": cmd_artifact_put,
        "page": cmd_artifact_page,
        "list": cmd_artifact_list,
        "release": cmd_artifact_release,
    }
    if args.command == "artifact":
        return artifact_handlers[args.artifact_command](args, None)

    if not db.exists():
        print(f"[DB_NOT_FOUND] 数据库不存在: {db}")
        print("[hint]   用 --db 指定路径，或设置 DELX_MEMORY_DB，或修改 backup/config.json 的 db_path")
        print("[next]   修正 db 路径后重试；artifact 组不受影响（不依赖库）。")
        return 2

    handlers = {
        "backup": cmd_backup,
        "restore": cmd_restore,
        "verify": cmd_verify,
        "list": cmd_list,
        "touch": cmd_touch,
        "metrics": cmd_metrics,
        "preflight": cmd_preflight,
        "check-keys": cmd_check_keys,
    }
    return handlers[args.command](args, db)


if __name__ == "__main__":
    sys.exit(main())
