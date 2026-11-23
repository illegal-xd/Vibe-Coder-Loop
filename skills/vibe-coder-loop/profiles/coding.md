---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Coding — 编码/修改/优化（A/B 类）

> Router 卡：只列**本类差异项**。公共加载集（kernel + engine + policy + 逐阶段文件）见 `SKILL.md`「加载时机索引」与「分级加载」；机器版 = `load_plan.json` `profiles.coding`（preflight 直接输出，勿手抄）。

**适用**：新功能开发 / 存量代码修改 / 性能·可读性优化（B，不改外部行为）/ 单点修复（A）
**任务分类**：A / B（对齐 `rules/intent.md`）；记忆路由行 = 「编码/调试」（`learning/memory/retrieval.md`）

**执行路径**：L0 → S1→S2(轻)→S4→S8→结束；L1 → +S9→S10(轻)；L2+ → 全阶段

**公共 Required:** kernel + engine + policy + `learning/memory/retrieval.md`（S2 召回）+ `learning/memory/lifecycle.md`（回写契约）+ `learning/skill-metrics.md`（S13 仪表盘）+ 逐阶段文件 —— 见 `SKILL.md`「加载时机索引」
**本类 Required（增补）:** `rules/design.md`（S6，L2+）、`rules/plan.md`（S7，L2+）、`engine/skill-routing.md`（能力缺口时）

**出口纪律**
- L0/L1 在 S8/S10 出口内联硬约束审查 + 消费回写（Quick Loop 上限 1 轮）
- Code 完成版本功能 / 改 API 签名 → 标注 `[待 Memory Evolution]`
- 产生可复用约束 → 按 `learning/memory/lifecycle.md`「记忆写入」直接写入
