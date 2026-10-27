# 记忆分层模型 L0–L7（数据治理口径）

> 本文件是 **delx-memory 记忆数据分层的事实源**：L0–L7 定义、边界、分类规则、字段规范与升层门槛。
> 范围：约束**记忆数据**及其治理工具（`scripts/memory/`）。**不约束** Agent 执行流程、MCP 工具契约、Skill 运行逻辑。
> 通用记忆协议（三层体系/命名空间/TTL/supersession）仍以 `skills/delx-memory-protocol/protocol.md` 为准；本文件与其**不冲突**，是同一批数据的另一条正交轴（见 §2）。
>
> **修订要点**：L0 只保留原始证据；runtime checkpoint 归 `category=state` / `layer=null`；L1/L2 默认不落库（按需视图）；L4 只收规范；L6 指针优先；分片必须继承父条目元数据。

---

## 1. 八个层级

| 层 | 名称 | 承载什么 | 现实证据形态（本库） | 关键约束 |
|---|---|---|---|---|
| **L0** | Raw 原始证据 | 原始消息、工具调用、diff、错误栈、原始任务输入/结果 | 外置归档 `~/.delx-memory/archive/**` + `evidence_ids` 的 `file:`/`archive:` 指针；**库内不存事件**。runtime checkpoint 不属于 L0（见 §4） | 不得有损覆盖；不得**伪造**系统中未保存的事件 |
| **L1** | Observation 原子观测 | 一条可独立理解的事实/行为结果/错误现象/用户修正 | 默认**不落库**；需要时从 L3/L2 按需切片为视图（不默认召回） | 一条一事实；区分「观察到」与「推断」；若落库须 TTL ≤30 天 + `derived` tag |
| **L2** | Episode 任务经历 | 同一任务的目标→动作→约束→结果→失败与修正 | 默认**不落库**；压缩摘要/任务复盘可写 `episode:*`（TTL ≤30 天，`derived` + candidate） | 不因关键词相似合并无关任务；不默认召回 |
| **L3** | Lesson 任务级经验 | 可复用策略/教训/用户纠正 | 现有 `lesson:*`、`reflection:*`、`experience:*` | 标适用任务类型+前置条件；区分已验证/待验证；保留反例 |
| **L4** | Convention 项目级约定 | **规范性**项目约定、架构决策、工程约束 | `rule:*`、`global:*`、符合规范标记的 `project:*`；模块文档/导航不算 L4 | 明确项目范围；区分「用户显式指定」与「从行为归纳」；失效项保留并记取代关系 |
| **L5** | Pattern 跨项目模式 | 多项目独立验证的通用模式 | 现有 `pattern:*` | **必须 ≥2 个项目独立证据**；记录适用条件与反例；不得仅凭重复出现认定 |
| **L6** | Skill 技能知识 | 有明确步骤/输入/输出/验收的技能知识**候选** | **指针优先**：`mirror_of` 指向 `skills/`；规则镜像归 `category=skill_mirror` / `layer=null`；仅七字段齐全的流程知识才 L6 | **权威源是 `skills/` 文件**；L6 仅为候选+指针，不发布、不启用 |
| **L7** | Principle 元原则 | 少量稳定、跨任务、有证据的原则/红线 | 现有 `principle:*` | 默认上限 10 条；必须人工审核；冲突不得自动合并 |

> **默认可写层 = L3–L7**（L4 仅规范、L6 仅七字段）。L0–L2 是**证据/采集轴**：L0 外置归档，L1/L2 是按需视图；没有 capture 管线时不得为了补齐层级而批量入库。

**层级是「知识抽象度」，不是成熟度分数。** 不得把层号当置信度或价值排序。

---

## 2. 与现有「三层体系」的关系（正交，不替代）

### 2.1 三条轴，不要混成一条阶梯

| 轴 | 内容 | 说明 |
|---|---|---|
| **抽象阶梯** | L3 → L5 → L7 | 实例 → 模式 → 原则；只有这三层参与“升层” |
| **正交类别** | L4 规范 · L6 流程技能 | 不是阶梯的下一级；L4 可由用户显式指定，L6 权威源在 `skills/` |
| **证据/采集轴** | L0 原始 → L1 观察视图 → L2 Episode 视图 | 默认不落库；capture 才启用，且不直接参与日常召回 |
| **作用域** | `scope:global/project/task/session` | 与 layer 正交；层号不决定作用域 |

