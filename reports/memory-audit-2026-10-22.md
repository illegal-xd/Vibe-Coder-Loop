# delx-memory 审计报告（2026-10-22）

> 生成时间：2026-10-22T01:58:32.416952+00:00　数据库：`~/.delx-memory/db.sqlite`　只读：是（`mode=ro`）
> 口径：本报告所有数字由 `scripts/memory/audit_memory.py` 对真实库执行得出，未做人工修饰。

## 1. 总量与结构

- 语料指纹 `corpus_fingerprint`：`ac7555d931b80922632d3f30fc07cc52fa5d648fe66a2c0a7e6099163cd6448c`（key+value 哈希集，用于 Phase 2/3 前后比对）
- 记忆条目：**217**　总字符：**337334**　中位长度：1072　最长：11260
- 物理表：`memory(key, value, created_at, updated_at, ttl_expires_at, tags, metadata)` + FTS5 外部内容表（`memory_fts`）+ TTL/tags/updated_at 三个索引
- metadata 非法 JSON：0 条 

### 前缀分布

| 前缀 | 条数 |
|---|---|
| `lesson` | 74 |
| `project` | 48 |
| `skill` | 31 |
| `reflection` | 18 |
| `reference` | 12 |
| `pattern` | 9 |
| `rule` | 8 |
| `preference` | 3 |
| `tooling` | 3 |
| `env` | 2 |
| `experience` | 2 |
| `skill-metrics` | 2 |
| `user` | 2 |
| `agent` | 1 |
| `global` | 1 |
| `principle` | 1 |

### metadata 字段使用率

| 字段 | 条数 |
|---|---|
| `layer` | 217 |
| `memory_category` | 217 |
| `status` | 217 |
| `review_status` | 217 |
| `confidence` | 217 |
| `evidence_level` | 217 |
| `needs_review` | 217 |
| `evidence_ids` | 217 |
| `legacy_id` | 217 |
| `layer_basis` | 217 |
| `migration_id` | 217 |
| `scope` | 216 |
| `title` | 214 |
| `access_count` | 208 |
| `cache_hit_count` | 206 |
| `access_protocol` | 31 |
| `source` | 19 |
| `consolidated_from` | 10 |
| `archived_at` | 9 |
| `note` | 9 |
| `evidence` | 7 |
| `updated_by` | 7 |
| `related` | 6 |
| `instances` | 6 |

## 2. L0–L7 分类建议

| 层级 | 条数 | 含义 |
|---|---|---|
| L3 | 94 | Lesson |
| L4 | 63 | Convention |
| L5 | 9 | Pattern |
| L6 | 29 | Skill |
| L7 | 1 | Principle |
| None | 21 | 非知识轴（layer=None） |

非知识轴类别：`knowledge`=196，`navigation`=7，`environment`=5，`state`=4，`preference`=3，`identity`=2

## 3. 数据质量

- 精确重复（规范化后 value 完全相同）：**0** 组
- 近似重复候选（3-gram Jaccard ≥0.35 或 containment ≥0.55 或标题相似 ≥0.50）：**5** 对（merge 候选 1 对，其余为相关候选）
- 悬空引用（引用了库内不存在的 key）：**54** 处（其中 36 处指向已合并归档条目、证据在 `archive/` 文件内；**18 处为真缺失**）
- 缺 scope 标注：**1** 条
- 无来源证据锚点：**16** 条
- TTL 已过期仍在库：**0** 条
- 已归档（`archived_at`/tag）：**9** 条
- 超实例层长度上限（>2000 字）：**50** 条
- 疑似冲突标记（含「已废弃/被取代/反例」等）：**15** 条
- 单条混合 L2 叙事 + L3 结论（蒸馏需拆分）：**11** 条
- 需人工审核：**57** 条


### 审计方法与局限

