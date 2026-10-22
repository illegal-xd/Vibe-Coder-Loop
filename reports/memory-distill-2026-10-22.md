# delx-memory 分层 dry-run 报告（2026-10-22）

> 生成：2026-10-22T02:00:46Z　**dry_run=True**　写路径：不存在　零副作用：**True**
> 语料指纹 before=`659166e2f53b3cb8…` after=`659166e2f53b3cb8…`
> 口径确认：导航判 layer=null ✅／非知识轴 layer=null ✅／L6 仅候选+mirror_of ✅（2026-10-22 用户确认）

## 1. 切片预览与数量

| 产出 | 条数 | 说明 |
|---|---|---|
| L1 原子观测切片 | 119 | 从父条目「触发/根因/修正/结果」小节逐条 verbatim 切片 |
| L2 Episode 候选 | 11 | 同任务+同项目+同日聚合，附 observation_keys |
| L4 候选 | 63 | 现有 project/rule 约定条目（非新增内容） |
| L5 候选 | 9 | 其中跨 ≥2 项目、达标 L5：**6** |
| L6 候选 | 29 | 七字段达标（≥5）：**0**；字段数分布 {3: 2, 1: 18, 2: 5, 0: 4} |
| L7 候选 | 1 | 全部 pending，需人工审核 |

## 2. 质量评估

- 知识条目 **196** / 全部 217；非知识轴 21 条**不计入** L4–L7 覆盖率
- 层级分布（仅知识条目）：{'L3': 94, 'L4': 63, 'L5': 9, 'L6': 29, 'L7': 1}
- 证据覆盖：203/217 条有 `evidence_ids`（0.935）；**E0（无任何锚点）= 18 条**
- 证据等级分布：{'E2': 141, 'E4': 48, 'E0': 18, 'E3': 9, 'E1': 1}（E4/E3/E1 为记录自述；**E2 = 仅锚点存在、记录未自述等级的推断值**；E0 = 无任何锚点）
- 审核：pending 206 ／ approved(用户显式指定) 11 ／ needs_review 62
- 冲突：带冲突/取代标记 15 条，**自动合并 0 条**

### Skill 镜像边界（L6）

| 项 | 数量 |
|---|---|
| skill:* 总数 | 31 |
| 已解析 mirror_of | 27 |
| 内容可核验（≥2 片段命中） | 14 |
| 部分核验（1 片段命中） | 8 |
| **记忆含 Skill 未覆盖内容**（0 命中，保留并评估提炼） | 5 |
| 无法确定权威文件（不猜路径，标待审） | 4 |

