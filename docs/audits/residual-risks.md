# 遗留风险与发布阻断项

- 日期：2026-10-19
- 结论：代码与文档层面的隐私/可移植性自动项已处理；**仍存在 4 个人工决策项和若干环境/语义风险，不能仅凭本清单直接发布**。
- 关联：[审计报告](2026-10-19-open-source-readiness.md)、[变更清单](change-list.md)、[发布检查清单](release-checklist.md)。

## 一、发布阻断项（必须人工决策）

| ID | 风险 | 为什么阻断 | 可选处置 |
|---|---|---|---|
| A-18 | 无 `LICENSE` | 默认“保留所有权利”，他人不能合法复用/分发；公开仓库语义不完整 | 选择 OSI 许可证（如 MIT/Apache-2.0）或明确专有/仅公开可见；由所有者决定 |
| A-22 | Git 历史 `ccda1dd` 含个人快照/状态内容 | 仅 `git rm --cached` 不会清除历史；一旦推送即公开 | ① 重写历史后再公开；② 新建干净历史（保留工作树）；③ 确认不公开该提交/仓库 |
| A-13 | `CHANGELOG.md` 含内部项目代号、会话事故与个人工作细节 | 历史变更记录可能泄露内部业务；append-only 原则下未自动改写 | 人工逐条复核；裁剪/脱敏/将仓库私有化；或确认内容可公开 |
| A-19 | `scripts/audit.sh`、`docs/design/*`、`docs/audits/*`、`.gitattributes`、`docs/installation.md` 等未跟踪 | 不提交则成果不进入版本库；全量 `git add .` 又可能带入本地状态/快照 | 按 `change-list.md` 的分组选择性提交；提交前检查 `git status` |

> 这四项未完成前，不应执行 `git push` 到公共远端，也不应创建公开 Release。

## 二、环境与平台风险

| 风险 | 现状 | 影响 | 缓解 |
|---|---|---|---|
| Windows 未真机验证 | 仅静态审查 Git Bash/WSL | 路径分隔符、权限、软链、换行行为可能与 macOS 不同 | 发布前至少在 Windows Git Bash 跑 `audit.sh`、smoke-check、`verify-symlinks.sh` |
| Linux 未真机验证 | 仅静态审查 | GNU 工具差异、权限、大小写敏感 | 在干净 Linux 容器/主机跑同一套回归 |
| 原生 CMD/PowerShell 不支持 Bash 工具 | 文档已声明 | 用户直接双击/在 PowerShell 运行 `.sh` 会失败 | 安装文档只给 PowerShell 复制/软链命令，明确需 Git Bash/WSL |
| 宿主安装依赖软链 | `installation.md` 提供复制方案 | Windows 普通用户无符号链接权限 | 优先复制；软链需开发者模式/管理员 |
| Python 依赖 | `smoke-check` 需要 `pyyaml`；`memory_tool.py` 使用标准库 | 干净机器可能缺 PyYAML，导致 smoke-check 失败 | 文档写明依赖；发布前在干净 venv 验证 |
| 无 CI | 当前只有本地脚本 | 回归依赖人工执行，跨平台矩阵易漂移 | 后续增加 GitHub Actions（macOS/Linux/Windows Git Bash）；不是本次阻塞 |

## 三、语义与适配风险

| 风险 | 说明 | 影响 | 缓解 |
|---|---|---|---|
| Pi/OpenCode 引用边界 | 文档已声明 OpenCode 优先、其他宿主需等价发现机制；H002 仍为 info | 非 OpenCode 用户可能误认为开箱即用 | 保持兼容矩阵与安装文档的“可选/需适配”措辞；发布说明中重复声明 |
| Skill 是协议，不是强制代码 | 状态机、恢复、出口清单仍由 LLM 遵循 Markdown；`memory_tool.py` 是唯一确定性代码 | 不同模型/宿主行为可能漂移 | 不宣称“自动保证”；设计文档中的 Core/Exec/Adapter 尚未实现 |
| 设计文档 `docs/design/*` | 未跟踪的规划稿，引用内部任务/调研日期；已做占位化 | 读者可能把规划当已交付功能 | 如提交，加“设计稿/未实现”标识；或暂不公开 |
| 记忆工具 key 变更 | `SKILL_LINKED_KEYS` 由 16 减为 14，移除了两个项目专属 key | 已存在的本地记忆可能出现“孤立 key” | 备份/迁移时保留旧库；如需要，先导出再升级；不影响现有 51 项测试 |
| 快照含个人数据 | 快照仍在本机 `backup/snapshots/`，已忽略但未删除 | 误提交/误打包会泄露 | 不执行 `git add -f`；迁移只走私有通道；发布前检查 `git ls-files` |

## 四、审计工具自身限制

- 只做文本/路径/链接检查，不解析 AST、不追踪拼接、不读取二进制/压缩包/加密内容。
- 不扫描 Git 历史；A-22 必须手工处理。
- Markdown 只检查内联相对链接；不检查引用式链接、HTML、锚点、URL 编码。
- 邮箱/私有 IP/凭证规则可能误报示例文本，也可能漏报拆分/编码写法。
- 路径含冒号时 TSV 解析可能不准确；报告按冒号切分字段。
- `scan` 默认跳过运行时状态和快照内容，避免把个人数据写入报告，因此**不能证明这些文件干净**。
- `--all` 会扩大扫描面，但仍排除运行时状态/快照；输出可能含环境路径（已脱敏常见用户名/邮箱/IP/凭证形态）。
- 自排除 `scripts/audit.sh` 与 `docs/audits/audit-tool.md` 的路径规则匹配，避免规则文档自触发；这意味着这两个文件的路径样例不被扫描。
- 未实现增量缓存、并发扫描、Git 历史扫描、自动修复；`report` 会重跑 `scan --all` + `check`，大仓库可能较慢。
- 退出码只覆盖工具自身失败与 `--fail-on`；不替代人工法律/安全审查。

## 五、已验证的边界

- macOS Darwin 25、Bash 3.2.57、Python 3.13.3 实跑通过。
- `scan --min-severity=high` 与 `check --min-severity=high` 均为 rc=0；只剩 H002 info（Pi 提及）。
- `test-audit.sh` 43/43、`test_memory_tool.py` 51/51、两个 smoke-check、`verify-symlinks.sh --host` 全部通过。
- “未发现凭证”只代表当前规则/当前工作区；不等于绝对安全。
