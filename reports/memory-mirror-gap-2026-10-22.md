# 5 条 `mirror_gap` 的逐条分析（2026-10-22）

> 输入：`reports/memory-distill-2026-10-22.json` 中 `mirror.verify_state == "gap"` 的 5 条记录（`mirror_gap=true`）。
> 方法：读记忆全文 + 完整 metadata/evidence_ids → 读对应 Skill 文件与引用点 → 逐句比对（含反例、边界、指针链）。
> **本轮不写库、不改 Skill、不合并任何记录。** 文末有零写入校验。
> 「重复出现」判定：`skills/vibe-coder-loop/backup/**` 下的 `skill_memory_*.json` 是记忆**快照**，不作为 Skill 侧覆盖证据；也不作为跨项目验证。

## 0. 结论速览

| # | 记忆 key | gap 类型 | 覆盖判定 | 是否需拆 | 建议 |
|---|---|---|---|---|---|
| 1 | `skill:references/debug-mode` | 骨架页下沉 | 部分覆盖（摘要 3 行） | 否（1 单元） | **L4 保持**，不提炼 |
| 2 | `skill:references/output-format` | 骨架页下沉 | 部分覆盖（摘要 3 行） | 否（1 单元 + 反例集） | **L4 保持**，不提炼 |
| 3 | `skill:rules/orchestration:subagent-reverify` | 指针 + 摘要 | 部分覆盖（1 行指针 + 三类枚举） | **是（2 单元）** | (a) **L4 保持**；(b) **L3 候选**（先并证据，不新建） |
| 4 | `skill:rules/review:doc-structure-recheck` | 指针 + 摘要 | 部分覆盖（1 行规则） | 否（1 单元） | **L4 保持**，不提炼（L3 已存在） |
| 5 | `skill:rules/review:hard-constraints` | 模板化镜像 | 表述不同但含义一致 + 1 条边界增量 | 否（1 单元） | **暂不提炼**，权威归 `safety.md §3` |

**总判定：本轮 5 条均不建议新增 L5/L7；1 条可拆出 L3 候选但建议先并入既有 pattern 证据链。0 条具备 L5 门槛（≥2 独立项目）。**

---

## 1. `skill:references/debug-mode`（525 字，E2，pending）

**记忆侧**：触发条件 3 项 / 调试模式 4 步行为 / 标签处理（调试模式不进入工程循环、可省 `[Loop: N]`）。
**Skill 侧**：`references/debug-mode.md` 全 18 行，L12 明写「完整触发条件/行为/标签处理已下沉为 `skill:references/debug-mode`……本文件摘要只用于定位，不得作为规则推断依据」；L14–18 为 3 行摘要。加载路由见 `SKILL.md:84`、`load_plan.json:197`。

**覆盖判定：设计性下沉（部分覆盖）**

| 内容 | 文件 | 记忆 |
|---|---|---|
| 3 项触发条件 | 摘要保留（措辞压缩） | 完整（含「满足任一即进入」） |
| 4 步行为 | 摘要保留（单行压缩） | 完整（4 条编号） |
| 标签处理（Loop 可省的理由） | **无** | 完整 |
| fail-closed 语义 | 有（`[RULE_STORE_MISSING]`） | 无 |

**知识单元判断**：1 个单元。三段是同一协议的组成部分，拆开会让「条目不可用 → fail-closed」的引用链碎裂。
**建议：L4（task 作用域规则）+ 保持现 key，不提炼 L3/L5。**
- 依据：内容是可执行协议，不是经验教训；无实例引用（`evidence_ids=["anchor:value:path"]`，无 lesson/日期），不满足 L3 的「记录支持任务与证据」。
- 适用范围：`scope:task`，任务类型 = 调试。
- 反例/失效条件：纯知识问答、代码解释类请求不应触发该模式（记忆未写明此边界）。
- 证据缺口：缺 1 条真实调试会话的实例锚点（含错误栈与最终根因），否则只能停在 E2。
- **治理风险（P1）**：唯一全文在记忆里，与「权威源唯一 = `skills/`」冲突；若该条目被合并/TTL 清理，按设计会触发 `[RULE_STORE_MISSING]` 直接停机。建议（不在本轮执行）：把全文回填 `references/debug-mode.md`，或在该条目加 `authority: memory-fulltext` 显式承认倒置。

## 2. `skill:references/output-format`（920 字，E2，pending）

