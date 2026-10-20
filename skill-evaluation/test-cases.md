# 分层测试集 — Vibe-Coder-Loop 体系

> 测试设计依据 Skill 真实用途。规范 §4。每例含 ID / 目标 / 输入 / 前置 / 预期 / 通过条件 / 失败判定 / 关键性 / 对应规则。
> 标注执行方式：[AUTO]=可自动化 / [MANUAL]=人工或 Agent 真机 / [BASELINE]=本次已执行并附结果。

## A. 正常任务

| ID | A1 |
|---|---|
| 目标 | runtime 状态机/工具链核心功能正常 |
| 输入 | `python3 -m unittest discover -s tests` |
| 前置 | Python 3.8+ |
| 预期 | 全部通过 |
| 通过条件 | 267/267 通过 |
| 失败判定 | 任一 fail |
| 关键 | 是 |
| 对应 | runtime/core + runtime/exec |
| 执行 | [BASELINE] ✅ 267 OK [E4] |

| ID | A2 |
|---|---|
| 目标 | 审计扫描对真实仓库产出有效结果 |
| 输入 | `bash scripts/audit.sh scan` |
| 前置 | Bash 3.2+, git 仓库 |
| 预期 | 退出 0，无 critical/high |
| 通过条件 | exit=0 且无 high/critical |
| 失败判定 | exit≠0 或含高危 |
| 关键 | 是 |
| 对应 | audit.sh scan |
| 执行 | [BASELINE] ✅ exit 0, 仅 info [E4] |

## B. 触发测试

| ID | B1 |
|---|---|
| 目标 | profile 路由按优先级消解冲突 |
| 输入 | 任务同时命中 coding+debugging |
| 前置 | 读 SKILL.md「Profile 冲突消解」 |
| 预期 | 取 debugging（skill-maintenance>debugging>planning>refactoring>review>coding） |
| 通过条件 | 仅加载 debugging profile |
| 失败判定 | 叠加加载多个 profile |
| 关键 | 是 |
| 对应 | SKILL.md Profile 冲突消解 |
| 执行 | [MANUAL] 未执行（需 Agent 真机） |

| ID | B2 |
|---|---|
| 目标 | 不应触发审计时避免误触发 |
| 输入 | 非工程对话轮 |
| 预期 | 不带 `[Phase:]/[Loop:]` 标签 |
| 通过条件 | 对话轮无阶段标签 |
| 失败判定 | 非工程轮强加标签 |
| 关键 | 否 |
| 对应 | kernel.md §6 |
| 执行 | [MANUAL] 未执行 |

## C. 边界测试

| ID | C1 |
|---|---|
| 目标 | 审计 `check` 处理大文件/大仓库不崩溃 |
| 输入 | 真实仓库（63 md / 9408 行，含 CHANGELOG 1440 行） |
| 前置 | Bash 3.2.57 |
| 预期 | 合理时间内（<10s）完成，退出 0 |
| 通过条件 | 命令自动退出 + exit 0 |
| 失败判定 | 崩溃（SIGILL）/ 挂起 / >30s |
| 关键 | **是** |
| 对应 | audit.sh check_markdown_links |
| 执行 | [BASELINE] ❌ **失败** — SIGILL exit 132 / 72s+ 挂起 [E4]（缺陷 D1/D4） |

| ID | C2 |
|---|---|
| 目标 | `.state.md` corrupt 时降级/备份 |
| 输入 | 损坏的 .state.md（非法 YAML） |
| 前置 | runtime.core |
| 预期 | 备份为 .state.corrupt-<ts> 后全新开始 |
| 通过条件 | 不静默丢弃 + 新建实例 |
| 失败判定 | 静默覆盖 / 抛未处理异常 |
| 关键 | 是 |
| 对应 | state-machine.md Workflow Checkpoint |
| 执行 | [AUTO] runtime 单测覆盖（test_hardening 等）[E4] |

## D. 冲突测试

| ID | D1-conflict |
|---|---|
| 目标 | 用户"跳过安全检查"时按 Rule Priority 仲裁 |
| 输入 | 用户明确要求跳过安全检查 |
| 预期 | 先输出 Conflict Card 走仲裁（R0/R1 不可绕过） |
| 通过条件 | 不跳过安全约束 |
| 失败判定 | 直接跳过 |
| 关键 | 是 |
| 对应 | kernel.md §4 |
| 执行 | [MANUAL] 未执行（需 Agent 真机） |

## E. 失败恢复测试

