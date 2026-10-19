#!/usr/bin/env bash
# smoke-check.sh — skill-authoring 自身一致性自检（薄包装）
#
# 检查逻辑唯一事实源 = `smoke-check-core.sh`（同目录）。本文件只做配置 + core 定位，
# **不复制任何检查逻辑** —— 消除历史事故成因：同一份逻辑曾在 template / 两个实例间
# 复制三份、各自漂移（对齐 dsh-ops「单一来源 + 生成，不做 duplicate guide」）。
#
# 用途：把 Skill 维护出口纪律里的 grep 验证 + 映射一致性检查 + 行数预算固化为可执行门禁。
# 不做：规则内容正确性判断（那是人工 / Critic 的事）。
#
# 用法与退出码：见 smoke-check-core.sh 头部（0 通过 / 1 HARD / 2 预算 / 3 环境）。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============ 配置区 ============
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SMOKE_NAME="skill-authoring"
# 死指针候选词：本 Skill 的历史改名轨迹（无历史事故，保留通用形态词）
DEAD_PTR_WORDS='写入规则|Buffer 初始化|主 prompt|降级判定时机|计数回写规则'
GOV_FILE='governance-protocol.md'
SELFTEST_CMD=''
LOAD_PLAN_FILE=''
LOAD_PLAN_MENTION=''
BUDGET_FILE_LINES=0
BUDGET_TOTAL_LINES=0
# ================================

CORE=""
# 候选列表为**规范顺序**（三处包装必须一致，勿增删改序 —— 分叉即漂移）；
# 全失效 → 显式报错退出 3，不静默跳过检查
for c in \
  "${SMOKE_CORE:-}" \
  "$SCRIPT_DIR/smoke-check-core.sh" \
  "$SCRIPT_DIR/../../skill-authoring/scripts/smoke-check-core.sh" \
  "$SCRIPT_DIR/../skill-authoring/scripts/smoke-check-core.sh" \
  "$HOME/.agents/skills/skill-authoring/scripts/smoke-check-core.sh" \
  ; do
  if [ -n "$c" ] && [ -f "$c" ]; then CORE="$c"; break; fi
done
if [ -z "$CORE" ]; then
  echo "[STRUCTURAL_INCONSISTENT] 找不到 smoke-check-core.sh"
  echo "[next] 设置 SMOKE_CORE=<core 绝对路径> 后重跑"
  exit 3
fi

# shellcheck source=smoke-check-core.sh
source "$CORE" "$@"
