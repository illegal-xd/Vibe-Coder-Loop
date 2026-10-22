# Skill 文件补全 Patch Proposal（2026-10-22）

> **状态：提案，未执行。** 本轮**未修改任何文件、未写数据库**（校验见 §10）。
> 目标：把 `references/debug-mode.md` / `references/output-format.md` 从"骨架 + 记忆全文"改为"文件即完整规则（Canonical = 文件）"，消除"规则全文只存记忆"的 P1 风险。
> 依据：`reports/memory-mirror-gap-2026-10-22.md` §0/§6（两条 `gap_kind = sink_by_design`）。

## 1. 目标与范围

| 项 | 内容 |
|---|---|
| 变更文件 | `skills/vibe-coder-loop/references/debug-mode.md`、`skills/vibe-coder-loop/references/output-format.md` |
| 变更性质 | 内容补全（18 → 31 行 / 18 → 47 行）；不改文件名、不改 frontmatter 字段、不改路径 |
| 不动 | `SKILL.md`、`references/governance.md`、`load_plan.json`、`manifest.yaml`、任何 `skill:*` 记忆条目、Agent 流程 |
| 停机语义 | **保留**：规则库整体未恢复仍 `[RULE_STORE_MISSING]` 停止；仅这 2 个文件不再参与该判定 |

## 2. 影响面（实测定位）

| 引用点 | 现状 | 补全后 |
|---|---|---|
| `SKILL.md:84` | `references/debug-mode.md`（完整内容 `skill:references/debug-mode`） | 路径仍有效；括注变陈旧 → **P2 待改**（见 §9） |
| `SKILL.md:81` | `references/output-format.md`（完整细则 `skill:references/output-format`） | 同上 |
| `load_plan.json:197` | `profiles.debugging` 含 `references/debug-mode.md` | 路径未变，命中不变 |
| `load_plan.json` `stage_sections` | **未收录**这两个文件 → 按整文件读 | 不变（改 H2 标题不影响匹配） |
| `engine/router.md:34,52` | 引用 `references/output-format.md`（Level 0-Doc 三维审查 / Investigation 格式检查） | 路径未变 |
| `profiles/debugging.md:15,36` | 引用 `references/debug-mode.md` | 路径未变 |
| `references/governance.md:57-58` | 两行 `Canonical = C`（条目为完整版） | 语义应改为 `A` → **P2 待改** |
| `manifest.yaml` `dependencies.required: rule_store` | 规则库为必需，缺失停机 | **不变**（其余 ~19 条仍下沉） |

## 3. 补丁（unified diff）

### 3.1 `skills/vibe-coder-loop/references/debug-mode.md`