`protocol.md` 的三层（instance → pattern → principle）是**提升阶梯**；L0–L7 是**数据分层**。同一批记录落在两轴上的位置：

| 现有前缀 | protocol 阶梯 | L0–L7 | 说明 |
|---|---|---|---|
| `lesson:` `reflection:` `experience:` | 实例层 | L3（L2 叙事保留在原文） | 一条记录可含任务叙事；L2 只作**按需视图**，不默认另存一份 |
| `pattern:` | 模式层 | L5（项目内通用则为 L4） | 是否跨项目由**证据**判定，不由前缀判定 |
| `principle:` | 原则层 | L7 | 前缀仍需人工复核 |
| `rule:` | 规则层（非阶梯） | L4 | 可执行的显式约定 |
| `project:` `reference:` | 非阶梯 | L4 **仅限规范**；模块文档/导航 → `layer=null` | 纯索引/跳转页 → `category=navigation`；项目事实 → `category=project_knowledge` |
| `skill:` | 非阶梯 | L6 **仅七字段齐全**；规则镜像 → `layer=null` | 须记 `mirror_of`；无指针的镜像归 `category=skill_mirror` |
| `obs:` `episode:` | 非阶梯 | L1 / L2 **按需视图** | 默认不落库；落库须 `derived` + candidate + TTL ≤30 天 |
| `vc:checkpoint:*` | 非阶梯 | `layer=null` + `category=state` | runtime checkpoint，不属于 L0 |
| `signal:` `feedback:` | 非阶梯 | `layer=null` + `category=state` | P1 经验进化闭环的运行观测账本；不进入 L0–L7 统计（见 §6.8） |
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
| `content:aggregate` | ≥5 条编号子项 + 「合并/聚合/全景/清单」标记 | 保层 + `needs_review=true`（应先拆成多条 L3 或外置） |
| `content:episode-narrative` | 含 ≥2 个「触发/根因/修正/结果/过程/复盘」小节 | 记 `contains_episode=true`（蒸馏需拆 L2） |
| `content:conflict-marker` | 含「已废弃/不再适用/被取代/反例」 | 记 `conflict_candidate`，**不自动合并** |
| `fragment:inherit-parent` | key 含 `#` 或 tag 含 `fragment` | **继承父条目**的 layer/category/scope/evidence_ids；不独立分类 |
| `content:project-knowledge` | `project:`/`reference:` 且无规范标记 | `layer=null` + `category=project_knowledge`（或 `navigation`） |
| `l6:field-gate` | `skill:` 且七字段不足 | `layer=null` + `category=skill_mirror` + `needs_review=true` |
| `runtime:checkpoint` | key 以 `vc:checkpoint` 开头 | `layer=null` + `category=state` + tag `runtime-state` |
| `prefix:signal` / `prefix:feedback` | 运行观测账本 | `layer=null` + `category=state`（不进入 L0–L7） |
| 未匹配 | — | `layer=null` + `needs_review=true`（**不强行归类**） |

### 禁止
- 为了补齐层级制造没有证据的中间记录。
- 同一内容机械复制到 L1–L7。
- 把未验证推测写成成熟经验。
- 用层号表达置信度。
- 只写 metadata `layer` 而不写 `layer:<L>` tag —— 后者才是 `memory_list(tag=...)` 可过滤的检索面。

> **写入一致性**：所有非 null layer 必须同时有 `layer:<L>` tag；分片必须继承父条目元数据；可用
> `python3 scripts/memory/memops.py validate` 检查，`memops.py repair --ttl --apply` 回填（metadata-only，自动备份）。
>
> `content:project-knowledge` / `l6:field-gate` 是**迁移期校验规则**：`memops validate` 对存量告警
> （`project_knowledge_in_l4` / `l6_mirror_without_pointer`），不自动改写语义；新写入按此判定，存量逐步人工迁移。

---

## 4. 非知识轴类别（`layer=null` 的合法情形）

> **`layer=null` 的语义（已确认）**：该记录**不属于 L0–L7 知识抽象层级**，**不代表记录无用**。
> 这些条目照常参与检索、召回、审计与回写；只是**不计入** L4–L7 的知识覆盖率与升层统计。

这些记录是有效记忆，但**没有抽象层级语义**，硬套 L0–L7 会污染高层集合（尤其会让 `user:persona` 之类被误判为 L7）。

