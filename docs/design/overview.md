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
  └─ Adapter: session.created → Core.loadCheckpoint(.state.md)
       ├─ fresh + 字段完整 → 恢复 {phase, current_step, completed}
       └─ 不满足 → Core 返回「全新开始」，Adapter 不注入历史

[用户输入] → Adapter 注入 STATIC 区（kernel/policy/rules，宿主 systemPrompt）
  └─ LLM S1 Intent → 输出目标三元组 + 任务分类
       └─ Adapter: turn_end → Core.transition(S1→S2) [校验出口清单 + 写 .state.md]

[LLM S2 Preflight] memory_list/get（经 memory_tool.py preflight）
  └─ Adapter: turn_end → Core.transition(S2→S4) [Complexity Gate 输出 Level]

[LLM S6 Design → S7 Plan → S8 Code]
  └─ 每个 turn_end → Core 写 .state.md（phase/loop/current_step/completed 追加）

[S8 Code 产出] LLM 调 Exec.run({cmd: "pytest", cwd, timeout})
  └─ Exec: 执行 → 归一化结果 {exit, stats, errors[], digest, bytes}
       └─ 超限 → Exec 外置到 artifact（reuse memory_tool.py artifact put）→ 返回 ref
  └─ Adapter: tool.execute.after → Exec.captureResult → Core.feedExec(result)

[S9 Test]
  └─ Exec 结果 → LLM 判定通过/失败
  └─ 失败 → Exec.fingerprint(result) → Core.repeatCheck(fp)
       ├─ 首次失败 → Core 返回 [PASS_NEW_FAILURE]，LLM 走 S8[N+1]
       ├─ 连续无变化 ≥2 → Core 返回 [NO_PROGRESS]（VC 码）→ 触发 Safe Mode
       └─ Loop>3 → Core 返回 [LOOP_BUDGET_EXHAUSTED] → 停止

[Compaction 发生]（宿主触发，非 Core）
  └─ Adapter: experimental.session.compacting → Core.snapshotTASKZone()
       └─ Core 返回 📌 TASK 区 13 字段 → Adapter push 进 compaction context
       └─ 保证压缩后 LLM 能从注入字段恢复（而非从历史对话回溯）

[中断 → 新会话恢复]
  └─ Adapter: session.created → Core.loadCheckpoint()
       ├─ status=active + fresh → 恢复 phase/current_step，completed 不重做
       ├─ pending 逐项核验（Exec.exists(file)/git status）→ 已落地移 completed
       └─ 与用户输入冲突 → 以用户输入为准（Core 不覆盖 TASK/ACTIVE）
```

### 失败时模块责任边界

| 失败类型 | 责任方 | 状态传递 |
|---|---|---|
| 命令执行失败（exit≠0） | Exec 归一化 + 指纹 | result → LLM 判定 → Core 记 review.last_failure |
| 环境错误（命令不存在/超时） | Exec 分类为 env_error | LLM 不消耗 Loop（同轮修正，VC `OUTPUT_LIMIT`/超时 `[next]`） |
| 状态非法跳转 | Core 拒绝转换 | 返回 VC `RULE_NOT_LOADED`/防跳过码 → LLM 回退 |
| Checkpoint 损坏 | Core 降级为「仅参考」 | 返回 stale → 以当前会话 + 用户输入为准 |
| 重复失败无进展 | Exec 指纹 + Core 计数 | 返回 `NO_PROGRESS` → LLM 进 Safe Mode |
| Adapter 加载失败 | Adapter 降级 | 回退到「LLM 手动驱动协议」（现有工作流，保持可用） |

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
| 语言 | **Python**（Core/Exec）+ **TypeScript**（Adapter） | Core/Exec 复用现有 memory_tool.py（Python 标准库，零依赖）；Adapter 必须用宿主插件语言（OpenCode=TS，Pi=TS） |
| 依赖 | Core/Exec **零第三方依赖**（仅标准库）；Adapter 仅 `@opencode-ai/plugin` | 现有 memory_tool.py 即零依赖标准库；不引入 DB/队列/常驻服务 |
| 存储 | **YAML 单文件 `.state.md`**（沿用）+ 复用 memory_tool.py artifact 目录 | 现有协议即 YAML 单文件；不引入 SQLite（评估见 MVP-1 §存储） |
| 运行 | 本地进程内（Core/Exec 作为 CLI 或被宿主插件 import）；无常驻服务 | 轻量、可调试、可回滚 |
| 测试 | Python `unittest`（沿用 test_memory_tool.py 风格）+ Adapter 用小场景脚本 | 现有测试范式 |

### 三个不（明确排除）

1. **不把 Core/Exec 包装为 MCP**：它们是确定性本地能力，CLI/import 即可；MCP 用于跨进程外部资源（delx-memory 是 MCP 因为它有独立服务进程）。
2. **不引入数据库**：`.state.md` YAML 单文件 + artifact 目录足以承载任务状态；任务状态是单实例、低频写、低并发。
3. **不在 Core 依赖宿主类型**：Core 不 import OpenCode/Pi 的任何类型；Adapter 消化宿主差异。

---

## 六、演进路线与分阶段交付

```text
Phase 0（现状）: LLM 驱动协议，memory_tool.py 提供记忆工具
   │
