# Vibe-Coder-Loop 体系审查报告（2026-10-20 第二轮独立复评）

## 0. 元信息

| 项 | 值 |
|---|---|
| 审查对象 | `Vibe-Coder-Loop` @ `cff0f7b`（工作树干净，仅本轮归档重命名） |
| Skill 版本 | `skills/vibe-coder-loop/manifest.yaml` = `1.22.1` |
| 审查范围 | `vibe-coder-loop`、`delx-memory-protocol`、`skill-authoring`、`kernel/Vibe Coder.md`、`runtime/core`、`runtime/exec`、`scripts/`、`tests/`、`docs/`、`README.md` |
| 旧报告归档 | `skill-evaluation/archive/2026-10-20-pre-round2/evaluation-report-2026-10-20.md`（上一轮报告）；更早产物仍在 `skill-evaluation/archive/2026-10-20-pre-review/` |
| 本轮约束 | 第二轮复评阶段未修改项目；随后用户指令“修复所有问题”，D1–D9 已落地（见 §12 修复回执） |
| 证据等级 | E0 推测 / E1 用户描述 / E2 文件读取 / E3 静态分析 / E4 运行或测试结果 |

> 本报告不把未执行项计为通过；无 Agent 宿主执行轨迹的维度明确标为“未评估”，不填满分。

---

## 1. 审查结论

### 1.1 总体判断

体系的分层设计、单一事实源意识、确定性工具链和机械测试密度仍然明显高于一般 Skill 项目：

- `runtime/core` 267 个单测、`memory_tool.py` 55 个单测、审计工具 51 个自测、软链 15 项、协议一致性 81 项、两个 shell 回归 6+7 项，全部通过。
- `audit check` 实测 1.10s、rc0；`smoke-check` rc0（规则 3871 行 / 预算 3900）；`.vibe-kernel/`、旧 `.state.md`、快照、脱敏规则集均被 gitignore，仓库未跟踪任何快照或状态文件。
- 执行层对 `rm -rf`、`git push`、超时、输出截断、脱敏都有实测行为。

但本轮独立复评发现 **两个 High 级核心契约缺陷**，它们不是文档润色问题，而是“规则声称的行为”与“实际执行结果”不一致：

1. **标准循环的 Loop 计数起点错误**：文档写“第一次进入 S8 Code 时 Loop = 1”“最多 3 轮（1/2/3）”，运行时实际从 Loop 0 开始，允许 4 轮 Code/Review。协议自检 81/81 全绿也没有覆盖这条路径。
2. **规则库为空时 preflight 失败开放（fail-open）**：文档要求规则库缺失必须 `[RULE_STORE_MISSING]` 停止、不得用骨架摘要继续；实测空规则库时 `preflight` **rc=0**，并明确打印“按文件内摘要降级并标注”。这与 README 的“fail-closed”定位直接冲突。

此外还有若干 Medium/Low 问题：Quick Loop 重试语义三方矛盾、README 快速开始两条命令不可执行、profile 必读清单与加载索引不一致、记忆路由“精确 key / search”自相矛盾、smoke 6b 声称校验 freshness 但只检查字段存在。

### 1.2 阻断性判断

| 口径 | 结论 |
|---|---|
| 作者本机私有使用 | 不构成阻断；现有工具链和规则骨架可用 |
| 对第三方宣称“fail-closed / 开箱按文档可恢复” | **构成阻断**：D1/D2 均可复现，且协议门禁为绿 |
| 公开分发 / 公开发布 | 仍受 LICENSE、Git 历史、CHANGELOG 隐私、Windows/Linux 未验证等既有事项阻断（见 §8.2） |

### 1.3 是否建议采纳修改

建议采纳：

- **C1**：`S7 -> S8` 增加“首次进入初始化为 1、已有 N+1 则保持”的 Loop 规则。
- **C2**：`preflight` 在 `skill:rules/*` 为空且非 `--files` 模式时返回非零并输出 `[RULE_STORE_MISSING]`。
- **C3–C8**：文档/命令/profile/门禁类修正（低风险，静态可核对）。

但按第二轮用户指令“不修改当前项目的内容”，**上述修改当时未落地**，只完成 Propose 与 Probe。**随后用户追加指令“修复所有审查处理的问题”，C1–C8 + D9.1/D9.2/D9.5 已落地；D9.3/D9.4 按既有策略保留。** 修复结果与回归见 §12 修复回执。

---

## 2. 范围、结构与依赖

### 2.1 组件清单

| 层 | 内容 | 规模/说明 |
|---|---|---|
| Skill 文档 | `skills/vibe-coder-loop/` 的 `kernel.md`、`engine/`(5)、`rules/`(7)、`policy/`(4)、`learning/`(含 5 个 memory 分片)、`profiles/`(6)、`references/`(7)、`SKILL.md`、`manifest.yaml`、`load_plan.json` | 规则文件合计 3871 行（smoke 实测） |
| 确定性工具 | `backup/memory_tool.py`（preflight / artifact / touch / metrics / backup / restore / verify / list / check-keys / export-rules） | 约 2300 行，标准库 |
| Runtime Core | 状态机、Checkpoint、协议一致性、恢复、Safe Mode、产物 | 约 6.6k 行，267 单测 |
| Runtime Exec | allowlist、超时、输出截断、脱敏、差异、产物 | 约 4.0k 行，6+7 shell 测试 |
| 审计/自检 | `scripts/audit.sh`、`scripts/verify-symlinks.sh`、`skills/*/scripts/smoke-check*.sh` | 51 项审计自测 |
| 委托 Skill | `delx-memory-protocol` 1.2.0、`skill-authoring` 1.2.0 | 协议文件 + 自检 core |
| 测试 | `tests/core`(13)、`tests/exec`(1)、`backup/test_memory_tool.py` | 267 + 55 用例 |

### 2.2 环境

| 项 | 值 |
|---|---|
| OS | macOS Darwin 25 |
| Shell | Bash 3.2.57(1) |
| Python | 3.13.3 |
| 测试框架 | `unittest`（未使用 pytest） |
| delx-memory | 本机 DB 存在（244 条 `memory` 记录；技能相关 45 条） |
| Agent 宿主 | 无真机轨迹采集；触发准确率/任务成功率无法评估 |

### 2.3 关键依赖关系

- `vibe-coder-loop` 的规则正文下沉到 delx-memory 的 `skill:*` 条目；仓库只分发骨架。
- `rule_store` 在 `manifest.yaml` 中为 `required`；`delx-memory` 记忆后端与 `codegraph` 为 `optional_integrations`。
- `skill-authoring/scripts/smoke-check-core.sh` 是自检逻辑唯一事实源；两个 Skill 的 `smoke-check.sh` 只是配置薄包装。
- `runtime/core` 的 `LEGAL_TRANSITIONS` / `LOOP_RULES` 是 `engine/transition.md` 机器块的程序化镜像；`check-protocol` 做双向比对。

