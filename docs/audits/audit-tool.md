# 审计工具说明（scripts/audit.sh）

- 版本：1.0.0
- 性质：只读扫描 + 显式报告生成；不访问网络，不修改 Git 索引，不读取 Git 历史。
- 适用：macOS / Linux / Windows Git Bash / WSL；Bash 3.2+。
- 依赖：`git`（可选，非 Git 目录降级为文件系统扫描）、`grep`、`sed`、`awk`、`find`、`sort`、`comm`、`xargs`、`mktemp`。不使用 `grep -P`、`mapfile`、关联数组或非 POSIX 的链接解析选项。

## 一、命令

```bash
bash scripts/audit.sh [--root <dir>] <command> [options]
```

| 命令 | 作用 | 是否写文件 |
|---|---|---|
| `scan` | 文本扫描个人路径、宿主路径、私有 IP、邮箱、凭证形态、非 POSIX 命令 | 否 |
| `check` | 仓库/宿主软链、断链、Markdown 相对链接、被 Git 跟踪的敏感文件 | 否 |
| `report` | 生成 Markdown 报告（默认 `docs/audits/scan-report.md`） | 是（或 `--out -`） |
| `verify` | 与基线比对；新增 critical/high 退出 1 | 否 |
| `rules` | 列出规则编号、严重度、范围 | 否 |
| `help` | 帮助 | 否 |
| `version` | 版本 | 否 |

## 二、scan

```bash
bash scripts/audit.sh scan
bash scripts/audit.sh scan --format=json
bash scripts/audit.sh scan --min-severity=high
bash scripts/audit.sh scan --fail-on=high
bash scripts/audit.sh scan --all
```

输出格式（TSV，冒号分隔）：

```text
path:line:rule:severity:reason
```

JSONL 字段：

```json
{"path":"relative/path.md","line":12,"rule":"P001","severity":"high","reason":"..."}
```

`reason` 已脱敏：用户名替换为 `<user>`，邮箱替换为 `<email>`，私有 IP 替换为 `<private-ip>`，凭证值不输出；`path` 为仓库相对路径。路径本身若含冒号，解析可能不准确（已知限制）。

### 规则

| 规则 | 严重度 | 检测 |
|---|---|---|
| P001 | high | `/Users/<name>`、`/home/<name>` |
| P002 | high | `Desktop/`、`Documents/`、`Downloads/` |
| P003 | high | `C:\Users\...` |
| P005 | medium | `\\wsl$\...`、`\\Users\...` |
| P006 | low | UNC `\\server\share`（排除常见本地转义路径） |
| P007 | high | `/root/` |
| H001 | medium | `~/.pi/agent` |
| H002 | info | 宿主/运行时引用（如 Pi），需确认适配范围 |
| S001 | critical | 常见 API Key / Token / 私钥形态；值不输出 |
| S002 | medium | 私有 IPv4（10/8、192.168/16、172.16/12） |
| S003 | high | 邮箱地址 |
| L001 | low | 非 POSIX 的 `readlink` 解析选项 |

`scan` 默认扫描：

- Git 跟踪文件；
- 未忽略的未跟踪文件；
- 不扫描 `.git/`、`node_modules/`、`dist/`、`build/`、`__pycache__/`、运行时 `.state.md`、记忆快照、生成的 `scan-report.md`。

`--all` 额外扫描被 `.gitignore` 忽略的文件，但运行时状态与快照仍排除，避免把个人数据写入输出。

### 退出码

- `0`：成功；`--fail-on` 未命中。
- `1`：`--fail-on` 命中。
- `2`：参数错误、临时文件失败、未知严重度/格式。

## 三、check

```bash
bash scripts/audit.sh check
bash scripts/audit.sh check --fail-on=high
bash scripts/audit.sh check --format=json
```

检查项：

| 规则 | 严重度 | 说明 |
|---|---|---|
| C001 | low | 仓库内跟踪的软链接（信息） |
| C002 | high | 仓库内断链 |
| C003 | high | 宿主软链接目标不存在 |
| C004 | low | 宿主路径存在但不是软链（复制安装可忽略） |
| C005 | info | 宿主 Skill/Prompt 未安装 |
| C006 | low | Markdown 相对链接目标不存在 |
| C007 | info | 未检测到宿主目录 / HOME 未设置 |
| C008 | high | 敏感运行时/凭证文件被 Git 跟踪 |
| C009 | high | 记忆快照被 Git 跟踪 |
| C010 | info | 非 Git 工作区，跳过跟踪面检查 |
| C011 | info / high | 本机脱敏规则集不存在（info：未生成，规则内容按隐私约束不入库）／存在但含个人路径（high：应导出为 `~` / `<USERPROFILE>`） |
| C012 | high | Checkpoint 存储契约漂移：协议未声明 delx-memory key `vc:checkpoint:`、协议回退到项目内 `.vibe-kernel/.state.md`，或 runtime 仍创建项目内状态目录 |

