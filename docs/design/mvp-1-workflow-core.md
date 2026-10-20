# MVP-1 — Workflow Core 设计

> 目标：把 `vibe-coder-loop` 已验证的「状态机 + `.state.md` Checkpoint + 恢复协议 + VC 错误码」从 Markdown 协议升级为确定性代码。
> 原则：**只管状态，不管判断**。架构方案、审查结论、下一步动作归 LLM；Core 强制状态合法性、机械写 Checkpoint、机械执行恢复。

---

## 一、目标与非目标

### 目标
1. **状态机代码化**：S0–S14 合法转换由代码校验，非法跳转被拒绝（防跳过规则可执行化）。
2. **Checkpoint 自动化**：`.state.md` 的读写、字段完整性校验、原子写入由 Core 承担；可经宿主事件触发，也支持 LLM 显式调用。
3. **恢复协议机械执行**：freshness 判定、字段完整性、pending 逐项核验——现有 LLM 手动执行的步骤变成代码确定性执行。
4. **VC 错误码程序化**：`RULE_NOT_LOADED`/`NO_PROGRESS`/`LOOP_BUDGET_EXHAUSTED`/`SCOPE_DENIED`/`PLAN_DRIFT` 等码由 Core 在转换/恢复时判定并返回结构化信号。
5. **host-agnostic 协议端口**：5 个方法构成的接口，不依赖任何宿主类型；MVP-3 与未来 Pi Adapter 都实现这 5 方法。

### 非目标
- 不实现对话压缩（归宿主；Core 只提供 TASK 区快照供注入）。
- 不决定 review 结论（`transition.md` S10 判定表由 LLM 读，Core 只校验「判定后才能转」）。
- 不引入数据库（沿用 `.state.md` YAML 单文件，见 §存储）。
- 不做多任务并发（单任务单 `.state.md`，按 cwd/worktree 隔离；多任务留 Phase 4）。
- 不修改 Skill 协议文件语义（Core 是协议的执行体，不是新规则源）。

---

## 二、现状与证据

### 已存在（可直接复用）
- **状态机定义**：`engine/state-machine.md` + `engine/transition.md`——15 状态（S0 Idle ~ S14 Safe Mode）、合法转换、异常路径（Retry/Rollback/Pause）、Loop 计数规则、角色约束、防跳过规则、出口清单。**[已验证]**
- **Checkpoint 协议**：`state-machine.md`「Workflow Checkpoint（.state.md）」节——13 字段、写入纪律（阶段出口仅变字段才写、S13 必写 status+resume）、恢复协议（freshness + 12 字段校验 + pending 核验 + 边界）。**[已验证]**
- **公共示例**：`.state.template.md`（脱敏 13 字段）；本地 `.state.md` 实例不随仓库发布。**[已验证]**
- **复杂度分级**：`engine/complexity-gate.md`——Level 0–4 与 Loop Depth（Quick/Standard/Full）映射、各 Level 激活阶段矩阵。`manifest.yaml` `complexity.levels` 为机器副本（冲突以 engine/ 为准）。**[已验证]**
- **VC 错误码族**：`transition.md`「VC 错误码族」——11 个工作流码 + Tool 层运维码，带 fail-closed 标记与 `[next]` 动作。**[已验证]**
- **memory_tool.py 参照实现**：`touch`/`metrics` 的「读改写同事务 + BEGIN IMMEDIATE + 逐条容错」模式、`preflight` 的「只回 key 不回 value」纪律、`artifact` 的「输出有界 + 显式 clamp」契约——这些是 Core 实现的工程范本。**[已验证]**

### 尚不存在（Core 要新建）
- 任何读取/校验/驱动 S0–S14 转换的代码。
- `.state.md` 的原子写入与 schema 校验代码（当前 LLM 手动追加 YAML）。
- 恢复协议的机械执行代码（freshness 阈值/字段核验/pending 落地检查）。
- VC 码的程序化判定与结构化返回。