Phase 1（MVP-1）: Core 可执行化 —— 状态机/Checkpoint/恢复代码化
   │   退出条件: 状态转换/恢复协议 100% 单元测试覆盖；LLM 可经 CLI 调用 Core
   │   Skill 仍可独立使用（LLM 不调 Core 时按协议手动跑，不破坏）
   ▼
Phase 2（MVP-2）: Exec 可执行化 —— 执行/归一化/Diff/指纹代码化
   │   退出条件: 场景测试覆盖（通过/失败/超时/命令不存在/输出过大/重复失败）
   │   Exec 可独立 CLI 调用（LLM 经 bash 调 exec run/summarize-diff）
   ▼
Phase 3（MVP-3）: OpenCode Adapter —— 宿主事件桥接
   │   退出条件: 基线 vs 实验数据对比（中断恢复成功率/重复测试数/无效调用/token）
   │   Adapter 可降级（插件加载失败 → 回退 Phase 1/2 的 LLM 手动驱动）
   ▼
Phase 4（未来）: Pi Adapter —— 复用 Core/Exec + 统一协议
       按实际 Pi 使用验证后补，不在本设计预抽象
```

**每个阶段保持「Skill 可独立使用」**：Core/Exec/Adapter 都是**叠加层**，不修改 Skill 的协议文件语义；LLM 即使完全不调用它们，仍可按现有 `transition.md`/`state-machine.md` 手动驱动工作流。这是降级与回退的根本保障。

---

## 七、评审自检（对照任务第九节）

| 维度 | 结论 |
|---|---|
| 真实复用现有 Skill | ✅ Core 直接取 `transition.md` 转换表 + `.state.md` 13 字段；不发明新工作流 |
| Core 与 OpenCode 解耦 | ✅ Core 零宿主依赖；Adapter 单向依赖 Core 协议端口 |
| 为 Pi 留最小接口 | ✅ host-agnostic port 5 方法；Pi Adapter 只需实现同 5 方法，事件映射在 Adapter 内消化 |
| 控制依赖/进程/内存/token | ✅ 零第三方依赖、无常驻服务、artifact 外置控 token、Exec 输出有界 |
| 可测试验证 | ✅ 状态转换/Checkpoint/恢复 = 单元测试；执行场景 = 集成测试；Adapter = 基线对比 |
| 不重复宿主能力 | ✅ Compaction 归宿主，Core 只注入 TASK 区；不实现对话压缩 |
| 无过度设计 | ✅ 接口由 3 MVP 真实需求驱动；Pi 具体映射留 Phase 4 |
| 分阶段交付 + 退出条件 | ✅ 每 Phase 有明确退出条件与可独立验收交付物 |

---

## 八、已确认的关键设计决策

1. **Core 只管状态，不管判断**：架构/审查/下一步动作归 LLM；Core 不自行决定 review 结论（`transition.md` S10 判定表是 LLM 读的协议，Core 只强制「判定后才能转」）。
2. **沿用 `.state.md` 13 字段，不新造数据结构**：Task/Stage/Checkpoint 概念直接映射现有字段；新增字段需协议变更（走 skill-iteration 流程）。
3. **状态机转换表取自 `transition.md`，不改语义**：Core 的合法转换表是该文件的程序化镜像，冲突时以文件为准（同 `manifest.yaml` 的 `levels.stages` 关系）。
4. **Exec 复用 memory_tool.py artifact 子系统**：`artifact put/page` 已验证输出外置 + 分页取用 + 投影过滤 + 字节上限；Exec 的大结果走它，不另造。
5. **Compaction 归宿主，Core 只提供 TASK 快照**：严守 `state-machine.md`「压缩归 Runtime」边界；Adapter 在 `experimental.session.compacting` 钩子注入 Core 返回的 TASK 区。
6. **Adapter 降级路径 = 现有 LLM 手动驱动协议**：插件失败/配置缺失 → 回退 Phase 0，Skill 照常可用。

---

## 九、未决问题与风险（需用户决策）

| # | 问题 | 选项 | 当前倾向 |
|---|---|---|---|
| U1 | Core 与 Skill 的版本耦合：Core 读 `.state.md` 13 字段，若 Skill 协议演进增字段，Core 如何同步？ | A. Core 声明 schema 版本号，字段缺失即降级；B. Core 与 manifest.yaml 版本绑定 | A（容错优先，与 memory_tool.py `check_keys` 的 fail-closed 哲学一致） |
| U2 | Core 是否暴露为 OpenCode 自定义工具（LLM 主动调）还是纯事件驱动（LLM 无感）？ | A. 事件驱动为主 + 工具兜底；B. 纯工具（LLM 显式调）；C. 纯事件 | A（事件驱动保证「LLM 漂移也不漏写 checkpoint」；工具兜底供 LLM 主动查询状态） |
| U3 | `.state.md` 当前是单实例单文件；多任务/多 worktree 如何承载？ | A. 维持单任务，多任务各自独立 `.state.md`（按 cwd/worktree 隔离）；B. 引入 task_id 多文件 | A（现有协议即单实例；多任务留 Phase 4） |
| U4 | Exec 的 Diff 汇总是否依赖 git？非 git 项目如何处理？ | A. git 优先，非 git 降级为「文件存在性 + mtime 对比」；B. 强依赖 git | A（与 `state-machine.md` pending 核验的「最低成本命令」一致） |
| U5 | MVP-3 基线数据如何采集？当前无 instrumentation | A. 先加日志埋点（memory_tool.py metrics 已有 dashboard 框架，可复用）；B. 人工统计 | A（复用现有 dashboard） |

---

## 十、现有架构问题与迁移风险

1. **历史路径描述陈旧**（迁移遗留）：旧文档中的历史路径指针已统一指向 `kernel/Vibe Coder.md`。本次设计文档**不改 Skill 内容**，留待后续 skill-iteration 统一更新。
2. **`<pi-agent-config>/AGENTS.md` 未统一**（迁移遗留）：Pi 全局 Prompt 是常规文件，与 `Vibe Coder.md` 内容不同；其「本仓库源」措辞陈旧。Phase 4 Pi Adapter 时需一并决策是否统一进项目。
3. **会话内压缩契约 E2/E3 未真机观测**：`state-machine.md` 自述该维度「未经真机观测」。MVP-3 Adapter 的 compaction 注入恰好**提供首次真机验证机会**——注入后观测 LLM 能否恢复 TASK 区，据实补 E4 证据（呼应 `references/e4-matrix.md` D-3 现场采集卡）。
4. **memory_tool.py 位于 `backup/` 目录**：命名 `backup/` 但实为确定性工具层（`manifest.yaml` `architecture.tools` 已正名）。Core/Exec 复用它时不引入新路径，沿用 `$HOME/.agents/skills/vibe-coder-loop/backup/memory_tool.py`（经重指软链解析到本项目）。
5. **单文件 `.state.md` 无并发保护**：当前 LLM 串行写无问题；Core 化后若 Adapter 事件 + LLM 工具并发写需原子化（`.state.md.tmp` + rename），MVP-1 §存储会处理。