宿主目录可用环境变量覆盖：

```bash
AGENTS_SKILLS_DIR=/path/to/agents/skills \
OPENCODE_SKILLS_DIR=/path/to/opencode/skills \
OPENCODE_AGENTS_DIR=/path/to/opencode/agents \
  bash scripts/audit.sh check
```

Markdown 检查只处理未被忽略的 `.md`，跳过代码围栏内的内容；不解析 HTML、引用式链接、URL 编码或大小写不敏感路径。

## 四、report

```bash
bash scripts/audit.sh report
bash scripts/audit.sh report --out docs/audits/scan-report.md
bash scripts/audit.sh report --out -
```

报告包含：生成时间（UTC）、仓库目录名（不含绝对路径）、工具版本、扫描范围、严重度汇总、最多 50 条发现（按严重度排序）、限制说明。报告中的匹配文本同样脱敏。

`report` 会执行 `scan --all` 与 `check`，因此可能包含运行时/快照检查结果（但不会读取快照内容）。默认输出文件已被扫描排除，避免报告自身被下一轮扫描。

## 五、verify

```bash
# 1. 生成基线（默认 text 输出；不要用 --min-severity 过滤）
bash scripts/audit.sh scan > docs/audits/baseline.local.tsv

# 2. 修改后比对
bash scripts/audit.sh verify -b docs/audits/baseline.local.tsv
```

行为：

- 基线允许以 `#` 开头的注释行；空行忽略；比较前去除 CR。
- 新增 critical/high → 退出 1，并在 stderr 列出前 20 条。
- 新增 medium/low/info 或发现消失 → 退出 0，仅输出计数。
- 基线应与当前仓库根目录的相对路径一致；换根目录会导致全部显示为新增/消失。

## 六、自测

```bash
bash scripts/tests/test-audit.sh
```

覆盖：规则命中、脱敏、JSONL、严重度过滤、`--fail-on`、`check` 的 C003/C006/C008/C009/C010/C011/C012、**大文件规模回归**（1500 行 + 围栏内外链接，20s 看门狗，防「逐行 fork」性能/崩溃回归）、`verify` 新增高危、`report` stdout、参数错误。测试使用临时目录与运行时拼接的虚构样例，不接触真实数据库/凭证。

## 七、已知误报与限制

- **只做文本匹配**：不解析 AST、不追踪变量拼接、不读取压缩包/二进制/加密内容。
- **不扫描 Git 历史**：历史中的个人内容需单独处理。
- **路径含冒号/换行**：TSV 解析可能不准确；报告按冒号切分字段。
- **Markdown 链接**：只识别内联链接形式；不处理引用式链接、HTML `<a>`、URL 编码、锚点目标文件。
- **邮箱/私有 IP**：可能误报示例文档；也可能漏报拆分写法（如 `user [at] example`）。
- **凭证**：只覆盖常见形态；命名变量、编码/加密内容可能漏报；S001 不输出匹配值。
- **H002**：`Pi` 等运行时引用是提示，不是缺陷；需要人工确认适配边界。
- **宿主检查**：默认不要求安装；`--host` 缺失只产生 info/warn，断链才是 high。
- **不替代人工审查**：未检出 ≠ 安全；发布前仍需人工检查许可证、历史、第三方内容与业务语义。

## 八、维护

- 新增规则：修改 `RULES`，同步 `rules` 输出与本文件；为规则增加自测样例。
- 新增 check 项：修改 `check_*` 函数与 `CHECK_RULES`，同步本文件。
- 保持 `LC_ALL=C`、Bash 3.2 语法、无网络、无第三方依赖。
- 如果规则正则本身包含会被扫描的字符串，记得在 `scan_one_rule` 中对 `scripts/audit.sh` 做自排除（现有 P003/P005/P006/P007/H001/L001 已处理）。
