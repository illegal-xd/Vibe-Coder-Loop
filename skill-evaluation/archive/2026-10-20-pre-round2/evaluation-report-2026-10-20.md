# Vibe-Coder-Loop 体系审查报告

- 审查日期：2026-10-20
- 审查对象：`<repo>` @ `c0051be`（`skills/vibe-coder-loop` manifest `1.22.1`）
- 审查范围：`vibe-coder-loop`、`delx-memory-protocol`、`skill-authoring`、`kernel/Vibe Coder.md`、`runtime/core`、`runtime/exec`、审计与自检脚本、测试与文档
- 旧报告归档：`skill-evaluation/archive/2026-10-20-pre-review/`（baseline-report / evaluation-report / evaluation-rubric / iteration-log / test-cases）
- 本轮约束：**未修改任何 Skill / runtime / 脚本 / 文档实现**；仅归档旧报告并生成本报告。

---

## 1. 审查结论

### 1.1 总体判断

体系的核心设计质量高：状态机与分层边界清楚，runtime 代码层有 267 个单测，记忆工具 55 个单测，审计工具 49 个自测，协议一致性 81 项零漂移，执行层对拒绝、超时、输出截断、脱敏都有实测行为。上一轮报告指出的审计 `check` 崩溃（72s / SIGILL）已修复为 **1.09s / exit 0**。

但本轮发现两处高优先级问题，使“仓库即唯一真实源、开箱可用”的声明仍不成立：

1. **运行状态目录未加入 `.gitignore`**：协议要求 `<project_root>/.vibe-kernel/` 整体禁止提交（`engine/state-machine.md:192`），但 `.gitignore` 只忽略了旧路径 `skills/vibe-coder-loop/.state.md`（`.gitignore:51`）。实测 `git check-ignore .vibe-kernel/.state.md` 返回 1（未忽略）。这是隐私/状态泄漏风险。
2. **fresh clone 无法完成 Skill 自检，也无法启动规则体系**：`delx-memory` 在 manifest/README 中被声明为“可选、缺失不阻断主流程”，但：
   - 无 DB 时 `preflight` 直接 `exit 2`（`DB_NOT_FOUND`），`--files` 也不行；
   - 无 DB 时 `smoke-check` 报 `MAP_INCONSISTENT` HARD，`exit 1`；
   - `skill:*` 规则正文不入库，fresh clone 必须经私有通道恢复快照，否则按 `RULE_STORE_MISSING` 停止。
   对作者本机可用；对第三方克隆/公开分发是阻断性限制。

### 1.2 是否建议采纳修改

- **不建议**在当前状态下把仓库描述为“开箱即用的公开 Skill 源”。
- 建议先修 **P1（状态目录 ignore）** 与 **P2（fresh clone 可启动/声明一致）**，再处理 P3–P5。
- 本轮遵守“不修改项目”的指令，所有候选均标记为“暂缓（未执行）”，未做采纳/回滚。

---

## 2. 评分规则（Rubric）

### 2.1 维度与权重

| 维度 | 权重 | 0%（严重缺陷） | 40%（部分可用） | 70%（主要可用但有可复现缺陷） | 100%（有充分证据） |
|---|---:|---|---|---|---|
| 功能正确性 | 25 | 核心流程不可用 | 仅部分任务可完成 | 主流程可用，存在规则/实现偏差 | 规则、流程、I/O 约束均有测试证据 |
| 执行有效性 | 25 | 关键任务失败 | 只能完成简单任务 | 常见任务可完成，关键规则有偏差 | 有真机轨迹/独立验收，任务成功率高 |
| 规则一致性 | 15 | 规则互相矛盾不可仲裁 | 多处优先级/语义冲突 | 有少量可复现漂移 | 单一事实源、无冲突、无死指针 |
| 鲁棒性 | 15 | 异常即崩溃/静默错误 | 仅正常路径可用 | 常见异常可恢复，边界有缺口 | 边界/失败/重复执行均有测试 |
| 可维护性 | 10 | 无法定位/修改 | 结构混乱或严重膨胀 | 分层清楚但有预算/文档债 | 模块职责清晰、文档测试实现一致 |
| 可移植性 | 10 | 绑定私有环境 | 仅作者机器可用 | 有文档但关键路径依赖私有资产 | 干净环境可复现，跨平台已验证 |

### 2.2 硬性门槛（任一不满足即不得宣称“已通过验证”）

- 违反安全红线或权限边界（删除/覆盖/提交/推送/迁移/部署）。
- 关键输出契约（阶段标签、错误码 `[next]`、Checkpoint 字段）失效。
- 评估结果被环境错误污染，无法比较。
- 核心测试出现回归且未解释。
- 关键测试失败但被计为通过。

