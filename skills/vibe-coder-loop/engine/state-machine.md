---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# State Machine — 状态机定义

本文件定义 vibe-coder-loop 的完整状态机。所有阶段、状态转移、循环控制均以此为准。

## 状态定义

| 状态 | 阶段标签 | Loop | 角色 | 说明 |
|---|---|---|---|---|
| S0 Idle | — | — | — | 等待用户输入 |
| S1 Intent | `[Phase: Intent]` | 0 | —（Phase Label） | 认知层：理解目标 |
| S2 Preflight | `[Phase: Preflight]` | 0 | — | 环境层：检查项目状态 |
| S3 Decision | `[Phase: Decision]` | 0 | —（Phase Label） | 冲突仲裁（条件触发） |
| S4 Router | `[Phase: Router]` | 0 | — | 工作流选择（Complexity Gate → 模式映射） |
| S5 Clarify | `[Phase: Clarify]` | 0 | — | 需求澄清 |
| S6 Design | `[Phase: Design]` | 0（首次）/ N+1（情况 B） | Architect | 高层设计 |
| S7 Plan | `[Phase: Plan]` | 0 | Architect | 实现计划（Step 五要素：为什么/能力绑定/依赖/完成判据/验证） |
| S8 Code | `[Phase: Code]` | N | Builder | 编写代码（执行中 Skill 不匹配 → 重新路由，见 `engine/skill-routing.md`） |
| S9 Test | `[Phase: Test]` | N | Verifier | 测试验证 |
| S10 Review | `[Phase: Review]` | N | Critic | 代码审查 |
| S11 Reflection | `[Phase: Reflection]` | N | —（Phase Label） | 经验反思（条件触发） |
| S12 Memory Evolution | `[Phase: Memory Evolution]` | N | —（Phase Label） | 记忆演化 |
| S13 Complete | — | — | — | 循环结束 |
| S14 Safe Mode | `[Phase: SAFE MODE]` | — | — | 异常保护状态 |

## 状态转移图

```text
S0 Idle
  → 用户输入 → S1 Intent

S1 Intent
  → 目标明确 + 无冲突预检 → S2 Preflight
  → 目标明确 + 冲突预检命中 → S2 Preflight → S3 Decision
  → 目标不明确 → 暂停（追问清单）→ 等待用户输入 → S1 Intent

S2 Preflight
  → 环境检查完成 → S4 Router（若 S1 无冲突）或 S3 Decision（若 S1 有冲突）

S3 Decision
  → Confidence=High/Medium → S4 Router
  → Confidence=Low → 暂停（追问清单）→ 等待用户输入 → S1 Intent

S4 Router
  → 按 Level/Loop Depth 映射进入各模式（**激活阶段唯一事实源 = `engine/complexity-gate.md`「Loop Depth」矩阵**；各模式内部细则见 `engine/router.md`）：
  → Quick Loop Level 0 / 0-Doc / 1 → S8 Code[1]
  → Standard Loop Level 2 / Full Loop Level 3/4 → S5 Clarify
  → Investigation 分支（E 类只读）→ S7 Plan（调查计划）

S5 Clarify
  → 需求对齐 → S6 Design

S6 Design
  → 设计完成 → S7 Plan

S7 Plan
  → 计划完成 → S8 Code[N]

S8 Code[N]
  → Level 0：出口内联 Review 后完成 → S13 Complete
  → Level 1+：代码完成 → S9 Test[N]

S9 Test[N]
  → 全通过 → S10 Review[N]
  → 有失败 → 保存 Lesson → S8 Code[N+1]（**Quick Loop 例外**：不回退 Code，直接输出 `⚠️ Quick Loop 未通过，建议升级为 Standard Loop`，见 `rules/test.md`）

S10 Review[N]
  → 按 `engine/transition.md` S10 判定路径表：情况 C → S11 触发判定；情况 A → S8 Code[N+1]；情况 B → S6 Design[0] → S8 Code[N+1]；N+1 > 3 → S13 Complete
  → Level 1：出口回写后完成 → S13 Complete

S11 Reflection
  → 触发条件命中 → 输出 Reflection Card → S12 Memory Evolution
  → 未触发 → S12 Memory Evolution

S12 Memory Evolution
  → 收尾 2 步（[1] 回写 + [2] 有经验才沉淀）→ S13 Complete

S13 Complete
  → 出口检查清单（**完整定义见 `engine/transition.md` S13 节，唯一事实源，此处不重述**）
  → follow-up 队列非空 → 回到 S1 Intent 且 **Loop 归 0**（新目标，享独立重试预算；语义见 `kernel.md` §1）；为空 → 输出最终结果 + 待决策清单 → S0 Idle

任何状态
  → 检测到异常条件 → S14 Safe Mode

S14 Safe Mode
  → 用户「继续」 → 恢复原 phase（`_resume_from`）且**维持原 Loop N**（`kernel.md` §1）
  → 用户「停止循环」或「接受当前代码」 → S13 Complete
  → 无用户响应 → 停在 S14（SAFE MODE 是暂停，不是终止）
```