---

## 三、任务状态机设计

### 3.1 状态转换合法性表（取自 `transition.md`，不改语义）

Core 维护一份合法后继表，**作为 `transition.md` 的程序化镜像**（关系同 `manifest.yaml` `levels.stages` 与 `complexity-gate.md` 的关系——冲突时以文件为准）：

```python
# 合法后继表 = engine/transition.md 各「→」箭头的程序化镜像
LEGAL_TRANSITIONS = {
    # 正向主链
    "S0":  {"S1"},                         # Idle → Intent
    "S1":  {"S2", "PAUSE"},                # Intent → Preflight（目标不明 → 暂停）
    "S2":  {"S4", "S3"},                   # Preflight → Router / Decision
    "S3":  {"S4", "PAUSE"},                # Decision → Router（Low 冲突 → 暂停追问）
    "S4":  {"S5", "S8"},                   # Router → Clarify（L2+）/ Code（Quick）
    "S5":  {"S6"},                         # Clarify → Design
    "S6":  {"S7"},                         # Design → Plan
    "S7":  {"S8", "S10"},                  # Plan → Code / Investigation→Review
    "S8":  {"S9", "S13"},                  # Code → Test（L1+）/ Complete（L0 直出）
    "S9":  {"S10", "S8"},                  # Test → Review / 回退 Code[N+1]
    "S10": {"S11", "S8", "S6", "S13"},     # Review → Reflection/Code[N+1]/Design[0]/Complete
    "S11": {"S12"},                       # Reflection → Memory Evolution（未触发可跳过）
    "S12": {"S13"},                       # Memory Evolution → Complete
    "S13": {"S0", "S1"},                   # Complete → Idle / follow-up 回 S1(Loop 归 0)
    "S14": {"S0", "S1"},                   # Safe Mode → 止血后回 Idle/重进
    # 回退弧（带源标记，不计非法——见 §3.3）
}
# PAUSE 是协议状态而非 S 编号（暂停等用户），由 transition 返回而不落 .state.md.phase
```

> **自检**：上表与 `transition.md` 各节「转移」行逐一对照，语义一致；`S7→S10`（Investigation 分支）、`S8→S13`（L0 直出）、`S10→S6`（情况 B 回 Design[0]）、`S13→S1`（follow-up）均覆盖。回退弧 `S9→S8`/`S10→S8`/`S10→S6` 带 `[N+1]` 语义，由 `transition()` 的 `loop` 参数承载（见 §3.2）。

### 3.2 状态转换接口（host-agnostic port 的核心方法）

```python
class WorkflowCore:
    def transition(
        self, to_state: str, *,
        loop: int | None = None,       # 显式设置 Loop（回退 N+1 / follow-up 归 0）
        exit_checklist: dict | None = None,  # 阶段出口清单的勾选证据（LLM 产出）
        force: bool = False,           # 仅 Safe Mode 恢复用，正常流程禁用
    ) -> TransitionResult: ...
```

**职责**：
1. 校验 `to_state` ∈ `LEGAL_TRANSITIONS[current.phase]`——非法 → 返回 VC `RULE_NOT_LOADED`（`[next] 回退执行当前阶段出口清单`），**不落 .state.md**。
2. 校验 `exit_checklist` 引用了上一阶段产出（防跳过规则可执行化）——缺引用 → 返回防跳过码，**不落 .state.md**。
3. 更新 `.state.md`：`phase` + `loop`（若传入）+ `current_step` + 追加 `completed`（若 exit_checklist 含 completed 项）；**仅在字段变化时写**（沿用协议「阶段出口仅变字段才写」）。
4. 返回 `TransitionResult{ok, from_, to, loop, vc_code?, next?}`。

**不做的**：不校验 exit_checklist 的*内容正确性*（那是 LLM 的判断）；只校验「该有的项是否勾选 + 是否引用了上一阶段」。

