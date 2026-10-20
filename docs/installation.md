# 安装与宿主集成

本文档面向公共用户。所有路径均为占位符；不需要作者的本地目录结构。

## 一、选择安装方式

| 方式 | 适用 | 升级 | 权限 |
|---|---|---|---|
| 软链接 | macOS / Linux / Windows Git Bash / WSL | `git pull` 后立即生效 | 创建符号链接的权限 |
| 复制 | 任意平台，包括 Windows 原生 | 重新复制 | 无特殊权限 |

本仓库不要求固定安装位置。下文用 `<repo>` 表示仓库根目录。

## 二、macOS / Linux（POSIX Shell）

```bash
git clone <repo-url> <repo>
cd <repo>

AGENTS_SKILLS="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
OPENCODE_SKILLS="${OPENCODE_SKILLS_DIR:-$HOME/.config/opencode/skills}"
OPENCODE_AGENTS="${OPENCODE_AGENTS_DIR:-$HOME/.config/opencode/agents}"

mkdir -p "$AGENTS_SKILLS" "$OPENCODE_SKILLS" "$OPENCODE_AGENTS"

for name in vibe-coder-loop delx-memory-protocol skill-authoring; do
  ln -sfn "$PWD/skills/$name" "$AGENTS_SKILLS/$name"
  ln -sfn "$AGENTS_SKILLS/$name" "$OPENCODE_SKILLS/$name"
done

ln -sfn "$PWD/kernel/Vibe Coder.md" "$OPENCODE_AGENTS/Vibe Coder.md"
```

校验：

```bash
bash scripts/verify-symlinks.sh --host
```

## 三、Windows PowerShell

PowerShell 用于创建链接/复制文件；**Bash 审计脚本仍需 Git Bash 或 WSL 执行**。

### 3.1 符号链接（推荐，需 Developer Mode 或管理员权限）

```powershell
$Repo = "C:\path\to\Vibe-Coder-Loop"
$AgentsSkills = Join-Path $HOME ".agents\skills"
$OpenCodeSkills = Join-Path $HOME ".config\opencode\skills"
$OpenCodeAgents = Join-Path $HOME ".config\opencode\agents"

New-Item -ItemType Directory -Force -Path $AgentsSkills, $OpenCodeSkills, $OpenCodeAgents | Out-Null

foreach ($name in @("vibe-coder-loop", "delx-memory-protocol", "skill-authoring")) {
  New-Item -ItemType SymbolicLink -Force `
    -Path (Join-Path $AgentsSkills $name) `
    -Target (Join-Path $Repo "skills\$name")
  New-Item -ItemType SymbolicLink -Force `
    -Path (Join-Path $OpenCodeSkills $name) `
    -Target (Join-Path $AgentsSkills $name)
}

New-Item -ItemType SymbolicLink -Force `
  -Path (Join-Path $OpenCodeAgents "Vibe Coder.md") `
  -Target (Join-Path $Repo "kernel\Vibe Coder.md")
```

### 3.2 复制（无符号链接权限时）

```powershell
$Repo = "C:\path\to\Vibe-Coder-Loop"
$AgentsSkills = Join-Path $HOME ".agents\skills"
$OpenCodeSkills = Join-Path $HOME ".config\opencode\skills"
$OpenCodeAgents = Join-Path $HOME ".config\opencode\agents"

New-Item -ItemType Directory -Force -Path $AgentsSkills, $OpenCodeSkills, $OpenCodeAgents | Out-Null

foreach ($name in @("vibe-coder-loop", "delx-memory-protocol", "skill-authoring")) {
  Copy-Item -Recurse -Force (Join-Path $Repo "skills\$name") (Join-Path $AgentsSkills $name)
  Copy-Item -Recurse -Force (Join-Path $AgentsSkills $name) (Join-Path $OpenCodeSkills $name)
}

Copy-Item -Force (Join-Path $Repo "kernel\Vibe Coder.md") (Join-Path $OpenCodeAgents "Vibe Coder.md")
```

### 3.3 Git Bash / WSL

可直接使用 macOS / Linux 的 POSIX 命令。Git Bash 中 `$HOME` 通常指向 Windows 用户目录；WSL 中需要把仓库放在 WSL 可见路径（例如 `/mnt/c/...` 或 WSL 文件系统内）。

## 四、其他 Agent 宿主

`kernel/Vibe Coder.md` 的 frontmatter（`mode`、`permission.skill` 等）是 OpenCode 约定。其他宿主需要：

1. 使用宿主自己的 Agent 配置格式；
2. 保留身份、安全原则与 Skill 调度部分；
3. 使用宿主的 Skill 发现机制，或显式告诉 Agent 本仓库 `skills/` 目录位置。