**记忆侧**：层级组织 5 条（两级层级/审查例外/emoji 位置/固定 emoji 保留项）+ 代码块 2 条 + 反例 5 组 + 指针（归档注释格式见 `policy/safety.md §4`）。
**Skill 侧**：`references/output-format.md` 全 18 行，L12 同样声明「已下沉为 `skill:references/output-format`」，L14–18 为 3 行摘要（层级/emoji/伪代码三点）。路由见 `SKILL.md:81`、`engine/router.md:34,52`（Level 0-Doc 三维审查、Investigation 格式检查）。

**覆盖判定：设计性下沉（部分覆盖）**

| 内容 | 文件 | 记忆 |
|---|---|---|
| 两级层级规则 | 摘要 1 行 | 完整（含「不使用 `####`」） |
| 审查输出允许多级 | 摘要 1 行 | 完整 |
| emoji 放文字之后 | 摘要 1 行 | 完整（含审查模板固定 emoji 可前置的例外） |
| **反例 5 组（❌/✅ 对照）** | **无** | 完整 |
| 归档注释格式 | 不涉及 | 仅指针 → `safety.md §4`（一致） |

**知识单元判断**：1 个规范单元 + 1 组**反例资产**（反例是独立可复用的教学材料，但仍属该规范的判定口径，不建议拆成独立层）。
**建议：L4 保持，不提炼。**
- 依据：属格式规范（约定），非任务经验；「反例」是规范的判定示例，不是独立知识。
- 适用范围：所有阶段输出；审查阶段例外。
- 反例（记忆自带）：`🔴 数据不一致` ❌ / `数据不一致 🔴` ✅；`#### 子标题` ❌ / `**子标题：**` ✅。
- 证据缺口：无反例来源事故（未记哪次输出触发了该规则），E2。
- 同上 P1：全文仅在记忆 + fail-closed。

## 3. `skill:rules/orchestration:subagent-reverify`（1194 字，E2，pending）

**记忆侧**：三类结论 → 复核动作表（3 行，每行含「已知陷阱」）+ 验证命令自检 3 条 + 反模式 4 条 + 边界（资产保护复核并行）。
**Skill 侧**：`rules/orchestration.md:66` 只有 1 行指针（「子 agent 的『已修/已注释/已删除/N 处零引用』都是转述，须按 `skill:rules/orchestration:subagent-reverify` 三类核查后再采信」）；另 `:85` 说明「结论维度同属主 agent 责任」。文件内**没有**复核动作、陷阱、验证命令自检、反模式。

**覆盖判定：指针 + 摘要（部分覆盖）**——文件承担"何时用"，记忆承担"怎么做"。

**知识单元判断：2 个单元**

| 单元 | 内容 | 性质 |
|---|---|---|
| (a) 结论复核协议 | 三类自述 → 动作 + 陷阱（反向回归 / 块注释误报 / 数量级口径） | 编排阶段**规则**，执行细则 |
| (b) 验证命令自检 | 「结论依赖单一命令 → 用第二独立信号交叉验证」；「pathspec 相对当前 workdir，跨目录静默返回空」 | **通用方法论**，不限 subagent 场景 |

**建议**
- (a) **L4 保持**（`rules/orchestration.md` 的执行细则），不升层。
- (b) **L3 候选**（任务级经验：结论类断言需要第二独立信号），但**先不新建条目**：
  - 上位原则已存在：`principle:verify-before-claim`（L7，`promotion_basis` = 8 实例跨 3 项目），(b) 是它的具体实例 → 新建会与 L7 重复。
  - 同主题 pattern 已存在：`pattern:subagent-conclusion-reverify`。
  - 建议动作（未来）：把 (b) 作为 `principle:verify-before-claim` 的实例证据追加到其 `evidence_ids`，而非新建 L3。
- 适用范围：多 subagent 编排的整合阶段；单 agent 不加载。
- 反例（记忆自带）：13 轮循环中子 agent 报「已注释 toHome111」但块注释内裸 grep 仍命中（误报 live）；反向也有误报已修。
- **证据缺口（关键）**：(a)(b) 的实例全部来自 **webbas 单项目**——`lesson:subagent-fix-needs-independent-reverify`（webbas）、`lesson:review-subagent-commentout-verification`（未标项目）、`lesson:dead-code-audit-must-count-docs-and-examples`（未标项目）；`pattern:subagent-conclusion-reverify` 的 3 实例亦全属 webbas 家族（webbas-v2-to-v3 / login 审查 / webbas-engine 审计）。**同一项目多次复现 ≠ 跨项目验证**，不满足 L5 门槛。

## 4. `skill:rules/review:doc-structure-recheck`（859 字，E2，pending）

