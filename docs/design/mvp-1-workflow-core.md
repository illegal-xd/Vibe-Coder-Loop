# MVP-1 — Workflow Core 设计

> 目标：把 `vibe-coder-loop` 已验证的「状态机 + `.state.md` Checkpoint + 恢复协议 + VC 错误码」从 Markdown 协议升级为确定性代码。
> 原则：**只管状态，不管判断**。架构方案、审查结论、下一步动作归 LLM；Core 强制状态合法性、机械写 Checkpoint、机械执行恢复。

---

## 一、目标与非目标

### 目标
1. **状态机代码化**：S0–S14 合法转换由代码校验，非法跳转被拒绝（防跳过规则可执行化）。
2. **Checkpoint 自动化**：`.state.md` 的读写、字段完整性校验、原子写入由 Core 承担；可经宿主事件触发，也支持 LLM 显式调用。
3. **恢复协议机械执行**：freshness 判定、字段完整性、pending 逐项核验——现有 LLM 手动执行的步骤变成代码确定性执行。
4. **错误码程序化（两族分离）**：协议码 `NO_PROGRESS`/`LOOP_BUDGET_EXHAUSTED`/`SCOPE_DENIED`/`PLAN_DRIFT` 原样复用；运行时码 `STATE_*`/`CHECKPOINT_*` 独立命名空间（见 §六）。
5. **host-agnostic 协议端口**：6 个方法构成的接口（含只读 `get_state`），Adapter 只实现映射，不依赖任何宿主类型；MVP-3 与未来 Pi Adapter 都实现这 6 方法。

### 非目标
- 不实现对话压缩（归宿主；Core 只提供 TASK 区快照供注入）。
- 不决定 review 结论（`transition.md` S10 判定表由 LLM 读，Core 只校验「判定后才能转」）。
- 不引入数据库（沿用 YAML 单文件 Checkpoint，见 §七 存储设计）。
- 不做多任务并发（单任务单状态文件，按**项目根**隔离——见 §7.1「状态文件定位与隔离」；多任务留 Phase 4）。
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
# 合法后继表 = engine/transition.md「机器可读转移表」块的程序化镜像（逐边双向比对，见 §3.1.2）
LEGAL_TRANSITIONS = {
    # 正向主链
    "S0":  {"S1"},                         # Idle → Intent
    "S1":  {"S2", PAUSE},                  # Intent → Preflight（目标不明 → 暂停）
    "S2":  {"S3", "S4"},                   # Preflight → Decision / Router
    "S3":  {"S4", PAUSE},                  # Decision → Router（Low 冲突 → 暂停追问）
    "S4":  {"S5", "S8"},                   # Router → Clarify（L2+）/ Code[1]（Quick Loop）
    "S5":  {"S6"},                         # Clarify → Design
    "S6":  {"S7"},                         # Design → Plan
    "S7":  {"S8", "S10"},                  # Plan → Code / Investigation 分支 → 文档审查
    "S8":  {"S9", "S13"},                  # Code → Test（L1+）/ Complete（L0 直出）
    "S9":  {"S10", "S8"},                  # Test → Review / 回退 Code[N+1]
    "S10": {"S11", "S8", "S6", "S7", "S13"},  # Review → Reflection / Code[N+1] / Design[N+1]
                                               #        / Investigation 补调查或重调查 / 达上限收尾
    "S11": {"S12"},                        # Reflection → Memory Evolution（未触发则直接跳 S12）
    "S12": {"S13"},                        # Memory Evolution → Complete
    "S13": {"S0", "S1"},                   # Complete → Idle / follow-up 回 S1(Loop 归 0)
    "S14": {"S13", RESUME},                # Safe Mode → 用户「停止/接受」→ S13；用户「继续」→ 恢复原 phase
}

# 升级弧（S14 的唯一入口，独立表，不混进主链后继）
ESCALATION_EDGES = {"*": {"S14"}}          # 任意状态 → Safe Mode；须 force=True + reason + 风险报告

# 伪状态：PAUSE = 暂停等用户输入（不落 .state.md.phase）；RESUME = 恢复 _resume_from 记录的原 phase（Loop 不变）
PAUSE, RESUME = "PAUSE", "RESUME"
```

> **自检**：上表与 `transition.md` 各节「转移」行逐一对照，语义一致；`S7→S10`（Investigation 分支）、`S8→S13`（L0 直出）、**`S10→S7`（Investigation 情况 A/B）**、`S10→S6`（情况 B 回 Design）、`S13→S1`（follow-up）均覆盖。
>
> **两处原设计的错，本轮按事实源修正**：
> 1. **`S14` 出口写错了**——原表写 `S14 → {S0, S1}`，但 `state-machine.md`「状态转移图」明确「用户发送"停止循环"或"接受当前代码" → S13 Complete」，且 `kernel.md` §1「已确认后**维持原 Loop N 继续**」。故正解是 `S14 → {S13, RESUME}`：停止走 S13（再由 S13 决定回 S0 还是 follow-up 回 S1），继续则恢复原阶段且**不重置 Loop**。
> 2. **`S10 → S7` 缺边**——Investigation 分支（E 类只读任务）在 S10 判定后「情况 A → 回 S7[N+1]（补充调查）/ 情况 B → 回 S7[0]（重新调查）」，原表只有 `S10→S6`（Standard 分支）。
>
> **S14 入口的完整表达**：S14 可由**任意状态**触发，因此入口放在 `ESCALATION_EDGES` 而非主链后继；`force` 是对外接口的一等参数（见 §3.2），不是内部开关。

### 3.1.1 为什么这张表必须被校验而不是被信任

`LEGAL_TRANSITIONS` 是**副本**，而副本必然漂移：协议文档改了、代码表没改，测试却只验证代码表自身，于是"测试全绿 + 行为全错"。因此增加**校验闸门**——副本不许裸信。

### 3.1.2 单一事实源与漂移校验

| 映射 | 事实源 | 校验方式 | 失败行为 |
|---|---|---|---|
| 状态集合 / 合法转换 / 异常路径 | `engine/transition.md` | `tests/core/test_protocol_conformance.py` 解析事实源并与 `LEGAL_TRANSITIONS` + `ESCALATION_EDGES` 逐边比对（双向：缺边、多边都报） | 测试红；CLI `core check-protocol` 返回 `PROTOCOL_DRIFT`，exit 3 |
| 阶段 Label 文本 | 同上 | 同上 | 同上 |
| Loop 计数规则 | `kernel.md` §7 + `transition.md` 各节「计数器」栏 | 断言 `INCREMENT_EDGES`（§3.3）与两条事实源一致 | 同上 |
| 复杂度分级 / Loop Depth 激活矩阵 | `engine/complexity-gate.md` | 与 `manifest.yaml` `complexity.levels` 比对 Level 集合 + 各 Level 激活阶段 | 同上 |
| Safe Mode 触发条件**键集合** | `kernel.md` §5 + `manifest.yaml` `tunable_parameters.safe_mode_triggers` | 键集合一致；**值**在 `runtime/core/safemode.py` 固定（manifest 为描述性镜像，校验键集 + 下界，**不提供项目级覆盖链**） | 同上 |

**机器可读块的约定（对 Skill 文件的最小侵入）**：`transition.md` 保留人读正文，另加一个受注释包裹的机器块：

```markdown
<!-- vc:transitions -->
S0  -> S1
S1  -> S2 | PAUSE
S10 -> S11 | S8(+1) | S6(+1) | S13
S13 -> S0 | S1(loop=0)
<!-- /vc:transitions -->
```

- 块**存在** → 校验器只读块（人读正文改写不影响代码表）。**当前已落地**：`transition.md`「机器可读转移表」节。
- 块**缺失/版本不符** → 校验器回退解析各节「**转移**：`>>> ...`」行 + 正则提取 `S<n>`；任何一条边无法解析 → `CONFORMANCE_UNPARSED`（**fail-closed，宁红不猜**）。
- 块内的 `(+1)` / `(loop=0)` / `(loop=1)` / `(resume)` / `(a/b)` 修饰符是 **Loop 语义的一部分**，校验器必须同时比对边集合与修饰符集合（只比边会漏掉「改成递增」这类最危险的漂移）。
- 块首行的 `v1` 为块的语法版本；语法变更须升版本并同步校验器。

**不做的事**：不把整个 Skill 改成机器可读格式（方法论正文的人类可读性优先）；**不在运行时**解析 Markdown（只在测试 / CI 时），避免启动路径依赖文件布局。

### 3.2 状态转换接口（host-agnostic port 的核心方法）

```python
class WorkflowCore:
    def transition(
        self, to_state: str, *,
        loop: int | None = None,             # 显式设置 Loop（回退 N+1 / follow-up 归 0）
        exit_checklist: ExitChecklist | None = None,  # 阶段出口清单的勾选证据（LLM 产出）
        expected_rev: int | None = None,     # 乐观并发：调用方读到的状态版本号（见 §4.2）
        force: bool = False,                 # 仅 S14 升级 / 用户确认恢复（§3.1 ESCALATION_EDGES）
        reason: str = "",                    # force=True 时必填：SafeModeReason 码或恢复依据
    ) -> TransitionResult: ...
