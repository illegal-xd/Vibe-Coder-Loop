---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Learning: Reflection — 经验反思机制（骨架版）

> **骨架化说明**：触发条件表/Reflection Card 模板/5 Why 要求/Feedback 写入格式已下沉为 `skill:` 规则条目（level:domain, permanent——加载全文执行）；条目不可用 → 按 `SKILL.md` 的 fail-closed 规则输出 `[RULE_STORE_MISSING]` 并停止；本文件摘要只用于定位，不得作为规则推断依据。

本文件定义触发式 Reflection 的定位与流程。Reflection 位于 Review 情况 C 通过后、Memory Evolution 之前，由主 agent 执行。

## 定位

- **时机**：S11，在 Review 情况 C 通过后、S12 Memory Evolution 之前
- **执行者**：主 agent，**子 agent 不参与**（子 agent 失败 → 走 Test 回退 Code[N+1]，由主 agent 在 Review 后判断）

## 触发判定（S11 出口，静态兜底）

```text
[Phase: Reflection]
[Loop: N]

### 触发判定
强制触发（任一命中 → 输出 Reflection Card）：
- [ ] ① 用户主动纠正 Agent
- [ ] ② 本轮曾发生 Review 情况 B（结构性回退）
- [ ] ③ 同一类问题重复出现 ≥2 次（含 lesson 命中同根因）
→ 命中 → 输出 Reflection Card → 进入 Memory Evolution
→ 未命中 → 跳过 Reflection → 直接进入 Memory Evolution
```

**其余信号属可选**（完成跨模块功能 / 架构调整 / 解决复杂 Bug / 高复用经验 / 高风险域 / 达到最大循环 / Code Confidence=Low）：Agent 判断"确有值得沉淀的规律"才做，**不做不违规**。完整条表（含 tag 体系）见 `skill:learning/reflection:triggers`——**仅在准备写 Card 时查阅**。

## 信号驱动判定（P1-1）

S11 首选运行 `python3 scripts/memory/reflection_signals.py evaluate --task-id <T>`（仓库根目录）。脚本读取 `signal:reflection:*`（复用 delx-memory `memory` 表；`layer=null` / `category=state`），只做**聚合判定**，不做晋升。**能力边界**：不实现后台监听；信号由 Agent 在 S9/S10 事件点写入，S11 读取判定。

| decision | 含义 | 动作 |
|---|---|---|
| `reflect` | 至少一个 group 命中触发 | 输出一个聚合 Reflection Card，groups 列出各 fingerprint |
| `skip` | 只有偶发/低价值信号 | 不蒸馏；信号保留供后续重复检测 |
| `insufficient` | 信号未验证或证据不足 | 只记录；不生成 Lesson/Pattern |
| `unavailable` | 记忆库不可用 | 标注 `[REFLECTION_DEGRADED]`，回退静态清单，继续 S12 |

**任务标识**：`<T>` = S1 生成的 `task:<yyyymmddThhmm>-<goal-slug>`，同一任务跨轮复用，不同任务不得复用。

**信号类型**：`user_correction` / `verification_failure` / `repeated_failure` / `high_cost_rework`。记录必须带证据（`file:` / `memory:` / `anchor:`）；模型猜测用 `--unverified`，不进入强制反思。

**聚合与分类**：同一 fingerprint 合并为一个 group；同一 `(task, type, fingerprint, dedupe_token)` 只算一次。分类为 `lesson_not_followed`（已有经验未被采用）/ `lesson_ineffective`（用了仍失败）/ `lesson_stale`（经验失效/冲突）/ `new_experience` / `sporadic` / `insufficient_evidence`。已有相似经验时优先 `supplement` 或 `correct`，不新增重复记录。

**触发 ≠ 晋升**：脚本固定输出 `promotion_authorized=false`。是否写入 L3/L5、是否提升，仍由本文件 Card 质量审计 + `learning/memory/promotion.md` 阈值独立决定。反思判定失败不阻塞编码/测试/恢复；按 `[REFLECTION_DEGRADED]` 降级。

## Reflection Card 产出

触发时输出 Reflection Card（格式/5 Why 要求/成功模式重点/Feedback Loop 写入格式见 `skill:learning/reflection:card-template`）：

```text
┌──────────────────────────────────────────────────┐
│ 🔍 Reflection Card                              │
├──────────────────────────────────────────────────┤
│ 触发原因: <为什么触发 Reflection>                │
│ 失败模式 / 成功模式: <失败/成功>                │
│ 根因分析: <5 Why 分析>                          │
│ 经验沉淀: <提炼的规律，避免复述"是什么">        │
│ 适用场景: <什么情况下应用这条经验>              │
│ 反模式（应避免）: <什么情况下不要这样做>        │
│ Pattern Fingerprint: <fingerprint值>            │
│ 质量审计（三问）: <为什么是经验/命中排除规则/证据>│
│ Confidence: <High/Medium/Low>                   │
│ Evidence: <E0-E4(来源)>                         │
└──────────────────────────────────────────────────┘
```

## 质量审计（三问）

Reflection Card 产出时按 `learning/memory/promotion.md`「经验质量审计」执行三问审计（为什么是经验 / 命中哪些垃圾排除规则 / 对话证据）；命中九类垃圾特征（事实性错误/通用常识/对话摘要/一次性case/主观偏好/缺上下文/粒度混用/不可执行/证据不足）→ 重写或放弃沉淀，避免"过程录像"入库。

## 降级条款

Reflection 触发但主 agent 上下文不足 → 仍输出 Reflection Card，5 Why 缩减为 3 Why，标注 `[Confidence: Medium] — 记忆检索降级`，不阻塞 Memory Evolution。

## 与 Memory Evolution 的衔接

Reflection 完成 → Feedback Loop 即时写入（`reflection:<key>`，tags=[reflection, vibe-coder, <触发类型>]，TTL 180 天；自主执行，无逐次确认）。下次 Intent 阶段 Preflight 自动 `memory_search "reflection:"` 检索注入。
