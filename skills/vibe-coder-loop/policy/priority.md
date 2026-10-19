---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Priority Policy — 优先级系统

本文件定义三层优先级仲裁：
1. **Global Priority** — 价值维度（指针，见下方）
2. **Skill Conflict** — Skill 间冲突仲裁
3. **Rule Hierarchy** — 规则层级（R0 > R1 > P0 > ...）

> 价值维度排序（Safety > Security > Correctness > Maintainability > Performance > Style）为通用编程常识，不在本文件重述。机器可读形态以各 Skill `manifest.yaml` 的 `priority` 字段为准（Skill 未声明者默认 `style`，最低）。本文件只定义**项目特有**的仲裁机制。

## 1. Global Priority — 价值维度（指针）

价值维度排序与维度定义属通用编程常识，不在此重述（防冗余）。机器可读形态：各 Skill `manifest.yaml` 的 `priority` 字段；人类可读维度说明见各项目工程规范。本节仅保留为**仲裁入口指针**，供下游引用 `§1` 时解析至此。

## 2. Skill Conflict — Skill 间冲突仲裁

当多个 Skill 的规则冲突时，按以下顺序仲裁：

### 仲裁顺序

```text
1. Skill 自身声明的 priority 字段（manifest.yaml）
   - priority: safety > priority: security > priority: correctness > ...
   
2. 若 priority 相同，按 Skill 类型：
   - policy/ 规则 > engine/ 流程 > rules/ 细则 > learning/ 演化
   
3. 若仍相同，按文件加载顺序：
   - kernel.md > policy/*.md > engine/*.md > rules/*.md > learning/*.md
   
4. 若仍冲突，输出 Conflict Card，等待用户裁决
```

### Skill 间冲突示例

| 冲突场景 | 仲裁 |
|---------|------|
| `vibe-coder-loop` 要求强制 Review vs `frontend-project-selector` 要求快速初始化 | 看 manifest priority：safety（vibe-coder-loop）> 无声明（selector）→ vibe-coder-loop 赢 |
| `design-to-code` 的像素级还原 vs `vibe-coder-loop` 的函数行数阈值 | Correctness（设计还原）vs Maintainability（行数 Signal）→ Signal 让步，允许拆分 |
| `miniapp-develop` 的平台特定 API vs `vibe-coder-loop` 的跨平台抽象 | 项目特定经验（B 类）不进入 Skill，保存到 Project Memory |

### Skill 注册表

所有活跃 Skill 必须在 `manifest.yaml` 中声明 priority，未声明的默认 priority: style（最低）。

## 3. Rule Hierarchy — 规则层级

### 层级定义

| 层级 | 名称 | 来源 | 不可变性 |
|---|------|------|---------|
| R0 | Kernel Rules | `kernel.md` | **不可变** — 任何情况不可违反 |
| R1 | Safety Policy | `policy/safety.md` | **不可变** — 用户要求也不能绕过 |
| P0 | 用户明确目标 | 用户输入 | 高 — 但受 R0/R1 约束 |
| P0.5 | 用户偏好 | `preference:user:*` 记忆 | 中高 — 多次确认后沉淀 |
| R2 | Workflow Rules | `engine/` | 中 — 流程优化可调整 |
| R3 | Optimization Rules | 代码质量/性能优化 | 低 — 可牺牲以保安全 |
| R4 | Style Rules | 代码风格/格式 | 最低 — 个人偏好可调 |

### 最终仲裁顺序

**唯一事实源 = `kernel.md` §4**（常驻文件）；本文件不重述仲裁链与「安全规则（R0/R1）不可被效率目标和用户要求绕过」约束。

### 各层规则来源

