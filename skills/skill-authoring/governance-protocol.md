# Skill 维护协议（governance）

> 本文件是 **Agent Skill 维护的通用协议事实源**，与具体工程 Agent 解耦。
> 宿主 Skill（如 `vibe-coder-loop`）的 **自身映射表**（骨架↔规则条目映射）是宿主实例资产，保留在宿主的 `references/governance.md`；本文件只提供通用骨架化协议 + canonical source 分类 + 下沉与 fallback 协议 + 残留验证纪律。
> 本文件提取自 `vibe-coder-loop` 的 `references/governance.md` 通用部分，作为可复用协议独立化。

## 骨架化设计原则

SKILL 文件保留**流程骨架**（触发条件 + 出口 + 安全细节），内容型规则/清单/模板下沉为 `skill:` 前缀记忆条目（level:core/domain + permanent）。加载：进入对应阶段按 key `memory_get`；条目不可用时的失败策略由宿主 Skill 决定（宿主声明 fail-closed 时必须停止，不得以摘要推断规则）。

## Canonical Source（一个规则只能有一个事实源）

- **Skill Canonical（类型 A）**：宪法层与核心执行契约（kernel.md / policy/safety.md / engine/state-machine.md / SKILL.md / manifest.yaml + transition 出口检查 + review 判定表）——**文件为事实源**；对应 memory 条目仅为摘要/指针/检查模板，不构成第二规则源。
- **Memory Canonical（类型 B）**：项目规则与经验（`rule:*`、`project:*`、`lesson:*`、`pattern:*` 等）——**条目为事实源**；Skill 文件仅"动作 + 指针 + 必要 fallback"。
- **Static Reference（类型 C，覆盖映射表中 skill:* 规则条目）**：Skill 文件 = 稳定摘要 + 降级 fallback；`skill:*` 条目 = **完整规则的 Canonical Source**。两者是"摘要/完整版"关系，不是两条独立规则；修改规则时以条目为准并同步文件摘要。

> **数据条目**（如 `skill:<host>:metrics` 仪表盘 / `skill:<host>:rollback-point` 回滚锚点）既非 A 也非 C——它们是数据快照，不参与规则 canonical 判定（规则本体在宿主的 skill-metrics 协议文件）。

## 加载协议

- Preflight 增加 `memory_list(prefix="skill:rules/<本任务涉及的子域>")` 按需检索（低复杂度命中域才取；高复杂度全量 key 列表 + 命中 get）。
- **宪法层**（kernel.md / policy/safety.md / engine/state-machine.md / SKILL.md / manifest.yaml）**永不沉**——确定性加载，禁止下沉。
- 协议核心文件保留文件事实源（防自指 + Preflight 强制动作兜底）；索引文件维护稳定路径（不承载规则内容）。
- **下沉条目的增 / 改 / 删**属 Agent 自主操作（授权模型见 `delx-memory-protocol` 协议 §记忆操作授权模型）——**不留待用户确认**；义务 = 质量闸门 + 三列完整回传 + 删除前核验归属与可回滚证据 + 改后引用扫描与快照重建。

## 残留验证纪律（修改 Skill 后强制）

修改 Skill 规则文件后，出口必须运行自检脚本。**验证从"人工裁决"升级为"可执行门禁"** ——
人工裁决已被历史事故证伪（改名后漏掉非编号形态 → 死指针存活多轮），故凡可机械判定的项一律由脚本给结论。

