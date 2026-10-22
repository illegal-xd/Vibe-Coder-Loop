# 记忆分层模型 L0–L7（数据治理口径）

> 本文件是 **delx-memory 记忆数据分层的事实源**：L0–L7 定义、边界、分类规则、字段规范与升层门槛。
> 范围：只约束**记忆数据**及其治理工具（`scripts/memory/`）。**不约束** Agent 执行流程、MCP 工具契约、Skill 运行逻辑。
> 通用记忆协议（三层体系/命名空间/TTL/supersession）仍以 `skills/delx-memory-protocol/protocol.md` 为准；本文件与其**不冲突**，是同一批数据的另一条正交轴（见 §2）。

---

## 1. 八个层级

| 层 | 名称 | 承载什么 | 现实证据形态（本库） | 关键约束 |
|---|---|---|---|---|
| **L0** | Raw 原始证据 | 原始消息、工具调用、diff、错误栈、原始任务输入/结果 | **库内不存在**。只有 3 类外置指针：metadata `source`/`evidence`/`provenance`、`~/.delx-memory/archive/**` 归档文件、value 内的路径+日期锚点 | 不得有损覆盖；不得**伪造**系统中未保存的事件 |
| **L1** | Observation 原子观测 | 一条可独立理解的事实/行为结果/错误现象/用户修正 | 现以「正文小节」形式埋在 L3 条目内，需拆分抽取 | 一条一事实；区分「观察到」与「推断」 |
| **L2** | Episode 任务经历 | 同一任务的目标→动作→约束→结果→失败与修正 | 现散落在 `lesson:*`/`reflection:*` 的「触发/根因/修正」段 | 不因关键词相似合并无关任务 |
| **L3** | Lesson 任务级经验 | 可复用策略/教训/用户纠正 | 现有 `lesson:*`(74)、`reflection:*`(18)、`experience:*`(2) | 标适用任务类型+前置条件；区分已验证/待验证；保留反例 |
| **L4** | Convention 项目级约定 | 项目规范、架构决策、工程约束 | 现有 `project:*`(48)、`rule:*`(8)、部分 `reference:*`、`global:*` | 明确项目范围；区分「用户显式指定」与「从行为归纳」；失效项保留并记取代关系 |
| **L5** | Pattern 跨项目模式 | 多项目独立验证的通用模式 | 现有 `pattern:*`(9) | **必须 ≥2 个项目独立证据**；记录适用条件与反例；不得仅凭重复出现认定 |
| **L6** | Skill 技能知识 | 有明确步骤/输入/输出/验收的技能知识**候选** | 现有 `skill:*`(31) 为 Skill 文件镜像 | **权威源是 `skills/` 文件**；L6 仅为候选+指针，不发布、不启用 |
| **L7** | Principle 元原则 | 少量稳定、跨任务、有证据的原则/红线 | 现有 `principle:*`(1) | 默认上限 10 条；必须人工审核；冲突不得自动合并 |

**层级是「知识抽象度」，不是成熟度分数。** 不得把层号当置信度或价值排序。

---

## 2. 与现有「三层体系」的关系（正交，不替代）

`protocol.md` 的三层（instance → pattern → principle）是**提升阶梯**；L0–L7 是**数据分层**。同一批记录落在两轴上的位置：

| 现有前缀 | protocol 阶梯 | L0–L7 | 说明 |
|---|---|---|---|
| `lesson:` `reflection:` `experience:` | 实例层 | L3（内含 L2 叙事） | 一条记录常混合 L2+L3 → 蒸馏必须**拆分**，禁止整条复制到两层 |
| `pattern:` | 模式层 | L5（项目内通用则为 L4） | 是否跨项目由**证据**判定，不由前缀判定 |
| `principle:` | 原则层 | L7 | 前缀仍需人工复核 |
| `rule:` | 规则层（非阶梯） | L4 | 可执行的显式约定 |
| `project:` `reference:` | 非阶梯 | L4 / 导航 | 纯索引/跳转页 → `layer=null` |
| `skill:` | 非阶梯 | L6（镜像） | 须记 `mirror_of` |
| `user:` `preference:` `env:` `tooling:` `skill-metrics:` `agent:` | 非阶梯 | `layer=null` | 见 §4 |

`scope` 与 `layer` **正交**：`pattern` 可以 `scope:project`；`lesson` 可以 `scope:global`。层号不决定作用域，作用域也不决定层号。

---

## 3. 分类规则（可解释，规则 id 落库）

分类必须同时给出 `layer` + `layer_basis`（规则 id + 理由）。规则表实现见 `scripts/memory/layers.py`。

