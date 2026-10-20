# 变更清单（开源就绪性修复）

- 日期：2026-10-19
- 基线报告：[2026-10-19-open-source-readiness.md](2026-10-19-open-source-readiness.md)
- 范围：隐私/可移植性/公共文档/审计工具。**未修改** Skill 方法论语义与 Kernel 调用契约。
- 状态：所有变更为**工作区未提交**；`git rm --cached` 两项已进入暂存区。提交范围由项目所有者决定（见 A-19）。

## 一、隐私与版本库边界

| 变更 | 文件 | 说明 |
|---|---|---|
| 取消跟踪个人 Checkpoint | `skills/vibe-coder-loop/.state.md` | 本地文件保留；新增 `.gitignore` 规则 |
| 取消跟踪记忆快照 | `skills/vibe-coder-loop/backup/snapshots/skill_memory_latest.json` | 本地文件保留；快照目录全部忽略，仅保留 `.gitignore` |
| 新增脱敏模板 | `skills/vibe-coder-loop/.state.template.md` | 13 字段占位示例，不包含真实任务内容 |
| 扩充忽略规则 | `.gitignore` | 环境/凭证/缓存/日志/CodeGraph/运行时状态/本地审计输出 |
| 快照目录忽略 | `skills/vibe-coder-loop/backup/snapshots/.gitignore` | 移除对最新快照的反向放行 |
| 配置去个人路径 | `skills/vibe-coder-loop/backup/config.json` | `db_path` 置空，走 `--db` > `DELX_MEMORY_DB` > 配置文件 > 自动探测 |
| 备份策略文档 | `skills/vibe-coder-loop/backup/README.md` | 明确快照禁止提交；内部项目名/路径通用化；Windows 同时给 `python` 说明 |

## 二、可移植性

| 变更 | 文件 | 说明 |
|---|---|---|
| 软链校验重写 | `scripts/verify-symlinks.sh` | 默认仅查仓库，`--host` 查宿主；POSIX `resolve_path()` 取代 GNU 解析选项；PASS/FAIL/WARN 与 0/1/2 退出码 |
| 临时文件可移植 | `skills/skill-authoring/scripts/smoke-check-core.sh`、`smoke-check.sh`、`smoke-check-template.sh`、`skills/vibe-coder-loop/scripts/smoke-check.sh` | 使用 `${TMPDIR:-/tmp}` + `mktemp`，退出时清理 |
| 行尾策略 | `.gitattributes`（新增） | Shell/Python/Markdown/YAML 统一 LF，避免 Windows `core.autocrlf` 破坏脚本 |
| Kernel 兜底路径 | `kernel/Vibe Coder.md` | 使用 `$HOME` / `%USERPROFILE%`；保留用户既有 `#ai` 标签删除修改 |
| 构建/平台边界 | `README.md`、`docs/installation.md`、`docs/audits/compatibility.md` | 声明 macOS/Linux/Git Bash/WSL；Windows 原生 CMD 不支持 |

## 三、公共文档

| 变更 | 文件 | 说明 |
|---|---|---|
| 重写入口 | `README.md` | 公共定位、结构树、环境要求、快速开始、Skills、配置变量、审计验证、安全隐私 |
| 新增安装文档 | `docs/installation.md` | 软链/复制、PowerShell 安装、其他宿主适配、配置优先级、验证、故障排查、卸载 |
| 新增兼容矩阵 | `docs/audits/compatibility.md` | 已验证/静态审查/不支持；依赖与未验证项 |
| 重写迁移记录 | `docs/migration.md` | 去除个人路径与私人 vault，改为占位符与通用步骤 |
| 新增状态模板引用 | `skills/vibe-coder-loop/engine/state-machine.md` | 公共模板与本地实例分离 |

## 四、内部名称脱敏（仅示例/注释，不改规则）

