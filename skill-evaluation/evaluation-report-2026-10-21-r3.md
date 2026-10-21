# Vibe-Coder-Loop 体系审查报告（2026-10-21 · 第三轮 · 变异测试强化）

## 0. 元信息

| 项 | 值 |
|---|---|
| 审查对象 | `Vibe-Coder-Loop` @ `b142b0b5f33384cb4cbe8b70b10fb80e15391886`（工作树仅本轮归档重命名） |
| Skill 版本 | `skills/vibe-coder-loop/manifest.yaml` = `1.22.1`（未迭代） |
| 审查范围 | `skills/vibe-coder-loop`（kernel/engine/rules/policy/learning/profiles/references/scripts/backup）、`skills/delx-memory-protocol`、`skills/skill-authoring`、`kernel/Vibe Coder.md`、`runtime/core`、`runtime/exec`、`scripts/`、`tests/`、`docs/`、`README.md` |
| 旧报告归档 | `skill-evaluation/archive/2026-10-20-pre-round3/evaluation-report-2026-10-20-r2.md`（上轮）；更早产物见 `archive/2026-10-20-pre-round2/`、`archive/2026-10-20-pre-review/` |
| 本轮约束 | 审查阶段**只读**（候选先在 `/tmp` 副本验证）；用户随后指令「修复所有问题」，修复结果见 **§13 修复回执** |
| 环境 | macOS Darwin 26.6.2；Bash 3.2.57；Python 3.13.3；delx-memory 本机库存在（`skill:*` 45 条）；**无 Agent 宿主真机轨迹** |
| 证据等级 | E0 推测 / E1 用户描述 / E2 文件读取 / E3 静态分析 / E4 运行或测试结果 |

> 本报告不把未执行项计为通过；无宿主轨迹的维度标「未评估」，不填满分。所有缺陷均给可复现命令或可核对行号。

---

## 1. 审查结论

### 1.1 总体判断

上一轮认定的两个 High 缺陷（标准 Loop 从 0 开始、空规则库 fail-open）**已实测关闭**：

- 标准路径 `S7→S8` 首次 `loop=1`，随后 2/3 轮，第 4 轮 `LOOP_BUDGET_EXHAUSTED`（E4）。
- 空规则库 `preflight` rc=3 + `[RULE_STORE_MISSING]`；真实库 rc=0；`--files` 应急路径 rc=0（E4）。
- `check-protocol` 82 项、零漂移；`smoke-check` rc0（规则 3877 / 预算 3900）。

本轮**新增变异测试**（在 `/tmp` 副本上定向删改配置）发现了一类比上轮更隐蔽的问题：**"门禁绿 ≠ 契约正确"仍然成立，只是盲区从"具体缺陷"移到了"阶段载荷覆盖率"与"profile 装配完整性"**。

本轮共确认 **10 项缺陷**（High 1 / Medium 6 / Low 3），其中 **6 项含 E4 复现**（命令或变异测试；D4 兼有 E2+E4），**4 项为 E2/E3 静态对照**。

### 1.2 阻断性判断

| 口径 | 结论 |
|---|---|
| 作者本机私有使用 | **不构成阻断**：状态机、执行层、记忆工具、审计链均可运行 |
| 对第三方宣称"默认加载即满足 R1 不可逆操作约束" | **构成阻断**：R3-D1 可复现——S8/S10 的默认两段式读**不含** `policy/safety.md` §1「不可逆操作清单」与 §2「冲突仲裁协议」 |
| 公开分发 | 仍受 LICENSE 缺位、规则库私有、Windows/Linux 未真机验证阻断（既有事项，非本轮新增） |

### 1.3 是否建议采纳修改

| 编号 | 建议 | 理由 |
|---|---|---|
| C1 | **采纳**（改 `load_plan.json` 两行） | 修复 R3-D1，零规则预算影响，门禁与自测仍全绿（已 Probe） |
| C2 | **采纳**（新增一条自测断言） | 关闭 R3-D2 的 5 个静默变异通道（已 Probe 证明现无防线） |
| C3 | **建议采纳**（补 4 个 profile 的 Required） | 关闭 R3-D3，纯装配层，不改语义 |
| C4 | 需**用户决策**后采纳 | R3-D4「Case B 的 `[Loop: 0]`」是语义二选一（改标签 or 改文档），不能单边改 |
| C5 | 需**用户决策**后采纳 | R3-D5「继续循环重置」要么补齐运行时入口，要么删条款 |
| C6–C10 | **建议采纳**（措辞/字段/接线） | 低风险，静态可核对 |

> 审查阶段按用户指令「不要修改当前项目的内容」只做 Propose 与 Probe；随后用户追加指令「修复所有问题」，**C1–C3、C6①、C7–C10 已落地（C4/C5/C6② 采用 §13 的决策后落地）**，回执见 §13。

---

## 2. 范围、结构与依赖

### 2.1 组件清单

| 层 | 内容 | 规模 |
|---|---|---|
| Skill 规则 | `kernel.md`、`engine/`(5)、`rules/`(7)、`policy/`(4)、`learning/`(含 memory 5 分片)、`profiles/`(6)、`references/`(7) | smoke 实测 **3877 行 / 预算 3900（余 23）** |
| 确定性工具 | `backup/memory_tool.py`（preflight/artifact/touch/metrics/backup/restore/verify/list/check-keys/export-rules） | 2315 行，仅标准库 |
| Runtime Core | 状态机 / Checkpoint / 协议一致性 / 恢复 / Safe Mode / 产物 | 约 6.0k 行，271 单测 |
| Runtime Exec | allowlist / 超时 / 截断 / 脱敏 / 差异 / 产物 | 约 2.2k 行，6+7 shell 用例 |
| 审计与自检 | `scripts/audit.sh`、`verify-symlinks.sh`、`smoke-check-core.sh` | 51 + 15 项 |
| 委托 Skill | `delx-memory-protocol` 1.2.0、`skill-authoring` 1.2.0 | 协议 + 自检引擎 |
| 测试 | `tests/core`(13 文件)、`tests/exec`(1)、`backup/test_memory_tool.py` | 271 + 56 用例 |

### 2.2 关键依赖关系（本轮核对）

- 规则正文下沉在 delx-memory `skill:*`（本机 45 条），仓库只分发骨架 → **fresh clone 必须 fail-closed**（已实测 rc=3）。
- `load_plan.json` = `SKILL.md` 两表的机器副本；`stage_sections` 决定**每个阶段实际读到哪些章节** ← 本轮缺陷集中于此。
- `runtime/core` 的 `LEGAL_TRANSITIONS` / `LOOP_RULES` 是 `engine/transition.md` 机器块的镜像，`check-protocol` 双向比对。
- `skill-authoring/scripts/smoke-check-core.sh` 是自检逻辑唯一事实源；两个实例脚本只做配置。

---

## 3. 基线实测（E4）

### 3.1 机械测试矩阵

