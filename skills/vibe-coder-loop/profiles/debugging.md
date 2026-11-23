---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Profile: Debugging — 调试/缺陷排查

> Router 卡：只列**本类差异项**。公共加载集见 `SKILL.md`「加载时机索引」与「分级加载」；机器版 = `load_plan.json` `profiles.debugging`。

**适用**：用户粘贴错误/堆栈（→ 触发调试模式，`kernel.md` 暂停条件 + `references/debug-mode.md`）/ 行为异常需先定位根因 / 测试反复失败
**任务分类**：A（调试变体）；记忆路由行 = 「编码/调试」（`retrieval.md`）

**执行路径**：L1（单点 bug）→ S1→S2→S4→S8→S9→S10；L2+ 全阶段，回退按 `engine/transition.md`

**公共 Required:** kernel + engine + policy + `learning/memory/retrieval.md`（S2 召回）+ `learning/memory/lifecycle.md`（回写契约）+ `learning/skill-metrics.md`（S13 仪表盘）+ 逐阶段文件 —— 见 `SKILL.md`「加载时机索引」
**本类 Required（增补）:**
- `references/debug-mode.md`（调试模式触发时）
- `learning/memory/lifecycle.md`「Test→Lesson 学习闭环」（失败先存 lesson 再回退）
- `engine/skill-routing.md`（systematic-debugging 等调试类能力绑定）

**出口纪律**
- **修复前必须先输出根因（Evidence ≥ E2）**，禁止"猜测-试错"循环
- 连续三轮未定位（调试螺旋）→ 停止迭代，点出可能错误的假设，只问一个诊断问题
- Test 失败 → 先写 `lesson:{主题}`（即时）→ 再回退 Code[N+1]
- Quick Loop（L1）回退仅 1 轮，仍不过 → 建议升级 Standard Loop