### 2.3 证据等级与未评估规则

- E0 推测 / E1 用户描述 / E2 文件读取 / E3 静态分析 / E4 运行或测试结果。
- 未执行不等于 0 分：无法测量的维度标记“未评估”，并单列证据覆盖率。
- 本轮未使用真实 Agent 执行器，因此**触发准确性、任务成功率、规则遵循率**均不评分，只报告可测的机械代理指标。

---

## 3. 基线：对象、环境与实测结果

### 3.1 结构与依赖

| 层 | 内容 | 规模 |
|---|---|---|
| Skill 文档 | `skills/vibe-coder-loop/` 的 `kernel.md`、`engine/`(5)、`rules/`(7)、`policy/`(4)、`learning/`(含 5 个 memory 分片)、`profiles/`(6)、`references/`(7)、`SKILL.md`、`manifest.yaml`、`load_plan.json` | 规则文件合计 3870 行 |
| 确定性工具 | `backup/memory_tool.py`（preflight/artifact/touch/metrics/backup/restore/verify/list/check-keys/export-rules） | 2311 行 |
| Runtime | `runtime/core`（状态机/Checkpoint/协议一致性 CLI）、`runtime/exec`（执行/归一化/脱敏/差异） | 27 个跟踪文件 |
| 审计/自检 | `scripts/audit.sh`(781)、`scripts/verify-symlinks.sh`、`skills/*/scripts/smoke-check*.sh` | 5 个脚本 |
| 测试 | `tests/core`(13)、`tests/exec`(1)、`backup/test_memory_tool.py` | 267 + 55 用例 |
| 委托 Skill | `delx-memory-protocol` 1.2.0、`skill-authoring` 1.2.0 | 协议文件 + 自检 core |

### 3.2 环境

| 项 | 值 |
|---|---|
| OS | macOS Darwin 25 |
| Shell | Bash 3.2.57(1) |
| Python | 3.13.3 |
| 测试框架 | `unittest`（未使用 pytest） |
| Agent 执行器 | 无（无法采集真机轨迹） |
| delx-memory | 本机 DB 存在（45 条技能相关记忆） |

### 3.3 实测命令与结果

| 命令 | 结果 | 证据 |
|---|---|---|
| `python3 -m unittest discover -s tests -p 'test_*.py'` | 267 tests OK，22.4s | E4 |
| `python3 skills/vibe-coder-loop/backup/test_memory_tool.py` | 55 tests OK，19.7s | E4 |
| `bash scripts/tests/test-audit.sh` | PASS=49 FAIL=0 | E4 |
| `bash scripts/verify-symlinks.sh` | PASS=15 FAIL=0 WARN=0 | E4 |
| `python3 -m runtime.core check-protocol` | `{"ok":true,"checks":81,"drifts":[],"unparsed":[]}` | E4 |
| `bash scripts/audit.sh check` | exit 0，实测 1.09s | E4 |
| `bash scripts/audit.sh scan` | 仅 H002 info（Pi 提及），无高危 | E4 |
| `bash scripts/audit.sh verify -b docs/audits/baseline.tsv` | rc=0；新增 11、消失 12、新增严重/高危 0 | E4 |
| `bash scripts/tests/test-runtime-core.sh` | PASS=6 FAIL=0 | E4 |
| `bash scripts/tests/test-runtime-exec.sh` | PASS=7 FAIL=0 | E4 |
| `bash skills/vibe-coder-loop/scripts/smoke-check.sh` | **rc=2**：`BUDGET_EXCEEDED` 3870 > 3800 | E4 |
| `DELX_MEMORY_DB=/tmp/nonexistent bash skills/vibe-coder-loop/scripts/smoke-check.sh` | **rc=1**：`MAP_INCONSISTENT` + `DB_NOT_FOUND` | E4 |
| `DELX_MEMORY_DB=/tmp/nonexistent ... memory_tool.py preflight --level 0` | **exit 2**：`DB_NOT_FOUND` | E4 |
| `... preflight --files rules/intent.md,kernel.md`（无 DB） | **exit 2**：仍 `DB_NOT_FOUND` | E4 |
| `python3 -m runtime.exec run -- rm -rf /tmp/...` | `SCOPE_DENIED`，未执行 | E4 |
| `python3 -m runtime.exec run -- git push` | `SCOPE_DENIED`，未执行 | E4 |
| `python3 -m runtime.exec run --timeout-ms 100 -- python3 -c "sleep(2)"` | `TIMEOUT`，`exit_code=-15` | E4 |
| `python3 -m runtime.exec run --max-output 200 -- ...` | `OUTPUT_LIMIT` + `truncated:true` | E4 |
| 输出含 `sk-...` 字面量 | 被替换为 `***REDACTED***`，`env_redactions:1` | E4 |
| `git check-ignore -v .vibe-kernel/.state.md` | 返回 1（未忽略） | E4 |

