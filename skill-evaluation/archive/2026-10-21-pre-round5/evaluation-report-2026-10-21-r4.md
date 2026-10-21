# Vibe-Coder-Loop 体系审查报告（2026-10-21 · 第四轮 · 修复后复评）

## 0. 元信息

| 项 | 值 |
|---|---|
| 审查对象 | `Vibe-Coder-Loop` @ `8dbb858b4311d98d379f405c108196185c0067fa`（工作树仅本轮归档重命名） |
| Skill 版本 | `skills/vibe-coder-loop/manifest.yaml` = `1.22.1`（同版本第五批已提交） |
| 审查范围 | `skills/vibe-coder-loop`（kernel/engine/rules/policy/learning/profiles/references/scripts/backup）、`skills/delx-memory-protocol`、`skills/skill-authoring`、`kernel/Vibe Coder.md`、`runtime/core`、`runtime/exec`、`scripts/`、`tests/`、`docs/`、`README.md` |
| 旧报告归档 | `skill-evaluation/archive/2026-10-21-pre-round4/evaluation-report-2026-10-21-r3.md`（上轮）；更早见 `archive/2026-10-20-pre-round3/`、`archive/2026-10-20-pre-round2/`、`archive/2026-10-20-pre-review/` |
| 本轮约束 | **只读审查**：未修改任何项目文件；候选修改全部在 `/tmp` 副本验证 |
| 环境 | macOS Darwin 26.6.2；Bash 3.2.57；Python 3.13.3；本机 delx-memory（`skill:*` 45 条）；**无 Agent 宿主真机轨迹** |
| 证据等级 | E0 推测 / E1 用户描述 / E2 文件读取 / E3 静态分析 / E4 运行或测试结果 |

> 本轮性质：上轮 10 项缺陷已提交，本轮做**修复后复评**——先核验修复是否真实生效，再用**新一变异测试集**继续找盲区。不把"上轮已修"当作"本轮通过"。

---

## 1. 审查结论

### 1.1 总体状态

- 上轮 High（S8/S10 安全载荷缺失）**已实测关闭**：`preflight --stage S8/S10` 均命中 `policy/safety.md` L14-27（§1）。
- 上轮新增的门禁用例**有效**：6 个原静默变异体全部转红。
- 机械层稳定：271 单测 / 57 记忆工具 / 51 审计 / 15 软链 / 82 协议 / 6+7 shell / smoke rc0（规则 3887/3900）。

但本轮用**第二批变异集**（针对 per-level 文件清单与工具参数）仍找到 **7 项新缺陷**：Medium 2 / Low 5。其中 **R4-D1 是上轮修复引入（或说被显式暴露）的规则双出口冲突**——同一"硬约束违规"在审查链路要求回 S6、在运行时要求进 S14，无仲裁。

### 1.2 阻断性判断

| 口径 | 结论 |
|---|---|
| 作者本机私有使用 | **不构成阻断** |
| 对第三方宣称"硬约束违规有唯一确定处置" | **构成阻断（口径层面）**：R4-D1 存在两条互斥路径 |
| 公开分发 | 仍受 LICENSE、私有规则库、跨平台未验证阻断（既有事项） |

### 1.3 是否建议采纳修改

| 候选 | 建议 | 依据 |
|---|---|---|
| C1 扩展 per-level 期望表 | **建议采纳** | 4 个变异现静默；Probe 后基线仍绿、4 个变异转红 |
| C2 硬约束违规仲裁 + `vc_violation` 入口 | **建议采纳（需用户确认语义）** | 二选一：可修复→情况 B；不可修复/已造成不可逆→S14 |
| C3 `artifact` 参数校验（offset / grep） | **建议采纳** | 与同函数既有 `--limit`/`--max-bytes` 校验一致 |
| C4 `exec --timeout-ms` 校验 | **建议采纳** | 负数被误报为 TIMEOUT；Probe 后 rc=2 |
| C5 审计文档计数与发布清单 | **建议采纳** | 43/51/55 三处过期；发布门禁会误判 |
| C6 `ARTIFACT_NAME_INVALID` 口径 | 建议（二选一：删死码或改文档） | 分隔符被静默消毒，错误码不可达 |

按用户本轮指令「不要修改当前项目的内容」，**以上候选均未落地**。

---

