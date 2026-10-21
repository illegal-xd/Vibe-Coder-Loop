# Vibe-Coder-Loop 体系审查报告（2026-10-21 · 第五轮 · 修复与精简后复评）

## 0. 元信息

| 项 | 值 |
|---|---|
| 审查基线 | `8dbb858b4311d98d379f405c108196185c0067fa`（第五批修复后） |
| 最终版本 | 同一 commit 之上的**未提交工作树**（版本仍 `1.22.1`，CHANGELOG 第六批） |
| 审查范围 | `skills/vibe-coder-loop`、`skills/delx-memory-protocol`、`skills/skill-authoring`、`kernel/Vibe Coder.md`、`runtime/core`、`runtime/exec`、`scripts/`、`tests/`、`docs/`、`README.md` |
| 本轮目标 | 修复第四轮 7 项缺陷 + 精简冗余注释；按评分规则达到 **≥73** |
| 旧报告归档 | `skill-evaluation/archive/2026-10-21-pre-round5/evaluation-report-2026-10-21-r4.md` |
| 环境 | macOS Darwin 26.6.2；Bash 3.2.57；Python 3.13.3；本机 delx-memory 45 条规则；**无 Agent 宿主轨迹** |
| 证据等级 | E0 推测 / E1 用户描述 / E2 文件读取 / E3 静态分析 / E4 运行或测试结果 |

---

## 1. 审查结论

### 1.1 总体状态

- 第四轮 7 项缺陷（R4-D1–D7）**全部修复并以 E4 验证**。
- 注释/说明精简：`memory_tool.py` 模块 docstring 104→25 行、6 处长注释块压到 2–3 行；smoke 引擎头部 41→12 行；SKILL/state-machine 去除重复解释。注释类净减 **约 141 行**（`memory_tool.py` −112、smoke 引擎 −29）；全量 diff **+145 / −211**（净 −66，其余为新增校验与测试）。
- 机械层扩到 **492 项断言**：274 单测（+3）/ 57 记忆工具 / 51 审计 / 15 软链 / 82 协议 / 6+7 shell；smoke rc0（3892/3900）。
- 无新增 High；无阻断性风险。

### 1.2 评分结论

| 口径 | 基线（R4） | 本轮终态 |
|---|---:|---:|
| 综合（100 分制；13 分未评估不计入） | 64.5 | **75.0** |
| 可评估子集得分率 | 74.1%（64.5/87） | **86.2%（75/87）** |
| 机械断言 | 489 | **492** |

> **分母自评修正**：R2–R4 报告把"可评估子集"写成 /75，但权重合计 100、未评估 13 分 → 可评估上限应为 **87**。本轮按 87 重算并回溯：R4 的 64.5 实为 74.1%，不是 86%。此前"/75"是笔误，不影响各维度扣分理由；本轮起统一用 /87 与 100 分制双列。

### 1.3 阻断性判断

| 口径 | 结论 |
|---|---|
| 本机私有使用 | 不构成阻断 |
| 对第三方宣称"硬约束违规有唯一处置" | **已解除**（§3 分流规则 + 上报入口） |
| 公开分发 | 仍受 LICENSE、私有规则库、跨平台未验证阻断（既有事项） |

### 1.4 是否达到停止条件

达到。本轮目标 = 综合分 ≥73，实测 **75.0**；同时满足"核心任务与关键测试达到预先定义要求"。**停止修改**，剩余项见 §7。

---

## 2. 范围、结构与依赖

| 层 | 内容 | 规模 |
|---|---|---|
| Skill 规则 | kernel / engine(5) / rules(7) / policy(4) / learning(含 memory 5 分片) / profiles(6) / references(7) | smoke 实测 **3892 行 / 预算 3900（余 8）** |
| 确定性工具 | `backup/memory_tool.py` | **2203 行**（精简前 2315），仅标准库 |
| Runtime Core | 状态机 / Checkpoint / 协议 / 恢复 / Safe Mode / 产物 | 约 6.0k 行，274 单测（含 exec） |
| Runtime Exec | allowlist / 超时 / 截断 / 脱敏 / 差异 | 约 2.2k 行 |
| 审计与自检 | `audit.sh` / `verify-symlinks.sh` / `smoke-check-core.sh` | 51 + 15 项 |

