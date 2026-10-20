# 基线报告 — Vibe-Coder-Loop 体系

> 本报告由证据驱动审查产出，**未修改任何项目既有文件**。所有结论标注证据强度 [E0–E4]。

## 1. 审查对象标识

| 项 | 值 |
|---|---|
| 仓库 | `<repo>`（本机克隆路径已脱敏） |
| Git commit | `2d2dd92859e0b2c1cb107d785e909fb38111b43d` |
| 主 Skill | `skills/vibe-coder-loop`（manifest version `1.22.1`） |
| 委托 Skill 1 | `skills/delx-memory-protocol`（version `1.2.0`） |
| 委托 Skill 2 | `skills/skill-authoring`（version `1.2.0`） |
| Kernel Prompt | `kernel/Vibe Coder.md`（OpenCode frontmatter） |
| 运行时 | `runtime/core`（状态机/checkpoint/协议一致性 CLI）+ `runtime/exec`（执行与验证 CLI） |
| 评估环境 | macOS, Bash 3.2.57(1) GNU, Python 3.13.3, 无 pytest（用 unittest） |
| 审查日期 | 2026-10-20 |

## 2. 文件清单与关键依赖

- **Skill 文档层**：`skills/vibe-coder-loop/` 下 `kernel.md` + `engine/`(5) + `rules/`(7) + `policy/`(4) + `learning/`(含 `memory/` 5 分片) + `profiles/`(6) + `references/`(7) + `SKILL.md` + `manifest.yaml` + `load_plan.json` + `CHANGELOG.md`(1440 行)。
- **确定性工具层**：`backup/memory_tool.py`（preflight / touch / metrics / artifact / backup·restore·verify·list·check-keys，仅标准库）。
- **运行时层**：`runtime/core/*.py`（state_machine / checkpoint / safemode / recovery / protocol / artifacts / cli 等）、`runtime/exec/*.py`（runner / diff / policy / redact / fingerprint 等）。
- **审计/自检层**：`scripts/audit.sh`(758 行)、`scripts/verify-symlinks.sh`、`skills/*/scripts/smoke-check*.sh`、`scripts/tests/test-audit.sh`。
- **测试层**：`tests/core/`(13 文件)、`tests/exec/`(1 文件)。
- **可选集成**：`delx-memory`（记忆后端）、`codegraph`（已在仓库建 `.codegraph/` 索引）、`skill-authoring`（自检 core）。

## 3. 已执行测试与基线表现

### 3.1 Python 运行时单元测试 — ✅ 通过 [E4]
```
python3 -m unittest discover -s tests -p 'test_*.py'
→ Ran 267 tests in 21.019s  OK
  tests.core: 210 tests (10.46s)
  tests.exec:  57 tests (7.86s)
```

### 3.2 审计工具自测 — ✅ 通过 [E4]
```
bash scripts/tests/test-audit.sh → PASS=43 FAIL=0
```
> ⚠️ 自测使用**合成小仓库**（虚构路径/假凭证），未覆盖真实仓库规模。

### 3.3 软链校验 — ✅ 通过 [E4]
```
bash scripts/verify-symlinks.sh → PASS=15 FAIL=0 WARN=0  结论: 通过
```

### 3.4 协议一致性自检 — ✅ 通过 [E4]
```
python3 -m runtime.core check-protocol
→ {"ok":true,"checks":81,"drifts":[],"unparsed":[]}
```
> runtime 代码表与 Skill 事实源零漂移。

### 3.5 审计扫描 — ✅ 通过（仅 info 级） [E4]
```
bash scripts/audit.sh scan → 退出 0，仅 H002 info（Pi 提及），无高危
```

### 3.6 审计 `check` 子命令 — ❌ 阻断性缺陷 [E4]
```
bash scripts/audit.sh check → Illegal instruction: 4  退出码 132
```
**根因（已隔离复现）**：`check_markdown_links()` 对**每个 markdown 源行**通过嵌套进程替换 `< <(printf '%s\n' "$line" | grep -oE '\]\([^)]+\)')` fork 一个 `grep` 子进程。全仓 63 个 md 文件 / 9408 行 → 约 9408 次 grep fork。实测全仓 `check_markdown_links` 单步耗时 **72 秒**；CHANGELOG.md（1440 行）单独即 >8s。在 macOS Bash 3.2.57 下，密集 fork 压力触发 bash 自身 SIGILL 崩溃（退出 132），对外表现为"命令无法自动退出"（用户实测确认挂起）。
- 子函数级隔离证据：`check_repo_symlinks` / `check_host_links` / `check_tracked_sensitive` 均瞬时返回 `rc=0`；唯 `check_markdown_links` 挂起/崩溃。
- 自测未暴露原因：`test-audit.sh` 的合成仓库仅含个位数 md 行，fork 数 < 10，永不触及性能/崩溃面。