## 2. 范围、结构与依赖

| 层 | 内容 | 规模 |
|---|---|---|
| Skill 规则 | kernel / engine(5) / rules(7) / policy(4) / learning(含 memory 5 分片) / profiles(6) / references(7) | smoke 实测 **3887 行 / 预算 3900（余 13）** |
| 确定性工具 | `backup/memory_tool.py`（preflight/artifact/touch/metrics/backup/restore/verify/list/check-keys/export-rules） | 2315 行，仅标准库 |
| Runtime Core | 状态机 / Checkpoint / 协议一致性 / 恢复 / Safe Mode / 产物 | 约 6.0k 行，271 单测 |
| Runtime Exec | allowlist / 超时 / 截断 / 脱敏 / 差异 / 产物 | 约 2.2k 行，6+7 shell 用例 |
| 审计与自检 | `audit.sh`、`verify-symlinks.sh`、`smoke-check-core.sh` | 51 + 15 项 |

关键依赖：规则正文在 delx-memory `skill:*`（本机 45 条）；`load_plan.json` 是 `SKILL.md` 两表的机器副本；`stage_sections` 决定每个阶段真实读到哪些章节。

---

## 3. 基线实测（E4）

### 3.1 机械矩阵

| 命令 | 结果 |
|---|---|
| `python3 -m unittest discover -s tests -p 'test_*.py'` | **271/271 OK**（27.6s） |
| `python3 skills/vibe-coder-loop/backup/test_memory_tool.py` | **57/57 OK**（22.5s） |
| `bash scripts/tests/test-audit.sh` | **51/51** |
| `bash scripts/verify-symlinks.sh` | **15/15** |
| `python3 -m runtime.core check-protocol` | **82/82，0 漂移** |
| `bash skills/vibe-coder-loop/scripts/smoke-check.sh` | **rc0**；3887/3900；HARD 0 |
| `bash scripts/tests/test-runtime-core.sh` / `test-runtime-exec.sh` | 6/6、7/7 |
| `bash scripts/audit.sh check` | rc0 |

合计 **489 项**机械断言通过。

### 3.2 上轮修复回归核验

| 上轮缺陷 | 本轮核验方式 | 结果 |
|---|---|---|
| R3-D1 S8/S10 缺 safety §1 | `preflight --stage S8/S10` | **通过**：均含 L14-27（S8 89 行、S10 82 行） |
| R3-D2 门禁盲区 | 重放 6 个变异体 | **通过**：6/6 转红（但见 R4-D2：期望表仍是子集） |
| R3-D3 profile 漏读 | 新自测断言 + smoke | **通过** |
| R3-D4 `[Loop: 0]` | grep 全部标签位 | **通过**：仅前置阶段（S1/S3/S6/S7 首次）保留 Loop 0，符合契约 |
| R3-D5 重置悬空 | 静态对照 `LOOP_RULES` | **通过**：仅 `S13→S1`、`S10→S7` 归 0 |
| R3-D6 阈值不可配置 | `check-protocol` + kernel §5 | **通过**（但触发入口缺失，见 R4-D1） |
| R3-D7 300 行互斥 | grep | **通过**：归档触发条件不再含行数 |
| R3-D8 Prompt 暂停项 | 静态 | **通过**：5 条对齐 |
| R3-D9 `Nonee` | `metrics` 实测 | **通过**：`skeleton=None/NoneB` |
| R3-D10 措辞 | smoke | **通过**：注释/标题已统一 |

### 3.3 工具层边界实测

| 用例 | 实测 |
|---|---|
| `artifact put --name "a/b"` | **静默消毒为 `a-b`，rc0**（见 R4-D5） |
| `artifact page --offset -1` | **rc0，静默按 0**（见 R4-D3） |
| `artifact page --grep "["` | **rc0，0 命中**（静默转义，见 R4-D4） |
| `artifact page --limit 0` / `--max-bytes 0` | rc3 `INVALID_ARGUMENT`（正确） |
| `artifact page --limit 99999` | rc0 + `OUTPUT_LIMIT`（显式 clamp，正确） |
| `artifact page --ref bogus` | rc4 `ARTIFACT_NOT_FOUND` + 已有 ref 提示（正确） |
| `export-rules --out <tmp>` | 45 条，残留扫描 0 命中（个人路径/邮箱/凭证） |
| `exec --timeout-ms -5` | **rc0 + `TIMEOUT`（exit -15）**（见 R4-D7） |
| `exec --max-output 0` | `truncated:true` + `OUTPUT_LIMIT`（显式，可接受） |
| `core transition --level 5` | `INVALID_ARGUMENT`（正确） |
| `core get-state`（双文档损坏） | `CHECKPOINT_CORRUPT` + reference_only（正确） |
| S13→S1（follow-up） | 字段重置 + `loop=0` + 归档旧状态（正确） |

