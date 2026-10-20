# 通用记忆协议（delx-memory 后端）

> 本文件是 **delx-memory 后端的通用协议事实源**，与具体工程 Agent 解耦。
> 实例特化（出口回写时机 S2/S8/S12、任务类型路由表、仪表盘字段、S12 收尾清单）由**宿主 Skill** 承载（如 `vibe-coder-loop` 的 `learning/memory/lifecycle.md` / `retrieval.md` / `promotion.md`）。
> 本文件提取自 `vibe-coder-loop` 的 `learning/memory/architecture.md` + `advanced.md`，作为可复用协议独立化；宿主 Skill 的实例文件保留实例绑定并**委托本协议**提供通用概念。

## 记忆操作授权模型（常驻授权，本协议事实源）

> 宿主 Skill 的写入/删除协议（如 `vibe-coder-loop` 的 `learning/memory/lifecycle.md`、`policy/lifecycle.md`）只承载「时机 + 动作」；**授权判定以本节为准**。

**用户常驻授权（Standing Authorization）**：记忆的**增 / 删 / 改 / 查**由 Agent **自主执行，无需逐次征询用户**。

| 操作 | 语义 | 义务（非用户确认项） |
|---|---|---|
| 增 | 新增 `lesson:` / `reflection:` / `pattern:` / `project:` / `preference:` 等 | 过**质量闸门**（九类垃圾特征 + 三问审计）；完整三件套 metadata + tags |
| 改 | 更新 value / tags / metadata / TTL / level、Merge 的 update·skip | 先 `memory_get` 取当前值 → 叠加计数 → 三列完整回传；TTL 按剩余时长重锚 |
| 删 | `memory_forget` 单条或批量 | ① **归属为本方**（他方 `owner:*` / 跨 skill 键不删）② **可回滚证据已核验**（快照 / git / 内容已迁移）③ 批量 ≥5 条先输出清单再执行（可观测，**不阻塞**） |
| 查 | `memory_get` / `memory_list` / `memory_search` | 无（只读） |

- **`explicit_user_intent=true` 语义**：本条常驻授权即构成"用户要求 Agent 管理记忆"——增/删/改调用携带该标志**合法**，无需每次重新取得同轮用户指令。
- **删除后义务**：输出 `🗑 已删除：<keys>` → 做**引用扫描**（FTS 反查旧 key，修导航/规则条目里的陈旧指针）→ 重建备份快照（使 `verify` 一致）。
- **唯一保留的用户确认项（不在本协议范围）**：**文件 / 代码删除** —— Agent 不执行物理删除，输出「🗑 待删除清单」由用户执行。记忆条目删除**不属于**此类。
- **`rule:` 条目同属自主范围**：其增 / 改 / 删由 Agent 执行——守门机制 = 宿主 `policy/priority.md` §3.6 的**准入四条件 + 结构红线**（不得覆盖 R0/R1 与 `engine/` 流程）+ **观察期转正**（`auto_generated` + `pending_review`，3 次成功触发转正），**不是用户审批**。
- **`level:core` 亦由 Agent 授予**：义务 = 在条目内记授予依据，且 core 只表示「`skill:*` 条目内的加载优先级」，不改变记忆的 Advisory 地位（不得否决文件规则）。

## 三层记忆体系

所有经验记忆按抽象层次分为三层。低层实例自动聚合为高层模式，模式跨项目验证后升华为原则。

```text
第3层：原则 (Principle)  ──── TTL 无限，p_critical
  │  ≥5 实例 + 跨 ≥2 项目
  ▼
第2层：模式 (Pattern)  ──── TTL 365 天，p_high
  │  ≥3 实例共享同一 fingerprint
  ▼
第1层：实例 (Instance)  ──── TTL 90/180 天，p_medium
  lesson:{digest} / reflection:{digest}
```

| 层级 | Key 格式 | TTL | Tag | 提升条件 | 示例 |
|------|---------|-----|-----|---------|------|
| 实例 | `lesson:{主题}`（默认 **p_medium**）/ `reflection:{摘要}`（默认 **p_high**）/ `experience:{主题}`（**p_high**） | 90/180/180 天 | 见左 | — | `lesson:checkbox-dual-safety` |
| 模式 | `pattern:{pattern_name}` | 365 天（**例外：身份级/核心协议 pattern 可设 permanent，如 pattern:memory-writeback-integrity**） | p_high | ≥3 实例同 fingerprint | `pattern:async-state-race` |
| 原则 | `principle:{principle_name}` | 无限 | p_critical | ≥5 实例 + 跨 ≥2 项目 | `principle:validate-async-before-use` |