| key | mirror_of | 来源 | 可核验 | 七字段 |
|---|---|---|---|---|
| `skill:learning/evolution:patch-proposal` | `skills/vibe-coder-loop/learning/evolution.md` | declared | ◐1 | 3/7 |
| `skill:learning/evolution:trigger-conditions` | `skills/vibe-coder-loop/learning/evolution.md` | declared | ◐1 | 1/7 |
| `skill:learning/memory:observation-window` | `skills/vibe-coder-loop/learning/memory/promotion.md` | declared | ◐1 | 2/7 |
| `skill:learning/memory:query-router` | `skills/vibe-coder-loop/learning/memory/retrieval.md` | declared | ✅3 | 1/7 |
| `skill:learning/metrics:early-warning` | `skills/vibe-coder-loop/learning/skill-metrics.md` | declared | ✅2 | 1/7 |
| `skill:learning/metrics:fields` | `skills/vibe-coder-loop/learning/skill-metrics.md` | declared | ✅2 | 2/7 |
| `skill:learning/reflection:card-template` | `skills/vibe-coder-loop/learning/reflection.md` | declared | ✅4 | 3/7 |
| `skill:learning/reflection:triggers` | `skills/vibe-coder-loop/learning/reflection.md` | declared | ◐1 | 2/7 |
| `skill:policy/priority:conflict-resolution` | `skills/vibe-coder-loop/policy/priority.md` | declared | ✅5 | 2/7 |
| `skill:references/debug-mode` | `skills/vibe-coder-loop/references/debug-mode.md` | declared | ⚠️0 | 1/7 |
| `skill:references/output-format` | `skills/vibe-coder-loop/references/output-format.md` | declared | ⚠️0 | 1/7 |
| `skill:rules/code:async-defense` | `skills/vibe-coder-loop/rules/code.md` | declared | ◐1 | 1/7 |
| `skill:rules/code:prechecks` | `skills/vibe-coder-loop/rules/code.md` | declared | ✅2 | 1/7 |
| `skill:rules/design:mirror-sync` | `skills/vibe-coder-loop/rules/design.md` | declared | ✅5 | 0/7 |
| `skill:rules/design:state-matrix` | `skills/vibe-coder-loop/rules/design.md` | declared | ✅3 | 1/7 |
| `skill:rules/design:verify-first` | `skills/vibe-coder-loop/rules/design.md` | declared | ✅3 | 1/7 |
| `skill:rules/intent:decision-arbitration` | `skills/vibe-coder-loop/policy/safety.md` | declared | ✅5 | 1/7 |
| `skill:rules/intent:goal-triple` | `skills/vibe-coder-loop/rules/intent.md` | declared | ✅2 | 1/7 |
| `skill:rules/orchestration:subagent-reverify` | `skills/vibe-coder-loop/rules/orchestration.md` | convention | ⚠️0 | 1/7 |
| `skill:rules/plan:step-orchestration` | `skills/vibe-coder-loop/rules/plan.md` | declared | ✅5 | 0/7 |
| `skill:rules/review:case-templates` | `skills/vibe-coder-loop/rules/review.md` | declared | ◐1 | 0/7 |
| `skill:rules/review:doc-structure-recheck` | `skills/vibe-coder-loop/rules/review.md` | convention | ⚠️0 | 1/7 |
| `skill:rules/review:eight-dimensions` | `skills/vibe-coder-loop/rules/review.md` | declared | ✅4 | 1/7 |
| `skill:rules/review:hard-constraints` | `skills/vibe-coder-loop/policy/safety.md` | declared | ⚠️0 | 0/7 |
| `skill:rules/review:verdict-path` | `skills/vibe-coder-loop/rules/review.md` | declared | ◐1 | 1/7 |
| `skill:rules/test:degradation` | `skills/vibe-coder-loop/rules/test.md` | declared | ✅2 | 2/7 |
| `skill:rules/test:task-spec` | `skills/vibe-coder-loop/rules/test.md` | declared | ◐1 | 1/7 |
| `skill:references/dead-code-audit` | — | — | ❌0 | 1/7 |
| `skill:system:metrics` | — | — | ❌0 | 1/7 |
| `skill:vibe-coder-loop:metrics` | — | — | ❌0 | 0/7 |
| `skill:vibe-coder-loop:rollback-point` | — | — | ❌0 | 1/7 |

### L5 跨项目证据矩阵

| pattern | 声明实例 | 硬引用 | 软匹配 | 项目 | 达标 L5 | 建议层 |
|---|---|---|---|---|---|---|
| `pattern:async-state-race` | 3 | 1 | 5 | webbas | ❌ | L4 |
| `pattern:batch-rewrite-integrity` | 6 | 0 | 3 | litecap, obsidian, webbas | ✅ | L5 |
| `pattern:external-api-drift-source-first` | 6 | 0 | 3 | delx-memory | ❌ | L4 |
| `pattern:fail-visible-not-silent` | 6 | 0 | 3 | delx-memory, webbas | ✅ | L5 |
| `pattern:js-runtime-memory-measurement` | — | 5 | 10 | delx-memory, pnpm, webbas | ✅ | L5 |
| `pattern:lossless-payload-splice` | — | 0 | 1 | multi-column-markdown | ❌ | L4 |
| `pattern:memoize-on-immutable-published-object` | — | 0 | 1 | multi-column-markdown, obsidian | ✅ | L5 |
| `pattern:memory-writeback-integrity` | — | 5 | 16 | delx-memory, java-vibe-code, jtkl, multi-column-markdown, vue-ui, webbas | ✅ | L5 |
| `pattern:subagent-conclusion-reverify` | 3 | 1 | 4 | delx-memory, jtkl, webbas, webtool-deepseek | ✅ | L5 |

### 导航完整性（保留引用，不删除、不猜替代）

- 引用完整：7 条；**需修复**：0 条

## 3. 回填字段预览（逐条 add-only，不改原 key/value/tags）