---

## 3. 基线实测（E4）

### 3.1 机械测试矩阵

| 命令 | 结果 | 耗时/备注 |
|---|---|---|
| `python3 -m unittest discover -s tests -p 'test_*.py'` | **267/267 OK** | 23.6s |
| `python3 skills/vibe-coder-loop/backup/test_memory_tool.py` | **55/55 OK** | 19.5s |
| `bash scripts/tests/test-audit.sh` | **PASS=51 FAIL=0** | 7.5s |
| `bash scripts/verify-symlinks.sh` | **PASS=15 FAIL=0 WARN=0** | 仓库内无软链 |
| `python3 -m runtime.core check-protocol` | `{"ok":true,"checks":81,"drifts":[],"unparsed":[]}` | 0 漂移 |
| `bash scripts/audit.sh check` | rc=0 | 1.10s |
| `bash scripts/audit.sh scan` | rc=0 | 仅 H002 info（Pi 提及），无高危 |
| `bash scripts/audit.sh verify -b docs/audits/baseline.tsv` | rc=0 | 新增 12、消失 13、新增严重/高危 0 |
| `bash scripts/tests/test-runtime-core.sh` | **PASS=6 FAIL=0** | — |
| `bash scripts/tests/test-runtime-exec.sh` | **PASS=7 FAIL=0** | — |
| `bash skills/vibe-coder-loop/scripts/smoke-check.sh` | **rc=0** | HARD 0；规则 3871 / 预算 3900 |
| `bash skills/vibe-coder-loop/scripts/smoke-check.sh --table` | rc=0 | 表格列数检查通过 |
| `git check-ignore -v .vibe-kernel/.state.md` | rc=0 | `.gitignore:53` |
| `git check-ignore -v skills/vibe-coder-loop/.state.md` | rc=0 | 遗留位置仍被忽略 |
| `git check-ignore -v .../snapshots/skill_memory_latest.json` | rc=0 | 快照不入库 |
| `git ls-files` 中 `.state.md` / `snapshots/*.json*` / `backup/rules/*` | 无 | 隐私项未被跟踪 |

机械断言合计：267 + 55 + 51 + 15 + 81 + 6 + 7 = **482 项通过**。

### 3.2 关键契约复现（基线缺陷）

**（1）标准 Loop 从 0 开始，实际允许 4 轮**

```bash
# 在临时项目内依次执行
core transition --to S1
core transition --to S2
core transition --to S4 --level 2
core transition --to S5
core transition --to S6
core transition --to S7
core transition --to S8      # 实测 loop=0（文档要求 1）
core transition --to S9
core transition --to S10
core transition --to S8      # retry 1 -> loop=1
# 再次 S9/S10 后：retry 2 -> loop=2，retry 3 -> loop=3，retry 4 -> LOOP_BUDGET_EXHAUSTED
```

实测：首次 `S8` 为 `loop=0`；随后 3 次重试成功；第 4 次才被预算拦截。即 **初始轮 + 3 次重试 = 4 轮 Code/Review**，而 `kernel.md` §7 写“最多 3 轮（Loop 1/2/3）”。

**（2）空规则库 preflight 失败开放**

```bash
# 复制本机 DB 后清空 memory 表，得到“DB 存在但规则条目为 0”的场景
DELX_MEMORY_DB=/tmp/memprobe/db.sqlite \
  python3 skills/vibe-coder-loop/backup/memory_tool.py preflight --level 2 --task coding
# 实测 rc=0
# 输出： （无 skill:rules/* 条目 —— 骨架化规则不可用，按文件内摘要降级并标注）
```

同一份 DB 上 `smoke-check` 以 `MAP_INCONSISTENT` rc=1 失败，说明自检知道规则库缺失，但 Workflow 入口 `preflight` 不失败关闭。

**（3）README 快速开始两条命令不可执行**

```bash
cd skills/vibe-coder-loop
python3 backup/memory_tool.py verify
# argparse: the following arguments are required: file  -> rc=2

python3 backup/memory_tool.py check-keys --files
# [KEYS_CHECK_INPUT_MISSING] 未收到任何 key              -> rc=3
```

`verify` 的签名是 `verify <file>`（`memory_tool.py:2192-2193`）；`check-keys --files` 的 `--files` 是 `nargs="*"`，需要跟 key 清单文件或走 stdin（`memory_tool.py:2208-2209`）。README `README.md:84-85` 两行都缺参数，且 `README.md:5/83` 把 gzip/JSON 快照称为“加密快照”（实测 `file` 为 JSON / gzip，无加密）。

**（4）Case B 的 Loop 口径**

```bash
# 标准路径到达 S10 后
core transition --to S6   # 实测 loop=N+1
```

文档写 `Review[N] → Design[0] → Code[N+1]`（`kernel.md:200`、`state-machine.md:76`、`transition.md:196`），机器块写 `S10 -> S6(+1)`（`transition.md:34`），运行时代码 `("S10","S6"): "inc"`（`state_machine.py:77`）。三处对“Design 阶段的 Loop 显示值”不一致。

**（5）Quick Loop 重试语义**

`kernel.md:199` 写“Quick Loop 上限 1 轮：回退修复仅 1 轮上限（回退修复 1 次）”；`rules/test.md:54` 写“Quick Loop 失败 → 不回退 Code，直接建议升级”；运行时 `loop_max(1)=1`，`S9→S8` 递增到 2 即 `LOOP_BUDGET_EXHAUSTED`（实测）。三方对“是否允许一次重试”表述不一致。

### 3.3 执行层实测（通过的边界）

| 用例 | 结果 |
|---|---|
| `exec run -- rm -rf /tmp/...` | `SCOPE_DENIED`，未执行 |
| `exec run -- git push` | `SCOPE_DENIED`，未执行 |
| `exec run -- git commit -m x` | `SCOPE_DENIED`（非只读 git 子命令） |
| `exec run --timeout-ms 100 -- python3 -c "sleep(2)"` | `TIMEOUT`，整树终止 |
| `exec run --max-output 200 -- ...` | `OUTPUT_LIMIT` + `truncated:true` |
| 输出含伪造密钥 | 被替换为 `***REDACTED***` |
| `exec run -- python3 -c "os.remove(...)"` | **允许执行**（见 §8.2 残余风险；代码注释已声明“防手滑，不是防对抗”） |

---

## 4. 评分规则（Rubric）

### 4.1 维度与权重