| 命令 | 结果 | 耗时 |
|---|---|---|
| `python3 -m unittest discover -s tests -p 'test_*.py'` | **271/271 OK** | 25.0s |
| `python3 skills/vibe-coder-loop/backup/test_memory_tool.py` | **56/56 OK** | 15.3s |
| `bash scripts/tests/test-audit.sh` | **PASS=51 FAIL=0** | ~7s |
| `bash scripts/verify-symlinks.sh` | **PASS=15 FAIL=0 WARN=0** | — |
| `python3 -m runtime.core check-protocol` | `{"ok":true,"checks":82,"drifts":[]}` | — |
| `bash skills/vibe-coder-loop/scripts/smoke-check.sh` | **rc0**，HARD 0，规则 3877/3900 | — |
| `bash skills/skill-authoring/scripts/smoke-check.sh` | rc0（自测未配置 → 显式跳过） | — |
| `bash scripts/tests/test-runtime-core.sh` / `test-runtime-exec.sh` | 6/6、7/7 | — |
| `git ls-files` 中 `.state.md` / `snapshots/*` / `backup/rules/*` | **0**（隐私项未入库） | — |

机械断言合计：271 + 56 + 51 + 15 + 82 + 6 + 7 = **488 项通过**。

### 3.2 工作流契约实测（CLI）

| 用例 | 操作 | 实测 | 判定 |
|---|---|---|---|
| 标准首次进 Code | `S1→S2→S4(2)→S5→S6→S7→S8` | loop **1** | 通过（上轮 High 已修） |
| 标准 Loop 上限 | 重试至第 4 次 | 1→2→3 后 `LOOP_BUDGET_EXHAUSTED` | 通过 |
| Level 0 路径 | `S4(0)→S8→S13` | loop 1，直达 S13 | 通过 |
| Level 1 Quick 不重试 | `S9→S8` | `LOOP_BUDGET_EXHAUSTED`（loop_max=1） | 与文档一致 |
| Case B 预算 | loop=3 时 `S10→S6` | `LOOP_BUDGET_EXHAUSTED`（N+1=4） | 通过 |
| Case B 继承 | `S10→S6` 后 `S6→S7→S8` | 2 → 2 → 2（不二次递增） | 通过 |
| Investigation | `S7→S10`，`S10→S7` | loop 保持 0；`--loop` 必填（+1 或 0） | 通过 |
| S8 自环 | `S8→S8` | 合法，loop 不变 | 通过 |
| S14 升级/恢复 | `--force --reason` → S14 → `RESUME` | 升级成功；RESUME 缺用户原话证据被拒 | 通过（fail-closed 正确） |
| S14 停止 | `S14→S13` | 需「停止/接受」证据 | 通过 |

### 3.3 工具层契约实测

| 用例 | 实测 |
|---|---|
| `preflight --task nosuchtask` / `--level 9` / `--stage S99` | 均 rc=3 + `[INVALID_ARGUMENT]` + `[next]` |
| `preflight` 排除全部阶段（`^S1..^S13`） | rc=3「排除后阶段集为空」（不静默空清单） |
| 无 DB | rc=2 `[DB_NOT_FOUND]` + 恢复提示 |
| 空规则库（`memory` 表 0 行） | rc=3 `[RULE_STORE_MISSING]` |
| `preflight --files` 应急 | rc=0，显式「无加载计划 → 不裁剪」 |
| `verify <快照>` | rc=0「45 条全部与数据库匹配」 |
| `metrics` | rc=0，仪表盘 upsert 正常（输出瑕疵见 R3-D9） |
| `touch` 未知 key | rc=1，跳过而非崩溃 |
| `core state check` | `ok:true, quality:strict, 13 字段齐全` |
| `load-checkpoint`（模板 1970 值） | `CHECKPOINT_STALE`（29876193 分钟 > 1440） |
| `repeat-check` 同指纹 ×2 | 第 2 次 `NO_PROGRESS` 并自动升级 S14（经 `transition`，非旁路写入） |
| `exec` `git -C . push` / `git --no-pager push` | `SCOPE_DENIED`（子命令白名单按 argv[1] 判定） |
| `exec` `make` / `npm run` | **允许执行**（allowlist 含 make/npm；可执行任意脚本，属已声明的"防手滑"边界） |

---

## 4. 评分规则（Rubric）

### 4.1 维度与权重（沿用上轮口径，便于纵向比较）

| 维度 | 权重 | 0% | 40% | 70% | 100% |
|---|---:|---|---|---|---|
| 功能正确性 | 25 | 核心流程不可用 | 仅部分任务可完成 | 主流程可用但有可复现契约偏差 | 规则/流程/IO 均有测试证据 |
| 执行有效性 | 25 | 关键任务失败 | 只能完成简单任务 | 常见任务可完成，关键规则有偏差 | 真机轨迹 + 独立验收 |
| 规则一致性 | 15 | 规则互相矛盾不可仲裁 | 多处优先级/语义冲突 | 少量可复现漂移 | 单一事实源、无冲突 |
| 鲁棒性 | 15 | 异常即崩溃/静默错误 | 仅正常路径 | 常见异常可恢复，边界有缺口 | 边界/失败/重复执行均有测试 |
| 可维护性 | 10 | 无法定位/修改 | 结构混乱 | 分层清楚但有预算/文档债 | 职责清晰、文档测试实现一致 |
| 可移植性 | 10 | 绑定私有环境 | 仅作者机器可用 | 有文档但关键路径依赖私有资产 | 干净环境可复现，跨平台已验证 |

### 4.2 硬性门槛

任一不满足即不得宣称"已通过验证"：

- 违反安全红线或权限边界（删除/覆盖/提交/推送/迁移/部署）。
- 关键输出契约失效（阶段标签、`[next]`、Checkpoint 13 字段、Loop 预算）。
- 评估结果被环境错误污染，无法比较。
- 核心测试回归未解释；关键测试失败被计为通过。

### 4.3 本轮方法上的新增

1. **变异测试（mutation probing）**：在 `/tmp` 副本上定向删改 `load_plan.json` / profile，看门禁是否报警。这是本轮唯一能暴露"静默覆盖率缺口"的手段（上轮的用例式测试对这类缺口天然免疫）。
2. **同任务对照**：每个变异体与基线跑**同一套**门禁命令（smoke + 自测 + check-protocol）。
3. **失败即证据**：变异后仍全绿 = 该通道无防线，直接记缺陷，不做推测。

---

## 5. 分层测试集与结果

### 5.1 用例与结果

