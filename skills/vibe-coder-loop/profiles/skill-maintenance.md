---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Skill Maintenance — 技能/文档维护

> Router 卡：只列**本类差异项**。公共加载集见 `SKILL.md`「加载时机索引」与「分级加载」；机器版 = `load_plan.json` `profiles.skill-maintenance`。

**适用**：修改 vibe-coder-loop skill 文件 / `kernel/Vibe Coder.md` / 本仓库文档 / `skill:`·`rule:` 条目与 backup 快照
**任务分类**：E（技能维护变体，多为 Level 0-Doc 或 Standard）；记忆路由行 = 「技能/文档维护」**强制召回** `rule:skill-iteration-manifest` + `lesson:skill-edit-date-residue`

**执行路径**：单文件文档 → Level 0-Doc；跨文件结构变更 → Standard；规则内容修改时 S13 残留验证强制

**公共 Required:** kernel + engine + policy + `learning/memory/retrieval.md`（S2 召回）+ `learning/memory/lifecycle.md`（回写契约）+ `learning/skill-metrics.md`（S13 仪表盘）+ 逐阶段文件 —— 见 `SKILL.md`「加载时机索引」
**本类 Required（增补）:** `references/governance.md`（映射表/canonical 分类）、`CHANGELOG.md`（迭代历史）、`manifest.yaml`（版本号唯一源）、`backup/README.md`、`skill-authoring` skill（维护协议源）

**出口纪律**
- **反自改**：无用户明确指令不改 Skill 文件（`learning/evolution.md` 核心原则）
- **版本策略**：统一合并当前 `manifest.yaml` version，未提交 git 期间不迭代；正文禁止日期/版本残留
- **S13 残留验证（强制）**：`bash scripts/smoke-check.sh --table`（cwd = Skill 根），退出码 0 = 通过 / 1 = HARD 违规 / 2 = 预算超限 / 3 = 环境错误
  - ① 日期/版本残留必须 0 命中 ② 死指针候选：合法命中记入 `DEAD_PTR_KNOWN`（键 = `文件::整行`，双精确匹配，跨文件不继承）③ 映射一致性：key 真实存在 + 规则条目 tags 含 `permanent` ④ 加载计划路径存在且被 SKILL.md 提及 ⑤ 行数预算**只降不升**
- 收尾：smoke-check 通过 + backup 快照重建 + verify
- 跨文件/跨层结构变更后至少 1 次 fresh-context 子 agent 走读（主 agent 自查有熟悉性盲区）