---

## 4. 评分规则（Rubric）

沿用上轮维度与权重，便于纵向比较；评分等级按 0% / 40% / 70% / 100% 四档，允许中间分并说明依据。

| 维度 | 权重 | 100% 判据 |
|---|---:|---|
| 功能正确性 | 25 | 规则、流程、I/O 均有测试证据且无契约偏差 |
| 执行有效性 | 25 | 真机轨迹 + 独立验收，成功率高 |
| 规则一致性 | 15 | 单一事实源、无冲突、无死指针 |
| 鲁棒性 | 15 | 边界/失败/重复执行均有测试 |
| 可维护性 | 10 | 职责清晰、文档测试实现一致 |
| 可移植性 | 10 | 干净环境可复现、跨平台已验证 |

**硬性门槛**：违反安全红线 / 关键输出契约失效 / 评估被污染 / 核心测试回归未解释 → 不得宣称"已通过验证"。

**未评估项**：Agent 触发准确率、任务成功率、规则遵循率、会话内压缩恢复、Linux/Windows 真机。

---

## 5. 分层测试集与结果

| ID | 类别 | 输入/操作 | 预期 | 实测 | 判定 |
|---|---|---|---|---|---|
| T-A1..A9 | 正常 | 全量机械矩阵 | 全过 | 489 项通过 | 通过 [E4] |
| T-B1 | 触发 | 宿主选择 Skill | 应触发/不误触发 | 无宿主轨迹 | **未评估** [E2] |
| T-C1 | 边界 | 空规则库 preflight | rc3 | rc3 `RULE_STORE_MISSING` | 通过 [E4] |
| T-C2 | 边界 | `--level/--task/--stage` 非法 | rc3 | rc3 | 通过 [E4] |
| T-C3 | 边界 | 排除全部阶段 | rc3 | rc3「阶段集为空」 | 通过 [E4] |
| T-C4 | 边界 | 损坏 Checkpoint | 降级 | `CHECKPOINT_CORRUPT` | 通过 [E4] |
| T-D1 | 冲突 | 硬约束违规的处置路径 | 唯一 | **审查→S6 / 运行时→S14** | **失败 Medium** [E3] → R4-D1 |
| T-D2 | 冲突 | 安全载荷（上轮修复） | 含 §1 | 含 L14-27 | 通过 [E4] |
| T-E1 | 失败恢复 | exec 拒绝/超时/截断/脱敏 | 结构化码 | 符合；但负超时误报 | 部分失败 Low [E4] → R4-D7 |
| T-F1 | 输出验收 | metrics 仪表盘 | 格式正确 | `skeleton=None/NoneB` | 通过 [E4] |
| T-F2 | 输出验收 | 发布清单计数 | 与实际一致 | 43/51/55 vs 51/57 | **失败 Low** [E2/E4] → R4-D6 |
| T-G1 | 回归 | 上轮 10 项修复 | 全保持 | 10/10 保持 | 通过 [E4/E2] |
| T-H1 | 鲁棒性 | 重复执行全量 | 稳定 | 两轮一致 | 通过 [E4] |
| T-I1 | 可移植性 | 硬编码路径 / bash4 / py3.9 API | 无 | 无（export-rules 残留 0） | 通过 [E3/E4] |
| T-J1 | 安全 | `rm -rf` / `git push` / 红码 | 拒绝 | `SCOPE_DENIED` | 通过 [E4] |
| T-K1 | 工作流 | 标准 Loop / Case B / Investigation | 与文档一致 | 1/2/3、N+1、loop 0→+1 | 通过 [E4] |
| T-M1 | 变异 | 删 L2 `policy/lifecycle.md` | 门禁红 | **绿** | **失败 Medium** [E4] → R4-D2 |
| T-M2 | 变异 | 删 L2 `policy/priority.md` | 门禁红 | **绿** | 失败 → R4-D2 |
| T-M3 | 变异 | 删 L2 `learning/reflection.md` | 门禁红 | **绿** | 失败 → R4-D2 |
| T-M4 | 变异 | 删 L3 `learning/memory/architecture.md` | 门禁红 | **绿** | 失败 → R4-D2 |
| T-M5 | 变异 | 删 lifecycle 的 S8 映射 | 门禁红 | 红（孤儿章节用例） | 通过 [E4] |
| T-M6 | 变异 | 扩展期望表后重放 M1–M4 | 全红 | 全红；基线仍绿 | 通过（候选 C1）[E4] |
| T-N1 | 未评估 | 压缩后恢复 / 跨平台 | — | 无真机 | **未评估** [E2] |

