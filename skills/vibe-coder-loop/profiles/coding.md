---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Coding — 编码/修改/优化（A/B 类）

> 任务入口路由卡。**Profile = Router**：仅聚合"本类任务需加载哪些模块"，不复制任何规则内容（Rules = Authority）。逐阶段文件清单 = `SKILL.md`「加载时机索引」；Level→激活阶段映射 = `engine/complexity-gate.md`「Loop Depth」矩阵（唯一事实源）。

**适用（判定特征，命中任一即本 Profile）**：
- 新功能开发、存量代码修改、文件新增
- 性能/可读性优化（B. Optimization，不改变外部行为）
- 单点修复（A. Direct Action，规模小、不涉结构重排）

**任务分类**：A. Direct Action / B. Optimization（`rules/intent.md` 目标三元组对齐）；记忆路由行 = 「编码/调试」（`memory/retrieval.md` 路由表）

**执行路径**（按 Level，细则见对应 engine 文件）：
- Level 0（文字/单点修改）：S1 → S2(轻量) → S4 → S8（出口内联审查 + 消费回写）
- Level 1（单文件）：S1 → S2 → S4 → S8 → S9 → S10（轻量）
- Level 2+（功能修改/系统级）：全阶段 S1-S13（Standard/Full Loop）

**加载**：

Required:
- kernel.md（R0 原则，任何阶段前）
- engine/state-machine.md + engine/transition.md（对应 S 出口检查）+ engine/complexity-gate.md + engine/router.md（S4 分级 + Quick/Standard/Full 模式选择）
- policy/safety.md + policy/confidence.md
- rules/intent.md（S1 目标三元组）→ rules/code.md（S8）→ rules/test.md（S9，L1+）→ rules/review.md（S10，L1+）
- learning/memory/lifecycle.md（S2 计数协议 + 出口 Quick 闭环）

Optional:
- rules/plan.md（S7，L2+）+ rules/design.md（S6，L2+）
- engine/skill-routing.md（S7 Step 绑定 / S8 适用性检查）
- policy/lifecycle.md（涉资产归档时）+ policy/priority.md（规则层级冲突时）
- learning/memory/retrieval.md（S2 路由表全表，L2+）
- learning/reflection.md + learning/skill-metrics.md（L2+ S11/S12）

**出口纪律**：
- L0/L1 在 S8/S10 出口内联硬约束审查 + 消费回写（Tool），违反回退修复（Quick Loop 上限 1 轮）
- Code 完成版本功能/API 变更 → 标注 `[待 Memory Evolution]`
- 产生可复用约束 → 记忆保存路径 B/C（`memory/lifecycle.md`）
