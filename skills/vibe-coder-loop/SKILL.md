---
name: vibe-coder-loop
description: Vibe Coder Loop 工程循环 Skill。承载完整工程流程：Intent → Preflight → Decision → Router → Clarify → Design → Plan → Code → Test → Review → Reflection → Memory Evolution。Agent Prompt 只负责身份/安全/调度，本 Skill 负责全部 Workflow。采用 profiles 任务入口 + kernel/engine/rules/policy/learning 分层，按需加载。版本信息唯一来源：manifest.yaml。
---

本 Skill 是工程 Agent 的完整工作流定义。Agent Prompt 通过 Skill 调度激活本 Skill，本 Skill 内部按阶段加载对应文件。

> ⚠️ **首次使用必读（依赖声明 · fail-closed）**：`rules/`、`references/`、`learning/reflection.md`、`learning/evolution.md`、`learning/skill-metrics.md` 等为**骨架版**——完整规则内容下沉在 `skill:` 前缀的 delx-memory 条目中（映射表见 `references/governance.md`）。**首次部署或新机器克隆后，必须先执行** `python3 backup/memory_tool.py restore <规则快照或脱敏规则集>` 恢复 `skill:*` 条目。规则内容**不入库**（隐私约束）：`backup/snapshots/*`（本机快照）与 `backup/rules/*`（`export-rules` 生成的脱敏规则集）均由本机生成、均被 gitignore，跨机器只经安全私有通道传输。
>
> **缺失时不得降级继续**：`rules/` 规则条目不可用且快照未恢复 → 输出 `[RULE_STORE_MISSING]` + `[next]` 恢复动作并**停止**（信号定义见 `engine/transition.md`「VC 错误码族」），**禁止**用残缺摘要继续推断——"以为自己有规则其实没有"会产出难追溯的错误结论，返工成本高于直接停下。`manifest.yaml` `optional_integrations` 标注仅为**规则库之外**能力的依赖声明；规则库（`rule_store`）在 `required` 中，**不等于规则可缺失**。此时 `scripts/smoke-check.sh` 也会以 `MAP_INCONSISTENT`（key 校验失败）rc=1 退出——**属预期 fail-closed 状态，不是环境故障**。

**机器可读契约**：`manifest.yaml` 是 Skill 元数据的单一来源（版本/依赖/复杂度/优先级/成本，description 仅保留当前事实摘要）；**迭代历史唯一事实源 = `CHANGELOG.md`**。本文件为人类可读入口。

## 架构边界

