# Vibe Kernel 开源就绪性审计报告（初始）

- 日期：2026-10-19
- 仓库：`Vibe-Coder-Loop`
- 分支：`main`（领先 `origin/main` 1 个提交）
- 审计性质：开源准备 / 可移植性 / 私密信息 / 宿主依赖 / 自动化工具
- 本报告为**修复前**基线；修复结果见文末「修复进度」与同目录其他交付物。

> 说明：本报告只记录脱敏后的证据。未发现可直接确认的真实 API Key、Token、私钥或密码；但发现了个人绝对路径、个人运行状态、内部项目代号和本机记忆快照。报告不复制敏感原文。

## 一、审计范围与方法

### 1. 范围

- Git 当前跟踪文件：65 个（`git ls-files`）。
- 工作区未跟踪且未忽略文件：`docs/design/*`、`scripts/audit.sh`。
- 被 `.gitignore` 忽略但仍存在于磁盘的运行时数据：`skills/vibe-coder-loop/backup/snapshots/*.json(.gz)`。
- Git 历史：`5c00380`（first commit）、`ccda1dd`（迁移提交，尚未推送）。
- 重点保护资源：`skills/delx-memory-protocol/`、`skills/skill-authoring/`、`skills/vibe-coder-loop/`、`kernel/Vibe Coder.md`。

### 2. 方法

1. 目录 / Git 状态 / 跟踪清单 / 忽略清单 / 历史对象清单。
2. 文本扫描：个人路径、Windows 用户目录、内部目录名、邮箱、私网 IP、凭证形态、平台差异命令、宿主路径。
3. 结构与引用检查：Markdown 相对链接、软链接、断链、越界链接、可执行位、CRLF/BOM、大文件。
4. 运行现有验证：`scripts/verify-symlinks.sh`、`skills/vibe-coder-loop/scripts/smoke-check.sh`、`skills/skill-authoring/scripts/smoke-check.sh`、`python3 backup/test_memory_tool.py`。
5. 静态审查：Bash 3.2/macOS、Linux GNU 工具、Windows Git Bash/PowerShell 差异；Python 标准库路径处理；OpenCode/Pi 宿主约定。

### 3. 当前工作区保护

- 未切换分支、未重置工作区、未删除无法确认用途的文件。
- 用户已有未提交修改 `kernel/Vibe Coder.md`（删除 `#ai` 标签）保留。
- 未跟踪的 `docs/design/*` 与 `scripts/audit.sh` 视为上一轮遗留成果，先审计后修复。
- 未执行 Git 历史重写、未推送、未发布。

## 二、初始发现清单

> 风险等级：Critical / High / Medium / Low / Info。  
> 状态：待处理 / 已修复 / 已验证 / 待人工确认 / 无法验证。

### Private Data / Security