### 3.3 回退弧与 Loop 计数

回退（`S9→S8[N+1]`/`S10→S8[N+1]`/`S10→S6[0]`/`S8→S8[N+1]` 自检修复）的特殊处理：

| 回退类型 | Loop 行为 | 依据 |
|---|---|---|
| `S9→S8`（测试失败回退） | loop +1 | `transition.md` S9「N→N+1」 |
| `S10→S8`（Review 情况 A） | loop +1 | `transition.md` S10 表「N→N+1」 |
| `S10→S6`（Review 情况 B 结构性回退） | loop +1（重设计后回 S8 同轮） | `transition.md` 情况 B |
| `S13→S1`（follow-up 新目标） | **loop 归 0** | `transition.md` S13「follow-up 享独立重试预算」 |
| `S8→S8`（同轮自检修复，未跨阶段） | **不递增**（同轮内修正） | `transition.md`「VC 码标否的不消耗 Loop 计数」 |

**Loop 上限守卫**：`loop > loop_max`（`manifest.yaml` `cost.loop_max=3`）→ 返回 `LOOP_BUDGET_EXHAUSTED`（fail-closed，停止）。**[待验证]** loop_max 是否应按 Level 区分（L0 Quick Loop 实际 1 轮上限，与 L3 Full Loop 的 3 轮不同）——当前 manifest 统一 3，`complexity-gate.md`「Loop Depth」矩阵另有「1 轮上限」表述，冲突时需决策（见 §未决 U6）。

### 3.4 Safe Mode（S14）入口

Safe Mode 触发条件取自 `kernel.md` §5 + `manifest.yaml` `tunable_parameters.safe_mode_triggers`：

```python
SAFE_MODE_TRIGGERS = {
    "consecutive_loops": 2,        # 连续 2 次 Code→Review 无改善
    "files_touched": 10,            # 单轮触及文件数
    "hard_violation_repeats": 3,   # 硬约束违规重复
    "failure_type_share": 0.15,     # 失败类型占比
    "loops_vs_avg_ratio": 1.5,      # 本轮循环数 / 平均
}
```

Core 在 `transition()`/`feedExec()` 时评估这些信号；命中任一 → 强制转 S14，返回 `NO_PROGRESS`（fail-closed）。**信号来源**：`files_touched` 由 Exec/Adapter 上报（tool.execute.after 累计）；`consecutive_loops`/`loops_vs_avg_ratio` 由 Core 从 `.state.md` 历史计算；`hard_violation_repeats`/`failure_type_share` 由 LLM 在 review 结果中标注、Core 累计。

> **`manifest.yaml` 自述**：`tunable_parameters` 是「项目无关缺省参考值，非契约；项目应自行覆盖」。Core 读取这些值作缺省，但**允许项目覆盖**（与 memory_tool.py config.json 的覆盖链一致）。

---

## 四、Checkpoint 设计

### 4.1 沿用 `.state.md` 13 字段（不新造数据结构）

`state-machine.md` 定义的 13 字段，Core 直接程序化（字段名/语义不变）：

| # | 字段 | 类型 | Core 管理方式 |
|---|---|---|---|
| 1 | `status` | enum(active/paused/complete) | `transition()`/`pause()`/`complete()` 写 |
| 2 | `updated_at` | datetime（到分钟） | 每次写自动更新 |
| 3 | `phase` | str（S0–S14 + Phase Label） | `transition()` 写 |
| 4 | `loop` | int | `transition()` 按回退规则写 |
| 5 | `level` | int(0–4) | S4 Router 后写（LLM 判定，Core 存储） |
| 6 | `goal` | {explicit, constraints[], risk[]} | S1 产出，Core 存；后续追加 risk |
| 7 | `current_step` | str | 每阶段出口写 |
| 8 | `completed[]` | str[] | 追加（不删、不改顺序） |
| 9 | `pending[]` | str[] | 追加/核验后移 completed（见 §5） |
| 10 | `decisions[]` | {id, what, value, evidence}[] | 追加 |
| 11 | `review` | {result, last_review, last_failure, issues[]} | S10 后写 |
| 12 | `user_decisions[]` | {id, what, user_says}[] | 用户输入时追加 |
| 13 | `resume` | str（多行） | S13 必写；阶段出口可选写指针 |