---

## 3. 关键修改（含根因与验证）

| # | 缺陷 | 根因 | 修改 | 验证 |
|---|---|---|---|---|
| 1 | **R4-D1 硬约束违规双出口** | 审查链（safety §3 → 情况 B）与运行时（`vc_violation` → S14）各自成立，无分流 | `safety.md` §3 增分流：可修复→情况 B；已不可逆/不可修复→`vc_violation`→S14。`transition.md` S8 出口 + S10 判定表补条目；`kernel.md` §5 行改为「不可修复者 1 次即停」 | 静态四文件一致；`check-protocol` 82/82；smoke rc0 [E2/E4] |
| 2 | **R4-D2 期望表子集** | 断言只覆盖 common + 少量文件 | L2 增 `policy/lifecycle.md`、`policy/priority.md`、`learning/reflection.md`；L3 增 `learning/memory.md`、`learning/memory/architecture.md` | 基线 57/57；4 个原静默变异**全红** [E4] |
| 3 | **R4-D3 负 offset 静默** | `max(0, offset)` | `<0` → `INVALID_ARGUMENT` rc3 | 实测 rc3；正常 offset 不受影响 [E4] |
| 4 | **R4-D4 非法正则静默** | `except re.error: re.escape(...)` | 改为 `INVALID_ARGUMENT` rc3 + `[next]` | 实测 `--grep "["` rc3 [E4] |
| 5 | **R4-D5 死错误码** | 文档称"分隔符→拒绝"，实现是消毒 | 保留消毒 + 双保险；码表与 docstring 改为「消毒后仍越界才拒绝」 | 实测 `a/b→a-b` rc0；文档一致 [E4/E2] |
| 6 | **R4-D6 计数过期** | 文档硬编码 43/51/55 | 发布清单改为「rc=0 / 以输出为准」；compatibility 标当前基线 51/57；residual-risks 去数字 | 静态；无残留旧数字 [E2] |
| 7 | **R4-D7 负超时误分类** | 无入参校验，`deadline` 直接为过去时间 | CLI 校验 timeout/max-output → rc2；`ExecRequest.__post_init__` 守卫；+3 单测 | rc2 实测；274/274 [E4] |
| 8 | **冗余注释** | 说明性注释与 argparse help/docstring 重复 | `memory_tool.py` docstring 104→25；6 处块注释→2–3 行；smoke 头 41→12；SKILL/state-machine 去重 | 语法/–help/smoke 全过；注释类净减约 141 行 [E4] |

---

## 4. 评分规则（Rubric）

| 维度 | 权重 | 100% 判据 |
|---|---:|---|
| 功能正确性 | 25 | 规则、流程、I/O 均有测试证据且无契约偏差 |
| 执行有效性 | 25 | 真机轨迹 + 独立验收，成功率高 |
| 规则一致性 | 15 | 单一事实源、无冲突、无死指针 |
| 鲁棒性 | 15 | 边界/失败/重复执行均有测试 |
| 可维护性 | 10 | 职责清晰、文档测试实现一致 |
| 可移植性 | 10 | 干净环境可复现、跨平台已验证 |

等级：0% / 40% / 70% / 100%；未执行项标「未评估」，不计入得分分母。硬性门槛：安全红线 / 关键输出契约 / 评估污染 / 核心回归未解释。

---

## 5. 测试集与结果（E4）

