#!/usr/bin/env bash
# smoke-check-template.sh — 通用 Skill 一致性自检**模板**（skill-authoring 协议）
#
# 实例化方式：复制本文件到目标 Skill 的 `scripts/smoke-check.sh`，只改下面「配置」区的值。
# **不要复制检查逻辑** —— 逻辑唯一事实源 = `smoke-check-core.sh`（同目录）；
# 复制逻辑即产生 duplicate guide，两份会各自漂移（单一来源 + 生成）。
#
# 参考实例：
#   - skill-authoring/scripts/smoke-check.sh   （本协议 Skill 自身）
#   - vibe-coder-loop/scripts/smoke-check.sh   （宿主 Skill）
#
# 用法：
#   bash scripts/smoke-check.sh                 # 全项检查
#   bash scripts/smoke-check.sh --quiet         # 只打印违规项
#   bash scripts/smoke-check.sh --table         # 额外跑 Markdown 表格列数一致性
#   bash scripts/smoke-check.sh --max-lines=300 # 覆盖单文件行数预算
#
# 退出码：0 = 无 HARD 违规；1 = HARD 违规；2 = 仅预算超限；3 = 环境/用法错误
# 错误码含义见 smoke-check-core.sh 头部。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============ 配置区（实例化时改这里） ============
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SMOKE_NAME=""                       # 报告标题，缺省取技能目录名
DEAD_PTR_WORDS=''                   # 必填。历史改名轨迹词正则，用 | 分隔
GOV_FILE=''                         # 选填。governance 映射文件，如 references/governance.md
SELFTEST_CMD=''                     # 选填。自测命令，如 'python3 backup/test_memory_tool.py'
LOAD_PLAN_FILE=''                   # 选填。加载计划，如 load_plan.json
LOAD_PLAN_MENTION=''                # 选填。须提及计划内全部路径的文件，如 SKILL.md
BUDGET_FILE_LINES=0                 # 选填。单文件行数预算（0 = 关闭）
BUDGET_TOTAL_LINES=0                # 选填。规则文件总行数预算（0 = 关闭）
GOV_KEY_PREFIX='skill:'             # 选填。映射表左列 key 前缀
KEYS_CHECK_CMD=''                   # 选填。key 存在性校验命令，如 'python3 backup/memory_tool.py check-keys --files'
KEYS_PREFIX=''                      # 选填。从映射文件抽取 key 的字面前缀
MAP_TABLE_MODE=0                    # 选填。1 = 解析 Markdown 映射表（连 Canonical 类型一起校验 TTL 不变量）
CHECKPOINT_FILE=''                  # 选填。Workflow Checkpoint 文件，如 .state.md（校验单文档可解析 + 13 字段）
DEAD_PTR_KNOWN=()                   # 选填。已裁定为合法命中的死指针白名单，键 = './<相对路径>::<整行内容>'
SCAN_EXCLUDE_PATHS=()               # 选填。额外排除的 path glob 片段
# 完整契约（全部变量 + 错误码 + 退出码）唯一事实源 = smoke-check-core.sh 头部注释，勿在此重述。
# =================================================

# core 定位（多候选；跨 Skill 布局差异由候选列表吸收，勿在此复制检查逻辑）
# 候选列表为**规范顺序**（三处包装必须一致，勿增删改序 —— 分叉即漂移）；
# 全失效 → 显式报错退出 3，不静默跳过检查
CORE=""
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
