# Vibe Kernel — 总体架构设计

> 范围：MVP-1（Workflow Core）/ MVP-2（Execution & Verification）/ MVP-3（OpenCode Adapter）的统一架构、模块边界、协作流程与演进路线。
> 调研依据截至 2026-10-19，结论分四档：**[已验证]**（有代码/配置/测试依据）/ **[未充分验证]**（有实现但缺验证）/ **[尚不存在]**（无对应实现）/ **[待验证/待决策]**（证据不足或多方案）。

---

## 一、最关键事实：现有工作流是「协议」，不是「代码」

理解本设计的前提——**当前 `vibe-coder-loop` 的工程流程几乎全部以 Markdown 协议形式存在，由 LLM 自觉遵循，而非由确定性代码驱动**。

| 能力 | 现状 | 证据 |
|---|---|---|
| 状态机 S0–S14 | **[已验证] 协议** | `engine/state-machine.md` + `engine/transition.md` 完整定义合法转换、异常路径（Retry/Rollback/Pause/Safe Mode）、循环计数规则、角色约束 |
| `.state.md` Checkpoint | **[已验证] 协议 + 实例** | `engine/state-machine.md`「Workflow Checkpoint」节定义 13 字段 + 写入纪律 + 恢复协议；公共模板为 `.state.template.md`；本地实例不随仓库发布 |
| 上下文分区 STATIC/TASK/ACTIVE/HISTORY | **[已验证] 协议** | `state-machine.md`「压缩后状态延续契约」；**[未充分验证]** 会话内压缩维度 E2/E3（文档自述「未经真机观测」） |
| VC 错误码族 | **[已验证] 协议** | `transition.md`「VC 错误码族」——RULE_NOT_LOADED/PLAN_DRIFT/NO_PROGRESS/LOOP_BUDGET_EXHAUSTED/OUTPUT_LIMIT 等，带 `[next]` 自纠信号 |
| 确定性记忆工具 | **[已验证] 代码** | `backup/memory_tool.py`：`touch`/`metrics`/`preflight`/`artifact put\|page\|list\|release`/`backup`/`restore`/`verify`/`check_keys`；含 `test_memory_tool.py`（49KB 测试） |
| 自动状态机执行 | **[尚不存在]** | 无任何代码读取/校验/驱动 S0–S14 转换；LLM 按 `transition.md` 出口清单自检 |
| 自动 Checkpoint 写入 | **[尚不存在]** | `.state.md` 由 LLM 在阶段出口手动追加；无宿主事件触发 |
| 自动跨会话恢复 | **[尚不存在]** | 恢复协议（freshness/字段完整/pending 核验）由 LLM 在 S1 读取时执行 |
| 通用执行器/Diff 汇总/重复失败检测 | **[尚不存在]** | `artifact` 子系统做结果外置（put/page），但无测试运行、Diff 解析、失败指纹 |
| 宿主事件 → Core 桥接 | **[尚不存在]** | OpenCode/Pi 宿主事件与 `.state.md` 无任何代码连接 |

> **设计含义**：三个 MVP 的本质不是「发明新工作流」，而是**把已验证的协议包进确定性代码**——让状态机从「LLM 自觉遵循」升级为「代码强制」，让 Checkpoint 从「手动追加」升级为「宿主事件触发自动写」，让恢复从「LLM 读协议执行」升级为「代码机械执行」。这是降低 LLM 漂移、减少重复 token 消耗、提升中断恢复可靠性的唯一杠杆。

---

## 二、模块边界

