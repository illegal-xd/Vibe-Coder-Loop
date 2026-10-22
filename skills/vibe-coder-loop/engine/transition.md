---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Transition — 状态转移规则

本文件定义各阶段的具体转移条件、出口检查清单、防跳过回退规则。

## 机器可读转移表（程序化镜像的事实源）

下面这个块是**本文件各节「转移」行的等价机器副本**，供 `runtime/core` 的 `core check-protocol` 逐边双向比对（缺边、多边都报；该校验器随 Phase 1 交付）。**人读正文仍是事实源**；改转移必须同时改块与代码表，否则门禁红。

```text
<!-- vc:transitions v1
# 语法：<from> -> <to>[, <to>]*        ;  "| pause" = 暂停等用户输入（不是状态，不落 phase）
# 修饰：(+1)=Loop+1   (loop=0)=Loop 归 0   (loop=1)=Loop 初始化   (loop=init)=首次进 S8 初始化为 1，已有 N+1 则保持   (resume)=维持原 Loop
#       (a/b)=该边允许多种 Loop 结果，调用方须显式指定（缺失 → INVALID_ARGUMENT）
# 自环：S8->S8（同轮自检修复）合法且 Loop 不变，不列为边
S0  -> S1
S1  -> S2 | pause
S2  -> S3, S4
S3  -> S4 | pause
S4  -> S5, S8(loop=1)
S4  -> S7(loop=0)                     # Investigation 分支（E 类只读）：跳过 S5/S6/S8/S9，loop 恒 0
S5  -> S6
S6  -> S7
S7  -> S8(loop=init), S10
S8  -> S9, S13
S9  -> S10, S8(+1)
S10 -> S11, S8(+1), S6(+1), S13
S10 -> S7(+1/loop=0)                 # Investigation：A 补充调查 = +1 / B 重新调查 = 归 0
S11 -> S12
S12 -> S13
S13 -> S0, S1(loop=0)
S14 -> S13, ALL(resume)              # 用户「停止/接受」→ S13；用户「继续」→ 恢复原 phase，Loop 不变
-->
```

**与状态转移图的关系**：`engine/state-machine.md`「状态转移图」中的「任何状态 → 检测到异常条件 → S14 Safe Mode」即上表 `ALL -> S14` 的**升级入口**（须用户可感知的风险报告，且从 S14 只能经「停止」或「继续」离开，不能自由跳转）。`S10 -> S6(+1)` 的递增**只发生一次**：随后 `S6→S7→S8` 继承同一 `N+1`，不二次递增。

## S1 Intent → S2 Preflight

> **Checkpoint（循环开始，强制）**：先读 delx-memory 条目 `vc:checkpoint:<项目绝对地址>`（不建项目内状态文件）——不存在 → 按 `<skill>/.state.template.md` 骨架初始化；存在 → 做 freshness + **13 字段**校验（含 `updated_at` 字段存在性，机械判定见 `scripts/smoke-check.sh` 6b；freshness 值由 `runtime.core load-checkpoint` 判定）。通过则按 `phase`/`current_step` 续跑（`completed` 项不重做）。协议唯一事实源 = `engine/state-machine.md`「Workflow Checkpoint（delx-memory）」。**阶段出口仅在有字段变化时写入该条目；轮次收尾（S13）必写一次 `status` + `resume`。**

**出口条件**：
- [ ] 目标三元组已输出（显式意图 + 隐含约束 + 风险标签）
- [ ] 任务分类已确定（A/B/C/D/E）
- [ ] 冲突预检已标注（无冲突 / 命中 → 进 Decision）

**转移**：
- 无冲突 → `>>> 进入 Preflight`
- 命中冲突 → `>>> 进入 Preflight`（Preflight 后进 Decision）

**暂停条件**：目标不明确 → 暂停，输出追问清单。

## S2 Preflight → S3 Decision / S4 Router

