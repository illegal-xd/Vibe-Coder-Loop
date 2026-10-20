---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Skill Metrics — 指标追踪（骨架版）

> **骨架化说明**：指标定义/失败类型分类/Buffer 结构/存储格式/早期预警规则已下沉为 `skill:` 规则条目（level:domain, permanent——加载全文执行）；条目不可用 → 按 `SKILL.md` 的 fail-closed 规则输出 `[RULE_STORE_MISSING]` 并停止；本文件摘要只用于定位，不得作为规则推断依据。

本文件定义 vibe-coder-loop 的运行指标收集、存储、分析机制。Metrics 是 Memory Evolution 的数据依据，没有 Metrics 的演化是盲目的。

## 分工总览

| 记录 | 用途 | 更新时机 |
|---|---|---|
| 周期 Metrics（`skill-metrics:vibe-coder-loop:<周期>`） | 月度聚合：成功率/循环数/失败类型 | **Memory 系统 / 周期任务**聚合落库（Agent 不显式执行） |
| 系统仪表盘（`skill:vibe-coder-loop:metrics`） | **实时运行状态**：冲突/检索/观察期/回滚/骨架 | **已存在的常驻记忆，每轮任务收尾必更**：事件触发即记账（metrics_events）→ 出口聚合 upsert；**0 事件也须更新**（显式标注「本轮 0 事件」+ 刷新 updated_at） |

## 核心机制（摘要）

- **指标定义与统计口径**（total_tasks 仅计工程任务；元任务计 notes）见 `skill:learning/metrics:fields`
- **失败类型分类**（9 种：intent-misunderstanding/test-insufficient/architecture-conflict/state-race/dependency-missing/boundary-missing/over-engineering/memory-outdated/skill-gap）见同条目
- **增量 Metrics 内存清单（Buffer）**：S4/S8/S9/S10 记入内存，**由系统 / 周期任务聚合落库**（Agent 不显式落库）；Level 0/1 随 Quick Loop 出口丢弃不落库
- **Agent 侧动作**：收尾执行**一条命令** `memory_tool.py metrics <delta> --counts`（写仪表盘）；**周期聚合与落库由系统 / 周期任务承担**——Agent 不显式落库，也**不再有欠账机制**
- **存储**：`memory_set` key=`skill-metrics:vibe-coder-loop:<period>`，TTL 180 天续期
- **早期预警**（S10 后）：循环数 > avg*1.5 / 失败类型占比 ≥15% / 连续 2 轮同类型 / Low+Test 失败 → 见 `skill:learning/metrics:early-warning`（含首次任务默认 avg_loops=2.0）。**本阈值 = S10 运行时预警**（触发预警报告 + 早期 Reflection）；与 `learning/evolution.md` 的 Evolution 触发阈值是同一统计数据在**不同动作**上的两个出口，不可互相替代
- **仪表盘联动**：`skill:vibe-coder-loop:metrics` 字段与异常阈值（auto_rule.pass_rate<60% / retrieval.hit_rate<40% → 预警）见 `skill:learning/metrics:early-warning`

## 周期 Metrics 输出摘要格式（周期落库时按需）

模板已下沉 `learning/memory/advanced.md`「周期 Metrics 输出模板（实例特化）」——仅在周期落库 / 月度聚合时读取。

## 系统状态仪表盘（skill:vibe-coder-loop:metrics）

> 本节约自原 `learning/memory.md`（架构收敛合并，见 `CHANGELOG.md`）。仪表盘为**运行指标常驻记忆**（区别于上节周期 Metrics 落库），原分散于 memory.md 的内容与本节 metrics 文件合并，消除双源。

> 设计原则：所有新机制的运行状态必须可观测。

**存储**：`skill:vibe-coder-loop:metrics`（level:core, permanent；**Skill 专属键**，命名规范 `skill:<skill-name>:<slug>`），**已存在的常驻记忆**（非新写记忆），单条持续更新（upsert）。

**每轮必更（Tool 执行）**：仪表盘是**每轮任务收尾必须更新**的常驻记忆——**与是否消费 delx-memory 无关**，Quick Loop 出口 / S12 / S13 / 用户"停止循环"等任何结束路径均须执行一次：

```bash
python3 <skill>/backup/memory_tool.py metrics <本轮 delta> --counts --note "<本轮摘要>"
```

Tool 保证：读取当前值 → 叠加本轮 delta → **完整回传**（未触及字段 / tags / metadata 原样保留）→ `hit_rate`（= `budget_hits/searches`）/ `memory_hit_rate`（= `memory_hits/searches`）**分别重算** → 空清单自动标注「本轮 0 事件」。**Agent 不手写数值聚合，也不计算任何 rate / 条目计数**（`--counts` 机械重算 `memory.*`）——例外见下「工具覆盖边界」。

> **两个 rate 语义不同，禁止混用**（同一字段曾被手工写入两种含义，修复成本 = 一次口径污染）：`hit_rate` = 检索**在红线预算内完成**的比率（Agent 配额合规）；`memory_hit_rate` = 检索**确有召回结果**的比率（召回有效性）。降级路径同样**禁止手写任何 rate**——只回传原始计数，rate 由 Tool 重算。

