---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Router — 工作流选择

本文件定义 S4 Router 阶段的判定逻辑。Router 在 Preflight/Decision 之后、具体工程阶段之前执行。

## 输入

- S1 Intent 目标三元组（显式意图 + 隐含约束 + 风险标签）
- S2 Preflight 环境检查结果（项目状态 + 记忆 + CodeGraph）
- S3 Decision Conflict Card（若触发）
- **Complexity Gate 输出**（Level + Loop Depth + 判据 + 置信度）

## 前置：Complexity Gate

Router 不再直接判定规模与风险，改为调用 `engine/complexity-gate.md` 获取 Level 分级和 Loop Depth。复杂度判定流程、信号词、判据标准、Loop Depth 矩阵均在 Complexity Gate 文件中定义。

**判定优先级（E 类 vs Level 0-Doc）**：判定依据 = **是否有文档 / 内容产出物**——有产出物（文档 / 知识笔记）→ 走「Level 0-Doc」路径；仅结论或报告文本（问题清单、调研结论）→ 走「Investigation 分支」。

## Quick Loop 细则（L0 / L0-Doc / L1）

**共性**：不强制读 profile；只跑本 Level 的激活阶段（矩阵见 `engine/complexity-gate.md`）；出口内联检查（Level 0/1 只跑**安全向**，Signal 项不查）；不合格 → 回退修复 1 轮上限，仍不过 → 建议升级 Standard Loop。

| 变体 | 触发 | 流程要点 |
|---|---|---|
| **Level 0** | 无可执行逻辑变更 | S1 内联 → S2 最小召回 → S4 判级 → S8 → 出口（代码向：内联安全向检查；文档/配置：`policy/safety.md`「Level 0 文档修改约束子集」）→ 结束 |
| **Level 0-Doc** | 文档 / 内容产出（含整理·总结·新增章节语义） | 同 L0；S2 加素材与经验检索；S8 出口改**三维审查**（准确性 / 覆盖 / 格式，格式见 `references/output-format.md`） |
| **Level 1** | 单文件代码修改 | S1 → S2（codegraph 定位 + lesson 检索）→ S4 → S8 → S9 轻量自测（≥1 项可观察验证）→ S10 轻量审查（安全向 + 正确性 / 可读性）→ 结束 |

**Level 0-Doc 边界**：仅限文档 / 无逻辑变更；涉及代码修改（即使单文件）归 Level 1+。
**Metrics**：Quick Loop 不落库；仅收尾回写 + 仪表盘一行。

## Standard Loop 模式（Level 2）

标准工程循环，适用于大多数任务。全阶段激活，各阶段细则见 `rules/` 目录。

### Investigation 分支（E 类任务，只读/无代码产出）

当任务分类为 **E. Investigation**（调研/审查/分析/评估，明确不产代码）时，走只读路径：

**流程**：S1 → S2 → S4 → S7（调查计划）→ S10（文档维度审查）→ S11 → S12

- **跳过**：S3/S5/S6/S8/S9（无代码产出，不激活代码链）
- **S7 Plan**：输出调查步骤清单（替代代码实现计划）
- **S10 Review**：审查对象为调查产出（问题清单 / 结论报告），**代码向约束（安全 / 资产 / 密钥）不适用**，改用：结论准确性（Evidence ≥ E2）/ 覆盖完整性 / 格式规范（`references/output-format.md`）三维检查
  - **结论口径**：零引用 / 死代码 / 未使用导出类结论按 `skill:references/dead-code-audit` 分档（范围含 examples 与文档站，三档分开给），不合并成单一数字
  - **篇幅/结构**：多轮编辑的文档另按 `skill:rules/review:doc-structure-recheck` 重跑结构指纹
- **Review 判定**：情况 C（结论可靠）→ S11；情况 A（局部补充调查）→ 回 S7[N+1]；情况 B（结论不可靠需重查）→ 回 S7[0]
- **输出标注**：阶段输出前标注 `[Investigation Mode]`

**判定依据**：S1 Intent 任务分类为 E 且用户未要求产出代码；若调查中需要验证代码假设 → 可局部调用 codegraph/Read，不进入 S8。

## Full Loop 模式（Level 3/4）

全量工程循环，含多 subagent 编排。Plan 阶段必须输出编排决策（见 `rules/plan.md`）。

## 出口条件

出口检查唯一事实源 = `engine/transition.md`「S4 Router → S5 Clarify / S8 Code」（本文件不重述）；满足后输出 `>>> 进入 <模式> 流程`。