```
┌─────────────────────────────────────────────────────────┐
│  宿主 (Host): OpenCode / Pi                              │
│  ─ 会话 / 上下文窗口 / Compaction / 工具调用 / 事件总线  │
└───────────────▲───────────────────────▲─────────────────┘
                │ events                │ tools/calls
        ┌───────┴────────┐      ┌───────┴────────┐
        │  MVP-3 Adapter │      │  MVP-2 Exec    │
        │  (宿主适配)     │      │  (执行/验证)   │
        │  事件→协议映射  │      │  命令执行      │
        │  协议→宿主注入  │      │  结果归一化    │
        └───────┬────────┘      │  Diff 汇总    │
                │               │  失败指纹     │
                ▼               └───────┬────────┘
        ┌───────────────────────────────▼────────────────┐
        │  MVP-1 Workflow Core                             │
        │  ─ 任务状态机（S0–S14 强制转换）                 │
        │  ─ Checkpoint 读写（.state.md 原子化）           │
        │  ─ 恢复协议（freshness/完整性/pending 核验）     │
        │  ─ VC 错误码的程序化判定与返回                   │
        └───────────────────────▲────────────────────────┘
                                │ references (read-only, 不改语义)
        ┌───────────────────────┴────────────────────────┐
        │  vibe-coder-loop Skill (协议层, 唯一方法论事实源) │
        │  ─ state-machine / transition / complexity-gate  │
        │  ─ policy/safety / kernel / rules                │
        │  ─ memory_tool.py (确定性记忆工具, 复用)         │
        └──────────────────────────────────────────────────┘
```

### 四个职责层（严格区分，不可混淆）

| 层 | 是什么 | 决定什么 | 不决定什么 |
|---|---|---|---|
| **Skill**（vibe-coder-loop） | 工程方法论协议（Markdown） | 阶段目标、判断规则、Agent 行为、出口清单、安全约束 | 运行时状态如何存储/驱动 |
| **Core**（MVP-1） | 任务状态管理代码 | 合法转换校验、Checkpoint 读写、恢复机械执行、VC 码判定 | 架构方案、代码审查结论、下一步做什么 |
| **Exec**（MVP-2） | 本地执行能力代码 | 命令执行、结果归一化、Diff 汇总、失败指纹 | 是否继续修复、修复策略 |
| **Adapter**（MVP-3） | 宿主事件桥接代码 | 事件→协议映射、协议→宿主注入、自定义工具暴露 | 工程流程本身（不重实现 Skill） |

**判定原则**：「需要判断的」交给 LLM（架构设计、审查结论、失败根因、下一步动作）；「可机械判定的」交给代码（状态合法性、字段完整性、命令退出码、文件存在性、时间戳新鲜度）。

### 与现有边界的关系（不新增机制，只显式化）

现有协议已声明这些边界，Core 只是**给协议配上执行体**：
- `state-machine.md`「执行者边界」：Context 管理归宿主，Agent 只管「压缩后继续 Workflow」——Core 把「继续 Workflow」可执行化。
- `transition.md` VC 错误码「不带 `[next]` 不构成错误码」——Core 把 `[next]` 变成程序返回值。
- `state-machine.md`「防跳过规则」——Core 把「无法引用上一阶段输出」变成转换拒绝。
- `delx-memory-protocol`「Memory ≠ Context」——Core 恪守：状态进 `.state.md`，经验进 Memory，二者不串。

---

## 三、端到端协作流程

### 典型任务全流程（含中断恢复）