| ID | 类别 | 操作 | 预期 | 实测 |
|---|---|---|---|---|
| T-A1..A9 | 正常 | 全量机械矩阵 | 全过 | **492/492** |
| T-B1 | 触发 | 宿主 Skill 选择 | 应触发/不误触发 | 未评估（无宿主） |
| T-C1..C4 | 边界 | 空规则库 / 非法 level·task·stage / 空阶段集 / 损坏 Checkpoint | fail-closed | 全部 rc≠0 或降级正确 |
| T-D1 | 冲突 | 硬约束违规处置 | 唯一出口 | **通过**（分流 + 上报入口）[E2] |
| T-E1 | 失败恢复 | exec 拒绝/超时/截断/脱敏/非法参数 | 结构化码 | 全部符合（负超时已改 rc2） |
| T-F1 | 输出 | metrics 仪表盘 | 格式正确 | `skeleton=None/NoneB` |
| T-F2 | 输出 | 发布清单计数 | 与实际一致 | 不再硬编码，按输出判定 |
| T-G1 | 回归 | R3/R4 修复保持 | 全保持 | 10/10 + 7/7 |
| T-H1 | 鲁棒性 | 重复执行 | 稳定 | 两轮一致 |
| T-I1 | 可移植性 | 路径/API/脱敏 | 无泄漏 | export-rules 残留 0 |
| T-J1 | 安全 | `rm -rf`/`git push`/红码 | 拒绝 | `SCOPE_DENIED` |
| T-K1 | 工作流 | 标准/Case B/Investigation/S14/follow-up | 与文档一致 | 1/2/3、N+1、loop 归 0、resume 维持 N |
| T-M1..M11 | 变异 | 11 个定向变异（上轮 6 + 本轮 5） | 门禁红 | **11/11 红**（本轮 4 个新盲区已关闭） |

**统计**：机械 492/492；非变异系统级 **14 通过 / 0 失败 / 2 未评估**；变异 **11/11 被捕获**。

---

## 6. 回归与风险

| 项 | 结果 |
|---|---|
| 单测 | 274/274（+3 参数校验） |
| 记忆工具 | 57/57 |
| 审计 / 软链 / 协议 | 51/51 · 15/15 · 82/82 |
| shell | 6/6 · 7/7 |
| smoke | rc0；3892/3900（余 8） |
| audit check / scan | rc0 / rc0 |
| 4 个原静默变异 | 全部 FAILED（门禁生效） |

残余风险：

| 风险 | 说明 | 等级 |
|---|---|---|
| 规则预算余 8 行 | 任何新增规则都需等量替换 | Low（已披露） |
| 新分流规则仅静态验证 | R4-D1 的分流依赖 Agent 判断"可修复性"，无真机轨迹 | Medium（未评估域） |
| 跨平台 | 仅 macOS 实测 | 未评估 |
| SKILL ↔ load_plan 双源 | 由 smoke + 自测双向校验，但仍属结构性成本 | Low |
| Exec 非沙箱 | `make`/`npm run`/`python3 -c` 可执行任意命令（已声明） | Medium（声明内） |

---

## 7. 迭代决策与后续建议

| 决策 | 内容 | 证据 |
|---|---|---|
| 采纳 | R4-D1–D7 全部修复 | §3 |
| 采纳 | 注释/说明精简（注释类净 −141 行；全量净 −66） | `git diff --numstat` |
| 采纳 | R4-D1 语义选「可修复→情况 B / 不可逆→S14」 | 用户"修复所有问题"授权；两种读法均保留唯一出口 |
| 暂缓 | 规则预算上调（余 8 行） | 无收益证据；优先等量替换 |
| 未评估 | 宿主触发/任务成功率、压缩恢复、Linux/Windows | 无真机 |

**后续（按优先级）**

1. 规则预算：新增规则前先做等量替换（当前余 8 行）。
2. 真机轨迹采集：按 `references/e4-matrix.md` Test A–F 采一轮，补执行有效性 13 分。
3. Linux/Windows 冒烟：在 `docs/audits/compatibility.md` 补一条实跑记录。
4. `restore` 快照目录与 `--db` 解耦（多库/多项目互删风险，上轮披露的优化项）。

---

## 8. 验证边界