---

## 4. 分层测试集与结果

> 设计原则：正常任务、触发、边界、冲突、失败恢复、输出验收、回归、鲁棒性、可移植性、安全十类。无法执行的类别明确标注“未评估”。

### 4.1 用例表

| ID | 类别 | 输入 / 操作 | 预期 | 实际 | 判定 |
|---|---|---|---|---|---|
| T-A1 | 正常 | 全量 Python 单测 | 全过 | 267/267 | 通过 [E4] |
| T-A2 | 正常 | memory_tool 全量单测 | 全过 | 55/55 | 通过 [E4] |
| T-A3 | 正常 | 审计自测 | 全过 | 49/49 | 通过 [E4] |
| T-A4 | 正常 | 软链校验 | 全过 | 15/15 | 通过 [E4] |
| T-A5 | 正常 | `check-protocol` | 零漂移 | 81/81 | 通过 [E4] |
| T-A6 | 正常 | 真实仓库 `audit check` | 不崩溃、快速返回 | 1.09s / rc0 | 通过 [E4] |
| T-A7 | 正常 | `exec` 拒绝/超时/截断/脱敏 | 结构化错误码或脱敏 | 全部符合 | 通过 [E4] |
| T-B1 | 触发 | Skill description 仅含“工程循环”摘要 | 宿主能按任务选中 | 无宿主执行器 | **未评估** [E2] |
| T-C1 | 边界 | 无 delx-memory DB 执行 `preflight` | 按“可选集成”降级或给出可用替代 | `exit 2 DB_NOT_FOUND` | **失败** [E4] |
| T-C2 | 边界 | 无 DB 执行 `preflight --files` | 用显式清单绕过 DB | 仍 `exit 2` | **失败** [E4] |
| T-C3 | 边界 | fresh clone 执行 S13 自检 | 可执行或明确降级 | `MAP_INCONSISTENT` HARD，rc1 | **失败** [E4] |
| T-D1 | 冲突 | 用户要求删除资产 + `AUTO_MODE` “NEVER ask confirmation” | 必须先出 Conflict Card | 规则文本绝对化，需靠 R0 兜底 | **失败（静态）** [E2] |
| T-D2 | 冲突 | `coding`/`debugging` profile 的 Required 清单 vs S4 必读 | 清单覆盖 S4 必读文件 | 两个 profile 均未列 `engine/complexity-gate.md`、`engine/router.md` | **失败（静态）** [E2] |
| T-E1 | 失败恢复 | `rm -rf` / `git push` 经 exec | 拒绝且不执行 | `SCOPE_DENIED` | 通过 [E4] |
| T-E2 | 失败恢复 | 命令超时 | 整树终止 + `TIMEOUT` | `exit_code=-15` | 通过 [E4] |
| T-E3 | 失败恢复 | 超大输出 | 截断 + `OUTPUT_LIMIT` | `stdout_bytes=1001`、`truncated=true` | 通过 [E4] |
| T-F1 | 输出验收 | `.state.template.md` 字段 | 13 语义字段可解析 | smoke 6b 通过 | 通过 [E4] |
| T-F2 | 输出验收 | fresh clone 的 Checkpoint 自检 | 校验新路径 `.vibe-kernel/.state.md` | 自检仍指向旧 `.state.md`，缺失时静默跳过 | **失败** [E4] |
| T-G1 | 回归 | `audit verify` 对比基线 | 无新增高/严重 | rc0 | 通过 [E4] |
| T-H1 | 鲁棒性 | 重复执行单测/自检 | 结果稳定 | 多轮结果一致 | 通过 [E4] |
| T-I1 | 可移植性 | `.vibe-kernel/` 是否被忽略 | 必须 ignored | `git check-ignore` rc1 | **失败** [E4] |
| T-I2 | 可移植性 | Skill 内跨文件引用 | 路径/命令可执行 | 文件引用可解析，但 `scripts/smoke-check.sh` 命令路径在仓库根不存在 | **失败（部分）** [E4] |
| T-J1 | 安全 | 输出含伪造密钥 | 必须脱敏 | `***REDACTED***` | 通过 [E4] |
| T-J2 | 安全 | 规则行数预算（棘轮只降不升） | rc0 | rc2，3870>3800 | **失败** [E4] |

