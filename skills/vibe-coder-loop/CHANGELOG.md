# vibe-coder-loop Changelog

> **迭代历史唯一事实源**（rule:skill-iteration-manifest 规则 1）。版本号唯一事实源 = manifest.yaml `version` 字段。
> 规则：技能文件正文禁止日期/版本备注；变更记录一律追加到本文件（格式 `## vX.Y — 标题`）。
> 版本策略（用户指令）：**未提交 git 期间版本号保持不变**——同版本内可含多个批次，改动多少次都不迭代；提交后才递增下一版本。

## v1.22.1 — 第二轮评审修复（D1–D9，同版本第四批）

> **同版本第四批**（未提交 git，版本不迭代）。**触发**：`skill-evaluation/evaluation-report-2026-10-20-r2.md` 第二轮独立复评发现的 D1–D9。本批修复了 D1（标准 Loop 起点与预算）、D2（空规则库 fail-open）、D3–D8（规则一致性、profile、README、记忆路由、6b 文案、文档漂移）、D9.1–D9.2（协议门禁与 smoke 4b 输出）。D9.3（遗留 `skills/vibe-coder-loop/.state.md` 本地实例）按资产生命周期不物理删除，保持 gitignore + 不引用；D9.4 预算若超限则上调并记明理由（见末尾验证）。

| # | 缺陷 | 修复 | 落点 |
|---|---|---|---|
| 1 | D1 标准 Loop 从 0 开始、实际 4 轮 | 新增 `S7→S8: init_if_zero`（首次进 Code=1，Case B 保持 N+1）；机器块加 `(loop=init)`；`check-protocol` 增加 S7→S8 初始化校验；新增 3 个回归测试 | `runtime/core/state_machine.py`、`runtime/core/protocol.py`、`engine/transition.md`、`tests/core/` |
| 2 | D2 空规则库 preflight rc0 fail-open | `preflight` 在 `skill:rules/*` 为 0 且非 `--files` 时输出 `[RULE_STORE_MISSING]` + rc3；`--files` 应急路径仍允许 | `backup/memory_tool.py`、`backup/test_memory_tool.py` |
| 3 | D2 11 处“检索失败降级”与 fail-closed 冲突 | 类型 C 骨架文件改为 fail-closed 措辞；`retrieval.md`（文件 canonical）澄清“不存在摘要降级” | `references/*.md`、`rules/*.md`、`learning/*.md` |
| 4 | D3 Quick Loop 重试三方矛盾 | `kernel.md` §7 改为“S9 失败不回退 Code，建议升级”，与 `rules/test.md` 与 `loop_max=1` 一致 | `kernel.md` |
| 5 | D4 README 快速开始命令不可执行 | `verify <快照路径>`；key 校验改用 `smoke-check.sh --table`（4b）；“加密快照”改为 gzip/JSON（未加密） | `README.md` |
| 6 | D5 profile 必读清单缺口 | review/debugging/coding/planning/refactoring/skill-maintenance 补齐 S1/S8/S10/S12 必读 | `profiles/*.md` |
| 7 | D6 记忆路由精确 key vs memory_search 矛盾 | 散文改为“已知 key 用 memory_get，经验域用 memory_search，均最小充分” | `learning/memory/retrieval.md`、`engine/transition.md` |
| 8 | D7 smoke 6b 虚假 freshness 声明 | 文案改为“含 updated_at 字段；freshness 由 load-checkpoint 判定”；Case B 记号澄清 | `smoke-check-core.sh`、`engine/transition.md`、`engine/state-machine.md` |
| 9 | D8 文档漂移（Core/Exec 未实现、未跟踪、加密） | residual-risks / change-list / README 修正现状；2026-10-19 报告加历史快照说明 | `docs/audits/*`、`README.md` |
| 10 | D9.1 协议门禁盲区 | `check-protocol` 增加 S7→S8 初始化校验 + 回归测试 | `runtime/core/protocol.py`、`tests/core/` |
| 11 | D9.2 smoke 4b `MISSING\t` 前缀 | 解析 `MISSING`/`NOT_PERMANENT` 前缀，输出分类原因 | `skill-authoring/scripts/smoke-check-core.sh` |
| 12 | D9.5 exec 非权限沙箱未声明 | README 安全与隐私补一句“exec 是防手滑，不是权限沙箱” | `README.md` |

**验证**：见文末「第二轮评审修复回执」与 `skill-evaluation/evaluation-report-2026-10-20-r2.md` §修复回执。

## v1.22.1 — 设计收敛补丁（`.state.md` 迁出 + 机器可读契约）

> **同版本第二批**（未提交 git，版本不迭代）。**触发**：对 `docs/design/` 三份 MVP 设计做 P0 级评审，发现 6 项会导致实现跑偏的硬缺陷；其中两项**必须改协议文件**才能闭环，故本批次落 Skill 侧最小增补。核心判别：**运行时状态不属于 Skill 安装目录**，**副本必须被机械校验**。

### 一、状态文件迁出 Skill 目录（原设计自相矛盾）

| # | 变更 | 落点 |
|---|---|---|
| 1 | 运行实例位置 `<skill>/.state.md` → `<project_root>/.vibe-kernel/.state.md`；**文件名不变**，减少数十处引用的改名面 | `engine/state-machine.md`「Workflow Checkpoint」 |
| 2 | 补**位置解析顺序**（`--state-dir` → `VIBE_KERNEL_STATE_DIR` → 项目 config → 缺省）与 `project_root` 判定（显式 cwd，或向上首个含 `.git`/`.vibe-kernel`/`pyproject.toml`/`package.json`/`go.mod` 的目录） | 同上 |
| 3 | 补**隔离规则**：每项目 / 每 worktree 各一份；`realpath` 归一（软链同目录 = 同项目）；解析结果落在 Skill 安装目录内 → **拒绝写入**（fail-closed，防多项目互相覆盖） | 同上 |
| 4 | `SKILL.md` 加载时机索引与 `load_plan.json` `_core_note` 指向新位置（防旧口径回流） | `SKILL.md` / `load_plan.json` |

### 二、机器可读契约（防「协议更新、代码用旧表」）

| # | 变更 | 落点 |
|---|---|---|
| 5 | 新增「机器可读转移表」节：`<!-- vc:transitions v1 -->` 块，含 28 条边 + Loop 修饰符（`(+1)` / `(loop=0)` / `(loop=1)` / `(resume)` / `(a/b)` 允许集），供 `check-protocol` 逐边 + 修饰符比对 | `engine/transition.md` |
| 6 | 块内修正两处与状态转移图不一致的边：**`S14 → S13 \| RESUME`**（原设计误写 `S14 → S0/S1`；`kernel.md` §1 明确「维持原 Loop N 继续」）；**补 `S10 → S7`**（Investigation 分支「情况 A 回 S7[N+1] / 情况 B 回 S7[0]」） | 同上 |
| 7 | 明确 `S10 → S6(+1)` 的递增**只发生一次**，`S6→S7→S8` 继承同一 `N+1`（消除"重设计后回 S8 同轮"的歧义） | 同上 |
| 8 | 新增「保留键」表：`_schema`（真实键，非顶部注释）/ `_rev` / `_project_id` / `_resume_from` + 子键 `review.failure_state`；**不计入 13 字段**；`_schema` 超前 → 只读降级 | `engine/state-machine.md` |
| 9 | 新增三条兼容硬约束：**未知键必须原样保留** / 高版本只读 / 保留键缺失按缺省（不判损坏） | 同上 |
| 10 | 新增「语法（机器读取口径）」：受限 YAML 子集（块映射/块序列/引号标量/`\|`/`#`），**不支持**锚点别名·流式集合·多文档；写端字符串标量一律加引号；三层降级（严格 → 仅扁平标量 → `corrupt` 备份） | 同上 |
| 11 | 新增「写入方式（机器端）」：临时文件 + `fsync` + `os.replace`；跨平台锁；`expected_rev` 不匹配即冲突**不覆盖**（锁只保证串行，版本号才防「基于旧状态覆盖」） | 同上 |

### 三、pending 核验改三态（修「文件存在 = 完成」误判）

| # | 变更 | 落点 |
|---|---|---|
| 12 | 恢复协议第 5 步：`verified`（强证据：内容哈希 / 本轮起点后有新提交 / 声明的验证命令跑通）→ 移 `completed`；`unverified`（仅"存在"或"mtime 较新"这类**弱证据**）→ **不得**移；`still_pending` → 保留待人工确认。口径明写「**文件存在 ≠ 任务完成**」 | `engine/state-machine.md` 恢复协议 |

### 四、运行时扩展码登记（防与工作流码混淆）

| # | 变更 | 落点 |
|---|---|---|
| 13 | 「VC 错误码族」新增**运行时扩展码**表（12 个），一律带 `[runtime]` 前缀、同守「不带 `[next]` 不构成错误码」与 fail-closed 铁律；**声明不改变既有码语义** | `engine/transition.md` |
| 14 | 其中 `STATE_ILLEGAL_TRANSITION` 明确**不复用** `RULE_NOT_LOADED`——后者语义是「阶段必读文件未加载」，借用会把 LLM 的 `[next]` 动作引错（去加载文件而不是回退阶段） | 同上 |
| 15 | 登记 `CHECKPOINT_LOCATION_UNRESOLVED` / `_FOREIGN` / `_STALE` / `_DEGRADED` / `_CORRUPT` / `_SCHEMA_AHEAD` / `_WRITE_FAILED` / `PROTOCOL_DRIFT` / `PHASE_TRANSITION_MISSING` / `STATE_REV_CONFLICT` / `EXIT_CHECKLIST_INCOMPLETE` | 同上 |

### 五、模板与配套

| # | 变更 | 落点 |
|---|---|---|
| 16 | 模板新增 `_schema: 1`；注释改为项目本地路径 + 保留键清单 + 字符串引号纪律 | `.state.template.md` |
| 17 | 设计文档同步（6 项 P0 + 专项）：状态机单一事实源校验、Loop 按 Level 分档（L0/L1=1，L2+=3）、Safe Mode 收窄为确定性触发、Exec 流式有界 + 整树终止、指纹 sha256 规范化 + 连续计数持久化、artifact 分 `ephemeral`/`pinned`、Hook 事实按 `@opencode-ai/plugin@1.15.4` 类型定义修正、新会话恢复走 `chat.system.transform` | `docs/design/` 五份 |

**验证**：`transition.md` 机器块与设计文档 `LEGAL_TRANSITIONS` 交叉比对 **28 边 / 28 边，修饰符 7 条，CONSISTENT**；`.state.template.md` 经 `yaml.safe_load` 解析为单文档 14 键（13 语义 + `_schema`）；`load_plan.json` JSON 合法；全仓代码围栏配平。

**未验证（不宣称）**：`check-protocol` 与 `core state check` 尚未实现，当前只有契约没有门禁；OpenCode 三条 Hook 仅在类型定义层确认，真机行为待 Phase 3 冒烟（A3/B2）。

## v1.22.1 — 体系评审缺陷修复（D1–D10 / P1–P8）

> **同版本第三批**（未提交 git，版本不迭代）。**触发**：`skill-evaluation/evaluation-report-2026-10-20.md` 的 P1–P8 候选，逐项落地。**定位决策（用户指令）**：本仓库配套的规则集为**私有规则集**——不改造成公开最小规则集，改为把定位写清并让 fail-closed 行为可预期。

### 一、状态泄漏（D1 / P1）

| # | 变更 | 落点 |
|---|---|---|
| 1 | `.gitignore` 增 `.vibe-kernel/`（协议声明位置整体忽略），旧 `skills/vibe-coder-loop/.state.md` 降级为遗留条目保留 | `.gitignore` |
| 2 | 新增 **C012** 机检：「协议声明的运行状态路径必须被 gitignore」——`git check-ignore .vibe-kernel/.state.md` 非 0 即 high 退出 1，防止协议改路径而 `.gitignore` 不跟随 | `scripts/audit.sh` `check_runtime_state_ignored` |
| 3 | C012 自测：无 `.gitignore` → 命中；写入 `.vibe-kernel/` → 不报 | `scripts/tests/test-audit.sh`（49 → 51 PASS） |

### 二、fresh clone 失败（D2 / P2，定位 = 私有规则集）

| # | 变更 | 落点 |
|---|---|---|
| 4 | README 首屏新增「定位（先读）」：框架开源、**规则集私有**、fresh clone **不是开箱即用**，未恢复规则库时 fail-closed 属预期 | `README.md` |
| 5 | 快速开始新增第 3 步「恢复私有规则集」（`restore` → `verify` → `check-keys`），验证步骤顺延为 4 | `README.md` |
| 6 | `required: [rule_store]`；`optional_integrations` 语义收窄为**规则库之外**的能力（记忆后端/CodeGraph/skill-authoring），不再暗示规则可缺失 | `manifest.yaml` |
| 7 | 依赖表述三处对齐：安装文档「可选集成」→「依赖与可选集成」、排障条目改为「fail-closed 预期结果」、兼容矩阵拆出「规则库必填」行 | `docs/installation.md` / `docs/audits/compatibility.md` |
| 8 | SKILL.md 补一句：规则库缺失时 `smoke-check` 以 `MAP_INCONSISTENT` rc=1 退出，**属预期** | `SKILL.md` |

### 三、自检路径与指令冲突（D3 / D4）

| # | 变更 | 落点 |
|---|---|---|
| 9 | 6b 校验对象改为**随仓库分发的** `.state.template.md`（13 字段契约锚点）——fresh clone 不再静默跳过；需校验真实实例时传 `VIBE_CHECKPOINT_FILE=<绝对路径>` | `scripts/smoke-check.sh` |
| 10 | core 6b 增「指定文件不存在 → 打印跳过原因，不计为通过」分支；`CHECKPOINT_FILE` 支持绝对路径 | `skill-authoring/scripts/smoke-check-core.sh` |
| 11 | `AUTO_MODE` 收窄为「仅可逆、非破坏性操作免确认」，并明写不可逆操作/低置信判断仍须 Conflict Card 或暂停（R0 优先） | `kernel/Vibe Coder.md` |

### 四、阶段漏读与命令路径（D5 / D6）

| # | 变更 | 落点 |
|---|---|---|
| 12 | `coding` / `debugging` / `skill-maintenance` / `planning` / `review` 的 Required 补齐 S4 必读 `engine/complexity-gate.md` + `engine/router.md`（`refactoring` 原已具备）；`planning` 的 Optional 重复项移除 | `profiles/*.md` |
| 13 | S13 收尾命令补明 cwd：`bash scripts/smoke-check.sh --table`（cwd = Skill 根）/ 仓库根写法二选一 | `profiles/skill-maintenance.md` |

### 五、预算、文档漂移（D7–D10 / P7 / P8）

| # | 变更 | 落点 |
|---|---|---|
| 14 | **总行数预算 3800 → 3900（棘轮例外，理由）**：本轮为修 D1/D5 净增行（profile 必读、SKILL/manifest 措辞），且 3870 已超旧预算；经核算规则文件实测 3871 行，取 3900 作**新下限**——后续只降不升，再需上调须在本节追加理由 | `scripts/smoke-check.sh` |
| 15 | README 结构树补 `runtime/` `tests/` `scripts/tests/`，并注明 Skill 内部分层；`scripts/` 描述与 C012 对齐 | `README.md` |
| 16 | 测试计数同步（`test_memory_tool` 51 → **55**、`test-audit` 43 → **51**） | `docs/audits/change-list.md` / `docs/audits/residual-risks.md` |
| 17 | Checkpoint 字段口径统一为 **13 项（含 `updated_at`）**，路径统一为 `<project_root>/.vibe-kernel/.state.md` | `engine/transition.md` / `engine/state-machine.md` |

**验证（E4）**：`smoke-check.sh` rc=0（本机，规则 3871 行 / 预算 3900）；`DELX_MEMORY_DB=/tmp/nonexistent` 下 rc=1 且 **6b 仍通过**（模板锚点不再依赖本机实例）；`audit.sh check` rc=0 含 C012；`test-audit.sh` 51/51；`test_memory_tool.py` 55/55；`git check-ignore .vibe-kernel/.state.md` rc=0。

**未验证（不宣称）**：真 fresh clone（临时 HOME + 干净 DB）未实跑——规则库必填，无法在无私有快照的机器上得到 rc=0；跨平台（Linux/Windows）未真机复跑。

## v1.22.1 — 加载计划按阶段裁剪（preflight 瘦身 + stage→section 映射）

> 提交 v1.22.0（4300e81）后递增。**触发**：对 v1.22.0 做收益评估，实测发现**保守档反而净增 7~8%** —— `preflight` 自身输出 L1 5,301 / L2 6,760 字符（章节索引占其约六成），超过它带来的节省；且"机械可定位"只覆盖 1 个文件（`engine/transition.md`，因只有它的 H2 标题自带阶段号）。本轮按评估结论实施两项：**① 输出瘦身 ② stage→section 映射**。

### 一、preflight 输出瘦身

| # | 变更 | 落点 |
|---|---|---|
| 1 | 新增 `index_min_lines`（120）：整文件仅在 ≥120 行时输出章节索引 —— 小文件直接整读（**索引本身也是上下文成本**） | `load_plan.json` |
| 2 | 章节索引行**限长**（260 字符，超长显式报 `[OUTPUT_LIMIT]`）；命中节列表限长 200 字符 | `backup/memory_tool.py` |
| 3 | 成本行改为**双口径对比**：`整文件口径 N 行/字符 → 按阶段命中 M 行/字符（省 X%）`；并给出「命中占比（占全量规则）」 | 同上 |
| 4 | 输出体量实测（回修后口径）：**5,301 → 3,032（L1，−43%）/ 6,760 → 3,735（L2，−45%）** | 实测 |

### 二、stage→section 映射（按阶段裁剪章节）

| # | 变更 | 落点 |
|---|---|---|
| 5 | `load_plan.json` 新增 `level_stages`（Level→阶段集，机器副本）与 `stage_sections`（**阶段 → 章节标题子串**，13 个文件 / 44 个匹配串）。**只存标题子串不存行号** → 零漂移 | `load_plan.json` |
| 6 | `engine/transition.md` **不进映射表**：其 H2 标题自带阶段号，由代码按 `S<n>` 机械匹配 + `VC 错误码族` 恒含（每阶段出口都可能用到） | `backup/memory_tool.py` |
| 7 | 新增 `always_whole`（`kernel.md`）：**R0 宪法层永不按节裁剪** —— 安全红线不冒漏读风险 | `load_plan.json` |
| 8 | **fail-safe**：某已映射阶段的子串全部命中不到真实章节 → 该文件**回退整文件**（宁可多读，不静默漏读）。实测该机制当场挡住一处写错的匹配串 | `backup/memory_tool.py` |
| 9 | 新增 `preflight --stage` 阶段集收窄：`S8,S9` = 只保留所列；`^S3` = **从默认集排除**（S1 冲突预检无冲突时用，免手抄全清单——手抄漏 S13 = 静默裁掉收尾义务）；token 校验 S1–S13（拒 S99/S08/8），非法 `[INVALID_ARGUMENT]` exit 3；列举法收窄显式提示被裁掉的默认阶段 | 同上 |
| 10 | `S13` 补入各 Level 阶段集（收尾清单每轮执行，漏掉 = **静默跳过收尾义务**）；三副本同步：complexity-gate 矩阵补 S13 行 + manifest stages 全量补齐；L0/L0-doc 补 **S10**（其「文档子集 4 项」内联检查需载入 safety.md §5，见回修 #16） | `load_plan.json` + `engine/complexity-gate.md` + `manifest.yaml` |
| 11 | 自检新增 **`LOAD_PLAN_PATTERN_MISS`（HARD）**：`stage_sections` 每个匹配串必须命中该文件的真实 H2 标题 —— 改名后即死指针（运行时虽有 fail-safe，但静默降级会把"按阶段裁剪"悄悄变成"整文件读"） | `skill-authoring/scripts/smoke-check-core.sh` |

### 三、实测收益（对比改造前基线）

| 场景 | 改造前 | 本轮后 | 净变化 |
|---|---|---|---|
| Quick Loop L1（debugging） | 70,171 字符 | 58,473 + 3,032 = **61,505** | **−12%** |
| Standard Loop L2（coding，21 文件） | 95,727 字符 | 84,033 + 3,735 = **87,768** | **−8%** |
| L2 且**冲突预检无冲突**（`--stage ^S3`） | 95,727 | 77,098 + 3,665 = **80,763** | **−16%** |
| L2 循环中单阶段重读（`--stage S8`） | 95,727 | 70,064 + 3,874 = **73,938** | **−23%** |
| Level 0 文档任务（S10 文档子集随阶段集载入，见回修 #16） | 63,161 | 50,017 + 2,777 = **52,794** | **−16%** |
| 对照：v1.22.0 同口径（整文件 + 旧 preflight） | 75,472 / 102,487（**净增 +7.6% / +7.1%**） | 61,505 / 87,768 | 相对上版 **−18% / −14%** |

> **最终态订正（#53 / #66 / #71）**：上表为第二轮回修时点的实测（保留原样，不改写已推送条目）。经第三～六轮审查回修与授权项后，**最终态**（最后一次规则文本编辑之后实测，四舍五入）为 ——
> L0 `63,325 → 50,893 + 3,038 =` **53,931（−15%）**｜L1 `70,790 → 59,729 + 3,293 =` **63,022（−11%）**｜L2 `96,142 → 86,127 + 4,132 =` **90,259（−6%）**｜L2 `^S3` **83,254（−13%）**｜L2 `S8` **74,650（−22%）**｜**L3 `105,880 → 95,436 + 4,602 = 100,038（−6%）`**。
> 对照 v1.22.0 同口径（同文件内容整文件 + 旧 preflight 5,301 / 6,760）：`76,091 / 102,902`（净增 +7.5% / +7.0%）→ 相对上版 **−17% / −12%**。preflight 输出：3,293（L1）/ 4,132（L2）。
> **口径**：绝对值随规则文本每轮微调而漂移（本轮 L2/L3 因 promotion 单源化再降 ~200 字符，比率随之 +0.1pp），比率结论稳健；取整一律四舍五入。

> **仍未节省的部分（据实标注）**：`kernel.md`（202 行，整文件）、以及被多数阶段共同需要的文件（`engine/state-machine.md` 仅省 6%、`engine/transition.md` 省 6%——Standard Loop 覆盖 S1–S13 故并集接近全文）。**stage 并集越大，裁剪收益越小**，这是机制的内生边界，不虚报。

### 四、验证

| # | 项 | 结果 |
|---|---|---|
| 12 | `test_memory_tool.py` 新增 3 用例（索引阈值抑制 / `--stage` 覆盖 / 映射失效 fail-safe）+ 改 fixture 覆盖新路径；审查回修再 +8 用例（见五） | 初版 37/37 → 回修后 **45/45 PASS** |
| 13 | 负向测试：注入 2 处坏匹配串 → `LOAD_PLAN_PATTERN_MISS` 全部捕获（EXIT=1）；`stage_sections` 44 串全量校验 0 漏 | 通过 |
| 14 | 两技能 smoke-check `--table` HARD 0 / 退出码 0；模板未配置 exit 3；`.state.md` 单文档可解析 | 通过 |
| 15 | 版本 | 1.22.0 → **1.22.1**（patch：同机制内的输出瘦身与映射细化。**含轻量接口面变化**——新增 `preflight --stage` 形参、输出布局调整（命中节行 + 双口径成本行）；无阶段/安全/回写流程变更） |

### 五、独立审查回修（Builder ≠ Critic：fresh-context 审查判 FAIL → 照单修复）

> 同版本内第二批（版本策略允许）。独立 Critic 实测复现后判定 **FAIL**（P0×1 / P1×7 / P2×12），全部回修；审查期间 `load_plan.json` 负向测试已 md5 比对还原，仓库零污染。

| # | finding（严重度） | 修复 |
|---|---|---|
| 16 | **[P0·欠读]** L0/L0-doc 阶段集缺 S10 →「Level 0 文档修改约束子集」（safety.md §5 内）只挂 S3 而 L0 不跑 S3，**L0 文档任务整轮不载入 R1 级检查表** | `level_stages` 0/0-doc 补 S10；§5 挂 S8+S10（出口内联检查逐字引用该子集）；§6（主 agent S10 逐项复核子 agent 产出）挂 S10 |
| 17 | [欠读] evolution「核心原则/演化流程/经验类型分类」、reflection「降级条款」、lifecycle「Quick Loop 记忆闭环」无任何阶段映射 → S11/S12/S13 相关节静默不载 | 全部补入对应阶段；lifecycle S13 加「记忆生命周期管理」（回写契约自足） |
| 18 | [P1] `--stage` 无校验：S99/S08/8 → transition.md 机械分支静默砍到 34 行（−86% 无提示） | token 校验 S1–S13 + 拒前导零 + `[INVALID_ARGUMENT]` exit 3；机械分支**仅命中 VC 节 → 回退整文件** |
| 19 | [P1] 手抄全清单收窄易漏 S13（= 静默裁掉收尾义务）；去 S3 后恢复路径未文档化 | `^S3` 排除语法；列举法收窄显式提示被裁默认阶段（漏 S13 点名）；SKILL.md 写明恢复路径（重跑 preflight 补回该阶段） |
| 20 | [P1] SKILL.md 三处整文件读法互相矛盾（两段式读 vs 读取粒度表 vs 分级加载） | 优先级声明：**怎么读以「读取粒度」表为准**；**哪些文件进上下文取分级加载∪加载时机索引**；kernel.md（always_whole）与子 agent 四件套例外必须整读 |
| 21 | [P1] 收益数字口径不实：L1 基线误用 6,760（实为 5,301，57% 应为 45%）；「净增 4~5%」实为 +7.6%/+7.1%；对照行 73,101/101,270 不可复现 | 全部按实测重述；收益表按回修后映射重测（上方三/四节已订正） |
| 22 | [P1] 章节索引超长截断不报 `[OUTPUT_LIMIT]`（命中节分支报、索引分支不报，同文件行为不一致） | 补报（与命中节分支一致） |
| 23 | [P2] S13 三副本不一致（矩阵无行 / manifest 全缺 / load_plan 有）；L0 S10 同病 | matrix 补 S13 行；manifest 0–4 全补 S13、L0 补 S10；三副本一致 |
| 24 | [P2] 死配置 `read_whole_below_lines`（0 代码消费者）+ `whole_below` 死变量；`always_read`（上轮删除）未记录 | 配置键 + 变量删除；两项删除补记于此 |
| 25 | [P2] `--files` 模式阶段行误归因 level_stages；`hit_chars` 线性折算未声明；smoke-check core 空映射假 ✓ + 违规行号恒 0；阈值测试无区分力 | 归因分模式；成本行标注「字符按行占比折算」；core 空映射显式「跳过」+ 违规报**真实行号**；阈值双向断言（90 行文件 + 阈值 120→50 必须翻转） |
| 26 | [P2] 章节级映射无覆盖度机械判定（结构性新增/改名可静默漏载） | 新增 `_unmapped_ok` 白名单（16 条含理由）+ 单测 #35：被映射文件每个 H2 须命中映射或显式白名单；**白名单条目失效同样报错**（防僵尸白名单） |

