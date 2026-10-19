# 迁移记录：obsidian → Vibe Kernel 项目

**日期**：2026-10-19
**操作者**：Vibe Coder Agent（用户任务：演进为个人 Vibe Kernel）

## 一、迁移映射

| 资源 | 源路径（obsidian） | 目标路径（本项目） | 文件数 | 完整性 |
|---|---|---|---|---|
| Agent Prompt | `raw/ai/agents/Vibe Coder.md` | `kernel/Vibe Coder.md` | 1 | md5 一致 |
| Skill: vibe-coder-loop | `raw/ai/skills/vibe-coder-loop/` | `skills/vibe-coder-loop/` | 69† | md5 一致 |
| Skill: delx-memory-protocol | `raw/ai/skills/delx-memory-protocol/` | `skills/delx-memory-protocol/` | 3 | md5 一致 |
| Skill: skill-authoring | `raw/ai/skills/skill-authoring/` | `skills/skill-authoring/` | 6 | md5 一致 |

† vibe-coder-loop 源 70 文件，迁移 69（排除 `backup/__pycache__/memory_tool.cpython-313.pyc` 机器缓存，可重新生成）。`.state.md`（含未提交工作区状态）与 19 个 `backup/snapshots/` 快照均保留。

**复制方式**：`rsync -a --exclude='__pycache__' --exclude='.DS_Store'`，保留元数据。obsidian 原始资源**未删除**（遵循「不擅自删除原始资源」原则），但因软链重指已不再是运行时引用的副本。

## 二、软链变更清单

| 软链路径 | 原目标 | 新目标 |
|---|---|---|
| `~/.agents/skills/vibe-coder-loop` | `…/obsidian/raw/ai/skills/vibe-coder-loop` | `…/Vibe-Coder-Loop/skills/vibe-coder-loop` |
| `~/.agents/skills/delx-memory-protocol` | `…/obsidian/raw/ai/skills/delx-memory-protocol` | `…/Vibe-Coder-Loop/skills/delx-memory-protocol` |
| `~/.agents/skills/skill-authoring` | `…/obsidian/raw/ai/skills/skill-authoring` | `…/Vibe-Coder-Loop/skills/skill-authoring` |
| `~/.config/opencode/agents/Vibe Coder.md` | `…/obsidian/raw/ai/agents/Vibe Coder.md` | `…/Vibe-Coder-Loop/kernel/Vibe Coder.md` |
| `~/.config/opencode/skills/{三 skill}` | 相对 → `~/.agents/skills/<name>` | **未改动**（链路自动解析到新项目） |

替换方式：`ln -sfn`（原子覆盖，可回滚——回滚命令见下）。

## 三、回滚

```bash
# 恢复软链原目标
ln -sfn /Users/allen/Documents/webDev/obsidian/raw/ai/skills/vibe-coder-loop ~/.agents/skills/vibe-coder-loop
ln -sfn /Users/allen/Documents/webDev/obsidian/raw/ai/skills/delx-memory-protocol ~/.agents/skills/delx-memory-protocol
ln -sfn /Users/allen/Documents/webDev/obsidian/raw/ai/skills/skill-authoring ~/.agents/skills/skill-authoring
ln -sfn "/Users/allen/Documents/webDev/obsidian/raw/ai/agents/Vibe Coder.md" "$HOME/.config/opencode/agents/Vibe Coder.md"
# 项目内文件为新增提交，git revert 即可
```

## 四、内部引用分析

### 操作性路径（运行时解析）——全部仍有效，零编辑
- `skills/vibe-coder-loop/scripts/smoke-check.sh` 与 `skills/skill-authoring/scripts/smoke-check*.sh` 引用 `$HOME/.agents/skills/skill-authoring/scripts/smoke-check-core.sh` → 经重指软链解析到本项目。✅
- `kernel/Vibe Coder.md` 兜底路径 `/Users/allen/.agents/skills/<name>/SKILL.md` → 经重指软链解析到本项目。✅
- `kernel/Vibe Coder.md` 记忆兜底 `delx-memory_memory_get key=agent:vc_constraints` → 不受路径影响。✅

### 描述性指针（历史/人读）——留待后续清理，本次不改
以下文件含 `raw/ai/agents/Vibe Coder.md` / `raw/ai/` 等描述性路径（人读指针，非运行时解析）：
- `skills/vibe-coder-loop/SKILL.md`（路由表项）
- `skills/vibe-coder-loop/profiles/skill-maintenance.md`
- `skills/vibe-coder-loop/learning/memory/retrieval.md`
- `skills/vibe-coder-loop/engine/transition.md`
- `skills/vibe-coder-loop/CHANGELOG.md`（**append-only，永不重写**）
- `skills/vibe-coder-loop/backup/archive/SPLIT_PLAN.md`（归档）

**决定**：依「不将迁移变成 Skill 重写」「不擅自改变原有语义」原则，本次零内容编辑。描述性指针陈旧为已知问题，留待后续 skill 迭代时统一更新（走 `rule:skill-iteration-manifest` 流程，记 CHANGELOG）。

## 五、未在本仓库 but 受影响的本机资源

### `~/.pi/agent/AGENTS.md`（Pi Runtime 全局 Prompt）
- 不在本次迁移清单内（任务范围外）。
- 为**常规文件**（非软链），是 obsidian `Vibe Coder.md` 的 **Pi 适配版**（内容不同：`Pi Global Context` 标题、无 frontmatter、有 Pi 专属节）。
- 含描述性引用「软链：`~/.config/opencode/skills/<name>` → `~/.agents/skills/<name>` → obsidian 源」——「obsidian 源」措辞现已陈旧，但操作性兜底路径 `/Users/allen/.agents/skills/<name>/SKILL.md` 仍有效。
- **待人工确认**：是否将 Pi 全局 Prompt 也统一进本仓库（因内容与 `Vibe Coder.md` 不同，不能简单软链，需另行决策）。

### delx-memory 条目 `agent:vc_constraints`
- 含描述性路径「obsidian `Documents/webDev/obsidian/raw/ai/skills/vibe-coder-loop/`」——现已陈旧。
- 操作性兜底 `/Users/allen/.agents/skills/vibe-coder-loop/SKILL.md` 仍有效。
- **待人工确认**：是否更新该记忆条目的描述性路径措辞。

## 六、验证结果

见 `scripts/verify-symlinks.sh` 输出（下一步执行）。
