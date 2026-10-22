# delx-memory 分层质量复核报告（2026-10-22）

> 本报告所有数字来自**实际执行**：`python3 -m unittest discover -s tests/memory`、
> `bash scripts/tests/test-memory-layers.sh`、`scripts/memory/audit_memory.py`、`scripts/memory/migrate.py --verify`。
> 迁移标识：`l0l7-backfill-v1`　迁移前备份：`~/.delx-memory/backups/db.sqlite.bak-2026-10-22-*-l0l7-backfill-v1`

## 1. 测试结果

| 套件 | 命令 | 结果 |
|---|---|---|
| 单元测试（17 例） | `python3 -m unittest discover -s tests/memory` | `Ran 17 tests in 1.594s` → **OK** |
| 门禁（8 项） | `bash scripts/tests/test-memory-layers.sh` | **8 passed, 0 failed** |

门禁逐项：

| 项 | 内容 | 结果 |
|---|---|---|
| 1 | `tests/memory` 全量通过 | PASS |
| 2 | 真实库只读 audit（不写库） | PASS |
| 3 | dry-run 输出结构合法 | PASS |
| 4 | dry-run 零副作用（指纹一致） | PASS |
| 5 | 首次 apply + verify 通过 | PASS |
| 6 | 二次 apply 幂等（`updated=0 inserted=0`） | PASS |
| 7 | 从备份恢复后原始语料指纹一致 | PASS |
| 8 | 测试全程真实库未被改动 | PASS |

### 测试项 ↔ 任务书要求对照

| # | 要求 | 覆盖用例 |
|---|---|---|
| 1 | 层级枚举与分类合法性 | `TestClassification.test_layer_enum` / `test_navigation_not_counted` |
| 2 | 原始数据完整性 | `TestApply.test_apply_preserves_originals_and_is_idempotent`（value/tags/created_at/updated_at 逐条比对） |
| 3 | 记忆与证据引用完整性 | `TestVerify.test_dangling_evidence_detected` + verify `dangling_evidence` |
| 4 | 精确/近似重复候选识别 | audit `exact_duplicates` / `near_duplicates`（只出候选） |
| 5 | 冲突不被错误合并 | `TestPlanShape.test_plan_counts_and_pending`（`auto_merged == 0`） |
| 6 | 蒸馏不覆盖原始数据 | `test_dry_run_no_side_effect` + 指纹一致性 |
| 7 | 用户修正/失败信号/约束不静默丢失 | 迁移 add-only（不删任何记录）+ `test_apply_preserves_originals…` |
| 8 | 待审候选不被标 approved | `TestMerge` / `test_candidate_never_approved` |
| 9 | 分层回填幂等性 | 二次 apply `0/0` + `TestApply` |
| 10 | dry-run 无副作用 | `test_dry_run_no_side_effect` |
| 11 | 中断后安全重试 | `test_interrupted_apply_can_resume`（`MIGRATE_FAIL_AFTER_BATCHES` 注入故障） |
| 12 | 备份恢复与历史引用完整 | `test_backup_then_restore_keeps_fingerprint` + `test_backup_never_overwrites` |
| 13 | 旧数据读取兼容 | 217 条原 key 全部可读，MCP `memory_get` / `memory_list` 实测正常 |
| 14 | L6/L7 审核门槛 | `test_l6_mirror_points_to_existing_file` / plan `l7 review_status=pending` |
| 15 | 原则超限不覆盖 | `test_principle_cap_flagged`（12 条原则仍全在，仅报「超 10 条上限」） |

## 2. 数据完整性

| 检查 | 结果 |
|---|---|
| 原始语料指纹（迁移前 → 迁移后） | `659166e2…c757238` → 同值，**未变** |
| 原记录总数字段 | 217 → 217（未删除、未新增替代） |
| `value` / `tags` / `created_at` / `updated_at` | 逐条比对一致（`UPDATE` 只写 `metadata`） |
| 备份可读性与一致性 | `VACUUM INTO` + `integrity_check=ok` + 行数一致 + 指纹一致 |
| 悬空 `evidence_ids` | 0 |
| 枚举非法（layer / review_status） | 0 / 0 |
| FTS 索引同步（衍生记录可检索） | 命中 11 条 |
| 衍生记录数 vs 计划 | 130 / 130 |

## 3. 分类质量