```

**职责**（顺序即校验顺序，前项失败即返回、不落盘）：

1. **版本校验**：`expected_rev` 非空且 ≠ 当前 `_rev` → `STATE_REV_CONFLICT`（`[next] 重新读取状态后重放本次转换`），不落盘。
2. **目标合法性**：`to_state ∈ LEGAL_TRANSITIONS[current.phase]` → 否则 `STATE_ILLEGAL_TRANSITION`（`[next] 回退执行当前阶段出口清单`），不落盘。**注意**：不复用 `RULE_NOT_LOADED`——该码语义是「阶段必读文件未加载」，借用作非法跳转会污染既有码义（见 §六 码归属）。
3. **升级合法性**：`to_state == "S14"` 且当前状态无直接边 → 需 `force=True` + `reason` 非空，否则 `STATE_ILLEGAL_TRANSITION`；写入 `_resume_from = 原 phase` 供 RESUME 恢复。
4. **出口证据**：`exit_checklist` 引用了上一阶段产出（防跳过规则可执行化）且必填项已勾选 → 否则 `EXIT_CHECKLIST_INCOMPLETE`（`[next] 补齐 <缺项> 后重试`），不落盘。
5. **Loop 记账**：按 §3.3 的边规则决定 `loop`。边只允许一个值时，显式传入必须等于该值（不一致 → `INVALID_ARGUMENT`，不允许用 loop 参数绕过预算）；边允许多个值时（如 `S10→S7` 的 A/B），**必须显式传**，否则 `INVALID_ARGUMENT`。
6. **预算守卫**：`loop > loop_max(level)` → `LOOP_BUDGET_EXHAUSTED`（fail-closed），不落盘。
7. **写入**：`phase` + `loop` + `current_step` + 追加 `completed` + `_rev += 1`；**仅在字段变化时写**（沿用协议「阶段出口仅变字段才写」）。
8. **返回** `TransitionResult{ok, from_, to, loop, rev, vc_code?, next?}`。

**不做的**：不校验 `exit_checklist` 的*内容正确性*（那是 LLM 的判断）；只校验「该有的项是否勾选 + 是否引用了上一阶段」。

**`ExitChecklist` 的轻量结构**（对应原 U7，此处定案）：

```python
@dataclass(frozen=True)
class ExitChecklist:
    stage: str                      # 上一阶段（如 "S7"）
    referenced_outputs: list[str]   # 上一阶段产出指针（文件路径 / Step 编号 / 函数名）
    checked_items: list[str]        # 本阶段出口清单已勾选条目（文本，来自 transition.md）
```

`referenced_outputs` 非空且至少一项能被**机械验证**（路径存在 / Step 编号出现在 S7 计划内 / 符号能在 codegraph 或 grep 命中）→ 视为满足防跳过；否则 `EXIT_CHECKLIST_INCOMPLETE`。**只验证"引用可解析"，不验证"引用得对"**——后者仍是 LLM 的判断。

### 3.3 回退弧与 Loop 计数

**唯一递增集合**（`INCREMENT_EDGES`，与 `transition.md` 机器可读块 + `kernel.md` §7 一致）：

| 边 | Loop 行为 | 依据 |
|---|---|---|
| `S9→S8`（测试失败回退 Code） | `N → N+1` | `transition.md` S9 转移「回退 Code [N+1]」 |
| `S10→S8`（Review 情况 A） | `N → N+1` | `transition.md` S10 表「情况 A → S8 Code[N+1]」 |
| `S10→S6`（Review 情况 B） | `N → N+1`（**递增发生在进入 S6 时**） | `transition.md` S10 表「情况 B → S6 Design[0] → S8 Code[N+1]」+ 计数器栏「N→N+1」 |
| `S10→S7`（Investigation 情况 A：补充调查） | `N → N+1` | `transition.md` S7「情况 A → 回 S7[N+1]」 |
| `S10→S7`（Investigation 情况 B：重新调查） | **归 0** | `transition.md` S7「情况 B → 回 S7[0]（重新调查）」 |
| `S13→S1`（follow-up 新目标） | **归 0** | `kernel.md` §1「follow-up = 新任务、Loop 归 0」 |
| `S4→S8`（Quick Loop 首次进 Code） | **初始化 = 1** | `transition.md` S4「Quick Loop → 进入 Code[1]」——这是赋值，不是递增 |

> **同一条边出现两种 Loop 语义**（`S10→S7` 的 A/B）：机器块写作 `S7(+1/loop=0)`，即该边**允许值集为 `{+1, 0}`**，调用方**必须显式传 `loop`**；未传或不 ∈ 允许集 → `INVALID_ARGUMENT`（`[next] 指明是补充调查(N+1)还是重新调查(0)`）。`S10→S6` 的 `[0]` 标签是**显示口径**（重设计阶段的 Loop 显示为 0），**计数器**仍为 `N+1`——预算按计数器算。

**不递增的边**（其余全部，含易错项）：

| 边 | Loop 行为 | 依据 |
|---|---|---|
| `S6→S7→S8`（情况 B 重设计的后续前进） | **保持**（不再二次递增） | 递增已计入 `S10→S6`；同一次情况 B 只消耗 1 次预算 |
| `S8→S8`（同轮自检修复，未跨阶段） | **保持** | 「VC 码标否的不消耗 Loop 计数」 |
| 防跳过回退（无法引用上一阶段产出） | **保持** | `state-machine.md`「防跳过回退属同一轮内修正」 |
| `S14→RESUME`（用户「继续」） | **保持**（`kernel.md` §1：维持原 Loop N） | SAFE MODE 是暂停，不是重置 |
| `S1→S2` / `S2→S3` / `S2→S4` / `S3→S4` / `S4→S5` / `S5→S6` / `S6→S7` / `S7→S8` / `S7→S10` / `S8→S9` / `S9→S10` / `S10→S11` / `S10→S13` / `S11→S12` / `S12→S13` / `S13→S0` / `S14→S13` | **保持** | 正向推进、收尾、达上限收尾均不改重试预算 |

**原设计的歧义修正**：旧文档写「`S10→S6` loop +1（重设计后回 S8 同轮）」，"同轮"易被读成"回 S8 时再算一轮"。定案：**情况 B 全程只递增一次**（在 `S10→S6`），`S6→S7→S8` 继承同一 `N+1`；§十 用例 V3b 专门验证该路径。

**Loop 上限守卫**：`loop_max` 按 Level 取值（原 U6，此处定案，依据 `kernel.md` §7）：

```python
def loop_max(level: int) -> int:
    return 1 if level in (0, 1) else 3   # kernel.md §7「Quick Loop(Level 0/1) 上限 1 轮」
                                         # + 「Review[3] 触发情况 B → N+1=4>3 → 直接停止」