| ID | 位置 | 等级 | 脱敏摘要 | 影响 | 修复方式 | 自动修复 | 验证 | 状态 |
|---|---|---|---|---|---|---|---|---|
| A-01 | `skills/vibe-coder-loop/backup/snapshots/skill_memory_latest.json:5` 及全文 | Critical | 已跟踪快照含个人主目录数据库路径与本机技能记忆 payload（含内部项目/会话信息） | 公开仓库即泄露个人运行环境与内部经验；且已进入 `ccda1dd` 历史 | 从 Git 索引移除、改为忽略；保留本地文件；更新备份文档禁止提交快照；历史风险单独处理 | 是（仅索引移除） | `git ls-files` 不再包含；扫描无该文件 | 已修复（索引移除；历史见 A-22） |
| A-02 | `skills/vibe-coder-loop/.state.md:1-54` | Critical | 已跟踪 Workflow Checkpoint，含真实内部任务 ID、项目模块、决策与工作区细节 | 公开即泄露内部项目状态与业务信息；已进入历史 | 从索引移除并忽略；新增脱敏 `.state.template.md`；保留本地实例 | 是（仅索引移除） | 模板存在、实例被忽略、smoke-check 跳过或通过 | 已修复（索引移除；历史见 A-22） |
| A-03 | `skills/vibe-coder-loop/backup/config.json:2` | High | 硬编码 `/Users/<user>/.delx-memory/db.sqlite` | 公共用户无法直接使用；泄露用户名与目录结构 | 改为空字符串，走自动探测；文档说明环境变量覆盖 | 是 | `memory_tool.py list` 自动探测；JSON 合法 | 已验证 |
| A-04 | `kernel/Vibe Coder.md:69` | High | 兜底读取 `/Users/<user>/.agents/skills/...` | 非本机用户路径无效；泄露用户名 | 改为用户主目录 + `.agents/skills`，分别标注 POSIX/Windows；保留发现机制优先 | 是 | 文本扫描无个人绝对路径；语义仍为兜底 | 已验证 |
| A-05 | `docs/migration.md:35-38,46,65,70` | High | 回滚命令与说明含个人绝对路径、私人 vault 名称 | 公开仓库泄露本地目录结构；文档示例不可运行 | 重写为脱敏的迁移/安装说明，使用占位符与跨平台命令 | 是 | 扫描无 `/Users/<user>`；链接有效 | 已验证 |
| A-06 | `scripts/verify-symlinks.sh:27,36,78-79` | High | 使用 GNU `readlink` 的非 POSIX 解析选项；包含与本项目无关的个人断链提示 | macOS/部分环境行为不一致；公共用户运行必然失败或看到无关个人路径 | 改为可移植链接解析；默认只校验仓库，`--host` 才校验宿主；移除个人断链 | 是 | macOS 实跑；Linux 静态；退出码测试 | 已验证 |
| A-07 | `skills/skill-authoring/scripts/smoke-check-core.sh:265,268` | High | 固定 `/tmp/smoke_selftest.log` | Windows/Git Bash 可能无 `/tmp`；并发运行互相覆盖；错误信息指向固定路径 | 使用 `TMPDIR`/`mktemp` 临时文件并清理 | 是 | `bash -n`；smoke-check 实跑；临时文件不存在残留 | 已验证 |
| A-08 | `skills/vibe-coder-loop/backup/README.md:3,37,83-85` | High | 建议提交 `skill_memory_latest.json`；含内部项目名；`/tmp` 示例 | 引导用户把个人记忆提交到公开仓库；示例不可移植 | 明确快照禁止提交；改为安全传输/本地备份；通用化项目名；临时路径占位符 | 是 | 文档扫描；快照 .gitignore 一致 | 已验证 |
| A-13 | `skills/vibe-coder-loop/CHANGELOG.md` 全文 | High | 历史变更记录含内部项目代号、会话事故与个人工作细节 | 公开可能泄露内部业务信息 | 不在本次自动重写（append-only 原则）；列入人工审核；发布前决定脱敏/裁剪/私有化历史 | 否 | 人工复核记录 | 待人工确认 |
| A-11 | `docs/design/overview.md:15,259-260`、`mvp-1-workflow-core.md:31` | Medium | 未跟踪设计文档引用真实内部任务 ID、旧内部目录、Pi 私有路径 | 若随仓库公开，泄露内部任务名与个人宿主配置 | 替换为占位任务 ID；更新旧路径；将 Pi 标注为可选适配器 | 是 | 扫描无内部任务 ID；链接有效 | 已验证 |
| A-12 | 多个 Skill 文档（见下） | Medium | 示例/注释含内部项目、前端/Web 项目、运维 Skill 等专有名称 | 公开后暴露内部项目/工作流来源 | 仅替换示例与注释中的专有名词为通用项目名，不改规则语义 | 是 | smoke-check 通过；差异仅限文本 | 已验证 |
| A-20 | `skills/vibe-coder-loop/backup/README.md:37` | Low | `/tmp/test.log` 示例 | Windows 不可直接用 | 改为 `$TMPDIR` / `<tmp>` 占位 | 是 | 文档检查 | 已验证 |
| A-25 | `skills/vibe-coder-loop/backup/README.md:90` | Low | Windows 下 `python3` 可能不可用 | 用户执行失败 | 同时给出 `python` 与 `python3` 说明 | 是 | 文档检查 | 已验证 |

**A-12 覆盖范围（初始）**：

- `learning/memory/retrieval.md`、`architecture.md`、`advanced.md`、`lifecycle.md`
- `profiles/skill-maintenance.md`、`SKILL.md`、`engine/transition.md`、`rules/plan.md`
- `backup/archive/SPLIT_PLAN.md`、`delx-memory-protocol/protocol.md`
- `scripts/smoke-check*.sh`、`memory_tool.py` 的示例/注释

具体专有名称不在报告中复述，避免二次泄露；修复后仅保留通用示例。

### Hardcoded Path / Portability

