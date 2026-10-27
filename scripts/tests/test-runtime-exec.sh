#!/usr/bin/env bash
# test-runtime-exec.sh — MVP-2 Execution & Verification 门禁
#
# 1) core check-protocol：代码表 ↔ Skill 事实源一致（含 exec 新增码）
# 2) tests/exec 全量单元测试（E1–E16 验收场景）
# 3) CLI 冒烟：exec run / exec diff / exec baseline
# 4) tests/core 回归（确保 Exec 不破坏 Core）
#
# 用法：bash scripts/tests/test-runtime-exec.sh
# 依赖：python3（仅标准库）、git（diff 测试）

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PY="${PYTHON:-python3}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/vibe-exec-test.XXXXXX")" || { printf 'mktemp failed\n' >&2; exit 2; }
PASS=0
FAIL=0

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT HUP INT TERM

ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1" >&2; }

assert_rc() {
  local want="$1" got="$2" name="$3"
  if [ "$got" -eq "$want" ]; then ok "$name"; else bad "${name}（期望 rc=${want}，得到 ${got}）"; fi
}

cd "$ROOT" || exit 2

# 1) check-protocol
"$PY" -m runtime.core.cli check-protocol >/dev/null 2>&1
assert_rc 0 "$?" 'core check-protocol 一致（含 exec 新增码）'

# 2) exec 单元测试
"$PY" -m unittest discover -s tests/exec -t . -q >/dev/null 2>&1
assert_rc 0 "$?" 'tests/exec 全量通过（E1–E16）'

# 3) Core 回归
"$PY" -m unittest discover -s tests/core -t . -q >/dev/null 2>&1
assert_rc 0 "$?" 'tests/core 回归通过'

# 4) CLI 冒烟：exec run 成功
"$PY" -m runtime.exec.cli run --cmd "$PY -c \"print(42)\"" --cwd "$TMP" 2>/dev/null | grep -q '"ok":true'
assert_rc 0 "$?" 'CLI exec run 成功输出'

# 5) CLI 冒烟：exec run 高危拒绝（fail-closed exit 4）
"$PY" -m runtime.exec.cli run --cmd "rm -rf /" --cwd "$TMP" >/dev/null 2>&1
assert_rc 4 "$?" 'CLI exec run rm -rf fail-closed（exit 4）'

# 6) CLI 冒烟：exec diff（非 git 降级建基线）
# 基线写在 ~/.vibe-loop/baseline/ → 用临时 HOME 隔离，避免污染真实用户目录
HOME="$TMP/home" "$PY" -m runtime.exec.cli diff --cwd "$TMP" 2>/dev/null | grep -q 'degraded'
assert_rc 0 "$?" 'CLI exec diff 非 git 降级'

# 7) CLI 冒烟：exec baseline
HOME="$TMP/home" "$PY" -m runtime.exec.cli baseline --cwd "$TMP" 2>/dev/null | grep -q '"ok":true'
assert_rc 0 "$?" 'CLI exec baseline 建立快照'

printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
