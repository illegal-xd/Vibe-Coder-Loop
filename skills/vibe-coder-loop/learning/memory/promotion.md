---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Learning: Memory/Promotion — 提升与质量治理协议

> **本文件是记忆体系质量侧（S12 默认路径）的唯一事实源**：S12 收尾（2 步）、自动提升逻辑、Pattern Fingerprint、经验质量审计、去重（Dedup）、Merge 治理协议、进化防抖：观察期协议。**触发式/周期式协议已下沉 `advanced.md`（按需加载）**：跨项目模式迁移 / Relevance 评分 / 事实时序 supersession / Memory Consolidation / 跨项目失效传播。概念层（三层体系/提升阈值定义）见 `architecture.md`，写入/计数侧见 `lifecycle.md`，检索侧见 `retrieval.md`，仪表盘见 `../skill-metrics.md`。导航入口 = `../memory.md`（索引）。

## S12 收尾（2 步）

> **设计原则：Memory 为 Agent 服务，而不是 Agent 为 Memory 服务。**
> Promotion / Dedup / Merge / Consolidation / Relevance / supersession / 观察期 / 失败类型分类 / Metrics 聚合与落库 —— 优先由 **Memory Tool** 承担；**没有对应工具命令的项，不得假设“系统会自动完成”**，由 Agent 按需执行或明确留待人工。
>
> 现有工具面：`memory_tool.py touch/metrics/backup/restore`、`scripts/memory/audit_memory.py` / `distill.py` / `migrate.py`、`scripts/memory/memops.py validate/search/repair/split`。Dedup / Merge / Consolidation / 自动提升**尚无独立运行时**；相关协议保留为实现参考，S12 只做 [1][2]。

```text
[1] 收尾回写（Tool 承担，一条命令）
    memory_tool.py touch <本轮消费 keys> [--hit]  +  memory_tool.py metrics <delta> --counts
    + 若本轮消费过记忆：memory_feedback.py record ...（见 lifecycle.md「记忆效用反馈」）
    → 输出：📌 访问计数回写：<keys> ｜ 📊 系统仪表盘：<简表>

[2] 经验沉淀（有则写，无则明说）
    出现「对未来任务有复用价值」的经验 → 过质量闸门后**直接写入**（无延迟确认）
    → 输出：🧠 已沉淀：<key 列表>（逐项标 TTL + 一句依据）；无 → 输出「本轮无沉淀」即结束
```

**允许跳过**：[2] —— 无新经验的任务。
**不再要求**：Agent 显式执行 promotion / dedup / merge / metrics 落库 / 观察期检查 / 类型分类。

**什么算「值得保存」**：现有代码看不出、下次遇到会再次踩坑的信息（判定见「经验质量审计」）；Agent 自己就能推出来的 → 不保存。

## 自动提升逻辑（Memory 系统职责，非 Agent 每轮动作）

> 概念表（层级/提升条件列）见 `delx-memory-protocol/protocol.md` §三层记忆体系（经 `architecture.md` 指针表）。以下为**系统侧**执行逻辑；Agent 只需按需写 `lesson:`，提升由系统 / 周期任务完成。
> **自动提升链**（lesson → pattern → principle）产出的始终是 **Advisory 记忆**，不自动生成 `rule:`；`rule:` 由 Agent **显式创建**（过 `policy/priority.md` §3.6 准入四条件 + 观察期转正），不从提升链的自动产物中派生。