```text
[OpenCode 会话启动]
  └─ Adapter: event("session.created") → Core.load_checkpoint(项目本地状态文件)
       ├─ resume / resume_degraded → 置「待注入恢复」标记
       ├─ stale / corrupt / foreign → 标记降级原因（不注入历史）
       └─ 注入发生在下一次 LLM 请求：chat.system.transform(output.system.push TASK 区)
            → 第 3 档验证：LLM 首条输出复述 phase/current_step 并续跑

[用户输入]（STATIC 区由 Skill 机制加载，Adapter 不重复注入）
  └─ LLM S1 Intent → 输出目标三元组 + 任务分类
       └─ LLM 调 vc_transition(S1→S2) + exit_checklist [Core 校验 + 原子写 + rev+1]

[LLM S2 Preflight] memory_list/get（经 memory_tool.py preflight）
  └─ LLM 调 vc_transition(S2→S4) [Complexity Gate 输出 Level]

[LLM S6 Design → S7 Plan → S8 Code]
  └─ 每个阶段出口 → vc_transition 写 phase/loop/current_step/completed（追加式）

[S8 Code 产出] LLM 调 vc_exec({cmd, cwd, timeout})
  └─ Exec: Popen 流式采集（内存有界）→ 归一化 {exit, stats, errors[], digest}
       └─ 超限 → 落盘 + artifact put + **回读校验** → 返回 ref（失败则不返回 ref）
  └─ Adapter: tool.execute.after（独立 Hook）→ Core.feed_exec(记账 + 指纹素材)
  └─ LLM 精度需要时重跑：vc_exec（精确结果）

[S9 Test]
  └─ Exec 结果 → LLM 判定通过/失败
  └─ 失败 → fingerprint(sha256, 规范 JSON) → Core.repeat_check(fp)
       ├─ 首次失败 → LLM 走 S8[N+1]
       ├─ 连续 2 次同指纹（计数持久化在状态文件）→ [NO_PROGRESS] → S14
       └─ loop > loop_max(level) → [LOOP_BUDGET_EXHAUSTED] → 停止

[Compaction 发生]（宿主触发，非 Core）
  └─ Adapter: experimental.session.compacting → snapshot_task_zone() → output.context.push
       + experimental.compaction.autocontinue(enabled=true) → 压缩后自动续跑
       └─ 保证压缩后 LLM 按 TASK 区继续（第 2 档验证：首条输出仍带 [Phase][Loop]）

[中断 → 新会话恢复]
  └─ load_checkpoint: active+fresh → 恢复 phase/current_step，completed 不重做
       ├─ pending 三态核验（verified / unverified / still_pending）→ 仅 verified 移 completed
       ├─ artifact 引用校验（失效不阻断，附 regen 提示）
       └─ 与用户输入冲突 → 以用户输入为准（Core 不覆盖 TASK/ACTIVE）
```

### 失败时模块责任边界

| 失败类型 | 责任方 | 状态传递 |
|---|---|---|
| 命令执行失败（exit≠0） | Exec 归一化 + 指纹 | result → LLM 判定 → Core 记 `review.last_failure` |
| 环境错误（命令不存在/超时/取消） | Exec 分类，**不进指纹计数** | 不消耗 Loop（同轮修正） |
| 状态非法跳转 | Core 拒绝转换 | `STATE_ILLEGAL_TRANSITION` → LLM 回退 |
| 并发写冲突 | Core 版本校验 | `STATE_REV_CONFLICT` → 重读后重放 |
| Checkpoint 损坏/降级 | Core 降级为「仅参考」 | `CHECKPOINT_CORRUPT`/`CHECKPOINT_DEGRADED` → 以用户输入为准 |
| 重复失败无进展 | Exec 指纹 + Core 持久化计数 | `NO_PROGRESS` → S14 |
| Adapter 能力不可用 | Adapter 分层降级 | L2/L3 可见提示 + 本地日志；Skill 照常可用 |
| 阶段转换被遗漏 | Adapter 检测（不自动转） | `PHASE_TRANSITION_MISSING` 提醒 |

---

## 四、依赖关系与开发顺序

```text
MVP-1 Workflow Core  ────────►  MVP-3 OpenCode Adapter
        │   ▲                              │
        │   └──── 协议端口（host-agnostic）─┘
        ▼
MVP-2 Execution & Verification
```

| 顺序 | MVP | 依赖 | 可独立验收交付物 |
|---|---|---|---|
| 1 | **MVP-1 Core** | 仅依赖 `.state.md` 协议 + 现有 memory_tool.py（可独立于宿主测试） | 状态转换库 + Checkpoint 读写 + 恢复协议的可执行实现 + 单元测试 |
| 2 | **MVP-2 Exec** | 复用 memory_tool.py artifact 子系统；可独立于 Core 测试（结果归一化/Diff 是纯函数） | 执行器 + 归一化器 + Diff 汇总 + 失败指纹 + 场景测试 |
| 3 | **MVP-3 Adapter** | 依赖 Core 协议端口 + Exec 结果格式 | OpenCode 插件 + 事件映射 + 自定义工具 + 基线/实验对比 |

**MVP-1 与 MVP-2 可并行**：Exec 的归一化/Diff/指纹是纯函数，不依赖 Core；只有「Exec 结果喂给 Core 做重复检测」这一接缝需要 Core 的接口稳定。建议先锁 Core 的 `feedExec`/`repeatCheck` 接口签名，再让 Exec 独立开发。

