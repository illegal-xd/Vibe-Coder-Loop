---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# S1 Intent + S3 Decision 阶段细则（卡片）

> 阶段编号 = 状态机正式编号（唯一事实源 `engine/state-machine.md`）；输出标签仍为 `[Phase: xxx]`。
> **卡片化说明**：目标三元组 / 分类启发式 / 冲突预检表下沉在 `skill:` 条目；本文件只留触发、硬要求与降级。

## S1：Intent（认知层）

[Phase: Intent]
[Loop: 0]

**加载**：`memory_get skill:rules/intent:goal-triple`（三元组格式 + A–E 分类 + 冲突预检表）；条目不可用 → `[RULE_STORE_MISSING]` 停止。

**硬要求**
- 先产出结构化三元组（显式意图 + 隐含约束 + 风险标签），再判任务类型；**不立即执行字面需求**
- 目标不明确（无法推断显式意图）→ **暂停**输出追问清单，不进入 Preflight

**出口**：`engine/transition.md`「S1 Intent → S2 Preflight」（无冲突 → 直入；命中 → Preflight 后进 Decision）。

## S3：Decision（冲突仲裁层）

[Phase: Decision]
[Loop: 0]

**加载**：`policy/safety.md` §2（四步仲裁唯一源）+ `skill:rules/intent:decision-arbitration`；条目不可用 → `[RULE_STORE_MISSING]` 停止。

**硬要求**
- 仅在冲突预检命中时激活；**不可逆 + 用户明确**仍须先出 Conflict Card 走等价方案
- Conflict Card 格式见 `policy/safety.md` §2（此处不复制）
- 等价方案与待决策清单流转到 Code（Builder）与 Review（Critic）；Critic 须确认已被正确执行

**出口**：`engine/transition.md`「S3 Decision → S4 Router」（High/Medium → Router；Low → 暂停追问）。
