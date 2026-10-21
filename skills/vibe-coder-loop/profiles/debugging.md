---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Debugging — 调试/缺陷排查

> 任务入口路由卡。**Profile = Router**：仅聚合"本类任务需加载哪些模块"，不复制任何规则内容（Rules = Authority）。逐阶段文件清单 = `SKILL.md`「加载时机索引」；Level→激活阶段映射 = `engine/complexity-gate.md`「Loop Depth」矩阵（唯一事实源）。

**适用（判定特征，命中任一即本 Profile）**：
- 用户粘贴错误信息/堆栈跟踪 → 触发调试模式（`kernel.md` 暂停条件 3 + `references/debug-mode.md`）
- 行为异常：功能不工作/结果错误/回归失败，需先定位根因再修复
- 测试失败反复（Test 回退 Code 循环）

**任务分类**：A. Direct Action（调试变体）；记忆路由行 = 「编码/调试」（`memory/retrieval.md` 路由表）

**执行路径**：
- Level 1（单点 bug）：S1 → S2 → S4 → S8 → S9 → S10（Test 失败 → Lesson 保存 → 回退 Code[N+1]，不进 Review）
- Level 2+（跨模块缺陷/架构级根因）：全阶段 S1-S13；回退路径 S10 情况 A/B 按 `engine/transition.md`

**加载**：

Required:
- kernel.md（调试模式触发条件 + 双队列契约）
- engine/state-machine.md + engine/transition.md（S1 Checkpoint + S8→S9 回退规则 + S9 串行门控）+ engine/complexity-gate.md + engine/router.md（S4 分级 + Loop 选择）
- policy/safety.md + policy/confidence.md（Evidence 标注强制）+ policy/lifecycle.md（资产归档）
- rules/intent.md（S1 目标三元组）+ rules/test.md（S9 验证 + 降级条款）→ rules/code.md（S8 修复）→ rules/review.md（S10，L1+）
- learning/memory/lifecycle.md（「Test→Lesson 学习闭环」：失败先存 lesson 再回退）+ learning/memory/retrieval.md（同类失败模式召回）
- learning/memory/promotion.md（S12 收尾）+ learning/skill-metrics.md（S13 仪表盘）

Optional:
- references/debug-mode.md（调试模式触发时）
- engine/skill-routing.md（systematic-debugging 等调试类 Skill 绑定）
- learning/reflection.md（S11 触发判定：解决复杂 Bug / 同类错误重复 ≥2 次）

**出口纪律**：
- 修复前必须先输出根因（Evidence ≥ E2），禁止"猜测-试错"循环；连续三轮未定位 → 停止迭代，点出可能错误的假设，输出一个诊断问题
- Test 失败 → 先保存 `lesson:{主题}`（即时写入）→ 再回退 Code[N+1]
- Quick Loop（L1）回退仅 1 轮上限，仍不通过 → 建议升级 Standard Loop
