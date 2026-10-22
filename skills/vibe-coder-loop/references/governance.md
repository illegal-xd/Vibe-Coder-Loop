# 治理：骨架 ↔ 规则条目映射（Governance）

> 仅在**修改 Skill 规则 / skill:* 记忆条目 / 骨架化治理**时读取，非流程加载内容。迁移背景见 CHANGELOG.md。

## 骨架化设计原则

SKILL 文件保留**流程骨架**（触发条件 + 出口 + 安全细节），内容型规则/清单/模板下沉为 `skill:` 前缀记忆条目（level:core/domain + permanent）。**例外**：已升格为文件权威的条目（映射表 Canonical=A 的 `references/` 行）——文件本身即完整规则，条目仅为全文镜像，加载与冲突判定均以文件为准。加载：进入对应阶段按 key `memory_get`；条目不可用 → 按 `SKILL.md` 的 fail-closed 规则输出 `[RULE_STORE_MISSING]` 并停止；本文件摘要只用于定位，不得作为规则推断依据。

## Canonical Source（一个规则只能有一个事实源）

- **Skill Canonical（类型 A）**：宪法层与核心执行契约（kernel.md / policy/safety.md / engine/state-machine.md / SKILL.md / manifest.yaml + transition 出口检查 + review 判定表 + priority.md §3.5 + 映射表 Canonical=A 的 `references/` 完整规则文件）——**文件为事实源**；对应 memory 条目（`skill:policy/priority:conflict-resolution`、`skill:rules/review:hard-constraints`、`skill:rules/intent:decision-arbitration`）仅为摘要/指针/检查模板，`skill:references/*` 为**全文镜像**（`authority=file` + `mirror_kind=fulltext_mirror`，逐字同步），均不构成第二规则源。
- **Memory Canonical（类型 B）**：项目规则与经验（`rule:*`、`project:*`、`lesson:*`、`pattern:*` 等）——**条目为事实源**；Skill 文件仅"动作 + 指针 + 必要 fallback"（如 transition S2/S13 对 `rule:skill-iteration-manifest` 的处理）。
- **Static Reference（类型 C，覆盖映射表中 skill:* 规则条目）**：Skill 文件 = 稳定摘要 + 降级 fallback；`skill:*` 条目 = **完整规则的 Canonical Source**。两者是"摘要/完整版"关系，不是两条独立规则；修改规则时以条目为准并同步文件摘要。
- **协议核心特例（通用 vs 实例分治）**：拆分后，`learning/memory/` 分片按 canonical 归属分两类：
  - **通用概念 → canonical = `delx-memory-protocol/protocol.md`**：三层体系 / 命名空间 / Tag-scope / TTL / Relevance / supersession / Consolidation / 跨项目迁移。本 skill 的 `learning/memory/architecture.md` + `learning/memory/advanced.md` = **实例特化 + 指针**（通用概念已裁指针，非第二 canonical，非 fallback 副本）；修改通用概念以 `delx-memory-protocol` 为准。
  - **实例特化 → 仍文件事实源**（防自指 + S2 强制动作兜底）：`learning/memory/lifecycle.md`（出口回写绑定 S2/S8/S12）/ `learning/memory/promotion.md`（S12 收尾）/ `learning/memory/retrieval.md`（Task→Memory Router 任务类型路由）。
  - `learning/memory.md` 为稳定路径索引（外部「节名」引用经索引解析）；同内容条目（`query-router` 等）为可执行副本，以条目内"主源"声明为准。

> 注（类型判定）：**类型 A（摘要/指针，不构成第二规则源）** = `skill:policy/priority:conflict-resolution`（完整规则在 `policy/priority.md` §3.5）+ `skill:rules/review:hard-constraints`（完整清单在 `policy/safety.md` §3，条目仅是检查模板）+ `skill:rules/intent:decision-arbitration`（完整协议在 `policy/safety.md` §2，条目/`rules/intent.md` 均为摘要指针）；`skill:references/output-format` / `skill:references/debug-mode` 亦为 A，但形态是**全文镜像**（文件含完整规则、条目逐字同步，冲突以文件为准）；**类型 C（条目为完整版）** = 映射表中其余 `skill:` 规则条目。**数据条目**（`skill:vibe-coder-loop:metrics` 仪表盘 / `skill:vibe-coder-loop:rollback-point` 回滚锚点）既非 A 也非 C——它们是数据快照，不参与规则 canonical 判定（规则本体在 `learning/skill-metrics.md`）。

## 映射表

> **行格式契约**：每行一个 memory key，**key 必须写全限定形式**（不得用 `verify-first` 这类短写 —— 短写无法被机器校验，是死指针的温床）。Machine-read by `scripts/smoke-check.sh`：
> ① key 必须真实存在于 delx-memory；② `Canonical` 列 ≠ `数据` 的条目 tags 必须含 `permanent`（**规则条目带 TTL = 到期后规则凭空消失 → 静默降级**，是不可接受的失效模式）。
> **Canonical 列只取 `A` / `C` / `数据`**：类型 B（`rule:*` / `project:*` 等 Memory Canonical）不进本表——本表只登记 `skill:*` 域的下沉条目；若某行需要 B，说明该行放错了表。