**统计**：机械断言 489/489；非变异系统级用例 **12 通过 / 2 失败 / 1 部分失败 / 2 未评估**；变异用例 **7 通过**（重放上轮 6 个 + M5）/ **4 失败**（M1–M4 当前无防线）。

---

## 6. 缺陷清单

### R4-D1（Medium）「硬约束违规」有两个互斥出口，且运行时触发入口无操作指引

| 项 | 内容 |
|---|---|
| 现象 | 同一事件（Hard 项违规）在四份文件中被导向两个不同状态：① `policy/safety.md:90-96`「Hard → 审查不通过 → 情况 B」；② `engine/transition.md:181,186` S9/S10 → 回 S6；③ `kernel.md:165`「硬约束违规 → SAFE MODE（1 次）」；④ 运行时 `runtime/core/core.py:396-410` 收到 `vc_violation` → `transition(S14, force=True)` |
| 触发入口 | `vc_violation` 只能经 `core transition --vc-violation` 或 `feed-exec` 的 `ExecResult.vc_violation` 传入；**Skill 的 S8/S10 出口清单从未要求 Agent 上报它**（grep `vc_violation` 在 skill 内仅 kernel §5 一处） |
| 影响 | 两种读法都"合规"：审查者回 S6 重设计，运行时却要求 S14；且后者实际几乎不可达（无人告知何时上报）。SAFE MODE 的"硬约束违规 1 次即停"在真实会话中可能永不触发 |
| 为什么现有规则不能解决 | `policy/priority.md` 的层级仲裁只处理"文件规则之间"，未定义"同一违规的可修复性分流"；kernel §5 只登记阈值，未写入口与出口关系 |
| 建议 | 在 `policy/safety.md` §3 增一行分流定义：**可修复的 Hard 违规 → 情况 B（S6 重设计）；已造成不可逆后果 / 无法在本轮修复 → 上报 `vc_violation` 进 S14**；并在 S8/S10 出口清单补一条上报条件。二选一需用户确认语义 |
| 证据 | E3（静态四文件对照）+ E4（`vc_violation` 路径实测存在，skill 内无调用指引） |

### R4-D2（Medium）per-level 文件清单的期望表仍是子集，4 个变异静默

| 项 | 内容 |
|---|---|
| 现象 | 上轮新增的 `test_real_plan_stage_payload_and_profile_coverage` 只断言 `common`（5 个）+ L1/L2/L3 的少量文件。删除以下 4 项时，57 项自测与 smoke **全绿**：`levels["2"]` 的 `policy/lifecycle.md`、`policy/priority.md`、`learning/reflection.md`；`levels["3"]` 的 `learning/memory/architecture.md` |
| 影响 | 装配层仍可静默丢文件：L2 失去 S8 生命周期约束或 S3 优先级仲裁输入，L3 失去记忆架构分片 |
| 根因 | 期望表是"手写子集"而非"与 `SKILL.md` 分级加载/`load_plan.levels` 对齐的全集" |
| 建议 | 把期望表补成完整分层（L2+：lifecycle/priority/reflection；L3+：memory.md/architecture.md），并保留 ratchet 语义——新增文件必须同步更新断言 |
| 证据 | E4：T-M1..M4 四个变异体全绿；T-M6 证明扩展后全红且基线不破 |

### R4-D3（Low）`artifact page --offset -1` 静默按 0 处理