**MVP-3 必须最后**：Adapter 是薄层，依赖 Core 与 Exec 的接口冻结。但在 MVP-1/2 开发期间，可用「LLM 手动调用 Core/Exec CLI」的方式先验证 Core/Exec 本身，不阻塞。

### 必须在 MVP-1 锁定的协议（后续不可轻易变）

1. **任务状态数据结构**（`.state.md` 13 字段的程序化契约——字段名、类型、必需性）
2. **状态转换合法性表**（S0–S14 的合法后继，直接取自 `transition.md`，不改语义）
3. **Checkpoint 文件格式与原子写入契约**（沿用 YAML 单文件 + 原子替换）
4. **恢复协议的机械判定规则**（freshness 阈值、字段完整性校验、pending 核验动作集）
5. **Core 对外接口形状**（host-agnostic port：loadCheckpoint/transition/snapshotTASKZone/feedExec/repeatCheck）

### 可留到后续的

- Token 预算计算（明确归 Runtime，Core 不碰）
- 具体 Diff 输出格式（MVP-2 内部，不影响 Core）
- Pi Adapter 的具体事件映射（MVP-3 落地后再针对 Pi 补，不在 MVP-1 预抽象）
- 多任务并发（当前单任务单 `.state.md`，多任务留后续）

---

## 五、技术选型与约束

| 维度 | 选型 | 依据 |
|---|---|---|
| 语言 | **Python**（Core/Exec）+ **TypeScript**（Adapter） | Core/Exec 复用现有 memory_tool.py（Python 标准库，零依赖）；Adapter 必须用宿主插件语言 |
| 依赖 | Core/Exec **零第三方依赖**（仅标准库）；Adapter 需 `@opencode-ai/plugin`（**运行时**，含 `tool()`） | YAML 用**受限子集自研解析器**而非 pyyaml（保持零依赖）；Adapter 依赖由宿主 bun 安装 |
| 存储 | **状态**：`<project_root>/.vibe-kernel/.state.md`（YAML 子集，项目本地）+ **产物**：`ephemeral`(memory_tool artifact, 24h) / `pinned`(`.vibe-kernel/artifacts/`) | 状态是**项目私有数据**，不放 Skill 安装目录；产物按恢复周期分层 |
| 运行 | 本地进程内（Core/Exec 作为 CLI 被 Adapter 调用）；无常驻服务 | 轻量、可调试、可回滚 |
| 并发 | 文件锁 + **乐观版本号**（`_rev` + `expected_rev`） | 锁只保证串行，版本号才防"基于旧状态覆盖" |
| 测试 | Python `unittest` + **协议一致性测试**（代码表 ↔ Skill 事实源）+ Adapter Hook 契约测试 | 副本必须被机械校验，不只被信任 |

### 三个不（明确排除）

1. **不把 Core/Exec 包装为 MCP**：它们是确定性本地能力，CLI 即可；MCP 用于跨进程外部资源。
2. **不引入数据库**：YAML 子集 + 目录足以承载任务状态与产物。
3. **不在 Core 依赖宿主类型**：Core 不 import OpenCode 任何类型；Adapter 消化宿主差异。

### 版本与向后兼容（统一规则）

| 项 | 规则 |
|---|---|
| 状态文件协议版本 | 顶层真实键 `_schema: 1`（**不是注释**）；高版本 → Core 只读不写 + `CHECKPOINT_SCHEMA_AHEAD` |
| 13 字段 | 语义字段集固定；保留键 `_schema`/`_rev`/`_project_id` 与保留子键 `review.failure_state` **不计入** |
| 未知字段 | 读写往返**必须原样保留**（Skill 先增字段、Core 后升级不互相破坏） |
| 错误码 | 两族分离：**协议码**（`transition.md` 已有，语义不改） vs **运行时扩展码**（`STATE_*`/`CHECKPOINT_*`，输出带 `[runtime]` 标识） |
| CLI 契约 | 单行 JSON + exit code 语义（0/3/4）；大入参走 `--*-file` |

---

## 六、演进路线与分阶段交付