> **字段映射 Task/Stage/Checkpoint 概念**：`goal`+`level` = Task；`phase`+`loop`+`current_step` = Stage；整体 13 字段 = Checkpoint。无需新增字段即可承载统一任务模型。

### 4.2 原子写入契约

```python
def _write_state(self, fields: dict) -> None:
    """原子写入 .state.md：写 .tmp → fsync → rename。"""
    # 防并发：LLM 工具调用 + Adapter 事件可能并发写
    # 同 memory_tool.py 的 BEGIN IMMEDIATE 哲学：先取文件锁（flock）再写
    tmp = self.state_path.with_suffix(".md.tmp")
    tmp.write_text(self._render_yaml(merged_fields), encoding="utf-8")
    os.fsync(tmp.fileno())
    tmp.replace(self.state_path)  # 原子 rename
```

**降级**：若 `.state.md` 不可写（权限/磁盘满）→ Core 不抛异常中断流程，返回 VC 码 `CHECKPOINT_WRITE_FAILED`（`[next] 检查目录权限/磁盘后重试`），LLM 可继续按协议手动维护（Phase 0 兼容）。

### 4.3 schema 版本与容错（对应 overview U1）

```python
STATE_SCHEMA_VERSION = 1  # .state.md 顶部注释声明；Core 读取时校验

def load_checkpoint(self) -> Checkpoint:
    raw = self._parse_yaml(self.state_path)  # 容错解析（见 §5.1）
    if raw.get("_schema_version", 0) > STATE_SCHEMA_VERSION:
        # 高版本字段 Core 不认 → 降级为「仅参考」，不破坏
        return Checkpoint(stale=True, reason="schema_ahead")
    # 缺失非必需字段 → 用缺省填充，不报错（向前兼容 Skill 演进增字段）
    ...
```

**冲突仲裁**：若 Skill 协议演进增字段，Core 缺省填充该字段为空 → LLM 按新协议仍可写（Core 透传未知字段，不丢失）——与 memory_tool.py `metadata_equal` 的「计数三件套漂移不算差异」容错哲学一致。

---

## 五、恢复协议机械执行

### 5.1 freshness + 字段完整性校验

现有 `transition.md` S1「Checkpoint（循环开始，强制）」的 LLM 手动步骤，Core 机械执行：

```python
def load_checkpoint(self, *, expected_age_minutes: int = 1440) -> RecoveryResult:
    """
    返回三态：
      - fresh + 完整 → 恢复 {phase, current_step, completed}，completed 不重做
      - stale（updated_at 超阈值）→ 标记 stale，以当前会话+用户输入为准
      - 损坏（YAML 不可解析/必需字段缺失）→ 标记 corrupt，降级为全新开始
    """
    if not self.state_path.exists():
        return RecoveryResult(mode="fresh_start", reason="no_checkpoint")
    try:
        raw = self._parse_yaml_robust(self.state_path)  # 容错：注释/格式异常不裸抛
    except CorruptYaml:
        return RecoveryResult(mode="fresh_start", reason="corrupt",
                              vc_code="CHECKPOINT_CORRUPT",
                              next="以当前会话为准，旧 .state.md 备份为 .state.md.corrupt")
    # 必需字段校验（status/phase/loop 三项不可缺）
    missing = REQUIRED_FIELDS - raw.keys()
    if missing:
        return RecoveryResult(mode="fresh_start", reason="missing_fields", missing=missing)
    # freshness（updated_at 到分钟）
    age = self._age_minutes(raw["updated_at"])
    if age > expected_age_minutes:
        return RecoveryResult(mode="resume_stale", raw=raw,
                              vc_code="CHECKPOINT_STALE",
                              next="核验 pending 后续跑；与用户输入冲突以用户为准")
    return RecoveryResult(mode="resume", raw=raw)
```