## 异常路径收敛表（4 类）

> **全部异常处理必须归入以下 4 类**。本表只做**归类 + 指向既有规则**，不新增任何机制、不改变各条款细则（细则仍以各自文件为准）。

| 类 | Agent 动作 | 既有规则源（细则不在此重述） |
|---|---|---|
| **Retry** | 自动重试，上限 2 次（指数退避） | LLM 429 / 5xx / 超时 / 断连 → `transition.md` S8 出口「LLM 层自动重试」 |
| **Rollback** | 回退指定阶段（**仅 Test 失败 / Review A·B 递增 Loop**；Level 0/1 出口修复与 subagent 降级**不递增**） | Test 失败 / Review A → S8[N+1]；Review B → S6[0]；Level 0/1 出口不合格 → 修复（1 轮上限）；subagent 不可用 → **降级形态**（阶段流不变，措辞见 `rules/test.md`） |
| **Pause** | 输出追问清单 / 进度快照，等输入 | Confidence Low；S1 目标不明；Retry 耗尽；引用对象缺失**且不可重建**；用户"停止循环 / 接受当前代码" |
| **Safe Mode** | 停自动修改 + 风险报告 + 等确认 | `kernel.md` §5 触发表（含**无进展**） |

**不算异常（不进上表）**：**Queue** = steering / follow-up，进 `kernel.md` §1 双队列，不触发以上任一类；**Runtime Recovery** = Compaction / overflow，属宿主职责，Agent 只按「压缩后继续执行」+ Checkpoint 恢复；**Degradation** 非独立类，是 Rollback 类下的执行形态变化。

## 循环计数规则

| 规则 | 说明 |
|---|---|
| Loop 计数起点 | 第一次进入 S8 Code 时 Loop = 1 |
| 递增条件 | S9 Test 失败 或 S10 Review 判定情况 A/B → 回退 S8 Code 时 Loop + 1 |
| 不递增条件 | S6/S7 回退属同一轮内修正，Loop 不变 |
| 上限 | Loop 3 仍未通过 → 停止并输出警告 |
| 重置 | **仅三条边归 0**：`S13→S1`（follow-up / 新任务）、`S10→S7`（Investigation 情况 B 重新调查）、`S4→S7`（Investigation 入口，pre-code 恒 0）。**不存在"继续循环即重置"路径**——SAFE MODE「继续」与契约外兜底暂停的恢复**均维持原 Loop N**（机器块 `(loop=0)` 只标注这三条边） |

> **Case B 记号**：`Design[0]` 中的 `0` 是设计阶段**重入序号**，不是 `loop` 字段；`S10→S6` 时 checkpoint `loop` 已为 `N+1`，`S6→S7→S8` 继承该值（机器块见 `engine/transition.md` `S10 -> S6(+1)`）。**输出标签一律用计数器值 `[Loop: N+1]`**——`Design[0]` 只出现在文档/表格的记号位置，不得作为 `[Loop: …]` 标签输出（`kernel.md` §6 标签契约）。

## 角色约束（只保留改变行为的 4 个角色）