```text
Phase 0（现状）: LLM 驱动协议，memory_tool.py 提供记忆工具
   │
Phase 0.5（设计收敛, 前置门禁）: 不写业务代码，只把契约钉死
   │   退出条件（六项全绿，缺一不进 Phase 1）:
   │   ① 状态文件位置与隔离规则（项目本地 + project_id + 锁/版本）
   │   ② 状态文件语法与解析方案（受限 YAML 子集 + 三层降级 + 渲染幂等）
   │   ③ 跨平台原子写与并发冲突处理（锁 + expected_rev + 合并策略）
   │   ④ 状态转换表/Loop 规则/复杂度表的单一事实源与校验机制
   │   ⑤ Exec 结果结构（流式 + 有界 + 整树终止 + 指纹规范化输入）
   │   ⑥ OpenCode Hook 最小验证（用本机 typings 跑通 tool.execute.after /
   │      session.compacting / chat.system.transform 三个钩子，确认入参出参）
   ▼
Phase 1（MVP-1）: Core 可执行化 —— 只做最小闭环
   │   范围: StateResolver + 原子写/rev + 合法转换 + Loop 守卫 + 恢复(三态 pending) + 最小码集
   │   明确不做: Safe Mode 统计型触发、schema 自动迁移、多任务
   │   退出条件: V1–V29 全绿 + check-protocol 进 CI + 真实任务中断 3 天后恢复成功
   ▼
Phase 2（MVP-2）: Exec 可执行化 —— 先执行器，后归一化
   │   顺序: 流式执行/整树终止/输出有界 → 指纹 → 归一化 → Diff → artifact 生命周期
   │   退出条件: E1–E16 全绿（E3b/E5/E5c/E14b 必测）+ 大输出内存不增长
   ▼
Phase 3（MVP-3）: OpenCode Adapter —— 先验证链路，后补功能
   │   顺序: 最小插件验证三类钩子 → 新会话恢复(A1–A3) → 压缩恢复(B1–B3)
   │         → 工具集 → 降级分层 → 基线对比
   │   退出条件: A1–A22 全绿（A3/A12/A14/A17/A19 必测）
   ▼
Phase 4（未来）: Pi Adapter —— 复用 Core/Exec + 统一协议
        按实际 Pi 使用验证后补，不在本设计预抽象
```

**每个阶段保持「Skill 可独立使用」**：Core/Exec/Adapter 都是**叠加层**，不修改 Skill 的协议语义；LLM 即使完全不调用它们，仍可按现有 `transition.md`/`state-machine.md` 手动驱动工作流。这是降级与回退的根本保障。

### Phase 0.5 的协议侧交付项（已落地，与代码同步）

设计收敛不只是改这份设计文档，还包括三处 **Skill 侧最小增补**（不改变方法论，只补机器可读性）。**本轮已完成**：

| 项 | 文件 | 已增补内容 |
|---|---|---|
| 保留键 + 位置 + 语法 | `engine/state-machine.md`「Workflow Checkpoint」 | 状态文件改 `<project_root>/.vibe-kernel/.state.md` + 解析顺序 + 隔离规则；保留键 `_schema`/`_rev`/`_project_id`/`_resume_from` + 保留子键 `review.failure_state`；未知键透传；YAML 子集语法与三层降级；原子写与 `expected_rev`；pending 三态核验 |
| 机器可读转换块 | `engine/transition.md`「机器可读转移表」 | `<!-- vc:transitions v1 -->` 块（含 `(+1)`/`(loop=0)`/`(loop=1)`/`(resume)` 修饰符），供 `check-protocol` 逐边 + 修饰符比对 |
| 运行时码登记 | `engine/transition.md`「VC 错误码族」 | 登记 12 个 `[runtime]` 扩展码，明确「不属于工作流判定、不改上表语义」 |
| 模板 | `.state.template.md` | 新增 `_schema: 1`；注释说明项目本地路径、保留键、字符串引号纪律 |
| 其他 | `SKILL.md` 加载时机索引 / `load_plan.json` `_core_note` | 指向项目本地路径，避免回到 Skill 目录的旧口径 |

> **不算完成的**：`check-protocol` 与 `core state check` 尚未实现，因此当前只是「契约已就位、门禁未上线」。Phase 1 必须把校验器写出来并接入 CI，否则机器块仍会漂移。

