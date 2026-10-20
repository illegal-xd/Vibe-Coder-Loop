---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Plan 阶段细则（骨架版）

[Phase: Plan]
[Loop: 0]

> **骨架化说明**：Step 拆分格式与编排决策详表已下沉为 `skill:rules/plan:step-orchestration`（level:domain, permanent——加载全文执行）；条目不可用 → 按 `SKILL.md` 的 fail-closed 规则输出 `[RULE_STORE_MISSING]` 并停止；本文件摘要只用于定位，不得作为规则推断依据。

**要求**：可执行，可拆分。Plan 必须让 Agent 在开始 Coding 之前真正知道"这次任务应该怎么做"。

**角色人格化**：Plan 阶段主 agent 扮演 **Architect** 角色，负责模块划分 + 编排决策 + 接口契约定义。Architect 不写代码（那是 Builder 的职责），只设计结构。

## Plan 必答项（增强）

Plan 必须能够回答下列问题（简单任务可内联精简，见「轻 Plan」节）：

```text
1. 要完成什么？          → Goal（引用 Design 模块划分）
2. 为什么这样做？        → Requirements（引用 Intent 目标三元组 + Clarify 关键约束）
3. 需要修改哪些部分？    → Implementation Steps（Step 拆分）
4. 修改顺序是什么？      → Step 编号顺序
5. 哪些任务存在依赖？    → Step 依赖声明（Dependencies）
6. 每一步完成后如何判断可以继续？ → 完成判据 + 验证方式
```

**优先复用现有字段**：Goal ← Design 模块划分；Requirements ← Intent 目标三元组 + Clarify 约束。**不新增重复字段**，仅按引用表达。

## Step 拆分格式（增强）

每步包含五要素（超简单步骤可省略「为什么」与「验证」）：

```text
1. Step A（本轮完成）
   - 为什么：<本步的关键实现决策是什么 + 为什么这样决策>（禁止"因为用户要求/需要实现功能"——必须给出能减少 Code 阶段重新决策的信息）
   - 需要能力：<能力描述> → Skill 绑定：<Skill/子agent/内置阶段>（Why：<一句话>）
   - 依赖：<Step N / 无>
   - 完成判据：<系统/代码达到的可观察最终状态>（禁止"代码修改完成/功能完成"——须可被外部观察验证，如"失效 token 请求返回 401，有效 token 路径保持不变"）
   - 验证：<直接证明完成判据的动作>（Verification ↔ Completion Criteria 一一对应；禁止"运行测试"这类无对应关系的泛化描述）
2. Step B（本轮完成）
   ...
3. Step C（未来扩展）
```

**依赖链**：Step 间依赖用「Step N 依赖 Step M」声明，必要时输出依赖链摘要（如 `1 ← 2 ← 3 ← 4`），保证执行顺序可验证。

**能力/Skill 绑定（可选）**：默认**不绑定**——内置阶段能力即能力载体。**仅当某 Step 存在明确能力缺口**时，才按 `engine/skill-routing.md`（Exception Path）写一行能力载体推荐。**不要把 Plan 变成 Skill 列表**；无缺口一律不写。

## 轻 Plan

Level 2 单点任务（如"增加一个 API 字段"）允许精简 Plan：Goal + 3-5 个 Step（含依赖与完成判据，可内联在 Code 阶段输出），不强制输出完整五要素。**Level 0/1 无 S7 阶段，天然无 Plan**。

## 编排决策（Plan 阶段末尾输出）

主 agent 在 Plan 阶段自主判断写码模式（单 agent / 多 subagent / 混合，判据表 + 角色人格化映射格式见 `skill:rules/plan:step-orchestration`）：

```text
### 编排决策
- 模式：[单agent / 多subagent / 混合]
- 判断依据：[模块数/依赖关系/规模/风险等级]
- 角色人格化映射：（主 agent → Architect → Critic；Builder；Verifier 等）
- 分发图（多subagent模式时）
- 测试subagent：unit-test-agent / e2e-test-agent
- Confidence: <High/Medium/Low>
```

## 计划契约（供 S8 漂移校验）

Plan 出口必须声明**预期修改文件集**（计划契约），供 S8 出口做漂移校验：

```text
### 计划契约
- 预期修改：<文件路径列表>
- 预期新增：<文件路径列表 / 无>
- 预期删除：<文件路径列表 / 无>（Agent 不执行物理删除，仅标注；见 `policy/lifecycle.md`）
```

**契约语义**：这是一个**可观察的修订快照**，不是意图声明 —— S8 出口拿它与实际改动集对比。**计划不得被静默替换**（保留已观测的修订与保护集，而非用新输入悄悄顶掉计划）。范围确需变更 → **回 S7 重规划**并重新声明契约，而不是在 S8 悄悄扩大改动面。

**校验口径**（在 S8 出口执行，见 `engine/transition.md` S8 节）：实际修改/新增文件 **⊆** 契约集合；
- 子集 → 通过
- 超出 → 输出 `[PLAN_DRIFT] 超出契约: <文件列表>` + `[next] <补记偏离理由 或 回 S7 重规划>`，**记录后继续**（不阻断，但必须留痕）

**轻 Plan 适用性**：Level 2 单点任务可只写「预期修改」一行；**Level 0/1 无 S7，校验不适用**。

## 出口条件

- [ ] 至少 1 个 Step 标记为"本轮完成"
- [ ] 计划中引用了 Design 阶段的模块划分
- [ ] Step 已声明依赖与完成判据（轻 Plan 可内联精简）
- [ ] 存在能力缺口的 Step 已写能力载体（无缺口则本项不适用）
- [ ] 编排决策已输出（模式 + 判断依据 + 角色映射 + Confidence）
- [ ] **计划契约已声明**（预期修改/新增/删除文件集；轻 Plan 可只写「预期修改」一行）
- [ ] **若产生可复用项目约束，按 `learning/memory/lifecycle.md`「记忆写入」直接写入**（自主执行，无逐次确认）
→ 满足后输出 `>>> 进入 Code`。
