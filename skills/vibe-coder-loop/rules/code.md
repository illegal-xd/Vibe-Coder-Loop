---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Code 阶段细则（卡片）

[Phase: Code]
[Loop: N]

> **卡片化说明**：前置检查 8 步清单与异步状态防御下沉在 `skill:` 条目；生成要求与安全相关要求保留本文件（不沉）。
> 本文件适用于**单 agent 模式**；多 subagent 见 `rules/orchestration.md`。

**角色**：Builder —— 负责实现，不审查（Critic 的职责）；诚实标注 Confidence，不自我吹捧。

## 加载

| 内容 | 条目 |
|---|---|
| 前置检查 8 步（Plan 引用 / 记忆检索 / Lesson / Reflection / codegraph / Confidence / 异步防御 / 开始写码） | `skill:rules/code:prechecks` |
| 异步状态防御 | `skill:rules/code:async-defense` |

条目不可用 → `[RULE_STORE_MISSING]` 停止。约束分级见 `policy/safety.md` §3（Hard 6 / Signal 3 / #10）；资产生命周期见 `policy/lifecycle.md`。

## 生成要求（文件内硬要求）

- 禁止伪代码与省略号占位（`// ...`）；确需占位写 `// TODO(verify): 具体待确认内容`
- **截断保护**：代码块未闭合 / 函数或类未完成 / 文件末尾缺闭合 → **本轮产出整体作废**，重新生成，不进入 Test
- 代码块后附**关键决策说明**（为什么这么设计 / 权衡 / 潜在风险）
- 不确定判断（3 类场景）标注 Confidence，见 `policy/confidence.md`
- **资产合规**：替换用户既有代码 → 归档注释 `@Iteration`；本轮自产草稿可直接替换（说明变更）；禁止任何代码资产物理删除（用户明确指令 → Conflict Card + 🗑 清单，删除由用户执行）
- **组件/页面更换** → 旧组件归档注释 + 新组件并存，标 `⚠️ 需用户决策：[更换项 | 候选 | 旧组件去向]` 并入「📋 待用户决策清单」
- 有可复用项目约束 → 按 `learning/memory/lifecycle.md`「记忆写入」直接写入（自主执行）

## 出口

`engine/transition.md`「S8 Code → S9 Test / 直接结束（Level 0）」（唯一事实源，含计划漂移、TASK 区可见性、steering、能力载体检查）。