### 5.2 pending 逐项核验（现有协议最耗时的人工步骤）

`transition.md` S1 恢复协议要求「pending 项核验已落地」。Core 用**最低成本命令**（与 `state-machine.md` pending 核验一致）机械执行：

```python
def verify_pending(self, pending: list[str]) -> list[PendingCheck]:
    """对 pending 项做存在性/mtime 核验，已落地的移 completed。"""
    results = []
    for item in pending:
        # 解析 pending 文本提取文件路径/git 状态线索（LLM 写 pending 时已含路径）
        paths = extract_paths(item)  # 正则提 ./xxx 或绝对路径
        if paths and all(self._exists_recent(p) for p in paths):
            results.append(PendingCheck(item, "landed", move_to_completed=True))
        elif "已提交" in item and self._git_clean():
            results.append(PendingCheck(item, "landed", move_to_completed=True))
        else:
            results.append(PendingCheck(item, "still_pending"))
    return results
```

**降级**：无法提取路径的 pending 项 → 标 `unverifiable`，**不**擅自移 completed（fail-closed，与 memory_tool.py `check_keys` 的 MISSING 语义一致）——交 LLM 判断。

### 5.3 恢复边界（对应 `state-machine.md` 恢复协议边界）

| 情况 | Core 行为 |
|---|---|
| status=active + fresh | 恢复 phase/current_step；completed 不重做；pending 经核验后处理 |
| status=paused + fresh | 恢复；标 `paused` 等用户确认续跑 |
| status=complete | 不恢复（任务已结束）；若用户给新输入 → 新循环覆盖 |
| stale（超阈值） | 标 stale；TASK 区仅供参考；**与用户输入冲突以用户为准**（Core 不覆盖） |
| corrupt | 备份旧文件为 `.state.md.corrupt`；全新开始；不静默丢弃旧数据 |

---

## 六、VC 错误码的程序化判定

Core 在以下时机判定 VC 码并返回结构化信号（`[CODE] fact\n[next] action` 格式，对齐 `transition.md` 契约）：

| 码 | Core 判定时机 | fail-closed | Core 的 `[next]` |
|---|---|---|---|
| `RULE_NOT_LOADED` | `transition()` 发现目标状态非法或 exit_checklist 缺上一阶段引用 | 否（回退） | 回退执行当前阶段出口清单 |
| `SCOPE_DENIED` | LLM 经工具调用显式上报「操作超授权」（红线/生命周期） | **是** | 输出 Conflict Card 止步（Core 不自纠，交 LLM） |
| `PLAN_DRIFT` | `feedExec()` 发现实际修改文件 ⊄ S7 计划声明集合（Adapter 上报 files_touched） | 否（记录后继续） | 补记偏离理由或回 S7 重规划 |
| `NO_PROGRESS` | `repeatCheck()` 连续 2 次指纹无变化（见 MVP-2 §指纹） | **是** | 进 Safe Mode，输出风险报告 |
| `LOOP_BUDGET_EXHAUSTED` | `transition()` 发现 loop > loop_max | **是** | 停止 + 建议升级 Loop 深度或人工介入 |
| `CHECKPOINT_STALE` | `load_checkpoint()` freshness 不通过 | 否（降级） | 核验 pending 后续跑；冲突以用户为准 |
| `CHECKPOINT_CORRUPT` | `load_checkpoint()` YAML 不可解析 | 否（降级） | 备份旧文件，全新开始 |
| `CHECKPOINT_WRITE_FAILED` | `_write_state()` 写失败 | 否（降级） | 检查权限/磁盘；LLM 手动维护 |