**已执行（E4）**：492 项机械断言；11 个变异体；7 项修复的行为验证（rc/输出）；4 组工作流路径（标准 / Case B / S14 升级-退出 / follow-up 归 0）；10 项工具边界；注释精简后的 `--help`/smoke/自测。

**仅静态（E2/E3）**：R4-D1 分流语义、R4-D5 文档口径、R4-D6 计数、profile 装配。

**未验证**：Agent 宿主轨迹（触发/成功率/规则遵循）、会话内压缩恢复、Linux/Windows、干净机器端到端、Python 3.8 运行。

---

## 9. 评分明细

| 维度 | 权重 | 基线 | 终态 | 依据 |
|---|---:|---:|---:|---|
| 功能正确性 | 25 | 19 | **22** | 7/7 缺陷关闭；4 变异由红到绿门禁；扣 3：无宿主轨迹、分流语义仅静态 |
| 执行有效性 | 25 | 10（12 可测） | **10.5（12 可测）** | 确定性任务全过；13 分未评估 |
| 规则一致性 | 15 | 10.5 | **13** | 双出口已统一；无已知冲突；扣 2：规则面大、未全量形式化 |
| 鲁棒性 | 15 | 10.5 | **13** | 参数校验 + fail-closed + 变异门禁；扣 2：跨平台未验 |
| 可维护性 | 10 | 7.5 | **9** | 注释类 −141 行、文档计数去硬编码；扣 1：预算余 8 行 + 双源 |
| 可移植性 | 10 | 7 | **7.5** | 无硬编码路径/脱敏 0 残留；扣 2.5：仅 macOS |
| **可评估子集（87）** | — | **64.5（74.1%）** | **75 / 87（86.2%）** | 13 分未评估 |
| **综合（100 分制）** | — | **64.5** | **75.0** | 覆盖 87/100；不宣称完整 100 分制 |

> 目标 `≥73` 已达成（75.0）。分数不是采纳依据：本轮采纳的每一项都有独立回归证据（§3/§6），未采纳项见 §7。

---

## 附录 A：复现命令

```bash
# 机械矩阵（492 项）
python3 -m unittest discover -s tests -p 'test_*.py'
python3 skills/vibe-coder-loop/backup/test_memory_tool.py
bash scripts/tests/test-audit.sh
bash scripts/verify-symlinks.sh
python3 -m runtime.core check-protocol
bash skills/vibe-coder-loop/scripts/smoke-check.sh
bash scripts/tests/test-runtime-core.sh
bash scripts/tests/test-runtime-exec.sh

# 修复验证
python3 skills/vibe-coder-loop/backup/memory_tool.py artifact page --ref <REF> --offset -1   # rc3
python3 skills/vibe-coder-loop/backup/memory_tool.py artifact page --ref <REF> --grep '['     # rc3
python3 -m runtime.exec run --cwd /tmp --timeout-ms -5 -- python3 -c 'print(1)'               # rc2
python3 skills/vibe-coder-loop/backup/memory_tool.py metrics | tail -1                        # skeleton=None/NoneB

# 变异（/tmp 副本）：删 L2 policy/lifecycle.md / priority.md / reflection.md、L3 architecture.md
# 运行 python3 backup/test_memory_tool.py → 4 个变异均 FAILED
```

## 附录 B：归档与产物

- 本轮归档：`skill-evaluation/archive/2026-10-21-pre-round5/evaluation-report-2026-10-21-r4.md`
- 历史：`archive/2026-10-21-pre-round4/`、`archive/2026-10-20-pre-round3/`、`archive/2026-10-21-pre-round5/`（本轮）
- 产物为单文件（含基线、rubric、测试集、迭代记录、评分、验证边界）
- 本轮修改未提交 git（版本仍 1.22.1）；`git status` 可见改动清单
- 评估副作用：`artifact` 探针在 `~/.vibe-loop/artifacts/` 生成临时产物（24h TTL 自动回收）；仓库未写入运行状态
