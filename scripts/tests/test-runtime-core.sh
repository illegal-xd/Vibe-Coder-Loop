#!/usr/bin/env bash
# test-runtime-core.sh — MVP-1 Workflow Core 门禁
#
# 1) core check-protocol：代码表 ↔ Skill 事实源一致（漂移 exit 3）
# 2) tests/core 全量单元测试（V1–V35）
# 3) CLI 冒烟：state check / 非法转换 fail-closed
#
# 用法：bash scripts/tests/test-runtime-core.sh
# 依赖：python3（仅标准库）

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PY="${PYTHON:-python3}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/vibe-core-test.XXXXXX")" || { printf 'mktemp failed\n' >&2; exit 2; }
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

"$PY" -m runtime.core.cli check-protocol >/dev/null 2>&1
assert_rc 0 "$?" 'core check-protocol 一致'

# 文档（docs/tooling.md、engine/state-machine.md）给出的入口形式 = python3 -m runtime.core
"$PY" -m runtime.core check-protocol >/dev/null 2>&1
assert_rc 0 "$?" '文档入口 python3 -m runtime.core 可用'

"$PY" -m unittest discover -s tests -t . -q >/dev/null 2>&1
assert_rc 0 "$?" 'tests/core 全量通过'

mkdir -p "$TMP/proj/.git" "$TMP/home"
home="$TMP/home"
cwd="$TMP/proj"

HOME="$home" "$PY" -m runtime.core.cli transition --cwd "$cwd" --to S1 >/dev/null 2>&1
assert_rc 0 "$?" 'CLI transition S0→S1'

HOME="$home" "$PY" -m runtime.core.cli state check --cwd "$cwd" >/dev/null 2>&1
assert_rc 0 "$?" 'CLI state check 语法通过'

HOME="$home" "$PY" -m runtime.core.cli transition --cwd "$cwd" --to S8 >/dev/null 2>&1
assert_rc 4 "$?" 'CLI 非法转换 fail-closed（exit 4）'

HOME="$home" "$PY" -m runtime.core.cli get-state --cwd "$cwd" 2>/dev/null | grep -q '"phase":"S1 Intent"'
assert_rc 0 "$?" 'CLI get-state 保持原 phase'

printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