| ID | 类别 | 输入/操作 | 预期 | 实测 | 判定 |
|---|---|---|---|---|---|
| T-A1..A9 | 正常 | 全量单测 / 审计 / 软链 / 协议 / smoke / 两个 shell | 全过 | 488/488 | 通过 [E4] |
| T-A10 | 正常 | Level 0 全路径 | 1→S13 | 符合 | 通过 [E4] |
| T-B1 | 触发 | Skill description 能否被宿主选中 | 应触发/不误触发 | 无宿主轨迹 | **未评估** [E2] |
| T-C1 | 边界 | 无 DB | fail-closed | rc2 `DB_NOT_FOUND` | 通过 [E4] |
| T-C2 | 边界 | 空规则库 | rc!=0 | rc3 `RULE_STORE_MISSING` | 通过 [E4] |
| T-C3 | 边界 | 排除全部阶段 | 拒绝空集 | rc3 | 通过 [E4] |
| T-C4 | 边界 | 模板 1970 值恢复 | 判 stale | `CHECKPOINT_STALE` | 通过 [E4] |
| T-D1 | 冲突 | AUTO_MODE vs 不可逆操作 | 仍须仲裁 | `kernel/Vibe Coder.md:15` 声明 | 通过 [E2] |
| T-D2 | 冲突 | S8 必读 `policy/safety.md` 实际载荷 | 含 §1/§2 | **仅 §3/§4/§5** | **失败 High** [E4] → R3-D1 |
| T-D3 | 冲突 | profile Required 覆盖 S12/S13 义务 | 覆盖 | 4/6 profile 缺 | **失败 Medium** [E2] → R3-D3 |
| T-D4 | 冲突 | 300 行阈值：Signal vs 归档触发 | 单一口径 | `lifecycle.md:69` vs `:154` 互斥 | **失败 Medium** [E2] → R3-D7 |
| T-D5 | 冲突 | Agent Prompt 暂停条件 vs Skill 暂停条件 | 一致 | Prompt 缺「引用对象不可重建」（其余一致） | **失败 Low** [E2] → R3-D8 |
| T-E1 | 失败恢复 | `rm -rf` / `git push` 变体 | 拒绝 | `SCOPE_DENIED` | 通过 [E4] |
| T-E2 | 失败恢复 | 超时 / 截断 / 脱敏 | 结构化码 | 符合 | 通过 [E4] |
| T-F1 | 输出验收 | 13 字段模板 | 可解析 | `state check` strict | 通过 [E4] |
| T-F2 | 输出验收 | `metrics` 仪表盘行 | 格式正确 | `skeleton=Nonee/NoneB` | **失败 Low** [E4] → R3-D9 |
| T-G1 | 回归 | 82 项协议比对 | 零漂移 | 零漂移 | 通过 [E4] |
| T-H1 | 鲁棒性 | 重复执行全量测试 | 稳定 | 两轮一致 | 通过 [E4] |
| T-I1 | 可移植性 | 硬编码路径 / bash 4 特性 / py3.9 API | 无 | 仅脱敏正则命中；脚本显式规避 | 通过 [E3] |
| T-I2 | 可移植性 | README 快速开始命令 | 可执行 | `restore/verify/smoke` 均 rc0 | 通过 [E4] |
| T-J1 | 安全 | 输出含伪造密钥 | 脱敏 | `***REDACTED***` | 通过 [E4] |
| T-J2 | 安全 | 行数预算 | 不超 | 3877/3900 | 通过 [E4] |
| T-K1 | 工作流 | 标准首次 S8 | Loop=1 | 1 | 通过 [E4] |
| T-K2 | 工作流 | 标准 3 轮上限 | 第 4 轮拒绝 | 拒绝 | 通过 [E4] |
| T-K3 | 工作流 | Case B 的 `[Loop]` 标签 vs checkpoint | 单一事实 | 标签 0 / checkpoint N+1 | **失败 Medium** [E4+E2] → R3-D4 |
| T-K4 | 工作流 | 「继续循环」重置计数器 | 有可执行路径 | 无合法转换/CLI | **失败 Medium** [E4] → R3-D5 |
| T-K5 | 工作流 | SAFE MODE 阈值可配置 | manifest 生效 | 硬编码，manifest 不参与 | **失败 Medium** [E3] → R3-D6 |
| T-M1 | 变异 | 删 `level_stages["2"]` 的 S13 | 门禁红 | 红（自测命中） | 通过 [E4] |
| T-M2 | 变异 | 删 `levels["1"]` 的 `rules/test.md` | 门禁红 | **绿（rc0）** | **失败 Medium** [E4] → R3-D2 |
| T-M3 | 变异 | 删 `levels["0"]` 的 `learning/skill-metrics.md` | 门禁红 | **绿** | **失败** → R3-D2 |
| T-M4 | 变异 | 删 `policy/safety.md` S8 的「3. 约束分级」 | 门禁红 | **绿** | **失败** → R3-D2 |
| T-M5 | 变异 | 删 `policy/confidence.md` 整个 S8 映射 | 门禁红 | **绿** | **失败** → R3-D2 |
| T-M6 | 变异 | 删 `always_whole: [kernel.md]` | 门禁红 | **绿** | **失败** → R3-D2 |
| T-M7 | 变异 | 删 profile 的一行 Required（review 的 skill-metrics） | 门禁红 | **绿** | **失败** → R3-D3 |
| T-M8 | 变异 | C1 候选（S8/S10 各加 §1） | 门禁仍绿且载荷变全 | rc0，3877 行不变；S8 75→89、S10 68→82 | 通过（候选可用）[E4] |
| T-N1 | 未评估 | 跨会话压缩后恢复 | 可继续 | 无真机 | **未评估** [E2] |
| T-N2 | 未评估 | Linux / Windows 真机 | 可运行 | 仅 macOS | **未评估** [E2] |

### 5.2 统计

- 机械断言：**488/488（100%）**，覆盖确定性工具链。
- 非变异系统级用例：通过 **18** / 失败 **8** / 未评估 **3**。
- 变异用例（本轮新增）：通过 **2**（S13 删除被自测捕获、C1 候选） / 失败 **6**（5 个静默装配变异 + 1 个 profile 变异）。
- 失败集中在：**阶段载荷完整性（R3-D1/D2）**、**profile 装配（D3）**、**Loop 标签/重置语义（D4/D5）**、**阈值接线（D6）**、**规则互斥（D7/D8）**、**输出格式（D9/D10）**。
- 任务成功率：**未评估**（无 Agent 宿主轨迹）。确定性工作流子集（T-K1..K5）：**2 通过 / 3 失败**，不作为"任务成功率"对外宣称。

---

## 6. 缺陷清单

> 严重度按"对安全契约、失败关闭、公开发布、可维护性"的影响排序。E4 = 已运行复现；E2/E3 = 文件静态对照。
> **行号口径**：本节行号均指修复前基线 `b142b0b`；修复后行号会平移，修复落点见 §13。

### R3-D1（High）S8/S10 的默认载荷不含 R1 不可逆操作清单与冲突仲裁