> **Level 0 轻量 S2 范围**：Level 0（Quick Loop）的 S2 仅执行第 1 项（Task→Memory Router 最小召回 Step 0-1）+ 消费清单记录；其余检查项（代码向检查）由 Level 1+ 执行。Level 0 与 S2 的职责边界见 `engine/complexity-gate.md`「Level 0 细分」（唯一事实源）。

**出口条件**：
- [ ] **Task→Memory Router 已执行（强制）**：S1 判定任务类型后，按 `learning/memory/retrieval.md`「任务类型 → 规则/经验路由表」执行对应**强制召回清单**（已知 key 用 `memory_get` 精确取值，不经 search；经验域用 `memory_search`，均须最小充分——防 snippet 截断 + 保证必中）。**路由表唯一事实源 = `learning/memory/retrieval.md`「任务类型 → 规则/经验路由表」节**（`skill:learning/memory:query-router` 条目为其可执行副本），本文件不重复清单内容。**此项为状态机强制动作，不依赖 Agent 自发检索**
- [ ] 上下文感知路由已执行（按用户输入特征选择 memory/codegraph 路径，清单外条目按需加载）
- [ ] CodeGraph 新鲜度检查已标注
- [ ] 版本号一致性检查已标注
- [ ] Feedback Loop 注入已标注（`[Feedback 命中]` 或 `[无反馈注入]`）
- [ ] **主动关联召回（按需，不取并集）**：仅当任务涉及跨项目复用时，按最相关的一类取 `memory_list(prefix="pattern:")` **或** `memory_list(prefix="principle:")`（Level 0/1 一律跳过）；命中已知模式再按需 `memory_get`；无此需求则跳过
- [ ] **记忆关联摘要已输出（命中时）**：命中 pattern/principle/相似任务 → 输出「💡 记忆关联」块；未命中 → 省略该块

**转移**：
- Intent 无冲突 → `>>> 进入 Router`
- Intent 有冲突 → `>>> 进入 Decision`

## S3 Decision → S4 Router

**出口条件**：
- [ ] Conflict Card 已输出
- [ ] 执行路径已选定

**转移**：
- High/Medium → `>>> 进入 Router`
- Low → 暂停，输出追问清单

## S4 Router → S5 Clarify / S8 Code

**出口条件**：
- [ ] Complexity Gate 已执行并输出 Level + Loop Depth
- [ ] 模式已确定（Quick Loop / Standard Loop / Full Loop）
- [ ] 高风险信号词检查已执行（若命中 → 已标注并升级）
- [ ] **运行时状态初始化（Tool / Runtime 承担，Agent 不逐字段计算）**：压缩归 Runtime 
      （`engine/state-machine.md`）；消费回写与仪表盘由 Tool 一条命令完成（`learning/memory/lifecycle.md`「回写契约」）；`.state.md` 已读且 `level` / `loop` 已写入

**转移**：
- Quick Loop（Level 0 / 0-Doc / 1）→ `>>> 进入 Code[1]`（各 Level 的激活阶段与跳过清单见 `engine/complexity-gate.md`「Loop Depth」）
- Standard Loop Level 2 / Full Loop Level 3/4 → `>>> 进入 Clarify`
- **Investigation 分支（E 类只读，Router 判定后）→ `>>> 进入 S7 调查计划`**（跳过 S5/S6/S8/S9；标注 `[Investigation Mode]`；边 = `S4→S7(loop=0)`）

## S5 Clarify → S6 Design

**出口条件**：
- [ ] 需求复述（工程化表达，引用 Intent 目标三元组）
- [ ] ≥1 个关键约束
- [ ] **歧义处理已标注**：存在真实歧义 → 输出追问清单（按价值排序，优先 ≤5 条）；无真实歧义 → 标注 `[无歧义]`，直接进入 Design

**判据（防「为追问而追问」）**：只有**答案会改变实现方案**的问题才算真实歧义。答案不影响方案的问题（命名偏好、文案措辞、可选增强项）→ 不追问，列入待决策清单或按项目惯例默认并标注 `[假设]`。

**转移**：`>>> 进入 Design`

## S6 Design → S7 Plan