> 实例层 tag 契约：lesson 默认 p_medium，reflection 默认 p_high，experience 默认 p_high。特殊高价值 lesson 可提级 p_high。
> 命名规范：lesson 用**主题式命名**（如 `lesson:antd-form-item-rest-table-radio`），不用 digest 哈希；reflection 用内容摘要。跨项目排坑经验用 `experience:{主题}`（TTL 180 天），全局规则用 `global:{主题}`（无限）。

## 命名空间隔离

所有记忆操作默认绑定当前 Git 仓库根目录的哈希值（若无则绑定工作目录路径）。CodeGraph 查询自动作用于当前项目索引。

**Key 命名规范（防跨 skill 覆盖）**：Skill 自有数据/规则条目必须带 **Skill 名**——`skill:<skill-name>:<slug>`（如 `skill:vibe-coder-loop:metrics`）；规则条目沿用 `skill:<文件域>:<slug>`（如 `skill:rules/intent:goal-triple`）。**禁止使用无 owner 的共享前缀**（如 `skill:system:*`）——多个 skill 写同一键会互相覆盖。

## Tag 权重体系（渐进加载）

| Tag | 含义 | 示例 | 加载时机 |
|---|---|---|---|
| `p_critical` | 入口记忆，首次必读 | module-index, memory-navigation, principle:* | Preflight/首次对话 |
| `p_high` | 模块详情/环境/服务配置/已验证模式 | module-compress, conventions, pattern:* | 进入该模块时/相似任务时 |
| `p_medium` | 补充参考/TTL 降级/实例经验 | tooling:*, lesson:*, reflection:*, experience:*, 过期记忆 | 遇到特定问题/Preflight 关联检索 |
| `stale` | 跨项目共享文件变更后标记 | 待验证的关联记忆 | Preflight 优先加载→验证→清除 |
| `skill-evolved` | 经验已沉淀到 Skill/Pattern | reflection:*-skill-evolved, pattern:*-skill-evolved | 仅历史追溯；**原 TTL 清零改永久保留** |
| `preference` | 用户偏好记忆 | preference:user:* | Preflight 注入 |

**作用域维度（scope，独立于优先级的归属维度）**：

| scope tag | 语义 | 加载时机 | 示例 |
|-----------|------|---------|------|
| `scope:global` | 全局规则/偏好，所有项目适用 | 每轮 Preflight（与 p_critical 同级） | user:*, global:*, 红线类 skill:* |
| `scope:project` | 项目专属规则/经验 | 进入该项目时（挂项目网络） | project:* 子节点 |
| `scope:task` | 任务类型触发 | 匹配宿主 Skill 的 Task→Memory Router 任务类型时 | 技能维护规则、记忆回写 pattern |

> 规则归属原则（防作用域污染）：技能维护类规则 = scope:project + scope:task，绝不升级为全局 p_critical（其他项目无需加载）；全局核心（红线/身份）才用 scope:global + p_critical。

## 召回纪律（summary-first，强制）

> **动机**：记忆条目是上下文成本项。「先取全文再判断是否需要」等于把每条候选的价值不确定性全部转嫁成 token 成本。先取**元信息**，命中才取**正文**。

**标准动作（Preflight 一律遵守）**：

| 步 | 动作 | 取回 |
|---|---|---|
| 1 | `memory_list(prefix=..., tag=...)` 或 `privacy_mode=summary` | **只回 key + tags + 时间戳**，不回 value |
| 2 | 按 key / tags 判断是否命中本任务 | 无命中 → 到此为止，**不取 value** |
| 3 | 命中才 `memory_get` | 回完整 value |

**强制条款**：

1. **禁止无条件全量 `memory_get`** —— 尤其禁止"先把 `prefix` 下所有条目拉进来再看"。这与「Memory ≠ Context」硬约束同源（记忆按需命中才进入上下文）。
2. **规模先行**：候选量未知时，先用计数类调用（`--count` / prefix 分布）摸清规模，再决定是否枚举。**不先摸规模就枚举 = 一次可能拉回数十条无用条目**。
3. **单次取用有界**：单条 `memory_get` 每次只取 1 个 key；批量取用走 `memory_get_many`（单次 ≤50，超限显式分批），**禁止**"一次脚本循环拉几十条 get"。超出**显式分批**，不静默截断。
4. **回收**：本轮取回但未使用的条目，不写入任何"已读"状态 —— **不产生幽灵引用**。

> **与宿主的关系**：宿主 Skill 规定"在哪个出口执行召回"（时机）；本节规定"召回时取多少"（粒度）。两者不重叠。

## Relevance 评分（懒计算）