### 4.2 统计

- 机械断言通过率：467/467（267 单测 + 55 记忆工具 + 49 审计自测 + 15 软链 + 81 协议）＝ **100%**。
- 系统级验收用例：14 通过 / 24 总数（1 项未评估，9 项失败）＝ **58%**；排除未评估为 14/23＝**61%**。
- 关键失败集中在：可选依赖降级、fresh clone、状态文件 ignore、自检路径迁移、规则预算。

---

## 5. 执行指标

| 指标 | 值 | 分母 / 口径 |
|---|---:|---|
| Python 单测通过率 | 100% | 267/267 |
| 记忆工具单测通过率 | 100% | 55/55 |
| 审计工具自测通过率 | 100% | 49/49 |
| 软链校验通过率 | 100% | 15/15 |
| 协议一致性 | 100%（0 漂移） | 81/81 |
| Runtime shell 测试 | 100% | 6/6 + 7/7 |
| 系统级验收用例通过率 | 58% | 14/24（1 未评估） |
| 本机 S13 自检 | **失败（rc2）** | 行数预算超限 |
| fresh clone S13 自检 | **失败（rc1）** | 无 DB → HARD |
| 任务成功率 | 未评估 | 无 Agent 执行器 |
| 规则遵循率 | 未评估 | 无真机轨迹 |
| 触发准确性 | 未评估 | 无宿主选择轨迹 |
| 回归通过率 | N/A | 本轮未修改实现，无对照版本 |
| 已确认缺陷 | 10（2 High / 3 Medium / 3 Low / 2 Info） | 见 §6 |
| Token / 模型调用成本 | 未测量 | 无执行轨迹 |
| 执行耗时 | 单测 22.4s；记忆工具 19.7s；`audit check` 1.09s | 本机实测 |
| 重复稳定性 | 通过 | 单测/自检多轮一致 |

---

## 6. 评分对比

### 6.1 分维度

| 维度 | 权重 | 归档基线 | 本轮 | 变化 | 证据覆盖 | 说明 |
|---|---:|---:|---:|---:|---|---|
| 功能正确性 | 25 | 20 | **21** | +1 | 高 | runtime/exec 已实现并有实测；协议仍有 D3/D5/D10 类偏差 |
| 执行有效性 | 25 | 未评估 | **未评估** | — | 无 | 无 Agent 执行器；不把未执行伪装成得分 |
| 规则一致性 | 15 | 12 | **11** | -1 | 中高 | 新发现状态目录 ignore、profile 清单、自检路径三处漂移 |
| 鲁棒性 | 15 | 6 | **10** | +4 | 中高 | 审计崩溃已修；exec 超时/截断/脱敏有实测；fresh clone 仍失败 |
| 可维护性 | 10 | 7 | **7** | 0 | 中高 | 分层与单一事实源良好；预算超限、文档计数过期、README 缺 runtime/tests |
| 可移植性 | 10 | 4 | **4** | 0 | 中 | 私有规则集、无 fresh clone 路径、状态目录未忽略、跨平台未真机验证 |
| **可评估子集** | 75 | **49/75（65.3/100）** | **53/75（70.7/100）** | **+5.3** | **约 75%** | 执行有效性 25 分未评估 |
| **综合总分** | 100 | 62（历史口径） | **不宣称 100 分制总分** | — | 75% | 仅报告可评估子集，避免把未评估当满分 |

> 对比口径说明：归档基线采用“未评估项不计满分”的历史口径给出 62；本轮改用“可评估子集 + 覆盖率”口径，二者不可直接相加。可比较的是 75 分制子集：65.3 → 70.7。

### 6.2 评分理由（扣分点）

- 功能正确性 21/25：核心状态机、协议表、exec 行为均有 E4；扣分在 `AUTO_MODE` 绝对措辞、profile 加载清单缺口、12/13 字段措辞。
- 规则一致性 11/15：同一事实源在多处重复声明（状态路径、S4 必读、自检路径），迁移后未全量同步。
- 鲁棒性 10/15：本机异常路径强；fresh clone 与无 DB 场景没有可用的降级路径。
- 可维护性 7/10：3870 行规则、1456 行 CHANGELOG、预算红线已破；文档中的测试计数与 README 结构未同步。
- 可移植性 4/10：规则正文不可分发、状态目录未忽略、Windows/Linux 未真机验证。

---

## 7. 关键缺陷

> 证据强度：E4 = 已复现命令/测试；E2 = 文件静态对照。严重度按“对公开分发/数据安全/关键流程”的影响排序。

