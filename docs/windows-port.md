# Windows 平台适配记录（分支 `windows`）

> **为什么有这个分支**：本仓库的能力最初在 macOS 上实现并验证。`windows` 分支只承载
> **平台适配差异**，不改变协议语义。`main` 继续作为 macOS 基线；当 `main` 更新后，
> 按本文「四、main 更新后的回填检查」逐项核对本分支的补丁是否仍需保留/重新应用。
>
> **记录纪律**：每新增一处 Windows 适配，追加到「二、路径 / 命令适配表」；纯环境安装
> （软链、agent、全局配置）记在「三、本机安装记录」，因为它们不进入 git。

## 一、环境基线（本机实测）

| 项 | 值 |
|---|---|
| 仓库路径 | `D:\allen_\Documents\github\Vibe-Coder-Loop` |
| opencode | 1.18.23（`D:\Program Files\node\opencode.ps1`） |
| 全局配置 | `C:\Users\allen_\.config\opencode\opencode.json` |
| 全局 agent | `C:\Users\allen_\.config\opencode\agent\Vibe Coder.md` |
| 外部 Skill 目录 | `C:\Users\allen_\.agents\skills`（junction） |
| OpenCode Skill 目录 | `C:\Users\allen_\.config\opencode\skills`（junction） |
| Python | 3.12.4；`python` / `py` 可用，**`python3` 不可用**（Microsoft Store 别名 stub，spawn 返回 9009） |
| Shell | 宿主 bash 工具 = PowerShell；`scripts/*.sh` 用 Git Bash（`D:\Program Files\Git\usr\bin\bash.exe`） |
| delx-memory | MCP `http://127.0.0.1:3030/mcp` 在线；DB `C:\Users\allen_\.delx-memory\db.sqlite` 存在 |

## 二、路径 / 命令适配表（进入 git 的差异）