- **精确重复**：value 规范化（折叠空白）后 SHA-256 相等。局限：不识别「同义改写」。
- **近似重复**：字符 3-gram 集合的 Jaccard / containment + 首行（或 metadata.title）3-gram 相似度；阈值 `Jaccard≥0.35` 或 `containment≥0.55` 或 `标题≥0.50`，且较短一方 ≥200 字才可判 merge 候选。阈值是按本库真实分布**校准**（语料已于 2026-10-21 做过一轮合并）后取的低门槛——只用于**发现候选**。
- **局限（必须知晓）**：
  - 近似重复用字面 n-gram，**语义等价但用词不同**的条目会漏检（漏检代价 = 冗余，不是数据损坏）。
  - 无向量/嵌入模型（本次约束不引入重型依赖），因此「语义相似仅作候选提示，绝不作为删除/合并依据」。
  - 冲突检测基于标记词（已废弃/被取代/反例），**不能**发现两段无标记但结论相反的文本 → 需人工抽检补位。
  - 「来源证据」判定为锚点存在性（metadata 指针 / 日期 / E 级 / 路径），**不验证证据真伪**。
  - 引用扫描用正则识别 key 形态，已过滤 skill 名/占位符/截断噪声，仍可能漏掉自由文本里的口语化指代。

### 近似重复（Top 15，仅候选，不自动合并）

| A | B | Jaccard | containment | 标题相似 | 判定 |
|---|---|---|---|---|---|
| `lesson:long-doc-multi-edit-structure-recheck` | `skill:rules/review:doc-structure-recheck` | 0.382 | 0.593 | 0.109 | merge_candidate |
| `reference:java-vibe-code` | `reference:memory-navigation` | 0.04 | 0.554 | 0.029 | related_candidate |
| `project:java-vibe-code-overview` | `reference:java-vibe-code` | 0.14 | 0.423 | 0.591 | related_candidate |
| `project:java-vibe-code-conventions` | `project:java-vibe-code-overview` | 0.128 | 0.298 | 0.5 | related_candidate |
| `project:jtkl-module-compress` | `project:jtkl-module-index` | 0.099 | 0.276 | 0.538 | related_candidate |

### 悬空引用

