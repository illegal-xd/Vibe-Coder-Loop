---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Test 阶段细则（卡片）

[Phase: Test]
[Loop: N]

> **卡片化说明**：task spec 格式 / 测试报告格式 / 降级判定 5 情形下沉在 `skill:` 条目；派发、串行门控与 Quick Loop 保留本文件。

**角色**：Verifier —— 假设 Builder 有 bug，主动找反证；只写测试，不写实现。
**视角隔离不可降级**：subagent 不可用时降级自测，仍须 ① 先声明预期（测前写"会通过的假设"）② ≥1 边界/反例（见 `engine/state-machine.md`「角色约束」）。

## 加载

| 内容 | 条目 |
|---|---|
| 测试 task spec + 测试报告格式 | `skill:rules/test:task-spec` |
| 降级判定（5 情形）+ 标注措辞（唯一版本） | `skill:rules/test:degradation` |

## 派发

整合本轮 Code 产出 → 打包 task spec → 逻辑层/纯函数派 `unit-test-agent`，UI 层派 `e2e-test-agent`，两者皆有时分别派发（可并行）。

## 串行门控

- ✅ 全部通过 → `>>> 进入 Review`（测试报告作为 Review 输入）
- ❌ 有失败 → **先保存 Lesson**（根因 + `success_correlation`，TTL 90 天，写 `lesson:{主题}`，输出 `📝 已记录经验教训`）→ `>>> 回退 Code [N+1]`；**不进 Review**
- **例外（Hard 优先）**：本轮产出违反 Hard 项（清单 `policy/safety.md` §3）→ 不得以"测试失败"名义直接修补，改走 S10 情况 B
- 同类 lesson ≥2 条同根因 → 标注 `⚠️ lesson 重复出现，可能触发 Reflection`

## Quick Loop（Level 0/1）

主 agent 自测（仍切 Verifier 视角并标降级风险）；≥1 项可观察验证；正常路径必覆盖，边界按风险选做。失败 → 保存 Lesson → 输出 `⚠️ Quick Loop 未通过，建议升级 Standard Loop`（不回退 Code，1 轮上限）。

## 子 agent 不循环

测试 subagent 一次性调用，不计入计数器；失败由主 agent 在 Code[N+1] 接管。

## 出口

`engine/transition.md`「S9 Test → S10 Review / S8 Code[N+1]」（唯一事实源，含 Metrics 记账、steering、Hard 不豁免、验证命令来自 `project:verify:<repo>` 画像、无单测须标注）。
