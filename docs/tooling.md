# 工具入口与调用约定（唯一事实源）

> **作用域**：本页只定义「何时用哪个入口 / 副作用边界 / 退出码 / 机器输出」。
> **参数、默认值、字段细节以各命令 `--help` 为准**，本页不复述参数表（防双源漂移）。
>
> 相邻事实源：Skill 运行时工具（`preflight` / `artifact` / `touch` / `metrics`）见
> `skills/vibe-coder-loop/SKILL.md`「运行时 Tool」；记忆数据分层见 `docs/memory-layers.md`；
> 公开面审计工具见 `docs/audits/audit-tool.md`；模块边界与设计取舍见 `docs/design/`。

## 1. 入口选择

> `python3 -m runtime.*` 须在**仓库根目录**执行（或设 `PYTHONPATH=<repo>`）；`--cwd` 指被操作的项目，不是包位置。

| 场景 | 入口 | 副作用 |
|---|---|---|
| 状态读取 / 阶段转换 / 恢复 / 失败指纹 | `python3 -m runtime.core <cmd> --cwd <project_root>` | `get-state` / `snapshot-task-zone` / `state check` / `check-protocol` 只读；`transition` / `feed-exec` / `repeat-check` 写 Checkpoint（delx-memory）；`load-checkpoint` 正常只读，检测到损坏会归档并清空主条目，`--import-legacy` 写库；`state gc` 默认执行（`--dry-run` 预览），`status=active` 时拒绝，删除超过保留期且未被 pinned 引用的 `.log` artifact |
| 受控命令执行 / 改动汇总 / 非 git 基线 | `python3 -m runtime.exec run\|diff\|baseline` | `run` 执行命令（副作用由被调用命令决定），超限且 `--externalize` 时写 artifact；`diff` 汇总改动，但非 git / 无提交 / `--base` 无效时**首次会创建基线快照**（写 `~/.vibe-loop/baseline/`）；`baseline` 显式建立/刷新同一基线（`VIBE_KERNEL_BASELINE_DIR` 可覆盖） |
| 反思信号（P1-1） | `python3 scripts/memory/reflection_signals.py record\|evaluate\|list` | 仅 `record` 写 `signal:*`；`evaluate` / `list` 只读 |
| 记忆效用观测（P1-2） | `python3 scripts/memory/memory_feedback.py record\|report\|verify` | 仅 `record` 写 `feedback:*`；`report` / `verify` 只读 |
| Skill 草稿（P1-3） | `python3 scripts/memory/skill_draft.py scan\|generate` | `scan` 只读；`generate` **默认写** `reports/skill-drafts/`（gitignore），预览加 `--dry-run` |
| 记忆运维 | `python3 scripts/memory/memops.py validate\|search\|repair\|split` | `validate` / `search` 只读；`repair` / `split` **默认 dry-run**，`--apply` 才写且自动备份 |
| Skill 运行时（加载计划 / 回写 / 外置） | `python3 skills/vibe-coder-loop/backup/memory_tool.py preflight\|touch\|metrics\|artifact\|backup\|restore\|verify\|list\|check-keys\|export-rules` | `preflight` / `list` / `verify` / `check-keys` 只读；`touch` / `metrics` / `restore` 写库；`backup` / `export-rules` / `artifact put` 写文件；`artifact page` 读文件；`artifact release` **删除产物目录**（不可逆；Checkpoint 仍在引用的 ref 会失效）；`restore` / `export-rules` 支持 `--dry-run` |
| 记忆迁移 / 审计 / 蒸馏 | `python3 scripts/memory/{migrate,audit_memory,distill}.py` | `distill` / `audit_memory` 只读库（`--out-*` 写报告）；`migrate` 默认 dry-run，但仍会写冻结计划 `.plan-*.json` 到 `--backup-dir`；`--apply` 写库并备份；`--restore` 需 `--yes` |
| 查看器数据导出 | `python3 scripts/memory/export_viewer_data.py` | 只读 SQLite（`mode=ro`），写 `tools/memory-viewer/memory-data.json`（gitignore） |
| OpenCode 上下文裁剪（可选） | `.opencode/plugins/vibe-context-dedup.js`（宿主自动加载；测试用 `node --test tests/context-dedup/*.test.mjs`） | 改本次模型请求的 `output.messages`（Dedup: `state.output`；Error Purge: `state.error`），以及工具 hook 的工具描述 / read 输出 / `edit` 行区间（Slim Edit）；不写会话存储；日志写 `~/.vibe-loop/context-dedup/events.jsonl` 与 `~/.config/opencode/token-usage/token-usage-YYYY-MM-DD.jsonl` |
| 公开面审计 | `bash scripts/audit.sh scan\|check\|report\|verify` | 默认只读；`report` 写 Markdown；契约见 `docs/audits/audit-tool.md` |
| 软链校验 | `bash scripts/verify-symlinks.sh [--host]` | 只读 |
| Skill 自检 | `bash skills/vibe-coder-loop/scripts/smoke-check.sh` | 只读 |

