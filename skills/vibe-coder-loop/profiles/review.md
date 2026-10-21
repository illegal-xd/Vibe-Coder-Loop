---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Review — 调研/审查/分析/文档写作（E 类）

> 任务入口路由卡。**Profile = Router**：仅聚合"本类任务需加载哪些模块"，不复制任何规则内容（Rules = Authority）。逐阶段文件清单 = `SKILL.md`「加载时机索引」；Level→激活阶段映射 = `engine/complexity-gate.md`「Loop Depth」矩阵（唯一事实源）。

**适用（判定特征，命中任一即本 Profile）**：
- 调研/审查/分析/评估，明确不产代码（E. Investigation）
- 只读走查：代码审查、质量审计、影响分析、方案评估
- 内容写作型（Level 0-Doc）：文档产出 > 30 行或含整理/总结/研究语义
- Skill 自身规则审查（Review 角色 + Critic 视角）

**任务分类**：E. Investigation（Level 0-Doc = E 类产出型变体）；记忆路由行 = 「调研/审查」（`memory/retrieval.md` 路由表）

**执行路径**（分支选择见 `engine/router.md`「判定优先级」）：
- Investigation 分支（纯结论/报告产出）：S1 → S2 → S4 → S7（调查步骤清单）→ S10（三维审查）→ S11 → S12 → S13（收尾）
- Level 0-Doc（文档产出物）：S1 → S2(轻量) → S4 → S8（文档写作）→ S8 出口三维审查 → S13（收尾）
- 全程标注 `[Investigation Mode]`（Level 0-Doc 除外）

**加载**：

Required:
- kernel.md（R0 原则，任何阶段前）
- engine/state-machine.md + engine/transition.md（S1 Checkpoint + S10 判定路径）
- engine/complexity-gate.md + engine/router.md（S4 分级 + 三分支细则：Investigation / Level 0-Doc / 判定优先级；**三维审查定义在 router**）
- policy/safety.md + policy/confidence.md（安全约束 + Evidence 标注强制）
- rules/intent.md（S1 目标三元组）+ rules/review.md（代码向硬约束与审查维度；Investigation 分支不适用）
- references/output-format.md（输出格式规范）
- policy/lifecycle.md（S12「记忆条目删除义务」）
- learning/memory/lifecycle.md（S13 回写契约）+ learning/memory/retrieval.md（S2 最小召回）
- learning/memory/promotion.md（S12 收尾 2 步）+ learning/skill-metrics.md（S13 仪表盘）

Optional:
- references/example.md（Review 格式参考）
- learning/reflection.md（审查发现沉淀）
- 审查类能力载体（code-review 系列；存在能力缺口时才按 `engine/skill-routing.md` 绑定）

**出口纪律**：
- 审查结论必须带 Evidence（E0 结论 Confidence 最高 Medium），禁止无依据判定
- Investigation 走查不产生代码修改——发现问题输出清单，修复由编码 profile 承接
- 文档写作遵守项目格式规则（标题层级/表格/链接兼容），不批量改动无关笔记