```

`manifest.yaml` `cost.loop_max=3` 仅作 **L2+ 缺省**，且必须与 `kernel.md` §7 保持一致（由 §3.1.2 校验器断言）；`complexity-gate.md` 的「1 轮上限」表述即 L0/L1 的硬约束——三者不再冲突，是**同一规则的分层表达**。项目覆盖只允许**收紧**（`min(项目值, 事实源值)`），不允许放宽。

### 3.4 Safe Mode（S14）入口

**原则**：MVP-1 只强制**可确定性判定、可稳定测试**的触发条件。统计型指标（需要历史分布或 LLM 上报）Phase 1 **只观测、不切态**——在口径未定义前强制切状态，等于把一个未定义的判断植入状态机。

```python
# Phase 1 强制触发（deterministic，可单元测试）
SAFE_MODE_ENFORCED = {
    "consecutive_same_failures": 2,   # 连续 2 次相同失败指纹（来自 §5.4 持久化计数）
    "loop_budget_exhausted": True,    # loop > loop_max(level)
    "hard_constraint_violation": 1,   # LLM 显式上报硬约束违规（单次即触发，不累计）
}

# Phase 1 只观测（写入 metrics，不改变状态；口径获批后再升级为强制）
SAFE_MODE_OBSERVED = {
    "files_touched": 10,              # 单轮触及文件数（Exec/Adapter 上报）
    "hard_violation_repeats": 3,      # 硬约束违规重复次数
    "failure_type_share": 0.15,       # 失败类型占比 —— 需先定义"失败类型"枚举与分母
    "loops_vs_avg_ratio": 1.5,        # 本轮循环数 / 历史平均 —— 需先定义历史窗口
}
```

| 触发 | 数据来源 | 判定位置 | 缺失数据时 |
|---|---|---|---|
| `consecutive_same_failures` | `.state.md` `review.failure_state`（§5.4 持久化） | `feed_exec()` | 计数缺失 → 按 1 处理，不误触发 |
| `loop_budget_exhausted` | `loop` + `level` | `transition()` | 恒可用 |
| `hard_constraint_violation` | LLM 经 `vc_violation` 参数显式上报 | `transition()` / `feed_exec()` | 无上报视为 0（**不猜测**） |

**触发动作**：`force=True` + `reason=<SafeModeReason>` 转 S14，返回 `NO_PROGRESS`（连续失败）或 `LOOP_BUDGET_EXHAUSTED`（预算），均 fail-closed → 停止 + 输出风险报告。

**S14 出口**（按 `state-machine.md`「状态转移图」+ `kernel.md` §1 修正）：

| 用户响应 | 转移 | Loop |
|---|---|---|
| 「停止循环」/「接受当前代码」 | `S14 → S13`（再由 S13 决定回 S0 或 follow-up 回 S1） | 不变 |
| 「继续」 | `S14 → RESUME`：恢复 `_resume_from` 记录的原 phase | **维持原 Loop N**（`kernel.md` §1） |
| 无响应 | 停在 S14 | — |

进入记录：转 S14 时写 `_resume_from = <原 phase>` 与 `_rev`，`exit_checklist` 出 S14 必须含**用户原话证据**（或 `user_decisions` 条目 id）；无证据不离开 S14。**进入不需确认，退出必需确认**。

> **`manifest.yaml` 自述**：`tunable_parameters` 中 `code_style` / `retrieval_caps` 等为「项目无关缺省参考值，非契约；项目可自行覆盖」。**例外 = `safe_mode_triggers`**：运行期强制阈值在 `runtime/core/safemode.py` 固定，manifest 只是描述性镜像（`check-protocol` 校验键集与下界），当前**没有**读取链——调宽/调严须同时改代码常量与 kernel §5。

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

#### 4.1.1 协议版本与扩展字段（原「13 字段不变」与「新增 schema/指纹」的矛盾修正）

「13 字段不变」约束的是**语义字段集**，不是"文件里只能有 13 个键"。定案：

| 类别 | 键 | 归属 | 规则 |
|---|---|---|---|
| **语义字段（13）** | 见上表 | Skill 协议 | 名字/语义不得由 Core 改动；缺失 → 容错填充 |
| **保留扩展键** | `_schema`, `_rev`, `_project_id`, `_resume_from` | Core | 前缀 `_`，**不计入 13 字段校验**，Skill 侧忽略即可 |
| **保留扩展子键** | `review.failure_state` | Core | 归入既有 `review` 字段的子键，不进顶层，**不改 13 字段数** |

**向后兼容规则**（三条，写死在 loader 里）：

1. **未知键透传**：Core 读写往返必须原样保留任何不认识的键（含注释顺序尽量不变），**不得丢弃**——这样 Skill 侧先增字段、Core 后升级也不会互相破坏。
2. **缺失即缺省**：非必需语义字段缺失 → 填缺省值，不报错（向前兼容 Skill 演进）。
3. **版本超前即降级**：`_schema > STATE_SCHEMA_VERSION` → 降级为「仅参考」（不写、不驱动转换），返回 `CHECKPOINT_SCHEMA_AHEAD`，交 LLM 按新协议手动处理。

`_schema` 是**真实键**而非顶部注释：注释不可被可靠解析，原设计"注释声明 + `raw.get("_schema_version")` 读取"自相矛盾（见 §4.3）。

### 4.2 原子写入契约（跨平台）

原设计的两个硬错已修正：`Path.write_text()` **返回写入字符数而非文件对象**（无 `fileno()`），且"读-改-写"窗口未被锁保护。

```python
def _write_state(self, fields: dict, *, expected_rev: int | None) -> WriteResult:
    """原子写：锁住读-改-写全程 → 同目录临时文件 → flush+fsync → os.replace → fsync 目录。"""
    with self._lock(exclusive=True):                       # 跨平台锁，见下
        cur = self._read_unlocked()
        if expected_rev is not None and cur.rev != expected_rev:
            return WriteResult(ok=False, vc_code="STATE_REV_CONFLICT",
                               next="重新读取状态后重放本次写")
        merged = self._merge(cur.fields, fields)           # 见下「冲突策略」
        merged["_rev"] = cur.rev + 1
        merged["updated_at"] = now_to_minute()
        payload = self._render(merged)                     # 规范形式渲染

        fd, tmp = tempfile.mkstemp(dir=self.state_dir, prefix=".state.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())                       # 显式句柄，非 write_text 返回值
            os.replace(tmp, self.state_path)               # POSIX: rename 原子；Windows: MoveFileEx 原子（同卷）
            self._fsync_dir(self.state_dir)                # 仅 POSIX；Windows 跳过
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)                             # 失败不残留 tmp
            raise
    return WriteResult(ok=True, rev=merged["_rev"])