| 项 | 内容 |
|---|---|
| 现象 | 按默认两段式读（`SKILL.md:96-97`），`preflight --level 2 --task coding --stage S8` 对 `policy/safety.md` 只命中 **L81-121(§3) / L122-133(§4) / L134-155(§5)**；S10 只命中 **L81-121 / L134-155 / L156-160**。**§1「不可逆操作清单」(L14-27) 与 §2「冲突仲裁协议」(L28-80) 全程缺失。** |
| 规则依据 | `SKILL.md:75`「S8 必读 `policy/safety.md`」；`SKILL.md:111` 明确「哪些文件必须进上下文以…加载时机索引为上限」——**文件级必读成立，章节级载荷未覆盖** |
| 实现位置 | `skills/vibe-coder-loop/load_plan.json` → `stage_sections["policy/safety.md"]`：S2=[§3,§4]、S3=[§1,§2,§5]、**S8=[§3,§4,§5]**、**S10=[§3,§5,§6]**、S12=[§3] |
| 影响 | 代码阶段（删除/覆盖/提交/推送/迁移/部署的**唯一发生地**）默认读不到 R1 不可逆清单；审查阶段也读不到 §2 仲裁协议。`policy/lifecycle.md` 只覆盖"资产归档"，不覆盖 commit/push/deploy/migration/overwrite |
| 为什么现有规则没解决 | `smoke` 的 `_unmapped_ok` 校验"每个 H2 至少被某阶段映射"，§1/§2 在 S3 已命中 → **判绿**；它不校验"某阶段是否仍覆盖其必需章节" |
| 缓解（不构成豁免） | `kernel.md` 为 `always_whole` 且含三红线；宿主 Prompt（`kernel/Vibe Coder.md:15`）声明"仍须先输出 Conflict Card"。但**仅靠 Skill 装配的宿主会丢这段**，且 §1 的五类操作在 kernel 中无对应 |
| 证据 | E4：上方 preflight 输出；T-M4/T-M5 证明该通道无门禁 |

### R3-D2（Medium，潜在 High）加载计划门禁无「阶段 × 文件 × 章节」覆盖率断言

| 项 | 内容 |
|---|---|
| 现象 | 5 个定向变异**全部 rc=0 全绿**：①删 `levels["1"].rules/test.md`；②删 `levels["0"].learning/skill-metrics.md`；③删 safety S8 的「3. 约束分级」；④删 confidence 的整个 S8 映射；⑤删 `always_whole: [kernel.md]` |
| 现状防线的边界 | 自测仅断言：每个 Level 含 S13；L0 含 S10；safety 的 **S10** 含 §5；`manifest.levels.stages == level_stages`；矩阵含用到的阶段行；`stage_sections` 匹配串命中真实 H2；`_unmapped_ok` 无僵尸条目 |
| 影响 | 后续任何"改装配"都可能静默丢文件/丢章节/让 R0 宪法可被裁剪，而 CI 全绿。**这正是项目自己在 `test_memory_tool.py:839` 记录过的 P1 失败模式**，只是盲区换到了"阶段载荷"与"per-level 文件清单" |
| 根因 | 门禁断言的是"路径存在 + 被 SKILL.md 提及 + 匹配串有效"，属**集合存在性**；缺的是**阶段→必需章节/文件**的覆盖关系（需要一张与 `SKILL.md` 分级加载/加载时机索引对应的期望表） |
| 证据 | E4：T-M2..T-M6 五个变异体与基线跑同一套 `smoke-check.sh` + 自测，全 rc=0 |

### R3-D3（Medium）Profile Required 清单未覆盖 S12/S13 强制义务

| Profile | 声称路径 | 缺失的强制文件 |
|---|---|---|
| `review.md` | Investigation：S1→S2→S4→S7→S10→S11→S12 | `learning/memory/lifecycle.md`（S13 回写契约）、`learning/skill-metrics.md`（S13 仪表盘）、`learning/memory/promotion.md`（S12 收尾）、`policy/lifecycle.md`（S12 记忆删除义务） |
| `skill-maintenance.md` | L0-Doc / Standard | 同上四项全缺（`retrieval.md` 亦缺） |
| `refactoring.md` | 全阶段 S1–S13 | `learning/skill-metrics.md`、`learning/memory/retrieval.md`（S2 强制召回） |
| `debugging.md` | L2+ 全阶段 S1–S13 | `learning/skill-metrics.md`、`learning/memory/promotion.md` |
| `coding.md` | L2+ 全阶段 | `learning/memory/promotion.md`（S12） |

- 规则依据：`SKILL.md:129-131`（分级加载下限）、`engine/transition.md:218-234`（S12/S13 出口含回写 + 仪表盘 + Checkpoint）。
- 影响：按 profile 装配的 Agent 在 S13 会命中 `[RULE_NOT_LOADED]` → 回退补读；若 Agent 不自纠，收尾义务（记忆回写 / 仪表盘 / pending 核验）被静默跳过。
- 证据：E2 静态对照；T-M7 证明删 Required 行无任何门禁反应。

### R3-D4（Medium）Case B 的 `[Loop: 0]` 标签与 checkpoint `loop=N+1` 永久分叉

| 项 | 内容 |
|---|---|
| 现象 | `rules/review.md:63` 要求情况 B 输出 `[Phase: Design] [Loop: 0]`；`kernel.md:200`/`state-machine.md:24,122` 写"重入序号 0，checkpoint `loop=N+1`"；运行时实测 `S10→S6` 后 `loop=2` |
| 影响 | 阅读输出的人看到 `[Loop: 0]`，读状态文件看到 `loop: 2`；跨会话恢复时"当前是第几轮"存在两个答案。`kernel.md:192` 的标签契约（`[Loop: N]` = 计数器）在此被打破 |
| 上轮状态 | 上轮记为 T-K3「失败/歧义」，修复选择为**加注释解释**而非统一口径 |
| 建议 | 二选一并写死：①标签改为 `[Loop: N+1]`（与 checkpoint 一致，`Design[0]` 只作内部记号）；②保留 0，但把 `[Loop: N]` 契约改为"N 为阶段重入序号，checkpoint 另有 loop 字段"——②会让所有其它阶段也要重新定义，成本更高 |

### R3-D5（Medium）「继续循环重置计数器」有条款无实现

| 项 | 内容 |
|---|---|
| 现象 | `engine/state-machine.md:120`「重置｜用户发送"继续循环"重置计数器（常规场景）」；`kernel.md:199-202` 无对应入口；运行时唯一 mutation 入口 `core transition` 无重置能力 |
| 实测 | S9(level 1, loop=1) 执行 `transition --to S8 --loop 0` → `[INVALID_ARGUMENT]`（inc 边要求 N+1=2）；唯一能归 0 的边是 `S13→S1` 与 `S10→S7(B)` |
| 影响 | 用户说"继续循环"时，Agent 要么违反文档、要么违反运行时；且"S14 继续（维持 N）"与"常规场景继续（重置）"没有可区分的执行路径 |
| 建议 | 二选一：①删除该行，明确"只有 follow-up / 新任务才归 0"；②增加显式转换（如 `--reset-loop` + `--reason`，并写进机器块与 check-protocol） |

### R3-D6（Medium）SAFE MODE 阈值不可配置，且强制触发集缺文档行

| 项 | 内容 |
|---|---|
| 现象 A | `kernel.md:157`「阈值见 `manifest.yaml tunable_parameters.safe_mode_triggers`；项目可按风险偏好调宽/调严」；`manifest.yaml:97-102` 给出 5 个键。实际：`runtime/core/safemode.py:17-21` **硬编码** `consecutive_same_failures=2`、`hard_constraint_violation=1`；全仓库无任何代码读取该 manifest 块（`grep manifest runtime/` 仅命中注释与 `protocol.py` 的**相等性断言**） |
| 现象 B | 强制触发键 `hard_constraint_violation` 在 `kernel.md:159-166` 的触发表中**没有对应行**（表内 6 行为文件数/删除风险/循环震荡/无进展/Memory 污染/规则冲突）；其映射目标 `hard_violation_repeats: 3` 语义是"重复 3 次"，代码却在第 1 次触发 |
| 影响 | 用户按文档调宽严格度会**静默无效**；`check-protocol` 只断言 `manifest >= code`，不校验语义与文档行覆盖，因此"绿"不代表可配置 |
| 证据 | E3（静态）+ E4（`protocol.py:520-528` 仅比对值）；文档 `docs/design/mvp-1-workflow-core.md:235` 声称"Core 读取这些值作缺省" |