---

## 七、评审自检（对照任务第九节）

| 维度 | 结论 |
|---|---|
| 真实复用现有 Skill | ✅ Core 直接取 `transition.md` 转换表 + `.state.md` 13 字段；不发明新工作流 |
| Core 与 OpenCode 解耦 | ✅ Core 零宿主依赖；Adapter 单向依赖 Core 协议端口 |
| 为 Pi 留最小接口 | ✅ host-agnostic port 6 方法；Pi Adapter 只需实现同 6 方法，事件映射在 Adapter 内消化 |
| 控制依赖/进程/内存/token | ✅ 零第三方依赖、无常驻服务、artifact 外置控 token、Exec 输出有界 |
| 可测试验证 | ✅ 状态转换/Checkpoint/恢复 = 单元测试；执行场景 = 集成测试；Adapter = 基线对比 |
| 不重复宿主能力 | ✅ Compaction 归宿主，Core 只注入 TASK 区；不实现对话压缩 |
| 无过度设计 | ✅ 接口由 3 MVP 真实需求驱动；Pi 具体映射留 Phase 4 |
| 分阶段交付 + 退出条件 | ✅ 每 Phase 有明确退出条件与可独立验收交付物 |

---

## 八、已确认的关键设计决策

1. **Core 只管状态，不管判断**：架构/审查/下一步动作归 LLM；Core 不自行决定 review 结论。
2. **沿用 13 字段语义，不新造数据结构**；保留键（`_schema`/`_rev`/`_project_id`）与保留子键（`review.failure_state`）不计入 13 字段，未知键必须透传。
3. **状态机转换表取自 `transition.md`，且必须被校验**：副本不许裸信——`check-protocol` 逐边比对进 CI 门禁（这是对"镜像必漂移"的唯一有效对策）。
4. **状态文件放项目本地，不放 Skill 安装目录**：`<project_root>/.vibe-kernel/.state.md` + 项目身份校验 + 锁 + 乐观版本号；落在 Skill 目录内直接拒绝（fail-closed）。
5. **YAML 只支持受限子集**：零依赖自研解析器 + 三层降级（严格 / 仅扁平标量 / 损坏）+ 规范渲染幂等；不用 pyyaml，也不假装标准库能解析 YAML。
6. **Exec 的输出限制发生在读取过程中**：Popen + 有界 Sink + 落盘；不用 `capture_output=True` 事后限流；超时/取消走**整进程树**终止。
7. **失败指纹必须是稳定摘要 + 持久化连续计数**：`sha256` 规范 JSON（不含 `stage`）；`last_fingerprint + consecutive_count` 存入状态文件；集合包含判断不能表达"连续"。
8. **复用 memory_tool.py artifact，但分两层生命周期**：`ephemeral`（24h 缓存，允许过期）/ `pinned`（项目内，Checkpoint 引用期间不删）；GC 永不删被引用的产物。
9. **阶段转换由 LLM 显式驱动，Adapter 只自动捕获运行事实**：`exit_checklist` 无法从事件推导；漏调时给 `PHASE_TRANSITION_MISSING` 提醒，**不替 LLM 转阶段**。
10. **新会话恢复与压缩恢复是两条链路**：前者靠 `chat.system.transform`，后者靠 `session.compacting` + `autocontinue`；两者的验收档位都是"LLM 行为"，不是"Core 读了文件"。
11. **Adapter 降级分层且可见**：L1–L4 逐级；L3 仍保留 `tool.execute.before` 安全拦截；诊断日志不依赖 Core。

---

## 九、未决问题与风险（按是否阻塞实现分诊）

### 9.1 阻塞实现（Phase 0.5 前必须定）

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| U1 | Core 与 Skill 的版本耦合 | **已定案**：`_schema` 真实键 + 未知键透传 + 高版本只读降级 | ✅ 关闭 |
| U2 | Core 暴露为工具还是纯事件驱动 | **已定案**：事件/Hook 捕获运行事实；**转换必须 LLM 显式调工具**（混合，且明确边界） | ✅ 关闭 |
| U3 | 单实例状态文件 / 多 worktree | **已定案**：按项目根隔离 + `_project_id`；worktree 优先 `ctx.worktree`；多任务并行留 Phase 4 | ✅ 关闭 |
| U6 | `loop_max` 是否按 Level 区分 | **已定案**：L0/L1=1，L2+=3（`kernel.md` §7），manifest 仅 L2+ 缺省 | ✅ 关闭 |