| 指标 | 值 |
|---|---|
| 知识条目 / 非知识轴 | 196 / 21（非知识轴 `layer=null`，不计入 L4–L7 覆盖率） |
| 层级分布 | L3 94 · L4 63 · L5 9 · L6 29 · L7 1 |
| 生命周期 | active 160 · candidate 48 · archived 9 |
| 审核 | pending 207 · approved 10（仅「用户显式指定 + 有锚点」） |
| 证据等级 | E4 48 · E3 9 · E2 141 · E1 1 · E0 18 |
| 无任何来源锚点 | 16（audit `no_source` 口径）；E0 共 18 = 16 条无锚点 + 2 条记录正文自称 E0 |
| 无 `evidence_ids` | 14（其余记录只有 `memory:` 交叉引用，无外部锚点） |

**已知偏差与处理**

1. **E2 是推断值**：记录未自述等级但存在锚点（日期/路径/metadata source）→ 记为 E2，已在报告中标注，不当作已验证结论。
2. **dry-run 与 audit 的 `needs_review` 数量不同**（57 vs 62）属预期：蒸馏环节追加了「E0 无锚点」证据闸门。
3. **L6 七字段达标 0/29**：29 条 `skill:*` 实为**规则镜像**（字段数 0–3），因此全部保留 `candidate + mirror_of`，不升层、不发布。
4. **5 条 `mirror_gap`**：记忆含 Skill 文件未覆盖的内容（`references/debug-mode`、`references/output-format`、`rules/orchestration:subagent-reverify`、`rules/review:doc-structure-recheck`、`rules/review:hard-constraints`）→ 按「保留独立价值」规则保留原记录，待评估提炼 L3/L5。
5. **4 条 mirror 未解析**（不猜路径）：`references/dead-code-audit`、`skill:system:metrics`、`skill:vibe-coder-loop:metrics`、`skill:vibe-coder-loop:rollback-point` → `needs_review=true`。
6. **3 条 pattern 保留 L5 + 待补证**（用户裁决）：`async-state-race`、`external-api-drift-source-first`、`lossless-payload-splice` —— 不降 L4，标 `needs_review`，待补第二项目证据。
7. **2 条 `legacy_scope`**（`doc-writing`）与 **1 条 `legacy_confidence="High"`**：旧值域不合规，已迁入 legacy 字段并保留，未丢弃。

## 4. 已知风险与残余问题

| 风险 | 影响 | 现状 |
|---|---|---|
| 130 条衍生记录进入存储 | `memory_list`（无 prefix）会多出 `obs:`/`episode:` 条目 | 已带 `derived` + `candidate` tag；不改召回策略（本轮禁止改 Agent 行为） |
| 18 条 E0（16 条无锚点 + 2 条正文自称 E0） | 置信度上限 0.3 | 已标 `needs_review`，进入人工补证队列 |
| 54 处悬空引用（36 指向归档合并条目、18 真缺失） | 导航/来源链不完整 | 未删除未改写；列在审计报告 §3 待修 |
| 50 条超实例层长度上限 | 召回成本高、升层证据不足 | 未拆分（拆分需逐条人工判断），保留原文 |
| 派生计划随代码口径变化 | 换规则后重算会出现「自愈更新」 | 迁移自有字段以计划为准（`MIGRATION_OWNED`），已实测收敛到 0 变更 |
| MCP 服务与迁移工具并发写 | 写冲突 | 短事务 + `busy_timeout=15s`；实测 217 条回填期间服务正常 |

## 5. 回滚

```bash
python3 scripts/memory/migrate.py \
  --db ~/.delx-memory/db.sqlite \
  --restore ~/.delx-memory/backups/db.sqlite.bak-2026-10-22-095405-l0l7-backfill-v1 --yes
```

恢复后 `original_fingerprint` 回到 `659166e2…c757238`。

已验证路径两条：
1. 单元测试 `test_backup_then_restore_keeps_fingerprint`（fixture 库，迁移前备份 → 写入 → 恢复 → 指纹回到原值）；
2. 真实库快照上手工执行：`VACUUM INTO` 迁移前备份 → apply（217 + 130）→ `--restore` → 行数回到 217、`obs:`/`episode:` 清零、指纹与计划中的 `corpus_fingerprint_before` 一致。

## 6. 本轮未改变

- 未改 Agent 执行流程 / 状态机 / Checkpoint（`runtime/` 未触碰）。
- 未改 MCP 工具契约（无新工具、无字段语义变更）。
- 未新增自动 recall / capture / injection。
- 未改任何 Skill 文件与 `skill-authoring` 流程；未发布任何 Skill。
- 未删除任何原始记忆；未自动合并重复或冲突。
