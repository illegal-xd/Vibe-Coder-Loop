# Vibe Kernel

面向 Coding Agent 的轻量级工程执行与持续改进框架。本仓库是约束、Skill 与验证工具的**唯一真实源**，供 OpenCode 等宿主通过 Skill 发现机制加载；不绑定单一宿主，也不要求固定安装目录。

> **定位（先读）**：本仓库分发**框架 + 协议骨架**，配套的**私有规则集**（`skill:*` 规则正文）**不在仓库内**——规则由本机 delx-memory 承载，跨机器只经安全私有通道（gzip/JSON 快照，未加密；传输时请自行加密通道）恢复。因此 **fresh clone 不是开箱即用**：未恢复规则集时 Skill **fail-closed**（`[RULE_STORE_MISSING]` 停止；`smoke-check` 以 `MAP_INCONSISTENT` rc=1 退出）——这是**预期行为，不是环境故障**。需要可运行 → 先完成「快速开始」第 3 步。

> 状态：公开分发准备中（框架开源；配套规则集私有）。许可证尚未声明（需项目所有者决策），因此当前默认保留所有权利，暂不建议直接再分发。

## 仓库结构

```text
Vibe-Coder-Loop/
├── kernel/
│   └── Vibe Coder.md          # OpenCode 主 Agent Prompt（其他宿主需适配）
├── skills/
│   ├── vibe-coder-loop/       # 工程 Workflow（状态机/规则/记忆/工具）
│   ├── delx-memory-protocol/  # 通用记忆协议
│   └── skill-authoring/       # Skill 维护协议 + 自检引擎
├── scripts/
│   ├── audit.sh               # 公开面审计工具（只读；含运行状态 gitignore 机检）
│   ├── verify-symlinks.sh     # 仓库/宿主软链校验
│   └── tests/
│       ├── test-audit.sh      # 审计工具自测
│       ├── test-runtime-core.sh
│       └── test-runtime-exec.sh
├── runtime/
│   ├── core/                  # 状态机 / Checkpoint / 协议一致性 CLI
│   └── exec/                  # 受控执行（allowlist / 超时 / 输出截断 / 脱敏）
├── tests/
│   ├── core/                  # runtime/core 单测
│   └── exec/                  # runtime/exec 单测
├── docs/
│   ├── installation.md        # 安装、宿主集成、配置
│   ├── migration.md           # 迁移与回滚记录（已脱敏）
│   ├── design/                # MVP 设计文档
│   └── audits/                # 审计报告、兼容矩阵、变更/风险/检查清单
├── .gitattributes
├── .gitignore
└── README.md
```

> `skills/vibe-coder-loop/` 内部：`kernel.md` `engine/` `rules/` `policy/` `learning/` `profiles/` `references/`（协议分层）+ `scripts/smoke-check.sh`（S13 自检实例）+ `backup/`（记忆工具与**本机生成**的快照/脱敏规则集，均不入库）。

## 环境要求

| 能力 | 要求 |
|---|---|
| Skill / Prompt 阅读 | 任意支持 Markdown + 文件读取的 Coding Agent |
| OpenCode 主 Agent | OpenCode；`kernel/Vibe Coder.md` 使用 OpenCode frontmatter |
| Shell 工具（审计/自检） | Bash 3.2+；macOS 自带 Bash 可用；Linux 使用 Bash；Windows 使用 Git Bash 或 WSL |
| 记忆工具 / 自检脚本 | Python 3.8+；`memory_tool.py` 仅标准库，完整 smoke-check 另需 PyYAML（缺失时显式跳过 YAML 校验） |
| 规则库（**必填**） | `delx-memory` 中的 `skill:*` 规则条目（私有通道恢复）。缺失 → `[RULE_STORE_MISSING]` **停止**，不降级继续 |
| 可选集成 | `delx-memory` 记忆后端（回写/检索/仪表盘）、`codegraph`（代码图谱）；缺失时对应能力标注降级，**不影响规则库的必填性** |
| 不支持 | Windows 原生 CMD / PowerShell 直接执行 `.sh`；请使用 Git Bash/WSL，或用 PowerShell 完成安装步骤 |

完整说明见 [docs/installation.md](docs/installation.md) 与 [docs/audits/compatibility.md](docs/audits/compatibility.md)。

## 快速开始

1. 克隆仓库到任意目录：

   ```bash
   git clone <repo-url> Vibe-Coder-Loop
   cd Vibe-Coder-Loop
   ```

2. 将 Skill 注册到宿主（软链接或复制）。macOS / Linux 示例：

   ```bash
   REPO="$PWD"
   mkdir -p "$HOME/.agents/skills"
   for name in vibe-coder-loop delx-memory-protocol skill-authoring; do
     ln -sfn "$REPO/skills/$name" "$HOME/.agents/skills/$name"
   done
   ```

   OpenCode 用户还需把 `kernel/Vibe Coder.md` 链接到 agents 目录，并把 Skill 暴露到 `~/.config/opencode/skills/`。Windows、PowerShell、复制方式与卸载步骤见 [docs/installation.md](docs/installation.md)。

3. **恢复私有规则集（必做，否则 Skill fail-closed 停止）**：`rules/` 等目录只有骨架版，完整规则正文在 delx-memory 的 `skill:*` 条目中：

   ```bash
   cd skills/vibe-coder-loop
   python3 backup/memory_tool.py restore <私有规则快照路径>   # gzip/JSON 快照，经私有通道获取（未加密）
   python3 backup/memory_tool.py verify <私有规则快照路径>    # 校验条目完整性
   bash scripts/smoke-check.sh --table                       # 含 SKILL 声明 key 的存在性校验（4b）
   ```

   无规则快照 → 无法启动 Workflow（`[RULE_STORE_MISSING]`）；这不是环境问题，是**定位**（见上方「定位（先读）」）。

