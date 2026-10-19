---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Learning: Memory/Lifecycle — 写入与生命周期协议

> **本文件是记忆体系写入侧与出口闭环的唯一事实源**：记忆保存（三路径）、用户偏好沉淀、TTL 策略、记忆访问计数与元数据协议、跨项目失效传播、Test→Lesson 闭环、Quick Loop 记忆闭环。检索/路由见 `retrieval.md`，提升/去重/S12 收尾见 `promotion.md`，概念层见 `architecture.md`，仪表盘见 `../skill-metrics.md`。导航入口 = `../memory.md`（索引）。

## 用户偏好记忆系统

### 记忆结构

```text
key: preference:user:<category>

示例:
key: preference:user:code-style
value: {
  style: "functional",
  language: "typescript",
  avoid: ["over abstraction", "class"],
  confirm_count: 3,
  last_confirmed: "<确认日期>"
}
```

### 优先级

- **P0.5 User Preference**：高于普通优化规则（R3），低于安全规则（R0/R1）
- 示例：用户偏好函数式风格 → 在无安全冲突时优先采用函数式实现

### 沉淀条件

- 用户**明确表达**偏好（"我喜欢函数式" / "别用类"）
- 同一偏好出现 **≥3 次**（跨对话或同对话多次）
- 与现有代码风格**不冲突**或用户明确要求改变

### 沉淀流程

1. Agent 识别到潜在偏好（条件见上「沉淀条件」）→ **直接写入**（无逐次确认）：
   - key=`preference:user:code-style`
   - tags=[preference, user, p_high]
   - value 含 `confirm_count`（累计命中次数）+ `last_confirmed`（最近命中时间）
2. 回复末尾输出一行回执（可观测，**不是确认请求**）：`💡 已记录偏好：<描述>（preference:user:<category>）`
3. 后续对话中，Preflight 阶段检索 `preference:user:*` 注入上下文

### 禁止沉淀的情况

- 用户仅表达一次，未确认
- 偏好与安全规则冲突（如"别写测试"）
- 偏好过于具体（如"这个函数要用 for 循环"——属单次指令，非长期偏好）

## 记忆写入（自主执行，无逐次确认）

**授权**：记忆的增 / 删 / 改 / 查由 Agent **自主执行**——用户常驻授权，授权模型唯一事实源 = `delx-memory-protocol` 协议 §记忆操作授权模型。工具硬约束 `explicit_user_intent=true` 由该常驻授权满足；**「建议块等用户回复保存」与「S12 批量确认清单」两类门控已废除**。

**写入时机（即时写入）**：

| 触发 | 动作 |
|---|---|
| 用户明确说"记住这个 / 保存到记忆" | 立即 `memory_set` |
| Agent 识别到值得保存的内容（条件见下） | **本轮内直接写入**，出口输出回执 |
| Test 失败 / Reflection 触发 / 项目约束变更 | 即写（见「Test→Lesson 学习闭环」、`../reflection.md`） |

**写入质量闸门（取代原用户确认，防污染）**：每条候选过 `promotion.md`「经验质量审计」（九类垃圾特征 + 三问）+ 去重 / Merge 四动作判定——**闸门是质量判定，不是用户确认**。

**识别条件**（值得写入）：

- 检测到依赖文件（package.json / Cargo.toml / requirements.txt 等）新增或变更 → 保存 `project:deps_<lang>`
- 完成涉及非常规逻辑的代码修改（超过 5 行算法 / workaround）且用户未取消 → 保存 `qa:<digest>`
- 发现 import/export 指向仓库外的本地目录 → 保存 `external_ref:<path>` 及 `linked_namespaces`
- 首次进入项目时，自动探测并保存基础信息（语言 / 框架 / 启动命令）
- Test 失败 → 保存 `lesson:{主题}`（见 `rules/test.md` 串行门控 + 本文件「Test→Lesson 学习闭环」）
- Reflection 触发 → 保存 `reflection:{摘要}`（见 `learning/reflection.md`）

**保存前强制 CodeGraph 校验**：对于涉及代码符号的记忆（如"函数 X 在文件 Y 中"），调用 `codegraph_search` 确认当前事实后再写入，避免保存过时信息。