| 阶段 | 角色 | 为什么保留 |
|---|---|---|
| S6 / S7 | **Architect** | 只设计不写码——防止在设计阶段就落实现细节 |
| S8 | **Builder** | 诚实标注、不自我吹捧、不审查自己的产出 |
| S9 | **Verifier** | 假设 Builder 有 bug，主动找反证（写测分离） |
| S10 | **Critic** | 独立挑刺、不手软 |

**核心约束**：**Builder ≠ Verifier ≠ Critic** —— 三角色不可由同一视角同时承担，这是消除"作者自审"偏见的硬约束。

**其余阶段名（Intent / Decision / Reflection / Memory Evolution）仅为 Phase Label**，不设人格、不写行为规则、不要求"扮演"。

**硬约束 vs 手段**：**视角隔离**（Verifier/Critic 独立于 Builder）不可降级；**subagent 派发**可降级（无派发工具/被拦截 → 降级自测，但须满足：① **先声明预期**——测前写"会通过的假设"，测后逐条对照；② **主动找反证**——≥1 边界/反例 + 回答"什么输入会出错"）。标注措辞见 `rules/test.md`；Critic 以"假设我是另一个工程师"视角审查。

## 上下文压缩（Runtime 负责）

> ⚠️ **验证状态（常驻提醒）**：本条「压缩后状态延续契约」在**「会话内压缩」维度未经真机观测**（R3–R8 共 26 次判定均为规则层推演 + 盲测，`[Evidence: E2/E3]`）。**「跨会话恢复」维度已取 E4**：另一会话写 Checkpoint 条目 → 全新 agent 真机读取并推出入口阶段/下一步（见 `references/e4-matrix.md` Test D-1）。
> **触发核对（出现任一即采集）**：① 压缩后无法确定 Phase / Loop N / 下一步；② context overflow 或 TASK 字段缺失（如 S10 情况 B 引用不到 S6 模块划分）；③ 用户反馈进度信息丢失。
> **采集动作**：当场填 `references/e4-matrix.md`「D-3 现场采集卡」→ 列入「📋 待用户决策清单」，**不暂停循环**（除非同时命中 `kernel.md` §1，此时以暂停优先）→ 据实补 E4 证据，被证伪则改本条契约并同步 CHANGELOG。详见 `lesson:compaction-e4-unverified-reminder`。

**执行者边界（架构事实）**：Context 管理（窗口 / 工具输出上限 / 压缩 / 摘要重建 / 阈值）属 Runtime，不同宿主机制不同；本 Skill 不实现压缩、不设阈值、不算 token 预算、不假设压缩命令。Agent 只承担「压缩后继续 + 信息获取规范 + E4 提醒」。

### 压缩后状态延续契约（Context Zone）

压缩由 Runtime 执行；本节的职责是回答「**压缩后 Agent 能否继续工作**」，即规定**哪些状态必须存活**、哪些可丢。分区只声明延续性，不是压缩算法：

| 区 | 内容 | 延续性 |
|---|---|---|
| **❄️ STATIC** | `kernel.md` + `policy/` + 当前阶段 `rules/`（= system prompt 前缀） | Runtime 常驻，跨轮 byte-identical |
| **📌 TASK** | ① 目标三元组（显式意图 + 隐含约束 + 风险标签 + **冲突预检标注**；= S1 输出中须可引用的部分，S1 另含任务分类但由意图派生、不需单独存活）② Complexity Level ③ 当前 Phase ④ Loop N ⑤ S7 Step 编号（含完成/未完成标记 + 当前 Step 完成判据/验证方式）⑥ 验收标准 ⑦ 关键决策（Confidence/Evidence）⑧ 待用户决策清单 ⑨ **上一阶段输出指针**（S2 环境结论 / S5 需求复述 / S6 模块划分）⑩ 上轮失败原因 + 上轮 Review 判定（A/B/C）⑪ SAFE MODE 触发依据计数（定义见 `kernel.md` §5）⑫ 待注入队列（steering / follow-up）⑬ 本轮待保存经验（摘要） | **必须存活**：压缩后须能恢复「当前目标 / 阶段 / 进度 / 已完成 / 未完成 / 下一步」 |
| **🔥 ACTIVE** | 最近一轮 Code 产出 / Test·Review 报告 / 当前错误 / 当前修改 | 保留最近 1 个完整轮（轮次保护） |
| **🗄️ HISTORY** | 已完成阶段过程细节 / 冗长日志 / 重复工具输出 / 被取代的中间推理 | 可被 Runtime 压缩；**无需保留** |

