---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Refactoring — 重构/架构调整（C/D 类）

> 任务入口路由卡。**Profile = Router**：仅聚合"本类任务需加载哪些模块"，不复制任何规则内容（Rules = Authority）。逐阶段文件清单 = `SKILL.md`「加载时机索引」；Level→激活阶段映射 = `engine/complexity-gate.md`「Loop Depth」矩阵（唯一事实源）。

**适用（判定特征，命中任一即本 Profile）**：
- 结构调整：模块拆分/合并、目录重组、接口变更（C. Refactoring）
- 架构级变化：新增模块/系统、跨组件解耦（D. Architecture，随代码落地）
- 行为保持类改动（需测试护栏 + 资产生命周期管理）

**任务分类**：C. Refactoring / D. Architecture（随代码落地时）；记忆路由行 = 「架构/重构」（`memory/retrieval.md` 路由表：codegraph 影响分析 + pattern 召回）

**执行路径**：
- Level 2（单模块重构）：全阶段 S1-S13（Standard）
- Level 3/4（架构变化/系统级）：全阶段 S1-S13（Full Loop，Plan 必须输出编排决策）
- Review 情况 B（结构性）→ 回 S6 Design[0] 重设计，不直接打补丁

**加载**：

Required:
- kernel.md（资产生命周期三红线 + SAFE MODE 阈值）
- engine/state-machine.md + engine/complexity-gate.md + engine/router.md（S4 分级）
- rules/design.md（S6 状态矩阵/先验证再假设）+ rules/plan.md（S7 五要素 Step）+ rules/code.md + rules/review.md
- policy/safety.md + policy/lifecycle.md（Active→Deprecated→Archived 流转强制）+ policy/confidence.md
- engine/transition.md（情况 B 回退 + 各阶段出口）

Optional:
- rules/orchestration.md（多 subagent/混合编排时）
- engine/skill-routing.md（能力绑定）
- learning/memory/promotion.md（S12 收尾 2 步 / 提升协议——提升·Consolidation 由系统承担）+ learning/memory/lifecycle.md（计数回写）
- learning/evolution.md（经验类型分类：项目经验 vs Skill 提案）

**出口纪律**：
- 重构行为等价 = 硬约束：先建立测试基线（S9），Review 的 Hard 项全过才收尾（Signal 项按可维护性判断）
- 废弃组件走归档注释（`@Iteration`）；禁止**自主**物理删除与私自处置被注释同类组件（三重禁止）；用户明确指令须先出 Conflict Card + 「🗑 待删除清单」（**代码资产的物理删除由用户执行**，见 `kernel.md` §2）
- 修改涉及更换用户组件 → `⚠️ 需用户决策` 标注 + 待决策清单
- CodeGraph 影响面分析先于修改（`codegraph_impact`）