```

**跨平台锁策略**（不假定 `flock` 存在）：

| 平台 | 机制 | 说明 |
|---|---|---|
| POSIX | `fcntl.flock(fd, LOCK_EX \| LOCK_NB)` + 轮询超时 | 锁文件 `<state>.lock`，超时 5s |
| Windows | `msvcrt.locking(fd, LK_NBLCK, 1)` + 轮询超时 | 同一 `.lock` 文件，锁首字节 |
| 兜底（两者均不可用） | `O_CREAT\|O_EXCL` 锁文件 + PID + 时间戳；>30s 视为陈旧可抢占 | 记录 `lock_mode: "best_effort"` 并写 metrics；不静默假设安全 |

**为什么还需要版本号（锁不够）**：锁只保证写入串行，不保证"基于新状态写"。Adapter 事件与 LLM 工具是两个进程，各自「读 → 决策 → 写」，锁在两者之间会让**后写者覆盖先写者的语义**（丢失中间状态）。因此引入乐观并发：

- `load_checkpoint()` / `get_state()` 返回 `rev`（来自 `_rev`）；没有 `_rev` 的旧文件按 `rev=0` 处理。
- 所有 mutation 接受 `expected_rev`；不匹配 → `STATE_REV_CONFLICT`（fail-closed，不落盘），调用方重读后重放。
- `expected_rev=None` 表示"调用方明确接受覆盖"（仅限 `pause()`/`complete()` 这类**整字段替换**操作，且写 metrics 记账）。

**冲突合并策略**（`_merge`）：

| 字段类型 | 策略 | 理由 |
|---|---|---|
| 追加型数组（`completed` / `pending` / `decisions` / `user_decisions`） | **并集 + 保序去重**（`completed` 以旧值为前缀，新项追加尾部） | 两个写者各自追加不同项时不该互相吞掉；顺序语义由协议保证（不删、不改序） |
| 标量（`phase` / `loop` / `status` / `level` / `current_step`） | **不合并**：rev 不匹配即 `STATE_REV_CONFLICT` | 标量冲突无安全默认值，猜就是错 |
| 结构化（`goal` / `review`） | 子键级合并；同一子键冲突按标量处理 | 减少无谓冲突，同时不吞语义 |

**降级**：若状态文件不可写（权限/磁盘满/锁超时）→ 不抛异常中断流程，返回 `CHECKPOINT_WRITE_FAILED`（`[next] 检查目录权限/磁盘后重试`），LLM 可继续按协议手动维护（Phase 0 兼容）。

### 4.3 解析格式与 schema 校验（原 U1 定案）

**现状事实**：`.state.md` 是**顶部单个 `---` 开始的 YAML 文档**（无结尾 `---`），字段按模板嵌套，`resume` 用块字面量 `|`，注释行贯穿全文（见 `skills/vibe-coder-loop/.state.template.md`）。标准库**没有** YAML 解析器，原设计的 `_parse_yaml()` 是空白。

**定案：受限 YAML 子集 + 规范化写出（零依赖）**

不复用完整 YAML 语法，而是定义**封闭语法**（我们同时拥有写端与模板，语法面可控）：

| 支持 | 不支持（出现即判 `corrupt`，不猜） |
|---|---|
| 块映射（`key:` + 缩进子块） | 锚点/别名（`&a` / `*a`） |
| 块序列（`- item`），空序列写作 `[]` | 流式集合（`[a, b]` 非空、`{a: b}`） |
| 标量：plain / 单引号 / 双引号 | 多文档（第二个 `---`） |
| 块字面量 `|`（多行文本） | 标签（`!!str`）、指令（`%YAML`） |
| 行注释 `#`（非引号内） | 复杂键（`? key`） |

**三层降级读取**（宁可降级，不可错解）：

```python
def load_raw(self) -> tuple[dict, ParseQuality]:
    text = self.state_path.read_text(encoding="utf-8")
    try:
        return parse_subset(text), ParseQuality.STRICT          # 完整结构
    except SubsetParseError:
        flat = scan_flat_scalars(text)                          # 只抽扁平标量
        if flat is None:
            raise CorruptState
        return flat, ParseQuality.DEGRADED                      # 仅 status/phase/loop/level/updated_at
```

- `STRICT`：全字段可用 → 正常恢复。
- `DEGRADED`：复杂字段（`completed`/`pending`/`decision`）不可信 → `mode="resume_degraded"`，只恢复 `phase`/`loop`/`level`/`updated_at`，**列表类字段全部转 pending 交 LLM 重新核验**，并返回 `CHECKPOINT_DEGRADED`。
- 都失败 → `corrupt`（备份 `.state.corrupt-<ts>`，全新开始）。

**写端规范化**（消除"写出去再读不回"）：

- 单一渲染器 `_render()`；**不保留**输入里的任意 YAML 特性，只输出子集内形式。
- 所有字符串标量**一律加引号**（规避 `state-machine.md` 已记录的陷阱：列表项以 `**`/`*` 开头会被 YAML 当别名）；多行只允许出现在 `resume`（用 `|`）。
- 输出幂等：`render(parse(render(x))) == render(x)`，作为单元测试不变量（V16）。
- 提供 `core state check` 子命令：LLM 手写后先校验再交付，避免写坏文件。

**schema 读取（统一存储方式）**：

```python
STATE_SCHEMA_VERSION = 1

def load_checkpoint(self) -> RecoveryResult:
    raw, quality = self.load_raw()
    schema = raw.get("_schema", 1)              # 真实键，非注释
    if schema > STATE_SCHEMA_VERSION:
        return RecoveryResult(mode="reference_only", vc_code="CHECKPOINT_SCHEMA_AHEAD",
                              next="按新版协议手动恢复；Core 不写入以免破坏")
    ...
```

**协议侧待同步**（不属本设计修改范围，但必须被记录）：`state-machine.md` 的 `.state.md` 节需补三句——`_schema`/`_rev`/`_project_id` 为保留键；`review.failure_state` 为保留子键；状态文件位置改由项目根解析（见 §7.1）。这是 Phase 0 收敛的**交付项之一**（见 overview §六）。

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
                              next="以当前会话为准，旧文件备份为 .state.corrupt-<ts>")
    # 字段完整性：协议要求 12 项齐全（13 字段中 updated_at 单列作 freshness）
    missing = REQUIRED_FIELDS - raw.keys()
    if missing:
        # 协议口径 = 「降级为仅参考」，不是"全新开始"：不覆盖、不删除，只是不据它驱动流程
        return RecoveryResult(mode="reference_only", vc_code="CHECKPOINT_DEGRADED",
                              missing=missing,
                              next="按当前会话 + 用户输入重建；旧文件仅作参考，不覆盖")
    # freshness（updated_at 到分钟）
    age = self._age_minutes(raw["updated_at"])
    if age > expected_age_minutes:
        return RecoveryResult(mode="resume_stale", raw=raw,
                              vc_code="CHECKPOINT_STALE",
                              next="核验 pending 后续跑；与用户输入冲突以用户为准")
    return RecoveryResult(mode="resume", raw=raw)