| 维度 | 权重 | 0% | 40% | 70% | 100% |
|---|---:|---|---|---|---|
| 功能正确性 | 25 | 核心流程不可用 | 仅部分任务可完成 | 主流程可用但有可复现契约偏差 | 规则、流程、I/O 均有测试证据 |
| 执行有效性 | 25 | 关键任务失败 | 只能完成简单任务 | 常见任务可完成，关键规则有偏差 | 真机轨迹 + 独立验收，成功率高 |
| 规则一致性 | 15 | 规则互相矛盾不可仲裁 | 多处优先级/语义冲突 | 少量可复现漂移 | 单一事实源、无冲突、无死指针 |
| 鲁棒性 | 15 | 异常即崩溃/静默错误 | 仅正常路径可用 | 常见异常可恢复，边界有缺口 | 边界/失败/重复执行均有测试 |
| 可维护性 | 10 | 无法定位/修改 | 结构混乱或严重膨胀 | 分层清楚但有预算/文档债 | 模块职责清晰、文档测试实现一致 |
| 可移植性 | 10 | 绑定私有环境 | 仅作者机器可用 | 有文档但关键路径依赖私有资产 | 干净环境可复现，跨平台已验证 |

### 4.2 硬性门槛

任一不满足即不得宣称“已通过验证”：

- 违反安全红线或权限边界（删除/覆盖/提交/推送/迁移/部署）。
- 关键输出契约（阶段标签、`[next]`、Checkpoint 字段、Loop 预算）失效。
- 评估结果被环境错误污染，无法比较。
- 核心测试出现回归且未解释。
- 关键测试失败但被计为通过。

### 4.3 证据覆盖与未评估

- E4：本轮实际执行的测试、CLI 行为、文件检查。
- E2/E3：规则文本、profile、文档、机器块静态对照。
- **未评估**：真实 Agent 宿主的触发准确性、任务成功率、规则遵循率、跨会话压缩行为、Linux/Windows 真机。不得用机械测试通过替代这些结论。

---

## 5. 分层测试集与结果

> 说明：T-K 组是本轮新增的“工作流契约”用例，正是它们暴露了上一轮测试集未覆盖的问题。C 列 = 候选副本（C1+C2）结果。

| ID | 类别 | 输入/操作 | 预期 | 基线实际 | 判定 | C 列 |
|---|---|---|---|---|---|---|
| T-A1 | 正常 | runtime 全量单测 | 全过 | 267/267 | 通过 [E4] | 267/267 |
| T-A2 | 正常 | memory_tool 全量单测 | 全过 | 55/55 | 通过 [E4] | 55/55 |
| T-A3 | 正常 | 审计自测 | 全过 | 51/51 | 通过 [E4] | 51/51 |
| T-A4 | 正常 | 软链校验 | 全过 | 15/15 | 通过 [E4] | 15/15 |
| T-A5 | 正常 | `check-protocol` | 零漂移 | 81/81 | 通过 [E4] | 81/81 |
| T-A6 | 正常 | 真实仓库 `audit check` | rc0，快速返回 | rc0 / 1.10s | 通过 [E4] | rc0 |
| T-A7 | 正常 | `smoke-check` | rc0 | rc0，3871/3900 | 通过 [E4] | rc0 |
| T-A8 | 正常 | `exec` 拒绝/超时/截断/脱敏 | 结构化码或脱敏 | 全部符合 | 通过 [E4] | 未复跑 |
| T-B1 | 触发 | Skill description 能否被宿主选中 | 应触发/不应误触发 | 无宿主轨迹 | **未评估** [E2] | 未评估 |
| T-C1 | 边界 | 无 DB 执行 preflight | 明确失败关闭 | rc2 `DB_NOT_FOUND` | 通过（码名与文档不一致）[E4] | rc2 |
| T-C2 | 边界 | DB 存在但 `skill:rules/*` 为 0 | 明确失败关闭 | **rc0 + 降级继续** | **失败 High** [E4] | rc3 `RULE_STORE_MISSING` |
| T-C3 | 边界 | 空规则库执行 smoke | 失败关闭 | rc1 `MAP_INCONSISTENT` | 通过 [E4] | rc1 |
| T-D1 | 冲突 | `AUTO_MODE` vs 不可逆操作 | 不可逆仍须仲裁 | 已收窄措辞 | 通过（静态）[E2] | — |
| T-D2 | 冲突 | profile Required vs S4/S8/S10 必读 | 清单覆盖索引 | review 缺 kernel/safety；debugging 缺 state-machine/review；coding 将 lifecycle 降为可选 | **失败 Medium** [E2] | 未修 |
| T-D3 | 冲突 | 记忆路由“精确 key” vs 表中的 `memory_search` | 单一动作口径 | 同节自相矛盾 | **失败 Medium** [E2] | 未修 |
| T-E1 | 失败恢复 | `rm -rf` / `git push` 经 exec | 拒绝且不执行 | `SCOPE_DENIED` | 通过 [E4] | — |
| T-E2 | 失败恢复 | 命令超时 | 整树终止 + `TIMEOUT` | 符合 | 通过 [E4] | — |
| T-E3 | 失败恢复 | 超大输出 | 截断 + `OUTPUT_LIMIT` | 符合 | 通过 [E4] | — |
| T-F1 | 输出验收 | `.state.template.md` 13 字段 | 可解析 | 通过 | 通过 [E4] | — |
| T-F2 | 输出验收 | `updated_at:` 为空 | 应判失败或明确降级 | 6b 仍打印“含 freshness”并通过 | **失败 Low** [E4] | 未修 |
| T-G1 | 回归 | `audit verify` 对基线 | 无新增高/严重 | rc0 | 通过 [E4] | rc0（副本无 .gitignore，计数不可比） |
| T-H1 | 鲁棒性 | 重复执行单测/自检 | 结果稳定 | 多轮一致 | 通过 [E4] | 通过 |
| T-I1 | 可移植性 | `.vibe-kernel/` 是否 ignored | 必须 ignored | rc0 | 通过 [E4] | — |
| T-I2 | 可移植性 | README 快速开始命令 | 可直接执行 | `verify` rc2；`check-keys --files` rc3 | **失败 Medium** [E4] | 未修 |
| T-J1 | 安全 | 输出含伪造密钥 | 必须脱敏 | `***REDACTED***` | 通过 [E4] | — |
| T-J2 | 安全 | 规则行数预算 | rc0 | 3871/3900，余量 29 行 | 通过 [E4] | 3871/3900 |
| T-K1 | 工作流 | 标准路径首次进入 S8 | Loop=1 | **Loop=0** | **失败 High** [E4] | Loop=1 |
| T-K2 | 工作流 | 标准 Loop 最多 3 轮 | 第 4 轮拒绝 | **初始 + 3 重试 = 4 轮** | **失败 High** [E4] | 1/2/3 后拒绝 |
| T-K3 | 工作流 | Case B：Design 阶段 Loop | `Design[0]` 或明确 N+1 | S6 实测 N+1，文档写 0 | **失败/歧义 Medium** [E4] | 未改（需文档决策） |
| T-K4 | 工作流 | Quick Loop 失败重试 | `kernel` 写可修 1 次 | 运行时直接预算耗尽 | **失败 Medium** [E4] | 未改（需文档决策） |
| T-K5 | 工作流 | 空规则库 preflight | rc!=0 + `RULE_STORE_MISSING` | rc0 + 降级 | **失败 High** [E4] | rc3 |
| T-K6 | 回归 | 候选副本全量回归 | 全过 | — | — | 267+55+51+6+7+15+81 全过；smoke rc0；audit rc0 |

