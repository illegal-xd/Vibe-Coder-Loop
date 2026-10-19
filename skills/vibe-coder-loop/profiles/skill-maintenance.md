---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Skill Maintenance — 技能/文档维护

> 任务入口路由卡。**Profile = Router**：仅聚合"本类任务需加载哪些模块"，不复制任何规则内容（Rules = Authority）。逐阶段文件清单 = `SKILL.md`「加载时机索引」；Level→激活阶段映射 = `engine/complexity-gate.md`「Loop Depth」矩阵（唯一事实源）。

**适用（判定特征，命中任一即本 Profile）**：
- 修改 vibe-coder-loop skill 文件（*.md / *.yaml / memory/ 分片 / profiles/）
- 修改 Vibe Coder Kernel（`raw/ai/agents/Vibe Coder.md`）或 obsidian raw/ai/ 文档
- 维护 `skill:` / `rule:` 记忆条目、backup 工具与快照

**任务分类**：E. Investigation（技能维护变体，常 Level 0-Doc 或 Standard）；记忆路由行 = 「技能/文档维护」强制召回（`memory/retrieval.md` 路由表：`rule:skill-iteration-manifest` + `lesson:skill-edit-date-residue` + `project:obsidian-vault-structure`，`memory_get` 精确 key）

**执行路径**：随改动规模走 Level 0-Doc（单文件文档修改）/ Standard（跨文件结构变更，本类任务多属后者）；规则内容修改时 S13 出口残留验证强制

**加载**：

Required:
- kernel.md（资产生命周期 + 反自改纪律）
- references/governance.md（本 skill **自身**骨架↔规则映射表 + canonical source 分类 + 下沉协议；**通用协议本体**在 `skill-authoring` skill 的 `governance-protocol.md`）
- engine/transition.md（S13 出口残留验证）
- CHANGELOG.md（迭代历史 + 版本规则：正文禁止日期/版本残留）
- manifest.yaml（版本号唯一事实源；本次变更统一合并当前版本号，未提交 git 不迭代）

Optional:
- `skill-authoring` skill（维护协议源：骨架化/canonical-source/下沉/fallback/残留验证纪律 + 自检脚本模板）
- learning/evolution.md（Skill Patch Proposal 机制——Agent 禁止自动修改 Skill，仅提案；**用户明确指令修改时豁免**，本 Profile 即处理用户指令场景）
- backup/README.md + backup/memory_tool.py（维护收尾：重新 backup + verify）
- learning/memory/architecture.md（分片事实源声明，改动协议前核对）
- **fresh-context 实测**（跨文件 / 跨层结构变更后，至少 1 次独立子 agent 按新文件走读一遍；主 agent 自查有熟悉性盲区，见 `lesson:fresh-context-subagent-validation`）

**出口纪律**：
- **反自改原则**：无用户明确指令禁止自动修改 Skill 文件（`learning/evolution.md` 核心原则）
- 版本策略：统一合并当前版本号（manifest.yaml `version`），未提交 git 期间不迭代；除非用户指定版本
- S13 残留验证（强制）——走 `bash scripts/smoke-check.sh --table`。**检查逻辑唯一事实源 = `skill-authoring/scripts/smoke-check-core.sh`**（本 Skill 的 `scripts/smoke-check.sh` 只是配置薄包装——不得在此复制检查逻辑）
  - **退出码即结论**：0 = 通过；1 = HARD 违规（必须修复后重跑）；2 = 仅预算超限；3 = 环境/用法错误
  - ① 日期/版本残留 → 必须 0 命中（`RESIDUAL_HIT`，HARD）
  - ② 死指针候选 → `DEAD_POINTER_CANDIDATE`，脚本输出候选；**已裁定为合法命中**的（节标题引用、机制自述行）记入 `DEAD_PTR_KNOWN` 白名单——键 = `文件::整行内容`，**双精确匹配**：内容或所在文件任一变动即重新成为候选；**跨文件复用不继承豁免**。这是**唯一**保留人工裁定的项——其余项已全部机械判定
  - ③ 映射一致性（`MAP_INCONSISTENT`，HARD）：映射表左列文件存在 + **声明的 `skill:*` key 真实存在** + **Canonical ≠ 数据 的条目 tags 含 `permanent`**（规则条目带 TTL = 到期静默降级）
  - ④ 加载计划一致性（`LOAD_PLAN_PATH_MISSING` / `LOAD_PLAN_UNDOCUMENTED`，HARD）：`load_plan.json` 内路径存在且被 `SKILL.md` 提及
  - ⑤ 行数预算（`BUDGET_EXCEEDED`，退出码 2）：**棘轮语义，只降不升**；确需上调须在 CHANGELOG 记明理由
- 收尾义务：`bash scripts/smoke-check.sh --table` 退出码 0 + backup 快照重新生成 + verify
