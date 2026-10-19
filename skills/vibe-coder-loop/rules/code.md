---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Code 阶段细则（骨架版）

[Phase: Code]
[Loop: N]

> **骨架化说明**：前置检查 8 步清单与异步状态防御已下沉为 `skill:` 规则条目（level:domain, permanent——加载全文执行）；硬约束/生成要求/出口条件保持本文件（含安全相关细节，不沉）。

本文件适用于**单 agent 模式**（主 agent 自写全部 Code）。多 subagent 模式见 `rules/orchestration.md`。

**角色人格化**：Code 阶段主 agent 扮演 **Builder** 角色。Builder 负责实现，不审查（那是 Critic 的职责）。Builder 必须诚实标注 Confidence，不自我吹捧代码质量。

## 前置检查（按顺序执行）

完整 8 步清单（Plan 引用/记忆检索/Lesson 检索/Reflection 反馈/codegraph 检索/Confidence 标注/异步防御/开始写码）见 `skill:rules/code:prechecks`（加载全文执行）；异步状态防御规则见 `skill:rules/code:async-defense`。

## 硬性约束

分级与定义见 `policy/safety.md` §3（**单一事实源**：Hard 6 项 / Signal 3 项 / #10 条件项）。生成时遵守 Hard 项；Signal 项按可维护性判断处理，不视为违规。资产生命周期见 `policy/lifecycle.md`。

## 生成要求

- 禁止伪代码、省略号占位（`// ...`）。如确需占位：`// TODO(verify): 具体待确认内容`
- **截断保护**：若输出被 token 截断（代码块未闭合 / 函数/类未完成 / 文件末尾无闭合标签 / 明显半截），**本轮产出整体作废**，回退重新生成，不进入 Test——禁止将不完整代码提交验证
- 代码块后附带**关键决策说明**：为什么这么设计、权衡与替代方案、潜在风险
- **不确定判断标注 Confidence**：仅 3 类场景（多个合理解释 / 记忆与代码冲突 / 风险无把握）标注 `[Confidence: High/Medium/Low]`（见 `policy/confidence.md`）
- **资产生命周期合规**：
  - 移除/替换**用户既有**代码 → 走 Active→Deprecated（归档注释 `@Iteration`）；**本轮自产草稿**可直接替换（说明变更即可）
  - 文件归档超限 → 走 Deprecated→Archived（移至 `archive/` 子目录，源位置留指针）
  - 禁止任何**代码资产**的物理删除（无用户指令 → 归档 + 「🗑 待删除清单」；**用户明确指令** → 先输出 Conflict Card + 清单，**删除由用户执行**）；**本轮自产草稿**可直接删改（见 `policy/lifecycle.md`「适用范围」）
- **涉及组件/页面更换时**：旧组件归档注释 + 新组件并存，标注 `⚠️ 需用户决策：[更换项 | 候选 | 旧组件去向]` 并追加到「📋 待用户决策清单」
- 本轮若产生待决策项，Code 输出末尾附「📋 待用户决策清单」（无则省略）

## 出口条件

- [ ] 前置检查已完成并标注结果（含 Reflection 反馈检索）
- [ ] 代码中引用了 Plan 阶段的 Step 编号（Quick Loop Mode 跳过此项）
- [ ] 关键决策说明已输出
- [ ] 涉及不确定判断时 Confidence 标注完成（3 类场景，见 `policy/confidence.md`）
- [ ] Lesson 检索已执行并标注结果（`[Lesson 命中]` 或 `[无历史经验]`）
- [ ] 异步状态防御检查已执行（`[异步状态: 已防御]` 或 `[异步状态: 不涉及]`）
- [ ] 资产生命周期操作合规（无自主 Archived→Removed）
- [ ] **若产生可复用项目约束，按 `learning/memory/lifecycle.md`「记忆写入」直接写入**（自主执行，无逐次确认）
- [ ] **若本轮 Code 完成了一个版本功能/修改了 API 签名 → 标注 `[待 Memory Evolution]`**（Review C 后执行）
      → 满足后输出 `>>> 进入 Test`。