| ID | 位置 | 等级 | 脱敏摘要 | 影响 | 修复方式 | 自动修复 | 验证 | 状态 |
|---|---|---|---|---|---|---|---|---|
| A-09 | `.gitignore:1-13` | Medium | 仅覆盖 Python/macOS/编辑器少量规则 | `.env`、运行状态、快照、Windows 缓存等可能误入版本库 | 扩充忽略规则；保留示例文件例外 | 是 | `git status --ignored`；扫描 | 已验证 |
| A-10 | `skills/vibe-coder-loop/backup/snapshots/.gitignore:5` | Medium | `!skill_memory_latest.json` 反向放行个人快照 | 与 A-01 直接冲突 | 移除反向放行，改为全部忽略 | 是 | `git check-ignore` | 已验证 |
| A-14 | `scripts/audit.sh`（未跟踪） | Medium | 部分实现：S002 误报版本号；凭证/邮箱脱敏不完整；无 JSON；`-b` 未实现；无退出码门禁；无测试 | 不能作为可靠发布门禁；报告可能泄露邮箱 | 重构为可组合工具；增加 JSONL、退出码、脱敏、测试 | 是 | 工具自测 + 复扫 | 已验证 |
| A-15 | 仓库根（无 `.gitattributes`） | Medium | 缺少行尾策略 | Windows `core.autocrlf` 可能把 `.sh` 转为 CRLF，导致 Bash 执行失败 | 新增 `.gitattributes`，脚本/文本统一 LF | 是 | `file` 检查；静态审查 | 已验证 |
| A-16 | `README.md:3,29-39`、`docs/migration.md` | Medium | README 以“个人 Vibe Kernel / 本机软链”为主，缺少公共安装、依赖、支持范围 | 公共用户无法判断如何安装与哪些平台可用 | 重写 README；新增安装与兼容性文档 | 是 | 文档链接；人工阅读 | 已验证 |
| A-17 | `skills/vibe-coder-loop/.state.md` | Medium | 模板与实例同一文件；移除实例后新用户无模板 | 新用户无法按模板创建检查点 | 新增脱敏 `.state.template.md`；更新状态机文档引用 | 是 | 模板 13 字段可解析；smoke-check | 已验证 |
| A-24 | `README.md:3-5` | Low | “个人 Vibe Kernel”“本机所有运行环境” | 与开源定位不符 | 改为公共定位；本机约定移入安装文档 | 是 | 文档检查 | 已验证 |

### Host Dependency / Documentation

| ID | 位置 | 等级 | 脱敏摘要 | 影响 | 修复方式 | 自动修复 | 验证 | 状态 |
|---|---|---|---|---|---|---|---|---|
| A-18 | 仓库根（无 LICENSE） | High | 未声明许可证 | 默认保留所有权利，公共用户不能合法复用/分发 | 由项目所有者选择许可证；不在本次擅自决定 | 否 | 人工确认 | 待人工确认 |
| A-19 | 未跟踪文件 | Info | `scripts/audit.sh`、`docs/design/*` 未纳入 Git；上一轮成果部分遗失 | 审计工具与设计文档可能再次丢失 | 本次修复后纳入变更清单，由用户决定提交 | 否 | `git status` | 待人工确认 |
| A-21 | `kernel/Vibe Coder.md:67,71`、`engine/state-machine.md:139` | Medium | 将 OpenCode skill 发现机制、`agent:vc_constraints` 记忆条目作为通用兜底 | 非 OpenCode 用户可能误解为通用能力 | 明确“OpenCode 优先 / 其他宿主需等价发现机制”；记忆兜底标注可选 | 是 | 文本审查 | 已验证 |
| A-22 | Git 历史 `ccda1dd` | High | 迁移提交包含 A-01/A-02 等个人内容；该提交尚未推送 | 一旦推送即进入公开历史；仅移除索引不能清除历史 | 发布前选择：重写历史 / 新建干净历史 / 确认不公开该提交；需人工决策 | 否 | `git log` / 人工 | 待人工确认 |
| A-23 | `docs/migration.md:31-40` | Medium | 回滚命令依赖已删除的私人 vault 源 | 公共用户无法回滚；文档失效 | 重写为通用安装/卸载说明 | 是 | 链接检查 | 已验证 |
| A-26 | `scripts/` | Medium | 新增/修改脚本无自动化测试 | 扫描器误报/漏报无法回归 | 新增 `scripts/tests/test-audit.sh`，使用虚构路径与假凭证 | 是 | 测试实跑 | 已验证 |
| A-27 | `scripts/audit.sh:report` | Medium | 报告默认包含被忽略快照；S003 邮箱原样输出 | 可能把个人邮箱写入公开报告 | 统一脱敏；报告只输出匹配片段；明确 `--all` 语义 | 是 | 自测断言无邮箱/密钥泄漏 | 已验证 |
| A-28 | `docs/design/overview.md:15`、`mvp-1:31` | Low | 设计文档把真实 `.state.md` 实例当作证据 | 公开后引用个人状态 | 改为“模板/脱敏示例” | 是 | 扫描 | 已验证 |
| A-29 | 多个脚本 | Info | `set -uo pipefail` 未启用 `-e` | 不是缺陷，但错误处理需显式 | 保持现状，工具内显式检查退出码；文档说明 | 否 | 静态审查 | 已验证 |
| A-30 | 全部 Shell 工具 | Medium | Windows 原生 CMD/PowerShell 不能直接执行 Bash 脚本 | 用户可能误以为全平台原生支持 | 明确支持 Git Bash/WSL；PowerShell 仅提供安装命令；不宣称 CMD 支持 | 是 | 文档矩阵 | 已验证 |

