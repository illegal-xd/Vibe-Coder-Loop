---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# 多 subagent 编排模式细则

本文件在 Plan 阶段编排决策为「多 subagent」或「混合」时加载。单 agent 模式不加载（用 `rules/code.md`）。

## 设计原则

1. **双层上下文注入**：常驻约束（约束分级 Hard/Signal + 三红线 + 归档格式 + 资产生命周期）通过子 agent 首步加载四件套获得（`policy/safety.md` 第 5 节：kernel + safety + lifecycle + confidence）；**项目上下文**通过 task spec 中【记忆继承】字段指定 memory key；任务特定内容内联在 task prompt
2. **复用现有机制**：待决策清单、情况 A/B 回退、codegraph 接口校验、Conflict Card 仲裁
3. **计数器零改动**：subagent 均为一次性调用不循环；仅主 agent 的 Code→Review 计数
4. **角色人格化**：subagent 分派时明确角色身份，避免"工具化"调用

## 角色人格化映射

主 agent 在不同阶段切换角色，subagent 也按角色身份派发：

| 阶段 | 角色 | 由谁扮演 | 职责 |
|---|---|---|---|
| S7 Plan | Architect | 主 agent | 模块划分 + 编排决策 + 接口契约 |
| S8 Code | Builder | 主 agent 或 subagent | 实现代码 |
| S9 Test | Verifier | **subagent 优先**（不可用则降级自测） | 验证实现符合契约 |
| S10 Review | Critic | 主 agent | 独立审查 |

> S1/S3/S11/S12 仅为 Phase Label（见 `engine/state-machine.md`「角色约束」），不设人格。

> 上表阶段号即状态机编号（唯一事实源 = `engine/state-machine.md`），不引入独立编号体系。

**核心约束**：Builder ≠ Verifier ≠ Critic。多 subagent 模式下，写码 subagent 标注为 Builder 身份，测试 subagent 标注为 Verifier 身份，主 agent 在 Review 切换到 Critic 身份。

## 派发流程

1. 主 agent（Architect 角色）在 Plan 阶段输出编排决策 + 分发图（见 `rules/plan.md`）
2. 用 `task-async`（并行）或 `task`（串行）派发——task spec 内联在工具的 prompt 参数里，**显式声明角色身份**（"你扮演 Builder 角色，实现模块X..."）
3. subagent 首步强制加载常驻约束包（定义见 `policy/safety.md` 第 5 节）：`read kernel.md + policy/safety.md + policy/lifecycle.md + policy/confidence.md`（或 `delx-memory_memory_get` key=`agent:vc_constraints` 兜底）；同时按 task spec 中【记忆继承】字段 `memory_get` 读取模块上下文
4. subagent 一次性产出，不进入 Vibe Coder 循环

## 写码 task spec 格式

```text
【角色】Builder（实现者，与 Verifier/Critic 隔离）
【任务】实现 <模块名>，对应 Plan 阶段 Step <编号>
【设计上下文】<Design 阶段该模块的职责/接口/数据流，摘录>
【接口契约】<函数签名/导出/依赖的其他模块接口>
【记忆继承】首步用 delx-memory_memory_get 读取以下 key 获取项目上下文：
  - reference:memory-navigation（导航，必读）
  - project:xxx-module-<对应模块>（按任务选）
  - project:xxx-frontend-conventions（编码约定）
  若 key 不存在则跳过，不阻塞
【约束】首步按序 read 加载四件套（kernel.md → policy/safety.md → policy/lifecycle.md → policy/confidence.md），严格遵守约束分级（Hard 项）+ 三红线 + 归档格式 + 生命周期（read 不可用时用 `delx-memory_memory_get` key=`agent:vc_constraints` 兜底）
【验收】Hard：无空 catch / 无硬编码密钥 / 未删用户既有资产 / 归档用 @Iteration；Signal（≤30 行 / ≤300 行 / ≤4 参数）按可维护性判断、非违规；不确定判断（3 类场景）标 Confidence
【产出】返回完整代码 + 关键决策说明（为什么这么设计）+ Confidence 标注
```

## 整合阶段（subagent 全部返回后，主 agent 执行）

1. 用 `codegraph_search` + `codegraph_callers` 校验各模块接口对齐（签名/类型/调用关系）
2. 接口不一致项 → 标注 `⚠️ 需用户决策：[冲突项 | 候选方案]` 并入「📋 待用户决策清单」（复用 `kernel.md` 规则 3 机制）
3. **结论级复核（不可只查接口 + 资产）**：子 agent 的「已修 / 已注释 / 已删除 / N 处零引用」都是**转述**，须按 `skill:rules/orchestration:subagent-reverify` 三类核查后再采信（复核动作 + 反模式见该条目，加载全文执行）
4. 主 agent 对冲突项做临时适配（归档注释冲突实现 + 并存引入新实现），不阻塞
5. 整合后的完整代码作为本轮 Code 产出，进入 Test（**优先派发 Verifier subagent**；派发不可用时降级自测但仍须视角隔离，见 `rules/test.md`）

## 失败回退与计数器

| 场景 | 动作 | 计数器 |
|---|---|---|
| Test subagent 报告失败 | 回退 Code[N+1]，主 agent 自修或重分发失败模块 | N→N+1 |
| 某 subagent 产出违反硬约束 | 主 agent 整合阶段即拦截，走 Code[N+1] 自修 | N→N+1 |
| Review 情况 A（≤5 问题） | 现有流程：Code[N+1] 修复 | N→N+1 |
| Review 情况 B（结构性/硬约束违反） | 现有流程：回退 Design[0]→Code[N+1]（不重置，上限拦截见 `kernel.md` §7 计数器规则） | N→N+1 |
| subagent 本身 | 一次性调用，不循环 | 不计入 |

**关键**：subagent 永不循环。任何 subagent 产出的问题都由主 agent 在 Code 阶段接管，走主 agent 的计数器。计数器语义与单 agent 模式完全一致，零改动。

## 三红线 + 资产生命周期在 subagent 的生效

- 子 agent 首步加载四件套（kernel + safety + lifecycle + confidence，定义见 `policy/safety.md` 第 5 节）即受 Hard 6 项 + Signal 判定 + 三红线约束 + 生命周期管理
- **主 agent 是资产保护最终责任人**：整合阶段 + Review 阶段逐项复核子 agent 产出（**资产维度**）；**结论维度**同属主 agent 责任 —— 见「整合阶段」第 3 项
- 子 agent 违反三红线/生命周期 = 主 agent Code[N+1] 接管修复（同时回退违规操作：把删除改为归档、把跳级归档补回 Deprecated 阶段）
