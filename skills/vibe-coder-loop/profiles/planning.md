---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Planning — 规划/设计先行/编排型任务

> 任务入口路由卡。**Profile = Router**：仅聚合"本类任务需加载哪些模块"，不复制任何规则内容（Rules = Authority）。逐阶段文件清单 = `SKILL.md`「加载时机索引」；Level→激活阶段映射 = `engine/complexity-gate.md`「Loop Depth」矩阵（唯一事实源）。

**适用（判定特征，命中任一即本 Profile）**：
- 大需求/多模块任务：Plan 阶段产出编排决策（模式 + 角色映射）
- 架构设计先行（D. Architecture 设计产出，不随代码落地）
- 多 subagent 派发 / 混合编排（主 agent + subagent 分工）
- S5 Clarify / S6 Design 高权重任务（需求模糊、多约束、跨页面/模块镜像）

**任务分类**：D. Architecture（设计产出）/ A-E 混合多模块；记忆路由行 = 「架构/重构」或「技能/文档维护」视内容（`memory/retrieval.md` 路由表）

**执行路径**：全阶段 S1-S13（Standard/Full Loop）；规划产出后转执行 profile（编码类落地 → `coding.md`）

**加载**：

Required:
- kernel.md + policy/safety.md + policy/priority.md（冲突仲裁优先级）
- engine/state-machine.md（S5-S7 出口）+ engine/transition.md
- rules/intent.md（S1）+ rules/design.md（S6）+ rules/plan.md（S7 五要素 Step + 编排决策）
- engine/skill-routing.md（**仅存在能力缺口的 Step** 才绑定能力载体）

Optional:
- rules/orchestration.md（多 subagent 编排决策 + 角色人格化映射）
- engine/complexity-gate.md（Level 3/4 高风险升级判定）
- rules/review.md（规划产出物走 Review 时）
- learning/memory/architecture.md（跨模块记忆网络挂载，S2）

**出口纪律**：
- Plan 未引用 Design 模块划分 / 未声明完成判据 → 回退，禁止提前进入 Code
- 编排决策必须输出：模式 + 判断依据 + 角色映射 + Confidence/Evidence
- 大需求任务不立即编码——Clarify/Design 阶段追问与设计优先于实现冲动
