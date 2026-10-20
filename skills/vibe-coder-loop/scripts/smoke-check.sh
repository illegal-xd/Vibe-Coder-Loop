#!/usr/bin/env bash
# smoke-check.sh — vibe-coder-loop 一致性自检（S13 出口 / skill-maintenance 收尾；薄包装）
#
# 检查逻辑唯一事实源 = `skill-authoring/scripts/smoke-check-core.sh`。
# 本文件只做配置 + core 定位，**不复制检查逻辑** —— 历史上 template 与两个实例
# 曾各持一份近乎相同的逻辑、需三处同步；改为单一来源 + 生成（host generates declarations from the same schemas; no duplicate guide）。
#
# 检查覆盖：日期/版本残留（HARD）· 死指针候选（需裁决）· governance 映射一致性（HARD）
#           · memory_tool 自测（HARD）· 加载计划一致性（HARD）· 行数预算（退出码 2）
#
# 用法：
#   bash scripts/smoke-check.sh                 # 全项检查
#   bash scripts/smoke-check.sh --quiet         # 只打印违规项
#   bash scripts/smoke-check.sh --table         # 额外跑 Markdown 表格列数一致性
#   bash scripts/smoke-check.sh --max-lines=320 # 覆盖单文件行数预算
#
# 退出码：0 = 无 HARD 违规；1 = HARD 违规；2 = 仅预算超限；3 = 环境/用法错误

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============ 配置区 ============
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SMOKE_NAME="vibe-coder-loop"
# 死指针候选词集中维护——曾因只按编号形态扫描漏掉「写入规则 N」「Buffer」「主 prompt」三种形态
DEAD_PTR_WORDS='写入规则|Buffer 初始化|主 prompt|降级判定时机|计数回写规则|规则 6-8|「规则 [0-9]'
DEAD_PTR_KNOWN=(
  './rules/test.md::降级判定时机（5 情形）+ 降级行为 + 标注措辞（唯一版本）见 `skill:rules/test:degradation`（加载全文执行）。核心：'
)
GOV_FILE='references/governance.md'
# 映射表 key 存在性校验：把「映射表里写的 key」从声明变成可校验事实
KEYS_CHECK_CMD='python3 backup/memory_tool.py check-keys --files'
KEYS_PREFIX='skill:'   # 只取字面前缀；键名形态由 core 内部正则决定
MAP_TABLE_MODE=1       # 映射表为标准化表格 → 连 Canonical 类型一起解析（校验 TTL 不变量）
SELFTEST_CMD='python3 backup/test_memory_tool.py'
LOAD_PLAN_FILE='load_plan.json'
LOAD_PLAN_MENTION='SKILL.md'
# 6b 校验对象 = **Checkpoint 模板**（`.state.template.md`，随仓库分发的 13 字段契约锚点）。
# 运行实例 `<project_root>/.vibe-kernel/.state.md` 属项目侧实例数据，不在 Skill 目录内：
# 需要校验真实实例时显式传 `VIBE_CHECKPOINT_FILE=<绝对路径>`；两者都缺失时 core 打印跳过原因（不静默通过）。
CHECKPOINT_FILE="${VIBE_CHECKPOINT_FILE:-.state.template.md}"
# 行数预算：防规则膨胀。**棘轮语义 —— 只降不升**；确需上调须在 CHANGELOG 记明理由。
BUDGET_FILE_LINES=320
BUDGET_TOTAL_LINES=3900
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
