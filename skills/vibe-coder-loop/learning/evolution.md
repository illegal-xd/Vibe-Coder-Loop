---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Learning: Evolution — Skill 演化机制（骨架版）

> **骨架化说明**：Patch Proposal 格式/Evaluation 标准/Human Approve 响应/触发条件表/Pattern-Driven 映射/经验分类已下沉为 `skill:` 规则条目（level:domain, permanent——加载全文执行）；检索失败按本文件摘要降级执行。

本文件定义 Agent 如何基于经验提出 Skill 优化建议。

## 核心原则（不可违反）

**Agent 禁止自动修改 Skill，只能提出提案，由人工确认后更新。**

```text
禁止路径：Agent → 直接修改 SKILL.md 或任何 Skill 文件。
```

## 演化流程（强制）

```text
Agent 积累经验 → Patch Proposal（对话末尾输出）→ Evaluation（自评影响）
  → Human Approve（"接受"/"修改后接受"/"忽略"）→ Skill Update（人工执行）
```

## 触发条件（摘要）

经验重复出现 **≥3 次** 且满足任一：任务失败/Review 不通过、Skill 流程缺口、用户反馈、Pattern 自动提升事件、失败类型占比 ≥15%（以落库 metrics 为准；**此为 Evolution 触发条件，非 S10 运行时预警阈值——后者见 `learning/skill-metrics.md`「早期预警」**）。**禁止**根据想象增加复杂规则。完整表见 `skill:learning/evolution:trigger-conditions`。

## 提案与确认（摘要）

- Patch Proposal 格式（问题模式/建议变更/触发条件/预期收益/影响评估/来源经验）见 `skill:learning/evolution:patch-proposal`
- Evaluation 标准（数据支撑 ≥3 条或占比 ≥15%/复杂度可控/无重复/可回退）见同条目；**不通过 → 降级为 Rule Candidate（观望区）**
- Human Approve：接受/修改后接受/忽略 响应格式见同条目

## 经验类型分类（摘要）

| 类型 | 定义 | 处理 |
|---|---|---|
| A. Skill 缺陷 | Agent 通用行为问题 | 可进入 Skill |
| B. 项目特定经验 | 框架配置/业务规则/技术栈方案 | 保存 Project Memory，**不进 Skill** |
| C. 候选规则 | 偶发/样本 <3 | Rule Candidate 观望 |

完整分类 + Pattern-Driven Proposal 映射表 + 防膨胀检查见 `skill:learning/evolution:trigger-conditions`。

## 协议有效性验收（记忆审计）

> 属**治理/演化**职责（非运行时 Metrics）：协议是否**真实生效**，以 delx-memory 中的实际数据为准（而非协议文本）。

| 协议 | 验收标准（记忆里应有） |
|---|---|
| 实例层（lesson/reflection） | 存在 `lesson:` / `reflection:` 条目，value 为高质量内容（含根因/口诀/模式） |
| 模式/原则提升 | 存在 `pattern:` / `principle:` 条目（同类 lesson ≥3 时） |
| Metrics 闭环 | 存在 `skill-metrics:vibe-coder-loop:<周期>` 条目 |
| 去重治理 | lesson/reflection 无大量同根因重复条目 |
| 沉淀闭环 | 已沉淀 Skill 的经验带 `skill-evolved` 标记 |

**某协议持续 0 执行 → 视为纸面协议，应收缩或删除**（防"规则存在 ≠ 规则生效"）。
