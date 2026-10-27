---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Learning: Memory/Retrieval — 检索与召回协议

> **本文件是记忆体系检索侧的协议载体**：查询路由（Task→Memory Router 表）、工具能力/分工、CodeGraph 触发与新鲜度、检索量红线。概念层见 `architecture.md`，写入侧见 `lifecycle.md`，质量/提升侧见 `promotion.md`。导航入口 = `../memory.md`（索引）。

## 工具实际能力

> 已下沉：`skill:learning/memory:query-router`（level:domain, permanent, reference——加载全文执行）。包含工具能力表/限制、取值约定、codegraph 工具适配、实际渐进加载路径。
>
> **本机兜底**：`python3 scripts/memory/memops.py search "<关键词>" --limit 5`（FTS5，默认排除分片）。`memory_search` 未暴露或不可用时优先用它，再退回 `memory_list(prefix=...) + memory_get`。

## 上下文感知路由表

> 已下沉：`skill:learning/memory:query-router`（路由表全量 + 主动关联召回协议 Step 0-4 + 分级执行 + 注入格式，lightweight-queries 已并入本条目）。加载全文执行；条目不可用时以本文件（canonical）为准，不存在摘要降级。路由要点：代码事实 → CodeGraph；版本/模块/经验/偏好 → memory；pattern / skill: 规则条目用 `memory_list(prefix)`（FTS5 不匹配前缀 key）。

## 任务类型 → 规则/经验路由表（Task→Memory Router）

> **Canonical**：**本文件为事实源**（协议核心特例——防自指 + S2 强制动作兜底，见 `references/governance.md`「协议核心特例」）。`skill:learning/memory:query-router` 条目为**可执行副本**（delx-memory 可用时加载全文执行；条目检索失败按本文件降级）。两处内容更新须同步。任务类型与 `profiles/` 任务入口层共享同一分类（判定特征对齐）。

> **设计动机**：规则/经验「存而不用」（触发条件无强制点，曾导致项目规则长期 access_count=0）。本表为 **Preflight 强制步骤**：S1 Intent 判定任务类型后，执行**最小充分召回**（硬性执行首项，非建议）。历史事故细节见 `rule:skill-iteration-manifest`（唯一事实源）。

| 任务类型 | 判定特征 | 强制召回清单 | 检索动作 |
|---------|---------|-------------|---------|
| 技能/文档维护 | 修改 vibe-coder-loop skill 文件、Vibe Coder Kernel、本仓库文档 | `rule:skill-iteration-manifest` + `lesson:skill-edit-date-residue` | `memory_get` 精确 key（已知） |
| 记忆/回写/指标 | 任务涉及 access_count、仪表盘、Metrics、记忆协议 | `pattern:memory-writeback-integrity` + `reference:memory-access-tracking` + `lesson:memory-metadata-overwrite` | `memory_get` 精确 key |
| 编码/调试 | 功能开发、bug 修复（vue/antd/通用） | **`memory_list(prefix="rule:")` 项目/任务级规则（样式变量 / 注释 / i18n / 弹窗等约定，命中域才 get）** + `memory_search "lesson:{技术栈}"` + `memory_search "reflection:{领域}"` + 项目网络入口 | `memory_list` + `memory_search`（≤2 次，取前 5） |
| 架构/重构 | 模块拆分、接口变更 | `codegraph_impact` + 项目网络 p_high + `memory_list(prefix="pattern:")` | codegraph + memory 组合 |
| 跨项目任务 | 涉及 ≥2 项目共享文件 | `memory_list(tag="stale")` + `memory_list(prefix="principle:")` + 跨项目关联 | 先 stale 验证再加载 |
| 调研/审查 | E 类只读任务 | 项目网络 + 相关 lesson/reflection | `memory_search` 关键词 |

**执行规则（最小充分召回 / Progressive Retrieval）**：

1. **S1 Intent 后判定任务类型**；S2 Preflight 执行对应**最小召回清单**——已知 key 用 `memory_get` 精确取值（不经 search，避免 snippet 截断且保证必中）；经验域按表用 `memory_search`（关键词，≤2 次、取前 5）。`memory_get` 不计入检索次数。
1a. **`memory_search` 不可用时**（部分 MCP 装配只暴露 `list/get/set/forget`）：先跑 `python3 scripts/memory/memops.py search "<关键词>" --limit 5`（FTS5，默认排除分片），仍不可用再改 `memory_list(prefix=...) + memory_get`，并在输出标注 `[memory_search 不可用 · FTS/prefix 回退]`；**不得因工具缺失跳过清单**。
2. **一次只取最相关的那一类**；类型模糊时**选最可能的一类**起步 —— **不取并集**（旧的「并集召回」策略已废弃）
3. 执行中发现信息不足 → **按需二次检索**（先说明缺口，再 `memory_search` 关键词）；仍不足 → 第三次
4. **排序原则**：Relevance > Specificity > Freshness > Frequency；边缘相关的一律不注入
5. **canonical 过滤**：默认排除 `fragment` tag 与 `#` key；只有需要细节时才按分片 key 精确取值。`memops.py search` 已默认排除。
6. **分层过滤**：需要按层取用时用 `memory_list(tag="layer:L3")`；不要拉全量后在上下文里筛。
7. Level 0/1 只做「任务类型判定 + 清单首项」；Level 2+ 用清单全项
8. 复杂度高 / 跨模块任务**允许 Agent 自行扩大召回** —— 本规则不设硬上限，仅要求「扩大召回须能说出理由」