**分区不变量**：

1. **状态不进 Memory**——HISTORY 区（会话过程细节 / 工具输出 / 中间推理）**不得**写入 delx-memory（受下「Memory ≠ Context」硬约束）；压缩的可逆性由 Runtime 的摘要与上下文重建承担，**不靠 Memory 兜底**（Memory 不是第二套 Context Manager）
2. **经验才进 Memory**——HISTORY 中若含经 `learning/memory/promotion.md`「经验质量审计」判定具长期价值的经验（lesson/reflection/pattern），走 S11/S12 正常沉淀，与压缩动作**解耦**；TASK 区只承载「本轮待保存经验**摘要**」，**压缩路径上不调用 `memory_set`**（写入走 S11/S12 出口，授权为常驻授权——无需用户确认，见 `learning/memory/lifecycle.md`「记忆写入」）
3. **TASK 区先可见**——在压缩可能发生时，先确保 📌 TASK 区**全量字段**在**当轮输出中显式可见**（不依赖历史对话回溯）；强制检查点 = `engine/transition.md` S8 出口（**Level 2+ 全量字段 / Level 1 精简版**；其余阶段以 `[Phase: x] [Loop: N]` 标签为最低可见性下限）；摘要卡的 `retrieve:` 键仅指向**已在 Memory 中的条目**，不为压缩新建记忆

**摘要卡格式**（Agent 固化/陈述当前 Workflow 状态的输出模板；**不是 Skill 的压缩触发动作**）：

```text
🗜️ 上下文摘要卡
❄️ STATIC（Runtime 常驻）：kernel 规则 ｜ policy ｜ 当前阶段 rules
📌 TASK（必须存活 · 13 项全出）：目标(含冲突预检标注) ｜ Level ｜ Phase ｜ Loop N ｜ Step 编号(含未完成 + 当前 Step 完成判据/验证方式) ｜ 验收标准 ｜ 关键决策(Confidence/Evidence) ｜ 待决策清单 ｜ 上一阶段输出指针(S2 环境结论 / S5 复述 / S6 模块划分) ｜ 上轮失败原因 + Review 判定 ｜ SAFE MODE 依据计数 ｜ 待注入队列 ｜ 本轮待保存经验摘要
🔥 ACTIVE（保留最近 1 轮）：<最近 Code 产出 / Test·Review 报告>
🗄️ HISTORY（可压缩）：<日志 / 重复输出 / 被取代的中间推理>
🔑 已有记忆：retrieve: <memory key>（可选；仅指向已存在条目）
```

**压缩后继续执行**：Runtime 完成压缩后，Agent **不重放、不重建历史**，直接从摘要卡恢复 📌 TASK 区 + 🔥 ACTIVE 区继续执行（当前目标 / Level / Phase / Loop / 已完成 / 未完成 / 下一步）；若摘要卡不足以恢复 TASK 区，按「防跳过规则」回退到**能重建该引用对象的最早阶段**，并遵守三条底线：**① 已完成/已确认的成果不重做**（含已确认的 S5 需求复述、S6 模块划分与 Step 完成标记 —— 仅**重建缺失的引用对象**；**「重建」= 补写该引用对象本身，不重走该阶段的确认/评审流程**）**② 不因恢复动作改动已确认的 Loop 计数** **③ 压缩场景下「防跳过规则」的「回退重新执行」收窄为「重建引用对象」**，不整段重做该阶段产出（防级联重做与震荡）。

**与「骨架化治理」的关系**：前者管磁盘常驻（STATIC 区供给源），后者管窗口层延续性；两者不同轴、不可互替（见 `references/governance.md`）。

**与 Memory 的边界（硬约束）**：Memory ≠ Context 双向隔离——Context 不进 Memory，Memory 不进 Context；完整定义见 `learning/memory/retrieval.md`「Memory ≠ Context 边界（硬约束）」。

### 信息获取规范（Agent 行为，非压缩）

