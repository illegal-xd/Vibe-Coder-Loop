# 发布前检查清单

- 适用：将本仓库公开或推送到公共远端前。
- 关联：[审计报告](2026-10-19-open-source-readiness.md)、[变更清单](change-list.md)、[遗留风险](residual-risks.md)、[兼容矩阵](compatibility.md)。
- 用法：逐项勾选；任一“阻断”项未完成，不发布。

## 一、人工决策（阻断）

- [ ] **LICENSE**：已由项目所有者选择并添加 `LICENSE` 文件；README 许可证段落与之一致。
- [ ] **Git 历史**：已确认 `ccda1dd` 的处置（重写 / 干净历史 / 不公开），并验证历史中不含个人快照或 `.state.md`：
      `git log --all --oneline`、`git rev-list --objects --all | grep -E 'state\.md|skill_memory_latest'`
- [ ] **CHANGELOG**：已人工复核内部项目代号、会话事故、个人工作细节；决定保留/裁剪/脱敏。
- [ ] **提交范围**：已按 `change-list.md` 第八节分组选择文件；未跟踪文件不会被全量 `git add .` 误带入。
- [ ] **公开范围**：确认 `docs/design/*` 是否随仓库公开；如公开，标注为“设计稿/未实现”。

## 二、工作区与隐私（阻断）

- [ ] `git status --short` 中不包含 `.state.md`、`backup/snapshots/*.json`、`scan-report.local.*`、`.env`。
- [ ] `git ls-files` 不含个人状态/快照：
      `git ls-files | grep -E '(^|/)\.state\.md$|skill_memory_.*\.json|scan-report\.local'`（应无输出）
- [ ] 本地 `.state.md`、快照仍存在但被忽略（文件保留，不删除）：
      `git check-ignore -v skills/vibe-coder-loop/.state.md skills/vibe-coder-loop/backup/snapshots/skill_memory_latest.json`
- [ ] 仓库内无个人绝对路径、邮箱、私有 IP、真实凭证（允许 H002 info）：
      `bash scripts/audit.sh scan --fail-on=high`（rc=0）
- [ ] 被 Git 跟踪的文件中无敏感运行时/快照：
      `bash scripts/audit.sh check --fail-on=high`（rc=0）
- [ ] 未使用 `git add -f` 强制加入被忽略文件。
- [ ] 如曾生成审计报告，确认 `docs/audits/scan-report.md` 已脱敏且不含本机路径。

## 三、文档与链接（阻断）

- [ ] README 的结构树与实际目录一致（`docs/audits/compatibility.md` 等路径存在）。
- [ ] README 引用的文档全部存在：`installation.md`、`migration.md`、`compatibility.md`、`audit-tool.md`、`change-list.md`、`residual-risks.md`、`release-checklist.md`。
- [ ] 安装文档中的 macOS/Linux/Windows 命令可复制执行；PowerShell 段落不暗示原生支持 Bash。
- [ ] 兼容矩阵明确“已验证/静态审查/不支持”，且不把 OpenCode/Pi 专属能力写成通用能力。
- [ ] 备份文档明确快照禁止提交；迁移只走本机或私有通道。
- [ ] `.gitattributes` 已包含 `*.sh text eol=lf`、Python/Markdown/YAML 的 LF 策略。
- [ ] 版本号/日期/文档索引无内部任务 ID、私人 vault 名、内部项目名。

## 四、自动化回归（阻断）

在仓库根执行：

```bash
bash -n scripts/audit.sh scripts/verify-symlinks.sh scripts/tests/test-audit.sh
bash scripts/verify-symlinks.sh
bash scripts/verify-symlinks.sh --host
bash skills/vibe-coder-loop/scripts/smoke-check.sh --quiet
bash skills/skill-authoring/scripts/smoke-check.sh --quiet
python3 skills/vibe-coder-loop/backup/test_memory_tool.py
bash scripts/tests/test-audit.sh
bash scripts/audit.sh scan --fail-on=high
bash scripts/audit.sh check --fail-on=high
```

- [ ] 以上命令全部 rc=0（smoke-check 若因未安装宿主依赖失败，记录原因并确认不是脚本回归）。
- [ ] `test-audit.sh`：43 PASS / 0 FAIL。
- [ ] `test_memory_tool.py`：51 tests OK。
- [ ] `verify-symlinks.sh`：仓库无断链；`--host` 无断链（未安装宿主时仅 info/warn）。
- [ ] `scan/check --fail-on=high`：无 critical/high；H002 info 已人工确认。
- [ ] 如修改了审计规则/检查项，已同步 `docs/audits/audit-tool.md` 与自测。

## 五、跨平台（发布前至少完成一项）

- [ ] **macOS**：已实跑（当前基线）。
- [ ] **Linux**：在干净环境跑第四节命令；确认 `grep -E`、`sed -E`、`find -print0`、`xargs -0`、`mktemp` 行为一致。
- [ ] **Windows Git Bash 或 WSL**：跑第四节命令；确认路径含空格、CRLF、Python 命令名（`python`/`python3`）无问题。
- [ ] 未验证平台已在 `docs/audits/compatibility.md` 中标注，而不是宣称支持。

## 六、提交与发布

- [ ] 提交信息不含个人路径/内部项目名。
- [ ] 提交后再次执行 `git ls-files` 与 `git status` 检查。
- [ ] 推送前确认远端为预期仓库，且没有误推其他分支/标签。
- [ ] 如创建 Release：说明支持范围（macOS/Linux/Git Bash/WSL）、未实现能力（Core/Exec/Adapter）、许可证。
- [ ] 发布后检查仓库首页渲染、相对链接、代码块复制按钮行为。
- [ ] 发布后轮换/撤销任何曾暴露的凭证（本仓库当前未发现可确认凭证；若有遗漏，按事故处理）。

## 七、回滚

- [ ] 发布前记录当前提交：`git rev-parse HEAD`。
- [ ] 若发现泄露：立即将仓库设为私有/删除公开内容，按 `residual-risks.md` A-22 处理历史，再评估凭证轮换。
- [ ] 本地个人文件不因回滚删除；只回退 Git 提交与远端状态。