```

**恢复时必须同时校验 artifact 引用**（否则恢复出一个指向已过期产物的状态，见 §7.3）：对 `review`/`pending` 中出现的每个 `artifact_ref`，用 `artifact list` 的索引核对存在性（**不读内容**，成本 O(1)）→ 失效则标 `artifact_missing` 并附 `regen_cmd`；**引用失效不阻断恢复**（降级不改 mode）。

### 5.2 pending 逐项核验（三态，不是二态）

原设计把「文件存在且 mtime 较新」直接等同于「任务完成」，这是错的：文件可能**早就存在**，也可能被**无关操作**更新了时间戳。Core 只收集证据，不代替 LLM 判定完成。

```python
@dataclass(frozen=True)
class PendingCheck:
    item: str
    state: Literal["verified", "unverified", "still_pending"]
    evidence: list[str]      # 供 LLM 复核的可读证据，如 "path exists: src/a.py (mtime 2026-10-19 22:10)"
    move_to_completed: bool  # 仅 verified 才可能为 True

def verify_pending(self, pending: list[str], *, plan: PlanContract | None) -> list[PendingCheck]:
    ...
```

| 状态 | 判定条件（必须至少命中一条**强证据**） | Core 动作 |
|---|---|---|
| `verified` | ① 文件路径存在 **且** 内容哈希与 pending 中声明的期望一致；② `git log -1 --format=%H -- <path>` 显示该文件在**本轮起点之后**有新提交；③ pending 声明的验证命令（如 `pytest tests/x.py`）已由 Exec 跑通且 `ok=True` | 移入 `completed`，记 `evidence` |
| `unverified` | 仅「路径存在」或「mtime 晚于本轮起点」——**弱证据** | **不移 completed**；保留在 `pending`，附 `evidence`，交 LLM 决定 |
| `still_pending` | 路径不存在 / 无任何证据 / 无法提取路径 | 保留，`unverifiable` 的子标记 |

**硬规则**：

- 只有 `verified` 可以 `move_to_completed=True`；`unverified` 一律不动（与"Core 只管状态，不管判断"一致）。
- 弱证据**不得**升级为强证据（不做"存在即完成"的隐式推断）。
- pending 项文本里没有可解析线索 → `still_pending`，**不猜测**，返回 `[next] 请人工确认该项是否已落地`。
- 「本轮起点」= `review.failure_state.round_started_at` 或 `updated_at` 的循环起始时间；两者都缺 → 没有"新提交"证据，只能 `unverified`。

### 5.3 恢复边界（对应 `state-machine.md` 恢复协议边界）

| 情况 | Core 行为 |
|---|---|
| status=active + fresh | 恢复 phase/current_step；completed 不重做；pending 经三态核验后处理 |
| status=paused + fresh | 恢复；标 `paused` 等用户确认续跑 |
| status=complete | 不恢复（任务已结束）；若用户给新输入 → 新循环覆盖（旧文件归档为 `.state.complete-<ts>`） |
| stale（超阈值） | 标 stale；TASK 区仅供参考；**与用户输入冲突以用户为准**（Core 不覆盖） |
| degraded（子集解析失败） | 只恢复 phase/loop/level；列表字段全部转 pending 重核；返回 `CHECKPOINT_DEGRADED` |
| 缺必需字段（12 项不全） | `reference_only`：**不覆盖、不删除**，不据它驱动流程；按当前会话 + 用户输入重建（协议口径为「仅参考」，非"全新开始"） |
| corrupt | 备份旧文件为 `.state.corrupt-<ts>`（不覆盖、不静默丢弃）；全新开始 |
| schema 超前 | `reference_only`：只读不写，交 LLM 按新协议手动处理 |
| `_project_id` 不匹配 | `foreign_start`：该文件属于另一个项目（复制/误放）→ 备份后全新开始，**不跨项目恢复** |

### 5.4 失败计数的持久化（供 §3.4 与 MVP-2 §5 使用）

连续失败计数**不能只存在内存**——进程重启或会话恢复就丢，导致 `NO_PROGRESS` 永不触发或误触发。定案存进 `.state.md` 的 `review.failure_state` 子键（属 §4.1.1 的保留扩展子键，不改 13 字段）：

```yaml
review:
  result: failed
  last_failure: "pytest: 2 failed"
  failure_state:
    last_fingerprint: "fp:9f2c…"   # 最近一次失败的稳定指纹（MVP-2 §5.1）
    consecutive_count: 2           # 与 last_fingerprint 连续相同的次数
    last_ok_at: "2026-10-20 08:55" # 最近一次成功执行（用于重置判定）
    round_started_at: "2026-10-20 08:40"  # 本轮起点（pending 强证据 ②③ 的基准）
    history: ["fp:9a1…", "fp:9f2c…"]      # 仅审计用，最多 10 条，环形覆盖