| 层 | 内容来源（本文件不重述） |
|---|---|
| R0 Kernel Rules | `kernel.md`（三红线 / Evidence / SAFE MODE / 计数器 / 角色隔离） |
| R1 Safety Policy | `policy/safety.md`（不可逆操作清单 / Conflict Card / 约束分级 Hard·Signal / 归档注释格式） |
| P0 用户明确目标 | 用户字面表达（**受 R0/R1 约束**：说"删除所有旧代码"仍须先出 Conflict Card；**代码资产不由 Agent 物理删除**——出 🗑 清单由用户执行；本轮自产草稿可直接删改；**记忆条目**过四条件闸门——见 `kernel.md` §2） |
| P0.5 用户偏好 | 长期稳定偏好（Vue3 / TypeScript / 函数式等），多次确认后沉淀 `preference:user:*`；低于安全、高于普通优化。定义与沉淀协议唯一事实源 = `learning/memory/lifecycle.md`「用户偏好记忆系统」节 |
| R2 Workflow Rules | `engine/`（状态机流转 / 阶段出口条件 / 防跳过 / 上下文压缩边界） |
| R3 Optimization Rules | 可读性 / 性能 / 结构优化；**可牺牲**（与安全或用户目标冲突时延后） |
| R4 Style Rules | 格式 / 命名 / 注释风格；**最低**（冲突时最先让步） |

## 3.5 记忆裁决边界（Memory 不参与 Rule Hierarchy）

> 设计原则：**Memory 回答「上次怎样」，不回答「能不能 / 必须」。** 因此 Memory **不进入 §3 的 R0-R4 仲裁链**——系统中不存在「Memory 规则 > Skill 文件规则」的通路。
> 协议条目：`skill:policy/priority:conflict-resolution`（level:core, reference；其内容须与本节一致）。

**分级标签的适用范围**：`level:core / level:domain / level:tactical` **仅用于 `skill:*` 骨架规则条目之间**的定级（`skill:rules/*`、`skill:learning/*` 同属 R2 级内容的内部排序），**不授予其高于 `engine/`、`rules/` 文件的效力**。

**经验类记忆一律 Advisory**：`pattern:` / `lesson:` / `reflection:` / `experience:` / `preference:` —— 可影响判断（提供线索、先例、注意事项），**不可否决** Skill 的流程与硬约束。冲突裁决：

| 冲突 | 裁决 |
|---|---|
| 经验记忆 ↔ `engine/` / `rules/` 文件规则 | **文件规则胜**；经验仅作为提示输出，不改变流程 |
| 经验记忆 ↔ 用户偏好（P0.5） | 用户偏好胜（偏好是用户确认的稳定意愿） |
| 经验记忆 ↔ 经验记忆 | 按来源可靠性排序（E4 实测 > E3 图谱 > E2 文件 > E1 陈述 > E0 推测）；仍不可判 → 保留双方 + 标 `contradict`（Agent 自主裁决，见 `learning/memory/promotion.md`），仅涉 R0/R1 语义分歧时在输出提请用户 |

**唯二可影响高优先层的例外**：

1. 用户在当前对话中的显式指令（= P0，已在 §3 链中）
2. **`rule:` 型项目规则**（如 `rule:skill-iteration-manifest`）——scope 限定项目/任务、过 §3.6 准入与观察期的**可执行约束**；来源 = 用户指令沉淀 **或 Agent 自主创建（经观察期转正）**，视为**既定指令在该作用域内的延伸**，效力等同 P0 落地（仍不得越过 R0/R1）

**边界**：本机制**不改变**「操作安全红线」（该不该做某操作 → R0/R1 + Conflict Card 主导）。冲突事件计数计入 `skill:vibe-coder-loop:metrics` 的 `conflict` 字段（字段记号，非独立 key）。

## 3.6 `rule:` 准入与权限边界（Agent 可自主，靠准入 + 观察期守门）

> `rule:` **不是普通记忆的隐式升级通道**，而是**带作用域的、可具约束力的规则**。
> 定位：`experience / lesson / reflection / observation / preference → Advisory Memory`（不可否决文件规则）；`rule:` 是**唯一**被授权可具约束力的记忆类型。
> **授权（用户裁定）**：`rule:` 的增 / 改 / 删与其余记忆一样由 **Agent 自主执行**（记忆操作常驻授权，见 `delx-memory-protocol` §记忆操作授权模型）——**不带用户确认门控**；其安全性来自下述**准入条件 + 观察期 + 结构红线**，而非人工审批。

