---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Review 阶段细则（骨架版）

[Phase: Review]
[Loop: N]

> **骨架化说明**：本文件为 Review 阶段**流程骨架**。检查清单/维度定义/模板要点已下沉为 `skill:` 规则条目（见文内各节引用），加载时按需 `memory_get`。**内容主源按 `references/governance.md`「Canonical Source」分类判定**（类型 A 以文件为源，如硬约束清单在 `policy/safety.md` §3；类型 C 以记忆条目为源）；条目不可用 → 按 `SKILL.md` 的 fail-closed 规则输出 `[RULE_STORE_MISSING]` 并停止；本文件摘要只用于定位，不得作为规则推断依据。

## 审查角色

主 agent 在 Review 阶段切换到 **Critic** 角色，与 Code 阶段的 Builder 角色隔离。Critic 不原谅 Builder 的代码，必须以独立视角审查。

- 你是资深全栈工程师，专精生产级工程标准
- 你**不写这段代码**，你是来挑刺的
- 每条问题包含三要素：**问题描述、根本原因、改进版本**
- **不手软原则**：Builder 是"自己人"，Critic 是"外来审查者"
- **降级条款**：若 subagent 通道不可用导致 Test 降级自测，Critic 必须以"假设我是另一个工程师"的视角审查，标注 `（降级自测：subagent 派发被拦截/失败，主 agent 自测，存在作者偏见风险）`（唯一措辞见 `rules/test.md`）

## 前置门控

Test 在前 Review 在后。**Test 失败不进 Review**，直接回退 Code[N+1]；仅全通过时继续下方检查。（报告格式见 `skill:rules/test:task-spec`）

**跨层结构/行为变更 → 独立审查（硬项）**：变更**新增或改变规则语义、字段、阶段集、接口**时（不论落在哪个文件；典型面：`rules/` `engine/` `policy/` `load_plan.json` `scripts/` `backup/*.py` `manifest.yaml`），或涉及跨技能时，S10 必须派 **fresh-context subagent** 做独立审查（Builder ≠ Critic）——**不得以自测全绿替代**：自测与 Builder 共享同一套假设，盲区同源。**豁免**：纯错别字 / 措辞 / 格式 / 注释修正，且不改变任何语义、字段、阶段集或接口。派发失败 → 主 agent 换视角审查并按 `rules/test.md` 的**唯一降级措辞**标注（勿在本文件复制该串，防三处漂移）。

## 第一步：约束检查（Hard 逐项 / Signal 评估）

分级与定义见 `policy/safety.md` §3（**Hard 6 项 + Signal 3 项 + #10 条件项**）；逐项打勾模板见 `skill:rules/review:hard-constraints`（摘要优先，需要清单时才 `memory_get`）。**Hard 命中 → 情况 B 短路；Signal 只计入维度层问题数。**

## 第二步：维度审查（硬性约束全部通过后执行）

8 项维度（可读性/结构与分层/注释/可维护性/坏味道优先级/记忆一致性/用户资产保护/资产生命周期合规）完整定义见 `skill:rules/review:eight-dimensions`（level:domain, permanent——加载全文执行）。

**关键判定要点**（条目未取时按此执行）：
- 注释维度：**归档旧代码必须 `@Iteration` 标注，禁止无标记注释代码块**
- 坏味道优先级：空错误处理 → 硬编码 → 深层嵌套 → 长函数 → 长文件 → 长参数 → 隐式副作用
- 记忆一致性：旧记忆正确 → 改代码对齐；旧记忆过时 → 更新记忆；判定标 Confidence
- 资产生命周期：禁止跨阶段跳级（Active→Archived 视为违反）
- **结论类判定**：零引用 / 死代码 / 未使用导出 —— 口径分档见 `skill:references/dead-code-audit`（扫描范围须含 examples 与文档站；三档结论分开给）
- **子 agent 产出**：整合阶段的结论级复核是 Review 前提（见 `rules/orchestration.md`「整合阶段」第 3 项 + `skill:rules/orchestration:subagent-reverify`）；Review 只审已复核过的产出

> Investigation 分支（只读任务）不适用硬约束，改用 `engine/router.md` Investigation 分支的文档维度审查。

## 第三步：判定路径

> **两把尺子（勿混计，防阈值不可达）**：硬约束层是**二值门**（命中 → 直接 B 并短路，不跑维度审查）；`issue_count` **只计维度层问题数**。完整口径唯一事实源 = `engine/transition.md` S10「判定路径」。

判定表、结构性定义、存量问题口径、计数规则见 `skill:rules/review:verdict-path`（level:domain, permanent——加载全文执行；检索失败按 `engine/transition.md` S10 判定路径表执行）。

## 情况 A / B / C 模板

模板要点（测试报告摘要 + 硬性约束打勾 + 🔎 问题清单 + ✨ 修复/重构方案 + 🧠 改进说明 + 下一步）见 `skill:rules/review:case-templates`（level:domain, permanent——加载全文执行）。

**关键流向**：
- 情况 A → 同一回复输出 `[Phase: Code] [Loop: N+1]` 修复代码
- 情况 B → 同一回复输出 `[Phase: Design] [Loop: 0]`（回退不重置计数器；Review[3] 回退 → N+1=4 超上限直接停止）
- 情况 C → Reflection 触发判定 → Memory Evolution

## 情况 C 后置：Reflection 触发判定

通过审查后，**先执行 Reflection 触发判定**，再进入 Memory Evolution：

```text
[Phase: Reflection]
[Loop: N]

### 触发判定
按 engine/transition.md「S11 Reflection → S12 Memory Evolution」的触发条件检查（强制 3 条 + 可选信号）：
- [ ] 命中条件：<#N>
- [ ] 触发理由：<具体描述>
→ 任一命中 → 输出 Reflection Card（格式见 learning/reflection.md）→ 进入 Memory Evolution
→ 全部未命中 → 跳过 Reflection → 直接进入 Memory Evolution
```

### Memory Evolution

按 `learning/memory/promotion.md`「S12 收尾（2 步）」执行（步骤名、命令与输出格式见该清单，此处不重述），输出：

```text
[Phase: Memory Evolution]
[Loop: N]
🔄 已演化记忆：<key列表>（或"本轮无记忆需更新"）
📌 访问计数回写（S12）：<keys>（已消费即回写过的 key 注明「消费即回写」）
🪞 Reflection 已沉淀：reflection:<key>（若触发）
🧠 已沉淀：<keys>（无则「本轮无沉淀」）
```

### 扩展建议（循环通过后，Level 2+ 且确有价值时）

首次完整通过审查后，若有真实可执行的方向，提供 3–5 个后续改进项：功能扩展 / 更好结构 / 日志错误处理配置化 / 性能优化 / 测试覆盖补强。**无真实可落地项 → 省略本节**（不凑数）。