**懒计算：仅 TTL 到期前 30 天评估**，存于 metadata `relevance_score`（禁止内嵌 value）。

```text
relevance_score = hit_count×0.25 + recency×0.20 + codegraph_verified×0.30
                + user_confirmed×0.15 + recurrence_count×0.10
```

各因子归一化到 0–1：`hit_count`（0 次=0 / ≥5 次=1）、`recency`（≤7 天=1 / >180 天=0，线性）、`codegraph_verified` 与 `user_confirmed`（0 或 1）、`recurrence_count`（≥5 条=1，线性）。

**淘汰决策**：< 0.3 → 到期删除（不续期）；0.3–0.6 → 降级 tag 为 p_medium 保持 TTL；≥ 0.6 → 续期；未到期不评估（0 成本）。

### 冷记忆降级（降召回噪声）

> **动机**：长期 `hit_count = 0` 的实例层条目不是"未来可能有用的资产"，而是**每轮召回的噪声源** —— 它们让候选列表变长，从而拉高"取错条目"的概率与取用成本。**降低召回噪声 = 同时降 token 与提信号比**。

**判定（可数，不做评分）**：一条 `lesson:*` / `reflection:*` / `experience:*` 同时满足

1. `hit_count = 0`（`metadata.access_count` 为 0 或缺失）
2. 创建已跨 ≥ 90 天
3. 未被任何 `pattern:*` / `principle:*` 引用为实例来源

→ 判为**冷记忆**。

**动作（分两级，均不删除正文）**：

| 级 | 动作 | 可逆性 |
|---|---|---|
| **降载** | 打 `scope:archived` tag + 从默认召回前缀中排除（`prefix` 检索不再返回） | 可逆（去 tag 即恢复） |
| **存根化** | value 压缩为 ≤ 3 行摘要 + 原文迁至外置文件，条目内留路径 | 可逆（文件在，可回填） |

**纪律**：

- **不做静默删除** —— 冷 ≠ 错。删除只在 Relevance 淘汰决策（`< 0.3` 且已到期）时执行，且须走「记忆操作授权模型」的删除义务。
- **与 TTL 到期 / Relevance 窗的优先级（防三者同日打架）**：冷记忆判定窗 = **TTL 到期前 30 天**（与 Relevance 懒计算同窗）。同窗内三者同时命中时**以 Relevance 淘汰决策为准**（它已含删除义务与证据核验）；冷记忆降载只在条目**未达删除条件**（relevance ≥ 0.3）时执行，且动作止于降载/存根化——**不删除**。窗口错开的依据：`lesson:*` 默认 TTL 90 天，冷记忆阈值「创建跨 ≥90 天」对 `lesson:*` 几乎不可达（到期即先走 Relevance/删除路径），故冷记忆降级的主要作用域是 `reflection:*`（180 天）与 `experience:*`（180 天）。
- **可观测** —— 批量降载 ≥5 条先输出清单再执行（同删除的批量纪律）。
- **可恢复** —— 存根化必须留下可回填的原文来源；**不得**只留"已归档"三个字。
- **不作用于规则层** —— `rule:*` / `skill:*` / `principle:*` 不参与冷记忆判定（它们的价值不由命中率度量）。

## 事实时序 supersession（≠ Merge contradict）

> **与 `contradict` 的分工**：`contradict` 处理「**两条经验结论冲突**」（主观认知分歧 → 人工裁决）；supersession 处理「**同一事实随时间变化**」（客观事实更新 → 可机械判定）。

**触发**：`memory_set` 更新一条**已存在**的**事实型记忆**（如「函数 X 在文件 Y」「项目用 Vue 3」），且新值与旧值**直接冲突**。

**规则**：

1. **不静默覆盖**——旧值保留；新值 value 内新增「## 时序链」段记 `supersedes: <old key>`，旧条目 value 内追加 `superseded_by: <new key>`
   - **链记在 value，不记 metadata**——metadata 为整体替换语义，独立字段易在下一次 set 时丢失
2. **召回时取当前值**——命中带 `superseded_by` 的条目 → 顺链读末端作为当前事实；旧值仅用于审计 / 回滚
3. **可直接覆盖的例外**——纯计数 / 元数据类更新（`access_count` / `cache_hit_count` / `updated_at` / `title`）；以及旧值已被显式判定为「**错误**」而非「**过时**」
4. **判定依据**——新旧是否指向**同一实体 + 同一属性**：是 → supersession；否 → 走 Merge 治理协议（create/update/skip）
5. **链深上限 = 2（强制折叠）** —— 新增一次 supersession 后，若链长 > 2，**折叠**：把末端（当前事实）提升为链头条目，中间节点降为同一 value 内「## 历史」段的纯文本记录（不再作为独立 key 参与召回）。依据：召回要顺链读、**每次顺链都是一次取用成本**；链越长，命中成本越高而信息增益越低。折叠后仍保留可追溯性（历史段在 value 内），但召回只需读一次。
6. **不折叠的情形**——链上任一节点带 `audit` / `evidence` tag（审计或合规留痕），或宿主 Skill 明确声明需要逐节点回滚。此时保持原链，但须在链头显式标注 `chain_depth: N`，供召回侧决定是否顺链。