| SKILL 文件 | 下沉规则条目（memory key） | 级别 | Canonical |
|---|---|---|---|
| `policy/priority.md` | `skill:policy/priority:conflict-resolution` | core+reference | A |
| `learning/memory/promotion.md` | `skill:learning/memory:observation-window` | core+reference | C |
| `learning/skill-metrics.md` | `skill:vibe-coder-loop:metrics`（仪表盘，S13 出口聚合） | core | 数据 |
| —（Skill 级） | `skill:vibe-coder-loop:rollback-point`（回滚锚点） | core | 数据 |
| `rules/intent.md` | `skill:rules/intent:goal-triple` | domain | C |
| `rules/intent.md` | `skill:rules/intent:decision-arbitration`（完整协议在 `policy/safety.md` §2） | core+reference | A |
| `rules/design.md` | `skill:rules/design:state-matrix` | domain | C |
| `rules/design.md` | `skill:rules/design:verify-first` | domain | C |
| `rules/design.md` | `skill:rules/design:mirror-sync` | domain | C |
| `rules/plan.md` | `skill:rules/plan:step-orchestration` | domain | C |
| `rules/orchestration.md` | `skill:rules/orchestration:subagent-reverify`（子 agent 结论独立复核，整合阶段第 3 项的细则） | domain | C |
| `rules/code.md` | `skill:rules/code:prechecks` | domain | C |
| `rules/code.md` | `skill:rules/code:async-defense` | domain | C |
| `rules/test.md` | `skill:rules/test:task-spec` | domain | C |
| `rules/test.md` | `skill:rules/test:degradation` | domain | C |
| `rules/review.md` | `skill:rules/review:hard-constraints`（完整清单在 `policy/safety.md` §3） | core+reference | A |
| `rules/review.md` | `skill:rules/review:eight-dimensions`（原名 five-dimensions 与内容不符，已更名） | domain | C |
| `rules/review.md` | `skill:rules/review:case-templates` | domain | C |
| `rules/review.md` | `skill:rules/review:verdict-path` | domain | C |
| `rules/review.md` | `skill:rules/review:doc-structure-recheck` | domain | C |
| —（审计口径，无对应文件） | `skill:references/dead-code-audit`（零引用/死代码结论口径；review.md 判定要点 + router.md Investigation 分支按需引用） | domain+reference | C |
| `learning/reflection.md` | `skill:learning/reflection:triggers` | domain | C |
| `learning/reflection.md` | `skill:learning/reflection:card-template` | domain | C |
| `learning/evolution.md` | `skill:learning/evolution:patch-proposal` | domain | C |
| `learning/evolution.md` | `skill:learning/evolution:trigger-conditions` | domain | C |
| `learning/skill-metrics.md` | `skill:learning/metrics:fields` | domain | C |
| `learning/skill-metrics.md` | `skill:learning/metrics:early-warning` | domain | C |
| `learning/memory/retrieval.md`（查询参考节：路由表/分工/工具能力） | `skill:learning/memory:query-router`（含主动关联召回协议） | domain+reference | C |
| `references/output-format.md` | `skill:references/output-format` | domain+reference | A |
| `references/debug-mode.md` | `skill:references/debug-mode` | domain+reference | A |

## 加载协议

S2 Preflight 检索动作已由 `backup/memory_tool.py preflight` 承担：该命令一次返回**加载清单 + 运行时章节索引 + 成本对比 + `skill:rules/*` 候选 key 列表**（只回 key 不回 value），替代原先"先读导航表 → 再逐个取 key → 再 memory_list"的多轮往返。命中域才 `memory_get`（Level 0/1 命中域才取；Level 2+ 全量 key 列表 + 命中 get）。

**宪法层**（kernel.md / policy/safety.md / engine/state-machine.md / SKILL.md / manifest.yaml）**永不沉**——确定性加载，禁止下沉。**learning/ 实例特化**（`learning/memory/lifecycle.md` 出口回写 / `learning/memory/promotion.md` S12 收尾 / `learning/memory/retrieval.md` 路由表）= 文件事实源；**通用协议概念**（三层体系/命名空间/TTL/Relevance/supersession/Consolidation/跨项目迁移）canonical = `delx-memory-protocol/protocol.md`，本目录 `learning/memory/architecture.md` + `learning/memory/advanced.md` 为**实例特化 + 指针**（通用概念已裁指针，含实例触发条件），修改通用概念以 delx-memory-protocol 为准。索引 `memory.md` 维护稳定路径（不承载规则内容）。