**Skill 不设任何压缩阈值**（无消息数 / 工具调用数 / Read 次数 / Loop 次数一类阈值，无「Meter → Threshold → Decision」判定链）；**何时压缩由 Runtime 自主决定**（边界见上「执行者边界」）。Agent 侧只保留 Context Hygiene——细则与 Agent Prompt「信息获取规范」同源，**此处不重复**；Skill 侧只保留一条红线：**大型结果取用量上限见 `learning/memory/retrieval.md`「检索量红线」**。`🗜️ 上下文摘要卡` 性质 = **Agent 固化 📌 TASK 区的手段**，不是压缩触发条件；STATIC / TASK / ACTIVE 三区不压缩（定义见上表）。

**压缩发生后**：Runtime 完成 Compaction 后，若 Agent 可观察摘要生效，可在输出末尾提示 `🗜️ 已压缩 <N> 轮阶段对话为摘要`，并按上「压缩后继续执行」恢复当前 Workflow。

**溢出恢复**：context overflow 属 Runtime 职责（宿主移除导致溢出的响应、按策略重试）；Agent **不自行重试**，直接暂停输出恢复建议（新会话 / 更大上下文模型 / 由用户处理）。

**诚实约束**：禁止声称已调用不存在的压缩工具，禁止伪造压缩结果。

## Workflow Checkpoint（delx-memory）

> **性质**：**Checkpoint ≠ Memory ≠ Context Manager**。它是 📌 TASK 区（字段定义见上「压缩后状态延续契约」表）的**持久化形式**，唯一用途是**跨会话恢复**。**不保存长期经验**（经验归 delx-memory 的 L1–L7，走 S11/S12），**不承担压缩**（压缩归 Runtime），**不参与规则仲裁**。
> **存储**：delx-memory 记忆条目，**项目目录不创建任何状态文件**（不建 `.vibe-kernel/`、不写 Checkpoint 条目）。
> **唯一 ID**：key = `vc:checkpoint:<项目绝对地址 realpath>` —— 项目在系统中的地址即身份，天然区分同名目录、子目录与 worktree。
> **runtime-state 独立 tag**：条目固定 `tags = vc-checkpoint / runtime-state / scope:project`，`metadata.layer = null`、`metadata.memory_category = state`。Checkpoint 是**运行实例态**，不属于 L0–L7 知识层（L0 只保留给原始证据，见 `docs/memory-layers.md`）；独立 tag 的作用是让 Preflight 召回规则/经验时**排除** Checkpoint，只有恢复协议按 key 精确读取。
> **位置解析**：① `--memory-key` / `VIBE_KERNEL_CHECKPOINT_KEY`（测试/运维覆盖，须以 `vc:checkpoint:` 开头）→ ② 缺省 `vc:checkpoint:<realpath(project_root)>`。记忆库：`--memory-db` / `DELX_MEMORY_DB` → 缺省 `~/.delx-memory/db.sqlite`（与 `memory_tool.py` 同库同表）。
> **project_root** = 显式 `--cwd`，或从 cwd 向上首个含项目标记（`.git` / `pyproject.toml` / `package.json` / `go.mod`）的目录；旧 `.vibe-kernel/` 仅作 legacy 标记与一次性导入来源。路径一律 `realpath` 归一——软链指向同一目录即**同一项目**（期望行为），不同目录各自隔离。
> **创建**：首次写入即 upsert；值骨架见 `<skill>/.state.template.md`（模板本身不改写）。

**字段（13 项，防漂移）**：`status` `phase` `loop` `level` `goal` `current_step` `completed` `pending` `decisions` `review` `user_decisions` `resume` `updated_at`。其中 **`updated_at`** 为 freshness 字段（最后写入时刻，**须到分钟**）——恢复协议第 1 条据它识别「同日陈旧」；不承载状态语义（必需字段集的机械判定见 smoke-check 6b）。其中 **`status` 为新增**；TASK 区 ⑨「上一阶段输出指针（S2 环境结论 / S5 需求复述 / S6 模块划分）」由 **`resume`** 承载，⑩「上轮失败原因 + Review 判定 A·B·C」由 **`review.last_review（最近一轮审查结论）/ review.last_failure（最近一次未通过的原因）`** 承载，其余项直接对应——故本机制不引入第二套状态语义。模板与字段注释见 `.state.template.md`（此处不复述）。