**记忆侧**：触发条件（同轮 ≥2 次编辑或 >300 行）+ 4 条规则（每轮复检 / 结构指纹三件套 / 行数突变阈值 / 唯一锚点）+ 3 条反模式 + 关联 2 条 lesson。
**Skill 侧**：`policy/safety.md:156` 1 行（「每轮 edit 后重跑结构指纹（章节清单 + 行数突变 + 区块闭合），不能只在首次写入时校验一次」+ 指针）。`rules/review.md` 未单独展开（维度审查在 `skill:rules/review:eight-dimensions`，其中以「关联」形式指向本条）。

**覆盖判定：指针 + 摘要（部分覆盖）**——规则骨架在文件，**判定阈值与命令、反模式只在记忆**。

| 内容 | 文件 | 记忆 |
|---|---|---|
| 「每轮 edit 后复检」 | ✅ 1 行 | ✅ |
| 三件套构成（章节清单/行数/区块闭合） | ✅ 括注列出 | ✅ 含具体命令与「只查表格不够」的依据 |
| 行数突变阈值（预估 vs 实际） | ❌ | ✅ |
| 唯一锚点替换建议 | ❌ | ✅ |
| 反模式 3 条 | ❌ | ✅ |

**知识单元判断**：1 个单元（4 条规则同属"结构完整性复检"口径，拆开会丢"表格全 OK 但章节已丢"这一关键依据）。
**建议：L4 保持，不提炼。**
- 依据：**对应 L3 已存在**——`lesson:long-doc-multi-edit-structure-recheck`（首写校验通过、3 次 edit 后两章静默消失、391→351 行），本条的记忆 `evidence_ids` 已指向它。再提炼 L3 就是同一知识的第三次复制。
- 适用范围：Level 0 文档修改子集（`safety.md §5`）、Level 0-Doc 出口、Review 文档维度、Investigation 产出。
- 反例（记忆自带）：「首写校验通过 → 后续小改无需校验」；事故中表格全 OK、围栏 0 个，两章已丢。
- 证据缺口：事故为单一实例且未标注项目（`attribute_projects` 未命中任何项目 token）→ 无法判断是否跨项目成立。

## 5. `skill:rules/review:hard-constraints`（869 字，E2，pending）

**记忆侧**：L1「主源：`policy/safety.md` §3（唯一事实源）」；Hard 6 项 + #10 条件项的**打勾清单**（含 `#4`–`#10` 编号）；Signal 3 项带「实际 ____ 行/个」填写位；Signal 处理口径；判定（Hard→情况 B；Signal 只影响 `issue_count` 1–5→A / ≥6 结构性→B）；1 条边界（「技能/文档日期版本残留检查不在此清单」）；Level 0 文档任务仅适用安全向子集。
**Skill 侧**：`policy/safety.md §3`（L81–124）有 10 项定义表、Signal 正确处理（天然形态/坏味道）、3 类必标场景、Hard 违规双出口；`rules/review.md:35` 声明「分级与定义见 §3；逐项打勾模板见 `skill:rules/review:hard-constraints`」。

**覆盖判定：表述不同但含义一致（模板化镜像）+ 1 条边界增量**

| 内容 | `safety.md §3` | 记忆 |
|---|---|---|
| Hard 6 + 条件 1 的**定义** | ✅ 权威 | 镜像（编号一致 `#4`–`#10`） |
| 打勾清单形态（可执行） | ❌ 无清单 | ✅ |
| Signal 填写位（实际值） | ❌ | ✅ |
| Signal 处理口径（天然形态/坏味道） | ✅ | 压缩版（一致） |
| 判定短路（Hard→B / Signal→issue_count） | ✅（双出口） | ✅ |
| 「日期版本残留不在此清单」边界 | ❌ | ✅ |
| Level 0 文档子集 | ✅ §5（5 项） | ✅ 指针 |

**知识单元判断**：1 个单元（清单模板）。它没有独立知识本体——所有定义都在 `safety.md §3`。
**建议：暂不提炼（`layer` 维持 L6 候选，但语义应为 L4 镜像；权威不迁移）。**
- 依据：内容 100% 可从 `safety.md §3` 重建，属"同一知识的可执行形态"，不是新知识；升 L4/L5 会制造第二事实源。
- 适用范围：S10 Review 第一步。
- 反例：`Signal` 不得写成"违规"，否则会把 300 行文件机械判为问题（`safety.md §3` 已明确）。
- 唯一增量：「技能/文档日期版本残留不在此清单」——建议以 **Patch Proposal** 形式并入 `safety.md §3` 的边界说明（不新建记忆层）。
- 证据缺口：无实例（纯规范镜像），E2 已属合理上限。