| # | 文件 | macOS 假设 | Windows 调整 | 原因 / 证据 |
|---|---|---|---|---|
| 1 | `.opencode/plugins/vibe-bridge.js` | `spawn(process.env.VIBE_KERNEL_PYTHON \|\| "python3", ...)` 固定启动器 | 启动器候选按平台：Windows `python` → `py` → `python3`；POSIX `python3` → `python`；首个成功者缓存；`VIBE_KERNEL_PYTHON` 仍优先；候选返回 9009 且空输出（Store 别名 stub）时继续下一个 | `python3 --version` 在 PowerShell 返回 9009；node `spawnSync("python3")` status=9009。不修则所有 hook 静默降级（`vc_state` → `BRIDGE_CLI_UNAVAILABLE`） |
| 2 | 同上（`spawnOnce` 子进程 env） | 继承宿主环境 | 注入 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8` | 本机 `python -c "import sys; print(sys.stdout.encoding)"` → `gbk`；`snapshot-task-zone` 是纯文本通道，中文会乱码。JSON 通道因 `ensure_ascii` 暂未暴露，此修复为防御性 |
| 3 | `kernel/Vibe Coder.md`（frontmatter） | `name: Vibe Coder — Agent Kernel` 被新版 opencode 当作 Agent ID | 改为 `name: Vibe Coder`，与文件名 / 文档称呼一致 | `opencode agent list` 实测注册名变为 `Vibe Coder — Agent Kernel`；替换目标 agent 是 `Vibe Coder`，ID 漂移会让 TUI / `default_agent` 找不到。跨平台修复（非 Windows 专属），main 若已修正可删除本补丁 |
| 4 | `docs/installation.md` | 只有 POSIX 软链 + Windows 符号链接 | 增加 junction 安装段（3.1.1）、插件全局注册示例、Windows python 启动器与故障排查行 | 让 Windows 安装步骤可复现，与本文互补 |
| 5 | `scripts/verify-symlinks.sh` | 只查 `~/.config/opencode/agents/`（复数） | `OPENCODE_AGENTS_DIR` 未设置时优先探测单数 `agent/`，不存在再回退 `agents/` | opencode 两种目录都接受；Windows 安装步骤写单数目录，原脚本会误报「Agent Prompt 未安装」 |
| 6 | `tests/context-dedup/slim-edit.test.mjs` | 期望 `<path>src/app.js</path>` | 期望值改用 `path.join("src", "app.js")`（Windows 为 `src\app.js`） | `path.relative` 在 Windows 返回反斜杠；原断言只适用于 POSIX |
| 7 | `tests/context-dedup/token-usage-log.test.mjs` | 用 `/project` 作项目根 | 用 `path.parse(os.tmpdir()).root + "project"` 构造平台绝对路径 | Windows 下 `path.resolve("/project", ...)` 会解析成当前盘符（`D:\project`），与 `path.join("/project", ...)` 不一致 |
| 8 | `docs/windows-port.md` | — | 本文件 | 追溯载体 |

### 审计后确认「无需修改」的项

| 位置 | 结论 | 依据 |
|---|---|---|
| `runtime/**` | 不改 | 已有 `os.name == "nt"` / `sys.platform == "win32"` 分支：`proc_tree.py` 用 `taskkill /T /F`；`pathnorm.py` 大小写不敏感探测；`checkpoint.py` 加锁分支 |
| `skills/**` 文档中的 `python3 ...` 命令 | 不改 | 属「文档命令」而非运行时路径；`docs/installation.md` 已给出 `python` / `py -3` 替代。Agent 在 Windows 上执行时用 `python` 等价替换 |
| `backup/config.json`、`runtime/core/memory_store.py` | 不改 | 已声明 Windows 默认 `%USERPROFILE%\.delx-memory\db.sqlite` |
| `.opencode/context-dedup/**` | 不改 | 仅用 `node:os.homedir()` / `node:path`，无 POSIX 绝对路径；token-usage 落在 `~/.config/opencode/token-usage` |
| 仓库内硬编码 `/Users/...` | 无 | 全仓 grep `/Users/[A-Za-z0-9_.-]+` 无命中（除审计脚本自身的脱敏正则） |

## 三、本机安装记录（不进入 git）

| 项 | 变更 |
|---|---|
| `~/.agents/skills/{vibe-coder-loop,delx-memory-protocol,skill-authoring}` | 旧 junction 指向 `D:\allen_\Documents\code\obsidian\raw\ai\skills\*`；已重建为本仓库 `skills\<name>`（只删 junction，未动目标目录） |
| `~/.config/opencode/skills/<name>` | 新建 junction → 本仓库 `skills\<name>` |
| `~/.config/opencode/agent/Vibe Coder.md` | 用 `kernel/Vibe Coder.md` 替换；旧文件备份为 `Vibe Coder.md.bak-20261111` |
| `~/.config/opencode/opencode.json` | 新增 `plugin` 数组，按 `file:///D:/...` 注册 `vibe-bridge.js` / `vibe-context-dedup.js`；改前备份 `opencode.json.bak-20261111` |

> 旧 junction 目标是本机历史副本（obsidian 目录），不属于本仓库资产；仅解除引用，未删除。

## 四、main 更新后的回填检查

`main`（macOS）合入新提交后，在 `windows` 分支执行：

```bash
git fetch origin
git log --oneline windows..origin/main      # 看 main 新增了什么
git merge origin/main                       # 有冲突优先保留平台相关补丁
```

逐项核对：

1. **`vibe-bridge.js` 启动器**：若 main 已改为跨平台启动器（`python`/`py` 探测），删除本分支补丁 #1，避免双份逻辑。
2. **`vibe-bridge.js` 子进程 env**：若 main 已注入 `PYTHONUTF8`/`PYTHONIOENCODING`，删除补丁 #2。
3. **`docs/installation.md`**：若 main 新增 Windows 段，合并去重；保持 junction 说明。
4. **本文件**：保留；每次合并后更新「二」表的适用版本（可在表头加 `main@<sha>` 备注）。
5. **运行时验证**（见下节）全部重跑，确认没有回归。

## 五、验证命令与结果

```powershell
# 1) 插件可导入、可真实调用 runtime.core（vc_state 返回 checkpoint）
node <临时脚本>   # 见下：import 插件 → plugin.tool.vc_state.execute({})

# 2) opencode 实际加载的插件 / agent / skill
opencode debug info
opencode debug agent "Vibe Coder"
opencode debug skill

# 3) 配置可解析（不启动 TUI）
opencode debug config

# 4) 仓库自检（Git Bash）
bash scripts/verify-symlinks.sh --host
```

验收基线（2026-11-11，分支 `windows`）：

- `vc_state` 返回真实 checkpoint（`mode=fresh_start`, `rev=0`），证明 Python 启动器与 `runtime/` 定位成功。
- `vc_transition` 非法清单在插件侧被拒（`CHECKLIST_INVALID`），未浪费 spawn。
- `opencode debug info` 的 `plugins:` 列表每项只出现一次（全局 `file:///` 注册与项目自动发现按同一路径去重）。
- 在 **仓库外**（`%TEMP%`）执行 `opencode debug info` 仍列出两个插件，`opencode debug skill` 仍列出三个仓库 Skill → 全局注册生效。
- `opencode agent list` → `Vibe Coder (primary)`；`opencode debug agent "Vibe Coder"` 可解析。
- `node --test tests/plugins/vibe-bridge.test.mjs` → 15/15 pass。
- `bash scripts/tests/test-context-dedup.sh` → 300 tests：299 pass / 0 fail / 1 skipped。
- `bash scripts/verify-symlinks.sh --host` → PASS=23 FAIL=0 WARN=1（WARN 为 agent 使用复制安装，属预期）。

## 六、已知边界

- `runtime/exec`（`vc_exec`/`vc_diff`）尚未接线到插件；其 Windows 兼容性只做了代码审计，未做真机验证。
- UWP / Store 版 Python 的 `python3.exe` 是别名 stub，可能返回 9009；插件已跳过该启动器。
- Git Bash 的 `$HOME` 与 PowerShell `$HOME` 指向同一目录（`C:\Users\allen_`），两条安装路径互不冲突。