**保留键（机器端；不计入 13 项，Agent 可忽略）**：

| 键 | 含义 | 缺失时 |
|---|---|---|
| `_schema` | 协议版本（整数） | 按 `1` 处理 |
| `_rev` | 单调版本号，供并发写校验（乐观锁） | 按 `0` 处理 |
| `_project_id` | 项目身份 = `sha256(realpath(project_root))` 前 16 位 | 不做归属校验 |
| `_resume_from` | 仅 S14 期间写入：进入 Safe Mode 前的 `phase`，用户「继续」时据此恢复 | 缺失 → 只能经「停止/接受」走 S13，不能 RESUME |
| `review.failure_state`（子键） | 连续失败计数与指纹（`last_fingerprint` / `consecutive_count` / `last_ok_at` / `round_started_at` / `history`），供 `NO_PROGRESS` 机械判定 | 按空初始化 |

**兼容规则（三条硬约束）**：① **未知键必须原样保留**——写入方不得丢弃不认识的键（防「Skill 先加字段、工具后升级」互相破坏）；② `_schema` 高于读取方支持版本 → 降级为「仅参考」，**只读不写**；③ 保留键缺失不构成损坏，按上表缺省处理。

**语法（机器读取口径）**：条目 `value` 是顶部单个 `---` 开始的 **YAML 子集**——块映射、块序列（`- item`，空写 `[]`）、单/双引号标量、块字面量 `|`（`resume` 用）、行注释 `#`。**不支持**锚点/别名、流式集合、多文档、标签。写端须给字符串标量**一律加引号**（防列表项以 `**`/`*` 开头被当别名）。解析失败 → 先降级为「仅扁平标量」（`status`/`phase`/`loop`/`level`/`updated_at`）→ 仍失败判 `corrupt`（复制到 `vc:checkpoint-quarantine:<project_id>:corrupt:<ts>` 后清空主条目，不静默丢弃）。

**写入纪律（避免"写了但没写状态"）**：**仅当字段发生变化时写入**——`phase` / `loop` / `current_step` / `completed` / `pending` 任一项变化 → 在**该阶段出口**写入（追加式）。无变化的阶段不写（省去"未变化也记一行"的仪式，避免恒定写放大）。

**写入通道（统一走 delx-memory）**：

| 通道 | 用法 | 适用 |
|---|---|---|
| 机器端（首选） | `python3 -m runtime.core <cmd> --cwd <project_root>`（`get-state` / `load-checkpoint` / `transition` / `state check`），在仓库根目录执行 | 有 `_rev` 乐观锁 + 字段校验 + 事务；阶段出口写状态。**勿用 `python3 runtime/core/cli.py`**（相对导入失败，ImportError） |
| Agent 端 | `delx-memory_memory_get` / `delx-memory_memory_set`，key 同上 | 机器端不可用时的降级；**`memory_set` 必须整条回传 value + tags + metadata + ttl**（三列整体替换，漏传即清空） |

- **并发**：写路径在 SQLite `BEGIN IMMEDIATE` 事务内完成读-改-写；`expected_rev` 不匹配 → `STATE_REV_CONFLICT`，**不覆盖**。
- **损坏**：先复制为 quarantine 条目（可回滚）→ 清空主条目 → 全新开始；主条目内容不静默丢弃。
- **TTL**：30 天，每次写入重锚（跨月恢复足够；过期条目按不存在处理）。
- **旧版文件**：`<project_root>/.vibe-kernel/Checkpoint 条目` 仅在 `import_legacy` 时**只读导入一次**；原文件保留为审计（不改名、不删除）。

**例外（必写）**：轮次收尾（S13）无论是否有变化都必须写一次 `status` + `resume`（含 pending 未落地项，防幽灵待办）。

**读写时机**：

