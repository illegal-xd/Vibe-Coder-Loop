---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Review — 调研/审查/分析/文档写作（E 类）

> Router 卡：只列**本类差异项**。公共加载集见 `SKILL.md`「加载时机索引」与「分级加载」；机器版 = `load_plan.json` `profiles.review`。

**适用**：调研/审查/分析/评估且不产代码（E）/ 只读走查 / 内容写作型（Level 0-Doc，>30 行或含整理·总结语义）/ Skill 规则审查
**任务分类**：E（Level 0-Doc = E 类产出型变体）；记忆路由行 = 「调研/审查」

**执行路径**（分支判定见 `engine/router.md`「判定优先级」）
- Investigation（纯结论/报告）：S1→S2→S4→S7（调查步骤）→S10（三维审查）→S11→S12→S13
- Level 0-Doc（有文档产出物）：S1→S2(轻)→S4→S8（写作）→S8 出口三维审查→S13
- 全程标 `[Investigation Mode]`（Level 0-Doc 除外）

**公共 Required:** kernel + engine + policy + `learning/memory/retrieval.md`（S2 召回）+ `learning/memory/lifecycle.md`（回写契约）+ `learning/skill-metrics.md`（S13 仪表盘）+ 逐阶段文件 —— 见 `SKILL.md`「加载时机索引」
**本类 Required（增补）:** `references/output-format.md`（格式）、`references/example.md`（Review 格式参考）、`learning/reflection.md`（审查发现沉淀）

**出口纪律**
- 审查结论必须带 Evidence（E0 → Confidence 最高 Medium），禁止无依据判定
- Investigation 不产生代码修改——发现问题出清单，修复由编码 profile 承接
- 文档写作遵守项目格式规则（标题层级/表格/链接），不批量改动无关笔记