1. 计算新 lesson/reflection 的 `pattern_fingerprint`
2. `memory_search fingerprint` → 统计同类实例数（含本轮新增）
3. 同类 ≥3 → 自动创建/更新 `pattern:{name}`，tag=p_high，TTL=365天
4. 同类 ≥5 且涉及 ≥2 项目 → 自动创建 `principle:{name}`，tag=p_critical，TTL=无限
5. Pattern/Principle 的 value 包含：fingerprint、实例引用列表、适用场景、反模式、提升日期
6. 聚合时同步扫描 `trigger:high-reuse` 标记条目（写入方已判定「高复用」）与 `recurrence_count ≥ 2` 条目 → **优先进入提升评审**（提前评审 ≠ 降低阈值：仍需其指纹同类实例 ≥3 才建 pattern）
7. **提升源只来自 L3**：L1/L2 默认不落库（见 `docs/memory-layers.md §6.7`）；L4 是规范类、L6 是指针类，均不参与 L3→L5→L7 阶梯
8. **审核分层**：L3/L4 有 `evidence_level E2+` 且无 `content:conflict-marker` → 可 `approved`；L5/L6/L7、用户显式修正、安全/失败证据 → 保持 `pending` 人工评审。L6 规则镜像不是 L6，归 `category=skill_mirror` / `layer=null`

**提升阶梯是双轴正交**（勿混淆——两轴相互独立）：

| 轴 | 取值 | 回答的问题 |
|---|---|---|
| **知识抽象度** | lesson → pattern → principle | 这条经验「被 generalize 到什么程度」 |
| **持久化作用域** | task → project → global（`scope` 标注） | 这条经验「在多大范围可见」 |

- `pattern` 可以 `scope:project`（项目内的通用模式）；`lesson` 可以 `scope:global`（跨项目适用的具体教训）
- 提升阈值**只约束抽象度轴**（≥3 → pattern；≥5 且 ≥2 项目 → principle）；作用域轴由 `scope` 标注独立决定（新写记忆必带 scope 三选一，见 `lifecycle.md` 禁止事项）
- 跨项目模式迁移（见 `advanced.md`）依赖**全局 namespace**，与抽象度无关

**Auto-Save 输出提示**：
```text
🎯 模式提升：检测到 {N} 条关于"{模式描述}"的经验，已自动提炼为 pattern:{name}
🏛️ 原则沉淀：{pattern:name} 已在 ≥2 项目中验证，已升华为 principle:{name}
```

## Pattern Fingerprint 算法

用于判断两条记忆是否属于同一模式（提升判定时计算）：

```text
fingerprint = 失败类型 : 技术栈抽象 : 根因关键词集合(排序去重) : 适用场景关键词集合(排序去重)
```

**匹配规则（4 条全满足才算同一模式）**：① 失败类型相同；② 技术栈抽象相同（vue2/vue3 视为相同，vue ≠ react）；③ 根因关键词交集 ≥ 2；④ 适用场景关键词交集 ≥ 1。

> **判断 fork**：**选词（哪些算根因/场景）是 Agent 的语义判断**（不可程序化）；**拼串与集合交集是机械计算**——当前规模下机械部分＝一次字符串拼接，工具化收益 < 复杂度成本，故保留由 Agent 执行。

## 按需协议（下沉 `advanced.md`，默认不加载）

以下协议**触发时才用**，已下沉 `advanced.md`（触发条件与规则本体见该文件；本处只留指针防漂移）：

| 协议 | 触发条件 | 位置 |
|---|---|---|
| 跨项目模式迁移 | S2 命中**其他项目**的 `pattern:*` / `principle:*` | `advanced.md` |
| Relevance 评分（懒计算） | 条目 TTL **到期前 30 天** | `advanced.md` |
| 事实时序 supersession | `memory_set` 更新**已存在的事实型**记忆且新旧冲突 | `advanced.md` |
| Memory Consolidation（8 Phase） | **周期聚合**（非每轮 S12 收尾 2 步） | `advanced.md` |
| 跨项目失效传播 | 修改**跨项目共享文件** | `advanced.md`+`lifecycle.md` |

## 经验质量审计（九类垃圾特征 + 三问）

> "过程录像不等于经验，不加过滤的自动提取是垃圾放大器"。本协议是**入库前质量闸口**：先判定一条候选经验是否值得保存，再进入去重/Merge。

**核心标准**：一条经验的价值 = 被召回后 Agent 能否产生**正向行为变更**（"不容易直接发现"的信息才值得召回——Agent 自己就能推出来的，召回无额外价值）。

**九类垃圾特征**（命中任一 → 不保存，或重写后再保存）：

