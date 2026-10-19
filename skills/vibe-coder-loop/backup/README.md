# backup — 技能相关记忆 备份/更新 工具

备份与更新 **vibe-coder-loop 技能相关联的数据记忆**（delx-memory 数据库中的 `skill:*` 规则条目 + 直接关联的 rule/lesson/pattern/reference/agent 条目）。**不备份其他项目记忆**（jtkl/vue-ui 等不受影响）。

## 快速开始

```bash
# 1. 备份（导出技能相关记忆到 snapshots/）
python3 memory_tool.py backup

# 2. 查看备份范围与数据库路径
python3 memory_tool.py list

# 3. 更新数据库（从备份文件恢复/同步，upsert，保留 created_at）
python3 memory_tool.py restore snapshots/skill_memory_latest.json            # 实际写入（写前自动落一份当前库快照）
python3 memory_tool.py restore snapshots/skill_memory_latest.json --dry-run  # 只打印将发生的变更，不写库

# 4. 校验备份与数据库一致性
python3 memory_tool.py verify snapshots/skill_memory_latest.json

# 5. 工具自测（标准库 unittest，自建临时库，不触碰真实库）
python3 test_memory_tool.py
```

## 上下文成本控制（加载计划 · 结果外置）

两项能力都服务于同一目标：**控制"什么进入上下文"**（前馈侧；压缩/阈值仍归 Runtime）。

```bash
# 加载计划：S2 Preflight 入口第一步，一次调用替代 N 次导航读取
#   输出 = 加载清单 + 运行时实测章节索引（零漂移）+ 成本对比 + 记忆候选（只回 key 不回 value）
python3 memory_tool.py preflight --level 2 --task coding
python3 memory_tool.py preflight --files kernel.md,rules/code.md   # 绕过 load_plan.json 显式指定
#   退出码：0 正常；3 = 计划缺失或清单内文件缺失（[RULE_STORE_MISSING] / [RULE_NOT_FOUND]，fail closed）

# 结果外置：>100 行的产出落盘，上下文只留 ref + 投影视图
python3 memory_tool.py artifact put --file /tmp/test.log --name test.log --kind text --loop 2
python3 memory_tool.py artifact page --ref a1234567890 --count                    # 先摸规模
python3 memory_tool.py artifact page --ref a1234567890 --grep '^FAIL' --limit 20  # 过滤 + 分页
python3 memory_tool.py artifact page --ref a1234567890 --equals state=failed --fields file,line  # jsonl 投影（kind 由 put 时声明）
python3 memory_tool.py artifact page --ref a1234567890 --max-bytes 4096         # 超限报 [OUTPUT_LIMIT]，不静默截断
python3 memory_tool.py artifact list / release --ref a1234567890
#   产物目录 = $VIBE_LOOP_ARTIFACTS_DIR，缺省 ~/.vibe-loop/artifacts/<workspace-hash>/（24h TTL）
#   --name 落盘前消毒（去路径分隔符/首尾点）；ref 形态固定的 `a+10hex`，非法一律拒绝（不信任 index.json）
#   退出码：3 = 源缺失/参数非法/名称或 ref 非法；4 = ref 不存在或已过期（均带 [next] 自纠行）
```

## 运行时写入（Skill 的 Tool 侧）

技能协议只声明「**何时调用 + 为什么 + 失败怎么办**」；字段级机制由本工具承担（Agent 不手写）：

```bash
# 消费回写：读取（memory_get）某条记忆后，同一 turn 内执行
#   --hit 表示内容经 E2+ 验证与事实一致（cache_hit_count +1）
python3 memory_tool.py touch lesson:xxx rule:yyy --hit

# 仪表盘聚合：任务收尾执行一次（每轮必更，0 事件也执行）
#   --budget-hit = 预算内完成数；--memory-hit = 确有召回结果数（两个 rate 由工具分别重算）
python3 memory_tool.py metrics --conflict 1 --retrieval 3 --budget-hit 3 --memory-hit 2 --counts --note "本轮摘要"
```