### 六、回修后验证

| # | 项 | 结果 |
|---|---|---|
| 27 | 单测 37 → **45**（+8：token 校验 / 排除语法 / 收窄提示 / 索引截断报限长 / **L0 子集回归（P0 防线）** / --files 归因 / transition fail-safe / 真实计划覆盖度+白名单） | **45/45 PASS** |
| 28 | 负向注入坏匹配串 → `[LOAD_PLAN_PATTERN_MISS]` 报**真实行号**（load_plan.json:286）、HARD exit 1；`load_plan.json` md5 还原一致 | 通过 |
| 29 | P0 通电：`--level 0` 阶段集 = S1 S2 S4 S8 **S10** S13，safety.md 命中含 §5（L134-155，子集所在）；`--stage S99` 现场 `[INVALID_ARGUMENT]` | 通过 |

### 七、pending 机制化收口（同批次）

| # | 变更 | 落点 |
|---|---|---|
| 30 | **死指针裁定收口**：候选白名单改**内容精确匹配**（`DEAD_PTR_KNOWN`，去首尾空白后整行比对）——行内容一经修改即重新成为候选。既消除每轮的稳定噪音，又不牺牲回归可见性（原「维持逐条裁决」的顾虑即在此被消解） | `smoke-check-core.sh` + `scripts/smoke-check.sh` + `profiles/skill-maintenance.md` |
| 31 | **「跨层结构变更 → 独立审查」升为 S10 硬项**：变更落在规则层/脚本层/加载计划/协议层（`rules/` `engine/` `policy/` `load_plan.json` `scripts/` `backup/*.py` `manifest.yaml`）或跨技能时，必须派 fresh-context subagent，**不得以自测全绿替代**（自测与 Builder 盲区同源）；派发失败须标注降级。依据：v1.22.0 抓 2×P0、v1.22.1 抓 1×P0，全部在自测全绿下存活 | `rules/review.md` 前置门控 |
| 32 | 验证（收口批次） | 单测 45/45 PASS；vcl smoke-check 死指针候选 **0**（已知合法白名单 1 处）；双技能 HARD 0 / exit 0；模板 exit 3 |

### 八、第三轮独立审查回修（PASS-with-findings · 用户指令下发）

> S10 硬项（#31）首次执行。审查独立通电验证 P0 修复有效、独立复现核心数字、做 8 项变异测试。**无存活 P0**；P1×4 / P2×11 / LOW×2，全部在本轮处理。

| # | finding（严重度） | 修复 |
|---|---|---|
| 33 | 白名单硬化 + **僵尸条目检测**：`DEAD_PTR_KNOWN` 键改 `./<文件>::<整行内容>` 双精确（跨文件复用不继承豁免，实测成立）；条目命中不到任何文件行 → HARD `STRUCTURAL_INCONSISTENT`（与 `_unmapped_ok` 僵尸检测对称，堵住「白名单失效只表现为候选重现、而候选非 HARD」的静默通道） | `smoke-check-core.sh` + wrapper + profile |
| 34 | 审查同时证明 HEAD 态白名单**真洞**：同内容复制到 `rules/code.md` 时豁免被继承 → #33 修的是真缺陷（非风格） | 同上 |
| 35 | [P1·欠读·**本批次引入**] `promotion.md`「Pattern Fingerprint 算法」被误判为「系统职责内部算法」入白名单——实为 **S11 必用**（Reflection Card 强制填指纹；节内自述「由 Agent 执行」；S12 去重协议 Step 1 引用）→ 补 S11+S12 映射、撤白名单 | `load_plan.json` |
| 36 | [P1·**防线缺口**] 变异实测：删 `level_stages[0].S10` 或 `safety.md` 的 `S10→§5`（= P0 根因/修复本身）时 45 用例 + smoke-check **全绿** → 新增真实产物断言（各 Level ⊇ S13、L0/L0-doc ⊇ S10、`safety.md S10→§5`、manifest↔level_stages 逐 Level 等价、矩阵 S13 行 + S10 行 L0 列）；**复测：三处变异全部 FAIL**（防线有效） | `test_memory_tool.py` |
| 37 | [P1] `--level` 零校验：拼错（`5`/`banana`/`-1`）静默关闭**全部**按阶段裁剪且 exit 0 → 与 `--stage` 同策略 fail closed `[INVALID_ARGUMENT]` exit 3 | `backup/memory_tool.py` |
| 38 | [P1] fail-safe 对「部分匹配」不闭合：某阶段**部分**子串未命中时静默丢节（实测：改名单个映射节 → 命中集静默少 20 行、无任何提示）→ 改**逐子串**判定（任一未命中 → 该文件回退整文件），与文档「宁可多读不漏读」对齐 | 同上 |
| 39 | [P2] `advanced.md` 三重矛盾（自述「按需分片、**不属于 S12 默认加载路径**」+ SKILL.md 门控 vs 本批次给它加的 S12 节级裁剪 + 悬空引用）→ 撤其 `stage_sections` 条目（回退整文件，是否读由 SKILL.md 触发门控决定） | `load_plan.json` |
| 40 | [P2] `skill-metrics.md`「核心机制」被误白名单化（实含 **S10 早期预警阈值** + `avg_loops` 默认值 2.0 + 仪表盘异常阈值）→ 补 S10+S13 映射、撤白名单 | 同上 |
| 41 | [P2] `resolve_stages` 边界四处：`^S13` 不点名收尾义务（与列举法不对称）/ 无效排除（S3 不在 L0 默认集）报成「排除成功」/ 空 token（如 `,`）静默降全整文件且归因错 / 排除分支未排序 → 全部修正 | `backup/memory_tool.py` |
| 42 | [P2] 前言（首个 H2 之前）在 partial 模式永不载入（12 文件）→ preflight 输出**显式标注**前言未列入（实际文案列文件名、不含行范围——#60 订正描述）；**不自动载入**（实测自动载入侵蚀收益约 4–6%，取舍见 `.state.md` D17） | 同上 |
| 43 | [P2] 本文件数字订正（审查实测）：`13 文件 / 44 匹配串` → **12 文件 / 唯一串 67（含阶段重复 112）**（#66 再订正）；四行 `hit_chars` 因批次内 `rules/review.md` 增长未复测 → 收益表全部按**最终态**重测；#28 的「行号 286」不可复现 → 撤回为可复现表述 | 本文件 |
| 44 | [P2/LOW] 记录面澄清：`KNOWN_STAGE_MAX=13` vs manifest `S14: safe-mode`（注释说明 S14 为止血档、无 sections、拒绝正确）；`0-doc` 在 manifest 无独立条目（合法变体，注明）；三副本 S3/S11「条件触发」在机器副本中的落法写入 `_note` | `memory_tool.py` + `load_plan.json` |
| 45 | 验证（第三轮） | 单测 **48/48 PASS**；三处防线变异全部 FAIL（防线有效）；双技能 smoke-check HARD 0 / exit 0；模板 exit 3；死指针候选 0（白名单 1 处，含僵尸检测）；3759/3800 |

### 九、第四轮独立审查回修（PASS-with-findings · Loop 3 内收口）

> 审查独立复现全部收益数字、对 12 文件做 108 条映射串全枚举（0 miss）、做 7 项变异测试。**无存活 P0**；2×P1 均为本轮引入。**Loop 已达 kernel §7 上限 3**：本轮只收 P1 + 高价值 P2，其余显式延后（见 `.state.md` pending）。

| # | finding（严重度） | 修复 |
|---|---|---|
| 46 | [P1·**静默欠读**] `--level` fail-closed 的键集取原始键 → 元键 `_note` 被当合法 level：`--level _note` 取到字符串注释键、逐字符成阶段集 → **只载 core 3 文件、rules/policy/learning 全不载、exit 0**；且错误信息主动把 `_note` 广告为合法值 | 过滤 `_` 前缀元键 + `resolve_stages` 的 `isinstance(default, list)` 类型守卫 + next 行动态拼接 |
| 47 | [P1·spec-vs-code] `select_sections` docstring ⑤ 与 `load_plan.stage_sections._note` 仍写旧语义「**全部**子串未命中才回退」，与 #38 的**逐子串**实现相反（下一位维护者照文档改回即复现静默丢节） | 两处同步为「任一未命中」+ 删除实现里不存在的「行范围」误述 |
| 48 | [欠读·P2] 白名单 12 条中 2 条实为**必读**：`lifecycle.md「子 agent 责任」`（含子 agent 禁止物理删除 / 违反 = 主 agent 接管 —— 正是 S10 子 agent 审查判据）、`reflection.md「定位」`（含「执行者：主 agent，子 agent 不参与」S11 角色硬约束）→ 分别补 S10 / S11 映射，白名单 12 → **10** | `load_plan.json` |
| 49 | [P2] `advanced.md` 撤节级映射后矛盾搬到文件级（levels 2/3/4 仍无条件列入，而文件自述 + SKILL.md 均为「触发式命中才读」）→ 从 `levels["3"]/["4"]` 移除，回归纯触发读；L3/L4 反而省 | 同上 |
| 50 | [P2] 前言提示的判据 `min(start)-1 ≥ 3` 被 frontmatter 计入而**恒真**（24/24 组合无条件触发）、文案断言错误、零测试 → 判据改为「首个 H2 之前的**实质行** > 0」（排除 frontmatter/H1/空行/围栏）+ 中性文案 + **双向用例**（partial 且有实质前言 → 提示；partial 但无 → 不提示） | `memory_tool.py` + `test_memory_tool.py` |
| 51 | [P2] `--files` 模式仍打印「阶段: S8（按阶段裁剪…）」——实际 `plan=None` 无裁剪（表头谎称）；`--stage ""` 与 `--stage ,` 口径不一（前者静默取默认集） | 表头按模式如实表述；`--stage` 改 `default=None` sentinel 并统一空串报错 |
| 52 | [P2] 键集一致性缺机械判定：`levels` 有键而 `level_stages` 无键时该 Level 静默退回全整文件且**无任何用例拦截**（审查 M7 变异证实）→ 新增断言 `level_stages 键集 == levels 键集` | `test_memory_tool.py` |
| 53 | [P2·D20 纪律] 上一轮把**已推送**条目（#4/#5/#12/#13/#27/#28 + 收益表）原地改写 → 恢复已推送原文，最终数字改由「收益表后订正块」承载（不改写已发布条目） | 本文件 |
| 54 | [P2] `load_plan.json` 被 `json.dumps(indent=2)` 整体重排（语义变化仅 #35/#39/#40/#48 所列）→ 本次记录在案；机器可读文件接受规范化（消除手写格式漂移） | 本文件 |
| 55 | [LOW] `DEAD_PTR_KNOWN` 僵尸检测由 `grep -F`（子串）改**整行相等**（行尾追加文字也会报 HARD，实测）；补「缺 `::` 分隔符」检测；`rules/review.md` 的降级措辞改指针（不再复制「唯一措辞」串） | `smoke-check-core.sh` + `rules/review.md` |
| 56 | 验证（第四轮） | 单测 **49/49 PASS**；变异复测：`levels/level_stages` 键集缺口（M7）FAIL ✓、`--level _note`（双防御同移）FAIL ✓、逐子串 fail-safe 回退语义 FAIL ✓；双技能 smoke-check HARD 0 / exit 0；模板 exit 3；候选 0（白名单 1） |
| 57 | [防线自证] 变异测试暴露**第三轮用例的 fixture 缺口**：fixture 计划缺 `_note` 元键 → `--level _note` 用例走不到元键路径、无区分力（移除双防御仍全绿）。补 fixture 后复测：仅移过滤由类型守卫兜住（冗余防御），双防御同移则用例 FAIL —— 防线与用例均自证有效 | `test_memory_tool.py` |

**延后项（Loop 上限内不再展开，记 pending）**：`smoke-check-template.sh` 可选变量清单不全（`DEAD_PTR_KNOWN`/`CHECKPOINT_FILE`/`KEYS_CHECK_CMD`/`MAP_TABLE_MODE` 等未列）；`--level` 校验在 `--files` 模式不提示「被忽略」以外的语义。

### 十、第五轮独立审查回修（PASS-with-findings · 收口轮）

> 独立空白审查（fresh context）判定 **PASS-with-findings**：无 P0；2×P1（HIGH confidence）+ 9×P2 + 3×LOW。审查独立复现全部收益数字、枚举映射串、做 12 项变异测试，并证明 **#51 声称的修复未达成**。**本目标的 Code 轮次累计 4（实施 + 三轮回修），已超 kernel §7 上限 3** —— 本轮为收口，后续修复须用户显式授权（见 `.state.md` D26）。