| # | 垃圾特征 | 判定 | 处理 |
|---|---------|------|------|
| 1 | 事实性错误 | 编造不存在的约束/方法/接口，把临时说法当规则 | 拦截（涉及代码符号先 CodeGraph 验证） |
| 2 | 通用常识 | 任何项目都适用，不体现项目特异性 | 不保存 |
| 3 | 对话摘要 | 只复述过程，未沉淀成可复用判断 | 重写为判断句或丢弃 |
| 4 | 一次性 case | 只对当前任务有效，不能迁移 | 不保存 |
| 5 | 用户主观偏好 | 个人选择，不代表团队/项目规范 | 走 preference:user:* 通道（≥3 次确认），不走 lesson |
| 6 | 缺少上下文 | 不知道对应哪个模块/组件/接口 | 补上下文或丢弃 |
| 7 | 粒度混用 | 一条经验兼顾通用规则和 case 特定信息 | 拆分 |
| 8 | 不可执行 | 只有抽象建议，看完不知道下一步做什么 | 补具体动作或丢弃 |
| 9 | 证据不足 | 无足够依据，推断过多 | Confidence/Evidence 降级或丢弃 |

**三问审计**（每条待保存经验必须可回答，答案随 value 保存）：

1. **为什么这是经验**——解决了什么可复用问题、是否项目特有
2. **命中哪些排除规则**——通过了上面哪几类垃圾检查（无垃圾特征 ≠ 通过，须显式列出）
3. **证据是什么**——哪几轮对话/任务支撑（对应 Confidence/Evidence 的 E0-E4）

**应用点**：所有写入候选（Test→Lesson / Reflection Card 三问字段 / 项目约束 / 偏好 / 周期 Consolidation 产出）**写库前逐条过筛**——质量闸门是**防污染判定**，不是用户确认。Quick Loop 出口的候选同样执行本审计。

## 去重协议（Dedup）

去重由 Memory 系统执行（非 Agent 每轮动作）：对新写入的每条 lesson/reflection，先查重再保存。

**严格否决规则（命中任一 → 禁止合并，宁严勿宽——误合并造成的边界污染是永久性的）**：

- **When（适用场景）不同不能合**——即使结论相似，场景不同就是两条经验
- **主结论类型不同不能合**——操作建议 / 风险规避 / 排查方法之间不混并
- **粒度不同不能合**——局部子机制 vs 完整系统经验，不能互相替代
- **同一技术事实但用途不同不能合**——同一条 API 既用于性能优化又用于兼容处理，不因"都涉及该 API"合并
- **禁止桥接式合并**——A~B 有重叠、B~C 也相关，不能推出 A~C 重复；经验边界在于适用场景的约束条件，语义相似 ≠ 经验等价；桥接式合并会把边界不同的经验串联归并，边界信息永久丢失

```text
Step 1: 计算新 memory 的 pattern_fingerprint
Step 2: memory_search fingerprint → 检索已存在的同类记忆
Step 3: 命中后先过严格否决规则：
  → 命中任一否决规则 → 不合并，转「Merge 治理协议」判定（通常 create 或 update）
  → 未命中且根因相同 → 合并：
    → 不创建新 key
    → 更新已有 memory 的 recurrence_count +1
    → 更新已有 memory 的 updated_at 和 TTL
    → 输出 🧹 去重：<new_key> 合并到 <existing_key>（第 {N+1} 次出现）
Step 4: 若命中但根因不同（同一 fingerprint 下不同根因）：
  → 创建新 key，但 link 到已有 fingerprint 组
  → 检查是否达到提升阈值（≥3条 → pattern）
```

## Merge 治理协议（新经验 vs 历史库）

入库前最后一关：判定新经验与历史经验库的关系，执行四动作之一：

| 动作 | 条件 | 执行 |
|------|------|------|
| create | 库中不存在唯一最合适的经验目标 | 新建 key |
| update | 与历史经验同向，且带实质新信息 | 合并更新（须过 Update 自检） |
| skip | 核心结论可互相替代 | 不写入，recurrence_count +1 |
| contradict | 核心结论直接冲突 | 标记冲突，不自动决断，走人工裁决 |