不变量（工具保证）：

- `touch`：**value 不改**、tags 不动、metadata 其余字段（title / note / relevance_score）原样保留、有限 TTL 按「剩余时长」重锚（防续期漂移）
- `metrics`：未触及字段原样保留、`hit_rate`（`budget_hits/searches`）与 `memory_hit_rate`（`memory_hits/searches`）**分别重算**、空清单自动标注「本轮 0 事件」；`--counts` 机械重算 `memory.*` 条目计数

**降级**：工具不可用时按 `../learning/memory/lifecycle.md`「回写契约」第 3 条手工执行（`memory_get` 取完整值 → 叠加 → `memory_set`）。

**覆盖边界**：`metrics` 覆盖全部**数值**字段聚合；`conflict.last` / `rollback.last`（描述性）与 `auto_rule.pass_rate`（派生判断）无工具路径，仍由 Agent 提供。

> ⚠️ 直接写库与 delx-memory MCP 并存：SQLite WAL 模式下外部写入对 MCP 读取可见，但 MCP 侧缓存可能滞后一轮。

## 数据库路径配置（跨机器迁移关键）

优先级：`--db` 参数 > 环境变量 `DELX_MEMORY_DB` > `config.json` > 自动探测。

- **本机（macOS/Linux）**：默认自动探测 `~/.delx-memory/db.sqlite`，无需配置
- **Windows**：自动探测 `%USERPROFILE%\.delx-memory\db.sqlite`；若路径不同，修改 `config.json` 的 `db_path` 字段（或设置环境变量 `DELX_MEMORY_DB`），**手动或让 agent 调整均可**
- **明确指定**：`python3 memory_tool.py --db /path/to/db.sqlite backup`

## 跨机器迁移流程

1. **源机器**：运行 `python3 memory_tool.py backup` → 生成 `snapshots/skill_memory_latest.json`（建议提交 git）
2. **目标机器**（如 Windows）：clone 仓库 → 修改 `backup/config.json` 的 `db_path` 指向本机 delx-memory 库 → 运行 `python3 memory_tool.py restore snapshots/skill_memory_latest.json`
3. 运行 `python3 memory_tool.py verify ...` 确认一致

## Windows 说明

- 需要 Python 3（python.org 安装，勾选 Add to PATH）
- 命令：`python memory_tool.py backup`（Windows 下可能是 `python` 而非 `python3`）
- 路径含反斜杠时注意 JSON 转义：`"db_path": "C:\\Users\\<user>\\.delx-memory\\db.sqlite"`
- SQLite 文件被 delx-memory 进程占用时，脚本带 busy_timeout 重试；仍失败则先停止占用进程

## 备份范围

- 前缀 `skill:*`：全部技能规则条目（rules/learning/policy/metrics 等；计数以 `memory_list(prefix="skill:")` 实时核对，不硬编码）
- 显式关联（16 条，与 `memory_tool.py` 的 `SKILL_LINKED_KEYS` 常量一致）：
  `rule:skill-iteration-manifest`、`lesson:skill-edit-date-residue`、`lesson:access-writeback-trigger-gap`、`lesson:memory-metadata-overwrite`、`lesson:runtime-message-timing`、`lesson:hard-constraint-bypass`、`lesson:checkpoint-instance-growth`、`lesson:fail-closed-over-silent-degradation`、`lesson:context-cost-lever-is-tool-surface`、`pattern:memory-writeback-integrity`、`agent:vc_constraints`、`reference:memory-navigation`、`reference:memory-access-tracking`、`reference:skill-context-cost-baseline`、`project:opencode-model-limits`、`preference:user:memory-autonomy`（记忆操作常驻授权记录）

> 调整范围：修改 `memory_tool.py` 顶部 `SKILL_LINKED_KEYS` 列表即可（不涉及数据库 schema）；快照含 `skill_version` + `changelog_top` 溯源字段（读取 manifest.yaml / CHANGELOG.md，用于溯源备份对应的技能版本）。

## 备份保留策略