| `memory_category` | 内容 | 例 |
|---|---|---|
| `state` | 周期指标快照 / runtime checkpoint / 反思信号 / 反馈账本 | `skill-metrics:vibe-coder-loop:2026-08`、`vc:checkpoint:*`、`signal:reflection:*`、`feedback:memory:*` |
| `environment` | 机器/工具链事实 | `env:system`、`tooling:github-network-proxy` |
| `identity` | 用户/Agent 身份与画像 | `user:persona`、`user:profile` |
| `preference` | 用户偏好 | `preference:user:memory-autonomy` |
| `navigation` | 索引/跳转页/加载包 | `reference:memory-navigation`、`agent:vc_constraints` |
| `project_knowledge` | 项目模块/文档事实（非规范） | `project:jtkl-module-index`、`project:webbas-engine-packages` |
| `skill_mirror` | Skill 规则镜像（指针） | `skill:rules/review:hard-constraints` |
| `evidence` | L0 证据引用 | 由 `evidence_ids` 指向 |

> 用户**显式**提出的全局约束（如 `global:dev-style-rule`）归 `L4 + scope:global`，并记 `constraint_type=explicit-user`——它是「明确约束」，不是「归纳出的原则」。
>
> **runtime checkpoint**：`vc:checkpoint:*` 固定 `category=state`、`layer=null`、tags `vc-checkpoint` / `runtime-state` / `scope:project`。它只承载运行实例态，不参与 L0–L7 覆盖率与升层统计；旧 `L0` tag 由 `memops.py repair` 迁移。

---

## 5. 字段规范

存储：SQLite `memory` 表**不新增列**，分层信息写 `metadata`（JSON）+ `tags`（既有格式 `,a,b,`）。理由见审计报告 §5（R1–R8）。

| 字段 | 位置 | 取值 | 说明 |
|---|---|---|---|
| `layer` | metadata **+ tag `layer:<L>`** | `L0`…`L7` / `null` | 知识层级；**非 null 必须同步可过滤 tag** |
| `memory_category` | metadata | 见 §4 | 非知识轴归类；`knowledge` 才计入层级覆盖率 |
| `scope` | metadata（兼容既有 tag `scope:*`） | `global`/`project`/`task`/`session` | 作用范围，独立于 layer |
| `status` | metadata | `candidate`/`active`/`superseded`/`archived` | 生命周期 |
| `review_status` | metadata | `pending`/`approved`/`rejected` | 审核状态；**候选不得默认 approved** |
| `confidence` | metadata | `0.0–1.0` + `evidence_level: E0–E4` | 既有 `"High"` 等旧值迁入 `legacy_confidence` |
| `protected` | metadata | `true` | 原始证据 / 用户显式修正 / 关键约束 / 失败证据 |
| `needs_review` | metadata | `true` | 无法可靠分类或证据不足 |
| `evidence_ids` | metadata | `string[]` | 指向 L0 证据（archive 路径/源 key/仓库文件行号） |
| `superseded_by` | **value（`## 时序链`）** | `string` | 取代关系**不写 metadata**（metadata 整体替换会丢失）；链长上限沿用 protocol §supersession = 2 |
| `legacy_id` | metadata | `string` | 与原扁平记录对应（默认等于自身 key；衍生记录指向来源） |
| `layer_basis` | metadata | `{rule_ids:[], reasons:[], by:"memops.py@<date>"}` | 可解释性，必需 |
| `parent_key` | metadata | `string` | 分片父条目 key |
| `fragment` | metadata | `true` | 该条是分片，不是独立知识单元 |
| `part` / `of_parts` | metadata | `int` | 分片序号与总数（上限 5） |
| `content_hash` | metadata | `sha256` | 分片/派生内容指纹，用于去重与幂等 |
| `derived_from` | metadata | `string` | 派生来源 key（分片/切片） |
| `evidence_missing` | metadata | `string[]` | 原 `evidence_ids` 中的悬空引用，待补证；不静默丢失 |
| `ttl_policy` | metadata | `string` | `memops repair --ttl` 补齐 TTL 的审计标记（如 `lesson:90d`） |
| `last_migrated_at` | metadata | ISO 时间 | 迁移审计字段；**新写入不再写**，且不改 `updated_at` |

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
| → L4 | **规范性**约定：同一项目 ≥3 次独立任务证据，**或**可信的明确项目规范直接支持；项目范围明确；无未解决关键矛盾。项目模块文档/导航**不算** L4 |
| → L5 | ≥2 个独立项目证据；已核对项目间差异；已记录适用条件与反例 |
| → L6 | 目标/前置条件/输入/步骤/输出/验收/失败处理**七字段齐全**；有 `mirror_of` 或权威文件；多次独立验证（建议 ≥5，但非充分条件）；只产出候选。规则镜像**不算** L6 |
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
| 29 条 `skill:*` | 仅 L6 候选 + `mirror_of` | 不发布、不改 `skill-authoring`；`gap` 5 条保留待提炼；当前多数未写 `mirror_of`，`memops validate` 报 `l6_mirror_without_pointer` |
| 3 条 pattern 跨项目证据不足（`async-state-race`、`external-api-drift-source-first`、`lossless-payload-splice`） | **保留 L5 + 待补证**，不降 L4 | `needs_review=true`，待补第二项目独立证据 |