### 5.1 统计

- 机械断言：482/482 通过（100%）。
- 系统级契约用例：**通过 12 / 部分 1 / 失败 9 / 未评估 1**（共 23 个系统级用例，不含 T-A 机械项与 T-K6 候选回归）。关键失败集中在 Loop 预算、规则库失败关闭、README 启动路径、profile 一致性。
- 任务成功率：**未评估**（无 Agent 轨迹）。确定性工作流子集（T-K1..T-K5）：0 通过 / 1 部分 / 4 失败，不作为“任务成功率”对外宣称。

---

## 6. 缺陷清单

> 严重度按“对工作流契约、失败关闭、公开分发、数据安全”的影响排序。E4 = 已复现命令/测试；E2 = 文件静态对照。

### D1（High）标准 Loop 从 0 开始，预算实际允许 4 轮

| 项 | 内容 |
|---|---|
| 现象 | 标准路径 `S1→S2→S4→S5→S6→S7→S8` 首次进入 S8 时 `loop=0`；随后 3 次重试成功，第 4 次才被拦截 |
| 规则依据 | `kernel.md:198`“最多执行 3 轮 Code+Review 循环（Loop 1/2/3）”；`state-machine.md:116`“第一次进入 S8 Code 时 Loop = 1” |
| 实现位置 | `runtime/core/state_machine.py:74-80` 的 `LOOP_RULES` 只有 `("S4","S8"): "init1"`；标准路径走 `S7→S8`，该边规则为 `keep`；`engine/transition.md:31` 机器块同样写 `S7 -> S8` 无修饰 |
| 影响 | 第 4 轮绕过文档预算；`[Loop: N]` 标签与 checkpoint 的 `loop` 不一致；跨会话恢复后预算判断偏移 |
| 根因 | Loop 语义未定义清楚（“第几次尝试”还是“第几次重试”），且 `check-protocol` 的“Loop 计数起点”检查只要求 `S4→S8`（`protocol.py:473`），未覆盖标准路径 |
| 证据 | E4：CLI 实测 Loop 0/1/2/3，第四轮 `LOOP_BUDGET_EXHAUSTED` |

### D2（High）规则库为空时 preflight 失败开放

| 项 | 内容 |
|---|---|
| 现象 | DB 存在但 `skill:rules/*` 条目为 0 时，`preflight` 返回 **rc=0**，输出“骨架化规则不可用，按文件内摘要降级并标注” |
| 规则依据 | `SKILL.md:10`“缺失时不得降级继续……输出 `[RULE_STORE_MISSING]` + `[next]` 并停止”；`README.md:5/52`；`docs/installation.md:102/106` |
| 实现位置 | `skills/vibe-coder-loop/backup/memory_tool.py:1813-1816` 的 `else` 分支只打印降级提示；`cmd_preflight` 末尾 `return 3 if missing else 0` 中的 `missing` 指加载清单文件缺失，不是规则条目缺失 |
| 影响 | 第三方/新机器在“DB 已配置但规则未恢复”时可直接进入 Workflow，使用骨架摘要产出难追溯结论；这正是文档明确禁止的失败模式 |
| 冲突 | 11 个骨架文件含“检索失败按本文件摘要降级执行”措辞（`references/governance.md:7`、`rules/review.md:15`、`rules/intent.md:14` 等）；其中类型 C（记忆条目为 canonical）的文件与 `SKILL.md:10` 的 fail-closed 直接矛盾。`learning/memory/retrieval.md` 是“文件为 canonical”的特例，其降级不构成同类冲突。实现选择了降级路径，未显式裁决 |
| 证据 | E4：空 DB（`memory` 表 0 行）`preflight` rc0；同一 DB `smoke-check` rc1 `MAP_INCONSISTENT` |

### D3（Medium）Quick Loop 重试语义三方矛盾

| 项 | 内容 |
|---|---|
| 现象 | `kernel.md:199` 写“回退修复 1 次”；`rules/test.md:54` 写“不回退 Code，直接建议升级”；运行时 `loop_max(1)=1`，任何 `S9→S8` 都直接 `LOOP_BUDGET_EXHAUSTED` |
| 影响 | Agent 按 kernel 可能尝试重试却被运行时拒绝；按 rules/test 则不会重试。行为取决于读哪份文件 |
| 建议 | 若产品意图是“Quick Loop 不重试”，修 `kernel.md`；若要保留 1 次重试，运行时对 L1 需允许 `loop_max=2` 或调整“上限”定义。二选一，必须单一事实源 |

### D4（Medium）README 快速开始的关键命令不可执行

| 项 | 内容 |
|---|---|
| 现象 | `README.md:84` `verify` 缺 `<file>` → argparse rc2；`README.md:85` `check-keys --files` 缺 key 清单 → rc3 `KEYS_CHECK_INPUT_MISSING` |
| 影响 | fresh clone 按“必做”第 3 步恢复规则集后，无法按文档完成校验；与“开箱可恢复”的定位冲突 |
| 证据 | E4：两条命令实测失败 |
| 建议 | 改为 `verify <快照路径>`；`check-keys` 用 `--files <key清单>` 或 `bash scripts/smoke-check.sh`（4b 已含 key 校验） |

### D5（Medium）Profile Required 清单与 SKILL.md 加载索引不一致

| 项 | 内容 |
|---|---|
| 现象 | `profiles/review.md:29-33` 未列 `kernel.md`、`policy/safety.md`；`profiles/debugging.md:27-32` 未列 `engine/state-machine.md`、`rules/review.md`；`profiles/coding.md:31/38` 把 S8 必读的 `policy/lifecycle.md` 降为可选；`profiles/planning.md:24` 声明全阶段 S1-S13，但 Required 未列 `rules/code.md` / `rules/test.md` / `rules/review.md` |
| 规则依据 | `SKILL.md:64`“任何阶段开始前必读 kernel.md”；`SKILL.md:75` S8 必读 `policy/lifecycle.md`；`SKILL.md:77` S10 必读 `policy/safety.md` + `rules/review.md` |
| 影响 | 按 profile 加载的 Agent 可能在 S4/S8/S10 触发 `[RULE_NOT_LOADED]` 或跳过安全/生命周期检查；虽然 `SKILL.md:39/50` 声明“索引为准”，但 profile 是任务入口，实际会先按它加载 |
| 证据 | E2 静态对照 |