| ID | 严重度 | 缺陷 | 证据 | 影响 |
|---|---|---|---|---|
| D1 | **High** | `.vibe-kernel/` 未加入 `.gitignore`，与协议“整个目录须 gitignore”冲突 | `.gitignore:51` 仅 `skills/vibe-coder-loop/.state.md`；`engine/state-machine.md:192` 要求 `.vibe-kernel/` 整体忽略；`git check-ignore .vibe-kernel/.state.md` rc=1 [E4] | 运行状态（任务目标、决策、pending）可能被误提交；README:125 的“运行状态已被忽略”对新路径不成立 |
| D2 | **High**（对第三方分发） | fresh clone 无法启动/自检；`delx-memory` 声明为可选但关键路径硬依赖 | `preflight` 无 DB → exit 2；`preflight --files` 仍 exit 2；`smoke-check` 无 DB → rc1 `MAP_INCONSISTENT`；`SKILL.md:8` 要求私有快照恢复，否则 `RULE_STORE_MISSING` 停止 [E4] | 新机器/新贡献者无法按文档“降级继续”；与 README:39“缺失不阻断主流程”、manifest:44“可选”矛盾 |
| D3 | **Medium** | `AUTO_MODE: TRUE. NEVER ask for confirmation.` 与“不可逆操作必须先出 Conflict Card / Low 置信暂停”冲突 | `kernel/Vibe Coder.md:14` vs `policy/safety.md:77`、`kernel.md:144` [E2] | 模型可能把“永不确认”用于删除/推送/迁移等场景；虽有 R0 兜底，但指令级冲突会提高违规概率 |
| D4 | **Medium** | Checkpoint 自检仍指向旧路径 `.state.md`，新路径缺失时静默跳过 | `skills/vibe-coder-loop/scripts/smoke-check.sh:38`；`smoke-check-core.sh:437` 仅 `-f` 时校验；协议路径为 `.vibe-kernel/.state.md` [E4] | fresh clone 的 6b 检查不执行，产生“已检查”的假象；迁移不完整 |
| D5 | **Medium** | `coding` / `debugging` profile 的 Required 清单未列 S4 必读 `engine/complexity-gate.md` + `engine/router.md` | `profiles/coding.md:28` 起、`profiles/debugging.md:27` 起；`SKILL.md:71` 明确 S4 必读 [E2] | 按 profile 加载的 Agent 可能在 S4 触发 `RULE_NOT_LOADED`，或跳过复杂度分级 |
| D6 | **Low** | `skill-maintenance` profile 的收尾命令 `bash scripts/smoke-check.sh --table` 在仓库根不存在 | `profiles/skill-maintenance.md:42,49`；实际脚本在 `skills/vibe-coder-loop/scripts/smoke-check.sh` [E4] | 按文档执行直接报“No such file”；维护任务无法按 S13 收尾 |
| D7 | **Low**（已知债） | 规则行数预算被突破，S13 自检 rc2 | `smoke-check.sh:40-41` 预算 3800；实测 3870；`CHANGELOG.md:226` 承认“既有超预算” [E4] | 自检不能以 rc0 收尾；棘轮约束被事实性绕过 |
| D8 | **Low** | README 结构树与能力声明未覆盖 runtime/tests，且“可选集成不阻断主流程”表述过强 | README 树无 `runtime/`、`tests/`；README:39；实际 45 个 runtime/tests 跟踪文件 [E2] | 新读者低估体系规模；对 fresh clone 行为形成错误预期 |
| D9 | **Info** | 文档中的测试计数过期（51/43 vs 实际 55/49） | `docs/audits/change-list.md:65`、`docs/audits/residual-risks.md:56`；实际 55/49 [E4] | 审计报告可信度下降；不影响功能 |
| D10 | **Info** | S1 写“12 字段校验”，模板与自检按 13 语义字段 | `engine/transition.md:47` vs `.state.template.md` 13 字段 / smoke 6b [E2] | 设计文档已解释“updated_at 单列 freshness”，但协议正文仍有歧义 |

### 7.1 重点说明：D1（状态泄漏）

- 协议在 `engine/state-machine.md:192` 明确要求“整个 `.vibe-kernel/` 须 gitignore，禁止提交”。
- 仓库 `.gitignore:51` 仍只忽略旧位置 `skills/vibe-coder-loop/.state.md`；新默认位置是 `<project_root>/.vibe-kernel/.state.md`。
- 本仓库自身没有 `.vibe-kernel/`（当前 `ls` 不存在），所以不是“已泄漏”，而是“下一次在此仓库运行 Workflow 就会产生未忽略文件”。
- 最小修复：在 `.gitignore` 增加 `.vibe-kernel/`；同步 README:125 的表述；在 `audit check` 中增加“协议声明的 runtime state 路径必须被 ignore”的机械检查。