```diff
--- a/skills/vibe-coder-loop/references/debug-mode.md
+++ b/skills/vibe-coder-loop/references/debug-mode.md
@@ -7,12 +7,25 @@
 status: active
 ---
 
-# 调试模式（骨架版）
+# 调试模式（完整规则）
 
-> **骨架化说明**：完整触发条件/行为/标签处理已下沉为 `skill:references/debug-mode`（level:domain, permanent, reference——加载全文执行）；条目不可用 → 按 `SKILL.md` 的 fail-closed 规则输出 `[RULE_STORE_MISSING]` 并停止；本文件摘要只用于定位，不得作为规则推断依据。
+> **权威声明**：本文件为**完整规则**（Canonical = 本文件），读取本文件即获得全部约束，不依赖记忆条目加载。
+> **停机语义（未变）**：规则库（`skill:*` 条目集合）未恢复 → 仍按 `SKILL.md` 的 fail-closed 规则输出 `[RULE_STORE_MISSING]` + `[next]` 恢复动作并停止，**禁止**用残缺摘要推断。本文件不再参与该停机判定（其内容已在文件内），但规则库整体的 fail-closed 语义不因本次迁移而改变。
+> **镜像关系**：记忆条目 `skill:references/debug-mode` 自本文件补全起转为**镜像 + 指针**（`mirror_of: skills/vibe-coder-loop/references/debug-mode.md`），仅供检索与跨机索引，不构成第二事实源。
 
-## 摘要（仅定位，不作规则推断）
+## 触发条件（满足任一即进入，不进入工程循环）
 
-- 触发：`[DEBUG]`/`[调试]` 开头、堆栈跟踪、用户说"帮我调试"
-- 行为：问上下文 → 按概率排序根因 → 具体修复 → 总结
-- 标签：`[Phase: Debug]` 即可，不强制 Loop 计数（循环外）
+- 用户消息以 `[DEBUG]`/`[调试]` 开头
+- 包含堆栈跟踪（`at xxx:line` 或 `Error: ... at ...`）
+- 用户说"帮我调试这个错误"
+
+## 调试模式下
+
+1. 询问缺失上下文（环境、版本、代码片段）
+2. 按概率排序提出最可能的根本原因
+3. 展示具体的代码更改或命令，不模糊建议
+4. 修复后总结为什么能解决问题
+
+## 标签处理
+
+调试模式**不进入工程循环**（无 S 阶段流转），`[Phase: Debug]` 可用作阶段标注；`[Loop: N]` 可省略。Kernel 的"每次输出必须包含 `[Phase: xxx]` `[Loop: N]`"在调试模式下解释为：输出 `[Phase: Debug]` 标签即可（循环外场景不强制 Loop 计数）。
```

### 3.2 `skills/vibe-coder-loop/references/output-format.md`