### D6（Medium）记忆路由“精确 key”与“memory_search”自相矛盾

| 项 | 内容 |
|---|---|
| 现象 | `learning/memory/retrieval.md:34` 要求“执行对应强制召回清单（`memory_get` 精确 key，不经 search）”，但同表 `retrieval.md:36` 的“编码/调试”行写 `memory_search "lesson:{技术栈}"` + `memory_search "reflection:{领域}"`；`engine/transition.md:65` 也写“`memory_get` 精确 key，不经 search” |
| 影响 | S2 强制召回的执行动作不唯一：按散文会跳过 search，按表格会 search；可能漏召回或违反“不经 search”的强制口径 |
| 建议 | 把散文改为“按路由表指定动作：已知 key 用 `memory_get`；经验域用 `memory_search`，均须最小充分”，并保留 `memory_get` 不计入检索次数的口径 |

### D7（Low）smoke 6b 声称校验 freshness，实际只检查字段存在

| 项 | 内容 |
|---|---|
| 现象 | `updated_at:` 留空仍通过 6b，并打印“13 字段齐全（含 updated_at freshness）” |
| 实现 | `skills/skill-authoring/scripts/smoke-check-core.sh:437-460` 只检查 `updated_at` 是否在 `req` 列表中，不检查值可解析/陈旧 |
| 影响 | 自检给出“freshness 已检查”的假象；真实实例的 freshness 实际由 `runtime.core load-checkpoint` 判定（该处会正确返回 `CHECKPOINT_DEGRADED`） |
| 建议 | 二选一：改文案为“含 updated_at 字段（freshness 由恢复协议判定）”；或对实例文件增加可解析性检查（模板的 1970 值必须豁免） |

### D8（Low）文档与实现漂移 / 隐私措辞不准确

| 子项 | 内容 |
|---|---|
| D8.1 | `README.md:5/83` 称快照为“加密快照”；实测 `skill_memory_latest.json` 是 JSON，历史快照是 gzip，均未加密。快照含本机上下文，措辞会误导隐私预期 |
| D8.2 | `docs/audits/residual-risks.md:34` 称“设计文档中的 Core/Exec/Adapter 尚未实现”，但 `runtime/core` 与 `runtime/exec` 已实现并有 267 测试；`change-list.md:54-56/80` 仍称 `scripts/audit.sh` 等“未跟踪”，实际已跟踪 |
| D8.3 | `docs/audits/change-list.md:55` 写 test-audit.sh “未跟踪”，实际已跟踪；测试计数在 `change-list.md` / `residual-risks.md` 已更新为 51/55，但表述仍带旧口径 |
| 影响 | 发布审计文档可信度下降；读者对“是否已有确定性代码/是否加密”形成错误预期 |

### D9（Info / 残余风险）

| 子项 | 说明 |
|---|---|
| D9.1 | `check-protocol` 的 Loop 起点检查只覆盖 `S4→S8`（`protocol.py:473`），不覆盖 `S7→S8`；81/81 全绿不等于 Loop 契约正确 |
| D9.2 | `smoke-check-core.sh:251-259` 直接把 `check-keys` 的 `MISSING\t<key>` 整行拼进错误信息，报告里出现 `MISSING` 前缀；属输出瑕疵，不影响失败关闭 |
| D9.3 | 遗留 `skills/vibe-coder-loop/.state.md` 仍在 Skill 安装目录（已被 gitignore），与新协议“运行状态不落 Skill 目录”不一致；不会入库，但可能被 Agent 误读 |
| D9.4 | 规则预算 3871/3900，仅余 29 行；任何新增规则都可能触发 `BUDGET_EXCEEDED` |
| D9.5 | `runtime.exec` 允许 `python3`，实测可通过 `python3 -c "os.remove(...)"` 删除文件，`files_modified` 为空；代码注释声明“防手滑，不是防对抗”，但 README/用户文档未显著声明这一边界 |

---

## 7. Propose–Probe–Compose

> 用户本轮要求“不修改当前项目内容”。以下候选均只在 `/tmp/vc-candidate-b` 副本验证；项目工作树未写入。

### 7.1 候选清单

| ID | 问题 | 最小修改 | 预期改善 | 副作用 | 验证 | 决策 |
|---|---|---|---|---|---|---|
| C1 | D1 标准 Loop 起点 | `state_machine.py` 增加 `("S7","S8"): "init_if_zero"` 及分支；`protocol.py` 支持 `(loop=init)`；`transition.md` 机器块 `S7 -> S8(loop=init)` | 首次 S8=1；3 轮上限；Case B 保持 N+1 | 新增一个 Loop 规则；需补测试 | 267 单测 + 81 协议 + CLI 实测 | **已验证，暂缓写入（用户禁止修改）** |
| C2 | D2 规则库缺失 fail-open | `memory_tool.py` 空 `skill:rules/*` 且非 `--files` → `[RULE_STORE_MISSING]` + rc3 | 与 SKILL/README 的 fail-closed 一致 | 空库时不能再用骨架摘要继续（符合定位） | 55 单测 + 空/真实 DB 实测 | **已验证，暂缓写入** |
| C3 | D3 Quick 重试 | 二选一：`kernel.md` 改为“Quick 不重试”；或 L1 `loop_max=2` | 三方口径一致 | 改动产品语义，需用户决策 | 静态 + 预算用例 | 暂缓（需决策） |
| C4 | D4 README 命令 | `verify <快照路径>`；`check-keys` 用清单文件或 smoke-check | 快速开始可执行 | 无 | 命令实测 | 暂缓（文档） |
| C5 | D5 profile 清单 | 补 review: `kernel.md`+`policy/safety.md`；debugging: `state-machine.md`+`rules/review.md`；coding: lifecycle 改 Required；planning 明确只到设计或补 code/test/review | 与加载索引一致 | 每个任务多读 1–3 个小文件 | 静态对照 | 暂缓（文档） |
| C6 | D6 记忆路由 | 散文改为“按表指定动作”，保留 memory_get 不计次 | 口径唯一 | 无 | 静态 | 暂缓（文档） |
| C7 | D7 6b 文案 | 改为“含 updated_at 字段（freshness 由恢复协议判定）” | 不再虚假声称 | 无 | 空值用例 | 暂缓（文案） |
| C8 | D8 文档漂移 | 修“加密快照”→gzip/JSON；修 Core/Exec “未实现”、未跟踪表述 | 文档与实现一致 | 无 | 静态 | 暂缓（文档） |
| C9 | D9.1 门禁盲区 | `check-protocol` 增加 S7→S8 初始化校验；新增集成测试：标准路径首次 S8=1、Case B S8=N+1、Quick 不重试/重试按决策 | 防止 D1 复发 | 门禁更严格 | 新增测试 + 变异测试 | 建议随 C1 一起做 |