| key | layer | category | scope | status | review | conf | E | needs_review |
|---|---|---|---|---|---|---|---|---|
| `agent:vc_constraints` | — | navigation | global | active | pending | 0.6 | E2 | 否 |
| `env:skill:ppt-master:install` | — | environment | global | active | pending | 0.6 | E2 | 否 |
| `env:system` | — | environment | global | active | pending | 0.6 | E2 | 否 |
| `experience:delx-memory-runtime-memory` | L3 | knowledge | project | archived | pending | 0.9 | E4 | 否 |
| `experience:smart-layout-vue2-adaptation` | L3 | knowledge | global | active | pending | 0.6 | E2 | 否 |
| `global:dev-style-rule` | L4 | knowledge | global | active | pending | 0.3 | E0 | 是 |
| `lesson:abort-race-resume-500` | L3 | knowledge | global | active | pending | 0.9 | E4 | 否 |
| `lesson:access-writeback-trigger-gap` | L3 | knowledge | global | candidate | pending | 0.6 | E2 | 是 |
| `lesson:ahash-prefilter-false-negative` | L3 | knowledge | global | active | pending | 0.9 | E4 | 否 |
| `lesson:amc-vscode-preview-integration-constraints` | L3 | knowledge | project | active | pending | 0.6 | E2 | 否 |
| `lesson:antd-form-item-rest-table-radio` | L3 | knowledge | global | active | pending | 0.6 | E2 | 否 |
| `lesson:asptools-member-drift` | L3 | knowledge | project | active | pending | 0.75 | E3 | 否 |
| `lesson:bulk-path-migration-checklist` | L3 | knowledge | project | active | pending | 0.6 | E2 | 否 |
| `lesson:checkbox-disabled-vs-button-disabled-dual-safety` | L3 | knowledge | global | active | pending | 0.3 | E0 | 是 |
| `lesson:checkpoint-instance-growth` | L3 | knowledge | project | active | pending | 0.9 | E4 | 否 |
| `lesson:cliproxyapi-sdk-embed-minimal-host` | L3 | knowledge | global | active | pending | 0.6 | E2 | 否 |
| `lesson:codegraph-rules-deletion` | L3 | knowledge | global | active | pending | 0.3 | E0 | 是 |
| `lesson:compaction-e4-unverified-reminder` | L3 | knowledge | project | active | pending | 0.9 | E4 | 否 |
| `lesson:context-cost-lever-is-tool-surface` | L3 | knowledge | global | active | pending | 0.9 | E4 | 否 |
| `lesson:dataview-file-tags-includes-frontmatter` | L3 | knowledge | project | active | pending | 0.75 | E3 | 否 |
| `lesson:dataview-port-global-vs-dv-method` | L3 | knowledge | global | active | pending | 0.75 | E3 | 否 |
| `lesson:dead-code-audit-must-count-docs-and-examples` | L3 | knowledge | global | active | pending | 0.6 | E2 | 否 |
| `lesson:declarative-continuity-needs-enforcement` | L3 | knowledge | project | active | pending | 0.3 | E0 | 是 |
| `lesson:delx-memory-tags-storage-format` | L3 | knowledge | global | active | pending | 0.9 | E4 | 否 |
| `lesson:doc-path-verify-before-reference` | L3 | knowledge | global | active | pending | 0.9 | E4 | 否 |
| `lesson:dynamic-import-static-deps` | L3 | knowledge | global | active | pending | 0.6 | E2 | 否 |
| `lesson:engine-safegetsession-double-parse` | L3 | knowledge | project | active | pending | 0.9 | E4 | 否 |
| `lesson:entry-opened-without-downstream-rules` | L3 | knowledge | global | active | pending | 0.6 | E2 | 否 |
| `lesson:fail-closed-over-silent-degradation` | L3 | knowledge | global | active | pending | 0.9 | E4 | 否 |
| `lesson:fake-green-mock-returns-null` | L3 | knowledge | global | active | pending | 0.9 | E4 | 否 |
| `lesson:ffi-crate-api-drift` | L3 | knowledge | global | active | pending | 0.9 | E4 | 否 |
| `lesson:file-split-overwrite-chain` | L3 | knowledge | global | active | pending | 0.9 | E4 | 否 |
| `lesson:fixed-segment-duration-assumption` | L3 | knowledge | global | active | pending | 0.9 | E4 | 否 |
| `lesson:framework-agnostic-abstraction-pitfalls` | L3 | knowledge | global | active | pending | 0.6 | E2 | 否 |
| `lesson:fresh-context-subagent-validation` | L3 | knowledge | global | active | pending | 0.6 | E2 | 否 |
| `lesson:gh-release-asset-visibility-lag` | L3 | knowledge | global | active | pending | 0.3 | E0 | 是 |
| `lesson:go-build-offline-toolchain-from-modcache` | L3 | knowledge | global | active | pending | 0.6 | E2 | 否 |
| `lesson:hard-constraint-bypass` | L3 | knowledge | project | active | pending | 0.9 | E4 | 否 |
| `lesson:holiday-year-baseline-switch` | L3 | knowledge | project | candidate | pending | 0.6 | E2 | 是 |
| `lesson:html-fragment-parse-context-decides-tags` | L3 | knowledge | global | active | pending | 0.6 | E2 | 否 |

