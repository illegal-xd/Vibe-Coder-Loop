---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Test 阶段细则（骨架版）

[Phase: Test]
[Loop: N]

> **骨架化说明**：task spec 格式/测试报告格式/降级条款已下沉为 `skill:` 规则条目（level:domain, permanent——加载全文执行）；派发流程/串行门控/出口条件保持本文件。

Test 阶段**优先派发 subagent**（写测分离 = 视角隔离的**实现手段**）。**派发不可用时降级自测，但"视角隔离"不可降级**——降级必须满足的 2 项最低要求（先声明预期 / 主动找反证）见 `engine/state-machine.md`「角色约束」。

**角色人格化**：Test 阶段 subagent 扮演 **Verifier** 角色。Verifier 与 Builder 隔离，假设 Builder 的代码可能有 bug，主动寻找反例。Verifier 不写实现代码，只写测试代码。

## 派发流程

主 agent 整合本轮 Code 产出 → 打包测试 task spec（格式见 `skill:rules/test:task-spec`）→ 派发：

- 逻辑层/纯函数 → `unit-test-agent`（Verifier 角色）
- UI 层/交互流 → `e2e-test-agent`（Verifier 角色）
- 两者皆有时分别派发（可并行）

## 降级条款（subagent 派发不可用时）

降级判定时机（5 情形）+ 降级行为 + 标注措辞（唯一版本）见 `skill:rules/test:degradation`（加载全文执行）。核心：

- S9 开始时**先尝试派发**；命中 5 情形之一 → 立即降级自测，标注 `（降级自测：subagent 派发被拦截/失败，主 agent 自测，存在作者偏见风险）`
- 降级自测仍须覆盖正常/边界/异常路径，至少 1 个可运行用例，且满足上条 2 项最低要求（先声明预期 / 主动找反证）
- Review 情况 C 通过后，将"subagent 通道不可用"作为技术债务列入扩展建议

## 测试报告格式（subagent 返回）

格式（状态/用例数/Confidence 分级/失败项/验证假设）见 `skill:rules/test:task-spec`「测试报告格式」。

## 串行门控

- ✅ 全部通过 → `>>> 进入 Review`（Test 报告作为 Review 输入）
- ❌ 有失败 → **先保存 Lesson**（失败根因分析 → `lesson:{主题}` 即时写入，tags=[lesson, vibe-coder, `<失败类型>`]，TTL 90 天；输出 `📝 已记录经验教训：lesson:{主题}`）→ `>>> 回退 Code [N+1]`（走情况 A 修复路径）。**不进 Review**——避免在功能未通过的代码上浪费质量审查。
  - **例外（Hard 项优先）**：若本轮 Code 产出**违反 Hard 项**（空错误处理 / 硬编码密钥 / 删除用户既有资产 / 三重禁止 / 更换未标 ⚠️，清单见 `policy/safety.md` §3）→ **不得以“测试失败”名义直接修补**，改走 S10 → **情况 B**（回 `S6 Design[0]`）；判定项见 `engine/transition.md` S9 出口「Hard 不豁免」
- 同类 lesson ≥2 条同根因 → 标注 `⚠️ lesson 重复出现，可能触发 Reflection`（Reflection 触发条件 #2）

## Quick Loop Mode 测试

Quick Loop 模式下：

- 主 agent 自测，不强制 subagent 派发（但仍切换到 Verifier 视角，标注降级风险）
- ≥1 项可观察验证（可运行用例 / 类型检查 / 编译通过 / 运行结果）
- 正常路径必覆盖；边界路径按风险选做（不要求全异常路径覆盖）
- Test 失败 → 保存 Lesson → 直接输出 `⚠️ Quick Loop 未通过，建议升级为 Standard Loop`（不回退 Code，1 轮上限）

## 子 agent 不循环

测试 subagent 为一次性调用，不进入 Vibe Coder 循环，不计入计数器。测试失败由主 agent 在 Code[N+1] 接管。

## 出口条件

- [ ] 测试已执行（subagent 派发 / 降级自测 / Quick Loop 自测）并返回报告
- [ ] 报告引用了 Code 阶段的函数/类名
- [ ] 报告包含 Confidence 标注
- [ ] 若全通过 → `>>> 进入 Review`
- [ ] 若有失败 → Lesson 已保存 → `>>> 回退 Code [N+1]`（Quick Loop 模式不回退，输出升级建议）