```diff
--- a/skills/vibe-coder-loop/references/output-format.md
+++ b/skills/vibe-coder-loop/references/output-format.md
@@ -7,12 +7,41 @@
 status: active
 ---
 
-# 输出格式细则（骨架版）
+# 输出格式细则（完整规则）
 
-> **骨架化说明**：完整格式细则（层级组织/emoji 用法/代码块规范/反例）已下沉为 `skill:references/output-format`（level:domain, permanent, reference——加载全文执行）；条目不可用 → 按 `SKILL.md` 的 fail-closed 规则输出 `[RULE_STORE_MISSING]` 并停止；本文件摘要只用于定位，不得作为规则推断依据。
+> **权威声明**：本文件为**完整规则**（Canonical = 本文件），读取本文件即获得全部格式约束与反例，不依赖记忆条目加载。
+> **停机语义（未变）**：规则库（`skill:*` 条目集合）未恢复 → 仍按 `SKILL.md` 的 fail-closed 规则输出 `[RULE_STORE_MISSING]` + `[next]` 恢复动作并停止，**禁止**用残缺摘要推断。本文件不再参与该停机判定（其内容已在文件内），但规则库整体的 fail-closed 语义不因本次迁移而改变。
+> **镜像关系**：记忆条目 `skill:references/output-format` 自本文件补全起转为**镜像 + 指针**（`mirror_of: skills/vibe-coder-loop/references/output-format.md`），仅供检索与跨机索引，不构成第二事实源。
 
-## 摘要（仅定位，不作规则推断）
+## 层级组织
 
-- 非审查输出最多两级层级：`###` + **粗体**；审查输出允许多级
-- emoji 放文字描述**之后**；审查模板固定 emoji 保留项可前置
-- 伪代码/占位规则见 `rules/code.md`「生成要求」
+- 非审查输出（Clarify、Design、Plan、Code、Test）最多使用两级层级：`###` 标题和 **粗体** 标记，不使用 `####` 及更深标题
+- 审查输出（Review 阶段）允许使用多级标题以组织问题描述和修复方案
+- 主层级：使用 `###` 标题
+- 次级层级：使用 **粗体** + 冒号（如 **关键发现：** xxx）
+- emoji 作为辅助视觉标记，放在文字描述**之后**（如 `数据不一致 🔴`，而非 `🔴 数据不一致`）
+- 审查模板中的固定格式 emoji（`🔎`、`✨`、`🧠`、`📌`、`✅`、`⚠️`）为保留项，允许前置使用
+
+## 代码块
+
+- 代码块外使用自然语句
+- 代码块内保持工程级简洁注释
+- 伪代码和占位规则：见 `rules/code.md`「生成要求」（不再重复）
+
+## 反例
+
+以下反例使用 ❌/✅ 前置仅为教学标记，实际输出中不应使用 emoji 前置。
+
+```text
+❌ 错误：🔴 数据不一致  →  ✅ 正确：数据不一致 🔴
+❌ 错误：#### 子子标题    →  ✅ 正确：**子子标题：**
+❌ 错误：// ... 其他逻辑  →  ✅ 正确：// TODO(verify): 异常处理逻辑待确认
+❌ 错误：// 旧逻辑（裸注释）        →  ✅ 正确：// @Iteration: [v1] 旧累加逻辑被纯函数替代 | 替代者: sumPure
+❌ 错误：物理删除用户既有函数      →  ✅ 正确：归档注释该函数（@Iteration 格式），保留在文件中
+```
+
+> 归档注释完整格式（含 `{替代者}`）唯一事实源 = `policy/safety.md` §4；本文件只示范"标注 vs 裸注释"的对比。
+
+## 变更约束
+
+- 本文件的权威关系见 `references/governance.md`「Canonical Source」；迁移后 `references/output-format.md` 归入**类型 A（文件为事实源）**，映射表对应行需同步。
```

**可应用性已实测**（`git apply --check`，只检查不写盘）：

```text
debug-mode.patch:    APPLIES CLEANLY
output-format.patch: APPLIES CLEANLY
```

## 4. 迁移前后差异

### 4.1 内容项对照

| 内容项 | 原文件 | 新文件 | 判定 |
|---|---|---|---|
| 调试模式 3 项触发 | 摘要压缩 | 全文（含"满足任一即进入"） | 保留 + 补全 |
| 调试模式 4 步行为 | 摘要压缩 | 全文 4 步 | 保留 + 补全 |
| 标签处理（Loop 可省理由） | **缺** | 全文 | 新增（原仅在记忆） |
| 输出层级规则（两级 / 审查例外） | 摘要 1 行 | 全文 6 条 | 保留 + 补全 |
| emoji 位置 + 固定 emoji 例外 | 摘要 1 行 | 全文 | 保留 + 补全 |
| 代码块规范 + 伪代码指针 | 摘要 1 行 | 全文 3 条 | 保留 + 补全 |
| **反例 5 组（❌/✅）** | **缺** | 全文 | 新增（原仅在记忆） |
| 归档注释格式指针（`safety.md §4`） | 不涉及 | 保留指针 | 一致 |
| fail-closed 停机语义 | "条目不可用 → 停机" | "规则库未恢复 → 停机；本文件不参与该判定" | **语义保留并显式化** |

### 4.2 逐行保真核验（脚本比对）

对记忆条目正文逐行（去标题/去列表标记）在新文件中检索：

| 记忆条目 | 有效行 | 新文件未命中 | 结论 |
|---|---|---|---|
| `skill:references/debug-mode` | 9 | **0** | 无删减 |
| `skill:references/output-format` | 19 | 1（见下） | 无删减 |

唯一差异为**措辞适配**（非删除）：
`> 归档注释完整格式…本条目只示范"标注 vs 裸注释"的对比` → `…本文件只示范"标注 vs 裸注释"的对比`
（"条目"改"文件"以匹配新语义；内容、指针、结论均未改）

### 4.3 diffstat

| 文件 | + | − |
|---|---|---|
| `references/debug-mode.md` | 19 | 6 |
| `references/output-format.md` | 35 | 6 |

## 5. 加载 / 引用 / 停机语义核验（实测事实）

1. **`[RULE_STORE_MISSING]` 的真实触发条件**（`SKILL.md:10` + `manifest.yaml:38-44`）：
   `rules/` 等骨架文件的规则条目（`skill:*`）不可用**且**快照未恢复 → 输出该码 + `[next]` 恢复动作并停止；`rule_store` 在 `dependencies.required`。
   → 补全后这 2 个文件**不再依赖条目**，但规则库整体仍是 required，所以码义不变、其它 19 条仍会触发。
2. **加载机制**：`load_plan.json` 的 `stage_sections` 未收录这两个文件 → 读取粒度为**整文件**；因此新增/改名 H2 不会造成节匹配失效。
3. **路径一致性**：所有引用点（§2 表）均按文件名引用，未改路径 → 无死指针风险。
4. **冒烟校验规则**（`scripts/smoke-check.sh`）：① load_plan 路径存在 ② 路径被 SKILL.md 提及 ③ `stage_sections` 匹配串命中真实 H2 ④ governance 映射 key 存在 + 非数据条目须 `permanent`。补丁**不触碰** ①–④ 的输入 → 预期校验通过。
5. **表格一致性检查**（`--table`，可选）：只统计"以 `|` 开头且以 `|` 结尾"的行；反例块内的 `|` 不在行首 → 不参与统计。

## 6. 记忆条目元数据变更建议（**两步门禁，本阶段都不执行**）

### 步骤 A（前置：文件已合并 + smoke-check 退出码 0 + distill 复跑显示 verified）

`skill:references/debug-mode` / `skill:references/output-format` 同样改：

```diff
  "status": "candidate",            →  "status": "active",
  "review_status": "pending",       →  "review_status": "pending",   // 保持：迁移后需人工确认一次
  "needs_review": true,             →  "needs_review": false,