## 6.6 分片协议（fragment）

> 触发：单条 `lesson:*` / `project:*` / `reference:*` 超过 2000 字或 40 行。分片是**检索优化**，不是新知识层。

1. **父条目 = router**：父条目保留标题、结论与「分片索引」表；原文完整归档到 `~/.delx-memory/archive/**`，归档路径写入 `archive_ref`。
2. **分片继承父条目元数据**：`layer` / `memory_category` / `scope` / `status` / `review_status` / `confidence` / `evidence_level` / `evidence_ids` / `protected` 全部继承；补 `parent_key` / `part` / `of_parts` / `fragment=true` / `content_hash` / `derived_from`。
3. **可过滤**：分片必须带 `fragment` tag 与 `layer:<L>` tag；默认召回排除 `fragment` tag 与 `#` key，只有需要细节时才 `memory_get`。
4. **证据链**：分片的 `evidence_ids` 至少包含 `file:<archive_path>#<parent_key>`；不得只留“已归档”三个字。
5. **上限与工具**：一个父条目 ≤5 片；超过则改为外置 artifact/归档文件，不再增加记忆条目。分片只能由 `memops.py split` 生成，禁止手工复制。

## 6.7 L1/L2 策略（默认不落库）

> 实测：130 条 `obs:`/`episode:` 派生记录 `access_count=0`，已归档到 `~/.delx-memory/archive/consolidation-2026-10-23/derived-layer.md`；在库条目已语义覆盖。

- **默认**：L1/L2 只作为**按需视图**（从 L3/L2 原文切片），不写入记忆库、不参与召回、不计入层级覆盖率。
- **启用 capture 时**：`derived` + `candidate` + TTL ≤30 天；只作为提炼 L3 的原料，不直接回答用户；到期后归档而非续期。
- **禁止**：为了“层级完整”批量生成 L1/L2；同一内容同时以 L2 与 L3 常驻。

## 6.8 经验进化闭环（P1：signal / feedback / draft）

> 目标：让「反思触发 → 记忆效用观测 → Skill 草稿」形成可验证闭环；**复用现有 `memory` 表，不新增表/列**。三类记录都是运行观测或候选产物，不改变 L0–L7 语义与晋升门槛。

| 记录 | key | 内容 | TTL | 写入方 |
|---|---|---|---|---|
| 反思信号 | `signal:reflection:<digest>` | 信号类型 / task / fingerprint / 证据 / 是否已验证 / 聚合次数 | 90 天 | `scripts/memory/reflection_signals.py record` |
| 记忆效用 | `feedback:memory:<digest>` | task / memory_key / retrieved / usage / outcome / attribution / confidence / 证据 | 180 天 | `scripts/memory/memory_feedback.py record` |
| Skill 草稿 | `reports/skill-drafts/<slug>/` | `SKILL.md`（`status=draft`）+ `draft.json` | 文件，不入库 | `scripts/memory/skill_draft.py generate` |

**字段语义**：

