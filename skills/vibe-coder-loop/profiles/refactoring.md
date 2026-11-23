---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Refactoring — 重构/架构调整（C/D 类）

> Router 卡：只列**本类差异项**。公共加载集见 `SKILL.md`「加载时机索引」与「分级加载」；机器版 = `load_plan.json` `profiles.refactoring`。

**适用**：模块拆分/合并、目录重组、接口变更（C）；新增模块/系统、跨组件解耦（D）；行为保持类改动
**任务分类**：C / D；记忆路由行 = 「架构/重构」（codegraph 影响分析 + pattern 召回）

**执行路径**：L2 → 全阶段（Standard）；L3/4 → 全阶段（Full，Plan 必须输出编排决策）；Review 情况 B → 回 S6 Design[0] 重设计，不直接打补丁

**公共 Required:** kernel + engine + policy + `learning/memory/retrieval.md`（S2 召回）+ `learning/memory/lifecycle.md`（回写契约）+ `learning/skill-metrics.md`（S13 仪表盘）+ 逐阶段文件 —— 见 `SKILL.md`「加载时机索引」
**本类 Required（增补）:** `rules/orchestration.md`（多 subagent / 混合）、`learning/evolution.md`（经验分类）

**出口纪律**
- **重构行为等价 = 硬约束**：先建立测试基线（S9），Hard 全过才收尾（Signal 按可维护性判断）
- 废弃组件走归档注释；禁止自主物理删除与被注释组件三重禁止；用户明确指令 → Conflict Card + 🗑 清单（删除由用户执行）
- 涉及更换用户组件 → `⚠️ 需用户决策` + 待决策清单
- CodeGraph 影响面分析先于修改