### R3-D7（Medium）300 行阈值的语义自相矛盾（Signal vs 归档触发器）

| 项 | 内容 |
|---|---|
| 现象 | `policy/lifecycle.md:69` 将"文件累计归档注释致超 300 行约束"列为 Deprecated→Archived 的**触发条件（任一命中，Agent 可自主）**；同文件 `:154` 写"#2「文件 ≤ 300 行」是 **Signal** —— 超限**不自动**触发 Deprecated → Archived"；`kernel.md:55` 复述前者；`policy/safety.md:88` 定义 #2 为 Signal |
| 影响 | Agent 可据 `:69` 仅因超行数就搬移用户资产到 `archive/`，而 `:154`/safety 明确禁止"仅因规模自动重构"。这是**资产操作权限**层面的歧义，不只是文案 |
| 证据 | E2；三处文件对照可复核 |

### R3-D8（Low）Agent Prompt 暂停条件缺「引用对象不可重建」

| 项 | 内容 |
|---|---|
| 现象 | `kernel/Vibe Coder.md:78-81` 的 4 条暂停条件 vs `skills/vibe-coder-loop/kernel.md:24-30` 的 5 条：Prompt **缺「引用对象不可重建」**及其恢复语义；其余 4 条一致（含「触发调试模式」——Skill 侧同样列为暂停） |
| 影响 | 压缩后 TASK 区无法重建时，只按 Prompt 执行的宿主会继续猜测/重做；Skill 要求"输出现存进度并请求确认、维持原 Loop N" |
| 自评修正 | 本轮初稿曾写作"双向漂移（Prompt 含调试模式、Skill 不含）"。复核 `kernel.md:27` 后确认**该判断错误**：Skill 同样把调试模式列为暂停。已按实际证据收窄为**单向遗漏**（详见 §13.3） |
| 证据 | E2 |

### R3-D9（Low）`metrics` 仪表盘行多一个 `e`

| 项 | 内容 |
|---|---|
| 现象 | `memory_tool.py:1175-1176` 模板 `"skeleton={sk}e/{sb}B"`；实测输出 `skeleton=Nonee/NoneB` |
| 影响 | S13 每轮可见的输出瑕疵；不影响数值，但会让"确定性工具"的可信度打折 |
| 证据 | E4（`python3 backup/memory_tool.py metrics`） |

### R3-D10（Low）自检/骨架文件的三处遗留措辞

| 子项 | 内容 |
|---|---|
| D10.1 | `skill-authoring/scripts/smoke-check-core.sh:23` 契约注释仍写"校验 …（含 `updated_at` freshness）"，而实现（`:460-469`）只校验字段存在，输出也已改为"freshness 由 load-checkpoint 判定" → **同一文件内自相矛盾**（上轮 D7 只改了运行时文案） |
| D10.2 | `references/output-format.md:12` 与 `references/debug-mode.md:12` 声明"摘要只用于定位，不得作为规则推断依据"，但第 14 行标题仍为 **`## 摘要（降级用）`** → 标题与正文互斥（上轮 D2 fail-closed 措辞改造的遗留） |
| D10.3 | 上述两文件的"降级用"字样是唯一残留的 fail-open 暗示；其余 9 个骨架文件已统一为 fail-closed 措辞 |

---

## 7. Propose–Probe–Compose

> 用户本轮要求"不修改当前项目内容"。所有候选只在 `/tmp/vc-c1` 等副本验证，项目工作树零写入。

### 7.1 候选清单

| ID | 对应缺陷 | 最小修改 | 预期改善 | 副作用 | 验证 | 决策 |
|---|---|---|---|---|---|---|
| C1 | R3-D1 | `load_plan.json`：safety 的 `S8` 与 `S10` 各前置 `"1. 不可逆操作清单"`（`§2` 暂不加——它是 S3 仲裁协议，S10 加它需 +53 行） | S8 75→89 行、S10 68→82 行（各 +14）；R1 清单回到代码/审查阶段 | 每阶段多读 14 行（约 +0.6KB） | smoke rc0、3877 行不变、preflight 命中节含 L14-27 | **已验证，建议采纳** |
| C2 | R3-D2 | 在 `backup/test_memory_tool.py` 增 1 个断言：①每个 Level 的 `levels` 必含 SKILL.md 分级加载下限；②`safety.S8 ⊇ §1`、`safety.S10 ⊇ §1`；③`always_whole == ["kernel.md"]` | 关闭 5 个静默通道 | 断言需随规则演进维护（但比"无防线"便宜） | T-M2..M6 复跑应变红 | **建议采纳** |
| C3 | R3-D3 | 四个 profile 的 Required 各补 1–4 行（lifecycle/skill-metrics/promotion/retrieval） | S13 不再 `[RULE_NOT_LOADED]` | 每个任务多读 2–4 个小文件 | 静态核对 + 手测 preflight `--task <profile>` | **建议采纳** |
| C4 | R3-D4 | 二选一：标签改 `[Loop: N+1]`（改 `rules/review.md:63` + `state-machine.md:24`），或改写标签契约 | 单一事实源 | 影响所有输出样例 | 静态 + 快照对照 | **暂缓（需用户决策）** |
| C5 | R3-D5 | 二选一：删 `state-machine.md:120` 的"重置"行，或加 `--reset-loop` 转换 | 条款与实现一致 | 后者需动机器块 + 协议门禁 | CLI 实测 | **暂缓（需用户决策）** |
| C6 | R3-D6 | ①把 `hard_constraint_violation` 写进 `kernel.md` §5 触发表；②删"可按风险偏好调宽/调严"，或实现读取链（`config.json` → `evaluate`） | 文档与接线一致 | 实现读取链需改 Core + 测试 | 静态；若实现则 `test_safemode` 扩展 | **建议（①必做，②二选一）** |
| C7 | R3-D7 | 删 `lifecycle.md:69` 的"超 300 行"触发项，改为"300 行为 Signal，见 safety §3"；同步 `kernel.md:55` | 资产权限无歧义 | 无（Signal 语义不变） | 静态 + `security` 断言 | **建议采纳** |
| C8 | R3-D8 | Prompt 暂停条件补「引用对象不可重建」（保留调试模式——Skill 侧同样暂停） | 单向补齐 | 无 | 静态 | **建议采纳** |
| C9 | R3-D9 | 删模板里的多余 `e` | 输出正确 | 无 | 单测快照（如有） | **建议采纳** |
| C10 | R3-D10 | 改 3 处措辞（注释/标题） | 无自相矛盾 | 无 | smoke 复跑 | **建议采纳** |