4. 验证：

   ```bash
   bash scripts/verify-symlinks.sh          # 校验仓库内资源
   bash scripts/verify-symlinks.sh --host   # 校验宿主软链接（已安装时）
   bash scripts/audit.sh scan               # 只读扫描公开面
   bash scripts/audit.sh check              # 结构检查（高/严重问题退出码 1）
   ```

## Skills

| Skill | 职责 | 依赖 |
|---|---|---|
| `vibe-coder-loop` | 完整工程循环：Intent → Preflight → Decision → Router → Clarify → Design → Plan → Code → Test → Review → Reflection → Memory Evolution | 文件读取；**私有规则集（必填）**；记忆后端/CodeGraph 可选 |
| `delx-memory-protocol` | 记忆授权模型、三层体系、命名空间、TTL、supersession、Consolidation | 无运行时数据 |
| `skill-authoring` | 骨架化、canonical source 分类、内容下沉、残留验证 | 自检脚本需要 Bash + Python 3（完整检查） |

Kernel Prompt 只负责身份、安全与调度，不复制 Skill 内部流程。三者均不要求固定绝对路径；发现机制优先，`$HOME/.agents/skills/...` 仅作兜底。

## 配置

| 变量 | 用途 | 缺省 |
|---|---|---|
| `DELX_MEMORY_DB` | delx-memory SQLite 路径 | 自动探测 `~/.delx-memory/db.sqlite`（Windows 使用 `%USERPROFILE%`） |
| `VIBE_LOOP_ARTIFACTS_DIR` | 结果外置目录 | `~/.vibe-loop/artifacts/<workspace-hash>/` |
| `SMOKE_CORE` | 指定 `smoke-check-core.sh` 路径 | 同仓库相对路径优先 |
| `AGENTS_SKILLS_DIR` | 安装/校验时覆盖 `~/.agents/skills` | `$HOME/.agents/skills` |
| `OPENCODE_SKILLS_DIR` | 安装/校验时覆盖 OpenCode skills 目录 | `$HOME/.config/opencode/skills` |
| `OPENCODE_AGENTS_DIR` | 安装/校验时覆盖 OpenCode agents 目录 | `$HOME/.config/opencode/agents` |

`skills/vibe-coder-loop/backup/config.json` 默认 `db_path` 为空，表示自动探测；需要时也可直接填写本机路径（不要提交个人路径）。

## 审计与验证

`scripts/audit.sh` 默认只读，不访问网络，不修改文件：

```bash
bash scripts/audit.sh scan                    # TSV: path:line:rule:severity:reason
bash scripts/audit.sh scan --format=json      # JSONL
bash scripts/audit.sh scan --all              # 额外包含 .gitignore 忽略的文件
bash scripts/audit.sh check                   # 软链/断链/Markdown 链接/跟踪敏感文件
bash scripts/audit.sh report                  # 生成 docs/audits/scan-report.md
bash scripts/audit.sh verify -b docs/audits/baseline.tsv  # 与基线比对；新增 Critical/High 退出 1
bash scripts/tests/test-audit.sh              # 工具自测（使用虚构路径/假凭证）
```

规则、退出码、已知误报与限制见 [docs/audits/audit-tool.md](docs/audits/audit-tool.md)。发布前流程见 [docs/audits/release-checklist.md](docs/audits/release-checklist.md)。

## 文档

- [安装与宿主集成](docs/installation.md)
- [跨平台兼容矩阵](docs/audits/compatibility.md)
- [审计报告（2026-10-19）](docs/audits/2026-10-19-open-source-readiness.md)
- [变更清单](docs/audits/change-list.md)
- [遗留风险](docs/audits/residual-risks.md)
- [发布前检查清单](docs/audits/release-checklist.md)
- [审计工具说明](docs/audits/audit-tool.md)

## 安全与隐私

- 仓库不包含真实凭证；**Workflow Checkpoint 存 delx-memory**（key `vc:checkpoint:<项目绝对地址>`，L0 独立 tag），项目目录不落状态文件；legacy `.vibe-kernel/` 与记忆快照（`backup/snapshots/*`）已被忽略，禁止提交。
- `runtime/exec` 是**防手滑**，不是权限沙箱：allowlist 只拦截显式的危险命令（`rm -rf`、`git push` 等）；`python3 -c`、`npm` 脚本等仍可执行任意操作。不要把 exec 当作对抗性隔离边界，不可逆操作仍须走 `policy/safety.md` 的 Conflict Card 仲裁。
- **机检兜底**：`bash scripts/audit.sh check` 的 **C012** 检查「Checkpoint 存储契约」——协议必须声明 delx-memory key 前缀 `vc:checkpoint:`，且 runtime 不得创建项目内状态目录，防止协议与实现各写一套。
- **规则内容不入库**：运行状态、记忆快照与脱敏规则集（`backup/snapshots/*`、`backup/rules/*`）均被忽略。仓库只分发协议骨架，规则内容由本机 delx-memory 生成，跨机器只经安全私有通道传输。
- 示例路径使用 `<repo>`、`/path/to/...`、`$HOME` 或 `%USERPROFILE%`，不依赖作者本机目录。
- 如发现疑似凭证或隐私泄露，请不要在 Issue 中粘贴原文；先脱敏，再联系维护者。
- 许可证与第三方内容授权仍需人工确认；在明确许可证前，请勿将本仓库内容用于再分发。