## 2. 统一约定（已实现，勿各自发明）

- **机器输出**：`reflection_signals` / `memory_feedback` / `skill_draft` / `memops` 用 `--json`；`migrate` / `distill` / `audit_memory` 用 `--out-json` / `--out-md` 落文件；`audit.sh scan` 用 `--format=json`；默认人读文本。`--pretty` 只改缩进，不改字段。
- **JSON 形态不统一（据实）**：`runtime.core` 除 `snapshot-task-zone`（输出文本）外均为 JSON，成功/失败都带 `ok` + `code`，降级任务区以 `[runtime] ...` 开头；`runtime.exec run` 的失败信封字段是 `vc_code`；`exec diff` 的计划漂移以退出码 4 表达，输出是 `DiffSummary`（无 `ok`/`code`）。
- **错误输出位置**：P1 脚本把原因写 stderr；`memops` / `migrate` / `memory_tool.py` 的人读提示多写 stdout —— 诊断时两处都要看，不能只 grep stderr。
- **失败不静默**：失败必须非零退出，不以 `ok=true` 掩盖。
- **写操作先预览**：`memops repair/split --dry-run`、`skill_draft generate --dry-run` 先看计划；`state gc` 例外——默认执行，预览需显式 `--dry-run`。
- **参数错误即失败**：缺必填参数返回 2，不退化为「默认值 + 成功」（例：`reflection_signals evaluate` 缺 `--task-id` → 2）。
- **不联网**：以上工具均不访问网络；不读取工作区之外的业务数据（记忆库路径例外，可用 `--db` / `DELX_MEMORY_DB` 显式指定）。

### 退出码

| 入口 | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| `runtime.core` | 成功 | — | 参数错误 | `check-protocol` 不一致 | 运行时错误 / 降级 / fail-closed 拒绝 |
| `runtime.exec` | 成功 | — | 参数错误 | — | 运行时错误 / 范围拒绝 / 计划漂移 |
| `reflection_signals` | 已给出判定 | — | 参数错误 | 记忆库异常 | — |
| `memory_feedback` | 成功（含空结果） | `verify` 发现错误 | 参数错误 | 记忆库异常 | — |
| `skill_draft` | 成功（含 deferred / no-op） | 自检失败 | 参数错误 | 记忆库异常 | — |
| `memops` | 成功（含 dry-run） | `validate` 有错误 / 运行异常 | 参数错误 | — | — |
| `distill` / `audit_memory` / `export_viewer_data` | 成功 | 数据库不可用 / IO 异常 | 参数错误 | — | — |
| `memory_tool.py` | 成功（含 no-op / dry-run） | 校验失败 / 无源数据 / 恢复被拒 / 写库失败 | 参数错误或库路径不可用 | 规则库缺失、参数值非法、artifact 读写失败 | artifact ref 不存在/过期；`check-keys` 缺 key；脱敏残留或漂移 |
| `audit.sh` / `verify-symlinks.sh` | 通过 | 失败 / 发现 | 参数错误 | — | — |
| `smoke-check.sh` | 通过 | 检查失败 | 预算超限 | 规则库 / 核心脚本缺失 | — |

> `reflection_signals` / `memory_feedback` / `skill_draft` 在记忆库**缺失**时按设计降级为 `decision=unavailable` / 空报告，退出码仍为 0（不阻塞工程循环）；只有库损坏等异常才返回 3。

## 3. 已知不统一项（保留，不改造的理由）

| 现象 | 保留理由 |
|---|---|
| `--json` 与 `--format=json` 并存 | `audit.sh` 的格式参数早于记忆脚本，且被基线与自测依赖；改名会破坏既有调用 |
| `python3 -m runtime.core`（必须模块方式）vs `python3 scripts/memory/*.py`（独立脚本） | `runtime` 包用相对导入，直接执行 `runtime/core/cli.py` 会 `ImportError`；`scripts/memory/*` 通过 `sys.path` 自举，可直接执行。两者都能用，强行统一需新增分发层 |
| 子命令层级深浅不一 | `runtime.*` 有 2 级（`state check`），记忆脚本 1 级；差异来自职责复杂度，不为形式统一增加空壳子命令 |

> 结论：**不引入统一 CLI 包装层**。新增 `vibe ...` 需额外的分发代码、兼容层与文档，而每次调用只省个位数 token；现有入口已满足「帮助 + 参数校验 + 稳定退出码 + 机器输出」。

## 4. 回归命令

```bash
python3 -m unittest discover -s tests -q
bash scripts/tests/test-memory-layers.sh
bash scripts/tests/test-runtime-core.sh
bash scripts/tests/test-runtime-exec.sh
bash scripts/tests/test-audit.sh
bash scripts/tests/test-context-dedup.sh
bash scripts/verify-symlinks.sh
```