| 时机 | 动作 |
|---|---|
| 循环开始（S1） | 读 Checkpoint 条目；不存在 → 按 `.state.template.md` 骨架初始化 |
| 每个阶段出口 | 更新 `phase` / `loop` / `current_step` / `completed` / `pending`（**追加式**，不重写已确认项） |
| 关键决策点（S3 仲裁 / S10 判定 / SAFE MODE） | 追加 `decisions` / `review` / `status` |
| 循环结束（S13） | `status: complete` + 输出最终摘要（条目保留，留待下一循环归档覆盖） |

**恢复协议（新会话）**：

1. 读 Checkpoint 条目 → **freshness 校验**：`status ∈ {active, paused}` 且 `updated_at` 与当前会话同量级（**须写到分钟**——仅到日会漏掉"同日陈旧"）；不满足 → 判为过期，退回 S1 全新开始（旧条目保留为审计，不删除）
2. **字段完整性校验**：**YAML 可解析 + 13 项齐全（含 `updated_at`）** → 可恢复；任一不满足 → 降级为「仅参考」，以用户输入 + 当前会话 TASK 区为准（**注意**：列表项以 `**`/`*` 开头会被 YAML 解析为别名而报错——写 markdown 强调时须加引号）
3. **不覆盖 TASK / ACTIVE**：Checkpoint 仅在本次会话 TASK 区为空时供给；与本次用户输入冲突时 **以用户输入为准**
4. **续跑**：`phase` + `current_step` 决定入口阶段；`completed` 项**不重做**；`status: paused`（含 SAFE MODE 触发态）→ 先输出恢复确认再继续
5. **pending 逐项核验（防幽灵待办）**：对每个 `pending` 项用**最低成本命令**收集证据（文件是否存在 / 版本号 / `git status` / 声明的验证命令），结果分**三态**：**verified**（有强证据：内容哈希一致 / 本轮起点之后有新提交 / 声明的验证命令已跑通）→ 移入 `completed`；**unverified**（仅"文件存在"或"mtime 较新"这类**弱证据**）→ **不得**移入 `completed`，附证据交 Agent 判断；**still_pending**（无证据或无可解析线索）→ 保留并标注待人工确认。**未核验不得直接执行 `pending[0]`**。口径：**文件存在 ≠ 任务完成**——文件可能早已存在，或被无关操作更新了时间戳。

**与压缩的衔接**：Runtime Compaction 后 TASK 区不可重建时，**优先读 Checkpoint 条目**（本机制即「防跳过规则」契约外兜底的可执行解）；仍不可用 → 按 `kernel.md` §1「引用对象不可重建」暂停。

## 防跳过规则

每个阶段的输出中，必须显式引用上一阶段的输出：

- S2 Preflight → S1 Intent 目标三元组
- S3 Decision → S1 Intent 冲突预检命中项（存活字段 = ① 冲突预检标注）
- S5 Clarify → S2 Preflight 环境检查结果 + S1 Intent 目标三元组
- S6 Design → S5 Clarify 需求复述
- S7 Plan → S6 Design 模块划分
- S8 Code → S7 Plan Step 编号
- S9 Test → S8 Code 函数/类名
- S10 Review → S8 Code 实际代码
- S11 Reflection → S10 Review 判定结果
- S12 Memory Evolution → S11 Reflection 产出或 S10 Review 情况 C

若无法引用，回退到上一阶段重新执行（Loop 0），不消耗计数器：

> ⚠️ **压缩场景收窄条款**：若「无法引用」的原因是 Runtime Compaction 导致该对象不在 TASK 区，则**不整段重做该阶段**——按「压缩后继续执行」三条底线执行（仅**重建缺失的引用对象**；已确认的 S5/S6 输出与 Step 完成标记不重做）。本收窄仅适用于压缩场景，其余场景仍按本节重做。
> **契约外兜底**：若引用对象已不在上下文且**无法重建**（Runtime 未按 TASK/ACTIVE 契约保留）→ **暂停**，输出现存已确认进度并请求用户确认，**不猜测、不重做**。

```text
[Phase: <回退到的阶段>]
[Loop: 0]
回退原因：无法引用 <上一阶段> 的输出（<具体缺失内容>），重新执行本阶段。
```

**回退计数规则**：防跳过回退属同一轮内修正，不消耗计数器。回退到的阶段标 Loop 0；回退后重新前进到达 Code 时，Code 仍标原 N（不 +1）。