- `experience:delx-memory-runtime-memory` → `experience:delx-memory-rss-optimization`（consolidated_from） · `merged_archive`
- `experience:delx-memory-runtime-memory` → `experience:bun-vs-node-read-load-memory`（consolidated_from） · `merged_archive`
- `experience:delx-memory-runtime-memory` → `experience:no-sdk-jsonrpc-memory-gain`（consolidated_from） · `merged_archive`
- `experience:delx-memory-runtime-memory` → `experience:rust-base-memory-probe`（consolidated_from） · `merged_archive`
- `lesson:entry-opened-without-downstream-rules` → `lesson:entry-opened-without-downstream-rules`（consolidated_from） · `missing` — self-reference（自身被列为来源）
- `lesson:entry-opened-without-downstream-rules` → `reflection:entry-open-vs-downstream-rules`（consolidated_from） · `missing`
- `lesson:regex-rewrite-must-reemit-delimiters` → `lesson:verification-before-completion`（value） · `missing`
- `project:delx-memory-web-overview` → `project:delx-memory-web-jsonviewer`（value） · `missing`
- `project:design-doc-pipeline` → `lesson:async-statusmap-vs-static-constants-race-condition`（value） · `missing`
- `project:design-doc-pipeline` → `lesson:state-matrix-design-principles`（value） · `missing`
- `project:design-doc-pipeline` → `lesson:verify-before-assume-special-handling`（value） · `missing`
- `project:jtkl-conventions` → `project:jtkl-frontend-conventions`（consolidated_from） · `merged_archive`
- `project:jtkl-conventions` → `project:jtkl-mgmt-conventions`（consolidated_from） · `merged_archive`
- `project:jtkl-git-conventions` → `project:jtkl-commit-convention`（value） · `missing`
- `project:jtkl-git-conventions` → `project:jtkl-git-update-workflow`（value） · `missing`
- `project:jtkl-i18n` → `project:jtkl-console-i18n`（consolidated_from） · `merged_archive`
- `project:jtkl-i18n` → `project:jtkl-mgmt-i18n`（consolidated_from） · `merged_archive`
- `project:jtkl-modules` → `project:jtkl-module-alarm`（consolidated_from） · `merged_archive`
- `project:jtkl-modules` → `project:jtkl-module-experience`（consolidated_from） · `merged_archive`
- `project:jtkl-modules` → `project:jtkl-module-pool-auth`（consolidated_from） · `merged_archive`
- `project:jtkl-modules` → `project:jtkl-mgmt-module-alarm`（consolidated_from） · `merged_archive`
- `project:jtkl-modules` → `project:jtkl-mgmt-module-activity`（consolidated_from） · `merged_archive`
- `project:jtkl-modules` → `project:jtkl-mgmt-module-dashboard`（consolidated_from） · `merged_archive`
- `project:jtkl-modules` → `project:jtkl-mgmt-module-overview`（consolidated_from） · `merged_archive`
- `project:jtkl-modules` → `project:jtkl-compress-v321-activity-tag`（consolidated_from） · `merged_archive`
- `project:jtkl-versions` → `project:jtkl-modules-v320`（consolidated_from） · `merged_archive`
- `project:jtkl-versions` → `project:jtkl-mgmt-modules-v320`（consolidated_from） · `merged_archive`
- `project:obsidian-vault` → `project:obsidian-vault-structure`（consolidated_from） · `merged_archive`
- `project:obsidian-vault` → `project:obsidian-conventions`（consolidated_from） · `merged_archive`
- `project:obsidian-vault` → `project:obsidian-ai-entrypoint`（consolidated_from） · `merged_archive`
- `project:webbas-engine-audit-2026-10` → `project:webbas-engine-code-audit-2026-10`（consolidated_from） · `merged_archive`
- `project:webbas-engine-audit-2026-10` → `project:webbas-engine-silent-catch-map`（consolidated_from） · `merged_archive`
- `project:webbas-engine-audit-2026-10` → `project:webbas-engine-http-error-spread-leak`（consolidated_from） · `merged_archive`
- `project:webbas-engine-audit-2026-10` → `project:webbas-engine-dts-parity-guard`（consolidated_from） · `merged_archive`
- `project:webbas-engine-audit-2026-10` → `project:webbas-engine-public-export-surface-audit`（consolidated_from） · `merged_archive`
- `project:webbas-engine-audit-2026-10` → `project:webbas-engine-utils-export-trim-misfire`（consolidated_from） · `merged_archive`
- `project:webbas-engine-overview` → `project:webbas-engine-build-package-json`（value） · `missing`
- `project:webbas-engine-releases` → `project:webbas-engine-v0.0.5`（consolidated_from） · `merged_archive`
- `project:webbas-engine-releases` → `project:webbas-engine-v0.0.6`（consolidated_from） · `merged_archive`
- `project:webbas-engine-releases` → `project:webbas-engine-v0.0.7`（consolidated_from） · `merged_archive`

## 4. 设计与现有数据的映射问题（Phase 1 结论）