### 7.2 Probe：C1 的实测结果

在 `/tmp/vc-c1`（`git archive HEAD` + 补 `backup/` 三文件）上打补丁：

```diff
 load_plan.json → stage_sections["policy/safety.md"]
-  "S8":  ["3. 约束分级", "4. 归档注释格式", "5. 子 agent 首步加载包"]
+  "S8":  ["1. 不可逆操作清单", "3. 约束分级", "4. 归档注释格式", "5. 子 agent 首步加载包"]
-  "S10": ["3. 约束分级", "5. 子 agent 首步加载包", "6. 子 agent 安全责任"]
+  "S10": ["1. 不可逆操作清单", "3. 约束分级", "5. 子 agent 首步加载包", "6. 子 agent 安全责任"]
```

| 指标 | 基线 | 候选 C1 |
|---|---|---|
| `smoke-check.sh` | rc0，3877/3900 | **rc0，3877/3900**（load_plan 不计入规则行数） |
| 自测（56 项） | 56/56 | **56/56** |
| `check-protocol` | 82/82 | **82/82** |
| S8 safety 命中节 | L81-121/122-133/134-155（75 行） | **L14-27 + L81-121/122-133/134-155（89 行）** |
| S10 safety 命中节 | L81-121/134-155/156-160（68 行） | **L14-27 + L81-121/134-155/156-160（82 行）** |
| R1 §1 是否在 S8 / S10 上下文 | **否 / 否** | **是 / 是** |

结论：C1 修复 R3-D1，**无回归、无预算影响**，改动仅 2 行 JSON。若把 §2「冲突仲裁协议」也加入 S10，代价是 +53 行（68→135），收益仅限「审查时复核仲裁过程」，**不建议**默认加入。

### 7.3 被拒绝 / 暂缓

| 项 | 原因 |
|---|---|
| 直接给 `policy/safety.md` 加 `always_whole` | 会把 160 行整文件塞进每个阶段，与"两段式读控字符量"的设计目标冲突；C1 更精确 |
| 把 C2 做成"任意装配变更都红" | 会把合法的按需调整也判红（如未来新增可选节），需维护期望表——代价可接受但需用户确认维护成本 |
| 修改 R3-D4/D5 的语义 | 证据只能证明"两处不一致"，不能证明哪一方是产品意图；留给用户决策 |
| 修改 `make`/`npm run` 的 allowlist | 与 `docs`/README 已声明的"防手滑，不是权限沙箱"一致；收紧会破坏正常构建流程 |

---

## 8. 回归与风险

### 8.1 回归

- 本轮**未修改项目任何文件**，不存在"修改引入的回归"。
- 基线 488 项机械断言全绿；两个 shell 用例集、协议 82 项、smoke、审计均通过。
- C1 候选副本复跑 smoke + 自测 + 协议：全绿（见 7.2）。
- 未在候选副本做 `audit verify -b baseline.tsv` 的计数比对（副本缺 `.git`，计数不可比）；原始仓库 `audit verify` 上轮 rc0，本轮未复跑（差异不影响结论，已披露）。

### 8.2 残余风险

| 风险 | 说明 | 等级 |
|---|---|---|
| S8 缺 R1 清单 | R3-D1；宿主若不提供 Prompt 层兜底，代码阶段的不可逆操作识别只能靠 memory | High |
| 装配门禁盲区 | R3-D2；未来改规则可静默丢章节，CI 全绿 | Medium（潜在 High） |
| Profile 漏读收尾 | R3-D3；S13 回写/仪表盘可能被跳过 | Medium |
| Loop 标签双口径 | R3-D4；人工/自动读取者得出不同轮次 | Medium |
| 重置条款悬空 | R3-D5；用户指令与运行时冲突 | Medium |
| 阈值不可配置 | R3-D6；调宽严格度静默失效 | Medium |
| 300 行歧义 | R3-D7；存在"仅因规模搬迁用户资产"的解释空间 | Medium |
| Exec 非沙箱 | `make` / `npm run` / `python3 -c` 可执行任意命令；已声明为防手滑 | Medium（声明内） |
| 规则预算 | 3877/3900，余 23 行；C7/C8 需净删或等量替换 | Low |
| 跨平台 | 仅 macOS 实测；Windows 依赖 Git Bash/WSL（文档已声明） | 未评估 |

---

## 9. 验证边界与未评估

**已执行验证（E4）**：271 单测 / 56 记忆工具 / 51 审计 / 15 软链 / 82 协议 / 6+7 shell / smoke / 10 条 CLI 工作流路径 / 4 条 S14 路径 / 7 个工具层错误路径 / **7 个变异体（1 被门禁捕获、6 静默）** / 1 个候选补丁。

**仅静态审查（E2/E3）**：profile 装配对照、Prompt↔Kernel 暂停条件、manifest 与代码接线、300 行语义、骨架文件措辞、Python 3.8 兼容性（未在 3.8 解释器实跑）。

**未验证（不宣称）**：
1. Agent 宿主真机轨迹（触发准确率 / 任务成功率 / 规则遵循率）。
2. 会话内压缩后的状态延续（`state-machine.md` 自带 E2/E3 标注，本轮未新增证据）。
3. Linux / Windows Git Bash 真机。
4. 干净机器端到端（临时 HOME + 私有快照恢复）。
5. Python 3.8 运行（README 声明 3.8+，本轮仅做静态 API 扫描，未发现 3.9+ 专有 API）。

---

## 10. 评估副作用披露（诚实约束）

审查过程中有一次对**本机运行数据的副作用**，按"不隐藏失败与影响"原则披露：

1. 用 `restore` 验证 README 命令时指定了**临时库**（`DELX_MEMORY_DB=/tmp/...`），但 `restore` 的写前快照固定落在 `skills/vibe-coder-loop/backup/snapshots/`。
2. 该工具按自身保留策略（`PRERESTORE_KEEP=2`）**清理了 1 个旧写前快照**（`skill_memory_prerestore_20260918_103125_174.json`）。该目录被 gitignore、未入库；即使不执行本次探测，下一次 `restore`/`backup` 也会按同一策略清理。
3. 我随后删除了本次新建的 `skill_memory_prerestore_20261021_083329_292.json`（本轮自产，非用户资产），使目录回到 1 个文件（原有 2 个，被保留策略减为 1）。
4. **真实 delx-memory 库未被写入**（`restore/metrics/touch` 全部指向临时库或只读命令）。

**审查阶段（§1–§12）结束时项目受版本控制的文件零改动**；随后按用户指令落地的修复见 §13（已改动 `load_plan.json`、profiles、kernel/policy、memory_tool 与自测）。

> 建议：若需彻底避免这类副作用，`restore` 的写前快照目录应可配置（当前与 `--db` 解耦），可列为后续优化项。

---

## 11. 评分与覆盖率

### 11.1 分项