> 共 217 条将获得字段补充；完整明细见 JSON `backfill_preview`。

## 4. L1 切片样例（verbatim，未改写）

- `obs:abort-race-resume-500-1` ← lesson:abort-race-resume-500「根因」：AbortController.abort() 只断开**前端**连接；请求可能已到达服务端并**写入成功**，只是响应未返回
- `obs:abort-race-resume-500-2` ← lesson:abort-race-resume-500「根因」：前端把被 abort 的分片视为「未上传」（uploadedIndexes 未记录）→ resume 时补传该片
- `obs:abort-race-resume-500-3` ← lesson:abort-race-resume-500「根因」：后端 upload 若**非幂等**（按 chunkIndex 存储，重复写入报错）→ 500/400
- `obs:abort-race-resume-500-4` ← lesson:abort-race-resume-500「根因」：修复前 resume 走「直接补传不 get」的产品语义（create 会话内一次），恰好没有查询服务端真实已收片
- `obs:access-writeback-trigger-gap-1` ← lesson:access-writeback-trigger-gap「根因（E2+，技能文档交叉验证）」：**执行侧**：agent 输出 `[Phase: S1 Intent]` 后直接进入工作，跳过 S2 Preflight 记忆路由（SKILL.md 加载时机索引要求 S2 读 learning/memory.md + 主动关联召回 pa
- `obs:access-writeback-trigger-gap-2` ← lesson:access-writeback-trigger-gap「根因（E2+，技能文档交叉验证）」：**技能侧结构性缺陷（本次修复重点）**：计数回写触发点全部绑定 S8（Level 0）/S10（Level 1）/S12（Level 2+）出口；S13 原只检查"计数回写欠账队列"——该队列仅覆盖"回写执行时失败"的标记，**不覆盖"a
- `obs:access-writeback-trigger-gap-3` ← lesson:access-writeback-trigger-gap「根因（E2+，技能文档交叉验证）」：8-05 只修复了回写时的 metadata/tags 格式（整体替换语义），未修复触发不落地——所以第三次复现。
- `obs:access-writeback-trigger-gap-4` ← lesson:access-writeback-trigger-gap「根因（E2+，技能文档交叉验证）」：**第 5 次新增根因**：lesson 的读取义务写在 SKILL 协议（memory.md / query-router）内，SKILL 不可达（相对路径失效）时读取义务整体失效——lesson 存库 ≠ 会被读。修复：Kernel 身
- `obs:codegraph-rules-deletion-1` ← lesson:codegraph-rules-deletion「教训」：编辑 `.codegraph/rules/` 前先用 `codegraph_rules_list` 确认正确规则名
- `obs:codegraph-rules-deletion-2` ← lesson:codegraph-rules-deletion「教训」：使用安全工作流：read → backup → patch → verify
- `obs:codegraph-rules-deletion-3` ← lesson:codegraph-rules-deletion「教训」：避免对 rules 文件直接执行 delete 操作
- `obs:codegraph-rules-deletion-4` ← lesson:codegraph-rules-deletion「教训」：写入后必须验证文件存在且内容正确

> 共 119 条切片；全部 `status=candidate` + `review_status=pending`，未写入。

## 5. 本轮不做的事

- 未写入任何记录、未建索引、未改 `updated_at`、未改 tags/metadata。
- 未创建/发布/修改任何正式 Skill；未触碰 `skill-authoring/` 流程。
- 未删除任何原始记录；未自动合并任何重复或冲突。