> 目标：减少 Context Pollution。**减少召回不是新的硬阈值规则** —— 召回量由任务复杂度与缺口决定。

## CodeGraph 专用触发条件

满足任一即调用：

- 询问函数/类/接口的定义、调用者、被调用者
- 询问改动某段代码的影响范围（自动调用 `codegraph_impact`）
- 要求解释某个模块的工作原理
- 用户提及具体符号名（如 `createOrder`）
- Code 阶段需要修改现有代码时（须先调用 `codegraph_search` 找到定义，再调用 `codegraph_callers` 评估影响）

### CodeGraph 新鲜度检查（codegraph_context 调用前执行）

1. `codegraph_status` → 获取索引文件数 + 节点/边统计
2. 若索引文件数 < 项目实际文件数 80% → 标注 `[CodeGraph 索引不完整]`
3. 若索引时间 > 7 天 或 本轮有 >5 文件 commit → 标注 `[CodeGraph 索引可能过期]`
4. 降级策略：不阻塞循环，标注后降级为 memory_search + Read 替代
5. 建议用户运行 `codegraph init` 重建索引（在输出末尾提示）

## delx-memory vs CodeGraph 分工

> 已下沉：`skill:learning/memory:query-router`（分工表 + 冲突优先级）。加载全文执行。

**冲突优先级**：CodeGraph（代码事实） > delx-memory（用户/历史陈述） > 模型知识。

**失败分级**：规则库（`skill:rules/*`）不可用 → fail-closed 停止；经验/模式/偏好召回失败或超时（≤3s）→ 标注 `⚠️ 记忆召回降级` 后继续，不阻塞循环、不重路由到远端服务。

## 检索量红线（Agent 行为配额）

**这是 Agent 行为约束，不是 token 预算**——token 预算与压缩阈值由 Runtime 承担（边界见 `engine/state-machine.md`「上下文压缩（Runtime 负责）」）。**两条独立口径，勿混用**：

| 口径 | 约束 | 含义 |
|---|---|---|
| **单次调用返回量** | `memory_search` / `codegraph` / `Read` 取用须可论证必要性；大文件分段读，不一次拉全 | 一次工具调用取用的**结果规模** |
| **每轮调用次数** | 召回量与任务复杂度成正比；禁止全量扫描式检索 | 一轮任务（S0→S13）内的**查询次数** |

> **缺省参考值**（项目无独立配置时）：`memory_search` 单次 ≤5 条 / 每轮 ≤5 次；`codegraph` ≤200 行；`Read` 单文件 ≤300 行。此为缺省而非硬契约——大 monorepo 或长任务可上调，前提是每次取用必要性可论证。

- `memory_get`（已知 key 精确取值）**不计入**上述任一口径——它是确定性读取，非检索；强制召回清单因此不受次数红线约束
- 单次调用返回量超限 → 需要更大范围时拆分为多次针对性查询，或改用 codegraph 定位后精读
- 次数红线与强制召回清单冲突时：**清单优先**；清单外检索相应压缩（不静默丢弃，标注 `⚠️ 检索超限`）

## Memory ≠ Context 边界（硬约束）

- **Context 不进 Memory**：会话上下文（过程细节 / 工具输出 / 中间推理）**不得**写入 delx-memory，除非经 `promotion.md`「经验质量审计」判定具长期价值
- **Memory 不进 Context**：delx-memory 条目**不得**无条件注入上下文；仅按本文件路由表**按需检索命中**时进入（常驻 STATIC / TASK 区的 = 宪法层 + 强制召回清单，其余按需）
- 违反后果：Memory 污染（过程录像沉入长期库）+ 上下文膨胀（全量记忆常驻）

## 性能优化

- 单次对话内，CodeGraph 和记忆查询结果在内存中缓存复用，不重复调用工具
- `codegraph_explore` 仅在需全面扫描模块结构时调用（如初次探索项目）
- 检索时优先使用关键词精准匹配，避免全量扫描
