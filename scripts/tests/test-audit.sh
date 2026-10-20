#!/usr/bin/env bash
# test-audit.sh — scripts/audit.sh 的自测（不依赖第三方测试框架）
# 所有敏感样例在运行时拼接，避免测试文件本身触发审计规则。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
AUDIT="$ROOT/scripts/audit.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/vibe-audit-test.XXXXXX")" || { printf 'mktemp failed\n' >&2; exit 2; }
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

assert_contains() {
  local hay="$1" needle="$2" name="$3"
  case "$hay" in
    *"$needle"*) ok "$name" ;;
    *) bad "${name}（未找到：${needle}）" ;;
  esac
}

assert_not_contains() {
  local hay="$1" needle="$2" name="$3"
  case "$hay" in
    *"$needle"*) bad "${name}（不应出现：${needle}）" ;;
    *) ok "$name" ;;
  esac
}

slash="/"
bs='\'
email_local="tester"
email_domain="example.invalid"
ip_mid="168"
token_prefix="sk-"
token_suffix="0123456789abcdefghij"
unc_host="server"
unc_share="share"
pi_agent="agent"

home_path="${slash}Users${slash}alice${slash}Desktop${slash}file.txt"
win_path="C:${bs}Users${bs}alice"
wsl_path="\\\\wsl\$${bs}Ubuntu${bs}home${bs}alice"
root_path="${slash}root${slash}secret"
pi_path="~/.pi/${pi_agent}"
readlink_cmd="read""link -f"
email="${email_local}@${email_domain}"
ip="192.${ip_mid}.1.10"
token="${token_prefix}${token_suffix}"
unc="\\\\${unc_host}\\\\${unc_share}"

mkdir -p "$TMP/leak"
{
  printf 'home=%s\n' "$home_path"
  printf 'win=%s\n' "$win_path"
  printf 'wsl=%s\n' "$wsl_path"
  printf 'root=%s\n' "$root_path"
  printf 'pi=%s\n' "$pi_path"
  printf 'cmd=%s\n' "$readlink_cmd"
  printf 'mail=%s\n' "$email"
  printf 'ip=%s\n' "$ip"
  printf 'token=%s\n' "$token"
  printf 'unc=%s\n' "$unc"
} > "$TMP/leak/leak.txt"

out="$(AUDIT_ROOT="$TMP/leak" bash "$AUDIT" scan 2>&1)"
rc=$?
assert_rc 0 "$rc" 'scan 正常退出'
for rule in P001 P002 P003 P005 P006 P007 H001 S001 S002 S003 L001; do
  assert_contains "$out" ":$rule:" "scan 命中 $rule"
done
assert_contains "$out" '<user>' 'scan 脱敏用户名'
assert_contains "$out" '<email>' 'scan 脱敏邮箱'
assert_contains "$out" '<private-ip>' 'scan 脱敏私有 IP'
assert_contains "$out" '疑似真实凭证' 'scan 标识凭证'
assert_not_contains "$out" 'alice' 'scan 不输出原始用户名'
assert_not_contains "$out" "$token_suffix" 'scan 不输出凭证值'

out="$(AUDIT_ROOT="$TMP/leak" bash "$AUDIT" scan --min-severity=high 2>&1)"
assert_contains "$out" ':P001:' 'min-severity 保留 high'
assert_not_contains "$out" ':L001:' 'min-severity 过滤 low'
assert_not_contains "$out" ':P005:' 'min-severity 过滤 medium'

out="$(AUDIT_ROOT="$TMP/leak" bash "$AUDIT" scan --format=json 2>&1)"
assert_contains "$out" '"rule":"P001"' 'json 输出规则字段'
assert_contains "$out" '"severity":"critical"' 'json 输出严重度字段'

AUDIT_ROOT="$TMP/leak" bash "$AUDIT" scan --fail-on=critical >/dev/null 2>&1
assert_rc 1 "$?" 'fail-on=critical 命中'
AUDIT_ROOT="$TMP/leak" bash "$AUDIT" scan --fail-on=none >/dev/null 2>&1
assert_rc 0 "$?" 'fail-on=none 不失败'