### 3.7 手动 markdown 断链核查 — ✅ 0 断链 [E4]
```
python 脚本复刻 audit 链接逻辑全仓扫描 → broken relative links: 0
```
> 说明 `check_markdown_links` 的**功能正确**，缺陷是性能/稳定性而非逻辑错误。

### 3.8 Skill 规则条目可用性（fail-closed 路径） — ❌ 可操作性缺陷 [E4]
- 本机 live delx-memory DB 含 45 条 `skill:*` / `lesson:*` / `pattern:*` 条目（`memory_tool.py list` 确认）。
- 但 `snapshots/skill_memory_latest.json`（恢复源）被 `.gitignore` 排除（`skills/vibe-coder-loop/backup/snapshots/*`，仅 `.gitignore` 占位被跟踪）。
- **fresh clone 中该快照不存在** → SKILL.md 要求的"新机器克隆后必须 `restore snapshots/skill_memory_latest.json` 恢复 skill:* 条目"在 fresh clone 上**不可执行**。

## 4. 当前工程质量评分（基线）

见 `evaluation-rubric.md`。总分 **62 / 100**（证据覆盖率详述于评分表）。

## 5. 已知缺陷与风险（按严重度）

| ID | 严重度 | 缺陷 | 证据 | 影响 |
|---|---|---|---|---|
| D1 | **Critical** | `audit.sh check` 全仓崩溃/挂起（SIGILL 退出 132 / 72s+ 挂起） | [E4] §3.6 | 发布前检查清单依赖的 `check` 命令在真实仓库不可用；CI/发布门禁失效 |
| D2 | **High** | Skill 完整规则内容（`skill:*` 条目）未纳入版本控制；fresh clone 无法重建规则集 | [E4] §3.8 | 与 README "本仓库是唯一真实源" 声明矛盾；新机器/新贡献者无法获取完整规则，fail-closed 直接停摆 |
| D3 | Medium | `python3 -m runtime.exec` 不可执行（包缺 `__main__.py`） | [E4] | 仅 `python3 -m runtime.exec.cli` 可用；文档/README 若引用 `-m runtime.exec` 会误导 |
| D4 | Medium | `check_markdown_links` 算法复杂度 O(行数 × fork) | [E4] §3.6 | 即便不崩溃，72s 耗时使 `check` 在交互/CI 场景不可用 |
| D5 | Low | 快照文件内嵌作者本机绝对路径 `db: ~/.delx-memory/db.sqlite` | [E2] | 文件 gitignored 故不入库，但作为"恢复源"分发给新机器会泄露本机路径 |
| D6 | Low | `test-audit.sh` 仅覆盖合成小仓库，缺真实规模回归 | [E4] | 审计工具的性能/崩溃面无自动化回归保护 |
| D7 | Info | `.aspirecode/` 大量会话日志存在于工作树 | [E2] | 已 gitignored 不入库，非缺陷；建议确认清理 |

## 6. 当前测试集覆盖范围

- **已覆盖（自动）**：runtime 状态机/checkpoint/safemode/recovery/协议一致性（267 unittest）、审计工具逻辑正确性（43 shell 自测）、软链校验、runtime↔Skill 事实源一致性（check-protocol 81 项）。
- **未覆盖**：Skill **行为层**（Agent 实际按状态机执行任务的轨迹）无自动化测试——状态机/规则是 Markdown 协议，无执行器，只能靠 Agent 真机运行验证；本次未执行真机任务轨迹。
- **未覆盖**：审计工具真实仓库规模回归（D6）。
- **未覆盖**：`skill:*` 规则条目内容与磁盘骨架文件的一致性自动化校验（check-protocol 校验的是 runtime 代码表，非 memory 条目 vs 骨架）。

## 7. 无法可靠测量的指标

- **Skill 执行有效性 / 触发准确性 / 任务成功率 / 规则遵循率**：状态机与规则为 Markdown 协议，依赖宿主 Agent 真机执行；本环境无 Agent 执行器，无法产出任务轨迹证据。这些维度标记**未评估**，不强行给分。
- **压缩后状态延续契约（会话内压缩维度）**：Skill 自身标注 `[Evidence: E2/E3]` 推演 + 盲测，未经真机观测（`state-machine.md` 已诚实声明）。本次同样无法测。
- **Token / 模型调用成本**：无 Agent 执行轨迹，无法测量。