```

**为什么 `history` 不参与判定**：集合包含判断会把「隔了 5 轮又出现同样错误」误判为连续。连续只由 `last_fingerprint` + `consecutive_count` 表达（MVP-2 §5.2 给出算法与重置规则）。

---

## 六、错误码归属：既有协议码 vs 运行时扩展码

原设计混用两类码且借用了语义不符的 `RULE_NOT_LOADED`。定案：**两族分离，格式统一**（都遵守 `[CODE] fact\n[next] action` 铁律）。

### 6.1 既有协议码（原样复用，语义不改）

| 码 | Core 判定时机 | fail-closed | `[next]` |
|---|---|---|---|
| `PLAN_DRIFT` | `feed_exec()` 发现实际修改文件 ⊄ S7 计划声明集合 | 否（记录后继续） | 补记偏离理由或回 S7 重规划 |
| `NO_PROGRESS` | `repeat_check()` 连续 2 次同指纹（§5.4） | **是** | 进 S14，输出风险报告 |
| `LOOP_BUDGET_EXHAUSTED` | `transition()` 发现 `loop > loop_max(level)` | **是** | 停止 + 建议升级 Loop 深度或人工介入 |
| `SCOPE_DENIED` | LLM 经工具调用显式上报「操作超授权」（红线/生命周期） | **是** | 输出 Conflict Card 止步（Core 不自纠） |
| `OUTPUT_LIMIT` / `ARTIFACT_NOT_FOUND` | 归 MVP-2 Exec 判定（Core 只透传） | 否 | 见 MVP-2 |

### 6.2 运行时扩展码（Core 新增，命名空间独立）

**前提声明**：下列码是**运行时事实**，不是工作流判定。它们不写入 `transition.md` 的码表，只在 Core/Exec 的输出中存在；Adapter 透传给 LLM 时必须带 `[runtime]` 标识，避免与工作流码混淆。若要正式纳入协议，走 Skill 侧的 skill-iteration（Phase 0 交付项，见 overview §六）。

| 码 | 判定时机 | fail-closed | `[next]` |
|---|---|---|---|
| `STATE_ILLEGAL_TRANSITION` | `to_state ∉ LEGAL_TRANSITIONS[phase]`（且不满足升级弧） | 是（不落盘） | 回退执行当前阶段出口清单 |
| `STATE_REV_CONFLICT` | `expected_rev` 与当前 `_rev` 不符 | 是（不落盘） | 重新读取状态后重放本次转换 |
| `EXIT_CHECKLIST_INCOMPLETE` | 出口清单缺必填项，或 `referenced_outputs` 无一项可机械验证 | 是（不落盘） | 补齐 `<缺项>` 后重试 |
| `CHECKPOINT_LOCATION_UNRESOLVED` | 无法确定项目根 / 目标路径在 Skill 安装目录内 | **是** | 显式传 `--cwd` 或设 `VIBE_KERNEL_STATE_DIR` |
| `CHECKPOINT_FOREIGN` | `_project_id` 与当前项目根不符 | 否（降级） | 备份该文件，按全新任务开始 |
| `CHECKPOINT_STALE` | freshness 不通过 | 否（降级） | 核验 pending 后续跑；冲突以用户为准 |
| `CHECKPOINT_DEGRADED` | 子集解析失败但扁平标量可读 | 否（降级） | 仅按 phase/loop 续跑，列表字段重新核验 |
| `CHECKPOINT_CORRUPT` | 严格 + 降级解析均失败 | 否（降级） | 备份旧文件，全新开始 |
| `CHECKPOINT_SCHEMA_AHEAD` | `_schema > STATE_SCHEMA_VERSION` | 否（只读） | 按新版协议手动恢复 |
| `CHECKPOINT_WRITE_FAILED` | 写入/加锁失败 | 否（降级） | 检查权限/磁盘；LLM 手动维护 |
| `PROTOCOL_DRIFT` | `core check-protocol` 发现代码表与事实源不一致 | **是**（CI 门禁） | 同步 `LEGAL_TRANSITIONS` 或修正事实源 |

**为什么不复用 `RULE_NOT_LOADED`**：它的协议语义是「进入某阶段但该阶段必读文件未加载」，`[next]` 是"加载对应文件后重跑本阶段出口"。把它用于"非法状态跳转"会让 LLM 去加载文件，而不是回退阶段——**错误码的原意是给 LLM 的动作指令，改名就改错了动作**。

---

## 七、存储设计

### 7.1 状态文件定位与隔离（P0 修正：不与 Skill 源文件同址）

> **已被取代（现行协议）**：Checkpoint 改为 delx-memory 条目 `vc:checkpoint:<项目绝对地址>`（tags `vc-checkpoint` / `L0` / `scope:project`），读取写入统一走 delx-memory；不再创建 `.vibe-kernel/` 或任何项目内状态文件。本节保留为历史设计决策记录，实现以 `skills/vibe-coder-loop/engine/state-machine.md`「Workflow Checkpoint（delx-memory）」为准。

**原设计的矛盾**：一边把状态放 `$SKILL_DIR/.state.md`，一边要求"按 cwd/worktree 隔离"。只要有第二个项目，所有项目会经软链写同一个文件，状态互相覆盖。**运行时状态不属于 Skill 安装目录**——安装目录是只读的代码资产，状态是每项目私有数据。

**定位顺序**（`StateResolver`，每一步都做 `realpath` 归一）：

> **命名说明**：文件名继续用协议名 `.state.md`（**只改位置，不改名**）——从 Skill 安装目录改为项目本地目录 `.vibe-kernel/`。这样既有的所有 `.state.md` 引用（`SKILL.md`/`kernel.md`/`transition.md`/`e4-matrix.md` 等数十处）无需跟着改名，减少漂移面。

```text
1. --state-dir <path>          显式参数（绝对路径，或相对 cwd 解析）
2. 环境变量 VIBE_KERNEL_STATE_DIR
3. 项目配置 <project_root>/.vibe-kernel/config.json → {"state_path": "..."}
4. 缺省：<project_root>/.vibe-kernel/.state.md
```

**项目根如何确定**：

```text
a. --cwd 显式给定（Adapter 传 worktree ?? directory）→ 必须存在且是目录，realpath 归一
b. 从 --cwd 向上查找项目标记（.git / .vibe-kernel / pyproject.toml / package.json / go.mod）
   取最高命中（避免子包误判为项目根）
c. 都找不到 → 用 --cwd 本身（不向上越出用户给定目录）
d. 解析失败 / 结果为 Skill 安装目录或其子目录 → CHECKPOINT_LOCATION_UNRESOLVED（fail-closed）
```

**硬校验（对称保护）**：解析结果若落在 `$SKILL_DIR` 内 → 拒绝并返回 `CHECKPOINT_LOCATION_UNRESOLVED`。这条规则同时拦住旧路径的回流。

**隔离规则表**：

| 场景 | 行为 |
|---|---|
| 两个项目并行 | 各自 `.vibe-kernel/.state.md`，物理隔离；`.vibe-kernel/.state.lock` 也各自独立 |
| git worktree | `ctx.worktree` 优先于 `ctx.directory` → 每个 worktree 各自状态（符合 worktree 即独立工作副本的语义） |
| 软链接指向同一目录 | `realpath` 归一后**视为同一项目**（这是期望行为：同一份代码不该有两份状态）；`_project_id` 相同故不冲突 |
| 软链接指向不同项目 | `realpath` 不同 → 各自隔离；不复用软链目标的状态 |
| 项目里发现别人的状态文件 | `_project_id = sha256(realpath(project_root))[:16]` 不匹配 → `CHECKPOINT_FOREIGN`，备份后全新开始 |
| 路径含空格 / Unicode | 全程 `pathlib.Path` + argv 数组传参，**不拼 shell 字符串**；日志用 `os.fsdecode` 原样输出 |
| `.vibe-kernel/` 不存在 | 创建（`0o700`），并确保 `.gitignore` 含 `.vibe-kernel/`（见下） |
| 路径不存在 / 无权限 | `CHECKPOINT_LOCATION_UNRESOLVED` / `CHECKPOINT_WRITE_FAILED`，不静默退化到 Skill 目录 |

**Git 忽略**：初始化 `.vibe-kernel/` 时：

1. 若 `.gitignore` 存在且无该条目 → **追加**带标记的块（`# vibe-kernel runtime state` + `.vibe-kernel/`）；不重写其他行。
2. 若不存在 → 创建（只含该条目）。
3. 若 `.gitignore` 只读 → 记 metrics 警告 + 在 `.vibe-kernel/` 内放 `.gitignore`（`*`）**双重保险**；不阻断。
4. 检测到状态文件**已被跟踪**（`git ls-files` 命中）→ 返回 `STATE_TRACKED_BY_GIT` 警告，提示用户 `git rm --cached`；**Core 不自动执行 git 写操作**（红线）。

**旧路径迁移**（不破坏现有用户）：若 `<project_root>/.vibe-kernel/.state.md` 不存在但 `$SKILL_DIR/.state.md` 存在 → **只读导入**（解析 → 写新位置 → 旧文件改名 `.state.md.legacy-<ts>`，不删除），并记录一次 metrics `state_migrated`。

### 7.2 选型复核：仍走 YAML 单文件

