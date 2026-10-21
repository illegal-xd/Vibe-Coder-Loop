# Vibe-Coder-Loop 体系审查报告（2026-10-21 · 第六轮 · 只读复评）

> 本轮性质：**审查 + 评估，不修改项目内容**（用户明确要求）。所有缺陷均给出候选修改方案与验证方式，但**未实施**。

## 0. 元信息与审查范围

| 项 | 值 |
|---|---|
| 审查对象 | ① `skills/vibe-coder-loop`（Workflow 主体） ② `skills/delx-memory-protocol`（协议委托） ③ `skills/skill-authoring`（Skill 维护协议 + 自检引擎） ④ `kernel/Vibe Coder.md`（身份 Prompt） ⑤ `runtime/core` + `runtime/exec`（确定性层） ⑥ `scripts/*.sh`、`tests/`、`docs/`、`README.md` |
| 基线 commit | `a831c9eb6b261e001d1066e9c0dba60383a03234`（`main`，工作树干净） |
| 版本 | `manifest.yaml version = 1.22.1`（CHANGELOG 同版本多批次） |
| 规则规模 | 规则类文件 **3892 行**（smoke 实测）/ 预算 3900（余 8） |
| 环境 | macOS 26.6.2（Darwin 26.6.2）；Bash 3.2.57；Python 3.13.3；PyYAML 6.0.3；本机 delx-memory 库可用（`lesson:*` 75 / `project:*` 75 / `reflection:*` 20 / `pattern:*` 4 / `experience:*` 5） |
| 证据等级 | E0 推测 / E1 用户描述 / E2 文件读取 / E3 静态分析 / E4 运行或测试结果 |
| 旧产物归档 | `skill-evaluation/archive/2026-10-21-pre-round6/evaluation-report-2026-10-21-r5.md`（本轮唯一移动项） |
| 累计归档 | `archive/2026-10-20-pre-review/`、`archive/2026-10-20-pre-round2/`、`archive/2026-10-20-pre-round3/`、`archive/2026-10-21-pre-round4/`、`archive/2026-10-21-pre-round5/`、`archive/2026-10-21-pre-round6/` |

**审查方式**：先跑全量机械矩阵确认"当前基线是否如既往报告所述"，再做**独立探针**（不依赖既有测试集的断言），最后按 rubric 打分。**评分只由本轮亲自采集的证据决定**，不沿用历史报告的自评分数。

---

## 1. 审查结论

### 1.1 总体状态

- **机械层稳固**：492 项断言全绿（274 单测 + 57 记忆工具 + 51 审计 + 15 软链 + 82 协议 + 6/7 shell），smoke `rc=0`（3892/3900），`audit scan --fail-on=high` `rc=0`（仅 H002 info）。
- **发现 1 项 High、2 项 Medium、4 项 Low**，其中 High 与此前五轮均未被识别，属**门禁盲区**而非新引入回归：
  - `engine/router.md` 与 `profiles/review.md` 定义的 **Investigation 主路径 `S4 → S7` 在机器可读转移表与运行时中不存在**，实测被 `STATE_ILLEGAL_TRANSITION` fail-closed 拒绝（E4）。`check-protocol` 无法发现，因为它只比对"文档机器块 ↔ 代码表"，两者**一致地缺失**这条边。
- 工作树除归档移动外**无改动**；本轮无回归可言（未修改），问题均为既存。

### 1.2 阻断性判断

| 口径 | 结论 |
|---|---|
| 本机私有使用（Markdown 驱动，无 runtime 强制） | 不构成阻断（Agent 可凭叙述走通 Investigation） |
| **启用 `runtime/core` 状态强制时** | **构成阻断**：所有 E 类（调研/审查/分析）任务在 S4 后无合法入边到 S7，`--force` 也无效（rc=4） |
| 公开分发 | 仍受 LICENSE / A-13 CHANGELOG 内容 / Git 历史（A-22）三项人工决策阻断（既有，未变化） |

### 1.3 是否建议采纳修改

建议采纳 **R6-D1（补边 + 流程级路径测试）** 与 **R6-D2（口径计数对齐）**；其余 5 项建议在下一轮"最小修补"批次一并处理。本轮按用户要求**不改动**。

---

## 2. 结构与依赖（基线）