**出口回执**（统一格式，可观测性要求而非确认请求）：S12 → `🧠 已沉淀：<key 列表>`；Quick Loop 出口 → 同上；无写入 → `本轮无沉淀`。

## 记忆生命周期管理

### TTL 策略

| 记忆类型 | TTL | 续期规则 |
|---|---|---|
| 版本状态（modules-v\*） | 180 天 | 每次命中 memory_set 续期 |
| 模块详情（module-\*） | 365 天 | 每次 Memory Sync 更新续期 |
| 编码规范（conventions） | 无限 | 不自动过期 |
| Lesson 经验（lesson:\*） | 90 天 | 不续期，到期自然淘汰（除非提升为 pattern） |
| QA 修复（qa:fix_\*） | 30 天 | 不续期 |
| Reflection 经验（reflection:\*） | 180 天 | 每次命中续期 |
| 跨项目经验（experience:\*） | 180 天 | 不续期 |
| 全局规则（global:\*） | 无限 | 不自动过期 |
| 用户偏好（preference:user:\*） | 无限 | 不自动过期 |
| 归档记录（archive:\*） | 90 天 | TTL 兜底用 |
| **模式（pattern:\*）** | **365 天** | 每次命中或新增实例时续期 |
| **原则（principle:\*）** | **无限** | 不自动过期 |
| **周期 Metrics（skill-metrics:\*）** | **180 天** | 每次落库续期 |

**TTL 到期前 30 天**：降级 tag 为 p_medium（降低加载优先级）→ 到期后自然删除或转为 `lesson:historical-*`。

### 记忆访问计数与元数据协议

> **Canonical**：本协议事实源 = 本文件。`pattern:memory-writeback-integrity` / `reference:memory-access-tracking` / `lesson:access-writeback-trigger-gap` 为经验锚，不构成第二规则源。

**字段语义**（存于 metadata 列，**禁止内嵌 value**）：`access_count` = 被读取并**消费**的次数（每轮消费 +1，同轮多次只 +1）；`cache_hit_count` = 消费后经 **E2+** 验证与事实一致的次数（≤ access_count）；`title` = 展示标题（≤100 字，新增/修改必须维护）；`relevance_score` = TTL 到期前 30 天懒计算（见 `advanced.md`「Relevance 评分（实例约束）」）。

#### 回写契约（三条，其余为 Tool 内部实现）

1. **消费即回写 = 主路径**——`memory_get` 即视为消费（**不做"先读后定"延迟判定**，宁可略高估不遗漏）；主 agent **同一 turn 内**执行 `memory_tool.py touch <key> [--hit]`（`--hit` = 内容经 E2+ 验证与事实一致），并维护会话级「已回写 key」集合（同轮同 key 只一次，跨轮重置）。数据完整性不变量由 Tool 保证（见 `backup/README.md`），**Agent 不手写任何字段**。任务在回写后中断 → 计数已落库不丢失（解决上下文压缩/会话中断导致清单内存态丢失的缺口）。「轮」= 一次主 agent 任务循环（S0→S13）
2. **出口兜底 = 仅对未回写残留**——回写义务**不依赖是否走到出口**：Quick Loop 在 S8 出口（Level 0）/ S10 出口（Level 1）；S12 [1]；**S13 Complete（含"停止循环"/"接受当前代码"直达）必须检查 S2 消费残留**。欠账队列只覆盖"回写执行失败"，**不覆盖"从未执行回写"**（后者由 S13 兜底——反复事故：读取了记忆但 access_count 全为 0，见 `lesson:memory-metadata-overwrite`）
3. **报告 + 降级**——每次回写**必须输出报告**（不可观测 = 未执行）：`📌 访问计数回写（<出口>）：<keys>`；失败 → `📌 计数回写欠账：<keys>` 随下轮补写。**Tool 不可用** → 手工 `memory_get` 取完整值 → 叠加 → `memory_set`（约束见下节）；**授权恒成立**（常驻授权，见上「记忆写入」）→ 直接执行，**无"待确认"分支**。

#### Agent 直接调用 `memory_set` 时的约束（用于：新增记忆 / 非计数类更新 / 合并；**计数路径不需要**）

