# 迁移与宿主集成记录（脱敏）

**日期**：2026-10-19

**性质**：从个人私有知识库迁移到本仓库的历史记录。为避免公开泄露，源路径、用户名和私人目录均已替换为占位符。当前安装方式见 [installation.md](installation.md)。

## 一、迁移映射

| 资源 | 源（占位） | 目标（本仓库） | 说明 |
|---|---|---|---|
| Agent Prompt | `<old-source>/agents/Vibe Coder.md` | `kernel/Vibe Coder.md` | 内容一致 |
| Skill: vibe-coder-loop | `<old-source>/skills/vibe-coder-loop/` | `skills/vibe-coder-loop/` | 排除 `__pycache__` / `.DS_Store` 等机器缓存 |
| Skill: delx-memory-protocol | `<old-source>/skills/delx-memory-protocol/` | `skills/delx-memory-protocol/` | 内容一致 |
| Skill: skill-authoring | `<old-source>/skills/skill-authoring/` | `skills/skill-authoring/` | 内容一致 |

迁移时保留了本机运行状态与历史快照，但它们属于个人实例数据：

- `skills/vibe-coder-loop/.state.md` —— Workflow 运行状态，**不进入版本库**；公共模板为 `.state.template.md`。
- `skills/vibe-coder-loop/backup/snapshots/*` —— 本机记忆快照，**不进入版本库**；需要迁移时通过安全私有通道传输。
- `skills/vibe-coder-loop/backup/rules/*` —— 本机生成的脱敏规则集（`export-rules`），**同样不进入版本库**：规则内容按隐私约束不外发，跨机器只经安全私有通道传输。

源目录未被删除；本仓库成为唯一运行源后，旧副本不再被软链引用。

## 二、宿主发现约定

本仓库不假设固定安装目录。推荐两种方式：

1. **软链接（macOS / Linux，或 Windows Git Bash）**：把 Skill 目录链接到宿主发现目录。
2. **复制（Windows 原生 / 无符号链接权限）**：复制到宿主的 skills 目录；升级时重新复制。

常见 OpenCode 约定（仅适用于 OpenCode；其他宿主使用其等价发现机制）：

| 入口 | 目标 |
|---|---|
| `~/.agents/skills/<name>` | `<repo>/skills/<name>` |
| `~/.config/opencode/skills/<name>` | `~/.agents/skills/<name>`（或直接指向 `<repo>/skills/<name>`） |
| `~/.config/opencode/agents/Vibe Coder.md` | `<repo>/kernel/Vibe Coder.md` |

macOS / Linux（POSIX Shell）：

```bash
REPO="/path/to/Vibe-Coder-Loop"
mkdir -p "$HOME/.agents/skills" "$HOME/.config/opencode/skills" "$HOME/.config/opencode/agents"
ln -sfn "$REPO/skills/vibe-coder-loop" "$HOME/.agents/skills/vibe-coder-loop"
ln -sfn "$REPO/skills/delx-memory-protocol" "$HOME/.agents/skills/delx-memory-protocol"
ln -sfn "$REPO/skills/skill-authoring" "$HOME/.agents/skills/skill-authoring"
ln -sfn "$HOME/.agents/skills/vibe-coder-loop" "$HOME/.config/opencode/skills/vibe-coder-loop"
ln -sfn "$HOME/.agents/skills/delx-memory-protocol" "$HOME/.config/opencode/skills/delx-memory-protocol"
ln -sfn "$HOME/.agents/skills/skill-authoring" "$HOME/.config/opencode/skills/skill-authoring"
ln -sfn "$REPO/kernel/Vibe Coder.md" "$HOME/.config/opencode/agents/Vibe Coder.md"
```

Windows PowerShell（需启用 Developer Mode 或以管理员身份运行；无权限时改用复制）：

```powershell
$Repo = "C:\path\to\Vibe-Coder-Loop"
$AgentsSkills = Join-Path $HOME ".agents\skills"
$OpenCodeSkills = Join-Path $HOME ".config\opencode\skills"
$OpenCodeAgents = Join-Path $HOME ".config\opencode\agents"
New-Item -ItemType Directory -Force -Path $AgentsSkills, $OpenCodeSkills, $OpenCodeAgents | Out-Null
New-Item -ItemType SymbolicLink -Force -Path (Join-Path $AgentsSkills "vibe-coder-loop") -Target (Join-Path $Repo "skills\vibe-coder-loop")
New-Item -ItemType SymbolicLink -Force -Path (Join-Path $AgentsSkills "delx-memory-protocol") -Target (Join-Path $Repo "skills\delx-memory-protocol")
New-Item -ItemType SymbolicLink -Force -Path (Join-Path $AgentsSkills "skill-authoring") -Target (Join-Path $Repo "skills\skill-authoring")
New-Item -ItemType SymbolicLink -Force -Path (Join-Path $OpenCodeAgents "Vibe Coder.md") -Target (Join-Path $Repo "kernel\Vibe Coder.md")
```

Windows 原生 CMD 不推荐；若使用 Git Bash / WSL，可直接使用上面的 POSIX 命令。

## 三、卸载 / 回滚

软链方式：

```bash
rm -f "$HOME/.config/opencode/agents/Vibe Coder.md"
rm -f "$HOME/.config/opencode/skills/vibe-coder-loop" \
      "$HOME/.config/opencode/skills/delx-memory-protocol" \
      "$HOME/.config/opencode/skills/skill-authoring"
rm -f "$HOME/.agents/skills/vibe-coder-loop" \
      "$HOME/.agents/skills/delx-memory-protocol" \
      "$HOME/.agents/skills/skill-authoring"
```

复制方式：删除宿主目录中对应的副本即可。回滚到迁移前的私有源，请用你自己的旧源路径替换 `<old-source>`；本仓库不保存该路径。

## 四、内部引用分析（迁移时）

- `skills/vibe-coder-loop/scripts/smoke-check.sh` 与 `skills/skill-authoring/scripts/smoke-check*.sh` 优先使用同仓库相对路径定位 `smoke-check-core.sh`；`$HOME/.agents/skills/...` 仅作兜底，可用 `SMOKE_CORE` 覆盖。
- `kernel/Vibe Coder.md` 的兜底加载改为用户主目录表达，不再包含个人绝对路径。
- `backup/memory_tool.py` 的数据库路径优先级为 `--db` > `DELX_MEMORY_DB` > `backup/config.json` > 自动探测。

## 五、历史与发布注意

迁移提交曾包含个人运行状态与记忆快照。即使当前已取消跟踪，**Git 历史仍可能保留这些内容**。发布前必须由项目所有者决定：

- 重写历史（例如 `git filter-repo`，需先备份）；或
- 使用干净的初始历史发布；或
- 确认不公开包含这些内容的提交。

本次工作未修改 Git 历史、未推送、未发布。