> **不新增码**：上表全部对应 `transition.md` 已有码或其运维延伸；Core 只做判定，不改码集。`OUTPUT_LIMIT`/`ARTIFACT_NOT_FOUND` 归 MVP-2 Exec 判定。

---

## 七、存储设计

### 7.1 选型：沿用 `.state.md` YAML 单文件，不引入数据库

| 选项 | 评估 | 决定 |
|---|---|---|
| **A. 沿用 `.state.md` YAML 单文件** | 现有协议即此；单实例、低频写、低并发；LLM/人类可读可改；零依赖；与 Skill 协议零摩擦 | ✅ **采用** |
| B. SQLite（仿 delx-memory） | 任务状态非高频检索/FTS；引入 DB 增依赖与运维负担；现有 memory_tool.py 的 SQLite 是记忆库（需 FTS5），非任务状态 | ❌ 拒绝 |
| C. JSON | 人类不可读可改；`.state.md` 现有 YAML 注释（字段说明）价值高 | ❌ 拒绝 |

**存储位置**：沿用 `$SKILL_DIR/.state.md`（经软链解析到本项目 `skills/vibe-coder-loop/.state.md`）；Adapter 按 cwd/worktree 隔离多任务时各自指向独立 `.state.md`（待 Phase 4）。

### 7.2 与 memory_tool.py 的关系

- **Core 不替代 memory_tool.py**：memory_tool.py 管**经验记忆**（lesson/pattern/仪表盘/artifact），Core 管**任务状态**（.state.md）。二者存储分离（SQLite vs YAML）、职责分离（Memory vs Context，`delx-memory-protocol` 硬约束）。
- **Core 复用 memory_tool.py 的工程模式**：原子写（同事务/同 rename）、逐条容错、fail-closed、显式 `[next]` 信号——这些是已验证的范本，Core 直接借鉴。
- **Core 可调用 memory_tool.py**：S12/S13 出口的 `touch`/`metrics` 仍由 memory_tool.py 承担（Core 不重写记忆回写）；Core 只在 transition 时触发「该回写了」的提醒信号。

### 7.3 artifact 子系统复用（对接 MVP-2）

`.state.md` 不存大产物（goal/conpleted/pending 是摘要）；大结果（测试输出/Diff）经 MVP-2 Exec 调 memory_tool.py `artifact put` 外置，`.state.md` 只存 ref。这严守 `delx-memory-protocol`「条目长则外置」纪律。

---

## 八、对外接口（host-agnostic port）

5 个方法，MVP-3 与未来 Pi Adapter 都实现这 5 方法的映射：

```python
class WorkflowCore:
    # 1. 恢复/加载（会话启动时）
    def load_checkpoint(self) -> RecoveryResult: ...

    # 2. 状态转换（阶段出口）
    def transition(self, to_state, *, loop=None, exit_checklist=None) -> TransitionResult: ...

    # 3. TASK 区快照（compaction 注入用）
    def snapshot_task_zone(self) -> str:
        """返回 .state.md 13 字段的紧凑文本，供 Adapter 注入 compaction context。"""

    # 4. 喂执行结果（供 MVP-2 Exec 结果流入，做重复检测/计划漂移）
    def feed_exec(self, result: ExecResult) -> FeedResult: ...

    # 5. 重复失败检测（Exec 指纹比对）
    def repeat_check(self, fingerprint: str) -> RepeatResult: ...
```

**Core 不依赖宿主类型**：`ExecResult`/`RecoveryResult` 等都是 Core 自定义的纯数据类；Adapter 负责把宿主事件/工具调用的产出翻译成这些类型。

---

## 九、实现层次与文件布局