1. **L0 无事件存储**：库内 0 条原始事件（无消息/工具调用/diff/堆栈）。证据只以外置形式存在——metadata `source`/`evidence`/`provenance`、`archive/` 归档文件（`merged_archive` 边 36 条）、value 内的路径与日期锚点。→ L0 只能以「证据引用」表达，**不得伪造**原始事件。
2. **现有三层 ≠ L0–L7**：`lesson/reflection/experience` 共 94 条全部落在 L3，但其中 11 条同时内含 L2 叙事结构（触发/根因/修正/结果）。一条记录混合两个层级 → 蒸馏只能**拆分**，不能整条复制到多层。
3. **超长聚合体阻塞升层**：50 条超过实例层上限（>2000 字），多为「N 条经验合并」体。L4/L5 要求「项目范围 + 适用条件 + 反例」，这些字段在正文里没有结构化位置 → 需先拆分为原子观测。
4. **`skill:*` 是 Skill 文件镜像**：31 条 `skill:*` 条目正文写明「主源：<Skill 文件>」，权威源在 `skills/`。按本次约束，L6 只能是「技能知识候选 + 指针」，必须记 `mirror_of`，不得成为第二套 Skill 仓库。
5. **导航/索引不是知识**：7 条为纯导航页/加载包/记忆图谱，若机械按前缀归入 L4 会虚增高层覆盖率。
6. **非知识轴无法用 layer 表达**：14 条（identity/state/environment/preference）没有「抽象层级」语义。若强行按重要性升层，`user:persona` 会被误判为 L7 原则，污染原则集合与 10 条上限。→ 必须先有 `memory_category` 再谈 layer。
7. **已归档不等于已退出召回**：9 条带 `archived_at` 的记录仍在 `memory` 表内并被 FTS 索引，仅靠 key 前缀无法区分「有效」与「历史」→ 需 `status` 字段，且默认召回集合要按 status 过滤。
8. **置信度字段值域不一致**：现有 `confidence` 仅 1 条且取值为 `"High"`，`evidence_level` 用 E0–E4，`relevance_score` 用 0–1。→ 新字段必须固定值域，并保留旧值到 `legacy_confidence`。

## 5. Schema 与迁移风险

| # | 风险 | 证据 | 迁移要求 |
|---|---|---|---|
| R1 | `metadata` 是**整体替换**语义，写入会覆盖未声明的字段 | protocol.md §supersession 第 1 条明示「链记在 value，不记 metadata——易在下一次 set 时丢失」 | 迁移必须「读-合并-写」，禁止构造新 metadata 整体覆盖 |
| R2 | 直接 `UPDATE` 会改 `updated_at`，破坏 Relevance 的 recency 因子 | 217 条中 `updated_at` 最早 2026-08-03 | 保留原 `updated_at`，另记 `last_migrated_at` |
| R3 | `key` 是主键，衍生记录若沿用原 key 会覆盖原始数据 | `memory(key TEXT PRIMARY KEY)` | 衍生记录一律新 key；原条目只做「加字段」不改 value |
| R4 | FTS5 外部内容表依赖 rowid；`INSERT OR REPLACE` 会换 rowid 导致索引错位 | `memory_fts(content='memory', content_rowid='rowid')` + 三个触发器 | 禁止 REPLACE；只允许 UPDATE 或 INSERT 新 key |
| R5 | WAL 模式下裸 `cp` 备份不一致 | db 目录存在 `-wal`/`-shm`，服务（bun pid 8053）在用 | 用 `sqlite3 .backup` / `VACUUM INTO`，并校验可读 + 表计数 |
| R6 | 迁移期间双写冲突（MCP 服务仍在跑） | 服务常驻 127.0.0.1:3030，`stmtCache` 绑定单一连接 | 迁移用短事务 + `busy_timeout`；批次落进度；写后从服务侧读回校验 |
| R7 | `consolidated_from` 存在自引用，来源图不闭合 | 实测 2 条 self-reference | 迁移时清理自引用并记 `warning`，不静默丢弃 |
| R8 | 无 layer 列 → 若加表达式索引需 DDL | sqlite_master 仅 3 个常规索引 | DDL 仅在备份后执行，且可 `DROP INDEX` 回滚；非必需则不加 |

## 6. Phase 2 dry-run 计划与验收条件

**计划（只读产出，不写库）**

1. `distill.py --dry-run` 对 217 条逐条产出分层建议 JSON：`key / layer / category / scope / status / review_status / confidence / evidence_ids / layer_basis(rule+理由) / needs_review`。
2. 生成衍生记录预览（**新 key，不覆盖原条目**）：
   - L1 观测候选：从含 Episode 叙事的 11 条中抽取原子事实（`obs:<slug>`，1 条 1 事实）
   - L2 Episode 候选：按「同一任务 + 同一日期 + 同一项目」聚合观测（`episode:<project>:<date>:<slug>`）
   - L3→L4 候选：仅对已有 ≥3 条独立任务证据 + 明确项目范围的条目提出（当前 L4 白名单 = `project:*`/`rule:*` 已确认项）
   - L5/L6/L7 候选：**只列候选 + 证据矩阵**，标 `review_status=pending`，不发布
