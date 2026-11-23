---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Planning — 规划/设计先行/编排型任务

> Router 卡：只列**本类差异项**。公共加载集见 `SKILL.md`「加载时机索引」与「分级加载」；机器版 = `load_plan.json` `profiles.planning`。

**适用**：大需求/多模块（Plan 产编排决策）/ 架构设计先行（不随代码落地）/ 多 subagent 派发或混合编排 / Clarify–Design 高权重任务
**任务分类**：D（设计产出）或 A–E 混合；记忆路由行 = 「架构/重构」或「技能/文档维护」视内容

**执行路径**：S1–S7（设计与计划段）；S8 起编码转 `coding.md`、审查转 `review.md`（本 profile 不承担 S8–S13）

**公共 Required:** kernel + engine + policy + `learning/memory/retrieval.md`（S2 召回）+ `learning/memory/lifecycle.md`（回写契约）+ `learning/skill-metrics.md`（S13 仪表盘）+ 逐阶段文件 —— 见 `SKILL.md`「加载时机索引」
**本类 Required（增补）:** `policy/priority.md`（冲突仲裁）、`engine/skill-routing.md`（仅能力缺口的 Step 绑定）、`rules/orchestration.md`、`learning/memory/architecture.md`（跨模块记忆挂载）

**出口纪律**
- Plan 未引用 Design 模块划分 / 未声明完成判据 → 回退，禁止提前进入 Code
- 编排决策必须输出：模式 + 判断依据 + 角色映射 + Confidence/Evidence
- 大需求不立即编码——Clarify/Design 的追问与设计优先于实现冲动