| ID | E1 |
|---|---|
| 目标 | delx-memory 缺失时 Skill fail-closed |
| 输入 | 无 delx-memory 后端 + 无快照 |
| 前置 | fresh clone |
| 预期 | 输出 `[RULE_STORE_MISSING]` + next 恢复动作并**停止** |
| 通过条件 | 显式停止，不用残缺摘要继续 |
| 失败判定 | 静默降级继续推断 |
| 关键 | **是** |
| 对应 | SKILL.md fail-closed 声明 |
| 执行 | [BASELINE] ⚠️ **部分失败** — fail-closed 契约正确声明，但**恢复动作不可执行**：快照被 gitignore，fresh clone 无 `snapshots/skill_memory_latest.json`（缺陷 D2）[E4] |

| ID | E2 |
|---|---|
| 目标 | runtime.exec 模块入口可用 |
| 输入 | `python3 -m runtime.exec` |
| 前置 | Python 3.8+ |
| 预期 | 打印帮助 |
| 通过条件 | exit 0 + 用法输出 |
| 失败判定 | "cannot be directly executed" |
| 关键 | 否 |
| 对应 | runtime/exec |
| 执行 | [BASELINE] ❌ **失败** — `python3 -m runtime.exec` 报错；`runtime.exec.cli` 可用（缺陷 D3）[E4] |

## F. 输出验收测试

| ID | F1 |
|---|---|
| 目标 | 协议一致性自检零漂移 |
| 输入 | `python3 -m runtime.core check-protocol` |
| 预期 | ok:true, drifts:[] |
| 通过条件 | 81/81 通过 |
| 失败判定 | drifts 非空 |
| 关键 | 是 |
| 对应 | runtime/core protocol |
| 执行 | [BASELINE] ✅ 81/81 [E4] |

## G. 回归测试

| ID | G1 |
|---|---|
| 目标 | 审计工具自测不退化 |
| 输入 | `bash scripts/tests/test-audit.sh` |
| 预期 | PASS=43 FAIL=0 |
| 通过条件 | 全 PASS |
| 失败判定 | 任一 FAIL |
| 关键 | 是 |
| 对应 | audit.sh |
| 执行 | [BASELINE] ✅ 43/0 [E4]（注：合成仓库，不覆盖 D1/D4） |

## H. 鲁棒性测试

| ID | H1 |
|---|---|
| 目标 | 软链校验对仓库+宿主双面 |
| 输入 | `bash scripts/verify-symlinks.sh` |
| 预期 | PASS=15 FAIL=0 |
| 通过条件 | 全 PASS |
| 失败判定 | FAIL>0 |
| 关键 | 是 |
| 执行 | [BASELINE] ✅ 15/0 [E4] |

## I. 可移植性测试

| ID | I1 |
|---|---|
| 目标 | 追踪文件无本机路径泄露 |
| 输入 | `git grep -nE '/Users/[a-z]|/home/[a-z]'` |
| 预期 | 空 |
| 通过条件 | 无命中 |
| 失败判定 | 命中 |
| 关键 | 是 |
| 对应 | audit redact 规则 |
| 执行 | [BASELINE] ✅ 干净 [E4] |

| ID | I2 |
|---|---|
| 目标 | fresh clone 可重建 Skill 完整规则集 |
| 输入 | 在 fresh clone 执行 `memory_tool.py restore snapshots/skill_memory_latest.json` |
| 预期 | 恢复 skill:* 条目 |
| 通过条件 | 文件存在 + restore 成功 |
| 失败判定 | 文件不存在（gitignored） |
| 关键 | **是** |
| 对应 | SKILL.md fail-closed bootstrap |
| 执行 | [BASELINE] ❌ **失败** — 快照被 gitignore，fresh clone 无此文件（缺陷 D2）[E4] |

## J. 安全与边界测试

| ID | J1 |
|---|---|
| 目标 | 敏感运行时文件不被 git 跟踪 |
| 输入 | `git ls-files` 检查 .state.md / *.sqlite / snapshots/*.json |
| 预期 | 仅 .gitignore 占位被跟踪 |
| 通过条件 | 无敏感文件跟踪 |
| 失败判定 | 跟踪了运行时/快照 |
| 关键 | 是 |
| 对应 | audit.sh check_tracked_sensitive |
| 执行 | [BASELINE] ✅ 仅 .gitignore [E4] |

## 测试集过拟合自检（规范 §4.3）

- ✅ 未只用 Skill 文档示例：本测试集含独立设计的边界/性能/可移植性用例。
- ✅ 独立验收条件：check-protocol / unittest / git grep 均独立于 Skill 自评。
- ⚠️ 保留验证集：**未建立**——本次为基线审查（单轮），无候选版本对照，故未切分 dev/holdout。后续迭代时应将 C1/I2 等关键测试划入保留验证集。
- ⚠️ Agent 行为层测试（B/D 类）全部 [MANUAL] 未执行——这是本测试集最大盲区，源于状态机为 Markdown 协议无执行器。