### 9.2 可暂缓（有明确缺省，不阻塞开工）

| # | 问题 | 缺省 | 何时再定 |
|---|---|---|---|
| U4 | Diff 是否依赖 git | git 优先，非 git 走**显式基线快照** | Phase 2 实现时按真实项目验证 |
| U5 | 基线数据采集方式 | 先落本地日志，可汇总时进 metrics | Phase 3 开工前 |
| U7 | `exit_checklist` 结构化格式 | `{stage, referenced_outputs[], checked_items[]}` | Phase 1 实现时微调 |
| U8 | 只读状态查询 | 加 `get_state()` | 已随接口确定 |
| U9 | 指纹历史存哪 | `review.failure_state` | 已定案 |
| U10 | artifact 调用方式 | subprocess CLI | 已定案 |
| U11 | 归一化器可配置 | 不做配置层，`unknown` 降级 | 有第二例需求再说 |
| U12 | Diff `base` | 缺省 `HEAD`，可覆盖 | 已定案 |
| U13–U15 | idle 语义 / STATIC 注入 / after-hook 输出 | 均已用类型定义定案 | 已关闭 |
| U17 | CLI 输出格式 | 单行 JSON + exit code 语义 | 已定案 |
| U21–U23 | 高危清单归属 / 脱敏误伤 / pin 策略 | 见 MVP-2 §十 | Phase 2 实现前 |
| U25 | 注入频率 | 首次 full + 常态 pointer | Phase 3 实测 token 后 |

### 9.3 仅实验/待真机（不阻塞设计，但阻塞"宣称成功"）

| # | 问题 | 为何不能靠设计解决 |
|---|---|---|
| U16 | 与 advisor 插件的 handler 顺序 | 取决于宿主实现，必须实测（A22） |
| U24 | `experimental.*` API 稳定性 | 无稳定性承诺 → 只能能力探测 + 回归测试 |
| U26 | 同项目多会话并行 | 真实使用模式未知；当前 `_rev` 冲突显式失败是可接受的下限 |
| E2/E3 | 会话内压缩恢复是否真生效 | 协议自述"未经真机观测"；**必须由 A3/B2 冒烟证明**，否则只能写成"注入可用、行为未验证" |

---

## 十、现有架构问题与迁移风险

1. **历史路径描述陈旧**（迁移遗留）：旧文档中的历史路径指针已统一指向 `kernel/Vibe Coder.md`。本设计**不改 Skill 内容**，留待 Phase 0.5 的三项最小增补（§六末）。
2. **`<pi-agent-config>/AGENTS.md` 未统一**（迁移遗留）：Phase 4 Pi Adapter 时一并决策。
3. **会话内压缩契约 E2/E3 未真机观测**：MVP-3 提供首次真机验证机会，**但结论以 A3/B2 为准**；失败则如实降级结论，不宣称闭环。
4. **memory_tool.py 位于 `backup/` 目录**：命名 `backup/` 但实为确定性工具层。Core/Exec 复用它时**不硬编码路径**，按 `VIBE_KERNEL_HOME` → 项目相对 → `$HOME/.agents/skills/...` 顺序解析。
5. **并发写入**：状态文件从"LLM 串行写"变为"Adapter 事件 + LLM 工具并发" → 文件锁 + `expected_rev` 双保险（MVP-1 §4.2）。锁只解决串行，版本号才防覆盖。
6. **运行时状态误入 Skill 目录**（本次修正）：原设计把状态放 `$SKILL_DIR`，与"多项目隔离"直接冲突；改为项目本地并加"落在 Skill 目录内即拒绝"的对称校验。
7. **协议与代码双源漂移**（本次修正）：`LEGAL_TRANSITIONS`/`manifest.complexity` 是副本 → 必须有 `check-protocol` 门禁，否则"测试全绿、行为全错"。
