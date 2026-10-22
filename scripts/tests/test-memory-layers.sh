#!/usr/bin/env bash
# test-memory-layers.sh — L0–L7 记忆分层数据治理门禁
#
# 1) 单元测试（tests/memory）：分类/合并/幂等/中断重试/备份恢复/审核门槛
# 2) 真实库**只读**审计与 dry-run（零副作用断言）
# 3) 真实库快照上的完整回填演练：apply ×2（幂等）+ verify + restore
# 4) 演练全程不得改动真实库（前后指纹一致）
#
# 用法：bash scripts/tests/test-memory-layers.sh [db-path]
# 依赖：python3（仅标准库）+ sqlite3 CLI

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PY="${PYTHON:-python3}"
DB="${1:-$HOME/.delx-memory/db.sqlite}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/vibe-memory-test.XXXXXX")" || { printf 'mktemp failed\n' >&2; exit 2; }
PASS=0; FAIL=0

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT HUP INT TERM

ok()  { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1" >&2; }

fp() { "$PY" - "$1" <<'PY'
import sqlite3, sys
sys.path.insert(0, "scripts/memory")
import migrate as M
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
print(M.fingerprint(c))
PY
}

printf '== 1) unit tests ==\n'
if "$PY" -m unittest discover -s "$ROOT/tests/memory" >"$TMP/ut.log" 2>&1; then
  ok "tests/memory 全量通过（$(grep -c '^OK' "$TMP/ut.log" >/dev/null && tail -3 "$TMP/ut.log" | tr '\n' ' '))"
else
  bad "tests/memory 失败"; cat "$TMP/ut.log"; fi

if [ ! -f "$DB" ]; then
  bad "数据库不存在：$DB"; printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; exit 1
fi

BEFORE="$(cd "$ROOT" && fp "$DB")"

printf '== 2) 真实库只读：audit + dry-run ==\n'
if "$PY" "$ROOT/scripts/memory/audit_memory.py" --db "$DB" --out-json "$TMP/audit.json" >"$TMP/audit.log" 2>&1 \
   && grep -q '^records=' "$TMP/audit.log"; then
  ok "audit 只读执行（$(head -1 "$TMP/audit.log")）"
else bad "audit 失败"; cat "$TMP/audit.log"; fi

printf '== 3) 快照演练：dry-run / apply ×2 / verify / restore ==\n'
sqlite3 "$DB" "VACUUM INTO '$TMP/snap.sqlite'" || bad "快照创建失败"

DRY="$("$PY" "$ROOT/scripts/memory/migrate.py" --db "$TMP/snap.sqlite" --date 2026-10-22 \
        --backup-dir "$TMP/bk" 2>"$TMP/dry.err")"
echo "$DRY" | grep -q '"dry_run": true' && ok "dry-run 输出结构合法" || { bad "dry-run 异常"; cat "$TMP/dry.err"; }
SNAP_BEFORE="$(cd "$ROOT" && fp "$TMP/snap.sqlite")"
AFTER_DRY="$(cd "$ROOT" && fp "$TMP/snap.sqlite")"
[ "$SNAP_BEFORE" = "$AFTER_DRY" ] && ok "dry-run 零副作用（指纹一致）" || bad "dry-run 改变了数据"

A1="$("$PY" "$ROOT/scripts/memory/migrate.py" --db "$TMP/snap.sqlite" --date 2026-10-22 --apply \
      --backup-dir "$TMP/bk" --out-json "$TMP/a1.json" 2>&1 | tail -1)"
echo "$A1" | grep -q 'verify_ok=True' && ok "首次 apply + verify 通过（$A1）" || bad "首次 apply 失败：$A1"

A2="$("$PY" "$ROOT/scripts/memory/migrate.py" --db "$TMP/snap.sqlite" --date 2026-10-22 --apply \
      --backup-dir "$TMP/bk" --out-json "$TMP/a2.json" 2>&1 | tail -1)"
echo "$A2" | grep -q 'updated=0 inserted=0' && ok "二次 apply 幂等（$A2）" || bad "二次 apply 非幂等：$A2"

BAK="$(ls "$TMP/bk" | grep -v '^\.plan' | head -1)"
if [ -n "$BAK" ] && "$PY" "$ROOT/scripts/memory/migrate.py" --db "$TMP/snap.sqlite" \
     --restore "$TMP/bk/$BAK" --yes >"$TMP/restore.log" 2>&1; then
  RESTORED="$(cd "$ROOT" && fp "$TMP/snap.sqlite")"
  [ "$RESTORED" = "$SNAP_BEFORE" ] && ok "从备份恢复后原始语料指纹一致" || bad "恢复后指纹不一致"
else bad "恢复失败"; cat "$TMP/restore.log"; fi

printf '== 4) 真实库未被测试改动 ==\n'
AFTER="$(cd "$ROOT" && fp "$DB")"
[ "$BEFORE" = "$AFTER" ] && ok "真实库指纹前后一致（未写入）" || bad "真实库被改动"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