不要把 OpenCode 专属字段描述成所有宿主通用能力。Pi 适配器目前未纳入本仓库。

## 五、可选集成

| 集成 | 是否必需 | 缺失时行为 |
|---|---|---|
| `delx-memory` | 否 | 记忆读写/回写步骤跳过或降级；Kernel 的记忆兜底也跳过 |
| `codegraph` | 否 | 代码定位降级为 `grep` + 文件读取 |
| Python 3 | 否（仅工具/自检） | 审计 Bash 工具仍可用；`memory_tool.py` 与完整 smoke-check 不可用 |

## 六、配置

### 6.1 记忆数据库

解析优先级：

1. `--db <path>`
2. `DELX_MEMORY_DB` 环境变量
3. `skills/vibe-coder-loop/backup/config.json` 的 `db_path`
4. 自动探测：
   - macOS / Linux：`$HOME/.delx-memory/db.sqlite`
   - Windows：`%USERPROFILE%\.delx-memory\db.sqlite`

`config.json` 默认 `db_path` 为空，适合大多数用户。不要把自己的绝对路径提交到仓库。

### 6.2 结果外置目录

`VIBE_LOOP_ARTIFACTS_DIR` 可覆盖默认的 `$HOME/.vibe-loop/artifacts/<workspace-hash>/`。目录由工具自动创建；24h TTL 由工具清理。

### 6.3 自检 core 定位

`skills/vibe-coder-loop/scripts/smoke-check.sh` 和模板会按以下顺序查找 `smoke-check-core.sh`：

1. `SMOKE_CORE`
2. 同目录
3. 同级 `skill-authoring/scripts/`
4. `$HOME/.agents/skills/skill-authoring/scripts/`（兜底）

若你把 Skill 安装到非标准目录，设置：

```bash
SMOKE_CORE="/path/to/Vibe-Coder-Loop/skills/skill-authoring/scripts/smoke-check-core.sh" \
  bash skills/vibe-coder-loop/scripts/smoke-check.sh
```

## 七、验证

```bash
# 仓库内资源（不依赖宿主安装）
bash scripts/verify-symlinks.sh

# 宿主软链接（需先完成安装）
bash scripts/verify-symlinks.sh --host

# 只读审计
bash scripts/audit.sh scan
bash scripts/audit.sh check

# 记忆工具自测（临时库，不触碰真实库）
python3 skills/vibe-coder-loop/backup/test_memory_tool.py

# Skill 自检（需要 Python 3；完整检查可能依赖本机记忆库）
bash skills/vibe-coder-loop/scripts/smoke-check.sh --quiet
bash skills/skill-authoring/scripts/smoke-check.sh --quiet
```

Windows 下若 `python3` 不可用，尝试 `python` 或 `py -3`。

## 八、故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `verify-symlinks.sh --host` 报“非软链” | 使用了复制方式，或链接路径不同 | 复制方式不需要宿主软链检查；或设置 `AGENTS_SKILLS_DIR` 等变量 |
| Windows 无法创建符号链接 | 未启用 Developer Mode / 无管理员权限 | 使用复制方式；或启用 Developer Mode |
| Bash 脚本报 `bad interpreter` / `\r` | Windows 检出为 CRLF | 确保 `.gitattributes` 生效；执行 `git config core.autocrlf false` 后重新检出 |
| `python3: command not found` | Windows 只安装了 `python` / `py` | 使用 `python` 或 `py -3`；把 Python 加入 PATH |
| smoke-check 报找不到 core | Skill 安装目录不是同级布局 | 设置 `SMOKE_CORE` |
| smoke-check 因记忆库缺失失败 | 本机没有 delx-memory 数据库 | 该检查是维护者工具；公共使用不需要运行，或配置 `DELX_MEMORY_DB` |
| `memory_tool.py list` 找不到库 | 数据库路径不同 | 使用 `--db` 或 `DELX_MEMORY_DB`，或修改本地 `backup/config.json`（不要提交） |
| 路径含空格 / 中文 | 未加引号 | 所有示例均使用引号；自定义脚本中也要引用变量 |
| 大小写不一致 | Linux 区分大小写，macOS/Windows 通常不区分 | 引用路径时保持与仓库实际大小写一致 |
| 审计工具报告“部分文件无法读取” | 权限不足或文件损坏 | 检查权限；工具会继续扫描并给出提示 |

## 九、卸载

- 软链接：删除宿主目录中的对应链接（见 [migration.md](migration.md) §三）。
- 复制：删除宿主目录中的副本。
- 本仓库的本地运行状态与快照不会被卸载脚本删除；如需清理，请手动确认后删除。
