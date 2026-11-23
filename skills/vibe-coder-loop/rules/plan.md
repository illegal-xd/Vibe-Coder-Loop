---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Plan 阶段细则（卡片）

[Phase: Plan]
[Loop: 0]

> **卡片化说明**：Step 拆分格式 / 编排决策判据表 / 角色映射下沉在 `skill:rules/plan:step-orchestration`，本文件只留要求、轻 Plan 例外与**计划契约**（`engine/transition.md` S8 引用）。

**要求**：可执行、可拆分——Code 之前必须知道"这次任务怎么做"。
**角色**：Architect（只设计不写码）。

## 加载

`memory_get skill:rules/plan:step-orchestration`（Plan 六问 + Step 六要素 + 编排决策格式）。条目不可用 → `[RULE_STORE_MISSING]` 停止。

## 文件内硬要求

- 优先复用现有字段（Goal ← Design 模块划分；Requirements ← Intent 三元组 + Clarify 约束），**不新增重复字段**
- Step 的「为什么」「完成判据」「验证」须能减少 Code 阶段的重新决策，禁止"因为用户要求 / 运行测试"这类泛化描述
- **能力绑定默认不写**：仅当 Step 存在明确能力缺口时按 `engine/skill-routing.md` 写一行，不把 Plan 变成 Skill 列表
- **轻 Plan**：Level 2 单点任务允许 Goal + 3–5 个 Step（含依赖与完成判据，可内联 Code 输出）；Level 0/1 无 S7，天然无 Plan

## 计划契约（S8 漂移校验的输入，定义在此）

```text
### 计划契约
- 预期修改：<文件路径列表>
- 预期新增：<文件路径列表 / 无>
- 预期删除：<文件路径列表 / 无>（Agent 不执行物理删除，仅标注）
```

- 语义 = **可观察的修订快照**，不是意图声明；计划不得被静默替换
- 范围确需变更 → **回 S7 重规划并重新声明契约**，不在 S8 悄悄扩大改动面
- 校验在 S8 出口执行（实际改动 ⊆ 契约；超出 → `[PLAN_DRIFT]` 记录后继续）

## 出口

`engine/transition.md`「S7 Plan → S8 Code / Investigation 分支」（唯一事实源，含计划契约项）。