| 项 | 内容 |
|---|---|
| 现象 | `memory_tool.py:2103` `offset = max(0, args.offset or 0)`；实测 `--offset -1` rc=0，从首行返回 |
| 对照 | 同一函数对 `--limit`（:2084）与 `--max-bytes`（:2096）均返回 `INVALID_ARGUMENT` rc3；上方注释自称「超限必须可见，不得静默截断」 |
| 影响 | 分页脚本传负偏移时静默重复首页，可能造成重复处理/漏页 |
| 建议 | `args.offset < 0` → `INVALID_ARGUMENT` rc3（与 limit 同构） |
| 证据 | E4 |

### R4-D4（Low）`artifact page --grep <非法正则>` 静默降级为字面量搜索

| 项 | 内容 |
|---|---|
| 现象 | `memory_tool.py:2070-2075` `except re.error: rx = re.compile(re.escape(...))`；实测 `--grep "["` rc=0、0 命中，无任何提示 |
| 影响 | 用户以为在用正则，实际是字面量匹配；`--count` 会给出一个"合法但错误"的数字（如把 `a|b` 当字面量 `a|b` 而非 a 或 b） |
| 建议 | `re.error` → `INVALID_ARGUMENT` rc3 + `[next]`（同 C3 补丁已验证） |
| 证据 | E4 |

### R4-D5（Low）`ARTIFACT_NAME_INVALID` 是不可达错误码

| 项 | 内容 |
|---|---|
| 现象 | `memory_tool.py:1975` 的拒绝分支要求 `dest` 逃逸产物目录，但 `_artifact_slug` 已把 `a/b` 消毒为 `a-b`，双保险永不触发；实测 `--name "a/b"` rc0 |
| 文档冲突 | `engine/transition.md` 运维码表写「`ARTIFACT_NAME_INVALID`（`--name` 含路径分隔符→改纯文件名）」；`memory_tool.py` 头部写「消毒（去路径分隔符/首尾点），非法直接拒绝」——**消毒 vs 拒绝**两种口径并存 |
| 影响 | 文档承诺的错误码永不出现；排障时按码表搜不到实际行为 |
| 建议 | 二选一：①保留消毒，删死分支与码表条目，文档统一为"消毒"；②改为拒绝分隔符并保留码。推荐①（消毒更安全，无破坏） |
| 证据 | E4 + E2 |

### R4-D6（Low）审计文档的测试计数过期（发布门禁会误判）

| 项 | 内容 |
|---|---|
| 现象 | `docs/audits/release-checklist.md:58-59`：`test-audit.sh: 43 PASS`（实际 51）、`test_memory_tool.py: 51 tests`（实际 57）；`docs/audits/compatibility.md:15,17` 同；`docs/audits/residual-risks.md:56` 写 `test_memory_tool.py 55/55` |
| 影响 | 发布者按清单核对时看到"数字不符"，或反过来在计数回退时误以为通过；三份文档给出三个不同历史值（43/51/55） |
| 根因 | 计数是硬编码快照，测试每轮增加但文档未同步；`change-list.md` 的 51 指 audit 自测（正确），易混淆 |
| 建议 | 清单改为"命令 rc=0 + 打印实际计数"，不写死数字；或在文档中只写"≥N"下界 |
| 证据 | E2/E4 |

### R4-D7（Low）`exec --timeout-ms` 负数被误报为 TIMEOUT

| 项 | 内容 |
|---|---|
| 现象 | `runtime/exec/cli.py:51` 无参数校验；`runner.py:271` `deadline = monotonic() + timeout_ms/1000`；实测 `--timeout-ms -5` → rc0 + `TIMEOUT`（exit -15），命令未执行 |
| 影响 | 参数错误被归入"执行超时"类，排障方向错误；`vc_code=TIMEOUT` 的 `[next]` 建议"提高 timeout"对负值无意义 |
| 建议 | `cmd_run` 入口校验 `timeout_ms > 0`、`max_output >= 0` → `INVALID_ARGUMENT` rc2（已 Probe，271 测试不回归） |
| 证据 | E4 |

---

## 7. Propose–Probe–Compose

> 所有候选只在 `/tmp` 副本验证；项目工作树零写入。