+ "authority": "file",
+ "mirror_kind": "fulltext_mirror", // 原：sink_by_design
+ "mirror_verified": "verified",
+ "mirror_gap": false,
+ "protected": true,                // 防合并/防 TTL 清理
+ "evidence_ids": ["file:skills/vibe-coder-loop/references/debug-mode.md"]   // 追加文件锚点
```

> 门禁未满足时**不得**写这些字段——否则会出现"标记为镜像但权威文件仍不完整"的反向不一致。

### 步骤 B（可选，单独批准）

`layer: L6 → L4`（这两条是可执行规则，不是七字段技能知识；L6 会与"技能知识"语义冲突）。
**本轮不并入步骤 A**：改层会影响 `by_layer_suggestion` 统计与 L6 候选清单，需单独确认。

## 7. 验证方案（按序，全部可通过/不通过判定）

| # | 命令 | 期望 |
|---|---|---|
| 1 | `git apply --check -p1 /tmp/vcl-patch/debug-mode.patch`（及 output-format） | 两条 `APPLIES CLEANLY`（**已实测通过**） |
| 2 | `git apply -p1 /tmp/vcl-patch/*.patch` → `git diff --stat` | 仅 2 文件变更：+19/−6、+35/−6 |
| 3 | 逐行保真断言（§4.2 脚本） | debug-mode 未命中 0；output-format 未命中 1（措辞适配，已声明） |
| 4 | `bash skills/vibe-coder-loop/scripts/smoke-check.sh` | 退出码 **0**；`governance 映射一致性`、`加载计划一致性` 仍通过 |
| 5 | `bash skills/vibe-coder-loop/scripts/smoke-check.sh --table` | 退出码 0（反例块内 `|` 不参与统计） |
| 6 | `python3 scripts/memory/distill.py --dry-run` | 这两条由 `verify_state=gap` → **`verified`**，`mirror_gap=false`；全库 gap **5 → 3** |
| 7 | 读回验证：`sed -n 1,50p` 两个文件 + `grep -F` 关键反例/停机语句 | 全部存在（内容可读、规则可执行） |
| 8 | 步骤 A 元数据写入后：`python3 scripts/memory/migrate.py --verify` | `ok=true`；layer/review 枚举合法；无悬空 evidence |

**任一步失败 → 停止，不进行步骤 A**（记忆条目不标镜像）。

## 8. 回滚

```bash
# 文件回滚（未提交时）
git checkout -- skills/vibe-coder-loop/references/debug-mode.md \
                skills/vibe-coder-loop/references/output-format.md
# 若步骤 A 已执行：从迁移前备份恢复 metadata
python3 scripts/memory/migrate.py --db ~/.delx-memory/db.sqlite \
  --restore ~/.delx-memory/backups/db.sqlite.bak-2026-10-22-l0l7-backfill-v1 --yes
```

## 9. 本轮未做 / 后续必须跟进

| 项 | 影响 | 建议 |
|---|---|---|
| `SKILL.md:81,84` 括注仍写"完整细则 `skill:references/...`" | 语义陈旧（文件已是完整版），但**不失效** | P2，本次不并入（属"其他 Skill 文件"） |
| `references/governance.md:57-58` `Canonical` 仍标 `C` | 与补丁后的类型 A 冲突，冒烟校验**不会报错**（key 存在 + permanent 仍在） | P2，与上一条同批改 |
| 其余 **9 个** 含"骨架化说明"的文件（`rules/code|design|intent|plan|review|test`、`learning/evolution|reflection|skill-metrics`） | 本次只处理 2 个 → 架构上出现 2 条例外 | 若 B 成为长期策略，需统一迁移；否则在 governance 中显式登记"两条例外"及理由 |
| `references/governance.md:7` 仍描述"内容型规则下沉"总原则 | 与新例外不一致 | 同上批次 |

## 10. 零写入校验

| 校验 | 结果 |
|---|---|
| 仓库已跟踪文件 | 0 处修改（仅 `/tmp` 下草稿 + 本报告新建） |
| `git apply --check` | 只检查，不写盘 |
| delx-memory 原始语料指纹 | `659166e2f53b3cb8ba535e4f944684222927cbdc6a46a534ee311dbb0c757238`（与迁移后一致，未变） |
| 记录数 | 347（217 + 130），未变 |

---

## 11. 执行记录（2026-10-22，步骤 1–2 已执行）

**授权范围**：仅应用两份补丁 + 运行 smoke-check + 复跑 distill。未做元数据变更、未提交 Git。

### 11.1 变更落地

```text
19  6  skills/vibe-coder-loop/references/debug-mode.md      (18 → 31 行)
35  6  skills/vibe-coder-loop/references/output-format.md   (18 → 47 行)
2 files changed, 54 insertions(+), 12 deletions(-)
```

`git status --short` 仅这两个已跟踪文件为 ` M`，其余均为未跟踪的报告/工具产物。

### 11.2 smoke-check 结果（`bash skills/vibe-coder-loop/scripts/smoke-check.sh`）

| 检查项 | 结果 |
|---|---|
| 1 日期残留 / 2 版本残留 | ✅ 0 |
| 3 死指针候选 | ✅ 0 |
| 4 governance 映射文件存在 | ✅ 全部存在 |
| 4b 映射表 key 存在性 | ✅ 30 个 key 全部存在 |
| 5 自测 | ✅ PASS |
| 6 加载计划一致性（路径 + stage_sections） | ✅ 全部通过 |
| 6b Checkpoint 可解析 | ✅ |
| **8 行数预算** | ⚠️ **3939 > 3900**（`BUDGET_TOTAL_LINES`，`scripts/smoke-check.sh:44`） |
| HARD 违规 | **0** |
| 退出码 | **2（仅预算超限，非 HARD）** |

**预算基线**：补丁前合计 = 3939 − 54 + 12 = **3897**（本就只剩 3 行余量）；补丁后 3939，超 39 行。单文件预算 320 未超（31 / 47）。

### 11.3 `--table` 结果（退出码 1，**非本次回归**）

```text
✗ [STRUCTURAL_INCONSISTENT] ./policy/safety.md:0: 表格列数不一致
```

定位：`policy/safety.md:126-131` 的归档格式表单元格内有 **转义竖线 `\|`**，检查器按 `split('|')` 计数得 4 vs 5 列 → 误报。
该文件**本次未改动**（`git status` 无 safety.md）→ **预先存在**，属检查器对 `\|` 转义的局限，不是表格真的坏了。

### 11.4 distill 复跑（只读）

| 指标 | 补丁前 | 补丁后 |
|---|---|---|
| `skill:references/debug-mode` | `gap`（0 命中） | **`verified`（5 命中）** |
| `skill:references/output-format` | `gap`（0 命中） | **`verified`（5 命中）** |
| `mirror.verified` | 14 | **16** |
| `mirror.gap_memory_has_extra_content` | 5 | **3** |
| 剩余 gap | debug-mode / output-format / subagent-reverify / doc-structure-recheck / hard-constraints | subagent-reverify / doc-structure-recheck / hard-constraints |
| `zero_side_effect` | True | True |

复跑产物：`reports/memory-distill-2026-10-22-post-patch.json`（保留补丁前基线 `memory-distill-2026-10-22.json` 以便比对）。

### 11.5 数据库零写入

| 校验 | 值 |
|---|---|
| 原始语料指纹 | `659166e2f53b3cb8ba535e4f944684222927cbdc6a46a534ee311dbb0c757238`（未变） |
| 记录数 | 347（217 + 130，未变） |

### 11.6 步骤 A 门禁判定：**未通过，故未执行**

§6 规定的前置条件是「smoke-check 退出码 0」。实际为 **2（预算超限）**，因此：
- **未**写入 `authority` / `mirror_kind` / `mirror_verified` / `protected`；
- 记忆条目仍保持 `status=candidate, review_status=pending, needs_review=true`（与"文件未完全纳入门禁"的现状一致，不会出现"已标镜像但门禁未过"的反向不一致）。

内容层验证（§4.2 逐行保真、§11.4 verified）**已通过**；阻挡项只有预算。

### 11.7 待决策（预算处理，三选一）—— **已按 A1 处置，见 §12**

| 选项 | 动作 | 代价 |
|---|---|---|
| A1 | 调 `scripts/smoke-check.sh:44` `BUDGET_TOTAL_LINES=3900 → ≥3960` | 改 1 个 skill 脚本（本轮授权外） |
| A2 | 把 output-format 的"反例 5 组"外置为独立文件并引用 | 新增文件 + 改引用，规则分散 |
| A3 | 接受 exit 2 为已知状态，预算调整并入 P2 批次 | 门禁语义被弱化（每次 smoke-check 非 0） |

> 建议 A1 与 P2 同批：3897/3900 仅剩 3 行余量，说明预算早已逼近上限，是债务信号而非本次引入。

---

## 12. 预算重推演执行记录（A1，已执行）

### 12.1 语义核实（先查语义，再定数值）

| 问题 | 证据 | 结论 |
|---|---|---|
| 3900 是硬性安全上限吗？ | core 实现：超限走 `[BUDGET_EXCEEDED]` 计数，归入 **`budget_violations`**，退出码 **2**，不计入 `hard` | **不是**安全阈值 |
| 是预警阈值吗？ | 只有单一阈值，无 warning band；超限即 exit 2 | 不是预警，是**容量上限** |
| 有文档定义吗？ | `scripts/smoke-check.sh` 配置注释：「行数预算：防规则膨胀。**棘轮语义 —— 只降不升**；确需上调须在 CHANGELOG 记明理由」 | 语义 = **容量预算 + 棘轮纪律** |
| 其他脚本依赖该值吗？ | 全仓 grep：仅 `smoke-check.sh` 一处；`skill-evaluation/archive/**` 的 `3871/3900` 等为评估证据记录，不做强制 | 无代码级依赖 |
| 历史轨迹 | 3758/3800 → 3870 超限 → **3800→3900（记为「新下限，只降不升」）** → 3871 → 3877 → 3887 → 3892 → 3897 → **3939（本轮）** | 预算被反复逼近，属既有债务 |

### 12.2 为何拒绝 3960

- 3960 − 3939 = **+21 行**；实测自然增速：3871→3897 = **+26 行 / 约 2 天**（不含本次结构性 +54）。
- 即 3960 约等于 **1.5 轮迭代**，下一轮文档改动立即复发 → 正是「反复小幅上调直到测试通过」的模式。

### 12.3 采用的数值与推导

`BUDGET_TOTAL_LINES: 3900 → 4200`

```text
3939（实测）
+ ≈90   已知 3 条 references 待完整化（subagent-reverify / doc-structure-recheck / hard-constraints，约 +30/条）
+ ≈130  10 轮常规迭代余量（按实测 ≈13 行/轮）
= ≈4159 → 取整 4200 作为容量上限（当前余额 261 = 6.2%）
```

- **不是**「3939 + 21」的试探值，而是按「当前内容 + 已知待办 + 迭代余量」推演。
- **预警机制**（显式写入配置注释）：余额 <120 行（>4080）→ 本轮收尾前必须做减法或记明下一轮处置；预警为人工规则（工具只输出合计行数，不在 wrapper 复制 core 校验逻辑）。
- **棘轮纪律**：若决定全面迁移其余 9 个骨架文件（预估 +300~450），必须**重新推演**本值并在 CHANGELOG 追加理由，**不得沿用 4200**。

### 12.4 复跑验证

| 检查 | 结果 |
|---|---|
| `bash scripts/smoke-check.sh` | **退出码 0**，HARD 0，死指针 0，映射 key 30/30，`3939 / 4200`，`BUDGET_EXCEEDED` 计数 0 |
| 日期/版本残留 | 0（新增 CHANGELOG 条目未触发 HARD） |
| 内容逐行保真（补丁后复跑） | debug-mode 未命中 **0**；output-format 未命中 **1**（仅「本条目」→「本文件」措辞适配） |
| `distill` 复跑 | 两条仍 `verified`（各 5 命中）；gap 保持 **3**；`zero_side_effect=true` |
| delx-memory | 指纹 `659166e2…c757238`、347 条，**未写库** |

### 12.5 变更文件清单（本轮）

| 文件 | 性质 | 是否授权内 |
|---|---|---|
| `skills/vibe-coder-loop/scripts/smoke-check.sh` | 预算 3900→4200 + 语义/预警注释 | ✅ 授权项 |
| `skills/vibe-coder-loop/CHANGELOG.md` | 新增「同版本第八批」记录 | ⚠️ **棘轮规则的强制配套**（配置注释要求上调须记 CHANGELOG）；若认为越界可单独回退该段 |
| `reports/known-issue-smoke-table-escaped-pipe.md` | 既有问题独立记录（不改任何被检文件） | ✅ 授权项（第 5 条要求） |

未改：规则正文、反例、数据库、元数据、Git（无提交）。

### 12.6 门禁复评：**已满足** → 元数据变更进入待确认（**未执行**）

§6 前置条件「smoke-check 退出码 0」现已满足。据此给出精确变更方案，**等你确认后执行**：

```diff
# 两条记录同时适用（key 各自对应）
  "status": "candidate"          → "active"
  "review_status": "pending"     → "pending"        // 保留：迁移后仍需人工确认一次
  "needs_review": true           → false
+ "authority": "file"
+ "mirror_kind": "fulltext_mirror"                 // 此前库中该字段不存在（sink_by_design 仅为提案标签）
+ "mirror_verified": "verified"
+ "mirror_gap": false
+ "protected": true                                // 防合并 / 防 TTL 清理
+ "evidence_ids": [ ...existing, "file:skills/vibe-coder-loop/references/<name>.md" ]
+ "layer": "L6" → 维持不变（改 L4 属步骤 B，需单独批准）
```

执行方式：`memory_set` 三列完整回传（value/tags/metadata 读-合并-写），不动 `value` 与 `tags`，改后跑 `memory_get` 复核 + `distill` 确认 `verify_state` 仍为 `verified`。

---

## 13. 元数据变更执行记录（已执行）

**授权**：仅更新 2 条镜像记录；保留 `review_status=pending`、`layer=L6`；不改 `value`/`tags`；不执行 L6→L4；不提交 Git。

### 13.1 写入前核对

| 目标 key | 文件存在 | 写入前 status | layer | review | needs_review | ttl |
|---|---|---|---|---|---|---|
| `skill:references/debug-mode` | ✅ 1632B | candidate | L6 | pending | true | NULL |
| `skill:references/output-format` | ✅ 2699B | candidate | L6 | pending | true | NULL |

### 13.2 变更前后（逐字段）

两条记录**变更完全相同**：

| 字段 | 前 | 后 |
|---|---|---|
| `status` | `candidate` | `active` |
| `needs_review` | `true` | `false` |
| `authority` | （不存在） | `file` |
| `mirror_kind` | （不存在） | `fulltext_mirror` |
| `mirror_verified` | （不存在） | `verified` |
| `mirror_gap` | （不存在） | `false` |
| `protected` | （不存在） | `true` |
| `evidence_ids` | `["anchor:value:path"]` | `["anchor:value:path", "file:skills/vibe-coder-loop/references/<name>.md"]` |
| `review_status` | `pending` | **`pending`（按要求保留）** |
| `layer` | `L6` | **`L6`（按要求保留）** |
| `value` / `tags` / `ttl` / `created_at` / `updated_at` | — | **逐项比对未变** |

写入方式：单事务、**只 UPDATE metadata 列**（`value`/`tags`/`ttl_expires_at`/`updated_at` 不在 SET 子句内）。未使用 `memory_set`，因其会重写 value/tags/ttl/updated_at，无法满足"不得修改 value、tags"的要求。

### 13.3 写入后验证

| 检查 | 结果 |
|---|---|
| 不变量（value/tags/ttl/created_at/updated_at 逐条比对） | **5/5 PASS × 2 条** |
| `memory_get` 复核 | 两条均返回新 metadata（`authority=file`、`mirror_kind=fulltext_mirror`、`needs_review=false`） |
| `distill` 复跑 | 两条 `verify_state=verified`（5 命中）、`mirror_gap=false`；全库 gap 保持 **3**；`zero_side_effect=true` |
| `migrate --verify` | `ok=true`；枚举非法 0；悬空 evidence 0；`approved_but_candidate` 0 |
| 记录数 | **347**（217 原始 + 130 衍生，未变） |
| 原始语料指纹 | `659166e2f53b3cb8ba535e4f944684222927cbdc6a46a534ee311dbb0c757238`（**未变**） |
| `fulltext_mirror` 记录数 | 2（仅目标两条） |
| layer 分布 | L3 94 · L4 63 · L5 9 · **L6 29** · L7 1 · null 21（未变） |
| review 分布 | pending 207 · approved 10（未变） |
| 记忆门禁 `test-memory-layers.sh` | 8/8 PASS（含真实库零写入断言） |

### 13.4 残留（未处理，需单独授权）

- 两条记录的 **value 正文**仍写着「主源：…（骨架页保留触发摘要，本条目为完整内容）」——「骨架页保留触发摘要」在文件补全后已不准确；按"不改 value"要求**未动**。
- `SKILL.md:81,84`、`references/governance.md:57-58`（Canonical A/C）仍未同步，属 P2。
- `--table` 对 `policy/safety.md` 转义竖线误报未处理，见 `reports/known-issue-smoke-table-escaped-pipe.md`。