**价值**：保留审计链（可追溯「当时为什么这么判」）+ 支持回滚 + 避免旧事实与新事实同时被召回造成矛盾。

## 条目标长与外置（value 不进膨胀）

> **动机**：一条被高频召回的记忆若自身很长，等于**每次命中都全额付费**。记忆条目的价值在**结论**，不在承载的原始材料。

**纪律**：

1. **实例层条目（`lesson:*` / `reflection:*` / `experience:*`）value ≤ 40 行**（约 2000 字符）。超限 → **外置**：原文写文件，条目内保留「结论 + 路径引用」。
2. **外置引用格式（唯一格式，便于机器识别）**：
   ```text
   ## 原文
   ref: <相对路径或 artifact ref>
   ```
   条目正文只保留可独立理解的结论；**不得**只留一句"详见文件"而不留结论（那样条目失去召回价值）。
3. **允许超限的例外**：`rule:*` / `skill:*` 规则条目（其正文即规则本体，本就要全文执行）；`principle:*`（抽象层级高、通常很短）。
4. **规则条目的反向纪律**：`skill:*` 规则条目不得内嵌大段**示例代码 / 完整日志 / 整篇文档** —— 那些走外置（见上第 2 条）。规则条目只承载**规则 + 判定口径 + 最小反例**。
5. **检查时机**：写入时（超限即外置，不等事后清理）；周期 Consolidation 时复核（仅提示，不自动改写正文）。

> **与宿主的关系**：宿主 Skill 规定回写时机与回执格式；长度上限与引用格式由本节承载。

## Memory Consolidation 协议（周期聚合）

> 非每轮必经；周期聚合（跨多轮批量整理）时执行。宿主 Skill 的每轮 S12 收尾走其实例 `promotion.md` 的 2 步精简清单。

8 个 Phase 的执行顺序；各 Phase 的规则本体见宿主 Skill 的 `promotion.md` / `lifecycle.md` 对应节：

| Phase | 动作 |
|---|---|
| 1 收集 | `memory_list` 取本周期 lesson / reflection（三个 tag） |
| 2 合并 | 同类合并，保留质量最高一条（不自动删除） |
| 3 指纹 | 对每条新 lesson / reflection 计算 fingerprint |
| 4 去重与 Merge | 过严格否决规则 → create / update / skip / contradict |
| 5 提升检查（轻量） | ≥3 同类 → pattern；≥5 且 ≥2 项目 → principle |
| 6 CodeGraph 验证 | 涉及代码路径/签名的记忆 → 验证 → 更新或标记过期 |
| 7 到期检查（懒计算） | 仅 TTL 到期前 30 天算 relevance_score |
| 8 待淘汰清理 | < 0.3 且已到期 → 按「记忆操作授权模型」**自主删除**（义务：归属为本方 + 可回滚证据；≥5 条先输出淘汰清单） |

## 跨项目模式迁移

Pattern fingerprint 是语言/框架无关的抽象。当在新项目中检测到与已有模式匹配的问题时，主动提示：

```text
Preflight → `memory_list(prefix="pattern:")`（全局 namespace）
  → 命中 pattern:async-state-race（项目 A 3 次，项目 B 1 次）
  → 🌐 跨项目模式提醒：
    项目 A + 项目 B 均遇到 pattern:async-state-race
    建议在本项目中重点关注异步状态完整性
```

实现：
- Pattern key 使用全局 namespace（不绑定项目哈希）
- `memory_search` 时不限定 namespace（或显式使用 `global` namespace）
- Pattern 的 fingerprint 计算时不包含技术栈细节（仅抽象类型）
- Principle key 强制使用全局 namespace

## 跨项目失效传播

当修改了跨项目共享文件时：

1. `memory_search` 检索引用该文件路径的所有记忆
2. 对命中的关联项目记忆执行 `memory_set` → 添加 `stale` tag
3. 提示：`⚠️ 关联项目记忆已标记 stale：<key列表>`
4. 下次进入关联项目时，Preflight 优先加载 stale 记忆 → codegraph 验证 → 更新或清除 stale tag