| 选项 | 评估 | 决定 |
|---|---|---|
| **A. YAML 子集单文件（项目本地）** | 单实例、低频写、低并发；LLM/人类可读可改；零依赖；与协议零摩擦 | ✅ **采用** |
| B. SQLite（仿 delx-memory） | 任务状态非高频检索；引入 DB 增依赖与运维负担 | ❌ 拒绝 |
| C. JSON | 人类不可读可改；失去注释价值 | ❌ 拒绝 |

### 7.3 artifact 生命周期约定（P0 修正：24h TTL ≠ 任务恢复周期）

`memory_tool.py` 的 artifact 是 **24h TTL、put 时回收**的会话级缓存；任务可能中断数天后恢复。把 artifact ref 写进 Checkpoint 而不定义生命周期，会导致"恢复出一个指向空气的状态"。

**两层存储**：

| 层 | 位置 | 生命周期 | 用途 |
|---|---|---|---|
| `ephemeral` | memory_tool.py artifact 目录 | 24h（put 时回收） | 会话内大输出（测试日志尾部、完整堆栈）；**允许过期** |
| `pinned` | `<project_root>/.vibe-kernel/artifacts/<sha256[:16]>.log` | 直到任务 S13 完成或显式 release | Checkpoint 长期引用的产物；**不允许静默过期** |

**引用契约**（`.state.md` 内不存裸 ref，存结构化引用）：

```yaml
review:
  last_failure_ref:
    tier: pinned            # ephemeral | pinned
    ref: "artifacts/9f2c1a…"  # pinned 为项目内相对路径；ephemeral 为 artifact ref
    sha256: "9f2c…"
    bytes: 48213
    created_at: "2026-10-20 08:55"
    reproducible: true       # 能否重跑重建
    regen_cmd: ["pytest", "-x", "tests/"]   # 仅 argv，禁止 shell 字符串
```

**规则**：

1. **恢复时**校验引用（§5.1）：`ephemeral` 用 `artifact list` 核对；`pinned` 用 `sha256` 核对。失效 → 标 `artifact_missing`，**不阻断恢复**。
2. **失效后的结构化返回**：能重建（`reproducible=true` 且有 `regen_cmd`）→ `[runtime] ARTIFACT_NOT_FOUND` + `[next] 重新执行 <regen_cmd>`；不能重建 → 明示"该证据已不可恢复，请基于现有信息判断"。
3. **永不返回不存在的 ref**：只有 `put` 成功且回读校验通过才写引用（MVP-2 §3.5）。
4. **GC 不误删**：`pinned` 目录的清理必须**先读当前 Checkpoint 的引用集合**，只删不在集合内且 `mtime` 早于阈值（缺省 7 天）的文件；`status=active` 时**不执行任何 GC**。GC 只在 S13 完成或用户显式 `state gc` 时运行。
5. **pinned 与 .gitignore**：`.vibe-kernel/` 整体忽略，无需单独规则。

### 7.4 与 memory_tool.py 的关系

- **职责分离**：memory_tool.py 管**经验记忆**（lesson/pattern/仪表盘/artifact）；Core 管**任务状态**（`.state.md`）。存储分离（SQLite vs YAML）、语义分离（Memory vs Context）。
- **复用工程模式**：原子写、逐条容错、fail-closed、显式 `[next]`、`artifact put/page` 的输出有界契约。
- **Core 可调用 memory_tool.py**：S12/S13 出口的 `touch`/`metrics` 仍由它承担；Core 只在 transition 时发出"该回写了"的提醒信号。

---

## 八、对外接口（host-agnostic port）

**6 个方法**（原 U8 定案：需要只读查询，但**不暴露 mutation**）：

```python
class WorkflowCore:
    # 1. 恢复/加载（会话启动时）
    def load_checkpoint(self) -> RecoveryResult: ...
        # RecoveryResult{mode, phase, loop, level, current_step, completed, pending,
        #                rev, quality, vc_code?, next?, artifact_missing[]}

    # 2. 状态转换（阶段出口）
    def transition(self, to_state, *, loop=None, exit_checklist=None,
                   expected_rev=None, force=False, reason="") -> TransitionResult: ...

    # 3. TASK 区快照（compaction / system prompt 注入用）
    def snapshot_task_zone(self, *, detail: Literal["full", "pointer"] = "full") -> str:
        """full=13 字段紧凑文本；pointer=单行指针（phase/loop/next + 取值入口）。"""

    # 4. 喂执行结果（MVP-2 Exec 结果流入，做重复检测/计划漂移）
    def feed_exec(self, result: ExecResult) -> FeedResult: ...

    # 5. 重复失败检测（幂等；与 feed_exec 内部同一实现）
    def repeat_check(self, fingerprint: str) -> RepeatResult: ...

    # 6. 只读状态查询（供 LLM 不读文件即知状态；无任何 mutation）
    def get_state(self) -> StateView: ...
```

**契约**：

- 全部方法**纯数据入参/出参**（dataclass），不含宿主类型；`rev` 在每次读写中显式传递（乐观并发）。
- `feed_exec` **幂等**：同一个 `fingerprint` 重复喂入不会把 `consecutive_count` 加两次（用 `exec_id` 去重，`exec_id` 由 Exec 生成）。
- **mutation 只经 `transition`**：`get_state`/`snapshot_task_zone` 严格只读；`pause()`/`complete()` 作为 `transition` 的目标状态表达（`status` 变化走 `transition` 的副作用），不单独开写口。
- CLI 一一映射（见 §九），参数 `--cwd` 必填，输出 JSON（含 `code`/`next` 字段），错误码同时以 `[CODE]` 前缀出现在 `message`。

---

## 九、实现层次与文件布局

```
runtime/core/                 # Core 实现（新建，零第三方依赖）
├── __init__.py
├── state_machine.py          # LEGAL_TRANSITIONS + ESCALATION_EDGES + transition() + Loop/预算守卫
├── checkpoint.py             # StateResolver + 原子写 + 跨平台锁 + 版本(rev) + 合并策略
├── state_parse.py            # 受限 YAML 子集解析器 + 规范渲染器（严格/降级/损坏 三态）
├── recovery.py               # load_checkpoint + freshness + 三态 pending 核验 + artifact 引用校验
├── safemode.py               # SAFE_MODE_ENFORCED / OBSERVED 判定
├── vc_codes.py               # 协议码 + 运行时扩展码（两族分离）+ 结构化返回
├── artifacts.py              # ephemeral/pinned 两层存储 + 引用契约 + GC
└── cli.py                    # 命令行入口（含 check-protocol / state check / state gc）
tests/core/
├── test_state_machine.py           # 合法/非法转换、升级弧、回退弧、Loop 计数、预算
├── test_checkpoint.py              # 原子写、锁、rev 冲突、合并策略、跨平台路径
├── test_state_parse.py             # 子集解析、引号陷阱、降级扫描、渲染幂等
├── test_recovery.py                # fresh/stale/degraded/corrupt/foreign + pending 三态
├── test_safemode.py                # 强制触发 vs 仅观测
├── test_artifacts.py               # 引用失效、GC 不误删、pinned 保留
└── test_protocol_conformance.py    # 代码表 ↔ transition.md/kernel.md/complexity-gate.md ↔ manifest
```

**新增可执行入口**（LLM/CI 可调，均为只读或受控写）：