---

## 6. 横向发现

1. **5/5 都不是「Skill 漏写内容」**，而是三种既定设计：骨架页下沉（#1 #2）、指针 + 摘要（#3 #4）、模板化镜像（#5）。
   → `mirror_gap` 这个字段名会误导。建议（Phase 4 工具改进，本轮不做）把 `mirror_gap` 细化为 `gap_kind: sink_by_design | pointer_plus_summary | template_mirror | truly_missing`；本次实测 **`truly_missing = 0`**。

2. **P1 治理风险：2 条规则全文只存在于记忆**（#1 #2）。设计上「条目不可用 → fail-closed 停机」，这意味着：
   - 记忆侧的合并去重（如 2026-10-21 那轮 244→226）若误伤这两条，会直接导致规则不可用；
   - 与「权威源唯一 = `skills/`」冲突。
   建议（不在本轮执行）：作为 Patch Proposal 提给 `skill-authoring` —— 要么把全文回填文件，要么在条目上加 `authority: memory-fulltext` 并在治理侧把它们加入"禁止合并/禁止 TTL 清理"白名单。

3. **跨项目证据普遍不足**：#3 的 3 个实例、`pattern:subagent-conclusion-reverify` 的全部实例都属 webbas 家族；`lesson:long-doc-multi-edit-structure-recheck` 未标注项目。按「同一项目多次 ≠ 跨项目」，**这 5 条一条也不够 L5**。

4. **不建议升层 ≠ 无价值**：#4 的价值已被 L3（`lesson:long-doc-multi-edit-structure-recheck`）承载；#3(b) 的价值已被 L7（`principle:verify-before-claim`）承载。重复升层只会增加召回噪声。
   本轮唯一"可新增知识"是 #3(b) **作为证据**并入既有 L7，而非新条目。

5. **分类口径要补一条**：#5 这类"可执行清单镜像"与 #3/#4 的"执行细则"不同，前者零增量、后者含增量（阈值/命令/反模式）。建议 `layer_basis` 增加 `mirror_kind`，供未来自动判定"是否含增量"。

## 7. 逐条目标内容（建议，未写入）

> 仅为将来 Phase 4 的写入建议文本；本轮不改库。

**#1 `skill:references/debug-mode`** — 字段补充
```json
{ "layer": "L4", "mirror_kind": "sink_by_design", "authority": "memory-fulltext",
  "protected": true, "needs_review": false,
  "boundary": "纯知识问答/代码解释不触发调试模式" }
```

**#2 `skill:references/output-format`** — 同上，另加
```json
{ "assets": ["反例 5 组（❌/✅ 对照）"], "boundary": "审查输出允许多级标题；固定模板 emoji 可前置" }
```

**#3(a) 保持**；**#3(b)** 建议以证据形式并入 L7（不新建 key）：
```json
// principle:verify-before-claim.metadata.evidence_ids +=
["memory:skill:rules/orchestration:subagent-reverify"]
// 并在 value「四类断言」表补一行：
// 「依赖单一命令的结论」→ 第二独立信号（mtime / 仓库根 git status / 直接 grep）+ 校验命令自身的 workdir 基准
```

**#4 `skill:rules/review:doc-structure-recheck`** — 字段补充
```json
{ "layer": "L4", "mirror_kind": "pointer_plus_summary",
  "evidence_ids": ["memory:lesson:long-doc-multi-edit-structure-recheck"],
  "boundary": "同轮 ≥2 次编辑 或 文件 >300 行 才触发" }
```

**#5 `skill:rules/review:hard-constraints`** — 字段补充
```json
{ "layer": "L4", "mirror_kind": "template_mirror", "authority": "skills/vibe-coder-loop/policy/safety.md#3",
  "unique_delta": ["边界：技能/文档日期版本残留不在此清单"] }
```

## 8. 零写入校验

| 校验 | 结果 |
|---|---|
| `corpus_fingerprint`（原始 217 条） | `659166e2f53b3cb8ba535e4f944684222927cbdc6a46a534ee311dbb0c757238` —— 与本轮分析前**一致** |
| 记录数 | 347（217 原始 + 130 衍生），本轮无变化 |
| Skill 文件 | 0 处修改（`git status` 无已跟踪文件变更，仅未跟踪的分析/工具产物） |
| 记录的 tags / value / metadata | 0 处修改（本轮只读） |
