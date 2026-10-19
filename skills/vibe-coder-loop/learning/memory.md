---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Learning: Memory — 记忆协议（索引/导航）

> **本文件 = 索引/导航页**：保留原路径与全部节标题，供外部引用（delx-memory 记忆条目、engine/rules/policy 的 `learning/memory.md「节名」` 指针）稳定解析——命中节名后按导航表转至分片文件。

**协议唯一事实源（分片）**：

| 文件 | 负责域（节名 → 位置） |
|---|---|
| `memory/architecture.md` | 概念层：通用协议指针（→`delx-memory-protocol`）+ 实例特化（scope 归属/命名冲突实证/提升执行指针） |
| `memory/retrieval.md` | 检索侧：工具实际能力 / 上下文感知路由表 / **任务类型 → 规则/经验路由表（Task→Memory Router）** / CodeGraph 专用触发条件 / delx-memory vs CodeGraph 分工 / 检索量红线 / 性能优化 |
| `memory/lifecycle.md` | 写入侧与出口闭环：用户偏好记忆系统 / 记忆保存（三条路径）/ TTL 策略 / **记忆访问计数与元数据协议** / 跨项目失效传播 / Test→Lesson 学习闭环 / Quick Loop 记忆闭环 |
| `memory/promotion.md` | 质量与 S12 主体（**默认路径**）：**S12 收尾（2 步）** / 自动提升逻辑 / Pattern Fingerprint 算法 / 经验质量审计 / 去重协议 / Merge 治理协议 / 进化防抖：观察期协议 |
| `memory/advanced.md` | 触发式/周期式协议（**按需加载，不进 S12 默认路径**）：实例触发条件 + 执行绑定（通用概念指针→`delx-memory-protocol`；周期 Metrics 输出模板为本 skill 实例特化） |
| `skill-metrics.md` | 运行指标：**系统状态仪表盘（skill:vibe-coder-loop:metrics，每轮必更）** 为主；周期 Metrics 输出模板已下沉 `memory/advanced.md` |

**分级阅读（按 Loop Depth 决定加载文件，控制进入上下文的文件量）**：

- **Level 0/1（Quick Loop）**：仅读 `memory/lifecycle.md`「记忆访问计数与元数据协议」+「Quick Loop 记忆闭环」两节（消费回写协议 + Tool 调用，Quick Loop 出口必用）+ `memory/retrieval.md`「任务类型 → 规则/经验路由表」节（Level 0 轻量 S2 Step 0-1 最小召回）；出口更新仪表盘读 `skill-metrics.md`「系统状态仪表盘」节。其余节/文件跳过
- **Level 2+（Standard/Full Loop）**：S12 时读 `memory/promotion.md`（S12 收尾/提升/指纹/质量审计/去重/Merge/观察期）+ `memory/lifecycle.md`（回写契约）；**触发式协议（跨项目迁移 / Relevance / supersession / Consolidation / 失效传播）命中才读 `advanced.md`**；涉及概念/路由按需读 `architecture.md` / `retrieval.md`；仪表盘随 `skill-metrics.md`「系统状态仪表盘」节
- 单文件均 ≤ 原 memory.md 的 1/3，整文件 Read 一次即可读完（无需分段；单文件取用上限见 `memory/retrieval.md`「检索量红线」）