| 命令 | 作用 |
|---|---|
| `core check-protocol` | 校验程序化映射与 Skill 事实源一致（`PROTOCOL_DRIFT`，exit 3） |
| `core state check --cwd` | 校验状态文件语法 + schema（LLM 手写后先用它） |
| `core state gc --cwd` | 清理不被引用的 pinned artifact（`status=active` 时拒绝执行） |
| `core get-state --cwd` | 只读快照（JSON） |

> **注意**：本设计只给布局与接口草案，**不实现**。文件路径是建议，实际实现时按验证脚本可达性调整。

---

## 十、验收场景（单元测试覆盖目标）

| # | 场景 | 期望 |
|---|---|---|
| V1 | 合法正向转换 S0→S1→S2→S4→S8→S9→S10→S13→S0 | 全部 ok，字段正确演进 |
| V2 | 非法跳转 S1→S8（跳过 Preflight） | 拒绝，`STATE_ILLEGAL_TRANSITION`，文件字节不变 |
| V3 | 回退弧 S9→S8，loop 递增 | ok，loop +1 |
| V3b | 情况 B：S10→S6（+1）→S7→S8 | 全程只 +1；S6→S7→S8 不二次递增 |
| V4 | `loop > loop_max(level)` | `LOOP_BUDGET_EXHAUSTED`，停止 |
| V4b | L0/L1 的 `loop_max` = 1；L2/L3 = 3 | 分别按 1/3 拦截 |
| V5 | follow-up S13→S1 | ok，loop 归 0 |
| V6 | status=active + fresh 恢复 | 恢复 phase/current_step，completed 不重做 |
| V7 | stale（超 1440 分钟）恢复 | 标 stale，冲突以用户为准 |
| V8 | corrupt（子集与降级扫描都失败） | 备份 `.state.corrupt-<ts>`，fresh_start |
| V9 | pending 有强证据（内容哈希/新提交/验证命令通过） | `verified` → 移 completed |
| V10 | pending 仅有弱证据（文件已存在 / mtime 较新） | `unverified`，**不移 completed** |
| V11 | pending 无可解析线索 | `still_pending`，返回 `[next]` 请人工确认 |
| V12 | 连续 2 次同指纹 | `NO_PROGRESS`，转 S14 |
| V13 | 实际修改文件 ⊄ S7 计划集 | `PLAN_DRIFT`，记录后继续 |
| V14 | 并发写：进程 A 读 rev=5 → 进程 B 写（rev=6）→ A 写 expected_rev=5 | A 得 `STATE_REV_CONFLICT`，**B 的数据不丢**；A 重放后成功 |
| V15 | 并发追加：A 追加 completed[1]，B 追加 completed[2] | 合并为两项，顺序稳定，无覆盖 |
| V16 | 渲染幂等 | `render(parse(render(x))) == render(x)` |
| V17 | 引号陷阱：pending 项以 `**` 开头 | 写出时被引号包裹，重新读回不报别名错误 |
| V18 | `_schema` 超前 | `CHECKPOINT_SCHEMA_AHEAD`，只读不写 |
| V19 | 未知键透传 | 读写往返后未知键与值原样保留 |
| V20 | 状态文件定位：软链项目 / worktree / 路径含空格与 Unicode | 各自解析到正确位置；`_project_id` 正确 |
| V21 | 状态文件被解析到 `$SKILL_DIR` 内 | `CHECKPOINT_LOCATION_UNRESOLVED`，拒绝写入 |
| V22 | 旧路径 `$SKILL_DIR/.state.md` 存在 | 只读导入到项目本地，旧文件改名 legacy，不删除 |
| V23 | `_project_id` 不匹配 | `CHECKPOINT_FOREIGN`，备份后全新开始 |
| V24 | artifact 引用已过期（ephemeral 超 24h） | 恢复成功 + `artifact_missing` + `regen_cmd` 提示；**不阻断** |
| V25 | GC 时存在被 Checkpoint 引用的 pinned 文件 | 不删除；`status=active` 时整体拒绝 GC |
| V26 | `core check-protocol` 面对人为改动的代码表 | `PROTOCOL_DRIFT`，exit 3 |
| V27 | S14 升级：任意状态 + force + reason | 允许进入；缺 reason → 拒绝 |
| V28 | S14 退出无用户确认证据 | 拒绝（停在 S14） |
| V29 | `snapshot_task_zone(detail="pointer")` | 单行指针，含 phase/loop + 取值入口 |
| V30 | S14 → RESUME（用户「继续」） | 恢复 `_resume_from` 的原 phase，**Loop 不变** |
| V31 | S14 → S13（用户「停止/接受」） | 进 S13；缺用户原话证据 → 拒绝离开 S14 |
| V32 | Investigation：S10→S7 传 loop=N+1 与传 0 | 两者都通过；未传 → `INVALID_ARGUMENT` |
| V33 | S10→S7 传 loop=N+2 | `INVALID_ARGUMENT`（不在允许集 `{+1, 0}`） |
| V34 | S4→S8（Quick Loop 首进 Code） | loop 初始化为 1（不是 0，也不是 +1） |
| V35 | 机器块被人为改动（如删掉一条边 / 把 `(+1)` 改成 `(loop=0)`） | `check-protocol` 报 `PROTOCOL_DRIFT`，exit 3（**修饰符漂移也要被抓到**） |

**退出条件**：

1. V1–V35 全绿（含 3 个跨进程并发用例与 3 个跨平台路径用例；Windows 用例在 CI 上至少跑一次）；
2. `core check-protocol` 在 CI 中作为门禁通过（阻塞合并）；
3. LLM 可经 `cli.py` 手动调 Core 跑完一个真实任务（端到端冒烟），且**中断 3 天后恢复**成功（验证 artifact 生命周期与 freshness 降级）；
4. Skill 协议**语义**未被修改（Core 是叠加层）；本设计提出的协议侧增补（保留键、状态文件位置）作为独立交付项跟踪。

---

## 十一、未决问题

| # | 问题 | 结论 / 倾向 | 状态 |
|---|---|---|---|
| U6 | `loop_max` 是否按 Level 区分？ | **已定案**：`loop_max = 1 (L0/L1) / 3 (L2+)`，依据 `kernel.md` §7；manifest 仅 L2+ 缺省；三者由校验器断言一致 | ✅ 关闭（§3.3） |
| U7 | `exit_checklist` 的结构化格式？ | **已定案**：`ExitChecklist{stage, referenced_outputs[], checked_items[]}`；只校验"引用可解析"，不校验"引用得对" | ✅ 关闭（§3.2） |
| U8 | 是否需要只读状态查询方法？ | **已定案**：加 `get_state() -> StateView`，无 mutation | ✅ 关闭（§八） |
| U18 | `_schema` 升级时的自动迁移要不要做？ | 倾向 Phase 1 **不做**：只降级为只读 + 明确提示；迁移脚本留 Phase 4（迁移本身有数据风险，且当前 schema 只有 v1） | 🟡 待决策 |
| U19 | 状态文件加锁失败时是否允许"无锁快速写"？ | 倾向**不允许**：返回 `CHECKPOINT_WRITE_FAILED` 让 LLM 手动维护；无锁写会让并发问题变成静默数据损坏 | 🟡 待决策 |
| U20 | pinned artifact 的保留阈值（7 天）是否够？ | 倾向可配置（`.vibe-kernel/config.json` → `artifact_retention_days`），缺省 7；**但 GC 永不删被引用的文件**，阈值只影响未引用残留 | 🟡 待决策 |