**出口条件**：
- [ ] 模块划分 + 数据流已输出
- [ ] 状态矩阵完整性检查已执行（若涉及多状态操作）
- [ ] 先验证再假设已执行（若涉及"特殊处理"假设）
- [ ] 多页面镜像同步已检查（若涉及多页面操作）
- [ ] 记忆交叉验证已标注（涉及不确定判断时含 Confidence + Evidence）
- [ ] 引用了 Clarify 需求复述

**转移**：`>>> 进入 Plan`

## S7 Plan → S8 Code / Investigation 分支

**出口条件**：
- [ ] ≥1 个 Step 标"本轮完成"
- [ ] 计划中引用了 Design 阶段的模块划分
- [ ] Step 已声明依赖与完成判据（轻 Plan 可内联精简，见 `rules/plan.md`「轻 Plan」）
- [ ] 存在能力缺口的 Step 已写能力载体（无缺口则本项不适用，见 `engine/skill-routing.md`）
- [ ] 编排决策已输出（模式 + 判断依据 + 角色映射）
- [ ] 若产生可复用项目约束，按 `learning/memory/lifecycle.md` 路径 B/C 写入记忆

**转移**：`>>> 进入 Code`

**Loop 初始化**：S7→S8 首次进入时 Loop=1；若从 S10 情况 B 回退，S6/S7 已携带 N+1，S8 保持 N+1（不二次递增）。

**Investigation 分支**（E 类只读任务，Router 判定后生效）：
- S7 输出**调查步骤清单**（替代代码实现计划）→ 跳过 S8/S9 → `>>> 进入 S10 文档审查`
- S10 按 `engine/router.md` Investigation 分支三维文档审查（结论准确性/覆盖完整性/格式规范）
- 判定：情况 C → S11；情况 A → 回 S7[N+1]（补充调查）；情况 B → 回 S7[0]（重新调查）
- 全程标注 `[Investigation Mode]`

## S8 Code → S9 Test / 直接结束（Level 0）

**Level 0 特殊路径**：S8 Code 出口执行内联硬约束检查（**文档/配置类按 `policy/safety.md`「Level 0 文档修改约束子集」5 项**）+ **消费回写**（见 `learning/memory/lifecycle.md`「回写契约」），通过 → 直接输出结果结束（S9 Test / S11 Reflection / S12 Memory Evolution 跳过；S10 以文档子集 5 项内联执行，见 `engine/complexity-gate.md`「Loop Depth」矩阵）；违反 → 回退修复（1 轮上限）。

**Level 1/2/3/4 标准路径**：

**出口条件**：
- [ ] 前置检查已完成并标注结果（含 Reflection 反馈检索 + 异步状态防御）
- [ ] 代码中引用了 Plan 阶段的 Step 编号（Quick Loop Mode 跳过）
- [ ] **计划漂移校验已执行**（Level 2+）：实际修改/新增文件 **⊆** S7「计划契约」声明的文件集（契约定义见 `rules/plan.md`「计划契约」）。超出 → 输出 `[PLAN_DRIFT] 超出契约: <文件列表>` + `[next] <补记偏离理由 或 回 S7 重规划>`，**记录后继续**（不阻断，但不得静默扩大改动面）。**Level 0/1 无 S7 → 标「不适用」**
- [ ] **TASK 区可见性（压缩安全）**：**Level 2+** → 输出 📌 TASK 区全量字段（清单唯一事实源 = `engine/state-machine.md`「压缩后状态延续契约」表）；**Level 1** → 精简版（目标 + Level/Phase/Loop + 当前 Step + 下一步）；**Level 0** → `[Phase][Loop]` 标签即可。缺失 → 补输出后再进入 Test
- [ ] 关键决策说明已输出
- [ ] 若涉及不确定判断（3 类场景）→ Confidence + Evidence 已标注
- [ ] Lesson 检索已执行并标注结果
- [ ] 资产生命周期操作合规
- [ ] **不可修复的 Hard 项已上报**：已造成不可逆后果且无法回退 → `--vc-violation <事实>` 进 S14；可修复者仍走 S10 情况 B（分流见 `policy/safety.md` §3）
- [ ] 若本轮 Code 完成了一个版本功能/修改了 API 签名 → 标注 `[待 Memory Evolution]`
- [ ] **steering 队列检查**：若运行中存在 steering 消息（用户插话，见 `kernel.md` 双队列契约）→ 注入当前轮次后继续；注入后重新执行前置检查
- [ ] **能力载体适用性检查**：若 Plan 绑定了能力载体（技能 / 子 agent），执行中确认其与实际问题匹配；不匹配 → 按 `engine/skill-routing.md` 输出 `[Skill 切换]` 说明并更新对应 Step 绑定。未绑定则本项标「不涉及」

