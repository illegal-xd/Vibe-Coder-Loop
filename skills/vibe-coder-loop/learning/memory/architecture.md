---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Learning: Memory/Architecture — 记忆架构（概念层）

> **Canonical 分治声明**：本文件的**通用概念**（三层体系 / 命名空间 / Tag-scope / TTL / Relevance / supersession / Consolidation / 跨项目迁移）canonical home = `delx-memory-protocol/protocol.md`；本文件 = **实例特化 + 指针**（通用概念已裁指针，非第二 canonical，非 fallback 副本）。修改通用概念以 `delx-memory-protocol` 为准。**执行侧协议**（写入/检索/提升/出口，实例绑定 S2/S8/S12）见同目录分片：`lifecycle.md`（保存/TTL/计数协议）、`retrieval.md`（路由表/查询策略）、`promotion.md`（提升/去重/S12 收尾）；运行指标见 `../skill-metrics.md`。导航入口 = `../memory.md`（索引）。

## 通用概念（指针）

以下通用协议的完整定义见 `delx-memory-protocol/protocol.md`，本文件不重述：

| 主题 | protocol.md 节 |
|---|---|
| 三层记忆体系（实例/模式/原则 · TTL · 提升阈值 · Key 格式） | §三层记忆体系 |
| 命名空间隔离（项目哈希绑定 · CodeGraph 作用域） | §命名空间隔离 |
| Key 命名规范（`skill:<skill-name>:<slug>` · 禁止 `skill:system:*`） | §命名空间隔离 |
| Tag 权重体系（p_critical/p_high/p_medium/stale/skill-evolved/preference） | §Tag 权重体系 |
| scope 维度（scope:global/project/task · 渐进加载时机） | §Tag 权重体系 |

## 实例特化（本 skill 绑定）

- **前缀规范完整版**：lesson 主题式命名 / `experience:{主题}` / `global:{主题}` 等前缀细则以 `reference:memory-nav-conventions` 记忆为准（导航已拆分为入口 `reference:memory-navigation` + 5 分片，按需加载）。
- **scope 归属实例**：技能维护类规则 = `scope:project/<project>` + `scope:task`，绝不升级为全局 p_critical（其他项目无需加载）；全局核心（红线/身份）才用 `scope:global` + `p_critical`。
- **命名空间冲突实证**：`skill:system:*` 无 owner 致多 skill 互相覆盖——见 `../skill-metrics.md`「系统状态仪表盘」D8 注。
- **自动提升执行**（阈值触发逻辑/系统侧输出）见 `promotion.md`「自动提升逻辑」节——概念定义在 protocol.md §三层记忆体系，执行绑定在 promotion.md。