```
runtime/core/                 # Core 实现（新建，零第三方依赖）
├── __init__.py
├── state_machine.py          # LEGAL_TRANSITIONS + transition() + Safe Mode 触发
├── checkpoint.py             # .state.md 读写/原子写入/schema 校验
├── recovery.py               # load_checkpoint + freshness + pending 核验
├── vc_codes.py               # VC 错误码常量 + 结构化返回
└── cli.py                    # 命令行入口（LLM/人工可调，降级兼容 Phase 0）
tests/core/
├── test_state_machine.py     # 合法/非法转换、回退弧、Loop 计数、Safe Mode
├── test_checkpoint.py        # 13 字段读写、原子写、schema 容错
├── test_recovery.py          # fresh/stale/corrupt/pending 核验场景
└── test_vc_codes.py          # 各码判定与 [next] 返回
```

> **注意**：本设计只给布局与接口草案，**不实现**（任务约束）。文件路径是建议，实际实现时按验证脚本可达性调整。`runtime/` 目录与 `kernel/`/`skills/` 同级，属本项目新增层。

---

## 十、验收场景（单元测试覆盖目标）

| # | 场景 | 期望 |
|---|---|---|
| V1 | 合法正向转换 S0→S1→S2→S4→S8→S9→S10→S13→S0 | 全部 ok，.state.md 各字段正确演进 |
| V2 | 非法跳转 S1→S8（跳过 Preflight） | 拒绝，返回 `RULE_NOT_LOADED`，.state.md 不变 |
| V3 | 回退弧 S9→S8[N+1]，loop 递增 | ok，loop +1 |
| V4 | Loop 达 3 → 再回退 | 返回 `LOOP_BUDGET_EXHAUSTED`，停止 |
| V5 | follow-up S13→S1 | ok，**loop 归 0** |
| V6 | status=active + fresh 恢复 | 恢复 phase/current_step，completed 不重做 |
| V7 | stale（超 1440 分钟）恢复 | 标 stale，以当前为准，与用户冲突以用户为准 |
| V8 | corrupt（YAML 损坏）恢复 | 备份旧文件，fresh_start |
| V9 | pending 含文件路径且文件存在 | 移 completed |
| V10 | pending 无路径线索 | 标 unverifiable，不擅自移 completed（fail-closed） |
| V11 | 重复失败指纹无变化 ≥2 | 返回 `NO_PROGRESS`，转 S14 |
| V12 | 实际修改文件 ⊄ S7 计划集 | 返回 `PLAN_DRIFT`，记录后继续 |
| V13 | 并发写（模拟 Adapter 事件 + LLM 工具） | flock + rename 原子化，无撕裂 |
| V14 | schema 版本超前（模拟 Skill 增字段） | 降级为「仅参考」，不破坏 |
| V15 | compaction 注入后恢复 | snapshot_task_zone 注入 → 新会话能从注入字段恢复（与 V6 一致） |

**退出条件**：V1–V15 全绿；LLM 可经 `cli.py` 手动调 Core 跑完一个真实任务（端到端冒烟）；Skill 协议文件**未被修改**（零内容编辑，Core 是叠加层）。

---

## 十一、未决问题

| # | 问题 | 倾向 |
|---|---|---|
| U6 | `loop_max` 是否按 Level 区分？`manifest.yaml` 统一 3，但 `complexity-gate.md` L0 有「1 轮上限」表述 | Core 读 `manifest.yaml` 统一值作缺省；若 `complexity-gate.md` 的「1 轮上限」是硬约束，需 Skill 侧先澄清并同步 manifest（Core 不擅自解释冲突） |
| U7 | `exit_checklist` 的结构化格式？LLM 产出的出口清单是自然语言，Core 如何「校验引用了上一阶段」？ | 建议定义轻量结构（{stage, referenced_outputs[], checked_items[]}）；LLM 用 `[Phase][Loop]` 标签 + 文件路径引用，Core 正则提路径即判引用——避免重格式化协议 |
| U8 | Core 是否需要「只读 .state.md 的当前状态」方法（供 LLM 工具查询）？ | 是——加 `get_state() -> dict`（只读快照），方便 LLM 不读文件即知状态；但**不**暴露 mutation（mutation 只经 transition） |