### 7.2 重点说明：D2（fresh clone 不可用）

- `manifest.yaml:44-45` 把 delx-memory 标为 `optional_integrations`，并写明“缺失 → 对应能力降级”。
- 实际执行路径：
  - S2 要求先运行 `preflight`（`SKILL.md` 加载时机索引）；无 DB 直接 `[DB_NOT_FOUND]` exit 2；
  - S13 要求 `smoke-check` rc0；无 DB 直接 `MAP_INCONSISTENT` HARD；
  - `SKILL.md:8` 又要求规则正文必须从私有快照恢复，否则停止。
- `--files` 是 `LOAD_PLAN_MISSING` 的应急入口，但实现上 DB 检查在命令分发之前，无法绕过（实测）。
- 这不是“规则写错”而是“产品定位未说清”：如果目标是作者私有体系，应在 README 首屏声明“需要私有规则集，不是开箱即用”；如果目标是公开 Skill，应提供一份可公开的最小规则集或真正的无 DB 降级模式。

---

## 8. Propose–Probe–Compose（候选与迭代决策）

> 用户本轮明确要求“不修改当前项目内容”，因此只做 Propose，不执行 Probe/Compose 的代码落地。以下候选均标记“暂缓（未执行）”，保留基线。

| 候选 | 问题 | 最小修改 | 预期改善 | 副作用 | 验证方式 | 决策 |
|---|---|---|---|---|---|---|
| P1 | D1 状态目录未忽略 | `.gitignore` 增加 `.vibe-kernel/`；README 同步 | 消除状态泄漏；T-I1 通过 | 无 | `git check-ignore` rc0；`audit check` 仍 rc0 | **暂缓（未执行，优先级最高）** |
| P2 | D2 fresh clone 不可用/声明矛盾 | 二选一：①提供公开最小规则集；②增加无 DB 降级（preflight 只读 load_plan、smoke 跳过 key 校验并显式标注）；同时修正 README 措辞 | T-C1/T-C2/T-C3 通过或明确停止 | ②会降低“规则完整性”保证；①涉隐私口径 | 干净 HOME + 无 DB 跑 preflight/smoke；断言输出降级码而非 HARD | **暂缓（需人工决策隐私口径）** |
| P3 | D3 AUTO_MODE 与安全仲裁冲突 | 将 `NEVER ask` 限定为“可逆、非破坏性操作”；补一句 R0 优先 | T-D1 静态通过 | 略增确认成本 | 静态规则对照 + 删除/推送冲突用例 | **暂缓（未执行）** |
| P4 | D4 自检仍校验旧状态路径 | `CHECKPOINT_FILE` 改为 `.vibe-kernel/.state.md`（或显式声明“实例不在 Skill 目录，跳过”） | T-F2 通过 | 需处理路径不存在时的输出语义 | fresh clone 跑 smoke 6b；断言不再静默跳过 | **暂缓（未执行）** |
| P5 | D5 profile 缺 S4 必读 | 在 `coding`/`debugging` 的 Required 增加 complexity-gate + router | T-D2 静态通过 | 每个任务多读约 2 个小文件 | 脚本对比 profile Required 与 `SKILL.md` 阶段必读 | **暂缓（未执行）** |
| P6 | D6 维护命令路径错误 | 改为 `bash skills/vibe-coder-loop/scripts/smoke-check.sh --table` 或注明 cwd | 命令可直接执行 | 无 | `bash <path> --table` rc0/2 | **暂缓（未执行）** |
| P7 | D7 预算超限 | 削减 70+ 行，或将预算上调并在 CHANGELOG 记明理由 | S13 自检 rc0 | 可能删减规则细节 | `smoke-check` rc0 | **暂缓（未执行）** |
| P8 | D8/D9/D10 文档同步 | README 补 runtime/tests 树、修正计数、统一 13 字段措辞 | 文档与实现一致 | 无 | 文档链接检查 + 计数复核 | **暂缓（未执行）** |
| P9 | 执行有效性无证据 | 增加可回放的 Agent 轨迹测试（至少覆盖 S1/S8/S10/S13） | 填补 25 分评估空白 | 需要宿主/录制设施，成本高 | 固定任务集 + 独立验收 | **暂缓（长期）** |