| rule id | 判定 | 结果 |
|---|---|---|
| `prefix:<p>` | 前缀默认初判（见 §2 表） | 层 + 类别 |
| `content:navigation` | 正文含「纯导航/跳转页/不存实质内容/记忆图谱/加载包」 | `category=navigation`, `layer=null` |
| `len:oversize` | 正文 >2000 字 或 >40 行（protocol §条目标长与外置） | 保层 + `needs_review=true` |
| `content:aggregate` | ≥5 条编号子项 + 「合并/聚合/全景/清单」标记 | 保层 + `needs_review=true`（应先拆 L1） |
| `content:episode-narrative` | 含 ≥2 个「触发/根因/修正/结果/过程/复盘」小节 | 记 `contains_episode=true`（蒸馏需拆 L2） |
| `content:conflict-marker` | 含「已废弃/不再适用/被取代/反例」 | 记 `conflict_candidate`，**不自动合并** |
| 未匹配 | — | `layer=null` + `needs_review=true`（**不强行归类**） |

### 禁止
- 为了补齐层级制造没有证据的中间记录。
- 同一内容机械复制到 L1–L7。
- 把未验证推测写成成熟经验。
- 用层号表达置信度。

---

## 4. 非知识轴类别（`layer=null` 的合法情形）

> **`layer=null` 的语义（已确认）**：该记录**不属于 L0–L7 知识抽象层级**，**不代表记录无用**。
> 这些条目照常参与检索、召回、审计与回写；只是**不计入** L4–L7 的知识覆盖率与升层统计。

这些记录是有效记忆，但**没有抽象层级语义**，硬套 L0–L7 会污染高层集合（尤其会让 `user:persona` 之类被误判为 L7）。

| `memory_category` | 内容 | 例 |
|---|---|---|
| `state` | 周期指标快照 | `skill-metrics:vibe-coder-loop:2026-08` |
| `environment` | 机器/工具链事实 | `env:system`、`tooling:github-network-proxy` |
| `identity` | 用户/Agent 身份与画像 | `user:persona`、`user:profile` |
| `preference` | 用户偏好 | `preference:user:memory-autonomy` |
| `navigation` | 索引/跳转页/加载包 | `reference:memory-navigation`、`agent:vc_constraints` |
| `evidence` | L0 证据引用 | 由 `evidence_ids` 指向 |

> 用户**显式**提出的全局约束（如 `global:dev-style-rule`）归 `L4 + scope:global`，并记 `constraint_type=explicit-user`——它是「明确约束」，不是「归纳出的原则」。

---

## 5. 字段规范

存储：SQLite `memory` 表**不新增列**，分层信息写 `metadata`（JSON）+ `tags`（既有格式 `,a,b,`）。理由见审计报告 §5（R1–R8）。

| 字段 | 位置 | 取值 | 说明 |
|---|---|---|---|
| `layer` | metadata | `L0`…`L7` / `null` | 知识层级 |
| `memory_category` | metadata | 见 §4 | 非知识轴归类；`knowledge` 才计入层级覆盖率 |
| `scope` | metadata（兼容既有 tag `scope:*`） | `global`/`project`/`task`/`session` | 作用范围，独立于 layer |
| `status` | metadata | `candidate`/`active`/`superseded`/`archived` | 生命周期 |
| `review_status` | metadata | `pending`/`approved`/`rejected` | 审核状态；**候选不得默认 approved** |
| `confidence` | metadata | `0.0–1.0` + `evidence_level: E0–E4` | 既有 `"High"` 等旧值迁入 `legacy_confidence` |
| `protected` | metadata | `true` | 原始证据 / 用户显式修正 / 关键约束 / 失败证据 |
| `needs_review` | metadata | `true` | 无法可靠分类或证据不足 |
| `evidence_ids` | metadata | `string[]` | 指向 L0 证据（archive 路径/源 key/仓库文件行号） |
| `superseded_by` | metadata | `string` | 取代关系（链长上限沿用 protocol §supersession = 2） |
| `legacy_id` | metadata | `string` | 与原扁平记录对应（默认等于自身 key；衍生记录指向来源） |
| `layer_basis` | metadata | `{rule_ids:[], reasons:[], by:"audit_memory.py@<date>"}` | 可解释性，必需 |
| `last_migrated_at` | metadata | ISO 时间 | **不改 `updated_at`**，避免破坏 Relevance 的 recency 因子 |

`layer/scope/status/confidence` 四者语义不相交，**禁止互相替代**。

### 附加字段（L6 镜像 / 导航）

| 字段 | 取值 | 说明 |
|---|---|---|
| `mirror_of` | `skills/...` 相对路径 | 权威 Skill 文件指针；仅在**路径存在且内容可核验**时写入 |
| `mirror_verified` | `verified`（≥2 片段命中）/ `partial`（1 片段）/ `gap`（0 片段） | 内容核验三态 |
| `mirror_gap` | `true` | 记忆含 Skill 文件未覆盖的内容 → **保留原记录**，评估提炼为 L3/L5，不丢弃 |
| `l6_kind` | `rule_mirror` / `skill_knowledge` | 区分「规则镜像」与「完整技能知识」 |
| `needs_repair` | `true` | 导航类指向的目标已失效 → 标记待修复，**不删除、不猜替代** |

---

