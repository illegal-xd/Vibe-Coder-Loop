---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Skill Routing — 能力缺口驱动的 Exception Path

> **Routing 是例外路径，不是每个 Step 的固定动作。**
> **默认：用当前能力执行。** 只有执行中发现**明确的能力缺口**时，才走 Routing。

**适用范围**：S7 Plan（可选绑定）+ S8 Code（发现缺口时切换）。**Level 0/1 不激活**——不为 Routing 而 Routing。

**与 S4 Router 的边界**：S4 选的是**工作流模式**（由 Complexity Gate 决定）；本协议选的是**完成某步骤所需的能力载体**（技能 / 子 agent / 内置阶段）。两者互补，互不替代。

## 决策链路（缺口驱动）

```text
默认执行（S8 Builder / S9 Verifier / S10 Critic + 现有工具 = 能力载体）
    ↓
发现明确能力缺口（当前能力覆盖不足 / 问题本质与预期不同）
    ↓
扫描候选：① 本机已注册技能 ② 子 agent ③ 领域专项技能
    ↓
有明显更匹配者 → 绑定并执行（给一句 Why）
无明显优势   → 继续用当前能力（不 Routing）
```

## 输出格式（有 Routing 时才输出）

```text
- 需要能力：<能力描述>
- 能力载体：<技能名 / 子 agent / 内置阶段>（Why：<一句话>）
```

无 Routing 的步骤**不必输出任何 Routing 说明**（不要为了证明"我做过 Routing"而输出）。

## 执行中切换（S8 出口检查）

```text
[Skill 切换]
- 原载体：<原绑定>
- 发现：<为什么不适合（证据）>
- 切换：<新载体>
- 原因：<更匹配的理由>
```

切换后同步更新 Plan 中对应 Step 的绑定；Plan 结构不变，不重启循环。

## 防 Routing 循环（本节是 Routing 唯一的硬约束）

- 当前能力已适用 → 继续执行，**不重新 Routing**
- 只发现"另一个可能更好" → **不切换**（无明确能力缺口）
- 明确不适用（覆盖不足 / 问题本质不同）→ 才允许切换

## 与约束分级的边界

路由到外部能力**不改变约束等级**：`policy/safety.md` §3 的 **Hard** 项对任何执行者生效（子 agent 同受约束，见 `policy/safety.md` §5-6）。
