---
name: delx-memory-protocol
description: >
  通用记忆协议 Skill——记忆操作授权模型（增删改查常驻授权，自主执行）、
  三层记忆体系（实例→模式→原则）、命名空间隔离、
  Tag/scope 渐进加载、TTL、Relevance 评分、事实时序 supersession、
  Memory Consolidation、跨项目迁移。供采用 delx-memory 后端的工程 Agent
  Skill（如 vibe-coder-loop）作为协议事实源引用。只定义协议，不定义具体
  工程任务的出口/回写时机（那由宿主 Skill 承载）。
---

# delx-memory-protocol — 通用记忆协议

本 Skill 是 **delx-memory 后端的协议事实源**，与具体工程 Agent 解耦：只定义"记忆体系长什么样、怎么命名、怎么淘汰、怎么跨项目迁移、**谁有权增删改查**"，不定义"在工程循环的哪个阶段回写"（出口时机由宿主 Skill 的 state-machine 承载）。

## 适用关系

- **宿主 Skill**（如 `vibe-coder-loop`）：在其 Preflight/出口阶段按本协议检索/回写；其实例特化文件（Task→Memory Router、出口回写协议、S12 收尾、仪表盘字段）保留在宿主，**委托本 Skill** 提供通用概念。
- **本 Skill**：只提供协议；不持有运行时数据（dashboard / rollback-point 仍属宿主）。

## 协议文件

| 文件 | 职责 |
|---|---|
| `protocol.md` | **记忆操作授权模型（增删改查常驻授权）** · 三层体系 · 命名空间隔离 · Tag/scope · TTL · Relevance · supersession · Consolidation · 跨项目迁移 |

> 实例特化（宿主出口绑定 S2/S8/S12 的回写时机、任务类型路由表、仪表盘 upsert）不在此处——那由宿主 Skill 的 `learning/memory/lifecycle.md` 等实例文件承载，引用本协议的通用概念。