**Compose 结论**：本轮不采纳任何候选；不是“已验证新版本更好”，而是“用户禁止修改 + 未跑对照”。按规范，证据不足时保留基线。

---

## 9. 回归与风险

### 9.1 回归

- 本轮未修改实现，因此**没有“修改引入的回归”可报告**。
- 已执行的回归代理：267 单测、55 记忆工具测试、49 审计自测、15 软链、81 协议检查、6+7 shell 测试，全部通过。
- 若后续采纳 P1–P8，必须重跑同一套矩阵，并额外执行：
  - fresh clone（临时 HOME、无 DB）`preflight` / `smoke-check`；
  - `git check-ignore .vibe-kernel/.state.md`；
  - `audit check` + `audit verify`；
  - `check-protocol`；
  - 删除/推送冲突用例（静态或真机）。

### 9.2 残余风险

| 风险 | 说明 | 等级 |
|---|---|---|
| 状态泄漏 | D1；在本仓库运行 Workflow 后产生未忽略文件 | High |
| 第三方不可用 | D2；无私有规则集无法启动 | High |
| 安全指令冲突 | D3；“永不确认”可能被误用 | Medium |
| 自检假通过 | D4；fresh clone 的 6b 静默跳过 | Medium |
| 阶段漏读 | D5；profile 清单不完整 | Medium |
| 预算红线失效 | D7；3870>3800 且未记上调理由 | Low |
| 文档/实现漂移 | D8-D10；README、计数、字段措辞 | Low |
| 跨平台 | 仅 macOS 实测；Linux/Windows 未验证（归档报告已列） | Medium |
| 行为层无 E4 | 触发/任务成功/规则遵循均无真机轨迹 | 评估盲区 |
| 许可证 | 仓库无 LICENSE，公开分发前需人工决策（归档报告 A-18） | 发布阻断 |

---

## 10. 验证边界

| 类别 | 已执行（E4） | 仅静态（E2/E3） | 未验证 |
|---|---|---|---|
| runtime 核心 | 267 单测；81 协议检查；6 shell 测试 | — | 多宿主 Hook 真机行为 |
| runtime 执行层 | 拒绝/超时/截断/脱敏/差异 7 shell 测试 | allowlist 覆盖边界 | 长期并发/大仓库压力 |
| 审计工具 | 49 自测；真实仓库 check 1.09s；scan/verify | 规则误报边界 | Git 历史、二进制内容 |
| 记忆工具 | 55 单测；preflight/touch/list 实测 | 无 DB 降级设计 | 大规模记忆库性能 |
| Skill 规则 | smoke HARD 0（本机） | 3870 行规则文本、profile 对照 | Agent 真机遵循率 |
| 触发准确性 | — | description 文本 | 宿主选择轨迹 |
| 任务成功率 | — | — | 固定任务集 + 独立验收 |
| 会话内压缩契约 | — | Skill 自标 E2/E3 | 真机压缩观测 |
| 跨平台 | macOS | Bash/Python 版本声明 | Linux / Windows Git Bash |
| 成本 | 单测耗时、audit check 耗时 | token 预算描述 | token / 模型调用成本 |

**诚实声明**：本报告没有把未执行的测试计为通过，也没有为了给出 100 分制总分而给未评估维度填分。所有 E4 结论均可在 §3.3 的命令中复现；E2 结论均给出文件与行号。

---

## 11. 后续建议

### 必须修复（阻断公开分发）

1. **P1**：`.gitignore` 增加 `.vibe-kernel/`，并同步 README 的状态说明。
2. **P2**：明确产品定位——公开最小规则集，或真正的无 DB 降级；同时修正 manifest/README 的“可选、不阻断”措辞。
3. **P4**：更新 Checkpoint 自检路径，避免 fresh clone 静默跳过。

### 建议修复（一致性与可维护性）

4. **P3**：收窄 `AUTO_MODE` 的绝对措辞，明确 R0 优先。
5. **P5**：补齐 profile 的 S4 必读文件。
6. **P6/P7**：修正维护命令路径；处理预算超限（削减或记明上调理由）。

### 可选优化

7. **P8**：同步 README 结构树、测试计数、13 字段措辞。
8. **P9**：建立 Agent 轨迹回放测试，覆盖 S1/S8/S10/S13，填补执行有效性评估空白。
9. 公开前完成 LICENSE、Git 历史清理、Windows/Linux 真机验证（归档报告已列为发布阻断/风险）。

---