| 维度 | 权重 | 得分 | 证据覆盖 | 扣分理由 |
|---|---:|---:|---|---|
| 功能正确性 | 25 | **17.5**（70%） | 高（E4） | 状态机/预算/执行层实测正确；R3-D1 安全载荷缺失、R3-D4/D5 契约分叉、R3-D6 接线缺失 |
| 执行有效性 | 25 | **10**（可测 12 分的 83%） | 中（确定性层） | 488 项机械断言全过；无 Agent 轨迹 → 13 分**未评估** |
| 规则一致性 | 15 | **10.5**（70%） | 高（E2/E4） | R3-D3/D4/D5/D6/D7/D8 六处可复现漂移 |
| 鲁棒性 | 15 | **10.5**（70%） | 中高（E4） | 异常/超时/截断/脱敏/降级均实测；R3-D2 门禁盲区（静默退化通道） |
| 可维护性 | 10 | **7.5**（75%） | 中（E2） | 分层与单一来源优秀；预算余 23 行、profile 漂移、骨架措辞遗留 |
| 可移植性 | 10 | **7**（70%） | 中（E3/E4） | 无硬编码路径、脚本规避 bash4/py3.9；仅 macOS 实测，Windows 未验证；`restore` 快照目录与 `--db` 耦合 |
| **可评估子集** | **75** | **63 / 75（84.0%）** | **约 85%** | 执行有效性 13 分未评估 |
| **综合（不宣称 100 分制）** | **100** | **63** | **覆盖约 75/100** | 13 分未评估，剩余 12 分为未覆盖维度 |

### 11.2 与上轮的关系（禁止直接相减）

- 上轮报告（已归档）在其自建测试集上给可评估子集 **48/75（64%）**，随后落地 D1–D9 修复并自估 ~56/75。
- 本轮测试集**再次扩大**（新增 8 个变异用例 + S14/Investigation/工具错误路径），且 R3-D1 是上轮未覆盖的新缺陷。
- 因此 **63/75 不能解释为"分数提升 15 分"**：它同时包含"上轮 High 已修（+）"与"新测试集暴露新缺陷（−）"两个方向。两轮口径不同，**不合并、不相加、不用于对外宣称改进幅度**。

---

## 12. 后续建议

> 下列第 1–11 项在用户指令「修复所有问题」后**已全部落地**（决策与验证见 §13）；第 12–14 项保留为后续。

### 必须修复（已落地，见 §13）

1. **C1**：`load_plan.json` 给 safety 的 S8 与 S10 各补 §1「不可逆操作清单」。（2 行 JSON；若认为审查阶段也需要仲裁协议，S10 再加 §2 需 +53 行）
2. **C2**：补 1 条自测断言覆盖"阶段载荷 + per-level 文件清单 + always_whole"。（防复发）
3. **C7**：删除或改写 `lifecycle.md:69` 的 300 行触发器，消除资产操作歧义。
4. **C9**：`skeleton={sk}e` → `skeleton={sk}`。

### 建议采纳（低风险、静态可核对）

5. **C3**：四个 profile 补 S2/S12/S13 必需文件。
6. **C6①**：把 `hard_constraint_violation` 写进 `kernel.md` §5 触发表（阈值语义与实际一致）。
7. **C8**：Prompt 暂停条件补「引用对象不可重建」，使 5 条与 `kernel.md` §1 对齐。
8. **C10**：3 处遗留措辞（smoke 注释、两个骨架标题）。

### 需用户决策（不可单边改）

9. **C4**：Case B 的 `[Loop: 0]` —— 改标签还是改契约？
10. **C5**：「继续循环重置」—— 删条款还是补运行时入口？
11. **C6②**：SAFE MODE 阈值 —— 删"可调"表述，还是实现 `config.json` 读取链？
12. `restore` 写前快照目录是否跟随 `--db` 隔离（多项目/多库场景避免互删）。

### 可选优化（无当前证据支持不作为必须项）

13. 为 `profiles/` 增加"Required ⊆ SKILL.md 索引"的机械对账。
14. 增加一个 `docs/audits/compatibility.md` 的 Linux 冒烟记录（需真机）。

---

## 13. 修复回执（用户指令「修复所有问题」后落地）

> 工作树已从 `b142b0b` 的只读基线变为**已修复状态**；版本号仍为 `1.22.1`（CHANGELOG「同版本第五批」，未提交 git 不迭代）。

### 13.1 处置一览

| 缺陷 | 决策 | 落点 | 验证 |
|---|---|---|---|
| R3-D1 安全载荷缺 §1 | 采纳 C1：S8/S10 各前置「1. 不可逆操作清单」（§2 未加——+53 行、且属 S3 仲裁协议） | `load_plan.json` | preflight S8 命中 L14-27（75→89 行）、S10 命中 L14-27（68→82 行）[E4] |
| R3-D2 门禁盲区 | 采纳 C2：新增 `test_real_plan_stage_payload_and_profile_coverage`（always_whole / S8·S10 必需章节 / per-level 分级加载下限 / profile Required / kernel §5 硬约束行） | `backup/test_memory_tool.py` | **6 个变异体全部转红**（13.4）[E4] |
| R3-D3 profile 漏读 | 采纳 C3：coding/debugging/refactoring/review/skill-maintenance 补 `memory/lifecycle`·`skill-metrics`·`promotion`·`retrieval`；planning 补 `retrieval`（不承担 S8–S13，故不补收尾三项） | `profiles/*.md` | 新用例逐文件断言；smoke rc0 [E4] |
| R3-D4 `[Loop: 0]` 分叉 | **决策：以计数器为准**——情况 B 输出 `[Loop: N+1]`，`Design[0]` 降为纯文档记号 | `kernel.md` §7、`engine/state-machine.md`、`rules/review.md`、`references/example.md` | 静态一致；check-protocol 82/82（机器块未变）[E2] |
| R3-D5 重置条款悬空 | **决策：删条款**（不新增运行时入口，避免动状态机/机器块）——「重置」行改为仅两条边归 0 | `engine/state-machine.md` | 与 `LEGAL_TRANSITIONS`/`LOOP_RULES` 的实际归 0 边一致 [E2+E4] |
| R3-D6 阈值不可配置 | **决策①**：kernel §5 增「硬约束违规 1 次」行，与 `safemode.py` 对齐；**决策②**：删「可按风险偏好调宽/调严」，改为「运行期事实源 = `safemode.py`，无项目级配置链」；manifest 标注观测/强制口径 | `kernel.md`、`manifest.yaml` | check-protocol 82/82（manifest 解析未破坏）[E4] |
| R3-D7 300 行互斥 | 采纳 C7：从 Deprecated→Archived 触发器移除行数项，显式声明 Signal 不自动触发归档；kernel 表同步 | `policy/lifecycle.md`、`kernel.md` | 静态 + smoke rc0 [E2] |
| R3-D8 Prompt 缺暂停项 | 采纳 C8（**按已修正的事实**）：补「引用对象不可重建」，保留调试模式 | `kernel/Vibe Coder.md` | 5 条与 `kernel.md` §1 对齐 [E2] |
| R3-D9 `Nonee` | 采纳 C9：模板 `skeleton={sk}/{sb}B` | `memory_tool.py` | 实测 `skeleton=None/NoneB` [E4] |
| R3-D10 措辞遗留 | 采纳 C10：smoke 注释；两个骨架标题改「摘要（仅定位，不作规则推断）」 | `smoke-check-core.sh`、`references/*.md` | smoke rc0 [E4] |