- **按天去重**：时间戳快照每天只保留一份（当天最新状态）；同天多余快照自动清理
- **历史压缩**：历史时间戳快照自动压缩为 `.json.gz`（gzip level 9，节省约 65%）；`skill_memory_latest.json` 永不压缩（restore/verify 主入口）
- **幂等判断**：扩展名即"是否已压缩"标记——已存在 `.json.gz` 的跳过；restore/verify 均支持 `.json.gz` 输入
- **写前快照**：`restore` 实际写入前，先把当前库状态落为 `skill_memory_prerestore_<时间戳>_<毫秒>.json`，本次写入可据此回退（带毫秒，同秒连续 restore 不互相覆盖）；最多保留 **2 份**（超出删最旧），**不参与**按天去重与历史压缩（需保持可直接读取）；`backup` 收尾同样执行该有界保留（旧份在同一命令内清理）
- 典型结果：`snapshots/` = 每天 1 个 `skill_memory_YYYYMMDD_HHMMSS.json.gz` + `skill_memory_latest.json`（+ 偶发 `skill_memory_prerestore_*`）
- **版本库边界**：`snapshots/.gitignore` 忽略 `skill_memory_*.json` 与 `skill_memory_*.json.gz`，仅 `skill_memory_latest.json` 进 git（快照 payload 含本机绝对路径，不适合版本化；历史快照由 `backup` 自动重建）

## 维护约定（技能迭代时必守）

- **新增/删除技能相关记忆 key**（skill:* 或显式关联）→ 同步更新 `memory_tool.py` 的 `SKILL_LINKED_KEYS` 与本 README「备份范围」说明
- **技能规则/关联内容更新后** → 重新执行 `python3 memory_tool.py backup`（快照溯源随版本更新）
- 迭代历史唯一事实源 = `../CHANGELOG.md`；版本号唯一事实源 = `../manifest.yaml` `version` 字段

## 说明

- 纯 Python 3 标准库（sqlite3/json/argparse/pathlib/zlib），无第三方依赖
- 恢复采用 upsert：已存在条目更新 value/tags/metadata/ttl，**保留原 created_at**；不存在则全量插入
- **范围守卫**：`restore` **与 `verify`** 均拒绝备份内技能范围外的 key（非 `skill:*` 且不在 `SKILL_LINKED_KEYS`）——防跨项目记忆被静默覆盖；`restore` 确认可信时用 `--force` 放行
- **条目校验**：外部/畸形快照（顶层非对象、条目非对象、`key` 缺失、`value` 非字符串）一律**可读拒绝**（退出码 1 + 逐条说明），不抛 traceback；同 key 重复条目按后者取值
- **读取上限**：备份解压后 8 MiB / 2000 条上限，`restore` 与 `verify` 一致，超限拒绝（防 gzip 炸弹与异常大文件）
- **并发写**：`touch` / `metrics` / `restore` 均以 `BEGIN IMMEDIATE` 取写锁，使 `busy_timeout` 对 delx-memory MCP 等其他进程真正生效（不丢更新）；`touch` 逐 key 容错（单条 metadata/TTL 畸形只跳过该条并指明 key）
- **`verify` 口径（两类）**：
  - **硬校验**（不一致 → 退出码 1）：缺失 / `value` / `tags` / `metadata`（计数三件套以外字段）/ `created_at` / `ttl_expires_at` / 范围完整性（库内技能 key 是否都进过备份）
  - **软提示**（退出码 0）：`access_count`·`cache_hit_count` 漂移、仪表盘 `value`、`updated_at` —— 均为 runtime 回写（`touch`/`metrics`）的正常结果
  - **注意**：`restore` 按备份值**精确**写入，会把软提示部分回退到快照时刻 → 回滚前先 `--dry-run` 确认影响范围
- FTS 全文索引由数据库触发器自动维护，无需手动同步
- `skill_memory_latest.json` 始终为最新（跨机器同步用，进 git）；历史快照与写前快照由 `.gitignore` 忽略