**转移**：`>>> 进入 Test`

**LLM 层自动重试**（S8 出口检查，API 调用失败时执行）：
- 触发：assistant 响应为可重试错误（429/5xx/网络超时/连接中断）
- 动作：自动重试，上限 2 次（指数退避 1s/3s），标注 `[Retry: N/2]`
- 成功 → 重试计数立即重置（防止跨轮累计）
- 重试耗尽 → 暂停，输出 `⚠️ LLM 调用持续失败（已重试 2 次）`，等用户决策（切换模型/检查网络/继续）
- 不可重试错误（400/401/认证失败）→ 不重试，直接暂停输出追问清单

**Level 0 文档类修改出口检查**（纯文档/配置单行修改，不涉及代码时替代代码出口）：5 项检查定义见 `policy/safety.md` 第 5 节「Level 0 文档修改约束子集」（**单一事实源**），此处不重述。

## S9 Test → S10 Review / S8 Code[N+1]

**出口条件**：
- [ ] 测试已执行（subagent 派发 / 降级自测 / Quick Loop 自测）并返回报告
- [ ] 报告引用了 Code 阶段的函数/类名
- [ ] 报告含验证结论；涉及不确定判断时含 Confidence + Evidence
- [ ] **Metrics 记账**：`{cycle:N, test_passed, failure_type, degradation}` 记入内存清单（收尾出口一次提交，聚合由 Tool 承担）
- [ ] **steering 队列检查**：若存在 steering 消息 → 注入后回到 S8 Code 继续（同一轮，不递增计数）
- [ ] **Hard 项不豁免**：回退前判 Hard 违规（清单见 `safety.md` §3）→ 命中则**不得以"测试失败"名义修补**，改走 S10 情况 B（回 `S6[0]`），违规修复合并其中

**转移**：
- 全通过 → `>>> 进入 Review`
- 有失败 **且无硬约束违反** → Lesson 已保存 → `>>> 回退 Code [N+1]`（不进 Review；Quick Loop 例外见 `rules/test.md`）
- 有失败 **且有硬约束违反** → 进 S10 → **情况 B**（见上项）

## S10 Review → S11 Reflection / S8 Code[N+1] / S6 Design[0]

**判定路径**：

> **两把尺子**：硬约束层 = **二值门**（`hard_violation_count`>0 → 直接 B 短路，不跑维度）；`issue_count` **只计维度层**（1–5→A；≥6/结构性→B）。明细见 `safety.md` §3 + `skill:rules/review:eight-dimensions`。

| 问题数 & 结构性问题（`issue_count` = 维度层） | 路径 | 计数器 |
|---|---|---|
| 0 处 | 情况 C → S11 Reflection 触发判定 | 停止 |
| 1 ～ 5 处 且 无结构性 | 情况 A → S8 Code[N+1] | N→N+1 |
| ≥6 处 或 存在结构性 或 硬性约束违反 | 情况 B → S6 Design[0] → S8 Code[N+1] | N→N+1 |
| N+1 > 3 | 输出已达最大迭代次数 → S13 Complete | 停止 |

> **硬约束违规的例外**：仅"可修复"的违规走情况 B；**已造成不可逆后果且无法回退** → 上报 `vc_violation` 进 S14（分流唯一事实源 = `policy/safety.md` §3）。