| 层 | 内容 | 规模 |
|---|---|---|
| `kernel.md` | R0 红线 / Evidence / Rule Priority / SAFE MODE / 计数器 | 205 行 |
| `engine/` | state-machine / transition / complexity-gate / router / skill-routing | 266 + 294 + 117 + 66 + 61 |
| `rules/` | intent / design / plan / code / test / review / orchestration | 86/60/102/53/67/98/86 |
| `policy/` | safety / lifecycle / confidence / priority | 162/164/91/162 |
| `learning/` | reflection / evolution / skill-metrics / memory（+ 5 分片） | 69/63/115/29 + 163/178/97/103/31 |
| `profiles/` | 6 张任务入口路由卡 | 41–53 |
| `references/` | governance / e4-matrix / layout / example / output-format / debug-mode | 64/85/54/55/18/18 |
| 确定性工具 | `backup/memory_tool.py`（仅标准库）+ `scripts/smoke-check.sh`（薄包装） | 约 2.2k 行 |
| Runtime | `runtime/core`（状态机/Checkpoint/协议/恢复/SafeMode）+ `runtime/exec`（allowlist/超时/截断/脱敏） | 约 8.2k 行 + 274 测试 |
| 依赖 | 规则库 `skill:*`（required，缺失 fail-closed）；delx-memory / codegraph / skill-authoring（可选） | — |

**单一事实源现状**：版本(`manifest`) / 迭代历史(`CHANGELOG`) / 转移表(`transition.md` 机器块 ↔ `state_machine.py`) / 加载计划(`SKILL.md` ↔ `load_plan.json`) / 安全清单(`policy/safety.md`) / 记忆协议(`delx-memory-protocol`) —— 分工清晰，但**叙述层（router / profiles / state-machine 图）未纳入任何机器校验**，这正是 D1 的成因。

---

## 3. 缺陷清单（均含位置、根因、证据、后果、最小修复、验证方式）

### R6-D1 · High · Investigation 主路径 `S4 → S7` 无机器可读边，运行时 fail-closed

| 项 | 内容 |
|---|---|
| 现象 | 文档三处声明 E 类任务走 `S1 → S2 → S4 → S7 → S10 → S11 → S12`；运行时拒绝该步 |
| 位置 | `engine/router.md:48`、`profiles/review.md:23`、`engine/state-machine.md:56`（转移图）；`engine/transition.md:18-40`（机器块，缺边）、`engine/transition.md:137-141`（Investigation 分支）；`runtime/core/state_machine.py:55`（`"S4": {"S5","S8"}`） |
| 证据 | **E4**：`core transition --cwd /tmp/vcprobe --to S7` → `{"ok":false,"code":"STATE_ILLEGAL_TRANSITION","fail_closed":true}`，`rc=4`；`--force` 无效（force 仅用于 S14 升级弧）。E2：机器块 `S4 -> S5, S8(loop=1)` 无双出边 |
| 根因 | `check-protocol` 的校验关系是「文档机器块 ↔ 代码表」**双向比对缺边/多边**，而**叙述层（router/profiles/状态图）不在比对范围**。两侧同时缺失 → 82/82 全绿。这是校验契约的**范围盲区**，不是实现 bug |
| 后果 | ① 启用 runtime 强制时，所有 E 类任务（含本次审查任务本身）在 S4 撞死锁：合法后继只有 S5（Investigation 声明跳过）与 S8（无代码产出）→ **无路可走**；② 即便退回 Markdown 驱动，Agent 读到 `STATE_ILLEGAL_TRANSITION` 的 `[next]`（"回退执行当前阶段出口清单"）也会形成回环；③ 该路径**零测试覆盖**（`tests/core/` 无 S4→S7 用例） |
| 最小修复（候选，未实施） | ① `transition.md` 机器块加 `S4 -> S7(loop=0)     # Investigation 分支`；② `LEGAL_TRANSITIONS["S4"]` 加 `"S7"`，`LOOP_RULES[("S4","S7")]="reset0"`；③ 新增**流程级**测试：把三条主流程（Quick / Standard / Investigation）各跑成一条有序路径断言，而非仅逐边断言；④ `check-protocol` 增加"流程声明 ⊂ 可达路径"的可选校验（至少覆盖 router.md 中出现的 `S1 → …` 序列） |
| 验证方式 | `python3 -m runtime.core check-protocol`（应仍 82 且含新边）+ 新增路径测试 + 手工 `transition` 序列 `S0→S1→S2→S4→S7→S10→S11→S12→S13` 全绿 |
| 回归风险 | 低：新增边不改变既有边的语义；`loop=0` 进入 S7 与「Investigation 不进入 Code 链」一致。风险点 = `loop` 归 0 是否与「S13→S1 / S10→S7 才归 0」的既有口径冲突 → 需同步 `state-machine.md` §循环计数规则「重置」行（改为三条边或表述为"pre-code 阶段恒 0"） |

### R6-D2 · Medium · 「Level 0 文档修改约束子集」自称 4 项，实为 5 项

