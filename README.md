# Vibe Kernel

面向 Coding Agent 的轻量级工程执行与持续改进框架。本仓库是约束、Skill 与验证工具的**唯一真实源**，供 OpenCode 等宿主通过 Skill 发现机制加载；不绑定单一宿主，也不要求固定安装目录。

> 状态：开源准备中。许可证尚未声明（需项目所有者决策），因此当前默认保留所有权利，暂不建议直接再分发。

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
│   ├── audit.sh               # 开源就绪性审计工具（只读）
│   ├── verify-symlinks.sh     # 仓库/宿主软链校验
│   └── tests/test-audit.sh    # 审计工具自测
├── docs/
│   ├── installation.md        # 安装、宿主集成、配置
│   ├── migration.md           # 迁移与回滚记录（已脱敏）
│   ├── design/                # MVP 设计文档
│   └── audits/                # 审计报告、兼容矩阵、变更/风险/检查清单
├── .gitattributes
├── .gitignore
└── README.md
```

## 环境要求

| 能力 | 要求 |
|---|---|
| Skill / Prompt 阅读 | 任意支持 Markdown + 文件读取的 Coding Agent |
| OpenCode 主 Agent | OpenCode；`kernel/Vibe Coder.md` 使用 OpenCode frontmatter |
| Shell 工具（审计/自检） | Bash 3.2+；macOS 自带 Bash 可用；Linux 使用 Bash；Windows 使用 Git Bash 或 WSL |
| 记忆工具 / 自检脚本 | Python 3.8+；`memory_tool.py` 仅标准库，完整 smoke-check 另需 PyYAML（缺失时显式跳过 YAML 校验） |
| 可选集成 | `delx-memory`（记忆后端）、`codegraph`（代码图谱）；缺失时对应能力降级，不阻断主流程 |
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

3. 验证：

   ```bash
   bash scripts/verify-symlinks.sh          # 校验仓库内资源
   bash scripts/verify-symlinks.sh --host   # 校验宿主软链接（已安装时）
   bash scripts/audit.sh scan               # 只读扫描公开面
   bash scripts/audit.sh check              # 结构检查（高/严重问题退出码 1）
   ```

## Skills

| Skill | 职责 | 依赖 |
|---|---|---|
| `vibe-coder-loop` | 完整工程循环：Intent → Preflight → Decision → Router → Clarify → Design → Plan → Code → Test → Review → Reflection → Memory Evolution | 文件读取；记忆/CodeGraph 可选 |
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

- 仓库不包含真实凭证；运行状态（`.state.md`）与记忆快照（`backup/snapshots/*`）已被忽略，禁止提交。
- **规则内容不入库**：运行状态、记忆快照与脱敏规则集（`backup/snapshots/*`、`backup/rules/*`）均被忽略。仓库只分发协议骨架，规则内容由本机 delx-memory 生成，跨机器只经安全私有通道传输。
- 示例路径使用 `<repo>`、`/path/to/...`、`$HOME` 或 `%USERPROFILE%`，不依赖作者本机目录。
- 如发现疑似凭证或隐私泄露，请不要在 Issue 中粘贴原文；先脱敏，再联系维护者。
- 许可证与第三方内容授权仍需人工确认；在明确许可证前，请勿将本仓库内容用于再分发。