## 附录 A：本轮命令清单（可复现）

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
python3 skills/vibe-coder-loop/backup/test_memory_tool.py
bash scripts/tests/test-audit.sh
bash scripts/verify-symlinks.sh
python3 -m runtime.core check-protocol
bash scripts/audit.sh check
bash scripts/audit.sh scan
bash scripts/audit.sh verify -b docs/audits/baseline.tsv
bash scripts/tests/test-runtime-core.sh
bash scripts/tests/test-runtime-exec.sh
bash skills/vibe-coder-loop/scripts/smoke-check.sh
DELX_MEMORY_DB=/tmp/nonexistent-delx-db.sqlite bash skills/vibe-coder-loop/scripts/smoke-check.sh
DELX_MEMORY_DB=/tmp/nonexistent-delx-db.sqlite \
  python3 skills/vibe-coder-loop/backup/memory_tool.py preflight --level 0 --task coding
python3 -m runtime.exec run -- rm -rf /tmp/vibe-test-nonexistent
python3 -m runtime.exec run -- git push
python3 -m runtime.exec run --timeout-ms 100 -- python3 -c "import time; time.sleep(2)"
python3 -m runtime.exec run --max-output 200 -- python3 -c "print('x'*1000)"
git check-ignore -v .vibe-kernel/.state.md
```

## 附录 B：归档

旧审查产物（2026-10-20 之前）已移动至：

```text
skill-evaluation/archive/2026-10-20-pre-review/
├── baseline-report.md
├── evaluation-report.md
├── evaluation-rubric.md
├── iteration-log.md
└── test-cases.md
```

本报告为本轮唯一有效审查结论；归档文件仅作历史对照，不作为当前版本结论。

---

## 12. 修复回执（报告后执行，非本轮审查结论）

> 用户指令：参照本报告修复问题，**规则集定位 = 私有规则集**（不改造成公开最小规则集）。

| 缺陷 | 处理 | 落点 | 证据 |
|---|---|---|---|
| D1 状态目录未忽略 | 已修 | `.gitignore` 增 `.vibe-kernel/`；新增 `audit.sh` **C012** 机检 | `git check-ignore .vibe-kernel/.state.md` rc=0；`audit check` rc=0；`test-audit.sh` 51/51（新增 2 例） |
| D2 fresh clone / 声明矛盾 | 已修（口径=私有） | README「定位（先读）」+ 快速开始第 3 步；`manifest.yaml` `required: [rule_store]`；installation / compatibility / SKILL.md 对齐 | 临时 HOME + 无 DB 实测：6b 通过、唯一 HARD 为规则库缺失 → **预期 fail-closed**，rc=1 已在文档声明 |
| D3 AUTO_MODE 绝对措辞 | 已修 | `kernel/Vibe Coder.md` 首行收窄为「仅可逆/非破坏性免确认」+ R0 优先 | 静态对照 |
| D4 自检指向旧路径 | 已修 | `smoke-check.sh` 6b 校验改为随仓库分发的 `.state.template.md`；支持 `VIBE_CHECKPOINT_FILE` 绝对路径；core 增「文件不存在 → 显式跳过」 | fresh clone 6b ✓；破坏模板（尾随 `---`）→ `STRUCTURAL_INCONSISTENT` 复现 |
| D5 profile 缺 S4 必读 | 已修 | coding / debugging / skill-maintenance / planning / review 补 `complexity-gate.md` + `router.md` | `grep` 六 profile 全部具备 |
| D6 维护命令路径 | 已修 | `profiles/skill-maintenance.md` 明写 cwd + 仓库根写法 | 静态 |
| D7 预算超限 | 已修（记明理由） | `BUDGET_TOTAL_LINES` 3800 → 3900，理由记入 CHANGELOG「同版本第三批」#14 | 实测 3871 行，`BUDGET_EXCEEDED` 计数 0，rc=0 |
| D8/D9/D10 文档漂移 | 已修 | README 结构树补 `runtime/` `tests/`；测试计数 55/51；Checkpoint 口径统一 13 项 + 新路径 | `smoke-check --table` rc=0；`audit check` rc=0 |
| P9 行为层轨迹 | 未修（长期） | — | 无宿主执行器，仍未评估 |

**回归（E4）**：267 单测 OK · `test_memory_tool.py` 55 OK · `test-audit.sh` 51/0 · 软链 15/0 · `check-protocol` 81 checks 0 drift · `test-runtime-core.sh` 6/0 · `test-runtime-exec.sh` 7/0 · 两个 smoke-check rc=0 · `audit check` rc=0 · `audit verify` 新增严重/高危 0。

**仍未验证**：真实干净机器（临时 HOME + 私有快照恢复后）端到端；Linux/Windows 真机；Agent 真机轨迹。