| 项 | 内容 |
|---|---|
| 位置 | 事实源 `policy/safety.md:149-154`（5 条 bullet）；引用方 `engine/complexity-gate.md:61,76,88`、`engine/transition.md:145,172` 均写「4 项」 |
| 证据 | **E2**：逐条计数 = ①不删除/不覆盖(#6) ②路径引用 E2 验证 ③落盘验证 ④多轮编辑结构指纹 ⑤Confidence/Evidence(#10) = **5**；全文 5 处写 4 |
| 根因 | 历史上修过一次计数（CHANGELOG:719「5 项改 4 项」），之后新增第 4 条（结构指纹）**未回改计数**；无机器校验 |
| 后果 | Agent 按"4 项"执行时**必然少做 1 项**。最易被跳过的是后加的结构指纹（长文档多轮编辑的防线）或 #10 标注 —— 属**静默降级**，且审查时无法判定"是否漏项" |
| 最小修复 | 事实源处给 5 条编号（1–5），引用方改为「5 项」；或把子集改为表格并声明条目数由表格行数决定（防再漂移） |
| 验证方式 | 新增断言：解析 `safety.md` 子集 bullet 数 == 引用方声明数；smoke 增一条计数一致性检查 |
| 回归风险 | 极低（纯文案 + 计数） |

### R6-D3 · Medium · 归档注释格式表不覆盖非 JS/前端语言，且声明了模板中不存在的 `{替代者}`

| 项 | 内容 |
|---|---|
| 位置 | `policy/safety.md:124-134`（§4 格式表：仅 JS/TS/CSS/JSONC 与 HTML/Vue/JSX）；`policy/lifecycle.md:53`（要求"归档注释中明确标注新替代者"） |
| 证据 | **E2**：格式模板只有 `[v{版本号}] {归档原因}` 两个占位符；第 133 行另定义 `{替代者}` 但两行模板均无该位；全文无 Python / Java / Go / SQL / Shell 的归档格式 |
| 后果 | ① **Hard #9「归档注释格式」在多语言项目中不可判定**（后端项目没有 canonical 格式 → 审查要么放过要么误判）；② `{替代者}` 位置未定 → 同一份代码里出现"写进原因/另起一行/不写"三种写法，破坏可检索性 |
| 最小修复 | ① 模板补 `| 替代者: {替代者}`；② 增补 3 类语言的等价格式（`# @Iteration:` / `// @Iteration:` / `-- @Iteration:`），或改为"语言注释符 + 统一正文格式"的生成式表述，避免逐语言枚举膨胀预算 |
| 验证方式 | 用 Python/Java 各写一条示例，按 §4 规则走一遍 Review 硬项 #9，确认判定唯一 |
| 回归风险 | 格式放宽可能被误读为"任选格式"→ 修完须保留"正文格式统一"的强约束 |

### R6-D4 · Low-Medium · 19 处 `memory/*.md` 短路径不可解析（skill 根基准下不存在）

| 项 | 内容 |
|---|---|
| 位置 | `profiles/coding.md:19,45`、`debugging.md:19`、`planning.md:20`、`refactoring.md:19`、`review.md:20`、`skill-maintenance.md:19`、`references/governance.md:15,16,64`、`learning/memory/advanced.md:13` |
| 证据 | **E2**：`skills/vibe-coder-loop/memory/{retrieval,lifecycle,promotion,architecture,advanced}.md` 均不存在（实测 `os.path.exists` 全 False）；真实路径为 `learning/memory/*.md`。注：`learning/memory.md:18-23` 的 `memory/*` 是**相对本目录**的合法写法，不在此列 |
| 根因 | 下沉分片时（`memory.md → memory/*.md`）沿用了相对写法，引用点分散在 `profiles/`、`references/`、`learning/memory/` 三层，各自正确基准不同 |
| 后果 | S2 的 **Task→Memory Router 是状态机强制动作**，其入口指引指向不存在路径 → Agent 可能①多花一次失败 read，②直接跳过强制召回（静默漏召回，正是历史事故 `lesson:memory-metadata-overwrite` 的同类形态）。smoke 的死指针检查是**词表驱动**（`DEAD_PTR_WORDS`），不覆盖"路径存在性"，因此 3892 行全绿 |
| 最小修复 | 统一改为 `learning/memory/<x>.md`（skill 根基准，与 SKILL.md「加载规则」一致）；smoke 增一条"反引号路径存在性"校验（`load_plan.json` 已有的同类检查扩展到文档正文，需排除 `skill:`/`rule:`/`lesson:` 前缀与外部路径） |
| 验证方式 | 该检查应对现有 19 处全红，改完后全绿；同时确认 `learning/memory.md` 的相对写法不被误报 |
| 回归风险 | 低；但需定义"相对路径白名单"，否则误报会让人关掉检查 |

### R6-D5 · Low · `[OUTPUT_LIMIT]` 6 处输出缺 `[next]`，违反 Skill 自身"错误码铁律"

| 项 | 内容 |
|---|---|
| 位置 | `backup/memory_tool.py:1634,1642,1644`（preflight 截断）、`:1976,1985,2006`（artifact clamp / 字节上限）；铁律见 `engine/transition.md:252` |
| 证据 | **E4**：`preflight --level 1 --task coding` 实际输出 `[OUTPUT_LIMIT] 章节标题超长已截断显示；…`（无 `[next]` 行）；测试 `test_memory_tool.py:780` 只断言该文案存在，**未断言 `[next]`**（其他码在 705/718/752/1014 等处有断言） |
| 后果 | 按文档定义这些输出"不构成错误码"→ Agent 拿不到单一确定动作（虽然文案里暗示了 read，但不符合可机械解析的契约）。属**契约自洽性**缺口，非功能性错误 |
| 最小修复 | 6 处补 `[next]` 行（`read <file>` / `artifact page --offset <n>`）；`test_memory_tool.py` 增加"所有 `[CODE]` 行必须有配对 `[next]`"的通用断言（比逐条断言更防再犯） |
| 验证方式 | 通用断言 + 现有 3 条路径复跑 |
| 回归风险 | 极低；输出变长 ≈ +40 字符/处 |

### R6-D6 · Low · CHANGELOG（迭代历史唯一事实源）批次顺序非单调

| 项 | 内容 |
|---|---|
| 位置 | `CHANGELOG.md:7`（第四批）→ `:28`（第六批）→ `:45`（第五批）→ `:65`（第二批）→ `:115`（第三批） |
| 证据 | **E2**：`grep -n "^## v1.22.1\|同版本第.*批"` 输出如上，第六批位于第五批之上，第四批置于全文之首 |
| 后果 | 读者/Agent 无法靠位置判断"最新批次"；与 `rule:skill-iteration-manifest`「append-only 历史源」的可用性预期冲突。语义未错（批次号自带顺序），故为 Low |
| 最小修复 | 按批次号重排（同版本内 1→6 自上而下或自下而上，选一种并注明口径）；或在文首加"批次索引表"（编号 → 行号） |
| 验证方式 | 新增断言：同版本 `## v1.22.x` 区块内"第N批"编号单调 |
| 回归风险 | 低（纯文档重排，注意不要丢失条目） |

### R6-D7 · Low · 活文档残留过期计数/环境值

| 项 | 内容 |
|---|---|
| 位置 | `docs/audits/residual-risks.md:36`（"不影响现有 **51** 项测试" → 实际 57）、`:54`（"macOS Darwin **25**" → 实测 26.6.2） |
| 证据 | **E4**：`test_memory_tool.py` = 57 tests；`sw_vers -productVersion` = 26.6.2。注：`docs/audits/2026-10-19-*.md:103` 的"51 tests"已声明为**修复前历史快照**，不扣分 |
| 后果 | 与 R4-D6 同类（计数硬编码漂移），但仅剩活文档两处；误导读者判断回归基线 |
| 最小修复 | 改为"以 `test_memory_tool.py` 末行 `OK` 为准"（与 `compatibility.md` 已采用的口径一致）；Darwin 版本改为占位或更新 |
| 验证方式 | 全库 grep `\b(51|55|43)\b.*测试` 应无命中 |
| 回归风险 | 无 |

---

## 4. 评分（Rubric + 本轮实测）

### 4.1 评分口径

| 维度 | 权重 | 100% 判据 |
|---|---:|---|
| 功能正确性 | 25 | 规则/流程/I-O 均有证据且无契约偏差 |
| 执行有效性 | 25 | 真机轨迹 + 独立验收 |
| 规则一致性 | 15 | 单一事实源、无冲突、无死指针 |
| 鲁棒性 | 15 | 边界/失败/重复执行均有测试 |
| 可维护性 | 10 | 职责清晰、文档测试实现一致 |
| 可移植性 | 10 | 干净环境可复现、跨平台已验证 |

等级：0% / 40% / 70% / 100%（可给中间分并说明依据）。硬性门槛：安全红线 / 关键输出契约 / 评估污染 / 核心回归。

**本轮计分规则**：可评估上限 = 100 − 未评估权重(13，属执行有效性的真机轨迹项) = **87**；同时披露"若把未评估项按 0 计"的 100 分制值（不作为结论）。

### 4.2 得分

| 维度 | 权重 | 本轮 | 依据 |
|---|---:|---:|---|
| 功能正确性 | 25 | **20** | 492 项机械断言全绿、`check-protocol` 82/82；扣 5：D1（High，主流程在运行时不可执行，且门禁无法覆盖）、D3（Hard #9 在多语言下不可判定） |
| 执行有效性 | 25 | **10.5 / 12 可测** | 确定性任务全过；13 分（宿主触发/成功率/规则遵循）**无真机轨迹 → 未评估** |
| 规则一致性 | 15 | **11** | 单一事实源体系清晰；扣 4：D2（4 vs 5）、D4（19 处不可解析引用）、D6（历史源顺序） |
| 鲁棒性 | 15 | **12** | 参数校验 / fail-closed / 变异门禁既往有效；扣 3：D5（错误码契约不完整）、跨平台未验 |
| 可维护性 | 10 | **8** | 分层与渐进披露优秀；扣 2：D6/D7 漂移 + 规则预算余 8 行（任何新增需等量替换） |
| 可移植性 | 10 | **7** | 无个人绝对路径 / 脱敏 0 残留 / 私密快照已忽略；扣 3：仅 macOS 实测、D4 影响跨环境加载 |
| **可评估子集** | **87** | **68.5（78.7%）** | 88/100 权重有证据 |
| 综合（100 分制，未评估项按 0） | 100 | **68.5** | 覆盖 87/100，**不宣称**完整 100 分制 |

> **与历次报告的关系**：R5 自评 75.0。本轮 68.5 **不是代码回归**（工作树除归档移动无改动），而是**新增证据**：D1（High）此前五轮均未发现，D2/D4 亦为新增实证。按"只有证据证明不满足才扣分"的规则，分数下调成立。**分数不是采纳依据**——采纳与否逐项见 §6。

### 4.3 执行指标（单独报告）

| 指标 | 值 | 分母 / 口径 |
|---|---|---|
| 机械断言通过率 | **492/492 = 100%** | 274 + 57 + 51 + 15 + 82 + 6 + 7 |
| 关键测试通过率 | **100%**（既有集） | 同上；**但 R6-D1 路径零覆盖** → 关键覆盖 ≠ 关键正确 |
| 规则遵循率 | **未评估** | 需真机轨迹（13 分未评估域） |
| 回归通过率 | **不适用/100%** | 本轮未修改；仅归档移动（无代码回归） |
| 触发准确性 | **未评估** | 无宿主选择轨迹 |
| 已确认缺陷 | High 1 / Medium 2 / Low 4 | 见 §3 |
| 独立探针 | 14 项（10 通过 / 4 暴露缺陷） | 见 §5 表 |
| Token / 耗时 | 未采集 | 宿主未暴露 |

---

## 5. 分层测试集与结果（本轮实跑）

| ID | 类别 | 输入 / 操作 | 预期 | 实测 |
|---|---|---|---|---|
| T-A1 | A 正常 | `unittest discover -s tests` | 全过 | **274/274 OK** [E4] |
| T-A2 | A 正常 | `test_memory_tool.py` | 全过 | **57/57 OK** [E4] |
| T-A3 | A 正常 | `test-audit.sh` / `verify-symlinks.sh` | 全过 | **51/51、15/15** [E4] |
| T-A4 | A 正常 | `core check-protocol` | 无漂移 | **82 checks, ok=true** [E4] |
| T-A5 | A 正常 | `smoke-check.sh` | rc0 | **rc0；3892/3900；HARD 0；死指针 0** [E4] |
| T-A6 | A 正常 | `test-runtime-core.sh` / `test-runtime-exec.sh` | 全过 | **6/6、7/7** [E4] |
| T-B1 | B 触发 | 宿主 Skill 选择 | 该触发/不误触发 | **未评估**（无宿主） |
| T-C1 | C 边界 | `preflight --stage S99` | fail-closed + `[next]` | `INVALID_ARGUMENT` rc3 + `[next]` ✅ |
| T-C2 | C 边界 | `preflight --level 9` / `--task unknown` | 同上 | 均 rc3 + `[next]` ✅ |
| T-C3 | C 边界 | `preflight --stage ^S3` / `--stage S8,S9` | 正确收窄 | 阶段行随之变化 ✅ |
| T-C4 | C 边界 | `preflight --files a.md,b.md` | 绕过 load_plan | 标注"未指定阶段，全部整文件" ✅ |
| T-C5 | C 边界 | `artifact page --ref ../etc/passwd` | 拒绝越权 ref | `ARTIFACT_NOT_FOUND` rc4 + `[next]` ✅ |
| T-D1 | D 冲突 | Investigation 流程 `S4 → S7` | 合法 | **`STATE_ILLEGAL_TRANSITION` rc4，`--force` 亦拒绝** ❌ **R6-D1** |
| T-E1 | E 失败恢复 | `exec run -- rm -rf /tmp/x` | 拒绝高风险 | `SCOPE_DENIED` rc4 + `[next]` ✅ |
| T-F1 | F 输出 | preflight 截断输出 | 带 `[next]` | **缺 `[next]`** ❌ **R6-D5** |
| T-F2 | F 输出 | 阶段载荷正确性（`--stage S8`/`S10` 是否含 safety §1/§3/§4/§6） | 含 | ✅（S8: L14-27/81-123/124-135/136-157；S10 含 §6） |
| T-G1 | G 回归 | 493 项机械矩阵 | 保持 | ✅（本轮未改代码） |
| T-H1 | H 鲁棒 | 重复执行 smoke / preflight | 稳定 | 两轮输出一致 ✅ |
| T-I1 | I 可移植 | 绝对路径 / 脱敏 / gitignore | 无泄漏 | `git grep /Users/` 仅规则与脱敏器；快照/状态均 ignored ✅ |
| T-J1 | J 安全 | 红线 / 不可逆 | 拒绝 | `SCOPE_DENIED` ✅ |
| T-K1 | K 工作流载荷 | L0/L1/L2/L3 preflight 输出规模 | 与声明一致 | **L1 4387 / L2 5456 字符**，CHANGELOG 记为 3293/4132（历史条目，作 Low 观察不改） |
| T-L1 | L 引用完整性 | 全文反引号 `.md` 路径存在性 | 全部可解析 | **19 处 `memory/*.md` 不可解析** ❌ **R6-D4** |
| T-M1 | M 文档自洽 | safety §5 条目数 vs 引用方声明 | 一致 | **5 vs 4（5 处）** ❌ **R6-D2** |

**不适用项及理由**：C 类"超长输入"对纯规则 Skill 无输入面；E 类"部分结果返回"依赖宿主工具（未接入）；J 类"权限边界"仅对 runtime/exec 有意义（已测）。

**覆盖缺口（本轮新增认识）**：既有 492 项全部是**逐点断言**（单边、单文案、单路径），缺一类**流程级路径断言**（把一条完整流程跑成有序状态序列）。R6-D1 正是这类缺口的产物。

---

## 6. 迭代决策（Propose–Compose）

| ID | 候选修改 | 决策 | 理由 / 证据 |
|---|---|---|---|
| R6-D1 | 补 `S4→S7` 边 + 流程级路径测试 + （可选）叙述层可达性校验 | **建议采纳（本轮未实施）** | E4 复现；不补则 runtime 强制下 E 类任务死路；补边回归风险低但需同步「Loop 归 0 边集」表述 |
| R6-D2 | 子集 5 条编号 + 引用方改 5 项 + 计数断言 | **建议采纳** | E2 事实清楚；修复零风险 |
| R6-D3 | 归档格式补 `{替代者}` + 非 JS 语言格式 | **建议采纳（需先定格式，避免预算膨胀）** | Hard #9 在多语言下不可判定；预算余 8 行，需等量替换 |
| R6-D4 | 19 处路径改全路径 + 反引号路径存在性校验 | **建议采纳** | 影响强制召回；新增校验可能误报，需白名单 |
| R6-D5 | 6 处补 `[next]` + 通用断言 | **建议采纳（低优先）** | 契约自洽；输出 +40 字符/处 |
| R6-D6 | CHANGELOG 批次重排或加索引 | **暂缓** | 纯可读性；重排有丢条目风险，建议用"文首索引表"最小改动 |
| R6-D7 | residual-risks 两处过期值 | **建议采纳（顺手）** | 与既有"以输出为准"口径统一 |
| — | 上诉"分数"式优化 / 放宽验收 | **拒绝** | 违反 §2.4 |
| — | 提高规则预算 | **暂缓** | 无收益证据；优先等量替换（余 8 行） |

---

## 7. 回归与风险

| 项 | 状态 |
|---|---|
| 本轮是否引入回归 | **否**（未修改项目；`git status` 仅归档移动：`D` 旧报告 + `??` 新归档路径） |
| 修复 R6-D1 的风险点 | `loop=0` 语义需与「仅两条边归 0」表述对齐（`state-machine.md:120`），否则产生新的规则冲突 |
| 修复 R6-D4 的误报风险 | `learning/memory.md` 的合法相对写法必须进白名单 |
| 残余风险（既有，未变化） | 规则预算余 8 行；跨平台仅 macOS；`runtime/exec` 非沙箱（已声明）；LICENSE / CHANGELOG 内容 / Git 历史三项人工决策 |
| 证据污染风险 | 低：所有结论均可用附录 A 命令复现；记忆库为只读探测（`touch/metrics` 未执行） |

---

## 8. 后续建议

**必须修复（下一轮最小批次，预估 30–40 分钟）**

1. R6-D1 补边 + 新增一条**流程级**测试（Quick / Standard / Investigation 各一条有序路径）。
2. R6-D2 子集编号 + 计数断言。
3. R6-D4 路径统一 + 存在性校验。

**可选优化（有余量时）**

4. R6-D5 `[next]` 通用断言；R6-D7 两处过期值。
5. R6-D3 归档格式（先定格式再落笔，注意预算等量替换）。
6. `check-protocol` 增"叙述层流程可达性"校验（防同类盲区第三次出现）。

---

## 9. 验证边界（诚实披露）

- **已执行（E4）**：492 项机械断言；`smoke` / `audit scan` / `check-protocol`；14 项独立探针（含 1 项 transition 状态机复现、3 项 artifact、5 项 preflight 参数、1 项 exec 拒绝）。
- **静态审查（E2/E3）**：全部规则文本的交叉引用、路径存在性、计数一致性、CHANGELOG 顺序、文档数值。
- **未验证**：宿主触发与任务成功率（无真机轨迹，13 分未评估）；会话内压缩恢复（R5 起即为 E2/E3）；Linux / Windows；干净机器端到端（规则库私有）；Python 3.8 实跑（代码含 `from __future__ import annotations`，语法兼容 3.8，但**未在 3.8 解释器验证**）。
- **未做**：未执行任何 `touch` / `metrics` / `memory_set`（避免污染被审对象的记忆计数）；未改动任何 Skill / runtime / docs 文件。

---

## 附录 A：复现命令（本轮全部证据）

```bash
cd <repo>

# 机械矩阵（492 项）
python3 -m unittest discover -s tests -p 'test_*.py'
python3 skills/vibe-coder-loop/backup/test_memory_tool.py
bash scripts/tests/test-audit.sh
bash scripts/verify-symlinks.sh
python3 -m runtime.core check-protocol
bash skills/vibe-coder-loop/scripts/smoke-check.sh
bash scripts/tests/test-runtime-core.sh
bash scripts/tests/test-runtime-exec.sh
bash scripts/audit.sh scan --fail-on=high

# R6-D1 复现（Investigation 主路径）
mkdir -p /tmp/vcprobe/.git
PYTHONPATH=$PWD python3 -m runtime.core transition --cwd /tmp/vcprobe --to S1
PYTHONPATH=$PWD python3 -m runtime.core transition --cwd /tmp/vcprobe --to S2
PYTHONPATH=$PWD python3 -m runtime.core transition --cwd /tmp/vcprobe --to S4
PYTHONPATH=$PWD python3 -m runtime.core transition --cwd /tmp/vcprobe --to S7   # rc=4 STATE_ILLEGAL_TRANSITION
PYTHONPATH=$PWD python3 -m runtime.core transition --cwd /tmp/vcprobe --to S7 --force --reason investigation  # 同样拒绝

# R6-D2 / D4 / D5 / D6 / D7 复现
grep -n "Level 0 文档修改约束子集" -A 8 skills/vibe-coder-loop/policy/safety.md
grep -rno '`memory/[a-z]*\.md`' skills/vibe-coder-loop/profiles skills/vibe-coder-loop/references skills/vibe-coder-loop/learning/memory/advanced.md
python3 skills/vibe-coder-loop/backup/memory_tool.py preflight --level 1 --task coding | grep OUTPUT_LIMIT
grep -n "^## v1.22.1\|同版本第.*批" skills/vibe-coder-loop/CHANGELOG.md
grep -n "51 项\|Darwin 25" docs/audits/residual-risks.md
```

## 附录 B：产物说明

- 本文件为**单文件报告**（含基线、rubric、测试集、缺陷、决策、验证边界），延续 R2–R5 的单文件约定，不新增目录结构。
- 归档：本轮开始前将 `evaluation-report-2026-10-21-r5.md` 移入 `archive/2026-10-21-pre-round6/`（唯一文件系统改动，属任务明确要求）。
- 评估副作用：`/tmp/vcprobe/`（临时状态机探针目录，可删）；未写入仓库运行状态，未写 delx-memory。

---

## 10. 修复回执（R6-D1–D8 已实施，本轮追加）

> 用户指令：「修复上述审查出来所有的问题」。以下为实施结果，均含 E4 证据。

### 10.1 修复清单

| ID | 修复内容 | 落点 | 证据 |
|---|---|---|---|
| D1 | 机器块加 `S4 -> S7(loop=0)`；`LEGAL_TRANSITIONS["S4"]` 加 `S7`；`LOOP_RULES[("S4","S7")]="reset0"`；S4 出口补 Investigation 转移行；计数器「重置」2→3 边；新增 `FlowPathTests`（Quick / Standard / Investigation 三条有序路径） | `engine/transition.md`、`engine/state-machine.md`、`runtime/core/state_machine.py`、`tests/core/test_state_machine.py` | `check-protocol` 82→**83**；`S1→S2→S4→S7→S10→S11→S12→S13` 实测走通，loop 恒 0 |
| D2 | 子集改编号列表（5 项，声明「条目数 = 清单行数」）；5 处引用 4→5；新增计数一致性用例（含"混入未编号条目"断言） | `policy/safety.md`、`engine/complexity-gate.md`、`engine/transition.md`、`backup/test_memory_tool.py` | 用例通过；变异「删 1 项」转红 |
| D3 | §4 改「注释符随语言、正文格式统一」：`//` `#` `--` `<!-- -->` 四类 + `替代者` 字段；`lifecycle.md` 示例同步；记忆条目 `skill:references/output-format` 示例对齐 | `policy/safety.md`、`policy/lifecycle.md`、delx-memory | E2 静态一致；Hard #9 在 Python/Java 下可判定 |
| D4 | 27 处 `memory/*.md` → `learning/memory/*.md`（SKILL 8 / profiles 7 / governance 10 / advanced 2）；新增「反引号路径存在性」用例（排除 CHANGELOG 与 `skill:`/`rule:` 前缀） | 同上 + `backup/test_memory_tool.py` | 0 unresolved；变异「回退短路径」转红 |
| D5 | 6 处 `[OUTPUT_LIMIT]` 补 `[next]`（preflight ×3、artifact ×3）；3 条既有用例补 `[next]` 断言 | `backup/memory_tool.py`、`backup/test_memory_tool.py` | 实跑输出含 `[next] read kernel.md …`；变异「删 `[next]`」转红 |
| D6 | CHANGELOG 重排 7→1 递减，补「第一批」标记；新增单调性用例 | `CHANGELOG.md`、`backup/test_memory_tool.py` | `[7,6,5,4,3,2,1]`；变异「换批次序」转红 |
| D7 | 测试计数改「以输出为准」；Darwin 版本更新为 26.6.2 | `docs/audits/residual-risks.md` | E2 |
| D8（执行中新发现） | `skill:vibe-coder-loop:metrics` 值被**双重 JSON 编码** + metadata 为 NULL → `metrics` 拒绝写入（S13 仪表盘义务不可执行）。已解码按三列回写；快照重建后 `verify` 45/45 一致 | delx-memory 条目 + 快照 | 修复前 `[metrics] 仪表盘 value 不是 JSON 对象…拒绝写入`；修复后 `[metrics] 仪表盘已更新` |

### 10.2 回归与变异（Probe 证据）

| 项 | 结果 |
|---|---|
| 单测 | **278/278**（+4 流程级用例） |
| 记忆工具 | **60/60**（+3 一致性用例，+3 `[next]` 断言） |
| 协议 | **83/83**（+1 边） |
| 审计 / 软链 / shell | 51/51 · 15/15 · 6/6 · 7/7 |
| smoke（两个 skill） | 均 rc0；规则 **3897/3900**（余 3） |
| audit scan | rc0（仅 H002 info） |
| 变异 M1 缺边（文档侧） | `PROTOCOL_DRIFT` 红 |
| 变异 M2 子集少 1 项 | 计数用例红 |
| 变异 M3 短路径回退 | 路径用例红 |
| 变异 M4 删一处 `[next]` | clamp 用例红 |
| 变异 M5 互换批次 | 顺序用例红 |
| 变异 M6 缺边（runtime 侧） | `PROTOCOL_DRIFT` 红 + 2 路径用例红 |

机械断言合计 **500**（274→278 单测 + 57→60 工具 + 51 + 15 + 83 + 6 + 7）。

### 10.3 过程事故（如实记录）

实施过程中执行了 `git checkout -- .`（意图清理临时副本，误作用于主仓库），导致首轮修改全部被回退。已**按同一变更集完整重放并重跑全量矩阵**，最终证据均取自重放后的状态；未提交任何 git 操作。教训：对副本目录应使用 `git -C <副本>`，且验证命令中的 `checkout/clean` 不得指向工作仓库。

### 10.4 收尾义务执行

- 记忆回写：`touch rule:skill-iteration-manifest / lesson:skill-edit-date-residue / skill:references/output-format --hit`（3 条，`📌` 报告见执行输出）
- 仪表盘：`metrics` 已更新（0 事件，`skeleton=None/NoneB`）
- 快照：`backup` + `verify` **45/45 一致**
- 残留验证：技能正文日期/版本残留 0（命中项均在 `backup/snapshots/*` 数据与 `backup/archive/*`，属规则允许例外）；死指针候选 0
- 文档更新：`docs/audits/residual-risks.md` 两处过期值；报告本节

### 10.5 剩余项

- D3 的「注释符随语言」为静态规则，**未在多语言真机项目验证**（E2）。
- 规则预算余 **3 行**：后续任何新增规则须先等量替换。
- 执行有效性 13 分（宿主轨迹）仍**未评估**。