## 6. 升层门槛（证据优先，次数只是下限）

| 升层 | 条件 |
|---|---|
| → L4 | 同一项目 ≥3 次独立任务证据，**或**可信的明确项目规范直接支持；项目范围明确；无未解决关键矛盾 |
| → L5 | ≥2 个独立项目证据；已核对项目间差异；已记录适用条件与反例 |
| → L6 | 目标/前置条件/输入/步骤/输出/验收/失败处理齐全；多次独立验证（建议 ≥5，但非充分条件）；只产出候选 |
| → L7 | 仅提候选；**必须人工审核**；禁止依据访问次数、重复出现或模型自评升级；有效原则 ≤10 条 |

不满足门槛 → 保留在当前层并记 `candidate` + `needs_review`。

## 6.5 L6 镜像边界（已确认，5 条硬规则）

1. **权威源唯一**：`skills/` 下的 Skill 文件是正式内容的权威来源，delx-memory **不得**成为第二份独立 Skill 定义。
2. **指针优先**：能确认对应关系时写 `mirror_of`；**无法确认时标 `needs_review=true`，不得猜测路径**（禁止用模糊文件名推断）。
3. **七字段齐全**：目标 / 适用前置 / 输入 / 步骤 / 输出验收 / 失败处理 / 来源验证；缺失字段标待审，**不得编造**。
4. **保留独立价值**：若记忆含 Skill 文件尚未覆盖的真实经验或证据（`mirror_gap`），**保留原记录**并评估提炼为 L3/L5，而非丢弃。
5. **不自动发布**：本阶段不创建、不修改、不发布任何正式 Skill，也不改动 `skill-authoring/` 流程。

> 现状（2026-10-22 dry-run）：29 条 L6 候选中 **七字段达标 0 条**，全部为 `rule_mirror` → 保留候选 + 指针，**不升层、不发布**。

### 已裁决事项（2026-10-22）

| 事项 | 裁决 | 落库表现 |
|---|---|---|
| 导航类 7 条 | `layer=null` + `category=navigation` | 不计入 L4–L7 覆盖率；引用保留，失效目标标 `needs_repair` |
| 非知识轴 14 条（identity/state/environment/preference） | `layer=null` + `memory_category` | 照常可检索，不参与升层统计 |
| 29 条 `skill:*` | 仅 L6 候选 + `mirror_of` | 不发布、不改 `skill-authoring`；`gap` 5 条保留待提炼 |
| 3 条 pattern 跨项目证据不足（`async-state-race`、`external-api-drift-source-first`、`lossless-payload-splice`） | **保留 L5 + 待补证**，不降 L4 | `needs_review=true`，待补第二项目独立证据 |

## 7. 降级与归档

- 逻辑归档（`status=archived` / `archived_at`），**不物理删除**。
- 受保护内容（原始证据、用户显式修正、关键约束、失败证据、被引用的历史决策、未解决冲突）不因去重/压缩/淘汰规则静默丢失。
- 低访问次数**不能单独**作为淘汰依据（沿用 protocol §冷记忆降级：冷 ≠ 错）。

---

## 8. 迁移命令（可重复执行）

```bash
# 只读审计（不含自产衍生记录）
python3 scripts/memory/audit_memory.py --out-json reports/memory-audit-<date>.json

# 蒸馏 dry-run（零写入；计划按原始指纹冻结，重跑幂等）
python3 scripts/memory/distill.py --dry-run --out-json reports/memory-distill-<date>.json

# 回填（默认 dry-run；--apply 才写；自动备份；中断可重试）
python3 scripts/memory/migrate.py --apply
python3 scripts/memory/migrate.py --verify --out-md reports/memory-migration-<date>.md
python3 scripts/memory/migrate.py --restore ~/.delx-memory/backups/<bak> --yes   # 回滚

# 门禁
bash scripts/tests/test-memory-layers.sh
```

## 9. 当前实施状态

| 阶段 | 状态 | 产物 |
|---|---|---|
| Phase 1 只读审计 | 完成 | `reports/memory-audit-2026-10-22.{md,json}`、`scripts/memory/audit_memory.py`、`scripts/memory/layers.py` |
| Phase 2 蒸馏 dry-run | **完成**（零副作用校验通过） | `reports/memory-distill-2026-10-22.{md,json}`、`scripts/memory/distill.py` |
| Phase 3 分层回填 | **完成**（备份 → 分批 add-only → 幂等/重试/恢复全测） | `reports/memory-migration-2026-10-22.md`、`scripts/memory/migrate.py` |
| Phase 4 L4–L7 候选治理 | L5/L6/L7 候选已产出，**待人工评审**（未升层、未发布） | `reports/memory-distill-2026-10-22.json` 的 `l5/l6/l7_candidates` |
| Phase 5 质量复核 | **完成**（17 单元测试 + 8 项门禁全过） | `reports/memory-quality-2026-10-22.md`、`tests/memory/`、`scripts/tests/test-memory-layers.sh` |