- `skills/vibe-coder-loop/engine/state-machine.md`：移除具体内部校准条目，改为“随宿主/环境而异”。
- `skills/vibe-coder-loop/engine/transition.md`：旧内部目录映射改 `kernel/`；移除内部服务名。
- `skills/vibe-coder-loop/learning/memory/*.md`：内部项目名改为通用项目 A/B、`<project>`。
- `skills/vibe-coder-loop/SKILL.md`、`rules/plan.md`、`docs/design/*`、`docs/design/mvp-1-workflow-core.md`：旧路径/内部任务 ID 占位化。
- `skills/delx-memory-protocol/protocol.md`、`skills/vibe-coder-loop/profiles/skill-maintenance.md`、`backup/archive/SPLIT_PLAN.md`：示例通用化。
- `skills/vibe-coder-loop/backup/memory_tool.py`：注释/示例通用化；`SKILL_LINKED_KEYS` 由 16 条减为 14 条（移除两个项目专属 key）。
- 设计文档 `.state.md` “真实实例”表述改为“公共模板；本地实例不发布”。

## 五、审计工具与测试

| 变更 | 文件 | 说明 |
|---|---|---|
| 审计工具 v1.0.0 | `scripts/audit.sh`（未跟踪） | `scan/check/report/verify/rules/help/version`；TSV/JSONL；脱敏；严重度过滤；`--fail-on`；Bash 3.2 兼容 |
| 工具自测 | `scripts/tests/test-audit.sh`（未跟踪） | 51 PASS / 0 FAIL；覆盖规则、脱敏、JSON、退出码、链接/软链/跟踪面/运行状态忽略面检查 |
| 工具说明 | `docs/audits/audit-tool.md`（未跟踪） | 规则、命令、退出码、限制与维护方式 |
| 报告基线 | `docs/audits/2026-10-19-open-source-readiness.md` | 修复前发现与修复后状态；保持脱敏 |
| 生成物 | `docs/audits/baseline.tsv`、`docs/audits/scan-report.md` | 可重复生成；当前仅 H002 info，可安全公开 |
| 误报自排除 | `scripts/audit.sh` | 扫描器自身与规则文档不参与路径规则匹配 |

## 六、验证结果（2026-10-19）

| 命令 | 结果 |
|---|---|
| `python3 skills/vibe-coder-loop/backup/test_memory_tool.py` | 55 tests OK |
| `bash skills/vibe-coder-loop/scripts/smoke-check.sh --quiet` | rc=0 |
| `bash skills/skill-authoring/scripts/smoke-check.sh --quiet` | rc=0 |
| `bash scripts/verify-symlinks.sh` | 仓库 PASS=15（关键文件/无断链） |
| `bash scripts/verify-symlinks.sh --host` | 宿主检查全部 PASS（23 项） |
| `bash scripts/tests/test-audit.sh` | 51 PASS / 0 FAIL |
| `bash scripts/audit.sh scan --min-severity=high` | rc=0，无 high/critical |
| `bash scripts/audit.sh check --min-severity=high` | rc=0（C006 已随文档补齐消除） |
| `bash -n` 全部 Shell 脚本 | 通过 |

## 七、未纳入本次变更

- Git 历史 `ccda1dd`：未重写、未推送。
- `LICENSE`：未选择。
- `skills/vibe-coder-loop/CHANGELOG.md`：append-only，未自动改写。
- `docs/design/*` 与 `scripts/audit.sh`、`docs/audits/*`：仍为未跟踪文件，提交范围待确认。
- 未在真实 Windows/Linux 主机运行；仅有 macOS 实跑与静态审查。

## 八、建议提交分组

1. **隐私与忽略**：`.gitignore`、`snapshots/.gitignore`、两个 `git rm --cached`、`.state.template.md`。
2. **可移植脚本**：`verify-symlinks.sh`、smoke-check 系列、`.gitattributes`。
3. **文档**：`README.md`、`installation.md`、`migration.md`、`compatibility.md`、`audit-tool.md`、报告/清单/风险/检查表。
4. **脱敏**：Kernel、Skill 文档、`memory_tool.py`/`config.json`/`backup/README.md`。
5. **审计工具与测试**：`scripts/audit.sh`、`scripts/tests/test-audit.sh`。

> 提交前先处理 A-13 / A-18 / A-22；提交时不要把本地 `.state.md`、快照、`scan-report.local.*` 加入索引。
