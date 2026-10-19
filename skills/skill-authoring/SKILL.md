---
name: skill-authoring
description: >
  Skill 维护协议——骨架化（skeletonization）/ canonical source 分类（A/B/C）/
  内容下沉与 fallback / 残留验证纪律。供任何工程 Agent Skill 的维护任务
  作为协议事实源引用。只定义协议与自检模板，不定义具体工程任务路由
  （那由宿主 Skill 的 skill-maintenance profile 承载）。
---

# skill-authoring — Skill 维护协议

本 Skill 是 **Agent Skill 维护的协议事实源**，与具体工程 Agent 解耦：只定义"skill 怎么骨架化、内容下沉到哪、canonical source 怎么定、改完怎么验证残留"，不定义"维护任务在工程循环的哪个阶段激活"（那由宿主 Skill 的 `skill-maintenance` profile 承载）。

## 适用关系

- **宿主 Skill**（如 `vibe-coder-loop`）：其 `skill-maintenance` profile 在 S13 出口按本协议执行残留验证；其 governance 映射表（骨架↔规则映射）是宿主**自身**的实例资产，保留在宿主。
- **本 Skill**：提供通用骨架化协议 + canonical source 分类 + 下沉协议 + 可复用的自检脚本模板。

## 协议文件

| 文件 | 职责 |
|---|---|
| `governance-protocol.md` | 骨架化协议 · canonical source 分类（A/B/C） · 内容下沉与 fallback · 残留验证纪律 · 自检脚本架构 |
| `scripts/smoke-check-core.sh` | **检查逻辑唯一事实源**（被 source 的库，不单独执行）：日期/版本残留 · 死指针候选 · 映射与 key 存在性 · 加载计划一致性 · 表格列数 · 行数预算 |
| `scripts/smoke-check.sh` | 本 skill 实例化自检（薄包装：只做配置 + core 定位） |
| `scripts/smoke-check-template.sh` | 可复用实例化模板（复制此文件到目标 Skill，只改配置区；**禁止复制 core 逻辑**） |