| ID | 缺陷 | 最小修改 | 预期改善 | 副作用 | 验证 | 决策 |
|---|---|---|---|---|---|---|
| C1 | R4-D2 | 扩展 `required_for()`：L2+ 增 lifecycle/priority/reflection；L3+ 增 memory.md/architecture.md | 4 个静默通道关闭 | 新增文件需同步断言 | 基线 57/57；4 变异全红 | **已验证，建议采纳** |
| C2 | R4-D1 | `safety.md` §3 增分流定义 + S8/S10 出口补 `vc_violation` 上报条件 | 同一违规唯一出口；触发器可达 | 需用户确认"可修复/不可修复"边界 | 静态对照 | **建议（语义待确认）** |
| C3 | R4-D3/D4 | `offset<0` → rc3；`re.error` → rc3 | 参数错误显式失败 | 依赖"非法正则按字面量"的脚本会失败（行为变严） | 57/57；rc3 实测 | **已验证，建议采纳** |
| C4 | R4-D7 | `cmd_run` 校验 timeout/max_output → rc2 | 错误分类正确 | 无 | 271/271；rc2 实测 | **已验证，建议采纳** |
| C5 | R4-D6 | 审计文档去掉硬编码计数，改 rc=0 + 实际输出 | 不再过期 | 文档措辞调整 | 静态 | **建议采纳** |
| C6 | R4-D5 | 保留消毒，删死分支 + 统一文档 | 无死码 | 移除以码为契约的外部脚本不受影响 | 静态 + 实测 | **建议采纳** |

### Probe 结果（同一测试集）

| 指标 | 基线 | C1 | C3 | C4 |
|---|---|---|---|---|
| memory_tool 自测 | 57/57 | **57/57** | **57/57** | — |
| runtime 单测 | 271/271 | — | — | **271/271** |
| 4 个原静默变异 | 绿 | **全红** | — | — |
| `--offset -1` / `--grep "["` | rc0 静默 | — | **rc3 + [next]** | — |
| `--timeout-ms -5` | TIMEOUT | — | — | **rc2 INVALID_ARGUMENT** |
| 正常路径 | 正常 | 正常 | `--offset 1` 正常 | 正常 |

---

## 8. 回归与风险

- 本轮未修改项目，无"修改引入的回归"。
- 上轮修复的保持性：10/10 通过（§3.2）。
- 候选副本无回归（§7 Probe）。

| 风险 | 说明 | 等级 |
|---|---|---|
| 硬约束违规双出口 | R4-D1；审查/运行时读法不同 | Medium |
| 装配门禁子集化 | R4-D2；仍可静默丢 L2/L3 文件 | Medium |
| 分页参数静默 | R4-D3/D4；重复页/错误计数 | Low |
| 死错误码 | R4-D5；排障按码表找不到 | Low |
| 发布清单计数 | R4-D6；门禁误判 | Low |
| 负超时误分类 | R4-D7；排障方向错误 | Low |
| 规则预算 | 3887/3900，余 13 行；C2 需净增 1–2 行 | Low |
| Exec 非沙箱 | `make`/`npm run`/`python3 -c` 可执行任意命令（已声明） | Medium（声明内） |
| 跨平台 | 仅 macOS 实测 | 未评估 |

---

## 9. 验证边界

**已执行（E4）**：489 项机械断言；4 组工作流路径（follow-up 全链路 / 非法 level / S14 无 force / 损坏 Checkpoint）；10 项上轮修复核验；12 项工具边界（含 4 个新缺陷复现）；11 个变异体（7 个已有防线 / 4 个新盲区）；3 个候选补丁。

**仅静态（E2/E3）**：R4-D1 四文件对照、R4-D5 码表与实现、R4-D6 计数、profile 装配。

**未验证**：Agent 触发准确率 / 任务成功率 / 规则遵循率；会话内压缩恢复；Linux/Windows 真机；Python 3.8 运行。

---

## 10. 评分与覆盖率