mkdir -p "$TMP/clean"
out="$(AUDIT_ROOT="$TMP/clean" bash "$AUDIT" scan 2>&1)"
assert_rc 0 "$?" 'clean scan 退出 0'
AUDIT_ROOT="$TMP/clean" bash "$AUDIT" scan --fail-on=critical >/dev/null 2>&1
assert_rc 0 "$?" 'clean fail-on 不失败'

# check：Git 跟踪的敏感文件 + 宿主断链 + Markdown 链接
repo="$TMP/repo"
mkdir -p "$repo/skills/vibe-coder-loop/backup/snapshots" "$repo/agents" "$repo/opencode" "$repo/agents_dir"
printf 'x\n' > "$repo/skills/vibe-coder-loop/.state.md"
printf '{}\n' > "$repo/skills/vibe-coder-loop/backup/snapshots/skill_memory_latest.json"
printf '[missing](missing.md)\n' > "$repo/README.md"
git -C "$repo" init -q
git -C "$repo" add -A
ln -s "$TMP/does-not-exist" "$repo/agents/vibe-coder-loop" 2>/dev/null || true

out="$(AGENTS_SKILLS_DIR="$repo/agents" OPENCODE_SKILLS_DIR="$repo/opencode" OPENCODE_AGENTS_DIR="$repo/agents_dir" \
  AUDIT_ROOT="$repo" bash "$AUDIT" check 2>&1)"
assert_contains "$out" ':C008:' 'check 检出被跟踪的运行时文件'
assert_contains "$out" ':C009:' 'check 检出被跟踪的记忆快照'
assert_contains "$out" ':C006:' 'check 检出 Markdown 断链'
if [ -L "$repo/agents/vibe-coder-loop" ]; then
  assert_contains "$out" ':C003:' 'check 检出宿主断链'
fi
AGENTS_SKILLS_DIR="$repo/agents" OPENCODE_SKILLS_DIR="$repo/opencode" OPENCODE_AGENTS_DIR="$repo/agents_dir" \
  AUDIT_ROOT="$repo" bash "$AUDIT" check --fail-on=high >/dev/null 2>&1
assert_rc 1 "$?" 'check fail-on=high 命中'

# verify：基线无变化 → 0；新增 high → 1
mkdir -p "$TMP/verify"
printf 'ok\n' > "$TMP/verify/ok.txt"
AUDIT_ROOT="$TMP/verify" bash "$AUDIT" scan > "$TMP/baseline.tsv"
AUDIT_ROOT="$TMP/verify" bash "$AUDIT" verify -b "$TMP/baseline.tsv" >/dev/null 2>&1
assert_rc 0 "$?" 'verify 基线一致'
printf 'token=%s\n' "$token" > "$TMP/verify/new.txt"
out="$(AUDIT_ROOT="$TMP/verify" bash "$AUDIT" verify -b "$TMP/baseline.tsv" 2>&1)"
assert_rc 1 "$?" 'verify 新增高危失败'
assert_contains "$out" '新增严重/高危' 'verify 报告新增高危'

# report 输出到 stdout
out="$(AUDIT_ROOT="$TMP/clean" bash "$AUDIT" report --out - 2>&1)"
assert_rc 0 "$?" 'report stdout 成功'
assert_contains "$out" '开源就绪扫描报告' 'report 含标题'
assert_contains "$out" '## 汇总' 'report 含汇总'

# rules / help / version / 参数错误
out="$(bash "$AUDIT" rules 2>&1)"
assert_contains "$out" 'P001' 'rules 列出 P001'
out="$(bash "$AUDIT" help 2>&1)"
assert_contains "$out" '用法' 'help 含用法'
out="$(bash "$AUDIT" version 2>&1)"
assert_contains "$out" 'vibe-audit' 'version 输出工具名'
bash "$AUDIT" scan --format=xml >/dev/null 2>&1
assert_rc 2 "$?" '非法 format 退出 2'
bash "$AUDIT" no-such-command >/dev/null 2>&1
assert_rc 2 "$?" '未知命令退出 2'

printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