### 7.2 Probe：候选 C1+C2 的实测结果

**C1 机器块与代码改动（摘要）**

```text
runtime/core/state_machine.py
+ ("S7", "S8"): "init_if_zero",
+ elif rule == "init_if_zero":
+     expected = current_loop or 1
+     ...
+     new_loop = expected

runtime/core/protocol.py
+ elif low == "loop=init":
+     normalized.add("init_if_zero")

engine/transition.md
- S7  -> S8, S10
+ S7  -> S8(loop=init), S10
# 修饰说明补充 (loop=init)
```

**C2 改动（摘要）**

```text
skills/vibe-coder-loop/backup/memory_tool.py
     else:
+        if not args.files:
+            print("  [RULE_STORE_MISSING] 未找到任何 skill:rules/* 规则条目（规则库缺失）。")
+            print("  [next] 执行 memory_tool.py restore <规则快照> 恢复规则库后重跑 preflight；不得以骨架摘要继续。")
+            return 3
         print("  （无 skill:rules/* 条目 —— 骨架化规则不可用，按文件内摘要降级并标注）")
```

**Probe 结果（同一测试集，基线 vs 候选）**

| 指标 | 基线 | 候选 C1+C2 |
|---|---|---|
| runtime 单测 | 267/267 | 267/267 |
| memory_tool 单测 | 55/55 | 55/55 |
| 审计自测 | 51/51 | 51/51 |
| 软链 | 15/15 | 15/15 |
| `check-protocol` | 81/81 | 81/81 |
| shell core/exec | 6/6, 7/7 | 6/6, 7/7 |
| `smoke-check` | rc0 | rc0（3871/3900） |
| `audit check` | rc0 | rc0 |
| 标准路径首次 S8 | **0** | **1** |
| 标准 Loop 重试 | 1/2/3，4 轮 | 2/3，3 轮后拒绝 |
| Case B 的 S6/S8 | 2/2 | 2/2（保持 N+1） |
| 空规则库 preflight | **rc0 + 降级** | **rc3 + RULE_STORE_MISSING** |
| 真实 DB preflight | rc0 | rc0 |
| `--files` 应急路径 | rc0 | rc0（仍允许显式清单） |

**结论**：C1 修复 D1，且不改变 Case B 的 N+1；C2 修复 D2，且不破坏真实 DB/应急路径；两者均无回归。C1 仍需配套 C9（门禁与集成测试），否则 `check-protocol` 仍可能在缺少 `init_if_zero` 时保持绿色。

### 7.3 被拒绝/暂缓的候选

| 候选 | 原因 |
|---|---|
| 直接把 `S7→S8` 设为 `init1` | 已实测：会破坏 Case B（`(2,2,1) != (2,2,2)`），不可采纳 |
| 把 `S4→S5` 设为 `init1` | 可通过 267 单测与 81 协议，但会让 S5–S7 显示 Loop 1，需改状态定义表；不如 C1 精确。保留为备选 |
| 修改 Quick 重试行为 | 涉及产品语义，证据只能证明“三方不一致”，不能证明哪种意图正确；留给用户决策 |
| 直接把 `preflight` 改为任何空库都 rc3 | 会破坏 `--files` 应急入口；C2 已用 `not args.files` 限定 |

---

## 8. 回归与风险

### 8.1 回归

- 本轮未修改项目实现，因此没有“修改引入的回归”。
- 候选 C1+C2 在 `/tmp` 副本跑完整矩阵：267 + 55 + 51 + 6 + 7 + 15 + 81 全过，`smoke-check` rc0，`audit check` rc0，CLI 契约符合预期。
- 未在候选副本复跑 `audit verify` 的基线比对（副本缺 `.gitignore`/`.git`，计数不可比）；原始仓库 `audit verify` rc0。

### 8.2 残余风险

| 风险 | 说明 | 等级 |
|---|---|---|
| 规则库 fail-open | D2；新机器 DB 已存在但未恢复规则时最危险 | High |
| Loop 预算偏移 | D1；4 轮而非 3 轮，且标签从 0 开始 | High |
| Quick 语义分歧 | D3；按不同文件执行会得到不同行为 | Medium |
| 启动路径不可执行 | D4；fresh clone 的“必做”步骤失败 | Medium |
| Profile 漏读 | D5；S4/S8/S10 可能触发 `RULE_NOT_LOADED` | Medium |
| 记忆路由歧义 | D6；S2 召回动作不唯一 | Medium |
| 自检虚假 freshness | D7；6b 通过不代表 freshness 有效 | Low |
| 文档/隐私措辞 | D8；“加密快照”不实；审计文档称 Core/Exec 未实现 | Low |
| 门禁盲区 | D9.1；81/81 绿但 Loop 契约错误 | Medium |
| 预算余量 | D9.4；3871/3900，仅 29 行 | Low |
| Exec 非安全边界 | D9.5；`python3` 可绕过 allowlist 做文件操作 | Medium（若把 exec 当权限边界） |
| 跨平台 | 仅 macOS 实测；Linux/Windows 未验证 | Medium |
| 无真机轨迹 | 触发/任务成功/规则遵循未评估 | 评估盲区 |
| 公开分发 | 无 LICENSE、Git 历史 `ccda1dd`、CHANGELOG 含内部信息、A-19 等 | 发布阻断（既有） |

---

## 9. 验证边界

| 类别 | 已执行（E4） | 仅静态（E2/E3） | 未验证 |
|---|---|---|---|
| runtime 核心 | 267 单测；81 协议；6 shell；标准/Quick/Case B CLI 序列 | Level→路径一致性未编码 | 多宿主 Hook 真机 |
| runtime 执行层 | 拒绝/超时/截断/脱敏/差异 7 shell + 手工探针 | allowlist 覆盖边界 | 长期并发/大仓库压力 |
| 审计工具 | 51 自测；真实仓库 check 1.10s；scan/verify | 误报边界 | Git 历史、二进制内容 |
| 记忆工具 | 55 单测；preflight 真实/空/无 DB；verify 快照 | 大规模库性能 | 跨平台路径 |
| Skill 规则 | smoke HARD 0；profile/路由/状态表静态对照 | 3871 行规则文本 | Agent 真机遵循率 |
| 触发准确性 | — | description 文本 | 宿主选择轨迹 |
| 任务成功率 | 确定性契约子集 | — | 固定任务集 + 独立验收 |
| 会话内压缩 | — | Skill 自标 E2/E3 | 真机压缩观测 |
| 跨平台 | macOS | Bash/Python 版本声明 | Linux / Windows Git Bash |
| 成本 | 单测/审计耗时 | token 预算描述 | token / 模型调用成本 |