## 三、初始验证结果

| 检查 | 结果 | 说明 |
|---|---|---|
| `scripts/verify-symlinks.sh` | 通过（本机） | 23 PASS / 0 FAIL / 1 WARN（无关个人断链）；证明本机迁移状态良好，但不证明公共可移植性 |
| `skills/vibe-coder-loop/scripts/smoke-check.sh --quiet` | 通过 | HARD 0；依赖本机 delx-memory 与 pyyaml |
| `skills/skill-authoring/scripts/smoke-check.sh --quiet` | 通过 | HARD 0 |
| `python3 backup/test_memory_tool.py` | 通过 | 51 tests OK；macOS / Python 3.13.3 |
| `bash -n` 核心脚本 | 通过 | 语法通过不等于跨平台行为通过 |
| 凭证扫描 | 未发现可确认凭证 | 仍需人工确认；不宣称绝对安全 |
| 二进制/图片附件 | 未发现 | 跟踪文件均为文本 |
| CRLF/BOM | 未发现 | 现有文件 UTF-8/LF；缺 `.gitattributes` 保护 |
| 软链接 | 仓库内无软链 | 本机宿主软链均可达 |

## 四、修复计划（最小必要）

1. **先处理 Critical/High 隐私项**：从 Git 索引移除 `.state.md` 与 `skill_memory_latest.json`，保留本地文件；补 `.gitignore`；新增脱敏状态模板。
2. **路径与配置**：`backup/config.json` 改自动探测；`kernel/Vibe Coder.md` 改用户主目录表达；`docs/migration.md` 脱敏重写；`backup/README.md` 修正快照策略。
3. **跨平台脚本**：重写 `verify-symlinks.sh`；修复 `smoke-check-core.sh` 临时文件；新增 `.gitattributes`。
4. **审计工具**：重构 `scripts/audit.sh`，支持 `scan/check/report/verify/help`、TSV/JSONL、脱敏、稳定退出码、忽略规则；新增自测。
5. **文档**：重写 README；新增安装文档、兼容性矩阵、审计工具说明、变更清单、遗留风险、发布检查清单。
6. **清理内部名称**：仅替换示例/注释中的内部项目名，不改 Skill 规则语义；`CHANGELOG.md` 因 append-only 原则列入人工审核。
7. **回归**：运行全部已有测试 + 新增测试 + 复扫；记录未验证平台。

## 五、修复进度

> 更新于 2026-10-19；自动项已回归，人工项保持待确认。

- [x] A-01 快照取消跟踪并忽略（历史见 A-22）
- [x] A-02 Checkpoint 取消跟踪并忽略 + 模板（历史见 A-22）
- [x] A-03 配置去个人路径
- [x] A-04 Kernel 兜底路径可移植
- [x] A-05 迁移文档脱敏
- [x] A-06 软链校验可移植
- [x] A-07 smoke-check 临时文件可移植
- [x] A-08 备份文档隐私策略
- [x] A-09/A-10 忽略规则
- [x] A-11/A-12/A-28 内部名称与旧路径清理
- [ ] A-13 CHANGELOG 人工确认
- [x] A-14/A-26/A-27 审计工具与测试
- [x] A-15 `.gitattributes`
- [x] A-16/A-24 公共文档
- [x] A-17 状态模板
- [ ] A-18 LICENSE 人工确认
- [ ] A-19 未跟踪文件提交范围人工确认
- [x] A-21/A-30 宿主与平台边界
- [ ] A-22 Git 历史人工确认
- [x] A-23 回滚说明
- [x] A-25 Windows Python 命令

## 六、明确不做

- 不自动修改 Git 历史、不推送、不创建 Release。
- 不删除本地个人快照与状态文件，只取消 Git 跟踪。
- 不替项目所有者选择许可证。
- 不把 OpenCode 专属能力宣称为所有 Agent 通用。
- 不为“跨平台”引入不必要的服务、框架或运行时。
- 不重写 Skill 方法论、工作流阶段或调用契约。