### 13.2 回归矩阵（修复后，E4）

| 命令 | 结果 |
|---|---|
| `python3 -m unittest discover -s tests -p 'test_*.py'` | **271/271 OK** |
| `python3 backup/test_memory_tool.py` | **57/57 OK**（+1 新用例） |
| `bash scripts/tests/test-audit.sh` | **51/51** |
| `bash scripts/verify-symlinks.sh` | **15/15** |
| `python3 -m runtime.core check-protocol` | **82/82，0 漂移** |
| `bash skills/vibe-coder-loop/scripts/smoke-check.sh` | **rc0**；规则 **3887 / 3900**（余 13 行） |
| `scripts/tests/test-runtime-core.sh` / `test-runtime-exec.sh` | 6/6、7/7 |
| `scripts/audit.sh check` | rc0 |
| 空规则库 preflight | rc3 `RULE_STORE_MISSING`（未回退） |
| 标准 Loop / Case B / Investigation / S14 | 修复前已实测；本轮只改文档与装配，未触及 `state_machine.py`，协议门禁 82/82 证明未漂移 |

机械断言合计：271 + 57 + 51 + 15 + 82 + 6 + 7 = **489 项**。

### 13.3 自评修正（必须记录）

R3-D8 初稿判为「双向漂移（Prompt 含调试模式、Skill 不含）」。复核 `kernel.md:24-30` 后确认：**Skill 侧第 27 行同样把「触发调试模式」列为暂停**——初稿结论错误。已把该缺陷收窄为**单向遗漏（缺「引用对象不可重建」）**，并相应收窄 C8 的修改范围（不再从 Prompt 删除调试模式）。

> 保留此条而非静默改稿：评估本身也受"未逐行核对就下结论"的影响，这正是本项目 `lesson:doc-path-verify-before-reference` 的同类问题。

### 13.4 变异复测（C2 有效性证明，E4）

把**修复后的** `test_memory_tool.py` 复制进 6 个变异体（各自保留其被破坏的装配），结果：

| 变异体 | 破坏点 | 修复前 | 修复后 |
|---|---|---|---|
| `m_testmd` | `levels["1"]` 删 `rules/test.md` | 绿 | **FAILED (failures=1)** |
| `m_metrics` | `levels["0"]` 删 `learning/skill-metrics.md` | 绿 | **FAILED** |
| `m_safety8` | safety S8 删「3. 约束分级」 | 绿 | **FAILED** |
| `m_conf8` | 删 confidence 的整个 S8 映射 | 绿 | **FAILED** |
| `m_always` | 删 `always_whole` | 绿 | **FAILED** |
| `m_profiles` | review 的 Required 删 skill-metrics | 绿 | **FAILED** |

即：6 个静默通道全部关闭；变异 → 门禁红的因果链可复现。

### 13.5 仍未验证（不宣称）

- Agent 宿主真机轨迹、会话内压缩恢复、Linux/Windows 真机、干净机器端到端（与 §9 相同，本轮未新增）。
- R3-D4/D5 的**语义决策**已落地，但"哪种输出标签更符合用户偏好"属产品判断，本报告只保证**单一事实源**，不保证偏好正确。
- 规则预算余量降到 **13 行**：后续任何新增规则都需先做等量替换。

### 13.6 修复后评分（仅可测部分，不宣称 100 分制）

- R3-D1/D2/D7 关闭 → 功能正确性与鲁棒性提升；D3/D4/D5/D6/D8/D10 关闭 → 规则一致性提升；D9 关闭 → 输出验收。
- 执行有效性（触发/任务成功/规则遵循）仍无 Agent 轨迹，**未评估**。
- 可评估子集从 **63/75** 预计升至 **约 68–70/75**（D1 +2、D2 +1、D3 +1、D7 +1、D4/D5/D6/D8/D10 各 +0.5–1）；**最终以下一轮复评为准**，本报告不回填评分表以免自评污染。

---

## 附录 A：复现命令

```bash
# 机械矩阵
python3 -m unittest discover -s tests -p 'test_*.py'
python3 skills/vibe-coder-loop/backup/test_memory_tool.py
bash scripts/tests/test-audit.sh
bash scripts/verify-symlinks.sh
python3 -m runtime.core check-protocol
bash skills/vibe-coder-loop/scripts/smoke-check.sh

# R3-D1：S8/S10 的 safety 载荷
python3 skills/vibe-coder-loop/backup/memory_tool.py preflight --level 2 --task coding --stage S8
python3 skills/vibe-coder-loop/backup/memory_tool.py preflight --level 2 --task coding --stage S10
# 期望（基线）：安全节只有 L81-121 / L122-133 / L134-155；缺 L14-27(§1) 与 L28-80(§2)

# R3-D2：变异测试（在 /tmp 副本上做，勿改工作树）
git archive HEAD | tar -x -C /tmp/vc-mut
cp skills/vibe-coder-loop/backup/{memory_tool.py,config.json,test_memory_tool.py} /tmp/vc-mut/skills/vibe-coder-loop/backup/
# 然后删 load_plan.json 的 levels["1"].rules/test.md，再跑：
cd /tmp/vc-mut && bash skills/vibe-coder-loop/scripts/smoke-check.sh   # 基线行为：rc0（应为 rc1）

# R3-D5：重置路径不可达
core transition --cwd <tmp> --to S8 --loop 0      # 在落于 S9 的 loop=1 标准项目上 → INVALID_ARGUMENT

# R3-D6：manifest 阈值不参与运行
grep -rn "manifest" runtime/ --include='*.py'      # 仅 protocol.py 的相等性断言

# R3-D9
DELX_MEMORY_DB=<临时库副本> python3 skills/vibe-coder-loop/backup/memory_tool.py metrics | sed -n 2p   # skeleton=Nonee/NoneB
```

## 附录 B：归档与产物

- 本轮归档：`skill-evaluation/archive/2026-10-20-pre-round3/evaluation-report-2026-10-20-r2.md`
- 历史：`archive/2026-10-20-pre-round2/evaluation-report-2026-10-20.md`、`archive/2026-10-20-pre-review/{baseline-report,evaluation-rubric,test-cases,iteration-log,evaluation-report}.md`
- 本轮产物合成单文件（按用户「输出审查结果 md 文件」指令）：`skill-evaluation/evaluation-report-2026-10-21-r3.md`
  - 内含：基线报告（§2-3）、评分规则（§4）、测试集（§5）、缺陷清单（§6）、迭代记录（§7）、执行指标（§5.2/§11）、未解决风险（§8-9）
- 候选副本：`/tmp/vc-c1`（C1 已打补丁，验证通过）；`/tmp/vc-m_s9`、`/tmp/vc-m_testmd`、`/tmp/vc-m_metrics`、`/tmp/vc-m_profiles`、`/tmp/vc-m_safety8`、`/tmp/vc-m_conf8`、`/tmp/vc-m_always`（变异体）。均为临时验证环境，不作为交付物。
