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
- Investigation 分支（纯结论/报告产出）：S1 → S2 → S4 → S7（调查步骤清单）→ S10（三维审查）→ S11 → S12
- Level 0-Doc（文档产出物）：S1 → S2(轻量) → S4 → S8（文档写作）→ S8 出口三维审查
- 全程标注 `[Investigation Mode]`（Level 0-Doc 除外）

**加载**：

Required:
- engine/complexity-gate.md + engine/router.md（S4 分级 + 三分支细则：Investigation / Level 0-Doc / 判定优先级；**三维审查定义在 router**）
- rules/review.md（代码向硬约束与审查维度；Investigation 分支不适用）
- references/output-format.md（输出格式规范）
- policy/confidence.md（Evidence 标注强制）

Optional:
- references/example.md（Review 格式参考）
- learning/memory/retrieval.md（调研素材召回：reference:* / lesson:*）
- learning/reflection.md（审查发现沉淀）
- engine/state-machine.md（情况 A/B/C 判定路径）
- 审查类能力载体（code-review 系列；存在能力缺口时才按 `engine/skill-routing.md` 绑定）

**出口纪律**：
- 审查结论必须带 Evidence（E0 结论 Confidence 最高 Medium），禁止无依据判定
- Investigation 走查不产生代码修改——发现问题输出清单，修复由编码 profile 承接
- 文档写作遵守项目格式规则（标题层级/表格/链接兼容），不批量改动无关笔记
