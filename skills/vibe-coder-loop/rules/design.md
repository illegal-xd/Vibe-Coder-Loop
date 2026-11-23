---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Design 阶段细则（卡片）

[Phase: Design]
[Loop: 0]

> **卡片化说明**：三条专项规则与记忆交叉验证细则下沉在 `skill:` 条目，本文件只留触发条件、禁止项与降级。

## 必输出

核心模块划分 + 数据流 + 状态/副作用位置 + 技术选型理由（如有）。

## 三条专项规则（触发即 `memory_get`，加载全文执行）

| 规则 | 触发 | 条目 |
|---|---|---|
| 状态矩阵完整性 | 涉及多状态操作（状态流转 / 审批流 / 生命周期） | `skill:rules/design:state-matrix` |
| 先验证再假设 | 写"需要特殊处理 / 需要兼容"之前 | `skill:rules/design:verify-first` |
| 多页面镜像同步 | 列表页与详情页（或其他页面）共享操作逻辑 | `skill:rules/design:mirror-sync` |

**禁止**：仅按主状态定义操作矩阵（漏子状态）；未验证现有逻辑就假设需要特殊处理；多页面独立演化导致行为不一致。

## 记忆交叉验证

出口前 `memory_search` 相关模块记忆：一致 → `[记忆验证通过]`；部分不一致 → `⚠️ 设计偏离已有架构` + 待决策清单；明显冲突 → **以当前代码事实为准**（`[Confidence: Medium]` + `[Evidence: E3]`），标注后继续，**不暂停**（记忆为 Advisory，见 `policy/confidence.md`）。

条目不可用 → `[RULE_STORE_MISSING]` 停止。

## 出口

`engine/transition.md`「S6 Design → S7 Plan」（唯一事实源）。