3. 去重/合并候选：本次实测精确重复 0 组、近似 5 对 → 只出建议，不动数据。
4. 冲突清单：`content:conflict-marker` 15 条与其他近邻条目两两对照，输出「冲突对 + 各自证据」，不合并。
5. 输出 dry-run 预览（JSON + MD）+ 变更差异 diff，逐条给出「新增/更新/跳级/待审」，并打印预计写入条数与受影响原条目数。

**dry-run 验收条件（全部满足才允许 Phase 3）**

- 运行前后 `memory` 表行数、`value` 哈希集合、`updated_at` 分布**完全一致**（等价于断言零副作用）。
- 每条衍生候选都有 `layer_basis` + 至少 1 个 `evidence_ids`，或显式 `needs_review=true` + 缺失原因。
- L2 聚合不跨项目、不跨任务；近似重复对中没有被自动合并的条目。
- L5 候选必须列出 ≥2 个项目来源；不足者降为「项目内 L4」或待验证候选。
- L6 候选必须含：目标/前置条件/输入/步骤/验收/失败处理/来源经验；缺项不进候选集。
- L7 候选 ≤10 条且每条有反例与来源；超限时输出「合并/替换/淘汰」建议而非覆盖。
- 报告中的数量与 JSON 明细逐项对账（同一脚本产出，禁止手填）。

## 7. 分层抽检样本


| key | 建议层 | 类别 | 字符 | 来源锚点 | 待审 | 抽检理由 |
|---|---|---|---|---|---|---|
| `reference:memory-navigation` | — | navigation | 11260 | 是 | 否 | stratified:navigation/None, fill:largest |
| `project:jtkl-mgmt-module-pool` | L4 | knowledge | 8452 | 是 | 否 | stratified:knowledge/L4, fill:largest |
| `project:jtkl-modules` | L4 | knowledge | 8080 | 是 | 否 | fill:largest |
| `project:jtkl-module-compress` | L4 | knowledge | 7338 | 是 | 否 | fill:largest |
| `project:webbas-engine-overview` | L4 | knowledge | 5904 | 是 | 否 | fill:largest |
| `project:jtkl-module-tuning-template` | L4 | knowledge | 5823 | 是 | 否 | fill:largest |
| `project:delx-memory-web-overview` | L4 | knowledge | 4884 | 是 | 否 | fill:largest |
| `skill:learning/memory:query-router` | L6 | knowledge | 4707 | 是 | 是 | stratified:knowledge/L6 |
| `agent:vc_constraints` | — | navigation | 3193 | 是 | 否 | edge:oversize |
| `lesson:skill-edit-date-residue` | L3 | knowledge | 3011 | 是 | 是 | stratified:knowledge/L3 |
| `tooling:image-understanding` | — | environment | 2252 | 是 | 否 | stratified:environment/None |
| `pattern:memory-writeback-integrity` | L5 | knowledge | 1966 | 是 | 是 | stratified:knowledge/L5 |
| `experience:delx-memory-runtime-memory` | L3 | knowledge | 1837 | 是 | 是 | edge:needs-review, edge:archived |
| `skill:system:metrics` | — | state | 1779 | 否 | 是 | stratified:state/None, edge:no-scope |
| `preference:user:online-doc-tool` | — | preference | 1016 | 是 | 否 | stratified:preference/None |
| `principle:verify-before-claim` | L7 | knowledge | 999 | 是 | 是 | stratified:knowledge/L7 |
| `user:persona` | — | identity | 971 | 否 | 否 | stratified:identity/None |
| `lesson:ffi-crate-api-drift` | L3 | knowledge | 644 | 是 | 否 | edge:conflict-marker |
| `env:system` | — | environment | 264 | 是 | 否 | edge:zero-access-old |
| `global:dev-style-rule` | L4 | knowledge | 41 | 否 | 否 | edge:no-source |