**诚实声明**：本报告没有把未执行的测试计为通过；没有为了给出 100 分制总分而给未评估维度填分；C1/C2 的“已验证”仅指 `/tmp` 副本，不代表项目当前版本已修复。

---

## 10. 后续建议

### 必须修复（P1，阻断“fail-closed / 3 轮预算”声明）

1. **C1**：为 `S7→S8` 增加 `init_if_zero` 语义；同步机器块与 `check-protocol`；补 3 个集成测试（标准首次=1、Case B=N+1、第 4 轮拒绝）。
2. **C2**：`preflight` 在空 `skill:rules/*` 且非 `--files` 时返回非零 + `[RULE_STORE_MISSING]`；同时裁决类型 C 骨架文件的“检索失败降级”措辞（`retrieval.md` 文件 canonical 特例除外），避免与 `SKILL.md:10` 冲突。
3. **C3**：明确 Quick Loop 是否允许 1 次重试；改 `kernel.md` 或改运行时，二选一。

### 建议修复（P2，一致性与可用性）

4. **C4**：修 README 快速开始两条命令；改“加密快照”措辞。
5. **C5**：补齐 review/debugging/coding/planning 的 Required 清单。
6. **C6**：统一记忆路由的 `memory_get` / `memory_search` 口径。
7. **C7/C8**：修 6b 文案、Core/Exec “未实现”、未跟踪表述、测试计数残留。

### 可选优化（P3）

8. **C9**：把 `check-protocol` 的 Loop 起点检查扩展到标准路径；增加“门禁被绕过”的变异测试。
9. 在干净 Linux/Windows Git Bash 上跑同一套矩阵。
10. 在公开前处理 LICENSE、Git 历史、CHANGELOG 隐私、A-19 等既有发布阻断项。

**下一步（2 分钟内）**：如果你认可 C1+C2，回复“应用 C1+C2”，我再把候选补丁写入项目并重跑同一套矩阵；若暂不修改，本报告即为本轮结论。

---

## 附录 A：本轮命令清单（可复现）

```bash
# 机械矩阵
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
bash skills/vibe-coder-loop/scripts/smoke-check.sh --table

# 隐私/状态
git check-ignore -v .vibe-kernel/.state.md
git check-ignore -v skills/vibe-coder-loop/.state.md
git check-ignore -v skills/vibe-coder-loop/backup/snapshots/skill_memory_latest.json
git ls-files | grep -E '\.state\.md|snapshots/.*\.(json|gz)$|backup/rules/'

# 规则库失败关闭
DELX_MEMORY_DB=/tmp/no-such-db.sqlite \
  python3 skills/vibe-coder-loop/backup/memory_tool.py preflight --level 2 --task coding
DELX_MEMORY_DB=/tmp/memprobe/db.sqlite \
  python3 skills/vibe-coder-loop/backup/memory_tool.py preflight --level 2 --task coding

# README 命令
cd skills/vibe-coder-loop
python3 backup/memory_tool.py verify
python3 backup/memory_tool.py check-keys --files

# Loop 契约（临时项目）
core transition --cwd <tmp> --to S1
core transition --cwd <tmp> --to S2
core transition --cwd <tmp> --to S4 --level 2
core transition --cwd <tmp> --to S5
core transition --cwd <tmp> --to S6
core transition --cwd <tmp> --to S7
core transition --cwd <tmp> --to S8
core transition --cwd <tmp> --to S9
core transition --cwd <tmp> --to S10
core transition --cwd <tmp> --to S8   # 观测 loop
```

## 附录 B：候选副本与归档

- 候选副本：`/tmp/vc-candidate-b`（C1+C2 已打补丁；完整回归通过）。该目录是临时验证环境，不作为项目交付物。
- 备选副本：`/tmp/vc-candidate`（`S4→S5 init1` 方案；267/81 通过，但会改变 S5–S7 的 Loop 显示，未推荐）。
- 本轮归档：`skill-evaluation/archive/2026-10-20-pre-round2/evaluation-report-2026-10-20.md`。
- 更早归档：`skill-evaluation/archive/2026-10-20-pre-review/`（baseline-report / evaluation-report / evaluation-rubric / iteration-log / test-cases）。

## 附录 C：评分明细

| 维度 | 权重 | 得分 | 证据覆盖 | 扣分理由 |
|---|---:|---:|---|---|
| 功能正确性 | 25 | 17 | 高（E4） | D1 预算 4 轮；D2 规则库 fail-open |
| 执行有效性 | 25 | 12（13 分未评估） | 中（确定性层） | 机械测试全过；无 Agent 轨迹；确定性契约 4 项失败 |
| 规则一致性 | 15 | 9 | 高（E2/E4） | D1/D3/D5/D6/D7 多处矛盾 |
| 鲁棒性 | 15 | 10 | 中高（E4） | exec/审计/记忆工具异常路径强；D2 失败开放、D7 虚假 freshness |
| 可维护性 | 10 | 7 | 中（E2） | 分层与单一来源良好；文档漂移、profile 漂移、预算余量 29 行 |
| 可移植性 | 10 | 5 | 中（E4/E2） | 私有规则库有文档；README 启动路径断、仅 macOS 实测 |
| **可评估子集** | **75** | **48（64.0%）** | **约 83%** | 执行有效性 25 分仅 12 分可测，13 分未评估 |
| **综合** | **100** | **60（覆盖约 72/100）** | **约 72%** | 不宣称完整 100 分制结论 |

> 与归档报告的关系：上一轮报告在其自身测试集上给出可评估子集 53/75（70.7%）。本轮测试集扩大了（新增 Loop/失败关闭/启动路径用例），因此 48/75 不能直接解释为“代码退化”；它表示“在新测试集下暴露了上一轮未覆盖的缺陷”。两轮口径不同，不合并、不相加。

---

## 12. 修复回执（本轮已执行 · 用户指令“修复所有审查处理的问题”）

> 用户追加指令后落地。修复对象 = `Vibe-Coder-Loop` @ 修复后工作树（commit `cff0f7b` 之上的未提交改动）；Skill 版本仍 `1.22.1`（未提交 git 不迭代，见 CHANGELOG v1.22.1 第四批）。

### 12.1 缺陷处置一览

