# delx-memory 分层回填报告（2026-10-22）

> 迁移标识 `l0l7-backfill-v1`　库：`~/.delx-memory/db.sqlite`
> 迁移前备份：`~/.delx-memory/backups/db.sqlite.bak-2026-10-22-095405-l0l7-backfill-v1`（VACUUM INTO，integrity_check=ok，行数+语料指纹均校验通过）
> 原始语料指纹：`659166e2f53b3cb8ba535e4f944684222927cbdc6a46a534ee311dbb0c757238`（迁移前后一致）

## 1. 数量总览

| 项 | 数量 |
|---|---|
| total_records | 347 |
| original_records | 217 |
| derived_records | 130 |
| knowledge_records | 196 |
| non_knowledge_records | 21 |
| originals_without_metadata | 0 |

## 2. 分层与治理字段分布（原始 217 条）

| 维度 | 分布 |
|---|---|
| layer_distribution | {'L3': 94, 'L4': 63, 'L5': 9, 'L6': 29, 'L7': 1, 'None': 21} |
| category_distribution | {'navigation': 7, 'knowledge': 196, 'identity': 2, 'environment': 5, 'state': 4, 'preference': 3} |
| status_distribution | {'active': 160, 'archived': 9, 'candidate': 48} |
| review_distribution | {'pending': 207, 'approved': 10} |
| evidence_level_distribution | {'E0': 18, 'E1': 1, 'E2': 141, 'E3': 9, 'E4': 48} |

## 3. 衍生记录

- L1 原子观测 `obs:*`：119
- L2 Episode `episode:*`：11
- 合计衍生：**130**（`status=candidate` + `review_status=pending` + `content_hash`，可幂等重跑；不参与正式召回前缀）

## 4. 回填后校验

- 校验结论：**PASS**
- 原始语料指纹一致：True
- 衍生记录：130（计划 130）
- layer / review 枚举非法：[] / []
- 悬空 evidence：[]
- 无 `evidence_ids` 的原始记录：14；证据等级 E0 共 18 条（无锚点或记录自称 E0），均已标 needs_review
- L7 原则数：1（上限 10）
- 候选被误标 approved：[]
- FTS 命中衍生记录：11

## 5. 回滚方法

```bash
python3 scripts/memory/migrate.py --db ~/.delx-memory/db.sqlite \
  --restore ~/.delx-memory/backups/db.sqlite.bak-2026-10-22-095405-l0l7-backfill-v1 --yes
```

恢复后 `original_fingerprint` 必须回到上表值；恢复路径已在单元测试与真实库快照上各验证一次（见 `reports/memory-quality-2026-10-22.md` §5）。