**降级（Tool 不可用）**：跳过本轮仪表盘更新并标注 `📌 仪表盘未更新`（不静默丢弃）；不要求 Agent 手工叠加重算。

**工具覆盖边界**：`metrics` 覆盖全部**数值**字段聚合；**描述性字段**（`conflict.last` / `rollback.last`）与**派生判断**（`auto_rule.pass_rate`）无工具路径，仍由 Agent 在 `--note` 之外显式提供。

**字段与更新时机**：

| 字段 | 语义 | 更新时机 |
|---|---|---|
| `conflict.total / by_user / by_level / last` | 冲突仲裁次数（按裁决方分类） | S3 Decision 仲裁 / Conflict Card 输出时 |
| `retrieval.searches / budget_hits / hit_rate / memory_hits / memory_hit_rate / over_budget` | 检索「预算内完成率」（`budget_hits/searches`）与「记忆命中率」（`memory_hits/searches`）——两条独立口径；红线见 `memory/retrieval.md`「检索量红线」，字段名保持 `budget_hits` 兼容 Tool | S2 Preflight 检索后 |
| `auto_rule.generated / promoted / demoted / deleted / pass_rate / pending` | 观察期规则通过率 | 系统观察期事件时（非 Agent 步骤） |
| `rollback.count / last` | 回滚次数 | 回滚执行后 |
| `skeleton.entries / bytes_saved` | 骨架化条目数与节省字节 | 骨架化变更后 |
| `memory.principle_count / pattern_count / lesson_count` | 三层体系条目数（健康度） | S13 出口核对（memory_list 统计） |
| `memory.zero_access_entries` | 存而不用条目数（access_count=0 的规则/经验） | S13 出口核对；>5 触发召回强化或清理提示 |

**仪表盘事件清单（防触发不落地）**：字段更新时机定义在事件触发点，但写入只在出口——与 access_count 消费清单同构，事件**触发即记账**（会话级内存清单，同轮同字段只计一次）：

| 触发点 | 记账动作 |
|---|---|
| S3 输出 Conflict Card / 仲裁 | `metrics_events.conflict += 1`（含 by_user/by_level 分类） |
| S2 Preflight 检索（memory_search/memory_list） | `metrics_events.retrieval_searches += N`（红线内完成记 `budget_hits`；确有召回结果记 `memory_hits`——两计数器独立） |
| 系统观察期事件（promoted/demoted/deleted/pending） | `metrics_events.auto_rule` 追加实际事件 |
| 回滚执行 | `metrics_events.rollback += 1` |
| 骨架化变更 | `metrics_events.skeleton` 记录 entries/bytes_saved |

> ✅ **D8 已修（命名空间隔离）**：仪表盘键原为 `skill:system:metrics`——**跨 skill 共用命名空间**，实测被他 skill 覆盖（混入 `skill_version` / `verify.*` / `updated_by`）。现改为 **Skill 专属键**，命名规范 **`skill:<skill-name>:<slug>`**：
> - 仪表盘 = `skill:vibe-coder-loop:metrics`（旧键弃用、**保留不删**——内含他 skill 数据）
> - 回滚锚点 = `skill:vibe-coder-loop:rollback-point`（数据全为本 Skill，原值已搬运）
> **禁止**再次使用 `skill:system:*` —— 该前缀无 owner，必然冲突。

**可观测性输出**（S13 出口）：`📊 系统仪表盘：conflict=0 ｜ retrieval_hit=xx% ｜ auto_pass=xx% ｜ rollback=0 ｜ skeleton=8条/-xxKB`

## token 报告口径（唯一口径，防逐轮漂移）

> **教训来源**：`lesson:checkpoint-instance-growth`——跨轮比较若不固定口径，会把实例增长误报为规则膨胀。**本口径为 Skill 内 token 报告的唯一定义；此后所有「token 变化」数字必须用它，并标注文件集。**

**主口径 = 规则文件净增**（估算 token = Σ字节/4）：

```text
Δtok = Σ(当前字节) − Σ(git HEAD 字节) ÷ 4
范围 = <skill>/ 下全部 .md + .yaml（递归）
排除 = .state.md（实例，随会话增长，非规则）
       CHANGELOG.md（历史日志，只增不减，无比较意义）
       backup/（工具 + 快照）
```

**辅助口径（仅一个）**：主口径 + `.state.md`（用于回答"技能目录总共大了多少"）。

**报告格式**（任何 token 数字必须带）：

```text
token 口径：规则文件净增（+<Δ> tok）[+ .state.md 辅助：+<Δ> tok]
```

**禁止**：用"循环路径 9 文件"等临时子集当报告口径（历史教训：+1817/+2823/+1324 数字分歧全部源于子集不一致）；当前值以 CHANGELOG「未达成项」节为准。

## 闭环原则

**没有 Metrics 的 Evolution 是猜测，有 Metrics 的 Evolution 是数据驱动。**
**没有实时预警的 Metrics 是滞后指标，有实时预警的 Metrics 是前馈控制。**