| 层 | 职责 | 关键词 |
|---|------|--------|
| **profiles/** | 任务类型入口路由 | 任务分类 → 加载聚合（coding/debugging/refactoring/planning/review/skill-maintenance） |
| **kernel.md** | R0 核心不可变原则 | 身份/安全红线/Evidence/Rule Priority/SAFE MODE |
| **engine/** | **什么时候做** | 状态定义、转移条件、模式选择、复杂度分级 |
| **rules/** | **怎么做** | 格式模板、检查清单、输出规范 |
| **policy/** | **不能做什么** | 安全约束、生命周期、置信度、优先级 |
| **learning/** | **怎么进化** | 三层记忆体系（实例→模式→原则）、反思、Pattern Fingerprint、去重与评分、跨项目迁移、Metrics 驱动演化。**通用协议概念委托** `delx-memory-protocol` skill（三层体系/命名空间/Tag-scope/TTL/Relevance/supersession/Consolidation/跨项目迁移），本目录保留**实例特化**（出口绑定 S2/S8/S12 的回写/路由/提升/S12 收尾/仪表盘） |
| **`backup/memory_tool.py`**（Tool 层） | **确定性执行（How）** | runtime：`touch`·`metrics`（**Agent 调用**）｜maintenance：`backup`·`restore`·`verify`·`list`（技能迭代调用）；不做判断、不改数据模型 |

## 已采纳协议 Skill（委托关系）

本 Skill 的通用协议概念委托给两个独立 skill，避免协议与实例特化混载：

| 委托 skill | 提供的通用协议 | 本 Skill 保留的实例特化 |
|---|---|---|
| `delx-memory-protocol` | 三层体系/命名空间/Tag-scope/TTL/Relevance/supersession/Consolidation/跨项目迁移 | `learning/memory/lifecycle.md` 出口回写绑定 S2/S8/S12 · `retrieval.md` Task→Memory Router（任务类型） · `promotion.md` S12 收尾 · `skill-metrics.md` 仪表盘 upsert |
| `skill-authoring` | 骨架化协议/canonical-source 分类(A/B/C)/下沉与 fallback/残留验证纪律 | `references/governance.md` 本 skill **自身**映射表 · `profiles/skill-maintenance.md` 任务路由入口 · `scripts/smoke-check.sh` 本 skill 实例化自检脚本 |

> 委托 ≠ 删除：本 Skill 的实例文件保留有效（含实例绑定 + 实例触发条件），通用概念已裁指针至 `delx-memory-protocol`（阶段 5 已实施，拆分执行记录见 `CHANGELOG.md`）。

## 任务入口路由（Profiles）

> Profile = **任务入口路由卡**（Router），Rules = Authority：profile 只聚合"本类任务需加载的模块路径"，不复制任何规则内容；逐阶段文件清单以本文件「加载时机索引」为准，Level→激活阶段映射以 `engine/complexity-gate.md`「Loop Depth」矩阵为唯一事实源（`manifest.yaml` `complexity.levels` 为等价机器副本，冲突以 engine/ 为准）。任务类型判定在 S1 Intent 产出（与 `learning/memory/retrieval.md` 路由表共享同一分类）。

| 任务判定特征 | Profile | 对应任务分类 |
|---|---|---|
| 新功能/代码修改/性能优化/单点修复 | `profiles/coding.md` | A/B |
| 错误/堆栈/行为异常排查 | `profiles/debugging.md` | A（调试） |
| 结构调整/模块拆分/架构级代码变更 | `profiles/refactoring.md` | C/D |
| 大需求/设计先行/多 subagent 编排 | `profiles/planning.md` | D/混合 |
| 调研/审查/分析/文档产出（不产代码） | `profiles/review.md` | E |
| 修改 skill 文件/Vibe Coder Kernel/本仓库文档 | `profiles/skill-maintenance.md` | 技能维护 |

**使用方式**：S1 判定任务类型 → 读对应 profile（约 40 行）→ 按 profile 的 Required 清单加载模块 → 执行中逐阶段出口检查仍以「加载时机索引」+ engine 文件为准。

**Profile 冲突消解（唯一优先级，不评分、不加权）**：任务同时命中多个 profile 时**取最左**，**只加载该 profile**（其余命中项内联一句提示，不叠加加载）：

```text
skill-maintenance > debugging > planning > refactoring > review > coding
```

依据：纪律强度（反自改 + 残留验证）＞ 根因前置 ＞ 设计约束 ＞ 行为保持 ＞ 只读 ＞ 兜底最宽。Quick Loop 不强制读 profile，亦可直接走阶段表。

## 加载时机索引

| 时机 | 必读文件 | 说明 |
|---|---|---|
| **任何阶段开始前** | `kernel.md` | R0 核心原则，每次循环必读 |
| **元数据契约** | `manifest.yaml` | 版本/依赖/复杂度/优先级/成本元数据（机器可读，不按阶段加载；与 engine/ 流程文件冲突时以 engine/ 为准） |
| **运行时 Tool**（确定性执行） | `backup/memory_tool.py` | 加载计划 `preflight` / 结果外置 `artifact` / 消费回写 `touch` / 指标聚合 `metrics` / 快照 `backup`·`verify`·`list`。**Agent 不手写数值聚合**（覆盖边界见 `learning/skill-metrics.md`）；不可用时按各协议「降级」条款手工执行（Skill 只声明何时调用 + 失败怎么办） |
| **S1 Intent** | `engine/state-machine.md` S1 + `engine/transition.md` S1→S2 + `rules/intent.md` | 目标三元组+任务分类+冲突预检 |
| **S2 Preflight**（**入口第一步**） | `backup/memory_tool.py preflight --level <L> --task <T>`（**一次调用替代 N 次导航读取**，输出加载清单 + **按阶段裁剪的命中节 + 实测行号** + 成本对比 + 记忆候选；行号与节归属均运行时扫描 → 零漂移） | 取得**清单 + 命中节**后，按下「读取粒度」决定读哪些区间；阶段集可用 `--stage` 收窄 |
| **S2 Preflight** | `engine/state-machine.md` S2 + `engine/transition.md` S2 出口检查（**第 1 项：Task→Memory Router 强制清单**） + `learning/memory/retrieval.md`「任务类型 → 规则/经验路由表」（Level 0 轻量 S2 最小召回；协议全量导航见 `learning/memory.md`） | 环境检查+**Task→Memory Router 最小充分召回**+消费清单记录+Feedback 注入+主动关联召回（按需，不取并集，Level 2+） |
| **S3 Decision** | `policy/safety.md` + `engine/transition.md` S3→S4 + `rules/intent.md` Decision 章节 | 冲突仲裁+Conflict Card；涉及规则层级冲突时另读 `policy/priority.md` |
| **S4 Router** | `engine/complexity-gate.md` + `engine/router.md` + `engine/transition.md` S4 出口（运行时状态初始化） | Complexity Gate 分级 + Loop Depth → Quick/Standard/Full Loop 选择；**E 类（Investigation）任务另读 `engine/router.md` Investigation 分支** |
| **S5 Clarify** | `engine/transition.md` S5→S6 | 需求澄清 |
| **S6 Design** | `engine/transition.md` S6→S7 + `rules/design.md` | 高层设计+状态矩阵+先验证再假设+多页面镜像 |
| **S7 Plan** | `engine/transition.md` S7→S8 + `rules/plan.md`；**有编排决策为多 subagent/混合时另读 `rules/orchestration.md`**；**发现能力缺口时才读 `engine/skill-routing.md`** | 实现计划（五要素 Step）+ 编排决策 + 角色映射 |
| **S8 Code** | `engine/transition.md` S8→S9 + `rules/code.md` + `policy/safety.md` + `policy/lifecycle.md`；**出现能力缺口或需切换时读 `engine/skill-routing.md`**；**存在不确定判断时读 `policy/confidence.md`** | 编写代码+前置检查+安全约束+生命周期+（按需）Confidence/Evidence |
| **S9 Test** | `engine/transition.md` S9→S10 + `rules/test.md` | 测试验证+Verifier 角色+task spec+降级条款 |
| **S10 Review** | `engine/transition.md` S10→S11 + `rules/review.md` + `policy/safety.md` | 代码审查+Critic 角色+约束检查（Hard 短路 / Signal 计问题数）+情况 A/B/C 模板 |
| **S11 Reflection** | 先按 `engine/transition.md` S11 触发清单判定（**门控在 engine**；未命中 → 跳过本阶段、**不加载** `learning/reflection.md`）；命中才读 `learning/reflection.md` | 经验反思+Reflection Card（含 Pattern Fingerprint） |
| **S12 Memory Evolution** | `learning/memory/promotion.md` + `learning/memory/lifecycle.md`（回写契约）+ `learning/evolution.md`（**门控**：仅 [2] 经验沉淀出现 Skill Patch Proposal 候选时才读，未出现跳过）+ `learning/skill-metrics.md`；**触发式协议命中才加读 `learning/memory/advanced.md`**（跨项目迁移 / Relevance / supersession / Consolidation / 失效传播 / 周期 Metrics 输出模板） | 执行内容见 `promotion.md`「S12 收尾（2 步）」（唯一事实源，此处不重述） |
| **子 agent 首步** | `kernel.md` + `policy/safety.md` + `policy/lifecycle.md` + `policy/confidence.md` | 四件套加载包（定义见 policy/safety.md 第 5 节）；兜底 `delx-memory_memory_get` key=`agent:vc_constraints` |
| **输出格式疑问** | `references/output-format.md`（完整细则 `skill:references/output-format`） | 按需参考 |
| **多 Skill 布局疑问** | `references/layout.md`（多 skill 生态 + 委托分治 + 新增 skill 检查清单） | 按需参考 |
| **Review 格式参考** | `references/example.md` | 按需参考 |
| **调试模式触发** | `references/debug-mode.md`（完整内容 `skill:references/debug-mode`） | 按需参考 |
| **E4 真机验证** | `references/e4-matrix.md` | 按需参考（Test A–F 证据采集） |
| **循环状态恢复** | `<project_root>/.vibe-kernel/.state.md`（位置解析与隔离规则见 `engine/state-machine.md`「Workflow Checkpoint」；协议同节） | 循环开始必读；阶段出口必写 |

## 骨架 ↔ 规则条目映射（骨架化治理）

> 治理规则（骨架化原则 / Canonical Source 分类 A·B·C / 完整映射表 / 加载协议）**唯一事实源 = `references/governance.md`**，仅在修改 Skill 规则 / skill:* 条目时读取。S2 的规则条目检索动作**已由 `preflight` 输出的候选 key 清单承担**（见「加载时机索引」S2 行与「加载规则」两段式读），本文件不再保留第二条检索指令；命中域才 `memory_get` 的口径不变。

## 加载规则

1. **主 agent 进入对应阶段时必读对应文件**（用 read 工具读取 `vibe-coder-loop/` 下的文件）
2. **两段式读（默认工作方式，控制进入上下文的字符量）**：
   - **第一段**：S2 执行 `python3 backup/memory_tool.py preflight --level <L> --task <T>`，取得加载清单 + **按阶段裁剪的命中节（含实测行号）** + 成本对比（「整文件口径 → 按阶段命中，省 N%」）
   - **第二段**：按清单读取 —— 标「命中」的文件**只读所列行号区间**（`read` 的 `offset/limit`）；标「整文件」的按下方「读取粒度」表执行。**不要默认整文件读入**
   - **阶段集可收窄**：清单首行给出默认阶段集（来自 `load_plan.json` `level_stages[level]`）。**S1 冲突预检无冲突 → `--stage ^S3`**（从默认集排除，免手抄全清单——手抄漏 `S13` 会静默裁掉收尾义务）；循环中重读单阶段用 `--stage S8`；**需要被收窄阶段的内容时（如临时需要 S3 仲裁输入）重跑 preflight 补回该阶段**。`--stage` token 校验 S1–S13，非法即 `[INVALID_ARGUMENT]`
   - 命中节与行号**每次实时扫描生成、不写死**（避免漂移成死指针）；`stage_sections` 映射失效时自动**回退整文件**（fail-safe，宁可多读不漏读）

### 读取粒度（按命中节读，不按整文件）

| 情形 | 读法 |
|---|---|
| 清单标「命中 N 行」 | 只读所列 `L<起>-<止>` 区间（一个文件可能对应多个区间；`S<N>→L…` 前缀标明该节属哪个阶段） |
| 清单标「整文件」且 ≥120 行 | 按所附章节索引选取相关 H2 节，只读该节行区间（「整文件」标记不预设命中——靠索引自定位，无相关节则整读） |
| 清单标「整文件」且 <120 行 | 整文件读（小文件无索引，索引本身也是上下文成本） |
| `engine/transition.md` | 标题自带阶段号 → 按 `S<N>` 机械匹配；`VC 错误码族` 各阶段出口都可能用到，**恒含** |
| 出口条件引用整节契约 | 见「防跳过规则」——**引用对象须完整读入**，此时不受本节收窄 |

> **优先级（消解歧义）**：文件内**怎么读**以本「读取粒度」表为准（两段式读第二段引用本表，不再另立整文件读法）；哪些文件**必须进上下文**以「分级加载」为下限、「加载时机索引」为上限（并集）。例外不受本表收窄：`kernel.md`（`always_whole`，R0）与**子 agent 四件套**必须整文件读（安全红线）。
3. **子 agent 首步必读（四件套）**：`kernel.md` + `policy/safety.md` + `policy/lifecycle.md` + `policy/confidence.md`
   - 双通道兜底：read 不可用 → `delx-memory_memory_get` key=`agent:vc_constraints`（完整兜底版）
   - 加载包定义见 `policy/safety.md` 第 5 节
4. **大产出外置（控制本轮后续上下文的字符量）**：S9 全量测试日志 / S10 逐项审查结果 / S6 状态矩阵等**超过约 100 行**的产出 → `memory_tool.py artifact put` 落盘，上下文只留 `ref` + 投影视图（`--fields` / `--equals` / `--grep` / `--limit` / `--count`）；需要明细时 `artifact page` 分页续取。**禁止把全量日志直接倒进上下文。**
5. references 为按需参考，非强制
6. 防跳过规则适用：未加载对应文件即输出阶段内容 → 回退重新执行（信号 `[RULE_NOT_LOADED]`，见 `engine/transition.md`「VC 错误码族」）

> **边界**：本节属**前馈侧**（控制"什么进入上下文"），是 Skill 职责；**反馈侧**（压缩时机 / 阈值，即"什么离开上下文"）**完全属 Runtime**，Skill 不设阈值、不请求压缩。两侧不重叠（见 `engine/state-machine.md`「上下文压缩（Runtime 负责）」）。

### 分级加载（控制进入上下文的文件量）

按 Loop Depth 控制 rules/ 层加载量，避免 Quick Loop 读取全量流程文件：

> **前馈 / 反馈边界**：本节只决定「加载哪些文件」（前馈，Skill 职责）；压缩阈值与时机属 Runtime（见上节边界声明）。确定性执行（回写 / 指标）由 `backup/memory_tool.py` 承担，不计入 rules/ 加载量。

| 模式 | rules/ 必读 | policy/ 必读 | learning/ 必读 |
|---|---|---|---|
| Quick Loop（Level 0/1） | `intent.md`（S1 激活时读，目标三元组格式）+ `code.md`（Level 1 加 `test.md`+`review.md`） | `safety.md` + `confidence.md`（涉及资产归档时加 `lifecycle.md`） | `memory/lifecycle.md`「记忆生命周期管理」节（内含「记忆访问计数与元数据协议」回写契约，Quick Loop 出口必用）+ `memory/retrieval.md`「任务类型 → 规则/经验路由表」节（Level 0 轻量 S2 Step 0-1 最小召回）；出口内联走 lifecycle「Quick Loop 记忆闭环」节，仪表盘读 `skill-metrics.md`「系统状态仪表盘」节 |
| Standard Loop（Level 2） | 激活阶段的全部 rules/（intent/design/plan/code/test/review） | 全部 policy/ | S12 时 `memory/promotion.md` + `memory/lifecycle.md` + skill-metrics.md；概念/路由按需 `memory/architecture.md` / `memory/retrieval.md`；**触发式 `memory/advanced.md` 命中才读** |
| Full Loop（Level 3/4） | 全部 rules/（含 orchestration.md 编排决策时） | 全部 policy/ | 全部 learning/（`memory/advanced.md` **为纯触发式**——不在加载清单内，命中其触发条件才读；S11 `reflection.md` 仍按门控读） |

- Level 0-Doc（内容写作型）：rules/ 仅 S1 引用 `rules/intent.md` 目标三元组格式，其余不读（S8 出口三维审查定义在 `engine/router.md`）
- 防跳过规则仍适用：进入某阶段但未加载对应文件 → 回退；**本表与「加载时机索引」冲突时按加载范围取并集**（本表为下限，索引为上限；仅指文件加载范围，与记忆召回无关——召回取最小充分，见 `learning/memory/retrieval.md`）
- 子 agent 四件套不受分级影响（安全约束全量加载）