| # | finding（严重度） | 修复 |
|---|---|---|
| 58 | [P1·静默欠读] `--task` 无校验：拼错（`debuging`）**静默丢掉整个 profile 文件集**（23→21 文件）且 exit 0、回显把错拼当已生效；`--stage`/`--level` 均已 fail-closed，独 `--task` 漏网 | 逐 token 校验 `profiles` 键集，未知 → `[INVALID_ARGUMENT]` exit 3（`--files` 模式跳过）+ 用例 |
| 59 | [P1·防线缺口] `level_stages` **值域零校验**：两份机器副本同时改错（`S10`→`S1O`）时 49 用例 + smoke 全绿、preflight 静默显示 `S1O` 并丢掉 S10 专属节（`safety.md §6` 等）；且 `levels` 缺键时仅返回 core 且无告警 | ①smoke 新增 `LOAD_PLAN_STAGE_INVALID`（值域/空列表/重复，HARD）②SELFTEST 同口径值域断言 + **矩阵覆盖断言**（机器副本用到的阶段必须在人类矩阵有对应行）③运行期 `level` 无文件条目 → 打印 ⚠ core-only 提示 |
| 60 | [P2·#51 未达成] `--files` + `--stage` 表头仍打印「按阶段裁剪章节」（对 `kernel.md` 是假话；对 `engine/transition.md` 又是真的——机械分支不依赖 plan → 实为**混合模式**）；#51 声称新增的「（--stage 亦被忽略）」是**不可达死分支** | 表头在 `if stages:` 内按模式分流，如实披露「仅 engine/transition.md 依 `S<n>` 机械匹配裁剪，其余整文件」；删死分支；用例改为断言新文案 |
| 61 | [欠读·P2] `confidence.md`「判定口径」被白名单化，但含**改变行为**的项目特有裁决（记忆与代码冲突 → Medium/E3，标注后继续**不暂停**）；该文件 91 行 < `index_min_lines` → 连节名都看不到 | 补 S8+S10 映射、撤白名单（10 → 9） |
| 62 | [P2·spec-vs-code] `promotion.md`「观察期协议」正文「均由 Agent 按本节自主执行」与同文件已映射的 §S12 收尾「系统职责 / 不构成每轮动作清单」互相否定 | 矛盾句修正为「非每轮动作清单——触发由检查时机驱动」；白名单理由同步为事实 |
| 63 | [P2·freshness 零检测] `updated_at` 既不在字段清单也不在 core 6b 必需集 → 实测陈旧值仍 HARD 0（第五轮实测：`updated_at` 落后文件 mtime 38 分钟仍过） | 纳入必需字段：`state-machine.md` 字段表 → **13 项（含 `updated_at`）**，core 6b `req` 同步（缺/坏即 HARD） |
| 64 | [P2·口径高估] `_canonical`/D1 称「等价机器副本」，实测与 SKILL.md 两表**互不为子集**（`reflection.md` 按门控读却无条件列入、`advanced.md` 合法缺席、SKILL.md 仍写「全部 learning/」） | `_canonical` 补口径（**机器 ⊆ 人读允许范围**，过读侧允许超集 + 触发式文件豁免，不承诺双向等价）；`SKILL.md` Full Loop 行改为「advanced.md 为纯触发式，不在加载清单内」 |
| 65 | [LOW] 僵尸条目报错位置指向 `GOV_FILE` 而非条目定义处；awk 归一化 `[ \t]` 与候选侧 `[[:space:]]` 不完全等价 | 报自身路径（`$kf` / 配置区）；awk 改用 `[[:space:]]` |
| 66 | [P2] 数字订正：订正块按**最终态**重测（并标注口径与取整惯例）；#43 计数改 **12 文件 / 唯一串 67 / 含重复 112**；#42 描述改为实际文案（不含行范围） | 本文件 |
| 67 | 验证（第五轮） | 单测 **50/50 PASS**（第六轮再 +1 → 51/51，见 #71）；变异：`--task` 拼错、`level_stages` 值域（S1O/空/重复/标量四例）、`--files` 表头、前言判据双向、键集一致性——全部被拦；双技能 smoke-check HARD 0 / exit 0；模板 exit 3；3759/3800 |

**仍延后（Loop 上限内不展开）**：`smoke-check-template.sh` 可选变量清单不全；`observance` 协议与 `policy/priority.md §3.6` 的单源化；每个 partial 文件被读 4 次（实测 0.21s，理论 TOCTOU，接受）。

### 十一、授权延后项收口（第六轮 · 用户显式授权，D26 例外）

> 用户 2026-10-15 询问三项延后项的收益 → 实测收益≈0（均不在加载路径）→ 用户仍显式**授权**执行。三项均属"未来维护性/一致性"，不改变 token 与流程行为。

| # | 变更 | 落点 |
|---|---|---|
| 68 | 模板配置区补齐 **8 个可选变量**（`GOV_KEY_PREFIX` / `KEYS_CHECK_CMD` / `KEYS_PREFIX` / `MAP_TABLE_MODE` / `CHECKPOINT_FILE` / `DEAD_PTR_KNOWN` / `SCAN_EXCLUDE_PATHS`）+ 标注「完整契约唯一事实源 = core 头部」——防实例化者漏用可选检查 | `smoke-check-template.sh` |
| 69 | **观察期协议单源化**：该节头改为指向 `policy/priority.md` §3.6（操作侧唯一事实源），删除与 §3.6 重复的阈值条目（3 次转正 / 连续 2 次失败降级），仅保留系统实现侧细则（标记落库 / 顺延 / 删除流程 / `level:core` 授予义务 / 检查时机 / 仪表盘）——两处阈值漂移风险消除 | `learning/memory/promotion.md` |
| 70 | **preflight 读盘合一**：新增 `_read_text_cached`（按 `(path, mtime_ns, size)` 记忆化 + 按轮清理），`file_stats` / `read_sections` / 前言判据 / 成本统计共享**同一快照** —— 清单文件读盘 **4 次 → 1 次**（实测 21/21 各 1 次，总读盘 41），并消除 D25 记录的理论 TOCTOU（同轮内跨度与提示必一致） | `backup/memory_tool.py` |
| 71 | 验证（第六轮） | 单测 **51/51**（+1 读盘缓存行为用例）；双技能 smoke-check HARD 0 / exit 0；模板 exit 3；**规则文件 3758/3800**（单源化净 −1 行）；耗时 0.20s（**读盘减少不改耗时**，如实标注）；收益数字再测（见上方订正块） |

### 十二、体系评估缺陷修复批次（D1–D6，同版本第三批）

> 触发：对仓库做证据驱动体系评估（产物在 `skill-evaluation/`），除基线结论外给出 4 个待验证候选（P1–P4）。本批次按报告逐项落地并**逐项验证**（不再停留在「暂缓待验证」）。评估发现的 D1/D2 属阻断性问题，故本批次优先闭环。

| # | 缺陷 | 修复 | 验证 |
|---|---|---|---|
| 72 | **D1/D4（Critical/Medium）** `audit.sh check` 真实仓库崩溃 + 72s（逐行 fork `grep`，9408 forks → macOS Bash 3.2 SIGILL/exit 132） | `check_markdown_links` 改**单文件一次 awk** 提取围栏外链接（含行号），复杂度 O(文件数×fork)；fence 过滤改在 awk 内状态机完成（语义等价） | 全仓 `check` **0.85s / exit 0**（原 72s+/崩溃）；自测 43 → **49 项全过** |
| 73 | **D6（Low）** 审计自测只用合成小仓库，永不暴露 D1/D4 | `test-audit.sh` 增**规模回归**：1500 行 + 围栏内外混合链接，20s 看门狗，断言不崩溃、围栏外断链仍被检出、围栏内链接仍被忽略 | 该用例 PASS；变异（回退逐行 fork）会被 20s 看门狗判 FAIL |
| 74 | **D2（High）** 完整规则内容只在 gitignored 快照/local DB，**无任何可校验的规则制品** | 新增 `export-rules`：从活库生成**脱敏规则集** `backup/rules/skill_memory_canonical.json`（主目录→`~`/`<USERPROFILE>`、去 `db` 字段），与活库可机械比对；`SKILL.md` fail-closed 动作改为「经私有通道取得快照/规则集后 restore」；`audit check` 增 **C011**（规则集存在但未脱敏 = high；未生成 = info）。**规则内容仍不入库**（用户隐私裁决：条目正文不外发，仓库只分发协议骨架） | `export-rules --check` → 一致（45 条）；`restore` 规则集 `--dry-run` 通过；C011 双向用例 PASS |
| 75 | **D5（Low）** 快照内嵌本机主目录绝对路径（`db` 字段） | `build_snapshot_payload` 的 `db` 改可移植写法（主目录内 → `~/...`，否则 `<external-db>`）；`restore` 显式忽略备份内 `db` 并提示 | 新增用例断言快照无本机路径、`restore` 打印忽略提示 |
| 76 | **D3（Medium）** `python3 -m runtime.exec` 不可执行 | 新增 `runtime/exec/__main__.py`（与 `runtime/core` 同构） | `python3 -m runtime.exec --help` 可执行 |
| 77 | 脱敏护栏（防 D2/D5 复发） | `export-rules` 内置**残留检测**（主目录路径/个人目录名/邮箱/凭证）→ 命中即 **fail-closed exit 4**，不写文件；`.gitignore` 排除 `backup/rules/`；测试样例运行时拼接，避免测试源码自身被审计命中 | 用例：含邮箱 → rc 4 且不落盘；`git check-ignore backup/rules/*` 生效；仓库 `scan --min-severity=high` 无新增命中 |
| 78 | 验证（本批次） | 单测 **55/55**（+4：脱敏/拒绝/漂移/db 可移植）；`test-audit.sh` **49/49**；`check-protocol` 81/81 零漂移；软链 15/15；smoke-check HARD 0（规则行数 3870 为**既有**超预算，本批次零行数增量）；`audit check` 0.85s / exit 0；提交面 `git ls-files` 不含任何规则/快照文件 |

**说明**：`skill-evaluation/` 报告中的 P1–P4 与本批次 72/73/74/76 一一对应；报告要求「先跑对照再采纳」，故 72–77 均给出修复前后对照数据。

## v1.22.0 — 上下文成本治理（加载计划 / 结果外置 / 结构化错误码）

> 提交 v1.21.0（dd3b437）后递增。**触发**：对照 `dsh-ops`（DSH 性能工具插件）的省 token 机制做同构分析，得出四项可迁移原则 ——
> ① 上下文**准入**控制（工具定义可开关 / 架构折叠 / 视图模式 / 动态渲染路由表）；
> ② 上下文**外置**（结果引用 put·page·release / 循环下推沙箱 / 数据落盘不落上下文）；
> ③ **返工抑制**（根除易错面 / 结构化错误码 / 计划不可静默替换 / WAL 结算状态 / 失败关闭）；
> ④ **成本回收**（TTL / 显式预算 / 超限显式报错）。
>
> **基线实测**（本地 `wc -l` / `wc -m`，整文件口径、含 `.state.md` 实例与 `manifest.yaml`，为**改造前**的加载集——与改造后 `preflight` 输出的成本行（已排除实例、含 yaml）**不可直接对比**）：Quick Loop 加载集 1,582 行 / 116,615 字符；Standard Loop 2,571 行 / 180,276 字符 —— 单是读规则即可吃掉 11.6–18 万字符。

### 一、上下文准入（C1 / C3）

| # | 变更 | 落点 |
|---|---|---|
| 1 | 新增 `load_plan.json`：加载计划的**机器可读副本**（core / levels 0–4 / profiles / 阈值）；声明为「等价机器副本」，人读事实源仍是 SKILL.md 两表 | `load_plan.json`（新） |
| 2 | 新增 `memory_tool.py preflight --level <L> --task <T>`：**一次调用**返回加载清单 + 成本 + **运行时实测章节索引** + 记忆候选，替代原先 N 次导航读取 | `backup/memory_tool.py` |
| 3 | **章节索引零漂移**：H2/H3 与行号在调用时扫描生成，不写死在任何文件里（对齐 dsh-ops「路由表由插件按实际发布情况渲染」）；digest 为**三级零维护回退**（frontmatter `digest:` → H1 标题 → 正文首行散文），无一处需人工维护 | 同上 |
| 4 | SKILL.md 新增**「两段式读」**加载规则 + 读取粒度表（<60 行整读 / 阶段细则只读本节 / 出口检查只读当前阶段一节 / 查表类先按索引定位） | `SKILL.md` |
| 5 | 新增 `SKILL.md` 加载规则第 4 条**大产出外置**：>100 行的产出落盘留 ref，禁止全量倒进上下文 | 同上 |

### 二、上下文外置（C2）

| # | 变更 | 落点 |
|---|---|---|
| 6 | 新增 `memory_tool.py artifact put/page/list/release`：结果引用（同构 `ops_result`）。投影 `--fields` / 过滤 `--equals`·`--grep` / **`--count` 先摸规模** / `--max-bytes` 单页字节上限 / 24h TTL 自动回收 | `backup/memory_tool.py` |
| 7 | **超限显式报错**：达字节上限返回 `[OUTPUT_LIMIT]` 并标注「本页提前结束」，**不静默截断、不返回空页**；`--count` 只回计数 | 同上 |
| 8 | 产物目录 `$VIBE_LOOP_ARTIFACTS_DIR`，缺省 `~/.vibe-loop/artifacts/<workspace-hash>/`（namespace 口径与 delx-memory 同源：git 仓库根路径哈希） | 同上 |

### 三、返工抑制（C4 / C5）

| # | 变更 | 落点 |
|---|---|---|
| 9 | 新增 **VC 错误码族**（10 码）：`RULE_NOT_LOADED` / `RULE_NOT_FOUND` / `RULE_STORE_MISSING` / `EVIDENCE_INSUFFICIENT` / `SCOPE_DENIED` / `PLAN_DRIFT` / `NO_PROGRESS` / `LOOP_BUDGET_EXHAUSTED` / `OUTPUT_LIMIT` / `ARTIFACT_NOT_FOUND`。**铁律：不带 `[next]` 的输出不构成错误码**（`[next]` 必须是单一确定动作） | `engine/transition.md` |
| 10 | 引入 **fail-closed 语义**：标「是」的码**不得降级继续**，禁止用残缺规则 / 陈旧摘要继续推断 | 同上 |
| 11 | 首次部署规则缺失由「**降级到残缺摘要**」改为 **`RULE_STORE_MISSING` 停止 + 恢复动作**（"以为自己有规则其实没有"的返工成本高于直接停下） | `SKILL.md` |
| 12 | 新增**计划契约 + 计划漂移校验**：S7 出口声明「预期修改/新增/删除文件集」；S8 出口校验实际改动 ⊆ 契约，超出 → `[PLAN_DRIFT]` 记录后继续（不阻断但留痕）。对齐 dsh-ops `plan → resume`「计划不得被静默替换」 | `rules/plan.md` · `engine/transition.md` |

### 四、通用协议层与维护协议层（C7–C13）

| # | 变更 | 落点 |
|---|---|---|
| 13 | 新增「**召回纪律（summary-first）**」：list/summary 先取元信息 → 命中才 `memory_get`；禁止无条件全量取 value；规模先行（先计数再枚举）；单次取用有界 | `delx-memory-protocol/protocol.md` |
| 14 | 新增「**冷记忆降级**」：`hit_count=0` + 跨 90 天 + 未被提升引用 → 降载（`scope:archived`）或存根化；**不做静默删除**；不作用于规则层 | 同上 |
| 15 | supersession 新增**链深上限 2 强制折叠**（末端提升为链头，中间节点降为 value 内历史段）；带 `audit` tag 时不折叠但须标 `chain_depth` | 同上 |
| 16 | 新增「**条目标长与外置**」：实例层条目 value ≤ 40 行，超出外置（`ref:` 格式）；规则条目不得内嵌大段示例/日志/文档 | 同上 |
| 17 | **消除 duplicated guide**：`engine/complexity-gate.md`「安全不变量」原文逐句复述 `kernel.md` §4.1（且自称以后者为唯一事实源）→ 改为纯指针 | `engine/complexity-gate.md` |
| 18 | 自检脚本重构为 **core + 薄包装**（3 份 ~162 行近似副本 → 1 个 core + 3 个配置包装）：`skill-authoring/scripts/smoke-check-core.sh` 为**逻辑唯一事实源** | `skill-authoring` · 本 skill `scripts/` |
| 19 | 自检新增**结构化错误码 + 退出码**（0/1/2/3）+ **行数预算门禁**（`BUDGET_EXCEEDED`，**棘轮语义只降不升**） | 同上 |
| 20 | 自检新增**两类新的机械判定**：① 映射表声明的 `skill:*` key **真实存在**；② `Canonical ≠ 数据` 的条目 tags 必须含 `permanent`（**规则条目带 TTL = 到期凭空消失 → 静默降级**） | 同上 |
| 21 | 映射表改为**全限定 key + `Canonical` 类型列**（消除 `verify-first` 类短写 —— 短写无法被机器校验，是死指针温床） | `references/governance.md` |
| 22 | 自检新增**加载计划一致性**（`LOAD_PLAN_PATH_MISSING` / `LOAD_PLAN_UNDOCUMENTED`）—— 该检查在本轮**当场抓出** `learning/memory/architecture.md` 的文档/计划漂移；因宿主文档惯用相对子目录短写（`memory/architecture.md`），提及判定放宽为「全路径 **或** basename」命中 | 同上 |

### 五、测试与验证

| # | 项 | 结果 |
|---|---|---|
| 23 | `test_memory_tool.py` 新增 9 个用例（`PreflightAndArtifactCase`），覆盖 fail-closed / 有界输出 / 投影正确性 / ref 生命周期 / 映射校验 | 30/30 PASS |
| 24 | 负向测试：plan 缺失 → 3；清单文件缺失 → 3；ref 不存在 → 4；字节超限 → `OUTPUT_LIMIT`；key 缺失 → 4；规则条目带 TTL → 4；数据类豁免 → 0 | 全部符合预期 |
| 25 | `smoke-check.sh`（core + 包装）| HARD 0；退出码 0；表格列数一致 |
| 26 | 跨 Skill 版本（记录于此，两协议 skill 无独立 CHANGELOG） | `skill-authoring` 1.1.0 → **1.2.0**（新增自检脚本架构节 + 残留验证纪律升级为门禁表 + manifest `smoke-check-core` 架构项）；`delx-memory-protocol` 1.1.0 → **1.2.0**（新增召回纪律 / 冷记忆降级 / 链深折叠 / 条目标长外置） |
| 27 | 本 skill 版本 | 1.21.0 → **1.22.0** |

### 审查回修（独立 Critic 轮 → FAIL 判定 → 全部照单修复，合入本版本）

> 交付后由 **fresh-context 独立 subagent**（非 Builder 本人）审查，判定 FAIL：P0×2 / P1×5 / P2×14。回修要点（逐项实测复验）：

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| R1 | **P0** | `artifact put --name` 未消毒 → 路径穿越**任意写**（`_artifact_slug` 定义未用） | slug 消毒（去分隔符/首尾点）+ `resolve` 边界双保险；非法 `[ARTIFACT_NAME_INVALID]` exit 3；实测越界名被中和 |
| R2 | **P0** | `release`/`prune` 信任 index.json → 伪造 ref 可诱导**界外 rmtree** | 新增 `_artifact_safe_dir`（ref 锁定 `a+10hex` + resolve 后 parent==base）；三处统一过校验；实测伪造 ref 被拒、victim 目录完好 |
| R3 | P1 | `preflight --files` 恢复路径失效（plan 解析先于 `--files` 判定，`[next]` 指了一条不可用的路） | 顺序对调；plan 缺失时 `--files` 实测可绕过 |
| R4 | P1 | `--limit`/`--max-bytes` **静默 clamp** + 负值越界返回 295 行（违"超限必须可见"） | 非正 → `[INVALID_ARGUMENT]` exit 3；超上限 **显式打印 clamp 行**（`[OUTPUT_LIMIT]`）；章节索引超 14 节报「另有 N 节」 |
| R5 | P1 | `RULE_STORE_MISSING` 码义漂移（被用于 plan 文件缺失） | plan 缺失改 `LOAD_PLAN_MISSING`（与 core `LOAD_PLAN_*` 同族）；码表 +1 行，`RULE_STORE_MISSING` 收敛单义 |
| R6 | P1 | smoke-check 运行时依赖 skill-authoring 未在 manifest 声明 | `optional_integrations` 增项（含缺失时行为：显式 exit 3，不静默跳过） |
| R7 | P1 | SKILL.md 同文件自相矛盾（S2 既说 `preflight` 又保留常驻 `memory_list` 指令） | 删第二条指令，指向 preflight 行 |
| R8 | P2 | `.state.md` 尾随 `---` → YAML **多文档不可解析**（存量 bug，违恢复协议；本轮暴露） | 删尾随分隔符；core 新增 **6b 节机械判定**（单文档 + 12 字段，pyyaml 缺失显式跳过） |
| R9 | P2 | 成本基线口径不一致（3652 vs 3746：一个含 `.state.md` 排 yaml，一个反）——违 `lesson:checkpoint-instance-growth` 固定口径 | 两处统一为「.md+.yaml，排除 `.state.md` 实例」；`.state.md` 移出 `load_plan.json` `core`（它由 S1 恢复协议单独读取） |
| R10 | P2 | `grep -rn` 无 rg 环境下死指针**行号必错**（文件名被读进行号列） | `rg --no-filename` / `grep -n`（单文件调用无前缀） |
| R11 | P2 | README 含 `page` 子命令不存在的 `--kind` 示例（照抄 dsh-ops 参数集） | 删除；kind 由 put 时声明 |
| R12 | P2 | protocol.md 要求 `memory_get` 的 limit 参数（不存在） | 改 `memory_get_many`（单次 ≤50） |
| R13 | P2 | 冷记忆降级与 TTL/Relevance 同日触发无优先级（`lesson:*` 90 天撞车几乎不可达） | 补裁决：判定窗 = TTL 到期前 30 天，同窗命中以 Relevance 淘汰为准，降载止于非删除动作；作用域注明为 reflection/experience |
| R14 | P2 | 映射表 B 类型空档（core 接受 `B` 但表内不出现） | core `TYPES` 收敛为 A/C/数据；表注注明 B 不进本表 |
| R15 | P2 | 三包装 core 定位块候选列表已分叉 | 统一为规范顺序（5 候选，注释「勿增删改序」） |
| R16 | P2 | Tool 输出多处缺 `[next]` / 码族不封闭 | ARTIFACT_*/DB_NOT_FOUND/KEYS_CHECK 等补 `[next]`；transition.md 增「Tool 层运维码（补充登记）」段收口 |

**回修验证**：`test_memory_tool.py` **34/34 PASS**（新增 4 用例：穿越名中和 / 伪造 ref 拒绝 + prune 安全 / 负值与 clamp 显式报告 / `--files` 绕过缺失 plan）；`.state.md` `yaml.safe_load` 单文档 OK + 12 字段齐全。

## v1.21.0 — 记忆操作常驻授权（增删改查自主执行）

> 提交 v1.20.0 后递增。用户指令：**「调整三 skill 中关于记忆增删改查的操作，后续无需再让我统一，让 agent 直接自己操作即可【只有文件、代码删除时才需要强制让我来确定】」**。

### 一、授权模型（新增事实源）

| # | 变更 | 落点 |
|---|---|---|
| 1 | 新增 **「记忆操作授权模型（常驻授权）」**：增/删/改/查自主执行；`explicit_user_intent=true` 由常驻授权满足；四类义务（质量闸门 / 三列完整回传 / 删除前核验归属与可回滚证据 / 改后引用扫描+快照）保留 | `delx-memory-protocol/protocol.md`（协议事实源）+ `SKILL.md` + manifest 1.1.0 |
| 2 | Consolidation Phase 8「待淘汰清理」由「人工确认」改为**自主删除**（过删除义务 + ≥5 条先列清单） | 同上 |
| 3 | skill-authoring：下沉条目的增/改/删属 Agent 自主（不留待确认） | `governance-protocol.md` + manifest 1.1.0 |

### 二、宿主协议改造（废除确认门控）

| # | 变更 | 文件 |
|---|---|---|
| 4 | 「记忆保存（三条路径）」→ **「记忆写入（自主执行，无逐次确认）」**：废除「建议块等用户回复保存」与「S12 批量确认清单」两类门控；保留**质量闸门**（九类垃圾特征 + 三问 + 去重/Merge）作为防污染判定 | `learning/memory/lifecycle.md` |
| 5 | 用户偏好沉淀：从「输出建议块等回复保存」→ **直接写入 + 一行回执**（保留 ≥3 次确认条件） | 同上 |
| 6 | 回写契约：「授权不可确认 → 待确认」分支删除（授权恒成立）；`memory_set` 约束适用范围改「新增 / 非计数类更新 / 合并」 | 同上 |
| 7 | Test→Lesson、Reflection、Quick Loop 闭环：[2] 全部改为**即时写入**（`📝 已记录经验教训` / `🧠 已沉淀`），无延迟确认 | 同上 + `learning/reflection.md` |
| 8 | S12 收尾 [2]：输出「待保存清单等确认」→ **直接写入 + 回执** | `learning/memory/promotion.md` |
| 9 | Contradict 裁决：请求用户裁决 → **Agent 自主裁决**（保留双方 + `contradict` tag + 取更具体/证据强者；涉及 R0/R1 语义分歧仅标注不阻塞） | 同上 |
| 10 | 观察期：升格 `level:domain` **自主执行**；删除 `candidate-delete` **自主执行**（过删除义务） | 同上 |
| 11 | **「记忆条目删除闸门（四条件）」→「记忆条目删除义务（两项）」**：用户确认与「先标后删」环节取消，保留 ① 归属为本方 ② 可回滚证据已核验（实际核验）；≥5 条先列清单（不阻塞） | `kernel.md` §2 · `policy/lifecycle.md` · `policy/safety.md` §1 |
| 12 | 出口措辞同步：`🧠 待保存记忆清单（等待用户确认）` → `🧠 已沉淀：<keys>`；计划/编码出口「路径 B/C」→「直接写入」 | `rules/review.md` · `rules/plan.md` · `rules/code.md` · `rules/test.md` · `profiles/debugging.md` · `engine/state-machine.md` |
| 13 | 身份层同步：新增「记忆操作常驻授权」条款（取代原「计数回写自动授权」单点授权），第 3 条 C 类条件改自主 | `raw/ai/agents/Vibe Coder.md` · `agent:vc_constraints` |

### 三、追加放开（用户裁定「都放开」）

| # | 变更 | 落点 |
|---|---|---|
| 14 | **`rule:` 条目权限全放开**：创建 / 修改 / 删除均 Agent 自主（原「仅用户」矩阵改写）。安全性改由**机制**承接：准入四条件（有事实依据 / scope 限 project·task / 可验证具体约束 / 不与 R0·R1·`engine/` 冲突）+ 结构红线（**不得覆盖 R0/R1 与 `engine/` 阶段流程**、不得覆盖当轮用户指令）+ **观察期转正**（`auto_generated` + `pending_review`，3 次成功触发转正、连续 2 次失败降级标 `candidate-delete`） | `policy/priority.md` §3.6（矩阵 / 准入 / Agent 动作改写）+ §3.5 例外②措辞 |
| 15 | **`level:core` 放开**：tactical → domain → core 全由 Agent 自主升格；义务 = 条目内记授予依据，且 **core 不改变 Advisory 地位**（仅表示 `skill:*` 条目内加载优先级，不得否决 `engine/`·`rules/` 文件规则） | `learning/memory/promotion.md` 观察期规则 3 |
| 16 | 提升链与 `rule:` 的关系澄清：自动提升链（lesson→pattern→principle）产物**始终为 Advisory**，不自动派生 `rule:`；`rule:` 由 Agent **显式创建**（过准入 + 观察期） | `learning/memory/promotion.md` |
| 17 | `contradict` 经验冲突：由「Conflict Card 请用户裁决」改 **Agent 自主裁决**（保留双方 + 标注 + 取更具体/证据强者；仅 R0/R1 语义分歧时在输出提请用户） | `policy/priority.md` §3.5 冲突表 |
| 18 | 通用协议层同步 + 授权记录更新（`preference:user:memory-autonomy`：`still_requires_user` 收窄为文件/代码删除一项） | `delx-memory-protocol/protocol.md` · `kernel.md` §2 · memory 条目 |

### 四、唯一保留的用户确认项

- **文件 / 代码资产的物理删除**——Agent 不执行，止步于归档 + 「🗑 待删除清单」，由用户执行（v1.20.0 分界不变）。
- 记忆侧的一切操作（含 `rule:`、`level:core`、跨条目合并/删除）**无用户确认门控**；守门改由**质量闸门 + 准入条件 + 观察期 + 结构红线**承接。

**边界**：授权扩张仅限**记忆条目**；代码资产删除规则（v1.20.0 分界）不变；质量闸门与写入完整性义务全部保留（防"自主"退化为"无门槛"）。



## v1.20.0 — 记忆教训回流 + Tool 双 rate + 快照收敛

> 提交 v1.19.0 后递增（HEAD 已含 1.19.0）。来源：以 delx-memory 经验（71 lesson / 4 pattern）反查 Skill 覆盖面的只读审查，用户裁定「可增规则但不得加剧主路径上下文 / Tool 加独立字段 / 执行清理 / 采纳提升信号」。

### 一、教训回流（4 项：记忆已有实例，Skill 缺动作点）

> 原则：**内容型规则下沉 `skill:*` 条目，Skill 文件只留「动作 + 指针」**——新增条目按需加载，主路径（S1–S13 常规加载）token 增量 = 2 行。

| # | 变更 | 落点 |
|---|---|---|
| 1 | **子 agent 结论独立复核**（三类结论：已修→重跑/读码；已注释·已删除→去注释后判 live 引用 + 审 diff 非注释行；数量级结论→脚本重算；验证命令自身双信号交叉） | 新条目 `skill:rules/orchestration:subagent-reverify` + `rules/orchestration.md` 整合阶段第 3 项 + 主 agent 责任节 + `rules/review.md` 判定要点 |
| 2 | **零引用 / 死代码审计口径**（范围显式声明含 examples/文档站；消费者三档分开给；豁免自身定义·再导出·`*.d.ts`） | 新条目 `skill:references/dead-code-audit` + `rules/review.md` 判定要点 + `engine/router.md` Investigation 分支 |
| 3 | **长文档多轮编辑结构复检**（每轮 edit 后重跑结构指纹三件套：章节清单 / 行数突变 / 区块闭合） | 新条目 `skill:rules/review:doc-structure-recheck` + `policy/safety.md` §5 Level 0 子集 + `engine/router.md` Investigation 分支 |
| 4 | **fresh-context 实测**入出口纪律（跨文件/跨层结构变更后至少 1 次独立子 agent 走读） | `profiles/skill-maintenance.md` Optional |

### 二、Tool：仪表盘双 rate + 快照收敛

| # | 变更 | 文件 |
|---|---|---|
| 5 | **`--memory-hit` 独立字段**：`memory_hits` / `memory_hit_rate`（= `memory_hits/searches`，召回有效性）与既有 `hit_rate`（= `budget_hits/searches`，预算内完成率）口径分离、分别重算；越界裁剪告警、`searches=0` 归零；摘要行改为 `retrieval=N(budget x / memory y)` | `backup/memory_tool.py` |
| 6 | 修因：同字段被手工写入两种含义（命中率 vs 预算完成率）导致比率互踩；降级路径明令**禁止手写任何 rate** | `learning/skill-metrics.md`、`backup/README.md` |
| 7 | 写前快照保留 **5 → 2** 份；`backup` 收尾同步执行有界保留（此前只有 `restore` 裁剪，旧份滞留） | `backup/memory_tool.py`、`backup/README.md` |
| 8 | 自测 +3：双 rate 独立性 / `memory_hit_rate` 裁剪 / backup 裁剪写前快照（21 项全通过） | `backup/test_memory_tool.py` |

> **一次性修复**：仪表盘检索基线重置（旧值 `searches=59 / budget_hits=0 / hit_rate=0.667` 系手工写入且计数从未累加 → 两 rate 永假低、并会命中 `<40%` 假预警）→ 重置为本轮真实计数 4/4/4，此后由 Tool 累加。

### 三、治理与收口

| # | 变更 | 文件 |
|---|---|---|
| 9 | 提升评审补候选信号：`trigger:high-reuse` 与 `recurrence_count ≥ 2` 优先评审（**不降阈值**，仍须指纹同类 ≥3 建 pattern） | `learning/memory/promotion.md` |
| 10 | `rules/orchestration.md` 设计原则编号断档（1→4）修正为 1–4 | 同上文件 |
| 11 | `SPLIT_PLAN.md` 使命完成（阶段 5 已实施）→ 归档 `backup/archive/`；引用改指本文件（拆分执行历史唯一事实源 = CHANGELOG） | `SKILL.md`、`references/layout.md` |
| 12 | 映射表补 3 条新条目（类型 C：条目为完整版，文件留动作 + 指针） | `references/governance.md` |

### 四、记忆键治理（用户指令：完成旧键处置 + 键改名）

| # | 变更 | 处置 |
|---|---|---|
| 13 | 键改名 `skill:rules/review:five-dimensions` → `eight-dimensions`（内容实为 8 项）；同步修 stale 内容：`30/300/4` 由「违规阈值」改为 **Review Signal** 表述、补坏味道不豁免说明 | 新键已建；3 处引用改指（`references/governance.md`、`rules/review.md`、`engine/transition.md`）；旧键标 `superseded` + `pending_removal` |
| 14 | 旧键 `skill:system:rollback_point`（越界命名空间 `system:`；内容已搬运至现行键） | 标 `pending_removal` + 记录 `removal_requested_at`；**Agent 不执行物理删除** → 用户已执行删除（见下） |
| 15 | 旧键 `skill:system:metrics` | **归属核实为 audio-kernel**（`owner:audio-kernel` + `updated_by: audio-kernel` + 其自身指标仍在更新）→ **保留不动**，从待删除清单移除 |

**删除已由用户执行**（Agent 侧止步于标记）：

```bash
sqlite3 ~/.delx-memory/db.sqlite "DELETE FROM memory WHERE key IN ('skill:system:rollback_point','skill:rules/review:five-dimensions');"
```

→ 结果核验：memory **225 行 / FTS 225 行 / 孤儿 0**（`memory_fts_ad` 触发器生效）；备份重建 **44 条 + verify 一致**。

> **可回滚性核查（修正一处先前说法）**：当日时间戳快照会被「按天去重」清理——同一天内 `backup → 删除 → backup` 序列会使**删除前的当日快照被销毁**，故「当日快照可 restore 回滚」不成立。实际回滚路径（两处均已实测含两键）：① git HEAD 的 `backup/snapshots/skill_memory_latest.json`（14:19 版本）；② `backup/snapshots/skill_memory_stabilization.json.gz`（42 条）。**建议**：若需长期保留「关键节点现场」，按天去重可改为保留最近 N 天，或对 prerestore 之外的关键节点做命名快照。

> **改名后的记忆侧引用扫描（文件 grep 抓不到的一类）**：FTS 反查发现两处陈旧引用并修复——① `reference:memory-navigation` 内 2 处示例键名仍指旧名 → 改指新键；② `skill:vibe-coder-loop:rollback-point` 的 `migration_note` 仍写「旧键保留未删（删除需用户明确指令）」→ 改为「已按用户指令删除」，并顺带去其硬编码条目数。**启示：改名/删键后必须做「记忆库内引用扫描」（FTS MATCH 旧名），仅扫文件不够**。

### 五、R0 删除条款收敛：按对象显式划分（用户裁定）

> 背景：R0 层三处删除条款互相矛盾——Agent Prompt「Agent 永不执行物理删除」 vs `kernel.md` §2 规则 1「仅用户明确指令 → 先 Conflict Card → 执行物理删除」 vs `policy/lifecycle.md`「执行删除：物理删除 `archive/` 下对应文件」。裁定 = **不统一为单一规则，而是按对象显式划分**。

| 对象 | 范围 | Agent 权限（裁定后） |
|---|---|---|
| **A 代码资产** | 用户项目内文件 / 组件 / 代码 / 注释 / 配置（含用户明确要求移除的、含已归档 `archive/` 文件） | **永不物理删除**（含用户明确指令）→ 归档 + 「🗑 待删除清单」（含可执行命令）→ **用户执行** |
| **B 本轮自产草稿** | 本轮新建、尚未经用户接受的实现 | 可直接删除 / 覆盖 / 重写（非用户资产，不入清单） |
| **C 记忆条目** | delx-memory key | **可执行删除**，但须四条件全满足（用户明确指令 + 已标 `pending_removal` + 可回滚证据已核验 + 非他方 owner）；默认仍是「标记 + 清单」 |

**落点（10 处，全部对齐）**：`raw/ai/agents/Vibe Coder.md`（身份层）· `kernel.md` §2（转换表 + 对象划分表 + 记忆条目删除闸门四条件）· `policy/safety.md` §1（拆两行：代码资产 / 记忆条目）· `policy/lifecycle.md`（状态机 / 适用范围 / Archived→Removed 流程 / 新增「记忆条目删除闸门」节 / 子 agent 责任）· `policy/priority.md`（P0 行 + 冲突示例）· `rules/code.md`（前置检查）· `profiles/refactoring.md` · `learning/memory/lifecycle.md`（禁止项）· `learning/memory/promotion.md`（观察期删除）· `agent:vc_constraints`（子 agent 兜底副本）。

**语义变更（需知悉）**：原「用户明确指令 → 可删除用户既有资产」（`kernel.md` §2 旧文 / `lifecycle.md` 旧「适用范围」表 / 裁定 R7）**被本次裁定取代**——代码资产的物理删除一律由用户执行；原「用户明确要求移除的代码」「授权重构范围内被替换的实现」由「可删」改为**归档 + 清单**。本轮自产草稿仍可直接删改（保证 Code[N+1] 迭代不被归档强制阻塞）。

**边界**：不改 Loop Depth 矩阵 / 三红线其余两条 / 硬约束 6 项 / S12 两步收尾 / 压缩边界（Runtime 负责）。`skill:vibe-coder-loop:rollback-point` 仍锚定 v1.14.8 历史态，不重写。

**已知遗留**：压缩后状态延续契约仍缺真机 E4 证据（等真实长会话触发）。

## v1.19.0 — 阶段 5 实例文件裁指针

> 提交 v1.18.0 后递增的下一版本基线（commit 029ceb7）。本批次实施 SPLIT_PLAN 阶段 5（实例文件裁指针），兑现协议提取式拆分的上下文降低收益。

### 批次 0：通用概念裁指针（architecture.md + advanced.md）

> 与 v1.18.0 同批提交后递增。性质：将宿主实例文件中与 `delx-memory-protocol/protocol.md` 重复的通用概念裁为指针，只保留实例特化。低风险高 churn，逐文件 smoke-check 守门。

| # | 变更 | 文件 | 行数 |
|---|---|---|---|
| 1 | 三层体系/命名空间/Tag-scope 通用概念表裁为指针表（→ protocol.md §各节），保留实例特化（memory-navigation 前缀指针/scope:project 实例/D8 实证/提升执行指针） | `learning/memory/architecture.md` | 65 → 31（-52%） |
| 2 | Relevance 公式/supersession 规则/跨项目迁移概念通用部分裁指针，保留触发条件表（加通用规则源列）、实例执行路径、Consolidation 规则源表+输出格式、周期 Metrics 模板、失效传播实例步骤 | `learning/memory/advanced.md` | 128 → 103（-20%） |
| 3 | 「fallback 副本」描述同步为「实例特化 + 指针」（通用概念已裁，非 fallback） | `references/governance.md`（2 处） | — |
| 4 | 委托声明「后续阶段可逐步裁减」更新为「阶段 5 已实施」 | `SKILL.md` | — |
| 5 | 索引描述同步：architecture/advanced 从通用概念清单改为「指针 + 实例特化」 | `learning/memory.md`（2 处） | — |
| 6 | 引用链修复：promotion.md:36 `architecture.md「三层记忆体系」`（裁后断链）→ 改指 `delx-memory-protocol/protocol.md` §三层记忆体系 | `learning/memory/promotion.md` | — |
| 7 | 节名精确化：lifecycle/skill-metrics 引用 advanced.md 节名补裁后后缀（「Relevance 评分」→「（实例约束）」、「周期 Metrics 输出模板」→「（实例特化）」） | `learning/memory/lifecycle.md`、`learning/skill-metrics.md` | — |

**合计**：learning/memory/ -59 行（-31%）。**守门**：smoke-check HARD 0 违规（3 处候选为既有非本次）。**引用链验证**：指针目标 8/8 可达（protocol.md §节全命中）；节名引用断链 1 处修复（promotion.md:36）+ 2 处精确化；E2 验证无残留断链。**边界**：文件保留不断链（memory.md 索引/lifecycle/promotion/retrieval/governance 引用全保留）；通用概念单一事实源 = delx-memory-protocol/protocol.md。

## v1.18.0 — 规则边界审计 + Rule Diet + Agent Autonomy

> 本版本含**两个批次**：第一批 = 规则边界审计修正（去重 / 仲裁收敛 / 删除语义 / 豁免）；第二批 = Rule Diet + Agent Autonomy。同属未提交变更，版本号保持 1.18.0。

### 第一批：规则边界审计修正（去重 / 仲裁收敛 / 永不删除 / 豁免）

### 批次 0：去重（零行为变化）

| # | 变更 | 文件 |
|---|---|---|
| 1 | 删除 `review.md` 内联的硬约束 10 项打勾清单与判定表（声明指针后复制内容 = 自相矛盾），只保留指针 | `rules/review.md` |
| 2 | 合并 `skill-routing.md` 双份不路由清单（「优先不 Routing」+「不路由条件」→ 一节，并入 Level 0/1 与单步完成两条） | `engine/skill-routing.md` |
| 3 | 删除 `agent:vc_constraints` 中与 `safety.md §5` 重复的「指针页清理」段 | memory 条目 |
| 4 | `agent:vc_constraints` 修正旧键 `skill:system:metrics` → `skill:vibe-coder-loop:metrics`；删除硬编码条目计数 | memory 条目 |

### 批次 1：口径收敛

| # | 变更 | 文件 |
|---|---|---|
| 5 | **§3.5 重写为「记忆裁决边界（Memory 不参与 Rule Hierarchy）」**：删除「level:core Memory > R2 文件规则」等两行；`level:*` 仅用于 `skill:*` 条目之间定级；经验记忆一律 Advisory（不可否决文件规则）；唯二例外 = 用户显式指令 + `rule:` 型项目规则 | `policy/priority.md` + memory 条目 |
| 6 | 观察期升级 **level 封顶 `tactical`**（不再自动升 domain/core；升格需用户确认） | `learning/memory/promotion.md` + memory 条目 |
| 7 | 检索量红线拆为两条独立口径（单次调用返回量 / 每轮调用次数），`memory_get` 不计入；删除「Read 整读 2000 行」表述 | `learning/memory/retrieval.md`、`learning/memory.md` |
| 8 | **删除指令收敛为「Agent 永不物理删除」**：取消 kernel 唯一例外；Archived→Removed 改为输出「🗑 待删除清单」由用户执行；Memory 改标 `pending_removal`（不再 `memory_forget`） | `kernel.md`、`policy/safety.md`、`policy/lifecycle.md`、`rules/code.md`、`Vibe Coder.md` |
| 9 | 修正记忆中的旧键与死指针（observation-window / conflict-resolution / early-warning / query-router / memory-navigation / pattern:memory-writeback-integrity / skill-context-cost-baseline / rollback-point / rule:skill-iteration-manifest） | memory 条目 |

### 批次 2：豁免条款（防僵化）

| # | 变更 | 文件 |
|---|---|---|
| 10 | 硬约束新增「适用范围与豁免」：数值型（#1/#2/#3）仅约束**本轮新增或修改**的函数/文件；数据型文件与结构性函数豁免（须标注 `[豁免: <原因>]`）；判据 = 只豁免「形态天然如此」，不豁免「设计不好」 | `policy/safety.md §3` + memory 条目 |
| 11 | 资产型（#6/#7/#8）适用范围 = **用户既有资产**；本轮 Agent 自产草稿之间的替换不受限 | `kernel.md §2`、`policy/safety.md §3` |
| 12 | S5 出口改为**歧义触发式**：仅真实歧义才追问，无歧义标 `[无歧义]`；补判据（答案是否改变实现方案） | `engine/transition.md` |
| 13 | 扩展建议改为「Level 2+ 且确有价值时」，无真实项可省略 | `engine/transition.md`、`rules/review.md` |
| 14 | S2 主动关联召回（pattern/principle list）限 Level 2+，Level 0/1 跳过 | `engine/transition.md`、`SKILL.md` |
| 15 | `.state.md` 写入纪律改为**仅字段变化时写入**（S13 收尾仍必写一次 `status` + `resume`） | `engine/state-machine.md`、`engine/transition.md` |

### 批次 3：scope 纠偏与指针统一

| # | 变更 | 文件 |
|---|---|---|
| 16 | `lesson:hard-constraint-bypass` / `lesson:runtime-message-timing` 的 `scope:global` → `scope:project`（来源为本 Skill 自身 E4 测试，非跨项目规律） | memory 条目 |
| 17 | 映射表唯一主源统一为 `references/governance.md`（原 memory-navigation / rollback-point 条目误指 SKILL.md） | memory 条目 |
| 18 | 版本号 1.17.0 → **1.18.0**（v1.17.0 已提交 git，本批为新一轮未提交变更，按版本策略只迭代一次） | `manifest.yaml` |
| 19 | 清除硬编码条目计数（27 条）→ 以 `memory_list(prefix="skill:")` 实时核对 | `manifest.yaml`、`backup/README.md`、`backup/memory_tool.py` |

### 明确保留（审计结论：不动）

Level 0-4 + Loop Depth 矩阵 / 三条红线 / 资产生命周期 / Conflict Card / 角色隔离（Builder≠Verifier≠Critic）/ `skill-routing.md` 的「优先不 Routing + 防 Routing 循环」/ 压缩边界（Runtime 负责）/ E4「未观测」诚实标注 / 演化刹车（禁止想象增规则 + 观察期防抖）。
以上均为「规则帮助判断而非代替判断」或「硬约束用于真正不可逆之事」的正面结构。



> 版本依据：v1.16.1 已提交 git → 本批为新一轮迭代（新增协议，minor）。用户指令：`.state.md` 落 skill 目录 / 全量 P0+P1+P2 / E4 下发独立 agent。

**背景**：6 个已确认缺口（Durable State / E4 验证 / 规则膨胀 / no-progress / Profile 冲突 / Cost 元数据）。冻结决策不动：保留 12 阶段 + 五层 + Quick/Standard/Full + Complexity Gate + Profile=Router + SAFE MODE；Context Compression 与 Memory 阈值仍归外部（Runtime / delx-memory）。

### 第二批：Rule Diet + Agent Autonomy（判定去机械化 / 约束降级 / 治理下沉）


> 与第一批同属未提交的 **v1.18.0**（未提交期间版本号保持不变）。用户指令：执行 Rule Diet，只做已确认项、不新增规则；Archive/Lifecycle 只调边界不推翻。

**背景**：v1.18.0 后规则总量 3,834 行 / 237 KB、`必须` 80 处、`禁止` 64 处、出口 checkbox 95 个 —— 已进入"规则过度完整"阶段。本批目标：**规则更少、边界更清、Context 更轻，同时不降低安全与 Memory 边界**。

### 一、判定去机械化（Complexity Gate）

| # | 变更 | 文件 |
|---|---|---|
| 1 | 判定逻辑改为**三问 + 信号证据**：Q1 影响面 / Q2 不确定性 / Q3 可逆与风险。**文件数、行数、关键词一律降为 Signal，不得单独决定 Level** | `engine/complexity-gate.md` |
| 2 | 删除「Level 0 信号词（出现即判定）」与「高风险信号词强制升级」→ 合并为一张「信号 → 正确读法」表（提高关注度，不机械定级） | 同上 |
| 3 | 删除 Level 1/2/3/4 判据 4 节（与分级表同源）；分级表判据列改为「三问的典型结论」 | 同上 |
| 4 | 输出格式 6 字段 → **3 字段**（程度 / Level+Loop Depth+激活阶段 / 依据 + 存疑项） | 同上 |
| 5 | 「置信度 Low → 默认 Level 2」→ **progressive escalation**：从最低成本路径起步，出现升级阀（跨文件引用 / 假设被推翻 / 不可逆操作 / 验证失败）才升级 | 同上 |
| 6 | Level 0-Doc 的 30 行硬边界 → 按语义判（行数是信号非门槛） | 同上 |

### 二、约束降级（Hard → Signal）

| # | 变更 | 文件 |
|---|---|---|
| 7 | `#1 函数≤30行 / #2 文件≤300行 / #3 参数≤4` → **Review Signal**：不短路、不进情况 B，计入维度层 `issue_count`，由 Agent 判断是否存在真实可维护性问题 | `policy/safety.md` §3 |
| 8 | `#10 Confidence/Evidence 未标注` → **条件 Hard**：仅「多个合理解释 / 记忆与代码冲突 / 风险无把握」3 类场景未标注才算违反 | 同上 |
| 9 | 删除 v1.18.0 的「数值型豁免清单」补丁（根因是优先级错配，降级后不再需要）；保留「天然形态」说明（数据表/生成代码/switch 派发） | 同上 |
| 10 | Hard 收敛为 6 项：空错误处理 / 硬编码密钥 / 删除·覆盖用户既有资产 / 三重禁止 / 更换未标注 / 归档注释格式 | 同上 |

### 三、`rule:` 权限边界（新增契约，非新增规则）

| # | 变更 | 文件 |
|---|---|---|
| 11 | 新增 **§3.6 `rule:` 准入与权限边界**：7 问权限矩阵（仅用户可创建/修改/删除；scope 限 project·task；不得覆盖 R0/R1 与 `engine/` 流程；不得覆盖当轮用户指令；**Agent 自动生成的记忆永不能成为 `rule:`**）+ 准入四条件 + 加载纪律（scope 不匹配不加载） | `policy/priority.md` |
| 12 | 自动提升链（lesson → pattern → principle）明文**不得产出 `rule:`** | `learning/memory/promotion.md` |

### 四、Memory 检索：宁多勿漏 → 最小充分召回

| # | 变更 | 文件 |
|---|---|---|
| 13 | 「类型模糊时取并集（宁多勿漏）」→ **选最可能的一类起步，不取并集**；不足时按需二次检索；排序 Relevance > Specificity > Freshness > Frequency | `learning/memory/retrieval.md` |
| 14 | 主动关联召回 Step 0-4 从固定流程 → **按需执行**；Skill 规则条目默认按文件内摘要执行，仅摘要不足才 `memory_get` | 同上 + memory 条目 |

### 五、Confidence / Evidence：表格 → 不确定性工具

| # | 变更 | 文件 |
|---|---|---|
| 15 | 删除「必须标注的判断点」6 类 + 审查验证表 → **3 类必标场景** + 一张判定口径表（用到才查） | `policy/confidence.md` |
| 16 | **记忆与代码冲突不再构成 Low**（改 Medium/E3，以代码事实为准，标注后继续不暂停）—— 消除与 Memory Advisory 的冲突 | 同上 |
| 17 | 各阶段出口「Confidence 标注完成」→ 条件化（仅涉及不确定判断时） | `engine/transition.md` |

### 六、S12 治理下沉

| # | 变更 | 文件 |
|---|---|---|
| 18 | S12 五步清单 → **2 步收尾**：① Tool 一条命令（touch + metrics）② 有值得复用经验才输出待保存清单，**无则明文"本轮无沉淀"** | `learning/memory/promotion.md` |
| 19 | Promotion / Dedup / Merge / Consolidation / Relevance / supersession / 观察期 / Metrics 聚合落库 → 明确为 **Memory 系统职责**，Agent 不显式执行 | 同上 + `learning/skill-metrics.md` |
| 20 | 删除 Metrics 欠账机制（复杂度来源） | 同上 |
| 21 | Reflection 触发 10 条 → **3 条强制**（用户纠正 / Review 情况 B / 同类重复 ≥2）+ 7 条可选信号 | `learning/reflection.md`、`engine/transition.md` S11 门控 |

### 七、边界整理（Priority 2）

| # | 变更 | 文件 |
|---|---|---|
| 22 | Router 删除重复节：模式映射、高风险升级、任务分类参考表；三个 Quick Loop 细则合并为一张表 | `engine/router.md` |
| 23 | Skill Routing 164 行 → **Exception Path**：默认不 Routing，出现能力缺口才三步路由；删除四问强制、候选来源表、数据库示例、出口条件（防 Routing 循环保留为唯一硬约束） | `engine/skill-routing.md` |
| 24 | 角色 7 → **4**（Architect / Builder / Verifier / Critic 保留，其余降为 Phase Label）；同步 state-machine / orchestration / manifest | 4 文件 |
| 25 | Review 删除测试报告摘要格式块、上下文缺失段（前者与 `skill:` 条目重复，后者与 code.md 重复） | `rules/review.md` |
| 26 | **删除保护边界修正**：区分「用户既有资产」（无指令禁删 / 用户明确指令可删）与「普通代码」（本轮自产 / 用户要求移除 / 授权重构范围 → 可删·可替换·可移动·可重构）。Archive/Lifecycle 四阶段机制**保留不动** | `kernel.md`、`policy/safety.md`、`policy/lifecycle.md` |
| 27 | Level 1 自测「≥1 可运行用例」→「≥1 项可观察验证」（用例 / 类型检查 / 编译 / 运行结果） | `complexity-gate.md`、`router.md`、`rules/test.md` |
| 28 | S8 出口 TASK 区可见性分级：Level 2+ 全量字段 / Level 1 精简版 / Level 0 标签 | `engine/transition.md`、`engine/state-machine.md` |

### 八、Rule Composition Test（独立 fresh-context agent 实跑 5 案例）

| Case | 结论 |
|---|---|
| 1 简单任务（变量改名） | L1 Quick Loop，**S5/S6/S7/S11/S12 全跳过**，无 Planning / 无 Routing / 无 Memory 治理 —— 阶段级快 |
| 2 普通任务（加字段） | L2 Standard，分析→实现→验证完整，无被挡行为 |
| 3 复杂任务（跨模块迁移） | L3 Full Loop，完整工程流程 + 编排 + Reflection，符合预期 |
| 4 Memory 与代码冲突 | **允许选 computed**（§3.5 经验为 Advisory + retrieval 冲突优先级） |
| 5 用户要求删文件 | 冲突预检 → S3 Conflict Card → 按新边界执行（普通代码可删 / 用户既有资产需明确指令） |

**测试暴露并已修复的 3 处残留冲突**：① kernel「永不删除」vs lifecycle「用户明确指令可删」（已对齐）；② confidence「记忆冲突 → Low → 暂停」vs Memory Advisory（已改为 Medium 不暂停）；③ S11 门控仍是 10 条（已同步为 3 强制 + 可选）。

### 版本与同步

- 版本号保持 **1.18.0**（未提交期间不迭代；`manifest.yaml` 不变）
- Memory 条目同步 11 条：`agent:vc_constraints`、`skill:rules/review:hard-constraints`（重写）、`skill:learning/reflection:triggers`（重写）、`skill:learning/memory:query-router`、`skill:rules/code:prechecks`、`skill:rules/review:verdict-path`、`skill:rules/review:five-dimensions`、`skill:rules/intent:goal-triple`、`skill:policy/priority:conflict-resolution`、`skill:learning/metrics:fields`、`skill:rules/test:degradation`

### 第三批：一致性收敛（Rule Composition Test 暴露的残留）

> 与第二批同属未提交的 **v1.18.0**。来源：独立 fresh-context agent 实跑 5 案例（简单 / 普通 / 复杂 / Memory 冲突 / 用户要求删除），逐条对照 `file:line` 复核第二批改动的**下游一致性**。**不新增规则**，只收敛残留冲突。

| # | 发现 | 修复 |
|---|---|---|
| 1 | S12「5 步 → 2 步」未传播：`transition.md` 仍写「执行 5 步（含 ④Metrics 硬性出口 / 欠账机制）」、`rules/review.md` 写「执行 5 步」，`advanced.md`/`promotion.md`/`memory.md`/`governance.md`/`architecture.md` 仍引用旧节名「S12 Memory Evolution 最小执行清单」，`skill-metrics.md`/`state-machine.md` 仍用旧步骤号 [3]/[4] | 全部对齐「S12 收尾（2 步）」（`transition.md`、`rules/review.md`、`promotion.md`、`advanced.md`、`memory.md`、`memory/architecture.md`、`memory/lifecycle.md`、`references/governance.md`、`SKILL.md`、`skill-metrics.md`、`state-machine.md`） |
| 2 | 删除权限自相矛盾：`kernel.md` §2 / `safety.md` §1 / `lifecycle.md` 允许「用户明确指令 → 物理删除」，但 `rules/code.md`「Agent 永不物理删除」、`priority.md`「不能物理删除」、`profiles/refactoring.md`「禁止物理删除」仍会机械拒绝（直接决定 Case 5 行为） | 按 R0 对齐：三处改为「禁止**自主**删除；用户明确指令 → 先出 Conflict Card 列清单后执行；普通代码可直接删改」 |
| 3 | 召回取并集残留：`transition.md` S2 出口强制 `pattern:` + `principle:` 双 list、`SKILL.md` 同框定，与 `retrieval.md`「不取并集」冲突 | 改为「按需，不取并集（取最相关一类）」 |
| 4 | Hard 违规路径口径不一：`kernel.md` §4.1 / `complexity-gate.md` 写「回退 S8、不进 S10」；`transition.md`/`rules/test.md`/`safety.md` 写「→ 情况 B」 | 补 Level 限定：Level 0/1 内联回退；Level 2+ 审查发现 → 情况 B |
| 5 | 30/300/4 降级未传播：`references/e4-matrix.md` 测试 C 仍以「>30 行」当硬约束违反输入（按新规则该测试永不成立）；`rules/orchestration.md` 验收项仍把行数/参数与 Hard 并列 | 改为真实 Hard 项（空 catch / 硬编码密钥 / 未删用户既有资产）；`orchestration.md` 区分 Hard / Signal |
| 6 | 死指针：`rules/test.md` →「角色人格化约束」（实际「角色约束」）；`complexity-gate.md`/`safety.md` →「Quick Loop 模式细则（Level 0-Doc，内容写作型）」（实际「Quick Loop 细则（L0 / L0-Doc / L1）」） | 3 处指针改名对齐 |
| 7 | 计数错误：「Level 0 文档修改约束子集」被 5 处称为 **5 项**，实际 4 项 | 5 处改为 4 项 |
| 8 | Confidence 宽口径：`rules/code.md`「关键判断必须标注」与 `confidence.md`「仅 3 类场景」不一致 | 收窄为 3 类场景 |
| 9 | 「并集」歧义：`SKILL.md` 加载表「冲突取并集」易被误读为记忆召回 | 标注「仅指文件加载范围，与记忆召回无关」 |
| 10 | `reflection.md`/`transition.md` S11 强制触发 ②「情况 B」在直接路径不可达（S11 仅自情况 C 进入） | 改为「本轮**曾发生**情况 B」 |

**保留不动（有意为之）**：仪表盘「每轮必更，0 事件也更新」（用户全局授权）；`SKILL.md` 加载范围取并集（下限/上限语义）；记忆键名 `skill:rules/review:five-dimensions`（内容已 8 项，改名属记忆键迁移，需用户明确指令）；旧键 `skill:system:*` 保留。

**验收**：残留扫描 0（S12 旧模型 / 角色 / 版本 / 死指针 / 5 项计数 / 30-300 硬框定 / 机械拒绝 全为 0）；`memory_tool.py` 18/18 自测通过；快照 `verify` 与库一致（42 条）。

### 第四批：Final Stabilization（Skill ↔ delx-memory 一致性审计 + 边界验证）

> 与前三批同属未提交的 **v1.18.0**。性质：**收口验证**，不新增规则、不重设计。审计 42 条 `skill:*` / 3 条 `rule:*` / 43 条 `lesson:*` / 19 条 `reflection:*` / 2 条 `pattern:*` / 2 条 `preference:*` / 51 条 `project:*` + `agent:vc_constraints`。

**Skill 侧（2 处明确冲突，最小修正）**：

| # | 文件 | 冲突 | 修正 |
|---|---|---|---|
| 1 | `rules/orchestration.md` | 子 agent「即受 **10 项**约束」与 `safety.md` §3（Hard 6 / Signal 3 / 条件 1）冲突 | → 「Hard 6 项 + Signal 判定 + 三红线 + 生命周期」 |
| 2 | `rules/design.md` | 记忆交叉验证「明显冲突 → **暂停追问**」与 `policy/confidence.md`（记忆与代码冲突 → Medium/E3 继续、**不暂停**）冲突 | → 以当前代码事实为准（Medium/E3），标注后继续并列入待决策清单，不暂停 |

**Memory 侧（12 条陈旧/冲突条目对齐，0 条删除）**：

| # | 条目 | 问题 | 处理 |
|---|---|---|---|
| 1 | `skill:rules/review:case-templates` | 引用 Skill 已删除的「硬性约束检查（10 项打勾）」与「上下文缺失段」；S12 5 步 / Reflection 10 条 | 对齐 Hard 6 项指针 + S12 收尾 2 步 + 3 强制触发；删陈旧段 |
| 2 | `skill:rules/review:hard-constraints` | 元数据 title「10 项」 | →「Hard 6 / Signal 3 / 条件 1」 |
| 3 | `skill:learning/metrics:early-warning` | `auto_rule` 写「S12 观察期检查后」；保留已删除的「仪表盘欠账」机制；「S13 出口聚合」由 Agent 手写 | 系统观察期事件时 / `📌 仪表盘未更新`（无欠账队列）/ Tool 聚合 |
| 4 | `skill:learning/metrics:fields` | 同一条目内「S12 必须聚合落库」与「周期聚合由系统承担」自相矛盾 | 统一为系统聚合落库 |
| 5 | `skill:learning/memory:observation-window` | 步骤号 `[3]` 已不存在；「Agent 自动执行升级/降级」与 `promotion.md`「Agent 侧动作：无」冲突 | 系统执行（降级为 S12 [2]），Agent 不显式调用 |
| 6 | `skill:learning/reflection:triggers` | title「10 条」；触发 ②「Review 判定情况 B」在 S11 直接路径不可达 | 3 强制 + 7 可选；「本轮曾发生情况 B」 |
| 7 | `skill:learning/reflection:card-template` | 旧编号 `#1-#10` / `#7-#10` | 强制 #1-#3 / 可选信号 |
| 8 | `skill:learning/memory:query-router` | Quick Loop 闭环仍要求「Agent 显式去重」；「宽泛检索所有相关记忆」与最小充分召回冲突 | 去重归系统；按需检索最相关一类（不取并集） |
| 9 | `skill:rules/plan:step-orchestration` | 引用已删除的 Skill Routing「四问」 | 改为「能力缺口驱动」判据 |
| 10 | `skill:learning/evolution:trigger-conditions` | 「S12 中自动提升」步骤绑定 | 系统自动提升 |
| 11 | `skill:rules/design:mirror-sync` | 同 Skill 侧 #2（记忆冲突 → Low → 暂停） | 同左 |
| 12 | `agent:vc_constraints` | 「硬约束10项」×2 | Hard 6 / Signal 3 / 条件 1 |

**验证结论**：`rule:` 权限边界 7 问全部成立（Agent 不能创建/升级/跨项目/覆盖指令；自动提升链禁产 `rule:`）；Priority Composition Test 4/4 PASS；Necessary Memory Miss 3/3 PASS；Context 按需注入成立（`skill:` 按 key 加载、`rule:` 仅 scope 匹配、经验记忆不注入）；默认路径 ≠ 强制路径（Complexity 三问 / Memory 有界召回 / S12 可只做 [1]）。

**唯一未处理项（已闭合）**：`rule:image-gen-dispatch` 缺 `scope:` 标签（§3.6 要求 project·task）——属 `rule:` 条目，**仅用户可修改**，故第四批只报告不改。→ **同版本 Close-out 轮经用户指令裁定补 `scope:task`**：依据 = 内容为图像生成渠道调度（imperative + 5 key 轮换 = 强制规则，非软偏好，故不降级 `preference:`）；无项目绑定（跨项目，故非 `scope:project`）；「图像生成」为任务类（同 `rule:skill-iteration-manifest` 的 `scope:task` 语义）。已落库 + verify 一致（42 条）。

### 批次 5：Consistency Repair（4 项定向验证 + 最小修复）

> 与前述同属 **v1.18.0**。性质：定向一致性验证；仅修复被证实为真的问题。

| # | 项 | 验证结论 | 修复 |
|---|---|---|---|
| 1 | `references/governance.md` 类型判定 | **1A 非冲突**：`priority:conflict-resolution` 的「类型 A」与「core+reference」是正交两维（前者 = Canonical Source 归属，后者 = 条目定级/性质）。**1B 真问题**：`decision-arbitration` 自称 `policy/safety.md` §2 为唯一事实源（`rules/intent.md` 同），属类型 A 指针，但 L16 类型 A 清单漏列、L26 未标指针 | L16 补入 `decision-arbitration`（完整协议在 `policy/safety.md` §2）；L26 标注「类型 A 指针」 |
| 2 | 早期预警阈值 25% / 15% | **真冲突**：同一统计对象 + 同一动作（S10 预警 + 早期 Reflection），文件写 **25%**（`skill-metrics.md`、`transition.md`），类型 C 正本条目写 **15%**；CHANGELOG 已载「early-warning 阈值统一 15%」→ 正本 = 15% | 两文件 25% → **15%**；并补**语义隔离**：`skill-metrics.md` 注明「S10 运行时预警」、`evolution.md` 注明「Evolution 触发条件」，两者同数据不同动作、不可互相替代（数值不改） |
| 3 | `rules/orchestration.md:67` Verifier 强制 | **真冲突**：`:67`「强制 Verifier subagent」与同文件 `:29`「subagent 优先（不可用则降级自测）」及 `rules/test.md:17` 冲突 | `:67` → 「**优先派发** Verifier subagent；不可用则降级自测但仍须视角隔离」 |
| 4 | CHANGELOG ↔ 实际 Memory | **metrics 一致**：第四批声明的 2 条 metrics 条目（`early-warning` / `fields`）与 DB 实际文本一致（无 3 条 metrics 声明，用户前提不成立）。**真不一致**：CHANGELOG「唯一未处理项」与仪表盘 `note` 仍称 image-gen scope 待裁定，而 DB 已 `scope:task` | 以 DB 为事实源：CHANGELOG 该行标记「已闭合」；仪表盘 note 更新为本轮摘要 |

**回归**：`25%` 残留 0（规则文件）｜`强制 Verifier` 残留 0｜governance 类型 A 清单与映射表一致（3 条指针条目均标明正本）｜CHANGELOG / 仪表盘 与实际 DB 状态一致（`scope:task` 已落库）。



> 版本依据：v1.17.0 已提交 git → 本批为新一轮未提交变更（规则边界审计落地，minor）。用户指令：批次 0→3 按序全执行 / Memory 不参与 Rule Hierarchy / 永不物理删除只归档 / 硬约束加豁免 / 批量一并做。（其中「永不物理删除」已由第二批按后续裁定修正为「用户明确指令下可删 / 普通代码可直接删改」，见 `kernel.md` §2；此处保留当时指令原文。）

**背景**：对 Skill × delx-memory 做规则边界审计（只读，E2 逐文件核对，覆盖 40 个规则文件 + 172 条记忆），识别出完全/语义重复 15 项、内容重叠 5 项、规则冲突 12 项、过度约束与干扰判断 6 项。本批为**已确认项**的落地，覆盖批次 0（纯删冗余）→ 批次 3（scope 纠偏）全部。

### 批次 6：Agent Kernel 精简（身份层去复制）

> 与前述同属 **v1.18.0**。性质：Agent Kernel（`agents/Vibe Coder.md`）瘦身，身份层不再复制已抽离技能的协议细节。

| # | 变更 | 文件 |
|---|---|---|
| 1 | 「Skill 调度规则」+「加载 Skill」合并为「Skill 调度与加载」一节；删除三 skill 路径表与子文件绝对路径列表，收敛为「获取技能（发现机制）+ 兜底（绝对路径）+ 记忆兜底」三行 | `agents/Vibe Coder.md` |
| 2 | 「记忆系统」模块删职责边界细节（三层体系/命名空间/TTL/supersession 等已由 `delx-memory-protocol` 承载），保留身份声明 + 双事实源指针（通用协议→delx-memory-protocol；出口回写→vibe-coder-loop/learning/memory/） | 同上 |
| 3 | 「记忆回写检查清单」从 3 项 checkbox 压缩为身份指针（计数回写 + 仪表盘两行），完整清单委托 `vibe-coder-loop/lifecycle.md`；**不并入 delx-memory-protocol**（该技能只定义协议不承载出口时机，回写清单属宿主出口绑定） | 同上 |

**行数**：150 → 115（-35 行，-23%）。**边界**：回写清单不并入 delx-memory-protocol——该技能 SKILL.md/protocol.md 明确「只定义协议，不定义工程任务的出口/回写时机；出口时机由宿主 Skill 承载」。


## v1.17.0 — Durable Workflow State + 异常路径收敛 + 运行时验证矩阵

### 变更清单

| # | 缺口 | 变更 | 文件 |
|---|---|---|---|
| 1 | Durable State | 新增「Workflow Checkpoint（`.state.md`）」协议：12 字段（**10 项映射既有 TASK 区，仅 `status` / `resume` 新增**）+ 读写时机 + 恢复协议（freshness / 字段完整性 / 不覆盖 TASK·ACTIVE / `completed` 不重做） | `engine/state-machine.md` + 新建 `.state.md` |
| 2 | Durable State | 接线：S1 循环开始读、S4 出口确认已写、S13 出口 `status: complete`；SKILL.md 加载时机索引新增 2 行 | `engine/transition.md`、`SKILL.md` |
| 3 | 规则膨胀 | 压缩节同义重复合并（「Skill 不设阈值」3 处并 1；信息获取规范 4 bullet → 1 句 + 指针） | `engine/state-machine.md` |
| 4 | 异常路径 | 新增「异常路径收敛表」：**Retry / Rollback / Pause / Safe Mode** 4 类 + 非异常 3 类（Queue / Runtime Recovery / Degradation） | `engine/state-machine.md` |
| 5 | no-progress | SAFE MODE 触发表新增「**无进展（No Progress）**」——连续 2 次 Code→Review 满足 issue 未解决 / issue 数未下降 / Test 结果无改善之一 | `kernel.md` §5 |
| 6 | Profile 冲突 | 新增 Profile 优先级 `skill-maintenance > debugging > planning > refactoring > review > coding`（取最左，不叠加加载，不评分） | `SKILL.md` |
| 7 | E4 验证 | 新建验证矩阵：Test A–F + 7 字段证据模板 + D 的诚实边界（Compaction 不可伪造） | 新建 `references/e4-matrix.md` |
| 8 | Cost 元数据 | `cost.profiles` 描述性标签（集中 manifest，**不写入 6 个 profile 文件**）；显式禁止 `max_tokens_per_phase` 类运行时限制 | `manifest.yaml` |
| 9 | 规则膨胀 | **P2-2 拆分**：`promotion.md` 的 5 个触发式/周期式协议（跨项目模式迁移 / Relevance 评分 / 事实时序 supersession / Memory Consolidation 8 Phase / 跨项目失效传播）下沉新建 `learning/memory/advanced.md`，**不进 S12 默认路径**；promotion.md 保留 S12 必经 + 1 张触发条件指针表 | `learning/memory/promotion.md`、`learning/memory/lifecycle.md`、新建 `learning/memory/advanced.md` |
| 10 | 加载浪费 | **S11 门控**：`reflection.md` 改为「先按 engine 门控判定，未命中不加载」（E4 实测 0 使用）；`memory.md` 索引 + `governance.md` canonical 列表同步 | `SKILL.md`、`learning/memory.md`、`references/governance.md` |

### E4 真机验证（5 个独立 agent，副本内执行，原始目录零改动）

| 测试 | 结论 | 等级 | 关键发现 |
|---|---|---|---|
| A Standard Loop S1→S13 | **FAIL** | **E4** | 产物 100% 达成（pytest 3 passed）但 **`.state.md` 仅 7/13 出口写入**；S8 出口未输出 TASK 13 项。成本审计：真机加载 24 文件 / 169KB ≈ **42.3K tokens**；「读了但 0 使用」3 文件、「只用了 1 节却全量加载」3 文件 ≈ **8.2K tokens 纯浪费** |
| B Test 失败回退 | PASS | E4 | Loop 1→2 正确、未被重置；Code[2] 真实引用上轮失败原因（非凭记忆） |
| C Review 情况 B | PASS | E4 | 硬约束违反 ×6 → 情况 B → S6[0] → Code[2]，Loop 不重置正确 |
| E Steering | PASS | E4 队列+转移 / E3 注入时机 | 不暂停、队列注入、Loop 保持；**外部真实注入时机**无法由 Agent 自造 |
| F Follow-up | PASS（机制层） | E4 队列+转移 / E3 注入时机 | S13 后回 S1、不计新任务；**S13 follow-up 检查与真实 Runtime 消息时序矛盾** |
| D-1 跨会话恢复 | 机制可恢复 / **语义陈旧** | **E4** | 另一会话写的 `.state.md` 被全新 agent 真机读取：freshness 通过、12/12 齐全、入口=Phase 2；**但 3/6 pending 是幽灵待办**（文件已落盘、checkpoint 未回写） |
| D-2 Compaction 存活 | **未观测** | E3 | 真机加载 ~28K tok 后 Runtime **仍未压缩** → 压缩契约维持 E3，不得标 E4 |

**据 E4 做的 3 处修复（只修本轮自己引入的缺陷）**：

| # | E4 发现 | 修复 |
|---|---|---|
| 修复 1 | Test A：S1 节「每个阶段出口必须更新**本文件**」指代不明（字面指向 transition.md，改它为违规） | 改为「更新 `.state.md`」+ 补「未触发阶段也须记一行」 |
| 修复 2 | Test C：异常路径收敛表 Rollback 行把「Loop +1」泛化到整类，与 `kernel.md` §7 冲突（Level 0/1 修复与降级**不递增**） | 行内限定：「**仅 Test 失败 / Review A·B 递增 Loop**」 |
| 修复 3 | Test B/C：TASK ⑨（上一阶段输出指针）与 ⑩（上轮失败原因）在 12 字段中**无落点**，原「10 项映射」断言不成立 | 明确 ⑨→`resume`、⑩→`review.last_failure` 承载；`updated_at` 要求**到分钟**；恢复协议新增**第 5 步「pending 逐项核验」**（防幽灵待办） |

### 债务修复轮（D1 / D2 / D4，用户指定顺序）

| # | 债务 | 修复 | 文件 |
|---|---|---|---|
| **D1** | S12 [4]「Metrics 落库（硬性出口，缺失 = S12 未完成）」与 `memory_set` 必须 `explicit_user_intent=true` +「用户不确认则本轮不写入（不阻塞循环）」**结构性矛盾** → 无用户确认的循环**永远无法完成 S12** | 重定义出口为「**已提交**」：**落库 或 记欠账任一即合规**，仅"两者皆无"才判 S12 未完成；明确「记欠账 = 合规完成态，非失败态」 | `learning/memory/promotion.md`（[4] + 欠账项段）、`engine/transition.md`（S12 节）、`learning/skill-metrics.md`（分工表 + 核心机制） |
| **D2** | `learning/skill-metrics.md`「运行级闭环复查」触发条件引用 `verify.runtime_check`，该字段**从未在 `skill:system:metrics` 中落地** → 检查静默失效 | **废除该一次性迁移检查**（触发不可满足），改记「已闭环」+ 列明其验收目标已由实证据闭环（`skeleton.entries` 28 条 / 31.1KB、仪表盘 upsert 每轮实跑、`skill:*` access_count 递增） | `learning/skill-metrics.md` |
| **D4** | 压缩契约「会话内压缩」维度仍 E3（未观测），提醒为被动式，真机发生时可能不留证据 | ① **收窄断言**：「跨会话恢复」维度**已取 E4**（Test D-1），不再整体声称"未验证"；② 提醒升级为**可交付采集**：`e4-matrix.md` 新增「**D-3 现场采集卡**」（含逐项自检 + 填完必做的 3 步）；③ 矩阵表 D 行拆为 D-1/D-2/D-3 状态 | `engine/state-machine.md`（提醒块）、`references/e4-matrix.md` |

**D4 未闭合声明**：会话内压缩存活**仍为 E3**——Agent 无法制造 Runtime 压缩，不得伪造；须等真实长会话触发后按 D-3 采集卡取证。

**新增债务 D8**（D2 排查中发现 → **已于下方「D8 修复轮」修复**）：`skill:system:metrics` 为**跨 skill 共用键**，真实值中混入其他 skill 字段（`skill_version` / `verify.*` / `updated_by` 指向另一项目）→ 两 skill **互相覆盖**。本 Skill 已声明「只写自身字段、不读 `verify.*`」；是否改用独立命名空间键**待用户裁定**（影响 Agent Prompt 指定键 + Tool + 多处引用）。

### 削减轮 + E4 复跑（用户指令「先完成 token 削减，然后 E4 复跑」）

**① token 削减（-355 tok）**——只压缩措辞，不动语义：

| 文件 | 削减 | 内容 |
|---|---|---|
| `kernel.md` | -110 | D3 双队列 3×4 表 → 3 行紧凑列表（保留语义×时序全部判据） |
| `engine/state-machine.md` | -130 | D5 角色节 6 行 → 3 行（保留"视角隔离不降级 + 2 项最低要求"） |
| `engine/transition.md` | -115 | D6 两把尺子 3 行说明 → 1 行；D7 出口项精简 |

**② E4 复跑（2 个独立 agent，副本内真机执行，原始目录零改动）**：

| 复跑 | 结论 | 等级 | 验证点 |
|---|---|---|---|
| **Test B**（D7 + D6） | **PASS** | **E4** | S9 失败后先做「硬约束不豁免」检查 → 物理删除 + 34 行函数 → **走 S10 情况 B**（非"测试失败"修补路径）；D6 `issue_count` 只计维度层 2 条、`hard_violation_count` 独立数出 2，无混计。修复后 2/2 通过 |
| **Test F**（D3） | **PASS** | **E4** | follow-up 后 S1/S2/S4 全程 `[Loop: 0]`（未继承主循环 loop=1），首进 S8 才 =1；S1 前真机读 `.state.md` + pending 逐项核验（ls + pytest） |

**复跑发现 → 补一行**：steering（改本轮回合产物）vs follow-up（主循环结束后新目标）在"顺便把函数改成…"类消息上判据重叠 → `kernel.md` 补「重叠判定：按 follow-up 关键词优先」。

**③ 累计 token 终态**（vs git HEAD，bytes/4）：

| 口径 | Δtok |
|---|---|
| 循环路径 9 文件（含 `.state.md`） | **+2823** |
| ＋ S11 reflection 门控（未触发时不加载） | **+1908** |
| − `.state.md`（Task 1 必要载体，含本轮会话累计的实例数据） | **+1324** |

> 数字说明：`+1817`（削减轮初报）与最终 `+2823` 的差异，**全部来自 `.state.md` 实例数据随多轮会话增长**（1065→1499，+434，即 completed 21 项 + decisions 13 项在积累）+ 逐轮口径合并。规则文件本体（除 .state.md）净增 ⊂ +1324 口径内，其中削减轮净回收 355。

### S12 轻量化 + 产物清理（用户指令）

**S12 阶段加载 −801 tok/循环**（E4 依据：Test A 复跑实测 S12 读 4 文件 36KB，其中 evolution.md 737 tok 零使用——无 Skill Patch Proposal 候选）：

| 变更 | 效果 |
|---|---|
| `learning/evolution.md` **门控**（同 S11 reflection 模式）：仅 S12 [3] 出现 Skill Patch Proposal 候选才读，未出现跳过 | -737 tok/循环（Standard/Full） |
| `learning/skill-metrics.md`「S12 输出摘要格式」模板下沉 `advanced.md`「周期 Metrics 输出模板」：周期落库/月度聚合时才读 | -64 tok/循环（模板 111 移按需文件） |
| **lifecycle.md 未动** | 其「用户偏好记忆系统」节被 `kernel.md` §4 / `priority.md` 节级引用，下沉会断链；风险 > 收益 |

**产物清理**：删除 8 个 E4 复跑副本（vcl-testA/B/C/D/EF、vcl-reA/B/F，共 ~110MB）+ 4 个临时补丁脚本。`opencode/` 临时目录中其他项目文件未触碰。

### 记忆更新 + 备份 + Test A 复跑（用户指令「Kernel 记忆更新，然后执行备份，最后复跑 Test A」）

**① Kernel 记忆更新**（3 条 lesson，均走经验质量审计，E4 实证）：

| key | 内容 |
|---|---|
| `lesson:runtime-message-timing` | Runtime 消息只能 turn 间到达 → 队列协议须分 turn 内/间两路径（D3） |
| `lesson:hard-constraint-bypass` | 测试失败路径可绕过硬约束审查 → 硬约束门控必须先于失败转移（D7） |
| `lesson:checkpoint-instance-growth` | checkpoint 实例随会话增长 → token 口径固定（含 .state.md 的 diff 会失真） |

同步 `SKILL_LINKED_KEYS` + `backup/README.md` 备份范围（10→13 条），重新 backup。

**② 备份**：快照 **42 条**（+3 lesson），`verify` 全一致，`test_memory_tool.py` 18/18 OK。

**③ Test A 复跑（独立 agent，副本真机，原始目录零改动）→ PASS（E4），上次 6 个 FAIL 点全部修复**：

| 复跑项 | 上次 FAIL | 本次 |
|---|---|---|
| Checkpoint 写入纪律 | 7/13 | **13/13**（S3/S11 显式记"未触发"） |
| S8 TASK 区可见性 | 0/13 | **13/13 全出** |
| S12 Metrics 硬出口 | 无确认卡死 | 工具层落库成功（EXIT=0），不依赖用户确认 |
| S9 降级自测对抗性 | 无要求 | 测前写 7 条假设 + 反证 4 组 |
| Review 两把尺子 | 语义混合 | issue_count 只计维度层=0 / hard_violation_count 独立 |
| D7 硬约束不豁免 | 无门控 | 出口项已执行（本轮"不涉及"） |

成本：真机加载 24 文件 / **174KB ≈ 43.5K tokens**；分级加载生效（transition/state-machine 各 1 次读取多出口复用）。**剩余最重：S12 读 4 份 learning 36KB（信息量大但不再"卡死"）**。

### 债务修复轮 II（D3 / D7 / D6 / D5，用户指定顺序）

| # | 债务 | 根因（E4 证据） | 修复 |
|---|---|---|---|
| **D3** | S13「follow-up 队列检查」与真实 Runtime 消息时序**矛盾** | Test F：用户消息只能在本轮 turn 结束后到达 → "S13 前注入"在真机不可满足 | 重写 `kernel.md` §1 双队列为**语义 × 时序**双维表：turn 内（预缓冲）保持原队列语义；**turn 间（真机常态）** steering=下 turn 直接执行不重走 S1；follow-up=新任务 **Loop 归 0** 但**先读 `.state.md`** 恢复+核验 pending。状态转移图、S13 检查项、E4 Test F 判据同步 |
| **D7** | 物理删除类违规可被「Test 失败 → Code[N+1]」路径**绕过** Review 情况 B | Test C：物理删除致 Test 首跑 ENOENT → 走"测试失败"路径，硬约束违反被当普通 bug 修掉 | `transition.md` S9 出口新增「**硬约束不豁免**」：回退前先判硬约束违反 → 命中则**不得以"测试失败"名义修补**，改走 S10 情况 B；`rules/test.md` 串行门控补例外指针 |
| **D6** | 硬约束短路后「≥6 处」阈值**不可达**，`issue_count` 语义混合两类问题 | Test C：硬约束是二值门（>0 即 B），计数到不了 6 | `transition.md` S10 + `rules/review.md` 第三步明确**两把尺子**：硬约束层=二值门（`hard_violation_count`>0 即 B，短路）；`issue_count` **只计维度层问题数** |
| **D5** | S9「强制派发 subagent」在本机 Runtime 不可满足 → 写测分离硬约束不可达 | Test A/B/C：无派发工具时恒降级 | `state-machine.md` 角色节拆分**硬约束 vs 手段**：不可降级=**视角隔离**；可降级=subagent 派发；降级必须满足 2 项最低要求（**先声明预期** + **主动找反证**）。`rules/test.md` "强制派发"→"优先派发" |

**冻结决策不动**：角色隔离原则保留（只是把"手段"与"本质"分开）；Loop 计数器上限（3）与 Quick Loop 1 轮上限不变。

**未新增机制**：D3 是时序路径补全（非新队列）、D7 是路径门控、D6 是字段语义澄清、D5 是降级要求细化。新增"规则"=0（均为既有规则的口径修正）。

### 遗留债务（本轮不修）

| # | 债务 | 来源 |
|---|---|---|
| D4' | 压缩契约「**会话内压缩**」维度仍 E3（已收窄断言，未闭合；非本轮可解） | Test D-2 |

### 已修债务（历史记录）

| # | 债务 | 修复轮 |
|---|---|---|
| D1 | S12 [4] 硬性出口与 `memory_set` 门控矛盾 | 债务修复轮 |
| D2 | `verify.runtime_check` 死指针 → 检查静默失效 | 债务修复轮 |
| D3 | S13 follow-up 时序矛盾 | 债务修复轮 II |
| D5 | S9 强制派发不可满足（拆分硬约束/手段） | 债务修复轮 II |
| D6 | `issue_count` 语义混合 | 债务修复轮 II |
| D7 | 物理删除可绕过 Review B | 债务修复轮 II |
| D8 | 仪表盘/回滚锚点键跨 skill 共用 | D8 修复轮 |

| # | 债务 | 来源 |
|---|---|---|
| D3 | S13「follow-up 队列检查」要求消息在 S13 前已在队列；真实 Runtime 用户只能在本轮结束后发消息 → 该路径真机仅在预缓冲时可满足 | Test F |
| D4' | 压缩契约「**会话内压缩**」维度仍 E3（已收窄断言，未闭合；非本轮可解） | Test D-2 |
| D5 | S9「强制派发 subagent」在本机 Runtime 无派发工具时恒走降级，写测分离硬约束不可满足 | Test A/B/C |
| D6 | `rules/review.md` 硬约束短路后「≥6 处」阈值在硬约束层不可达，`issue_count` 语义混合两类问题 | Test C |
| D7 | 物理删除类违规可被「Test 失败 → Code[N+1]」路径绕过，不进 Review 情况 B | Test C |

### D8 修复轮（命名空间隔离，用户指令「改独立键」）

| 项 | 旧键 | 新键 |
|---|---|---|
| 仪表盘 | `skill:system:metrics`（**跨 skill 共用**，实测被他 skill 覆盖） | **`skill:vibe-coder-loop:metrics`** |
| 回滚锚点 | `skill:system:rollback_point` | **`skill:vibe-coder-loop:rollback-point`** |
| 命名规范 | 无（`system` 前缀无 owner） | **`skill:<skill-name>:<slug>`**；**禁止 `skill:system:*`**（规范落 `memory/architecture.md`「命名空间隔离」） |

**迁移策略（数据所有权不可分辨时的处理）**：

- **仪表盘 → 0 基线起算**：旧键数值混入他 skill 事件（`conflict.last`「dpp_tool_exec_ 缓存」、`rollback.last`「.understand-anything」均非本 Skill），**不搬运任何计数**；旧值全文存入新键 `migrated_from_note` 供审计。**唯一沿用** `skeleton.entries/bytes_saved`（骨架化机制为本 Skill 专属，无混入风险）
- **回滚锚点 → 原值整体搬运**：数据经核验全为本 Skill 自身（scope 列出的 27 条均为本项目 `skill:*` 条目）
- **旧键保留不删**——`skill:system:metrics` 内含他 skill 数据，删除属不可逆操作，**需用户明确指令**

**改动点位**：`backup/memory_tool.py`（`DASHBOARD_KEY` 常量 + 注释）/ `backup/test_memory_tool.py`（8 处 fixture 字面量）/ `learning/skill-metrics.md` / `references/governance.md`（映射表 2 行 + 类型判定注）/ `learning/memory/promotion.md` / `learning/memory.md` / `policy/priority.md` / `learning/memory/architecture.md`（命名规范新增）/ `raw/ai/agents/Vibe Coder.md`（Agent Prompt 仪表盘契约 2 处）/ `llmwiki/ai/vibe-coder-loop.md`

**验证**：`python3 backup/test_memory_tool.py` **18/18 OK**；`memory_tool.py metrics --counts` 实测写入新键成功（`conflict=0 | retrieval=0 | skeleton=28e/31100B`）

### 明确未做（有意）

| 候选 | 判定 | 原因 |
|---|---|---|
| 「唯一事实源」跨文件批量瘦身 | 不执行 | 收益 ~120 tok/循环 < 触及 6 个 profile 文件的风险，且与「禁止批量改写」冲突 |

### 未达成项（诚实记录）

> **口径说明（收口后唯一口径）**：本节历史数字（+1012 / +1927 / +2486 等）使用过多种临时子集（"Standard Loop 路径"、"循环路径 9 文件"），彼此不可比——**这正是口径漂移的教训**（见 `lesson:checkpoint-instance-growth`）。自「口径收口轮」起，**唯一定义见 `learning/skill-metrics.md`「token 报告口径」**：规则文件净增（全部 .md/.yaml，排除 .state.md / CHANGELOG / backup）。本节保留历史记录供审计，**不再作为当前值引用**。

**口径收口轮当前值（规则文件净增，bytes/4）**：

| 口径 | Δtok |
|---|---|
| **主口径**（39 规则文件，排除 .state.md / CHANGELOG / backup） | **+5557** |
| 辅助（含 .state.md 实例） | **+7062**（实例当前 1505） |

主口径构成（最大的 ±5 项）：`advanced.md`（新建按需文件）+1813｜`e4-matrix.md`（新建按需文件）+1597｜`engine/state-machine.md` +1159｜`promotion.md` −678（P2-2 拆分）｜`transition.md` +329

> 解读：主口径把**新建按需文件**（advanced.md / e4-matrix.md，合计 +3410，默认不入常规加载路径）与**常驻文件增量**（+2147）合并。若需回答"每循环认知负担"，可自行按常驻子集（循环必读文件）拆算并**标注为次口径参考**，但**不作为报告口径**。

**历史记录（旧口径，仅供审计，勿引用）**：

- 首次实现：Standard Loop 路径 +1012（门控后），P2-2 前 +2486
- 各轮累加口径不一，曾在 +1012 / +1817 / +2172 / +2823 间漂移；数字分歧全部源于"文件子集不一致 + .state.md 实例增长"

### 边界

未新增阶段 / Loop / Memory / Policy / Guardrail / Profile；未改 `backup/memory_tool.py` 与 delx-memory；未写入 Context Compression 规则或任何运行时 token 限制。

## v1.16.1 — 压缩后状态延续：闭环验证驱动的缺口修复

> 版本依据（用户指定）：不迭代大版本，按补丁号 v1.16.1。

下发 2 个只读子 agent 独立验证主张「Runtime Compaction 后 Agent 仍知道做到哪里 / 还缺什么 / 下一步」。裁决：Verifier **INCOMPLETE**、Critic **PARTIALLY SUPPORTED**（机制层被证伪）。据缺口清单做最小修复（不新增机制 / State / Tool）。

**验证确认成立的**：S8→S7 Step 编号、S9/S10→S8 产出的引用对象均落在 TASK/ACTIVE；前向续行主路径 12 字段中 11 项有明确规则支撑。

**验证暴露的缺口 → 本次修复**：

| 缺口 | 触发条件 | 修复 | 严重度 |
|---|---|---|---|
| **防跳过 × 压缩 级联重做**：S5 需求复述 / S6 模块划分不在 TASK 区，S10 情况 B → S6 Design[0] 时无法引用 → 级联回退、可能重跑设计并命中 SAFE MODE | S10 情况 B 之后发生 Compaction | TASK 区补 ⑨ 上一阶段输出指针（S2 环境结论 / S5 需求复述 / S6 模块划分）；「压缩后继续执行」恢复阀补两条底线（不重做已完成 Step / 不改动已确认 Loop 计数） | High |
| **声明 ≠ 机制**：TASK「必须存活」仅声明，无任何出口清单强制产出 | 任一轮未自觉输出即被压缩 | `transition.md` S8 出口新增强制项「TASK 区可见性（压缩安全）」 | Critical |
| **上轮失败原因不存活**：TASK 无「上轮为何失败 / Review 判定 A·B·C」→ Code[N+1] 可能重复同一修复 | Loop N 失败后压缩 | TASK 区补 ⑩ 上轮失败原因 + 上轮 Review 判定 | Critical |
| **SAFE MODE 计数 / 双队列不可恢复** | 压缩跨轮 | TASK 区补 ⑪ SAFE MODE 计数 + 待注入队列（steering / follow-up） | Major |
| 本轮待保存经验在 S12 前被压缩即丢 | Test 失败 → 压缩 → Code 前置 `memory_search "lesson:"` 查不到 | TASK 区补 ⑫ 本轮待保存经验摘要；明确**压缩路径不调用 `memory_set`** | Major |

**否决的建议（安全）**：子 agent 提议「Test 失败即 `memory_set` 落库、不等 S12」——与 delx-memory 工具 `explicit_user_intent=true` 硬门控冲突，不采纳；改以 TASK 区摘要承载，写入仍走 S12 批量确认。

**边界**：未新增 Tool / Manager / Store / Memory 类型 / Workflow Stage / State；`memory_tool.py` 与 delx-memory 未改；未引入压缩阈值或外部命令依赖。

### 复验轮（round 2）：同一根因被两个 agent 独立命中 → 同步修复

复验裁决：Verifier **INCOMPLETE（REQUEST_CHANGES）**、Critic **PARTIALLY SUPPORTED**。两者独立指出同一根因：**字段表扩到 12 项，但唯一产出物（摘要卡模板）与唯一强制点（S8 出口检查项）未同步扩到 12 项 → 新字段无载体、无强制，缺口 2 仅 PARTIAL，缺口 3/4/5 载体形同虚设**。

| 复验发现 | 修复 |
|---|---|
| 摘要卡模板仅 8 字段，⑨⑩⑪⑫ 缺席（Agent 按模板输出则新字段永不进卡） | 摘要卡 TASK 行同步为「12 项全出」 |
| S8 强制项复制式列举 7 字段 → 与字段表漂移（漂移根因） | 强制项改为**指针**（「TASK 区全量字段，唯一事实源 = state-machine 表，本处不复制」），根除漂移 |
| ⑪「SAFE MODE 计数」无事实源定义 | 改为「SAFE MODE 触发依据计数（定义见 `kernel.md` §5）」 |
| Plan 五要素（依赖/完成判据/验证）不在存活区 → 压缩后「下一步怎么做」无判据 | TASK ⑤ 补「当前 Step 完成判据 / 验证方式」 |
| 「不重做已确认成果」仅护 S7 Step，S5/S6 输出不在护范围；与防跳过「回退重新执行」字面冲突 | 底线扩为三条：① 含已确认的 S5/S6 输出 ③ 压缩场景下「回退重新执行」收窄为「重建引用对象」 |
| S2/S7 阶段压缩无 TASK 保障（强制点只在 S8） | 不变量 3 补最低可见性下限（`[Phase]/[Loop]` 标签）+ 指明强制检查点 |
| Agent Prompt 层字段清单与 Skill 漂移 | `Vibe Coder.md` 改为指针式（不复制字段清单） |

**遗留（未修复，已知）**：Test 报告全文（通过项/计数）在 ACTIVE 仅保留 1 轮，跨 2 轮以上压缩后仅剩 TASK ⑩ 的失败原因与判定；真机 Runtime Compaction 行为仍未观测（E4 缺失）。

### 第 3–6 轮：循环验证至无 blocker（用户指令「验证→修复→再验证直到没问题」）

| 轮次 | Verifier | Critic | 本轮修复 |
|---|---|---|---|
| R3 | PASS（blockers none） | SUPPORTED（blockers none） | 摘要卡 ⑤「验证方式」/⑦「Confidence·Evidence」/⑨「S2 环境结论」子项补齐；「防跳过规则」新增压缩场景收窄条款 |
| R4 | PASS（blockers none） | SUPPORTED（blockers none） | 底线① 定义「**重建 = 补写该引用对象本身，不重走该阶段的确认/评审流程**」（消歧）；防跳过新增**契约外兜底**（对象不可重建 → 暂停 + 输出已确认进度 + 请求用户确认，不猜测不重做） |
| R5 | PASS（blockers none） | SUPPORTED（blockers none） | — |
| R6（终轮） | PASS（blockers none） | SUPPORTED（blockers none） | `kernel.md` §1 暂停条件清单回链「引用对象不可重建」（指向 state-machine「防跳过规则」→ 契约外兜底），消除 R0↔R2 未回链瑕疵 |

**收敛判定**：**连续 3 轮（R4/R5/R6）双 agent 零 blocker**，18 次独立判定无一给出「压缩后 State/Plan 实际丢失」路径。完整链路：TASK 12 字段存活 → S8 出口强制可见 → 摘要卡恢复 → 收窄重建 → 不可重建则**显式暂停**（无静默丢失）。

**遗留 non_blocking（双方判定不影响主张，未修，已记录）**：① 防跳过清单 S3→S1「冲突预检命中项」未映射 TASK 字段（可由①目标三元组重导）；② 摘要卡「12 项」计数与 ⑪ 合并双项的呈现冗余；③ 契约外暂停的恢复语义（是否维持 Loop N）未在 kernel 声明。

### 第 7 轮：清除 3 条遗留 non_blocking（用户指令「修复遗留」）

| 遗留项 | 修复 |
|---|---|
| ① S3→S1 未映射 TASK 字段 | TASK ① 扩为「目标三元组（显式意图 + 隐含约束 + 风险标签 + **冲突预检标注**，= S1 全量输出）」；防跳过清单该行补存活字段指引「（存活字段 = ① 冲突预检标注）」→ 映射双向可查 |
| ② 摘要卡计数与 ⑪ 合并双项的呈现冗余 | 拆分 ⑪ 合并项并重新编号：⑪ SAFE MODE 触发依据计数 ⑫ 待注入队列（steering / follow-up）⑬ 本轮待保存经验（摘要）→ 字段表与摘要卡统一为 **13 项全出**，计数自洽 |
| ③ 契约外暂停的恢复语义未声明 | `kernel.md` §1 该暂停条目下补「**恢复语义**：用户确认后维持原 Loop N 继续（不重置计数器）；本暂停由 Agent 侧状态触发，**不走双队列**」 |

### E4 未闭合项记录 + 触发提醒钩子（用户指令）

用户指令：记录「唯一未闭合项＝真机 Runtime Compaction 观测（E4 缺失）」，并在**此后运行触发相关问题时提醒用户修复**。

| 变更 | 位置 |
|---|---|
| 新增**常驻提醒块**：标注契约未经真机观测（R3–R8/26 次判定皆 E2/E3）+ 3 条触发条件（压缩后无法确定 Phase·Loop·下一步 / overflow 或 TASK 字段缺失 / 用户反馈进度丢失）+ 提醒通道（`⚠️ 待核对：压缩契约（E4 未验证）` + 列入「📋 待用户决策清单」）+ **不暂停循环**（命中 `kernel.md` §1 暂停条件时以暂停优先） | `engine/state-machine.md`「上下文压缩（Runtime 负责）」节首 |
| 执行者边界「承担两件事」→「**三件事**」（纳入「E4 未验证期的提醒义务」；原计数因新增义务而失准，已同步） | 同上 |
| 记忆落库：`lesson:compaction-e4-unverified-reminder`（tags 含 `pending-verification`；TTL 90 天＝lesson 策略；**持久提醒由节内指针承担**，不依赖条目存活） | delx-memory |

**验证**：2 轮子 agent 复核均 **PASS / blockers none**；双方所列 non_blocking 均自标「不建议本轮修」（触发①②通常已命中 kernel §1 暂停，措辞由「暂停优先」覆盖；`⚠️ 待核对：` 为新标记无需统一措辞表）。

### 第 8 轮：终局确认（循环终止）

R7 又浮出 3 条同级观察，其中 1 条触及计数语义，一并处理后跑终轮确认：

| 项 | 处理 |
|---|---|
| 计数器歧义：用户以"继续循环"回复契约外暂停时是否重置 | 循环计数规则「重置」行区分：常规场景重置 / **契约外兜底恢复不重置，维持原 Loop N** |
| TASK ① 标签「= S1 全量输出」与括号枚举不符（缺「任务分类」） | 收窄为「= S1 输出中须可引用的部分；S1 另含任务分类，但由意图派生、不需单独存活」 |
| `kernel.md` §1 措辞归属（暂停 ≠ 回退） | 改「与 §7『防跳过回退不消耗计数』**同源**」 |
| CHANGELOG 历史「12 字段」未标 superseded | **不追改**（历史条目 + 第 7 轮行已记录 12→13），双方判定可接受 |

**终局裁决**：Verifier **PASS** ｜ Critic **SUPPORTED** ｜ blockers = none。终局攻击均无法给出「压缩后 State/Plan 实际丢失」路径——最强攻击（S1–S7 窗口内压缩、尚无 S8 出口产物）被链路降级为**显式暂停**（`state-machine.md:149` 重建 → `:191` 收窄 → `:192` 契约外兜底）而非静默丢失。

**循环终止**：连续 5 轮（R4–R8）双 agent 零 blocker，累计 26 次独立判定；残余均为措辞层观察（双方自标「仅观察，不再作为待修项」），继续迭代无边际收益。**唯一未闭合项＝真机 Runtime Compaction 观测（E4）**，本环境无法构造。

## v1.16.0 — 统一版本（未提交 git 期间合并；版本不迭代）

> 版本策略见本文件头：未提交 git 期间统一合并当前版本号 1.16.0。本条合并同版本下七批变更（Token 成本优化 → 架构收敛 → Context 管理原则 → Skill/Tool 职责分离 → Tool 安全修复 → 四维审查修复 + 去重 → 取消部署副本同步）。

### 取消 AGENTS.md 部署副本同步义务 + 清理多余规则

用户指令：**后续不需要补写 `~/.config/opencode/AGENTS.md`**。据此删除为该副本服务的规则与陈述。

| 变更 | 位置 |
|---|---|
| 删除「同步部署副本（Vibe Coder.md ↔ `~/.config/opencode/AGENTS.md`，手工同步非软链）」收尾义务 | `profiles/skill-maintenance.md` 出口纪律 |
| 删除架构收敛拆分叙事（历史陈述只应存 CHANGELOG），并移除「AGENTS.md」这一已失效的外部引用者举例 | `learning/memory.md` 索引页 |
| 同步技能基线记忆：口径 A 由「部署 Prompt 副本」改为「Agent Prompt 源文件 `raw/ai/agents/Vibe Coder.md`」并注明副本停止维护；追加本轮对比快照 | delx-memory `reference:skill-context-cost-baseline` |

**后果声明**：Agent Prompt 的部署通道不再由本 Skill 维护；`raw/ai/agents/Vibe Coder.md` 为唯一源，`~/.config/opencode/AGENTS.md` 不再纳入收尾检查。

**本轮同口径实测（上下文成本，口径定义见上述基线条目）**：A 11,207 B ｜ B 18,437 B ｜ C 29,644 B（**-6.6%**）｜ D Quick Loop 395 行 ｜ E S12 500 行（**-8.3%**）｜ F Full 809 行。

### 四维独立审查修复（P1×13 / P2×35）+ 骨架-记忆边界澄清

下发 4 个只读子 agent 分别审查**精简度 / 记忆分层 / 工具质量 / 整体评分**，裁决：精简 6.0、记忆分层 6.5、工具 6.5、整体 **6.6**（REVISE）。本轮修完全部 P1（8 项）与 P2（18 项），并补一套可复跑回归测试。

**P1 修复（8/8）**

| # | 问题 | 修复 |
|---|---|---|
| 1 | 「Level→激活阶段」有 **3 处并称唯一事实源**且内容分歧（`SKILL.md:28` / `complexity-gate.md:125` / `state-machine.md:53` / `profiles/coding.md:12`） | 统一为 `engine/complexity-gate.md`「Loop Depth」矩阵唯一；`manifest.yaml complexity.levels.stages` 降为等价机器副本；6 个 profile 头统一为同一句 |
| 2 | `promotion.md:183` 死引用「写入规则 5」（三轮重构后该节已不存在） | 改指 `lifecycle.md`「Agent 直接 `memory_set` 时的约束」第 2 条 |
| 3 | `state-machine.md:100` 计数器递增条件**遗漏 S9 Test 失败路径**（字面执行会绕过 3 轮上限） | 补为「S9 Test 失败 或 S10 Review 情况 A/B」 |
| 4 | Level 1 是否存在 S12 **三文件三种说法** | `complexity-gate.md` L1 改为「S10 出口内联轻量记忆闭环」，与 `state-machine.md` 对齐 |
| 5 | `learning/evolution.md` 被列为 S12 必读但**全流程无发行点**（死加载） | S12 清单 [3] 显式纳入「经验类型分类 → Skill Patch Proposal 判定」 |
| 6 | `manifest.yaml` 称 delx-memory 为「可选集成」，与 `governance.md`「14 条规则以条目为 Canonical」矛盾 | 补注：「可选」指循环不阻断，缺失时 14 条规则降级为文件摘要，**须标注降级** |
| 7 | Level 0-Doc 的 S2 是否执行强制召回不明（`complexity-gate.md:69` vs `transition.md:29`） | 明确「Task→Memory Router Step 0-1 强制，与格式校对型同」 |
| 8 | `SKILL.md:55` 与 `:86` 的 Quick Loop `policy/` 必读清单冲突 | 补 `lifecycle.md`（资产归档时）+ 新增「本表与加载时机索引冲突取并集」裁决 |

**P2 修复（18 项）**

`complexity-gate.md:18` 修复被 `||` 合并而**三轮未渲染**的表格行｜`SKILL.md:15` `kernel/**`→`kernel.md`（目录不存在）｜`state-machine.md:115` 死指针→`skill:rules/test:degradation`｜`orchestration.md:67,78` 悬空「主 prompt」→`kernel.md`｜`manifest.yaml` 补 S0｜`state-machine.md:25`+`plan.md:38` 六要素→五要素（实际只列 5 项）｜`lifecycle.md` TTL 表补 Metrics 行（180 天，`manifest` 已声明）｜`manifest.memory.write` 补路径 C 说明｜`manifest.cost` 标注描述性+事实源｜`profiles/review.md:31` 三维审查归属→`engine/router.md`｜`profiles/refactoring.md:38` 短路径歧义→全路径｜`router.md:127-129` 出口清单重复→指向 `transition.md`｜`policy/safety.md:131` 并列双「单一事实源」→精确标题｜`SKILL.md:90` 自相矛盾句

**去重（单一事实源收口）**

| 收敛项 | 原状 | 现 |
|---|---|---|
| Evidence 五级体系 | `kernel.md` §3（表+格式+判断点）+ `policy/confidence.md` 各一份 | `confidence.md` 为唯一源；kernel 留 3 行指针（**常驻集省 ~1.0 KB/轮**） |
| 最终仲裁链 + 「安全不可绕过」 | `kernel.md` §4 + `policy/priority.md` §3 逐字重复 | kernel 唯一；priority 改为「各层规则来源」7 行表 |
| Profile 头模板 | 6 份各不相同（`coding.md` 还声明了 4 个「唯一事实源」） | 6 份统一单句 |

**工具修复（`backup/memory_tool.py`，6 类缺陷）**

| 缺陷 | 影响 | 修复 |
|---|---|---|
| C1 `verify` 假阳性 | **跑完一轮正常 runtime 回写后 verify 必挂**（`touch` 改 metadata、`metrics` 重写仪表盘 value 都被当硬错误；且 `json.dumps` 默认分隔符使 147/162 行字符串必然不同） | metadata 改**语义比较**（忽略 `access_count`/`cache_hit_count`）；仪表盘 value 与 `updated_at` 归为软提示；README 显式声明两类口径 |
| C2–C5 外部畸形快照 | 顶层非对象 / 条目非对象 / `key` 缺失 / `value` 非字符串 → `AttributeError`·`KeyError`·`IntegrityError` 裸 traceback | 新增 `validate_entries()` + `load_payload()`：**可读拒绝 + 退出码 1 + 逐条说明** |
| C6 `touch` 静默丢批 | `int(ttl)` 在 per-key try 之外 → 整批回滚且无提示 | TTL 解析纳入逐 key try；失败项打印 key + 原因 |
| C8 `hit_rate` 口径 | `searches=0` 时保留旧命中率；`budget_hits>searches` 时 hit_rate>1 | `s=0`→0；`bh>s`→裁剪为 1.0 并告警 |
| C9/C10 `verify` 与 `restore` 策略不一致 | verify 不查范围守卫与条目上限（可对 restore 拒绝的备份报「一致」） | verify 复用同一守卫与上限 |
| C12 写前快照 | 被 `backup` 压缩删 `.json`，且从不清理（只增不减） | 排除出压缩/去重；新增保留上限 **5 份**（超出删最旧） |
| C13/C14 | `p.name[13:21]` 偏移硬切；同 key 重复条目计数虚报 | 改正则解析日期；按 key 去重（后者覆盖） |
| 简化 | `fetch_entries` N+1 查询；TTL「按剩余时长重锚」实为恒等运算 | 改单条 `IN` 查询；改为直接的 `int(ttl)` 并更正注释 |

**新增回归测试**：`backup/test_memory_tool.py`（stdlib `unittest`，18 例，自建临时库 + 临时快照目录，**不触碰真实库**）。覆盖：语义 verify / 范围守卫 / 8 类畸形快照 / gzip 炸弹 / 条目上限 / 同 key 去重 / touch 逐 key 容错 / 计数口径 / hit_rate 边界 / 6 并发 `metrics` 不丢事件 / 写前快照有界与不被压缩。**18/18 通过**。

**审查中证伪的原始判断（诚实记录）**：`SKILL.md:59` 的「计数回写规则 6-8」**已在上一轮修复**（全仓库 `rg "计数回写规则"` = 0）；该前提已过期。但同族死指针残留 4 处（编号形态之外），已在本轮清除。

**收尾**：死指针校验升级为**双轨 grep**（日期/版本 + 节名/概念词）并写入 `profiles/skill-maintenance.md` S13 出口纪律；清理 `.DS_Store`×3 与 `__pycache__`（均已被 gitignore，非版本库内容）。

**独立复核（第二轮）与收口**：第二道只读复核确认 15 条声明中 8 条完全修复、5 条部分修复，并新发现 3 处指针错位。已全部收口：

| 残留 | 修复 |
|---|---|
| S11 触发条件「唯一事实源=记忆条目」却在本文件列全 10 条（自相矛盾） | 改判为「**本清单为 S11 门控事实源**」（engine 层确定性 gate，与 Loop Depth 矩阵同级），判定细节外链条目 |
| `rules/review.md` 把已不含清单的 `learning/reflection.md` 当事实源引用 | 改指 `engine/transition.md`「S11 Reflection → S12 Memory Evolution」 |
| `complexity-gate.md` Level 0 示例写「跳过 S10」与同文件矩阵「S10 内联」矛盾 | 示例改为「跳过 S3/S5/S6/S7/S9/S11/S12；**S10 以文档子集 5 项内联执行**」 |
| `state-machine.md` 指向 `retrieval.md`「上下文预算红线」，实际节名为「Memory ≠ Context 边界（硬约束）」 | 改正节名 |
| `promotion.md` 指向 `evolution.md` 摘要节而非 canonical 条目 | 补指 `skill:learning/evolution:trigger-conditions` |
| `rules/review.md` 笼统声明「主源以 memory 条目为准」，与类型 A 判定张力 | 改为「按 `governance.md` Canonical Source 分类判定」 |
| S12 五步在 `transition.md` / `rules/review.md` 名级重复枚举 | 两处改为「步骤名/命令/格式见清单，此处不重述」 |

**最终机械校验**：死指针候选词 0 命中（除候选词表自身）｜Markdown 表格列数 0 处不一致｜6 个 profile 头逐字一致（hash 唯一）｜工具回归 18/18 通过｜真实库 `verify` rc=0。

### Tool 缺陷修复：安全（H1/H2/H3）+ 正确性（D1/D2）+ 快照跟踪

独立子 agent 双轨审查 `backup/memory_tool.py`（安全轨 + 正确性轨），裁决 **UNSAFE / INCORRECT**，7 项缺陷全部修复。**未新增子命令 / 指标 / 抽象层，未改 Skill 侧行为。**

| # | 缺陷 | 影响 |
|---|---|---|
| H1 | `restore` 无范围校验 / 无 dry-run / 无写前快照 | 备份夹带范围外 key 会静默 upsert 覆盖本机其他项目记忆（记忆投毒）；旧快照静默回滚 19/34 条 |
| H2 | 事务用 `BEGIN`（deferred）→ `busy_timeout` 对写冲突无效 | 与 delx-memory MCP 并发写时直失败或丢更新 |
| H3 | `load_snapshot` 全量解压、无上限 | gzip 炸弹：97 KB 输入 → 626 MB RSS |
| D1 | `_recount_memory` 的 `int(access_count)` 无异常保护 | 单条畸形 metadata 打挂整条 `metrics --counts` |
| D2 | `cmd_touch` 无逐 key 容错 | 一条畸形 metadata → 裸 traceback + 整批回滚，且不指出是哪条 key |
| M1 | `snapshots/.gitignore` 只忽略 `*.json` | 6 个历史 `.json.gz` 被 git 跟踪（快照 payload 含本机绝对路径） |

**修复细节**

- **H1**：新增 `out_of_scope_keys()` 守卫——备份含非 `skill:*` / 非 `SKILL_LINKED_KEYS` 的 key → 拒绝执行并逐条列出（`--force` 可放行）；新增 `--dry-run`（只打印将写入的条目，不写库）；实际写入前落 `skill_memory_prerestore_<ts>_<ms>.json` 供回退（带毫秒，**同秒连续 restore 不互相覆盖**）
- **H2**：`restore` / `touch` / `metrics` 全部改为 `BEGIN IMMEDIATE`（立刻取写锁，使 `busy_timeout` 真正生效）
- **H3**：`load_snapshot` 改用 `zlib.decompressobj` + `max_length` 流式解压，解压后上限 8 MiB、条目上限 2000，超限拒绝（**不全量解压后再判断**）
- **D1**：`metadata` 解析结果非 `dict` 时归一为 `{}`；`access_count` 转换异常计 0（计入「存而不用」预警，而非打挂统计）
- **D2**：`cmd_touch` 逐 key `try/except`，失败项打印「key + 原因」，其余 key 照常提交
- **M1**：`snapshots/.gitignore` 补 `skill_memory_*.json.gz`；6 个历史 `.gz` 执行 `git rm --cached`（**文件保留在磁盘，仅取消跟踪，可逆**）；`skill_memory_latest.json` 仍进 git

**附带重构**：`cmd_backup` 的采集逻辑抽为 `build_snapshot_payload(db)`，供 backup 与 restore 写前快照共用（输出与行为不变）。

**验证（沙箱 DB 副本，含 `-wal`/`-shm` 一起复制；19/19 + 2/2 通过）**

| 用例 | 结果 |
|---|---|
| dry-run 幂等（无变更 → 「将写入 0 条」） | 通过 |
| 越界 key 拒绝 / `--force` 放行 | 通过 |
| gzip 炸弹（40 MiB 展开）与超大明文拒绝 | 通过 |
| `created_at` / `ttl_expires_at` / 范围未覆盖 → 硬失败 rc=1 | 通过 |
| `updated_at` 漂移 → 软提示 rc=0 | 通过 |
| 畸形 metadata：`metrics --counts` 存活、`touch` 定位到具体 key、其余 key 仍 +1 | 通过 |
| 写前快照落盘且可用于回退 | 通过 |
| 8 个并发 `metrics --conflict 1` → `delta=8`（无丢更新） | 通过 |
| 外部持写锁 2.5 s → `touch` 等待 2.05 s 后 rc=0（旧代码 0.15 s rc=1） | 通过 |
| `zero_access_entries` 口径保持 **14**（D1 修复未破坏上一轮修正） | 通过 |

**未修（需用户决策，非本轮范围）**：`touch` 同轮同 key 不去重（用户已定 Agent 责任）；`verify.*` 的 `last` 描述性字段与 `auto_rule.pass_rate` 无工具路径（已在「工具覆盖边界」声明）；`--db` 未做 schema 校验。

### 审查修复：引用断链 ×2 + Tool 缺陷 ×3（含文档精度）

独立子 agent 审查（2 个只读验证 agent + 沙箱实测）裁决 **PARTIAL**，发现 5 项缺陷，全部修复。**未新增能力 / 子命令 / 抽象。**

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | 引用断链 ×2：仍指「lifecycle 规则 8」（三轮已重构为「回写契约」）——`skill-metrics.md` · `backup/README.md` | 改指「回写契约」第 3 条 |
| 2 | `metrics` 的 `--auto-generated` 未注册（`METRIC_FIELDS` 已定义、argparse 缺项，调用报 `unrecognized arguments`） | 注册该 flag |
| 3 | `zero_access_entries` 口径漂移：工具按**全库 162 行**计数（53），基线语义为**三层体系**（14）→ 该字段 `>5` 触发线恒为真，预警失效 | `_recount_memory` 限定 lesson/pattern/principle/reflection 前缀；note 显式声明口径 |
| 4 | `cmd_metrics` 的 `SELECT` 在 `BEGIN` 之前 → 读改写非原子（与 MCP 并发可能互相覆盖） | `BEGIN` 前置，读改写同事务 |
| 5 | 文档称「Agent 不手写字段聚合」，但 `conflict.last` / `rollback.last`（描述性）与 `auto_rule.pass_rate`（派生）无工具路径 | 补「工具覆盖边界」声明（`skill-metrics.md` / `backup/README.md` / `SKILL.md`） |

**验证**（沙箱 DB 副本 → 真实库）：`metrics --auto-generated 2 --counts` → `auto_rule.generated` 0→2、**`zero_access_entries` 53→14（回正）**、`verify.*` 与 `conflict.last` 保留｜断链复检 `rg "规则 8|规则 6-8|规则 6/7/8"` → **0**｜`BEGIN` 已位于 `SELECT` 之前（单事务）。

**附带**：子 agent 消费的 15 个记忆 key 按协议由主 agent 汇总回写（14 条 `--hit`；`skill:system:metrics` 因当轮被判口径不一致，不计 hit）。

### Skill Context 三轮瘦身：单一事实源收口 + 引用断链修复

用户评审（Canonical Source 收口）。**零逻辑改动**——未新增 Tool / 能力 / 阶段 / 指标 / Memory 类型 / 阈值，未改 Tool 行为。

**引用断链修复（前两轮改写遗留的 5 处陈旧引用）**

| 断链 | 位置 | 修正 |
|---|---|---|
| 「lifecycle 规则 6-8」（二轮已重构为「回写契约」3 条） | `SKILL.md` S12 行 · `memory.md` · `promotion.md` · `lifecycle.md`「Quick Loop 闭环」 | 全部改指「回写契约」/「该节第 3 条」 |
| 「Metrics Buffer + 上下文预算初始化」（二轮已合并为「运行时状态初始化」） | `SKILL.md` S4 行 | 同步 |
| 「计数回写自动执行协议」 | `SKILL.md` 分级加载 | 改「回写契约 + Tool 调用点」 |

**单一事实源收口（重复规则 → 指针）**

| 规则 | 原重复处 | 收口到 Canonical |
|---|---|---|
| Level → 激活阶段 | `complexity-gate.md` **双表**（Loop Depth 矩阵 ＋ 与 Router 的衔接） | Loop Depth 矩阵（与 Router 的衔接改为指针，标题保留供外部引用） |
| 未激活阶段列举 | `router.md` ×3「跳过：S3/S5/…」 | 同上矩阵 |
| 消费回写命令 | `transition.md` ×3（S4 / S8-L0 / S12） | `lifecycle.md`「回写契约」 |
| Metrics 落库命令 | `transition.md` ×2（S4 / S12） | `promotion.md` 清单 [4] ＋ `skill-metrics.md` |
| S13 出口命令 / 输出格式 / 降级 | `transition.md` S13 ×2 | 同上两处 |
| 摘要卡分区格式 ＋ compact 执行者边界 | `retrieval.md` | `state-machine.md`「上下文压缩触发」 |
| S12 执行内容枚举 | `SKILL.md` S12 行 | `promotion.md`「S12 Memory Evolution 最小执行清单」 |
| 状态转移图内的 Tool 注记 | `state-machine.md` ×4 行 | `transition.md` |
| Metrics 术语（Buffer / 内存清单不一致） | `transition.md` ↔ `skill-metrics.md` | 统一「Metrics 内存清单（Buffer）」 |

**结果**：`transition.md` 不再含任何 Tool 命令（回归「何时离开 / 进入哪里 / 异常回退」）；`state-machine.md` 回归「是什么状态 / 负责什么」；`lifecycle.md` / `promotion.md` / `skill-metrics.md` 各为唯一权威来源。

**尺寸（初 → 现）**：TOTAL 206,158 → 197,146（**-9,012 / -5%**，本轮 -861）。`SKILL.md` 12,270 → 10,021（-18%，93 行）｜`transition.md` 12,803 → 11,145（-13%，196 行）｜`lifecycle.md` 14,568 → 11,711（**-20%**，173 行）｜`promotion.md` 18,105 → 16,546（229 行）｜`state-machine.md` 12,159 → 11,734（208 行）｜`skill-metrics.md` 7,625 → 6,741（95 行）｜`complexity-gate.md` 6,688 → 6,537（131 行）。

> 本轮字节降幅小（-861），**主要收益是引用完整性**：5 处断链（会让 Agent 找不到「规则 6-8」）已修复；9 类重复规则收敛为单源。

**行为一致性**：状态机 / Loop / Memory / Promotion / Metrics / Tool 行为**均未变**。

用户评审结论（P0×2 + P1×3）。**本轮未新增任何 Tool**——先瘦协议，不加 Tool；未新增/删除能力、阶段、指标、Memory 类型。

**P0 `lifecycle.md`（-19.7%）**——Tool 已实现，文档不再解释其内部机制

- 「记忆访问计数与元数据协议」：`存储位置` + `字段约定` 4 行表 → 「字段语义」1 段；`写入规则` 5 条（含 value 回传 / tags 整体替换 / TTL 重算 / metadata 三件套 / access_protocol 退役）→ **「回写契约」3 条**（消费即回写 / 出口兜底 / 报告+降级，字段完整性「由 Tool 保证，Agent 不手写」）+ **「Agent 直接 `memory_set` 时的约束」3 条**（仅新增记忆 / 批量确认 / 非计数更新用，计数路径不需要）
- 删除 `读取规则`（后端 java-vibe-code / 前端 delx-memory-web 的 `json_extract` 实现细节，非运行时知识）
- `禁止事项` 6 条 → 1 行

**P0 Tool 命名分层统一**——`tools/（backup/memory_tool.py）` → `backup/memory_tool.py`（概念层与物理路径一致）

- `memory_tool.py` docstring / `backup/README.md` / `SKILL.md` 架构边界 + 加载索引统一声明两组：**runtime**（`touch`·`metrics`，**Agent 调用**）｜**maintenance**（`backup`·`restore`·`verify`·`list`，技能迭代调用）；Skill 只暴露 runtime 组

**P1 `promotion.md`（-8.6%）**——机械算法与语义判断分离

- Pattern Fingerprint：删「计算示例」（10 行 A/B 对照）→ 保留公式 + 4 条匹配规则 + **显式标注判断 fork**（选词 = Agent 语义判断 / 拼串与交集 = 机械计算，并说明当前不 Tool 化的理由）
- Relevance 评分：5 行因子表 → 1 行归一化说明
- Memory Consolidation：Phase 1-8 代码块（与 S12 清单 / 提升 / 去重三节重复）→ **8 行执行顺序表**（每行指向对应规则源，不再重述）

**P1 `skill-metrics.md` 职责归位（-12.3%）**——纯运行时文件

- 「learning/ 有效性验收（记忆审计）」→ 迁至 `learning/evolution.md`（属治理/演化职责，非运行时 Metrics）；「若协议持续 0 执行 → 视为纸面协议」一并迁出
- 「运行级闭环复查」4 步列表 → 1 行（一次性迁移检查）

**P1 `transition.md`**：S4 转移的 Level 流程列举 → 指针（`engine/complexity-gate.md`「Loop Depth」唯一事实源）

**尺寸**：TOTAL 201,840 → 198,007（本轮 **-3,833**）；累计 206,158 → 198,007（**-8,151 / -4%**）。分层：常驻 21,632 → 21,698（`SKILL.md` 12,270 → 10,142 = **-17.3%**）｜engine 45,107 → 44,948｜learning 59,225 → 55,485（**-7.5%**；`lifecycle.md` 14,568 → 11,699 = **-19.7%**，`promotion.md` 18,105 → 16,546 = -8.6%）｜rules / policy / references / profiles 不变。

**行为一致性**：状态机 / 出口条件 / 安全约束 / Complexity Level 语义 / Memory 数据模型 / 指标集合 均未改；本轮全部改动为「删除重复表述 + 指针对齐 + 表述精度收敛」。

用户要求：将「Agent 必须理解的规则」与「程序可机械执行的规则」分离（Skill = Why/When/Decision；Tool = How/Execute/Persist）。**不新增能力 / 阶段 / 指标 / Agent 角色 / Skill 路由机制；不改 Memory 数据模型与 Complexity Level 语义；不程序化 Complexity Gate · Reflection · Skill Routing · Planning · Review。**

**Tool 扩展**（`backup/memory_tool.py`，+2 子命令，纯标准库）

- `touch <key>... [--hit]`：Memory 消费回写（access_count+1；`--hit` 时 cache_hit_count+1）
- `metrics [--<delta> …] [--counts] [--note]`：仪表盘 upsert（叠加本轮 delta + `hit_rate` 重算 + `--counts` 机械重算 memory.* 计数）
- **不变量（工具保证，Agent 不再手写）**：value 不改 / tags 不动 / metadata 其余字段原样保留 / 有限 TTL 按剩余时长重锚 / 未触及字段完整回传
- 冒烟验证（DB 副本）：touch 保 value、metrics 重算正确、metadata 与 `verify` 字段保留；真实库未受影响

**从 Markdown 下沉到 Tool**

| 原描述位置（重复） | 下沉内容 |
|---|---|
| `lifecycle.md` 规则 6-8 ＋ `transition.md` S4/S8/S10/S12/S13 ＋ `promotion.md` [2] ＋ `review.md` ＋ `coding.md` ＋ `complexity-gate.md`（**跨 8 文件重复**） | 消费回写的字段级机制（value 回传 / metadata 三件套 / tags 整体替换语义 / TTL 重锚）→ `touch` |
| `skill-metrics.md`「每轮必更」段 ＋ `transition.md` S13 仪表盘项 | 仪表盘聚合（取当前值 → 叠加 → 完整回传 / hit_rate 计算 / 条目计数）→ `metrics` |

**Markdown 瘦身**

- `SKILL.md`：删目录树（改指针）+ 删「指针页已删除」历史迁移说明 + 骨架化摘要改纯指针；新增 `tools/` 架构边界行 + 加载时机索引 Tool 行
- `engine/transition.md`：S4 三项运行时初始化（Metrics Buffer / 预算 / 消费清单）合一为「运行时状态初始化（Tool）」；S8/S9/S10/S12/S13 字段级写入细节 → Tool 调用
- `learning/memory/lifecycle.md`：规则 6-8 由「字段级机制」改为「判断 + Tool 调用 + 降级」
- `learning/skill-metrics.md`：仪表盘更新段 → 一行命令 + 不变量 + 降级
- `engine/state-machine.md`：S8/S10/S12 节点改「消费回写（Tool）/ 仪表盘聚合（Tool）」
- 指针化：`promotion.md` / `review.md` / `memory.md` / `complexity-gate.md` / `profiles/coding.md` / `backup/README.md` / `manifest.yaml`

**无法安全下沉（已核实，保留 Markdown）**

- **Context 水位 / Headroom 计算**：唯一运行时（sqlite 脚本）**无会话上下文访问权**，无法感知 usage；且公式为单次减法 + 单次比较——下沉＝用一次工具往返换 2 行规则。改为**收敛重复**（`state-machine.md` 为唯一事实源，其余改指针）。
- **Pattern Fingerprint / Relevance 评分**：输入（关键词集合 / 验证标记）由 Agent 判断产生，机械部分＝一次哈希；工具化收益 < 复杂度成本。
- **周期 Metrics 汇总**（`skill-metrics:vibe-coder-loop:<周期>`）：单次写入无合并风险，维持 `memory_set`。

**尺寸变化（字节）**：TOTAL 206,158 → 201,840（**-4,318 / -3%**）；常驻 23,690 → 21,632（**-9%**，其中 `SKILL.md` 12,270 → 10,076 = **-18%**）；engine 46,499 → 45,107（-3%）；learning 59,996 → 59,225（-2%）；rules 29,887 → 29,804；profiles 13,821 → 13,807；policy / references 不变。**口径说明**：剩余字节大头为判断性内容（阈值 / 清单 / 判断标准 / 安全约束），按「不程序化 Agent reasoning」约束不应下沉；本 Skill 已经历多轮去重（见下方各批），本轮新增维度是「运行时执行细节」——故**总量降幅有限，但重复源从 8 个文件收敛为 1 个 Tool**。

**行为一致性**：状态机 S0-S14 / 阶段出口条件 / 安全约束 / Complexity Level 语义 / Memory 数据模型 / 指标集合**均未改变**；仅将「字段如何更新」由 Agent 手写改为 Tool 执行（Tool 不可用时按各协议降级条款手工执行，行为回退到原路径）。

### Context 管理原则：headroom 四能力吸收（批 1 / 2 / 3）

来源：headroom（context compression layer）四能力解剖（Context Budget / Headroom·Reserve / Context Zone / Session Failure→Memory Promotion）对照本 Skill。**Skill 只定义原则，不引入压缩引擎、不新增阶段/状态**；批 3 为协议层改动，**仅对新写入生效，不迁移存量记忆**（用户裁定）。用户指定输出预留 = **固定值 16,000 tokens**。

**批 1 — 上下文分区（Context Zone）+ 分区摘要卡**

- **`engine/state-machine.md`「上下文压缩触发」新增「上下文分区（Context Zone）」**（宪法层文件内直接生效，不下沉条目）：四区模型（❄️STATIC / 📌TASK / 🔥ACTIVE / 🗄️HISTORY）+ 三不变量（①永不丢消息 ②可逆·检索键=CCR 等价物 ③冷前缀时机）+ 摘要卡模板由 EXHAUSTIVE 改为**分区格式**；**节名保留**（Vibe Coder.md「完整协议唯一事实源」指针零破裂）
- **TASK 区自既有硬规则派生**：= 防跳过规则要求显式引用的对象集（S1 目标三元组 / S5 需求复述 / S6 模块划分 / S7 Step 编号）——分区非新增机制，是既有硬规则的显式化
- **与骨架化治理的轴划分声明**：`references/governance.md` 管**磁盘层常驻**（宪法层永不沉 / 查询参考下沉）↔ 本节管**窗口层常驻**（单会话运行时）；同哲学（确定性保留 vs 按需取回）、不同轴，不可互相替代
- **消费方一致性同步**：`learning/memory/retrieval.md`「上下文预算红线」+ `raw/ai/agents/Vibe Coder.md`「上下文预算管理」的 `EXHAUSTIVE` 表述同步为分区格式

**批 2 — 预算（Budget）+ 输出预留（Reserve）+ 前馈/反馈对偶**

- **`engine/state-machine.md` 新增「预算」+「输出预留」两节**：① 预算 = `窗口上限（project:opencode-model-limits）− 输出预留`，判定基准由「已用 vs 窗口」改为「**已用 vs 预算**」，窗口未声明 → `[窗口未知]` 降级启发式；② 三保护（输出预留 16,000 tokens 固定值 / STATIC 区保护 / 轮次保护 N=1 完整轮），**优先级高于压缩**；③ 触发条件首项由「> 80%」改为「已用 > 预算」；④ 新增「Memory ≠ Context 边界」硬约束（Context 不进 Memory / Memory 不进 Context）
- **`engine/transition.md` S4 出口新增「上下文预算初始化」**：与 Metrics Buffer 初始化并列（统一预算口径的初始化时机）
- **`learning/memory/retrieval.md`「上下文预算红线」**：分项 caps 降格为统一预算的「**分项配额**」；新增「Memory ≠ Context 边界（硬约束）」节；阈值行由「> 80%」改为「已用 > 预算」
- **`SKILL.md`**：「分级加载」节新增「**前馈 / 反馈对偶**」声明（前馈 = 加载量；反馈 = 预算 / 预留 / 四区 / 摘要卡；共享同一预算口径）；「加载时机索引」S4 行同步（Metrics Buffer + 上下文预算初始化）
- **`raw/ai/agents/Vibe Coder.md`**：上下文预算管理节第 2 项由「软阈值 80%」改为「预算阈值」（含 16,000 预留 + 降级启发式）

**批 3 — 成功关联 + 双轴正交 + 时序 supersession**

- **`learning/memory/lifecycle.md`「Test→Lesson 学习闭环」新增 `success_correlation` 字段（必填）**：`{failed: <错误路径/假设>, succeeded: <正确路径>}`——lesson 价值在「从失败到成功的 diff」而非失败清单；未修复成功 → `succeeded: null` + 标 `unresolved`（不编造成功路径）
- **`learning/memory/promotion.md`「自动提升逻辑」新增「提升阶梯双轴正交」声明**：**知识抽象度**（lesson→pattern→principle）⊥ **持久化作用域**（task→project→global）；提升阈值只约束抽象度轴，作用域由 `scope` 标注独立决定（消除「pattern 必为 global / lesson 必为 project」的隐式误读）
- **`learning/memory/promotion.md` 新增「事实时序 supersession」节**：与 Merge `contradict` 明确分工（contradict = 经验结论冲突走人工裁决；supersession = 同一事实随时间变化可机械判定）；规则 = 不静默覆盖 + 链记在 value（不记 metadata，防整体替换丢失）+ 召回取链末端 + 计数类可覆盖 + 判定依据为「同一实体同一属性」
- **索引同步**：`learning/memory.md` 分片表 promotion.md 行加「事实时序 supersession」
- **批 1–3 完成判定**：headroom 四能力全部落到原则层；**未引入压缩引擎、未新增阶段/状态**

### 架构收敛：profiles 任务入口 + memory 拆分 + 依赖声明

用户定向要求（降低 Agent 理解成本 / 控制 Skill 架构复杂度；禁止能力扩展 / 工作流重设计 / 大规模搬迁）：
- **新增 profiles/ 任务入口层（6 文件）**：coding（A/B）/ debugging / refactoring（C/D）/ planning / review（E + Level 0-Doc）/ skill-maintenance——判定特征 + Required/Optional 加载清单 + 出口纪律的路由卡；Profile=Router、Rules=Authority（仅路径引用，不复制规则内容；Level→阶段以 manifest.yaml complexity.levels 为唯一事实源，逐阶段文件以 SKILL.md 加载时机索引为准）；SKILL.md 新增「任务入口路由」6 行判定表 + 架构树/架构边界/description 同步
- **learning/memory.md 拆分（601 行 → 索引 ~40 行 + 分片）**：`learning/memory/architecture.md`（三层体系/命名空间/Tag 权重）、`retrieval.md`（Task→Memory Router 路由表/工具能力/CodeGraph 触发/预算红线）、`lifecycle.md`（保存三路径/用户偏好/TTL/访问计数协议/失效传播/Test→Lesson/Quick 闭环）、`promotion.md`（自动提升/指纹/评分/审计/去重/Merge/观察期/Consolidation/S12 清单）；原 memory.md 保留为稳定路径索引（AGENTS.md / delx-memory 记忆条目 20+ 处 `memory.md「节名」` 外部引用经索引解析不破裂）；仪表盘节 + learning/ 有效性验收并入 skill-metrics.md（消除双源）；storage.md 未建（存储实现已内联/下沉，独立文件=空壳，遵守"禁止为拆分而拆分"）
- **manifest.yaml dependencies 重构**：`[delx-memory, codegraph]` → `required: []` + `optional_integrations: [delx-memory, codegraph]`（核心零外部依赖，可选集成缺失→能力降级不阻断循环）；architecture 段加 profiles/learning 分片说明
- **指针全量同步**：SKILL.md 加载索引/分级加载、engine/transition（5 处）+ state-machine + router、rules/review + plan + code、policy/priority、references/governance（Canonical 特例 + 映射表 + 加载协议）、Vibe Coder.md（4 处）→ 部署副本 ~/.config/opencode/AGENTS.md 已同步（diff 验证一致）
- **上下文成本基线落库**（用户要求保存实测结果供后续迭代）：新增 `reference:skill-context-cost-baseline`（permanent，含 A-H 八口径定义 + v1.15.2→1.16.0 实测表：常驻 -12.6%/Quick -38~49%/S12 -16%/磁盘 +12.3%）；backup `SKILL_LINKED_KEYS` 9→10 条 + README 同步 + 重新 backup/verify（37 条一致）。**勘误**：前批 changelog 自记常驻 28.3KB 与实测 31.7KB 不符（指针表述还原 + profiles 扩充回冲），以基线条目实测口径为准
- **版本未迭代**：manifest version 保持 1.16.0（与上批未提交变更合并；用户版本策略指令见本文件头）
- 语义等价性：状态机/S1-S13 出口/安全约束/计数回写协议原文保真搬迁，无规则删除；Quick Loop 单任务加载 memory 相关 ~601 行 → lifecycle+retrieval 节（约 -70%），S12 由 promotion 调度页自足加载

### Token 成本优化：去重 + 治理内容按需化（能力等价，同版本前批）

用户定向要求（Prompt/Skill Token 审计优化，禁止能力降级/工作流重构）：
- **Vibe Coder.md**：上下文预算节改为"义务骨架 + 指针"（完整协议事实源 = state-machine.md「上下文压缩触发」，消除逐条复制）；回写检查清单压缩表述 + 事实源指针；多模态节删除（用户指示，随同移除主模型名）；CodeGraph/加载 Skill 节冗词压缩。同步部署副本 ~/.config/opencode/AGENTS.md
- **SKILL.md**：骨架↔规则条目映射表 + Canonical Source 说明（~2.6KB）迁至 `references/governance.md`（仅修改 Skill 规则时读取），原处保留摘要 + 指针；架构树注释剥离；S2 Preflight 的 skill:rules 域检索动作保留在常驻摘要（防行为降级）
- **engine/ 去重**：complexity-gate 删安全不变量副本（指针 kernel.md §4.1）、示例压缩、判定流程 ASCII 图转文字；router 高风险信号词表改指针（事实源 complexity-gate.md）；state-machine S4 转移改指针（事实源 complexity-gate「与 Router 衔接」+ router 模式细则）、S13 出口改指针（事实源 transition.md S13）
- **kernel.md**：§4 删 Global Priority 价值维度副本（指针 priority.md §1）
- **manifest.yaml**：description 清除迭代版本残留（符合自定规则：description 仅当前事实 + 指针）
- **版本指针表述还原**（审查发现后）：SKILL.md description / 机器可读契约 / 加载时机索引、Prompt 记忆兜底的"版本信息唯一来源 manifest.yaml"指针按 rule:skill-iteration-manifest 还原；正文版本标注残留清理（references/governance.md 首行"（v1.16.0）"→ CHANGELOG 指针）；版本号保持 1.16.0 未迭代
- 常驻加载（Prompt + SKILL.md + kernel.md）：优化前基线 36.3KB → 当前 ~28.3KB，累计约 -8KB / -22%
- 语义等价性：三红线/计数器/SAFE MODE/状态机转移/出口条件/加载协议均未改；所有去重以"指针 + 唯一事实源声明"实现，无纯删除

### Context 职责边界审查（Runtime / Skill / Memory 三分离）

用户指令：审查 Skill 是否错误承担 Runtime 的 Context Compression 职责；只消除职责重叠与「压缩后无法继续执行」，不做功能扩展（不新增 Tool / Manager / State / Memory 类型）。

| 变更 | 位置 |
|---|---|
| **删除 Runtime 基础设施描述**：预算公式（`窗口上限 − 输出预留`）、输出预留固定值 16,000 tokens、「Headroom / Reserve」三保护节、`已用 > 预算` 判定口径、overflow 自动重试 1 次（宿主职责） | `engine/state-machine.md`「上下文压缩触发」→ 收敛为「水位感知（Agent 侧信号）」+ Runtime 边界声明 |
| **修复内部矛盾（Context 被写成 Memory）**：原文要求「压缩前把 HISTORY 区固化到 delx-memory 并写检索键」，与同节「Memory ≠ Context」硬约束及 `retrieval.md` 直接冲突（= 把会话历史当 Memory 保存，Memory 沦为第二套 Context Manager）→ 改为「状态不进 Memory；可逆性由 Runtime 摘要/重建承担；仅经经验质量审计的经验走 S11/S12 沉淀」 | `engine/state-machine.md` 分区不变量 + 摘要卡模板 + Agent 动作 |
| **补「压缩后状态延续契约」**：TASK 区字段补全（Complexity Level / 当前 Phase / Loop N / Step 完成标记 / 关键决策 / 待决策清单）+ 新增「压缩后继续执行」（依摘要卡 TASK+ACTIVE 恢复，不重放历史；不足则按防跳过规则回退） | `engine/state-machine.md` |
| 骨架化治理类比改写（删除「HISTORY 区固化回 delx-memory ↔ 查询参考下沉」错误类比：磁盘文档层 ≠ 会话运行层） | 同上「与骨架化治理的关系」 |
| 术语去歧义：「上下文预算红线」→「检索量红线（Agent 行为配额）」（保留 caps，删除对预算公式的从属声明）；「分级加载（上下文预算）」→「分级加载（控制进入上下文的文件量）」 | `learning/memory/retrieval.md` / `learning/memory.md` / `SKILL.md` |
| 跨文件指针同步：S4 出口「① 预算口径 → state-machine「预算」」→「① 上下文水位与压缩 → Runtime 职责 + state-machine「水位感知」」 | `engine/transition.md` |
| Agent Prompt 对齐：删除预算公式与「需保留状态先固化到 delx-memory」；改为 Runtime 边界声明 + 5 条义务（含压缩后继续） | `raw/ai/agents/Vibe Coder.md`「上下文管理（Runtime 负责）」 |

**边界声明**：未新增 Tool / Context Manager / Recovery Manager / Memory 类型 / Workflow Stage / State；`backup/memory_tool.py` 未改。运行时行为等价——Agent 仍输出摘要卡并请求 `/compact`，仅移除 Skill 侧 token 数学与 Memory 兜底路径。**保留项**：水位启发式信号（>80 消息 / >30 工具调用 / 同文件 Read >3 次）、摘要卡 + 请求压缩、防死循环、诚实约束、Memory ≠ Context 硬约束。

### Context 压缩职责再收敛（去 Skill 侧阈值与外部命令依赖）

用户指令：Skill 只保留「压缩后 Workflow 可继续」，不保留自己的压缩触发器。**本条取代同版本上文「Context 职责边界审查」中保留的水位阈值与请求压缩行为**（该节新增的「水位感知」已整体移除）。

| 变更 | 位置 |
|---|---|
| **删除 Skill 侧压缩阈值**：消息数 >80 / 工具调用 >30 / 同文件 Read >3 次 / 轮次 >2 四条启发式信号整体移除；明确「不构成 Context Meter → Threshold → Compression Decision 判定链」 | `engine/state-machine.md`「上下文压缩触发」→「上下文压缩（Runtime 负责）」 |
| **删除 `/compact` / `ctrl+x c` 依赖**：「明确请求用户执行 `/compact` 或 `ctrl+x c`」删除；改为「不假设 Runtime 提供任何特定压缩命令」（Runtime 机制各异） | 同上 + Agent Prompt |
| **删除 Skill 侧压缩请求与防死循环**：不再由 Skill 发起压缩请求，故「压缩请求每轮最多 1 次 / 压缩失败暂停」随之移除；仅保留 context overflow → 暂停不自行重试 | 同上「溢出恢复」 |
| **新增「信息获取规范（Agent 行为，非压缩）」**：不无目的批量读取 / 不重复读取与重复工具调用 / 大型结果只取相关部分 / 信息不足主动获取（上限指向 `retrieval.md`「检索量红线」） | 同上 |
| 摘要卡定位澄清：由「压缩动作输出模板」改为「Agent 固化 📌 TASK 区的手段，非 Skill 的压缩触发条件」 | 同上 + 「TASK 区先可见」措辞 |
| 跨文件指针同步（节名变更 上下文压缩触发 → 上下文压缩（Runtime 负责））：SKILL.md 反馈侧对偶 / transition.md S4 出口 ① / retrieval.md 检索量红线 / priority.md R2 描述 / Agent Prompt 上下文节 | `SKILL.md` / `engine/transition.md` / `learning/memory/retrieval.md` / `policy/priority.md` / `raw/ai/agents/Vibe Coder.md` |

**保留**：📌 TASK 区延续契约（目标 / Level / Phase / Loop / Plan Step / 验收标准 / 关键决策 / 待决策清单）、🔥 ACTIVE 最近一轮 Test·Review、压缩后继续执行规则、Memory ≠ Context 硬约束、诚实约束、溢出暂停。**未新增** Tool / Manager / Store / Memory 类型 / Workflow Stage / State；`memory_tool.py` 与 delx-memory 未改。

## v1.15.2 — backup 历史快照策略（按天去重 + gzip 压缩）

用户要求（备份时压缩以往数据 + 当天只保留一份 + 清理多余）：
- memory_tool.py 新增 `dedupe_daily_snapshots()`：按天去重——每天只保留一份最新时间戳快照（含 .json/.json.gz），同天多余自动清理（保留当天最新状态）
- memory_tool.py 新增 `compress_history_snapshots()`：历史时间戳快照自动压缩为 `.json.gz`（gzip level 9，节省约 65%），删除原 .json；幂等判断 = 扩展名（已存在 .gz 则跳过）
- `load_snapshot()`：restore/verify 支持 `.json.gz` 输入（压缩后历史快照仍可校验/恢复）
- `skill_memory_latest.json` 永不压缩（restore/verify 主入口）；backup 输出去重/压缩统计报告
- 实测：清理同天多余 10 个，历史 4 天各保留 1 份 .gz，累计节省约 880 KB
- backup/README.md 新增「备份保留策略」节

## v1.15.1 — backup 脚本增强 + 备份同步惯例

用户要求（更新备份/更新脚本 + 备份新 delx-memory + 建立惯例）：
- memory_tool.py 增强：① docstring 备份范围补全（skill:* 27 条 + 关联 9 条 ≈ 36 条）；② 快照 payload 新增 `changelog_top` 溯源字段（读取 CHANGELOG.md 最新条目标题，与 skill_version 互补）；③ 新增 `read_changelog_top()`；④ SKILL_LINKED_KEYS 注释标注"修改必须同步 README + 重新 backup"
- backup/README.md 新增「维护约定」节：新增/删除关联 key → 同步 SKILL_LINKED_KEYS + README；技能规则/关联内容更新后 → 重新 backup
- rule:skill-iteration-manifest 追加「备份同步义务」节（技能维护任务收尾 = 同步脚本 + 备份 + verify）
- 实际执行 backup + verify（36 条一致）

## v1.15.0 — changelog 抽离（description 瘦身）

- **问题**：manifest.yaml description 承载全部迭代历史（约 9.9KB / 140 行），每次加载 manifest（机器可读契约）都全量读取，上下文成本高。
- **变更**：① 迭代历史抽离至本文件（CHANGELOG.md，唯一事实源）；② manifest.yaml description 仅保留当前架构事实 + 最近版本摘要 + 指针（约 -96% 体量）；③ rule:skill-iteration-manifest 规则 1 更新（迭代历史事实源：manifest.yaml description → CHANGELOG.md）；④ SKILL.md 架构树/机器可读契约说明同步；⑤ reference:memory-navigation 维护记录指针同步；⑥ lesson:skill-edit-date-residue 合法例外表述同步。
- **兼容**：version 字段仍为版本号唯一事实源；backup 工具 read_skill_version 不受影响；未新增能力/未改状态机行为。

## v1.14.9 — 存量冗余收敛

用户定向要求（自审三方向——冗余/关联/精简，禁止新增能力/改状态机行为）：
- Vibe Coder.md 对齐部署副本（修复 v1.14.6 漏改：上下文预算节 apply-model-limits.sh → project:opencode-model-limits；补多模态/CodeGraph 章节；合并兜底重复；显式声明部署副本 ~/.config/opencode/AGENTS.md 同步义务）
- manifest.yaml changelog 早期版本聚合（v1.6-v1.10.5 合并为 2 条摘要，保留 v1.11.0+ 详细——骨架化/记忆体系为现行架构基础）
- memory.md 计数协议规则 6-10 合并表述（消费即回写主路径 + 出口兜底 + 授权降级三段式，语义全保留）+ 仪表盘节去重 + 上下文感知路由表节指针化
- priority.md 示例压缩（§1/§5）；complexity-gate.md 示例压缩
- backup/README.md 备份数修正 28→27（v1.14.8 已删 lightweight-queries）
- delx-memory：reference:memory-navigation SKILL 条目表指针化（指向 SKILL.md 映射表，消除双表漂移）、agent:vc_constraints 压缩一次性实测验证段落
- 未新增能力；State Machine / S1~S13 / 安全约束 / 事实源声明均未变更

## v1.14.8 — 记忆库梳理整合

delx-memory 全量审计 + 用户确认执行：
- 事实修正 30 条（E0-E4 实测：webbas skills 仓库位置/vue-ui 目录名/jtkl mgmt 路径/版本号 0.0.3→1.0.0/pm2 id 16→17 等）
- 合并 6 组 13 条→6 条：workflow 5→workflow:vue-ui-workflow-notes、jtkl git 2→project:jtkl-git-conventions、build-package-json→webbas-engine-overview、jsonviewer→delx-memory-web-overview、public-account→user:profile、lightweight-queries→query-router
- 用户确认删除 19 条（11 合并旧 key + 7 stale + 1 版本快照）
- 文件侧指针同步：memory.md/SKILL.md 清除 lightweight-queries 引用
- memory-navigation 精简（3 节指针化）+ rollback_point 重建锚点 + skill-metrics:2026-08 补录
- early-warning 阈值统一 15%、悬空 pattern 指针清除、lesson:memory-metadata-overwrite 补 skill-evolved

## v1.14.7 — 备份工具更新

用户要求，未新增能力：
- memory_tool.py docstring 备份范围同步 9 条关联（指向 SKILL_LINKED_KEYS 常量防漂移）
- 快照 payload 新增 skill_version 溯源字段（读取 manifest.yaml，缺失标 unknown）
- verify 增强：比较 tags/metadata（值一致但元数据漂移时报差异并提示重新备份）
- README.md 备份范围同步 9 条 + skill_version 说明
- 实测：list=37 条（28 skill:* + 9 关联）、backup 通过、verify 37 条一致、py_compile OK、日期/版本残留 0

## v1.14.6 — 边界定向修正

审计驱动（Boundary Cleanup，未新增能力/未改状态机行为）：
- Level 0/S2 定义统一：complexity-gate/router/transition 与 state-machine/manifest 对齐（Level 0 轻量 S2 = Task→Memory Router 最小召回 Step 0-1 + 消费清单记录，不执行代码向检查；消除"跳过 S2"与"S1→S2轻量→S4→S8"四文件冲突）
- Canonical Source 语义：SKILL.md 骨架化节新增三类型声明（Skill Canonical / Memory Canonical / Static Reference），conflict-resolution 条目标注为类型 A 摘要型；memory.md 路由表节与计数协议节补 canonical 注记（D3/D5/D7/D8 事实源收敛）
- user:persona 最高规则补 R0/R1 安全红线边界（无条件服从不覆盖不可逆操作/资产保护/三红线，先说明风险与等价方案等裁决）
- Kernel（AGENTS.md）上下文预算节移除 apply-model-limits.sh 项目路径，改引 project:opencode-model-limits（E1 项目知识泄漏修复）

## v1.14.5 — references/ 骨架化

- references/output-format.md 与 references/debug-mode.md 完整内容下沉为 skill:references/output-format + skill:references/debug-mode（level:domain, permanent, reference），文件保留骨架摘要 + 记忆引用（检索失败降级执行）
- SKILL.md 加载索引 + 骨架↔规则条目映射表同步（references 两文件加记忆 key 引用）
- references/example.md 保留文件（教学示例大内容，非规则，下沉收益低）
- backup 范围验证：skill:* 前缀自动覆盖新增 2 条（26→28）。未新增能力；宪法层（kernel/safety/state-machine/SKILL.md/manifest）未动

## v1.14.4 — 存量能力收敛优化

用户定向要求（只优化现有 Plan / Skill Routing 质量 + 项目经验抽离，禁止新增能力）：
- Plan 三要素语义增强（rules/plan.md）——为什么=关键实现决策（禁止"因为用户要求"）、完成判据=可观察最终状态（禁止"代码完成"）、验证=直接证明完成判据（Verification ↔ CC 对应）；明确 Plan 职责=需要什么能力，Skill 选择由 Routing 承担
- Skill Routing 质量（engine/skill-routing.md）——新增「判断顺序」（能力→内置够用→不路由）、「优先不 Routing」、「防 Routing 循环」；四问明确用于决策不用于生成长文；与 plan.md 重复表述收敛（plan.md 唯一事实源）
- Project Fact 抽离——state-machine.md + memory.md 中 apply-model-limits.sh 路径下沉为 project:opencode-model-limits（scope:project）；memory.md 两处 Experience 叙述精简（指向 rule:skill-iteration-manifest）
- backup/memory_tool.py 备份范围 SKILL_LINKED_KEYS 增加 project:opencode-model-limits（9 条关联）。未新增任何能力/状态/Agent/Tool/Skill/Memory 层；架构未重构

## v1.14.3 — backup/ 备份工具

用户要求（技能目录下增加备份文件夹 + 备份/更新脚本，备份技能相关联的数据记忆，跨平台可手动或 agent 调整数据库地址）：
- backup/memory_tool.py：纯 Python3 标准库跨平台（macOS/Linux/Windows）脚本，四命令 backup/restore/verify/list；备份范围=skill:* 前缀 26 条 + 显式关联 8 条共 34 条，不备份其他项目记忆
- 数据库路径解析优先级：--db > DELX_MEMORY_DB 环境变量 > backup/config.json > 自动探测（~/.delx-memory/db.sqlite，Windows %USERPROFILE%）
- 恢复 upsert 保留 created_at，FTS 由触发器自动维护
- snapshots/ 输出时间戳快照 + skill_memory_latest.json（latest 进 git 用于跨机器同步，历史快照 .gitignore 忽略）
- 实测验证：list=34 条、backup/verify 通过、restore 在副本库 upsert 34 条 + FTS 26 条

## v1.14.2 — 去重复规则优化

用户指出「delx-memory 规则无法生效？为何在 SKILL 描述中增加已有记忆的重复规则」——v1.14.1 修复时把规则内容复制进 transition.md/review.md，与 delx-memory 条目重复，违背骨架化架构（内容型规则唯一事实源 = 记忆条目）。修正：
- transition S2/S13 出口保留「动作+指针」，删除规则内容复制
- review.md 第 11 项删除——技能文档任务不走硬约束（走 Investigation/Level 0-Doc 三维审查），S13 出口已覆盖验证，硬约束恢复 10 项 = policy/safety.md §3 唯一事实源
- rule:skill-iteration-manifest 新增「生效机制」节（状态机入口表：S2 召回 + S13 验证，文件仅动作+指针）
- lesson:skill-edit-date-residue 追加修正记录。原则固化：规则唯一事实源 = delx-memory 条目；技能文件只承载「动作+指针」，禁止复制规则内容（防双重维护/规则漂移）

## v1.14.1 — 版本标注残留事故修复

用户反馈「规则为何还是不生效」，rule:skill-iteration-manifest 第 4 次同类触犯 + 规则生效机制结构性修复：
- 清除 v1.14.0 引入的正文版本标注 4 处（rules/plan.md×2、engine/skill-routing.md×1、skill:rules/plan:step-orchestration×1），grep 验证 0 残留
- 根因（3 层机制入口缺失）：Task→Memory Router 强制清单未被 S2 出口硬性绑定；v1.11.3 声称的 review.md 第 11 项从未落地；「修改后即验证」只是规则文本非状态机动作
- 修复：transition S2 出口第 1 项硬性绑定 Task→Memory Router、transition S13 出口新增技能/文档维护类任务 grep 0 残留强制验证、review.md + skill:rules/review:hard-constraints 补第 11 项（条件项）
- 教训：规则内容完备 ≠ 规则生效——生效依赖状态机入口（出口检查）而非规则自述

## v1.14.0 — Plan + Skill Routing 定向迭代

小范围渐进，不改状态机/Verification/Review Loop/Coding Loop/Tool/记忆核心：
- Planning 增强——S7 Step 拆分升级为六要素（为什么/需要能力+Skill 绑定/依赖/完成判据/验证），Plan 六问（Goal←Design、Requirements←Intent+Clarify，优先复用字段不新增），Level 2 单点任务新增「轻 Plan」（Goal+3-5 Step 内联）
- Skill Routing——新增 engine/skill-routing.md 轻量能力→Skill 选择协议（四问；候选来源：本机注册 Skill→内置阶段→子agent→领域专项；执行中 S8 出口适用性检查+[Skill 切换]说明协议；不路由条件防过度 Routing；与 S4 工作流 Router 职责分离）
- 连接 Plan 与 Skill——每 Step 能力绑定，Skill 只是步骤能力推荐不替代任务计划；transition S7/S8 出口检查、state-machine S7/S8 描述、SKILL.md 架构树+加载索引同步
- 未引入 Skill Registry/评分/动态调度/未来架构（留待后续迭代）

## v1.13.0 — 经验质量治理吸收

腾讯 QQ 浏览器团队经验系统方法论，用户决策吸收三项、评测集暂缓：
- 经验质量审计（memory.md 新增节：九类垃圾特征清单 + 三问审计；核心标准=召回后行为正向变更；应用于路径 C/Test→Lesson/Reflection/S12 批量确认）
- Merge 治理协议（memory.md 新增节：create/update/skip/contradict 四动作 + 唯一目标判定前置默认 create + Update 自检四问 + contradict 人工裁决）
- Dedup 收紧（去重协议加严格否决规则：When 不同/主结论类型不同/粒度不同/用途不同不合 + 禁止桥接式合并）
- reflection.md + skill:learning/reflection:card-template 同步三问审计字段；Quick Loop 闭环与 Consolidation Phase 4 同步引用

## v1.12.0 — 记忆链路迭代设计

用户经验驱动的系统梳理：
- Task→Memory Router（任务类型→强制召回清单，Preflight 硬性执行——解决"规则存而不用"根因，rule:skill-iteration-manifest 长期 access_count=0 事故）
- scope 作用域维度（scope:global/project/task 独立于优先级，防规则误升级污染全局）
- Quick Loop 记忆闭环（Level 0/1 出口内联去重/待保存/仪表盘，S12 提升从纸面到落地）
- 记忆健康度仪表盘（skill:system:metrics 增加 memory.principle_count/pattern_count/lesson_count/zero_access_entries 字段）
- metadata 完整性校验并入出口检查；skill:learning/memory:query-router + lightweight-queries 同步

## v1.11.3 — 独立复审后修复五项

- 嵌套自引用软链清理（skill 根内 vibe-coder-loop → obsidian 源，递归扫描重复遍历风险）
- 授权失效降级条款（计数回写/仪表盘自动执行依赖用户全局授权，授权不可确认时降级为欠账标记 + S12 批量确认清单，memory.md 规则8 + 仪表盘节 + state-machine S12 同步）
- pattern:memory-writeback-integrity 提升（lesson 三实例同类 ≥3，permanent；lesson 标 skill-evolved 保留历史引用）
- 加载兜底改为 read 绝对路径（glob 不遍历软链目录实测失效）
- 日期/版本/迭代叙述禁令进入 review.md 硬性约束检查项（第 11 项，防规则声明不落地）

## v1.11.2 — 系统仪表盘事件清单修复

用户反馈"主动触发未更新"：字段更新时机定义在触发点但写入只在 S13 出口，中间无记账导致 conflict/retrieval 等事件丢失（与 access_count 触发不落地同模式第 4 次暴露）。修复：触发即记账入会话级 metrics_events 清单 → S13 出口聚合（memory_get 取当前值叠加后完整回传，禁止"照抄旧值+只改 note"，空清单也显式标注）→ 欠账兜底；memory.md 仪表盘节 + skill:learning/metrics:early-warning 同步；补记存量漏记事件。

## v1.11.1 — 文件元数据清理 + learning/ 部分下沉

- 全文件移除 created/updated frontmatter 与正文日期/版本/迭代叙述（版本事实单一来源 manifest.yaml，grep 验证 0 残留）
- learning/ 部分下沉（方案 B）：reflection/evolution/skill-metrics 3 文件骨架化 + memory.md 查询参考三节下沉（-5,967B），8 条 skill:learning/* 条目落库；memory.md 协议核心（三层体系/访问计数/去重/提升/S12 清单）保留文件（防自指）

## v1.11.0 — SKILL 骨架化 + delx-memory 规则条目体系

用户设计（2026-08-10）：
- skill: 命名空间（skill:[领域]/[子域]:[具体名称]）+ level:core/domain/tactical + reference/permanent tag 体系
- CONFLICT_RESOLUTION 冲突仲裁（用户显式指令 > level:core > level:domain > level:tactical，policy/priority.md §3.5）
- 进化防抖观察期（auto_generated+pending_review → 3 次触发全成功升级 domain / 连续 2 次失败降级，删除需人工确认）+ 回滚锚点 skill:system:rollback_point
- 系统仪表盘 skill:system:metrics（S13 出口自动更新）
- p0-p2 骨架化：rules/ 6 文件瘦身为指针页（10.9K→~3K review.md 等），14 条规则条目下沉 skill:rules/*，SKILL.md 新增骨架↔规则条目映射表；宪法层（kernel/safety/state-machine）不沉

## v1.10-v1.10.5 — 真实任务验证细化

- Test 降级判定时机标准化（5 种降级情形）、Level 0 文档约束子集反向指针、rules/ 分级加载
- 独立审查暴露跨文件一致性修复 14 项
- 技能路径引用改为 skill 根（vibe-coder-loop/ 前缀）
- 上下文压缩协议修订（opencode 源码证据：Agent 无 compact 工具、80% 阈值对齐、诚实约束）
- 访问计数回写自动执行（用户 2026-08-05 全局授权）；S13 消费清单残留兜底回写

## v1.6-v1.9 — 早期迭代

- 三层记忆体系（实例→模式→原则）、Pattern Fingerprint、主动记忆召回、内存去重与质量评分、跨项目模式迁移、实时 Metrics 驱动
- 去重整合（4 旧文件降级指针页）、子 agent 加载包统一四件套、记忆写入对齐工具约束、加载索引补全、命名规范同步（experience:/global:）、codegraph 工具适配、skill-evolved 标记协议
- 运行期鲁棒性四项（steering/follow-up 双队列、LLM 层自动重试、Code 截断保护、上下文压缩防死循环）
- 真实运行验证路径修复（Level 0-Doc 变体、Level 0/1 Metrics Buffer 不落库、Level 0 文档出口单一事实源）