**唯一目标判定前置**：先从历史库召回与新经验相关的子集，判定是否存在**唯一**最合适的经验目标；若没有（沾边多条但都不属于同一条可维护经验）→ **默认回退 create**，禁止强行匹配（一条不够匹配的历史经验被硬推成 update 目标会污染边界）。

**Update 自检**（每笔 update 必须通过四问）：合并后的 When 是否过度泛化（丢失原场景约束）？What 是否保留最具体/最安全/最可执行的操作建议？Why 是否保留核心机制？是否引入不受原经验支持的新结论？

**Contradict 裁决**：冲突 = 新认知与旧认知不一致，本身是有价值的信号。**Agent 自主裁决**（不再请求用户）：默认**保留双方**——旧条目加 `superseded` 或保留，新条目标 `contradict` tag 并在 value 内记「与 <key> 冲突 + 各自依据」，召回时取**更具体 / 证据更强**者；若涉及 R0/R1 安全语义分歧 → 保留双方并仍在输出中标注 `⚠️ 经验冲突待裁决：[<key> vs <key>]`（**标注不阻塞循环**）。

> **事实时序 supersession**（≠ Merge contradict）：仅当 `memory_set` 更新**已存在的事实型**记忆且新旧直接冲突时触发 → 规则见 `advanced.md`。已下沉，本处不重述。

## 进化防抖：观察期协议（Observation Window，系统职责）

> 设计原则：防止 Agent 自动生成的规则未经验证进入正式规则库（防抖），异常时可回滚。协议条目：`skill:learning/memory:observation-window`（level:core, reference）。
> **操作侧唯一事实源 = `policy/priority.md` §3.6**（准入四条件 / 权限矩阵 / 观察期转正·降级阈值）；本节只保留**系统实现侧**细则，**不重述阈值与判定**（避免两处漂移）。

防止 Agent 自动生成的规则未经验证进入正式规则库（防抖），异常时可回滚：

1. **标记实现**：所有**自动生成**的 Memory 记录（S12 自动提升的 pattern、Test 失败自动 lesson、进化自动规则条目）落库时由系统写入 tags `auto_generated` + `pending_review`，初始 `level:tactical`
2. **转正 / 降级阈值**：**不在此重述**——判定与阈值以 `policy/priority.md` §3.6 为准（Agent 侧）与本条目 `skill:learning/memory:observation-window`（系统侧）
3. **顺延**：触发不足转正阈值 → 观察期顺延（TTL 自然到期则按 TTL 规则淘汰）
4. **删除流程（系统侧细则）**：`candidate-delete` 条目 → 过 `policy/lifecycle.md`「记忆条目删除义务」后**自主删除**（核验归属 + 可回滚证据；≥5 条先输出淘汰清单）→ 输出 `🗑 已删除：<keys>` + 重建备份快照
5. **`level:core` 授予义务（系统侧）**：① 在 value / note 记一句授予依据 ② core 仅表示「`skill:*` 条目内的最高加载优先级」，**不改变记忆的 Advisory 地位**——不得据此否决 `engine/` / `rules/` 文件规则（`policy/priority.md` §3.5）
6. **检查时机**：S12 [2] 经验沉淀步骤执行；Quick Loop（无 S12）由 S13 出口顺带检查（仅当存在 pending_review 条目时）
7. **仪表盘**：升级/降级/删除事件更新 `skill:vibe-coder-loop:metrics` 的 `auto_rule` 字段（generated/promoted/demoted/deleted/pass_rate/pending；字段记号，非独立 key，见 `skill-metrics.md`「系统状态仪表盘」节）

## Memory Consolidation（周期聚合，按需）

**非每轮 S12 必经**——S12 每轮执行的是上方「S12 收尾（2 步）」；**周期聚合**（8 Phase：收集/合并/指纹/去重·Merge/提升/CodeGraph 验证/到期检查/淘汰清理）时读 `advanced.md`（含执行顺序表与输出格式）。