**情况 C 后置**：Review 通过后、输出最终结果前，先执行 S11 Reflection 触发判定，再执行 S12 Memory Evolution。

**S10出口操作**：
- [ ] **Metrics 记账**：`{cycle:N, result:A/B/C, issue_count, structural, hard_violation}` 记入内存清单
- [ ] **早期预警检查**（仅情况 C）：若本轮循环数 > avg_loops * 1.5 或失败类型占比 ≥15% → 触发早期 Reflection + 输出预警报告

## S11 Reflection → S12 Memory Evolution

**强制触发**（任一命中；本清单为 S11 门控事实源，与 `complexity-gate.md`「Loop Depth」矩阵同属 engine 层 gate）：
- 用户主动纠正 Agent
- 本轮曾发生 Review 情况 B（结构性回退）
- 同一类问题重复出现 ≥2 次（含 lesson 命中同根因）

**可选信号**（Agent 判断「确有可沉淀的规律」才做，不做不违规）：完成跨模块功能 / 架构调整 / 复杂 Bug / 高复用经验 / 高风险域 / 达最大循环 / Code Confidence=Low。明细见 `learning/reflection.md` + `skill:learning/reflection:triggers`。

**未触发** → 直接跳到 S12 Memory Evolution。

## S12 Memory Evolution → S13 Complete

**执行内容**：按 `learning/memory/promotion.md`「S12 收尾（2 步）」执行（唯一事实源，此处不重述）：[1] Tool 一条命令完成收尾回写（`touch` + `metrics`）→ [2] 有值得复用经验才输出「🧠 待保存记忆清单」（无则明文「本轮无沉淀」）。**Promotion / Dedup / Merge / Consolidation / 观察期 / Metrics 聚合由 Memory 系统（Tool / Runtime）承担，Agent 不在循环内逐项执行。**

**转移**：`>>> 进入 Complete`

## S13 Complete → S0 Idle

**出口条件**：
- [ ] **消费回写残留检查已执行**（覆盖「读取了记忆但未走到回写出口」的反复故障模式，见 `lesson:memory-metadata-overwrite`）→ 命令、输出格式与降级一律见 `learning/memory/lifecycle.md`「回写契约」
- [ ] **系统仪表盘更新已执行**（**每轮必更，0 事件也执行**；命令、字段与降级一律见 `learning/skill-metrics.md`「系统状态仪表盘」）→ 输出 `📊 系统仪表盘：<简表>`
- [ ] **Checkpoint 收尾已执行**：`.state.md` → `status: complete` + `resume` 写下一步（协议见 `engine/state-machine.md`「Workflow Checkpoint」）
- [ ] **技能/文档维护类任务：残留验证已执行（强制）**：本轮若改过技能文件（`vibe-coder-loop/*`、Vibe Coder Kernel、`kernel/` 文档）或 `skill:`/`rule:` 条目 → 执行 ① 日期/版本残留 grep + ② 死指针候选词 grep（**验证模式、合法例外与回退要求见 `rule:skill-iteration-manifest`**）；残留 > 0 → 回退修复后再收尾（教训 `lesson:skill-edit-date-residue`）
- [ ] **follow-up 队列检查**：队列非空 → 注入 → `>>> 回到 S1 Intent` 并 **Loop 归 0**（follow-up = 新目标，享独立重试预算；语义见 `kernel.md` §1）；队列为空 → 正常结束。**turn 间到达的追加消息落在下一 turn** → 按 `.state.md` 恢复协议处理（先核验 `pending`），不算本 turn 遗漏
- [ ] 输出最终结果
- [ ] 「📋 待用户决策清单」（若有）
- [ ] 扩展建议（**Level 2+ 且确有价值时**给 3–5 个改进方向；Level 0/1 可省略）

> 防跳过回退规则（引用清单 + 回退模板 + 计数规则）见 `engine/state-machine.md`「防跳过规则」节（唯一事实源）。