| 缺陷 | 处理 | 落点 | 验证 |
|---|---|---|---|
| D1 标准 Loop 起点/4 轮 | **已修**：`S7→S8: init_if_zero`（首次进 Code=1，Case B 保持 N+1）；机器块加 `(loop=init)`；`check-protocol` 增 S7→S8 初始化校验 | `runtime/core/state_machine.py`、`runtime/core/protocol.py`、`engine/transition.md`、`tests/core/` | CLI：标准 1/2/3、第 4 轮 `LOOP_BUDGET_EXHAUSTED`；Case B S6/S8=2；271 单测 OK；协议 82 checks |
| D2 空规则库 fail-open | **已修**：`preflight` 空 `skill:rules/*` 且非 `--files` → `[RULE_STORE_MISSING]` rc3；`--files` 应急路径仍 rc0；11 处骨架文件改为 fail-closed 措辞，`retrieval.md`（文件 canonical）澄清 | `backup/memory_tool.py`、11 个 `.md`、`skill-authoring/governance-protocol.md` | 空 DB rc3 `RULE_STORE_MISSING`；真实 DB rc0；`--files` rc0；56 单测 OK |
| D3 Quick 重试三方矛盾 | **已修**（口径=不重试）：`kernel.md` §7 改为“S9 失败不回退 Code，建议升级”，与 `rules/test.md` 和 `loop_max=1` 一致 | `kernel.md` | 静态 + CLI：Quick S9→S8 `LOOP_BUDGET_EXHAUSTED` |
| D4 README 命令/加密措辞 | **已修**：`verify <快照>`；key 校验用 `smoke-check.sh --table`；“加密快照”→ gzip/JSON（未加密） | `README.md` | README 快速开始命令形态与工具签名一致 |
| D5 profile 必读缺口 | **已修**：review/debugging/coding/planning/refactoring/skill-maintenance 补齐 S1/S8/S10/S12 必读 | `profiles/*.md` | 静态对照；smoke 6 加载计划仍 rc0 |
| D6 记忆路由矛盾 | **已修**：散文改为“已知 key 用 `memory_get`，经验域用 `memory_search`，均最小充分” | `learning/memory/retrieval.md`、`engine/transition.md` | 静态 |
| D7 6b 虚假 freshness | **已修**：文案改为“含 updated_at 字段；freshness 由 load-checkpoint 判定”；Case B 记号在 state-machine 加注释 | `smoke-check-core.sh`、`engine/transition.md`、`engine/state-machine.md` | 空 `updated_at` 仍 6b 通过字段存在性；freshness 由 `load-checkpoint` 判 `CHECKPOINT_DEGRADED` |
| D8 文档漂移 | **已修**：residual-risks / change-list / README 修正现状；2026-10-19 报告加历史快照说明；README 补 exec 边界声明 | `docs/audits/*`、`README.md` | 静态 |
| D9.1 协议门禁盲区 | **已修**：`check-protocol` 增 S7→S8 初始化校验 + 回归测试（modifier drift + 代码 edge 守卫） | `runtime/core/protocol.py`、`tests/core/test_protocol_conformance.py` | 82 checks；删 `loop=init` 即报 modifier drift |
| D9.2 smoke 4b 前缀 | **已修**：解析 `MISSING`/`NOT_PERMANENT` 前缀，分类输出 | `smoke-check-core.sh` | 空 DB 报告不再带 `MISSING\t` 前缀 |
| D9.3 遗留 `skills/vibe-coder-loop/.state.md` | **保留**（不物理删除）：本地实例，已被 gitignore，未被加载索引引用；按资产生命周期不删 | — | `git check-ignore` rc0；`git ls-files` 未跟踪 |
| D9.4 预算余量 | **可控**：修复后规则行数 3877 / 预算 3900（余 23），未超限；未上调预算 | smoke 实测 | smoke rc0 |
| D9.5 exec 非权限沙箱 | **已修**：README 安全与隐私补一句“exec 是防手滑，不是权限沙箱” | `README.md` | 静态 |

### 12.2 回归矩阵（修复后）

| 命令 | 结果 | 备注 |
|---|---|---|
| `python3 -m runtime.core check-protocol` | `{"ok":true,"checks":82,"drifts":[],"unparsed":[]}` | +1 新增 S7→S8 校验 |
| `python3 -m unittest discover -s tests -p 'test_*.py'` | **271/271 OK** | +4（标准 init、3 轮预算、modifier drift、edge 守卫） |
| `python3 skills/vibe-coder-loop/backup/test_memory_tool.py` | **56/56 OK** | +1（空规则库 fail-closed） |
| `bash scripts/tests/test-audit.sh` | **PASS=51 FAIL=0** | — |
| `bash scripts/verify-symlinks.sh` | **PASS=15 FAIL=0 WARN=0** | — |
| `bash scripts/tests/test-runtime-core.sh` | **PASS=6 FAIL=0** | — |
| `bash scripts/tests/test-runtime-exec.sh` | **PASS=7 FAIL=0** | — |
| `bash skills/vibe-coder-loop/scripts/smoke-check.sh --table` | **rc0** | HARD 0；规则 3877 / 预算 3900 |
| `bash scripts/audit.sh check` | rc0 | — |
| `bash scripts/audit.sh scan` | rc0 | 仅 H002 info |
| `bash scripts/audit.sh verify -b docs/audits/baseline.tsv` | rc0 | 新增 13、消失 14、新增严重/高危 0 |
| 空 DB preflight | **rc3** `RULE_STORE_MISSING` | fail-closed |
| 真实 DB preflight | rc0 | — |
| 标准 Loop CLI | 1 → 2 → 3 → 拒绝 | 文档 3 轮上限 |
| Case B CLI | S6/S8=2（保持 N+1） | 不破坏既有行为 |

### 12.3 仍未验证（不宣称）

- 真实干净机器（临时 HOME + 私有快照恢复后）端到端。
- Linux / Windows Git Bash 真机。
- Agent 真机轨迹（触发准确率 / 任务成功率 / 规则遵循率）。
- D9.3 遗留本地 `.state.md` 保留为本地实例，不作为公开缺陷。

### 12.4 修复后评分（仅可测部分，不宣称 100 分制）

- D1/D2/D9.1 关闭 → 功能正确性与鲁棒性提升；D3–D8 关闭 → 规则一致性提升。
- 执行有效性（触发/任务成功/规则遵循）仍无 Agent 轨迹，未评估。
- 可评估子集从 48/75 提升约 7–9 分（D1 +2、D2 +1、D9.1 +1、D5/D6/D3 各 +1 等），预计约 56/75（74.7%）；最终以复评为准，本报告不再回填评分表以避免自评污染。
- 候选 C1/C2 的 `/tmp` 副本回归（267/55/51/6/7/15/81）与项目内回归（271/56/51/6/7/15/82）一致 → 证据强度 E4。
