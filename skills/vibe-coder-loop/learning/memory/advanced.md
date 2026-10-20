---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Learning: Memory/Advanced — 触发式与周期式协议（按需加载）

> **Canonical 分治声明**：本文件的**通用协议**（跨项目模式迁移 / Relevance 评分 / 事实时序 supersession / Memory Consolidation / 跨项目失效传播）canonical home = `delx-memory-protocol/protocol.md`；本文件 = **实例触发条件 + 执行绑定 + 指针**（通用概念已裁指针，非第二 canonical，非 fallback 副本）。修改通用概念以 `delx-memory-protocol` 为准。
> **本文件是按需分片**，不属于 S12 默认加载路径。默认路径为 `memory/promotion.md`（S12 主体）与 `memory/lifecycle.md`（写入与计数）。导航 = `../memory.md`。

**触发条件（命中才读本文件）**：

| 协议 | 触发条件 | 通用规则源 |
|---|---|---|
| 跨项目模式迁移 | S2 主动关联召回命中**其他项目**的 `pattern:*` / `principle:*` | `delx-memory-protocol/protocol.md` §跨项目模式迁移 |
| Relevance 评分 | 记忆条目 **TTL 到期前 30 天**需算 `relevance_score` | 同上 §Relevance 评分 |
| 事实时序 supersession | `memory_set` 更新**已存在的**事实型记忆且新旧值冲突 | 同上 §事实时序 supersession |
| Memory Consolidation | 执行**周期聚合**（非每轮 S12 收尾 2 步） | 同上 §Memory Consolidation |
| 跨项目失效传播 | 修改**跨项目共享文件**（如 console↔management 共享的 hooks.js） | 同上 §跨项目失效传播 |

---

## 跨项目模式迁移（实例执行路径）

通用概念（fingerprint 抽象性 / 全局 namespace）见 `delx-memory-protocol/protocol.md` §跨项目模式迁移。实例提示格式：

```text
S2 Preflight → `memory_list(prefix="pattern:")`（全局 namespace）
  → 命中 pattern:async-state-race（项目 A 3 次，项目 B 1 次）
  → 🌐 跨项目模式提醒：
    项目 A + 项目 B 均遇到 pattern:async-state-race
    建议在本项目中重点关注异步状态完整性
```

实现要点（实例侧）：
- Pattern key 使用全局 namespace（不绑定项目哈希）
- `memory_search` 时不限定 namespace（或显式使用 `global` namespace）
- Pattern 的 fingerprint 计算时不包含技术栈细节（仅抽象类型）
- Principle key 强制使用全局 namespace

## Relevance 评分（实例约束）

通用公式 / 因子归一化 / 淘汰决策（< 0.3 删除 / 0.3–0.6 降级 / ≥ 0.6 续期）见 `delx-memory-protocol/protocol.md` §Relevance 评分。实例约束：`relevance_score` 存于 metadata（**禁止内嵌 value**），仅 TTL 到期前 30 天懒计算（字段语义见 `lifecycle.md`「记忆访问计数与元数据协议」）。

## 事实时序 supersession（实例约束）

通用规则（与 `contradict` 分工 / 触发 / 不静默覆盖 / 召回取当前值 / 可覆盖例外 / 判定依据）见 `delx-memory-protocol/protocol.md` §事实时序 supersession。实例约束：
- **链记在 value，不记 metadata**——metadata 为整体替换语义，独立字段易在下一次 set 时丢失（见 `lifecycle.md`「Agent 直接 `memory_set` 时的约束」第 2 条）
- **存量说明**：本协议仅对新写入生效，不迁移存量记忆（用户裁定）

## Memory Consolidation 协议（实例执行顺序）

通用 8 Phase 顺序见 `delx-memory-protocol/protocol.md` §Memory Consolidation。实例规则源映射：

| Phase | 动作 | 规则源（本 skill 实例文件） |
|---|---|---|
| 1 收集 | `memory_list` 取本周期 lesson / reflection | — |
| 2 合并 | 同类合并，保留质量最高一条 | `promotion.md` 去重协议 |
| 3 指纹 | 计算 fingerprint | `promotion.md` Pattern Fingerprint |
| 4 去重与 Merge | 严格否决规则 → create/update/skip/contradict | `promotion.md` + Merge 治理协议 |
| 5 提升检查 | ≥3 同类 → pattern；≥5 且 ≥2 项目 → principle | `promotion.md` 自动提升逻辑 |
| 6 CodeGraph 验证 | 涉及代码路径/签名 → 验证 → 更新或标记过期 | — |
| 7 到期检查 | 仅 TTL 到期前 30 天算 relevance_score | 本文件 §Relevance 评分 |
| 8 待淘汰清理 | < 0.3 且已到期 → 输出淘汰提示（**不自动删除，人工确认**） | 本文件 §Relevance 评分 |

输出格式：
```text
🧠 Memory Evolution Summary
- 去重: {X} 条合并到已有记忆
- 提升: {Y} 条实例 → pattern:{name} | {Z} 条 pattern → principle:{name}
- 验证: {W} 条记忆经 CodeGraph 验证更新
- 待淘汰: {K} 条低分记忆（relevance < 0.3，到期时评估）
```

## 周期 Metrics 输出模板（实例特化）

周期落库 / 月度聚合时输出（周期聚合 `memory_set skill-metrics:vibe-coder-loop:<周期>` 之后的汇总）：

```text
📊 Skill Metrics 摘要
- 周期: 2026-07
- 成功率: 87% (13/15)
- 平均循环: 2.4
- 主要失败类型: 需求理解错误(20%) > 测试不足(13%) > 异步竞态(13%)
- 效率偏差: 本轮 3 轮 > 平均 2.4（+25%）
- Pattern 提升: 本周期提升 1 个 pattern（pattern:async-state-race）
- 建议关注: intent-misunderstanding 占比偏高，考虑加强 Intent 阶段追问清单
```

> 指标定义与统计口径 / 失败类型 9 类 / Buffer / 早期预警 完整规则见 `skill:learning/metrics:fields` + `skill:learning/metrics:early-warning`（memory 条目为完整版，`learning/skill-metrics.md` 只留每轮仪表盘摘要）。

## 跨项目失效传播（实例步骤）

通用概念见 `delx-memory-protocol/protocol.md` §跨项目失效传播。实例执行（修改跨项目共享文件时）：

1. `memory_search` 检索引用该文件路径的所有记忆
2. 对命中的关联项目记忆执行 `memory_set` → 添加 `stale` tag
3. 提示：`⚠️ 关联项目记忆已标记 stale：<key列表>`
4. 下次进入关联项目时，Preflight 优先加载 stale 记忆 → codegraph 验证 → 更新或清除 stale tag