### 权限矩阵

| 问题 | 答案 |
|---|---|
| 谁可以创建？ | **Agent 可自主**——依据 = 当轮用户指令沉淀，或经观察期验证的经验聚合；须过下方准入四条件 |
| 谁可以修改？ | Agent 可自主；语义变更须在 value 内记「变更依据」，与现状冲突时在输出标注 |
| 谁可以删除？ | Agent 可自主（过 `policy/lifecycle.md`「记忆条目删除义务」两项自检） |
| 是否可以跨项目？ | **否**。scope 必须为 `scope:project` 或 `scope:task`，**禁止 `scope:global`** |
| 是否可以覆盖 Skill？ | 作用域内可覆盖 **R3/R4**（优化 / 风格）；**不得覆盖 R0/R1，也不得覆盖 `engine/` 的阶段流程**（结构红线，非用户门控） |
| 是否可以覆盖当前用户指令？ | **否**。用户当轮显式指令（P0）始终优先于已存 `rule:` |
| Agent 自主创建的 `rule:` 何时生效？ | **须先过观察期**：tags 必带 `auto_generated` + `pending_review`；3 次成功触发 → 转正（移除 `pending_review`）；连续 2 次失败 → 降级 + 标 `candidate-delete` |

### 准入四条件（全部满足才可创建）

1. **有事实依据可引用**——当轮用户指令原文，或经观察期验证的经验聚合（Evidence ≥ E2）
2. **scope 明确**（`project` / `task` 二选一）
3. **内容为可验证的具体约束**（非经验叙述；经验归 `lesson:` / `pattern:`）
4. **不与 R0/R1、`engine/` 阶段流程冲突**

### 加载纪律

- `rule:` **仅在 scope 匹配当前任务时进入上下文**（经 Task→Memory Router 召回）；不匹配 → 不加载
- 禁止无条件注入所有任务

### Agent 遇到"想写规则"时的动作

先判别性质：可迁移的**经验** → 写 `lesson:` / `pattern:`（Advisory）；**作用域内的可执行约束**且满足准入四条件 → **直接创建 `rule:`**（带 `auto_generated` + `pending_review`），输出标注 `📐 已建规则：rule:<key>（观察期：3 次触发验证）`。

## 4. 三层优先级关系

```text
Global Priority（价值维度，指针）
    ↓ 指导
Rule Hierarchy（规则层级）
    ↓ 约束
Skill Conflict（Skill 仲裁）
```

- Global Priority 是**价值判断**，回答"什么更重要"（通用常识，§1 指针）
- Rule Hierarchy 是**规则执行**，回答"听谁的"
- Skill Conflict 是**边界仲裁**，回答"跨 Skill 时听谁的"

## 5. 冲突解决示例（综合）

| 场景 | 仲裁 | 执行 |
|------|------|------|
| 用户："直接删除旧代码，不用保留" | Rule: R1>P0 → R1 赢 | 输出 Conflict Card + 「🗑 待删除清单」；**代码资产的物理删除由用户执行**（Agent 不删）；本轮自产草稿可直接删改 |
| 为了快速完成任务跳过 Test | Global: Correctness>Performance；Rule: R2>R3 → R2 赢 | 必须执行 Test，即使增加时间成本 |
| 用户偏好函数式（P0.5）vs 现有 OOP 风格（R4） | Global: Maintainability>Style；Rule: P0.5>R4 → P0.5 赢 | 新代码函数式，旧代码不强制重构 |

> 用户偏好的完整沉淀协议（识别条件/沉淀流程/禁止情况）唯一事实源 = `learning/memory/lifecycle.md`「用户偏好记忆系统」节。