| 记录 | 字段 | 取值 / 语义 |
|---|---|---|
| signal | `signal_type` | `user_correction` / `verification_failure` / `repeated_failure` / `high_cost_rework` |
| signal | `task_id` / `fingerprint` / `dedupe_token` | 本轮任务标识 / 同类问题指纹 / 同任务内区分轮次（决定幂等 key） |
| signal | `verified` / `evidence_ids` | 是否确认真实事件；verified=true 必须有证据（`file:` / `memory:` / `anchor:`） |
| signal | `occurrence_count` / `report_count` | 独立事件数（决定是否重复失败）/ 同事件重复上报次数（不放大样本） |
| feedback | `task_id` / `memory_key` / `memory_layer` | 任务 / 被观测记忆 / 记录时层级 |
| feedback | `retrieved` / `usage` | 是否进入上下文 / `used` / `not_used` / `unknown`（usage=used 必须有证据） |
| feedback | `outcome` | `success` / `failure` / `neutral` / `unknown`（任务结果，独立于 usage） |
| feedback | `attribution` / `confidence` | `direct` / `partial` / `none` / `unknown`；归因可信度 `high` / `medium` / `low` / `unknown` |
| feedback | `memory_value_hash` / `last_value_hash` | 首次记录 / 最近记录时的记忆内容 sha256，用于只读漂移检测 |
| feedback | `recorded_at_ms` / `updated_at_ms` / `updates` | 首次记录 / 最近更新 / 同一样本更新次数 |

**硬约束**：

- 两类记录固定 `layer=null` / `memory_category=state`，不进 L4–L7 覆盖率，也不参与升层/淘汰统计。
- 幂等：signal 按 `(task, type, fingerprint, dedupe_token)`、feedback 按 `(task, memory_key)` 生成确定性 key；重复执行只更新同一条记录。
- 效用反馈只采集 `retrieved` / `used` / `not_used` / `unknown` 与任务结果；**不合并为单一分数**，不因一次失败自动降权/归档/删除。
- 草稿只写文件，不写记忆、不改正式 `skills/<name>/`（仅允许显式 `skills/_drafts/` 暂存）、不完成 L6 晋升；已有正式 Skill 覆盖时只生成改进提案。
- 原始记忆的 value/tags/metadata 不被上述工具改写；`memory_feedback.py verify` 只读校验并报告内容漂移。
- 当前版本**无独立 `memory_pack` 实现**；`retrieved` 以 S2 preflight 候选 + 实际 `memory_get` 消费清单为准，不虚构未发生的注入。

**命令**：入口、副作用与退出码唯一事实源 = `docs/tooling.md`；治理/迁移命令示例见 §8。参数以 `--help` 为准：

```bash
python3 scripts/memory/reflection_signals.py record --help
python3 scripts/memory/memory_feedback.py record --help
python3 scripts/memory/skill_draft.py generate --help
```

## 7. 降级与归档

- 默认逻辑归档（`status=archived` / `archived_at`）；仅 Relevance 淘汰/用户显式要求时按 protocol 的删除义务执行（先备份、核验归属与可回滚证据），文件/代码资产仍**永不物理删除**。
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

# 运维检查（只读）/ 检索 / 回填 / 分片（默认 dry-run）
python3 scripts/memory/memops.py validate --max-examples 5
python3 scripts/memory/memops.py search "关键词" --limit 5
python3 scripts/memory/memops.py repair --ttl --apply          # metadata-only，自动备份
python3 scripts/memory/memops.py split <key> --max-chars 1800 --apply

# 经验进化闭环（只读 / dry-run 优先）
python3 scripts/memory/reflection_signals.py evaluate --task-id <T> --json
python3 scripts/memory/memory_feedback.py report --json
python3 scripts/memory/memory_feedback.py verify --json
python3 scripts/memory/skill_draft.py scan --json
python3 scripts/memory/skill_draft.py generate --dry-run --json

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
| Phase 6 运维修复 | **完成**：`memops.py`（validate/search/repair/split）+ 单测；真实库 metadata-only 修复 328 条（114 分片继承、209 条 `layer:*` tag、203 条 TTL、1 条 checkpoint 归 state、5 条悬空证据移入 `evidence_missing`）；`validate` PASS（仅 L6 无指针 / L4 项目知识 / review backlog 告警） | `scripts/memory/memops.py`、`tests/memory/test_memops.py`、`~/.delx-memory/db.sqlite`（备份 `db.sqlite.bak-memops-repair-*`） |
| Phase 7 经验进化闭环（P1） | **完成**：反思信号门控 / 记忆效用反馈 / Skill 草稿生成；复用现有表，无 schema 迁移；42 项单测 | `scripts/memory/{evolution_store,reflection_signals,memory_feedback,skill_draft}.py`、`tests/memory/test_evolution_loop.py` |