## VC 错误码族（结构化自纠信号）

> **目的**：把"出口检查不通过"从**方向性指令**（如"回退重新执行"）升级为**可判定、可自纠的结构化信号** —— 读到码即知下一步，不再重新推理失败原因。采用可判定的结构化错误码（如 `ACCESS_DENIED` / `POLICY_DENIED` / `OUTPUT_LIMIT`）。

**格式契约（强制）**：

```text
[<CODE>] <一句话事实>
[next] <唯一确定的下一个动作>
```

**铁律**：**不带 `[next]` 的输出不构成错误码**。`[next]` 必须是**单一确定动作**（不是"分析一下""考虑是否需要"）。

| 码 | 触发 | `[next]` | fail-closed |
|---|---|---|---|
| `RULE_NOT_LOADED` | 进入某阶段但该阶段必读文件未加载 | 加载对应文件后重跑本阶段出口 | 否（回退） |
| `RULE_NOT_FOUND` | 加载清单内文件在磁盘缺失 | 从 git 恢复该文件，或修正 `load_plan.json` | **是** |
| `LOAD_PLAN_MISSING` | `load_plan.json` 缺失或不可解析（≠ 规则条目缺失） | 从 git 恢复；临时应急用 `--files` 显式给出清单 | **是** |
| `RULE_STORE_MISSING` | 规则已下沉但 `skill:*` 条目不可用，且快照未恢复 | 执行 `memory_tool.py restore`；仍不可用 → **停止** | **是** |
| `EVIDENCE_INSUFFICIENT` | 关键判断 `[Evidence: E0]` 而场景要求证明 | 补 E2+ 证据（read / grep / codegraph），或降级为追问 | 否（降级） |
| `SCOPE_DENIED` | 操作超出授权（红线 / 生命周期 / 未授权项） | 输出 Conflict Card 或「🗑 待删除清单」，止步 | **是** |
| `PLAN_DRIFT` | S8 实际修改文件超出 S7 计划声明集合 | 补记偏离理由；范围变更 → 回 S7 重规划 | 否（记录后继续） |
| `NO_PROGRESS` | 连续 2 次 Code→Review 无改善（`kernel.md` §5） | 进 SAFE MODE，输出风险报告 | **是** |
| `LOOP_BUDGET_EXHAUSTED` | Loop 3 仍未通过 | 停止 + 建议升级 Loop 深度或人工介入 | **是** |
| `OUTPUT_LIMIT` | 工具输出达字节 / 行上限（**含显式 clamp**：`--limit` 超上限按上限执行时同样报此码，不静默） | 分页续取（`artifact page --offset`） | 否（分页） |
| `ARTIFACT_NOT_FOUND` | `artifact` ref 不存在或已过 24h TTL | `artifact list` 核对；源在则重新 put | 否（重建） |

**Tool 层运维码（补充登记）**：`memory_tool.py` / `smoke-check-core.sh` 另输出以下运维码，同守「不带 `[next]` 不构成错误码」铁律，属维护域（不进上表的工作流判定）：

`ARTIFACT_SOURCE_MISSING`（源文件缺失→核对路径）/ `ARTIFACT_NAME_INVALID`（`--name` 消毒后仍越界→改纯文件名；分隔符本身会被消毒）/ `ARTIFACT_REF_INVALID`（ref 形态或边界非法→核验 index 是否被篡改）/ `INVALID_ARGUMENT`（参数非正或正则非法→修正后重试）/ `DB_NOT_FOUND`（库路径缺失→--db 或 DELX_MEMORY_DB）/ `KEYS_CHECK_INPUT_MISSING`（key 清单为空→stdin 或 --files 传入）；smoke-check 侧：`RESIDUAL_HIT` / `MAP_INCONSISTENT` / `STRUCTURAL_INCONSISTENT` / `LOAD_PLAN_PATH_MISSING` / `LOAD_PLAN_UNDOCUMENTED` / `DEAD_POINTER_CANDIDATE`（唯一保留人工裁决）/ `BUDGET_EXCEEDED`（棘轮，只降不升）。

