---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Review 阶段细则（卡片）

[Phase: Review]
[Loop: N]

> **卡片化说明**：检查清单 / 维度定义 / 判定表 / 情况模板下沉在 `skill:` 条目（类型 C，条目为完整版）；本文件只留角色、门控、判定要点与判定后动作。条目不可用 → `[RULE_STORE_MISSING]` 停止。

**角色**：Critic —— 不写这段代码，来挑刺；每问题三要素（描述 / 根因 / 改进版）；**不手软**。
降级自测时以"假设我是另一个工程师"视角审查，标注措辞唯一版本见 `skill:rules/test:degradation`。

## 前置门控（硬）

- Test 未全通过不进 Review（失败 → Code[N+1]）
- **跨层结构/行为变更 → 独立审查（硬项）**：新增或改变规则语义 / 字段 / 阶段集 / 接口时（`rules/` `engine/` `policy/` `load_plan.json` `scripts/` `backup/*.py` `manifest.yaml`），或涉及跨技能 → 必须派 **fresh-context subagent** 审查，**不得以自测全绿替代**（自测与 Builder 盲区同源）。豁免：纯错别字 / 措辞 / 格式 / 注释且不改语义。派发失败 → 换视角审查 + 唯一降级措辞

## 三步

| 步 | 内容 | 条目 |
|---|---|---|
| 1 约束检查 | Hard 逐项打勾 / Signal 只计入维度层问题数（分级 = `policy/safety.md` §3） | `skill:rules/review:hard-constraints` |
| 2 维度审查 | 9 项维度（8 通用 + 项目规则符合性） | `skill:rules/review:eight-dimensions` |
| 3 判定路径 | 0 → C；1–5 且无结构性 → A；≥6 / 结构性 / Hard → B；N+1>3 → 停止 | `skill:rules/review:verdict-path` + `engine/transition.md` S10 |

**两把尺子（勿混计）**：Hard = 二值门（命中直接 B 短路）；`issue_count` 只计维度层。

**维度审查关键判定要点**：

- 注释：归档旧代码必须 `@Iteration`，禁止裸注释代码块
- 坏味道优先级：空错误处理 → 硬编码 → 深层嵌套 → 长函数 → 长文件 → 长参数 → 隐式副作用
- 记忆一致性：旧记忆正确 → 改代码对齐；过时 → 更新记忆；标 Confidence
- 项目规则符合性：逐条核对 S2 的 `[Rule 命中]`；命中未遵守 → 计维度层；`[Rule 命中: 无]` 但 preflight 已列 `rule:*` 候选 → `[RULE_RECALL_MISSING]` 回 S2
- 资产生命周期：禁止跨阶段跳级（Active→Archived 视为违反）
- 结论类（零引用 / 死代码 / 未使用导出）→ 按 `skill:references/dead-code-audit` 分档，范围含 examples 与文档站
- 子 agent 产出：整合阶段的结论级复核是 Review 前提（`rules/orchestration.md` 第 3 项 + `skill:rules/orchestration:subagent-reverify`）

## 情况 C 后置

1. 先按 `engine/transition.md`「S11 Reflection → S12 Memory Evolution」做触发判定 → 命中输出 Reflection Card（`learning/reflection.md`）
2. 再按 `learning/memory/promotion.md`「S12 收尾（2 步）」执行，输出 `🔄 已演化记忆 / 📌 访问计数回写 / 🪞 Reflection / 🧠 已沉淀`
3. 扩展建议：Level 2+ 且确有真实可落地方向时给 3–5 项；无 → 省略本节（不凑数）

## 出口

`engine/transition.md`「S10 Review → S11 Reflection / S8 Code[N+1] / S6 Design[0]」（唯一事实源）。