| 维度 | 权重 | 得分 | 证据覆盖 | 扣分理由 |
|---|---:|---:|---|---|
| 功能正确性 | 25 | **19**（76%） | 高（E4） | 上轮 High 已修；R4-D1 双出口、R4-D7 错误分类 |
| 执行有效性 | 25 | **10**（可测 12 的 83%） | 中（确定性层） | 无 Agent 轨迹 → 13 分未评估 |
| 规则一致性 | 15 | **10.5**（70%） | 高（E2/E4） | R4-D1；上轮 6 处漂移已关闭 |
| 鲁棒性 | 15 | **10.5**（70%） | 中高（E4） | R4-D3/D4/D7 静默参数处理；R4-D2 装配盲区 |
| 可维护性 | 10 | **7.5**（75%） | 中（E2） | R4-D6 文档计数；预算余 13 行 |
| 可移植性 | 10 | **7**（70%） | 中（E3/E4） | 仅 macOS 实测；Windows 未验证 |
| **可评估子集** | **75** | **64.5 / 75（86.0%）** | **约 85%** | 执行有效性 13 分未评估 |
| **综合（不宣称 100 分制）** | **100** | **64.5** | **覆盖约 75/100** | 13 分未评估 |

> **与上轮不可直接相减**：上轮基线与本轮基线不是同一 commit（上轮为修复前 `b142b0b`，本轮为修复后 `8dbb858`），且测试集再次扩大（新增 9 个变异）。64.5 只表示"当前状态在本轮测试集下的可测得分"，不构成改进幅度声明。

---

## 11. 后续建议

**建议立即处理（有 E4 证据、低风险）**

1. C1：扩展 per-level 期望表（关闭 4 个静默通道）。
2. C3：`artifact` 的 `offset`/`grep` 参数显式失败。
3. C4：`exec` 的 `timeout-ms`/`max-output` 参数校验。
4. C5：审计文档去掉硬编码计数。
5. C6：统一 `--name` 的"消毒"口径，删除死分支。

**需用户决策**

6. C2：硬约束违规的"可修复 → 情况 B / 不可修复 → S14"分流，以及 `vc_violation` 的上报条件（涉及产品语义）。

**可选**

7. 把 `smoke-check` 的 13 行预算余量纳入发布前检查（当前靠人记）。
8. 用同一套"期望表"机制覆盖 profile Required（避免再次出现"补了 6 个文件但断言只查 2 个"）。

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

# R4-D1：双出口静态对照
grep -n "硬约束违规" skills/vibe-coder-loop/kernel.md
grep -n "情况 B" skills/vibe-coder-loop/policy/safety.md
grep -n "vc_violation" runtime/core/core.py skills/vibe-coder-loop/**/*.md

# R4-D2：4 个静默变异（/tmp 副本）
git archive HEAD | tar -x -C /tmp/vc-r4
cp skills/vibe-coder-loop/backup/{memory_tool.py,config.json,test_memory_tool.py} /tmp/vc-r4/skills/vibe-coder-loop/backup/
# 删 load_plan.json 的 levels["2"] 中 policy/lifecycle.md，然后：
cd /tmp/vc-r4/skills/vibe-coder-loop && python3 backup/test_memory_tool.py   # 基线：OK（应失败）

# R4-D3/D4/D5：artifact 参数
python3 skills/vibe-coder-loop/backup/memory_tool.py artifact page --ref <REF> --offset -1
python3 skills/vibe-coder-loop/backup/memory_tool.py artifact page --ref <REF> --grep '['
python3 skills/vibe-coder-loop/backup/memory_tool.py artifact put --file <F> --name "a/b"

# R4-D6
grep -n "43 PASS\|51 tests\|55/55" docs/audits/release-checklist.md docs/audits/compatibility.md docs/audits/residual-risks.md

# R4-D7
python3 -m runtime.exec run --cwd /tmp --timeout-ms -5 -- python3 -c 'print(1)'
```

## 附录 B：归档与产物

- 本轮归档：`skill-evaluation/archive/2026-10-21-pre-round4/evaluation-report-2026-10-21-r3.md`
- 历史：`archive/2026-10-20-pre-round3/`、`archive/2026-10-20-pre-round2/`、`archive/2026-10-20-pre-review/`
- 本轮产物为单文件（按用户「输出审查结果 md 文件」指令），内含：基线（§2-3）、评分规则（§4）、测试集（§5）、缺陷（§6）、迭代记录（§7）、执行指标（§5/§10）、验证边界（§9）
- 候选副本：`/tmp/vc-c4`（C1）、`/tmp/vc-c1r4`（C3）、`/tmp/vc-c5`（C4）；变异体：`/tmp/vc-n_life2`、`n_prio2`、`n_refl2`、`n_arch3`、`n_lif8`。均为临时环境，不作交付物。