**运行时扩展码（确定性代码层登记）**：以下码由 `runtime/core`（状态/Checkpoint）与 `runtime/exec`（执行/产物）产生，**不属于工作流判定**——输出时必须带 **`[runtime]` 前缀**以示区分，且同样遵守「不带 `[next]` 不构成错误码」与 fail-closed 铁律。**登记在此仅为防混淆，不改变上表任何码的语义**。

| 码 | 触发 | `[next]` | fail-closed |
|---|---|---|---|
| `[runtime] STATE_ILLEGAL_TRANSITION` | 目标状态不在合法后继表（且不满足 S14 升级弧） | 回退执行当前阶段出口清单 | 是（不落盘） |
| `[runtime] STATE_REV_CONFLICT` | 并发写：`_rev` 与期望值不符 | 重新读取状态后重放本次转换 | 是（不落盘） |
| `[runtime] EXIT_CHECKLIST_INCOMPLETE` | 出口清单缺必填项，或引用无法机械解析 | 补齐缺项后重试 | 是（不落盘） |
| `[runtime] CHECKPOINT_LOCATION_UNRESOLVED` | 无法确定项目根，或解析结果落在 Skill 安装目录内 | 显式传 `--cwd` 或设 `VIBE_KERNEL_STATE_DIR` | 是 |
| `[runtime] CHECKPOINT_FOREIGN` | `_project_id` 与当前项目不符 | 备份该文件，按全新任务开始 | 否（降级） |
| `[runtime] CHECKPOINT_STALE` | freshness 不通过 | 核验 pending 后续跑；冲突以用户为准 | 否（降级） |
| `[runtime] CHECKPOINT_DEGRADED` | 仅扁平标量可解析 | 按 phase/loop 续跑，列表字段重新核验 | 否（降级） |
| `[runtime] CHECKPOINT_CORRUPT` | 严格与降级解析均失败 | 备份后全新开始 | 否（降级） |
| `[runtime] CHECKPOINT_SCHEMA_AHEAD` | `_schema` 高于支持版本 | 按新版协议手动恢复 | 否（只读） |
| `[runtime] CHECKPOINT_WRITE_FAILED` | 写入/加锁失败 | 检查权限或磁盘后重试；可手动维护 | 否（降级） |
| `[runtime] PROTOCOL_DRIFT` | 代码表与本文件机器可读块不一致 | 同步代码表或修正本文件 | 是（CI 门禁） |
| `[runtime] PHASE_TRANSITION_MISSING` | 连续多轮无 `vc_transition`（宿主适配层检测） | 若已出口则调用 `vc_transition` 并传 exit_checklist | 否（提醒） |
| `[runtime] ENV_ERROR` | Exec 层：命令不存在 / Python 解释器不可用 / 环境不可用 | 修正命令/PATH 后重试（不消耗 Loop） | 否 |
| `[runtime] TIMEOUT` | Exec 层：命令超时，整进程树已终止 | 缩小范围或提高 timeout 后重试（不消耗 Loop） | 否 |
| `[runtime] CANCELLED` | Exec 层：执行被取消（用户中断 / Adapter Esc），整树已终止 | 确认是否继续该步骤 | 否 |

**fail-closed 语义（硬约束）**：标 **是** 的码**不得降级继续** —— 停止并输出恢复建议，**禁止**"用残缺规则 / 陈旧摘要继续推断"。标否的码按 `[next]` 执行后继续，不消耗 Loop 计数（属同一轮内修正）。

**与既有机制的关系（不新增机制）**：`RULE_NOT_LOADED` = 防跳过规则的信号化；`SCOPE_DENIED` = 红线 / `policy/lifecycle.md` 的信号化；`NO_PROGRESS` = `kernel.md` §5 SAFE MODE 的信号化；`LOOP_BUDGET_EXHAUSTED` = `kernel.md` §7 计数上限的信号化。**本表只做信号编码，判定口径仍以各自条款为准。**