1. 新增记忆：`memory_set(key, value, metadata={title, access_count:0, cache_hit_count:0, …}, tags, ttl_seconds)`
2. **`value` / `tags` / `metadata` 三列均为整体替换**（tags 未传即被清空；metadata 缺失字段即丢失）→ 更新前先 `memory_get` 取当前值，value 原样回传、tags 全量携带、metadata 至少含三件套
3. 有限 TTL 更新：`ttl_seconds = 原到期时间 − now`（防续期漂移）

**禁止**：`_meta` 写回 value｜未访问却 +1｜用 `memory_search` snippet 命中代替"消费"｜子 agent 直接写计数（由主 agent 汇总，防并发覆盖）｜新写记忆不带 `scope` 标注（global/project/task 三选一）｜**删除前未核验归属与可回滚证据**（删除义务见 `policy/lifecycle.md`「记忆条目删除义务」）

**协议文档记忆**：`reference:memory-access-tracking`（TTL 365 天）

### 跨项目失效传播

触发条件 = 修改了**跨项目共享文件**（如 jtkl console↔management 共享的 hooks.js）；4 步流程（检索引用 → 打 `stale` tag → 提示 → 下个项目 Preflight 验证）见 `advanced.md`（按需加载，本处不重述）。

## Test→Lesson 学习闭环

Test subagent 报告失败时，主 agent 在回退 Code[N+1] 前执行：

1. 分析失败根因（类型：边界遗漏/类型错误/异步遗漏/依赖缺失/逻辑错误/...）
2. 记入待保存缓冲区：`memory_set` key=`lesson:{主题}` value={失败模式 + 根因 + 修复方案 + 规避建议 + **成功关联**}
   - **成功关联（`success_correlation`，必填）**：`{failed: <错误路径/假设>, succeeded: <正确路径>}`——lesson 的价值在「**从失败到成功的 diff**」，不是失败清单本身
     - 反例（无价值）："Read 失败了 5 次"（只记录失败，不可行动）
     - 正例（可行动）：`failed: FirstClassEntity 在 axion-formats/` → `succeeded: 实际在 axion-scala-common/` → 结论「X 在 Y，不在 Z」
     - 若**未修复成功**（Loop 耗尽 / 用户接管）→ `succeeded: null` + 标 `unresolved`，**不编造成功路径**
   - tags=[lesson, vibe-coder, `<失败类型>`]
   - TTL=90 天
   - 写入时机：**回退 Code[N+1] 前即时写入**（无延迟确认）；写入前输出 `📝 已记录经验教训：lesson:{主题}`
3. 回退 Code[N+1]，Code 前置检查中 `memory_search "lesson:"` → 命中同类失败模式 → 生成时主动规避

**价值**：Agent 在跨对话中积累经验，同类错误不重复犯。

## Quick Loop 记忆闭环（Level 0/1 出口内联）

> **设计动机**：S12 收尾仅在 Level 2+ 执行，Quick Loop（大量日常任务）无该出口 → 三层体系长期空转。本协议为 Quick Loop 出口（S8/S10）内联的**轻量记忆闭环**（与计数回写同出口，一并执行）。

**闭环动作（Quick Loop 出口，随计数回写执行）**：

1. **消费清单回写**（已有协议，见上「回写契约」）
2. **去重 / Merge 归系统**：Dedup / Merge 由 Memory 系统承担（协议见 `promotion.md`），**Agent 不显式执行**；本轮若产生 lesson/reflection 候选，直接进入下步即时写入
3. **即时写入 + 回执**：识别到值得保存的内容（Test 失败 lesson / Reflection 触发 / 新 pattern 候选）→ 过质量闸门后**直接写入**，出口输出 `🧠 已沉淀：<keys>`；无 → `本轮无沉淀`
4. **仪表盘更新**（已有协议，每轮必更，见 `skill-metrics.md`「系统状态仪表盘」节）

**与 S12 的分工**：Quick Loop 闭环覆盖"即时写入 + 仪表盘"；周期治理（Consolidation / 提升 / 评分 / 淘汰）由 Memory 系统承担（协议见 `promotion.md`）。

> Quick Loop 触发新增 lesson/reflection 时按 `learning/reflection.md` 的 Reflection 判定（3 条强制 + 可选信号）**即时写入**；pattern 提升（同类 ≥3）由 Memory 系统按 `promotion.md` 自动执行。