| 检查项 | 判定 | 失败码 |
|---|---|---|
| 日期残留（正文禁止日期备注） | 机械 | `RESIDUAL_HIT`（HARD） |
| 版本残留（正文禁止版本标注） | 机械 | `RESIDUAL_HIT`（HARD） |
| 死指针候选词 | **需裁决**（引用 vs 节标题） | `DEAD_POINTER_CANDIDATE`（非 HARD） |
| 映射表左列文件存在性 | 机械 | `MAP_INCONSISTENT`（HARD） |
| **映射表声明的 key 存在性 + TTL 不变量** | 机械 | `MAP_INCONSISTENT`（HARD） |
| 自测命令 | 机械 | `STRUCTURAL_INCONSISTENT`（HARD） |
| **加载计划路径存在性 + 已被文档提及** | 机械 | `LOAD_PLAN_PATH_MISSING` / `LOAD_PLAN_UNDOCUMENTED`（HARD） |
| Markdown 表格列数一致性 | 机械 | `STRUCTURAL_INCONSISTENT`（HARD） |
| **行数预算（防规则膨胀）** | 机械 | `BUDGET_EXCEEDED`（退出码 2） |

**退出码**：0 = 通过；1 = HARD 违规；2 = 仅预算超限；3 = 环境/用法错误。

**TTL 不变量**（上表第 5 行）：映射表 `Canonical` 列 ≠ `数据` 的条目，tags 必须含 `permanent`。
依据：类型 A/C 条目承担规则事实源职责，带 TTL 会**到期后凭空消失并静默降级到文件内摘要**。
映射表因此必须写**全限定 key**（短写无法被机器校验，是死指针温床）。

**预算语义 = 棘轮**：默认预算只降不升；确需上调必须在 CHANGELOG 记明理由。

## 自检脚本架构（单一来源 + 生成）

检查逻辑**只存在一处**：`scripts/smoke-check-core.sh`（被 source 的库）。三个消费者只是配置薄包装：

```text
skill-authoring/scripts/smoke-check-core.sh      ← 逻辑唯一事实源
  ├── skill-authoring/scripts/smoke-check.sh          （本协议 Skill 自身实例）
  ├── skill-authoring/scripts/smoke-check-template.sh （供外部 Skill 实例化的模板）
  └── <宿主 Skill>/scripts/smoke-check.sh             （如 vibe-coder-loop）
```

**禁止复制检查逻辑到实例** —— 历史上同一份逻辑曾在模板与两个实例间复制三份、需三处同步且各自漂移。
实例化方式：复制**模板**（不是 core）到目标 Skill 的 `scripts/smoke-check.sh`，只改「配置区」的值。

> core 定位由模板/实例内的多候选列表吸收跨 Skill 布局差异（含 `$HOME/.agents/skills/...` 兜底）；
> 候选全失效时显式报 `STRUCTURAL_INCONSISTENT` 并给 `[next]`，**不静默跳过检查**。

## 草稿生成与自检（P1-3）

`vibe-coder-loop` 的 `scripts/memory/skill_draft.py` 从 L5 Pattern 生成草稿时遵循本协议：

1. **草稿不是正式 Skill**：默认写入 `reports/skill-drafts/`，固定 `status: draft` + `draft: true`；不得放入正式 `skills/<name>/`（确需暂存仅用 `skills/_drafts/`），不得注册到路由器或 `manifest.yaml`。
2. **必备章节**：名称与用途 / 触发条件与适用范围 / 前置条件与输入 / 推荐执行步骤 / 验证标准与预期结果 / 常见失败与恢复 / 不适用条件与已知反例 / 经验来源与证据 / 验证状态与待解决。
3. **证据与状态**：保留来源 Pattern、实例/证据引用与 `verification: pending`；证据不足、存在未解决冲突或未达复用阈值 → 只报告 `deferred`，不生成确定性规则。
4. **去重**：已有正式 Skill 覆盖 → 生成改进提案，不新建重复技能；已有草稿 → 更新同一目录，不重复创建；人工修改过的草稿不覆盖。
5. **自检**：生成后调用 `scripts/smoke-check-core.sh`（存在时），失败如实记录 `verification: self-check-failed` 并以非零退出码报告；**不得把 skipped / failed 写成 pass**。
6. **晋升**：草稿 → 人工 Review → 正式 L6 / Skill 目录；本阶段不改变 L6 晋升门槛。
