# 跨平台兼容性矩阵

- 更新时间：2026-10-19
- 说明：**已验证** = 在当前审计环境实际执行；**静态审查** = 阅读代码/文档推断，未在目标平台执行；**不支持** = 明确不承诺。
- 本表不把“未验证”写成“通过”。

## 一、平台与运行时

| 能力 | macOS | Linux | Windows |
|---|---|---|---|
| Bash 审计/校验脚本 | 已验证（Bash 3.2.57，macOS 26） | 静态审查（POSIX/GNU Bash）；如环境允许建议在 CI 跑 | 仅 Git Bash / WSL；原生 CMD/PowerShell 不支持直接执行 |
| `verify-symlinks.sh`（仓库内） | 已验证 | 静态审查 | Git Bash/WSL 静态审查；原生 PowerShell 不适用 |
| `verify-symlinks.sh --host` | 已验证（本机软链） | 静态审查（`$HOME` 约定） | 静态审查；需 Git Bash/WSL，且链接创建成功 |
| `scripts/audit.sh` | 已验证（v1.0.0，scan/check/report/verify/rules） | 静态审查 | 静态审查（Git Bash/WSL）；不含原生 CMD 实现 |
| `scripts/tests/test-audit.sh` | 已验证（43 PASS / 0 FAIL） | 静态审查 | 静态审查（Git Bash/WSL） |
| `smoke-check-core.sh` | 已验证（Bash + Python 3） | 静态审查 | Git Bash/WSL + Python 3 静态审查；`/tmp` 已改为 `TMPDIR`/`mktemp` |
| `memory_tool.py` | 已验证（Python 3.13.3，51 tests） | 静态审查（标准库跨平台） | 静态审查（`Path.home()`、`USERPROFILE`、SQLite、`os.replace`） |
| OpenCode Agent Prompt | 已验证（本机 OpenCode） | 取决于 OpenCode 自身支持 | 取决于 OpenCode 自身支持；frontmatter 为 OpenCode 约定 |
| Pi Runtime | 未验证（本机未安装） | 未验证 | 未验证 |
| Git 历史/发布 | 已验证（只读检查） | 不适用 | 不适用 |

## 二、功能支持边界

| 功能 | 支持范围 | 说明 |
|---|---|---|
| Skill 发现 | 宿主发现机制优先 | OpenCode 自动解析软链；其他宿主需等价机制；`$HOME/.agents/skills` 仅兜底 |
| 软链接安装 | macOS/Linux 原生；Windows 需 Developer Mode/管理员 | Windows 无权限时用复制 |
| 路径含空格 | 支持 | 脚本变量均已加引号；`kernel/Vibe Coder.md` 含空格已验证 |
| 非 ASCII 路径/文件名 | 静态审查 | UTF-8；Windows 终端编码可能影响显示，不影响 Python 文件 API |
| 大小写敏感 | 不依赖大小写 | Linux 大小写敏感；引用保持实际大小写 |
| CRLF/LF | 仓库统一 LF | `.gitattributes` 强制脚本/文本 LF |
| 临时目录 | `TMPDIR`/`mktemp` | 不再固定 `/tmp`；Windows Git Bash 由环境提供 |
| 原子写入 | Python `os.replace`；SQLite `BEGIN IMMEDIATE` | Windows/macOS/Linux 标准库行为 |
| 文件锁/并发 | SQLite busy_timeout + 立即事务 | 跨进程可用；不承诺网络文件系统上的强一致 |
| 进程/信号 | 不依赖 `kill`/`pkill` | 工具是短进程，无守护进程 |
| 固定端口/常驻服务 | 无 | 审计工具不启动服务、不访问网络 |
| WSL/Git Bash | 支持 Bash 脚本 | 路径映射、换行和权限需按发行版验证 |
| 原生 CMD | 不支持 | 文档只提供 PowerShell 安装命令 |
| 许可证 | 未声明 | 需人工决策；不影响技术兼容性 |

## 三、依赖声明

| 依赖 | 必需性 | 版本/说明 |
|---|---|---|
| Bash | 审计/校验脚本必需 | 3.2+（macOS 自带）；不使用 `mapfile`/关联数组 |
| Git | `audit.sh` 的跟踪面扫描、发布检查必需 | 任意较新版本；非 Git 目录可退化为文件系统扫描 |
| grep/sed/awk/find/sort/comm | 审计脚本必需 | POSIX/BSD/GNU 常用选项；不使用 `grep -P` |
| Python | 记忆工具、完整 smoke-check 必需（对使用者可选） | 3.8+；仅标准库；完整 smoke-check 另需 PyYAML |
| OpenCode | Prompt 原宿主的必需项 | 非本仓库依赖；其他宿主需适配 |
| delx-memory | 可选 | 缺失时记忆能力降级并标注 |
| codegraph | 可选 | 缺失时用 grep + 读取替代 |
| PyYAML | 可选 | 仅 smoke-check 的 Checkpoint YAML 校验；缺失时显式跳过 |
| Node.js / Bun | 不需要 | 本仓库工具不依赖 |

## 四、未验证项

- Linux 真实发行版上的 Bash/Python 行为未在本机执行；建议在 CI 或容器中补跑。
- Windows 原生 / Git Bash / WSL 均未在本机执行；Windows 符号链接权限、`%USERPROFILE%`、CRLF 仅在代码/文档层静态审查。
- Pi Runtime 适配未验证。
- 网络文件系统、大小写不敏感 Linux 挂载、非 UTF-8 终端未验证。
- 第三方许可证与内容授权未审计完成。
