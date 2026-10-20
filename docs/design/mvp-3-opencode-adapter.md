# MVP-3 — OpenCode Adapter 设计

> 目标：把 OpenCode 宿主事件桥接到 Core/Exec，让状态机/Checkpoint/执行从「LLM 手动驱动」升级为「宿主事件自动驱动」。
> 原则：**Adapter 是薄层**——只做事件→协议映射 + 协议→宿主注入，不重实现 Skill 工作流；宿主类型不泄漏进 Core。
> 调研依据：OpenCode 官方插件文档（v1，2026-10-19 抓取）+ 本机 `opencode.json` 实际配置。

---

## 一、目标与非目标

### 目标
1. **事件→协议映射**：OpenCode 的 session/tool/command 事件映射到 Core 的 5 方法（loadCheckpoint/transition/snapshotTaskZone/feedExec/repeatCheck）。
2. **协议→宿主注入**：Core 的 TASK 区快照注入 OpenCode compaction context（`experimental.session.compacting` 钩子）。
3. **自定义工具暴露**：把 Core/Exec 的 CLI 能力暴露为 OpenCode 自定义工具，供 LLM 主动查询/触发（事件驱动为主 + 工具兜底）。
4. **降级兼容**：插件加载失败/配置缺失 → 回退 Phase 0（LLM 手动驱动协议，Skill 照常可用）。
5. **基线对比验证**：采集「中断恢复成功率/重复测试数/无效调用/token」数据，证明 Adapter 价值。

### 非目标
- 不实现对话压缩（归 OpenCode `compaction`；Adapter 只注入 TASK 区）。
- 不重实现 Skill 工作流（Adapter 不含 S0–S14 逻辑，全委托 Core）。
- 不绑定 OpenCode v2 特性（基于 v1 已验证事件；v2 适配留后续）。
- 不实现 Pi Adapter（Pi 事件映射留 Phase 4，本设计只给 host-agnostic port 对接证据）。
- 不修改 opencode.json 的现有配置（plugin 数组追加，不替换）。

---

## 二、现状与证据

### 已验证的 OpenCode 插件能力（官方文档，2026-10-19）

| 能力 | 证据 | Adapter 用途 |
|---|---|---|
| 插件 = `async (ctx) => ({hooks})` | 文档「Create a plugin」 | Adapter 工厂 |
| `ctx` 提供 `{project, client, $, directory, worktree}` | 文档 | 获取 cwd/worktree → Core 定位 `.state.md` |
| Session 事件：`session.created/compacted/deleted/diff/error/idle/status/updated` | 文档「Session Events」 | `session.created`→loadCheckpoint；`session.compacted`→重新注入 TASK；`session.idle`→可选 checkpoint 写 |
| Tool 事件：`tool.execute.before/after` | 文档「Tool Events」 | `tool.execute.after`→Exec 捕获结果→Core.feedExec |
| `experimental.session.compacting` 钩子（input, output） | 文档「Compaction hooks」 | 注入 Core.snapshotTaskZone() 到 output.context |
| 自定义工具 `tool({description, args(zod), execute})` | 文档「Custom tools」 | 暴露 `vc_state`/`vc_transition`/`vc_exec`/`vc_diff` |
| npm 依赖 `package.json` + `bun install` | 文档「Dependencies」 | Adapter 调 Core/Exec CLI（无 TS 重写） |
| 加载顺序：global config → project config → global plugins → project plugins | 文档「Load order」 | Adapter 放 `.opencode/plugins/`（项目级） |

### 本机配置（`~/.config/opencode/opencode.json`，已验证）

```jsonc
{
  "compaction": {"auto": true, "prune": true},   // 自动压缩 + 剪枝 → TASK 注入必要
  "mcp": {
    "delx-memory": {"type": "remote", "url": "http://127.0.0.1:3030/mcp"},  // 记忆 MCP（不动）
    "codegraph": {"type": "local", "command": ["codegraph","serve","--mcp"]}  // 代码图谱（不动）
  },
  "plugin": [["@kojoru/opencode-advisor", {...}]],  // 现有 advisor 插件（共存，不替换）
  "provider": { /* 自定义 provider + 大窗口模型 */ }
}
```

**关键**：`compaction.auto=true + prune=true`——OpenCode 会自动压缩并剪枝旧工具输出。这使 Core 的 TASK 区注入**非可选**（否则压缩后 LLM 丢失 `.state.md` 状态，恢复协议失效）。Adapter 的 compaction 钩子恰好填补此缺口。

### 尚不存在（Adapter 要新建）
- 任何 OpenCode 插件（当前 `plugin` 数组只有 advisor，无 Vibe Kernel 插件）。
- OpenCode 事件与 `.state.md` 的代码连接。
- compaction 钩子注入 TASK 区（现有 Skill 协议要求 LLM 手动输出 📌 TASK 区，无宿主自动注入）。

---

## 三、Adapter 架构

```text
┌─────────────── OpenCode 宿主 ───────────────┐
│  session.created  tool.execute.after        │
│  session.compacted  experimental.compacting │
│  event({type})  tool(args)  ctx{directory}  │
└───────▲──────────────────────────▲──────────┘
        │ OpenCode plugin hooks      │ custom tool calls
┌───────┴──────────────────────────┴──────────┐
│  vibe-kernel-adapter.ts (TypeScript)          │
│  ┌──────────────────────────────────────┐    │
│  │  EventMapper: OpenCode event →        │    │
│  │    Core method 调用（经 CLI subprocess） │    │
│  ├──────────────────────────────────────┤    │
│  │  ToolExposer: Core/Exec CLI →          │    │
│  │    OpenCode custom tool                │    │
│  ├──────────────────────────────────────┤    │
│  │  CompactionInjector: Core.snapshot →   │    │
│  │    output.context.push(TASK 区)        │    │
│  ├──────────────────────────────────────┤    │
│  │  FallbackGuard: 插件失败 → 静默回退   │    │
│  │    Phase 0（LLM 手动驱动）            │    │
│  └──────────────────────────────────────┘    │
└───────▲───────────────────────────────────────┘
        │ subprocess: python3 runtime/core/cli.py / runtime/exec/cli.py
┌───────┴───────────────────────────────────────┐
│  Core (MVP-1) / Exec (MVP-2) —— Python，零宿主依赖 │
│  Core 调 memory_tool.py（记忆回写，复用）          │
└────────────────────────────────────────────────┘
```

**核心约束（宿主类型不泄漏）**：Adapter 用 TypeScript 写，但 Core/Exec 是 Python。Adapter **不**把 OpenCode 的 `ctx`/event 类型传给 Core——Adapter 把它们翻译成 Core 的纯数据类参数（经 CLI JSON 入参/出参）。Core 永远不知道自己在 OpenCode 里跑。

---

## 四、事件→协议映射

### 4.1 映射表

| OpenCode 事件 | Adapter 行为 | Core 方法 | 说明 |
|---|---|---|---|
| `session.created` | 加载 checkpoint | `core.load_checkpoint()` | 新会话首动作；fresh→恢复，stale/corrupt→降级 |
| `session.idle` | 可选写 checkpoint | `core.transition(to=S13)` 或 no-op | **[待验证]** idle=响应完成还是会话结束？文档未明。倾向：idle=响应结束→不写（等待用户）；真正写 checkpoint 在 `tool.execute.after`（见下） |
| `tool.execute.after` | 捕获工具结果 | `core.feed_exec(result)` + `exec.captureResult` | LLM 调 bash/test 工具后，Adapter 抓 stdout/exit，喂 Core |
| `tool.execute.before` | 拦截危险操作 | （可选）`core.scope_check` | 映射 `policy/safety.md` 红线（删除/推送/部署）→ throw 阻断 |
| `experimental.session.compacting` | 注入 TASK 区 | `core.snapshot_task_zone()` → `output.context.push` | **核心**——压缩前注入 13 字段，保压缩后可恢复 |
| `session.compacted` | 重新注入 STATIC | （可选）重新拉 STATIC 区 | 压缩后 system prompt 可能被改，重注入规则 |
| `command.executed` | 记录 `/` 命令 | （可选）日志 | 用户执行 slash 命令时记账（未来仪表盘） |
| `event({type})` 通用 | 派发到上表 | — | 单一 `event` handler 内 switch type |

### 4.2 事件驱动 vs 工具兜底（对应 overview U2）

```text
事件驱动（主）：  OpenCode 事件 → Adapter → Core（LLM 无感，保证不漏写 checkpoint）
工具兜底（辅）：  LLM 显式调 vc_state/vc_transition 工具 → Core（LLM 主动查询/触发）
```

**为什么不能纯事件驱动**：LLM 的 `exit_checklist`（阶段产出 + 上一阶段引用）只能 LLM 产出，事件无法自动生成。`transition()` 需要 `exit_checklist` 参数——这部分 LLM 必须显式调 `vc_transition` 工具传入。

**为什么不能纯工具驱动**：LLM 漂移时会忘记调 `vc_transition`，导致 checkpoint 不写。`experimental.session.compacting` 必须由事件驱动（不依赖 LLM 自觉），否则压缩后状态丢失。

**分工**：
- 事件驱动：`load_checkpoint`（会话开始）、`snapshot_task_zone`（compaction）、`feed_exec`（工具结果捕获）——这些不需要 LLM 产出，可自动。
- 工具兜底：`vc_transition`（LLM 传 exit_checklist）、`vc_exec`（LLM 显式跑命令并归一化）、`vc_diff`（LLM 显式要 Diff）、`vc_state`（LLM 查当前状态）——这些需 LLM 决策。

### 4.3 关键事件伪代码

```typescript
// .opencode/plugins/vibe-kernel-adapter.ts
import type { Plugin } from "@opencode-ai/plugin"
import { execCore, execExec } from "./bridge"  // subprocess 调 Python CLI

export const VibeKernelAdapter: Plugin = async ({ directory, worktree }) => {
  const cwd = worktree || directory

  return {
    // 会话开始 → 加载 checkpoint
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const recovery = await execCore(["load-checkpoint", "--cwd", cwd])
        if (recovery.mode === "resume") {
          // 注入恢复提示（让 LLM 知道从哪续跑）
          // 注：OpenCode v1 无 systemPrompt 注入事件；经 compaction hook 或 message 注入
        }
      }
      if (event.type === "tool.execute.after") {
        const result = await execExec(["capture", JSON.stringify(event.properties)])
        await execCore(["feed-exec", "--result", result.ref, "--cwd", cwd])
      }
    },

    // 压缩前注入 TASK 区
    "experimental.session.compacting": async (input, output) => {
      const taskZone = await execCore(["snapshot-task-zone", "--cwd", cwd])
      output.context.push(`## 📌 TASK 区（Vibe Kernel Checkpoint）\n${taskZone.text}`)
    },

    // 自定义工具：LLM 主动调
    tool: {
      vc_transition: tool({
        description: "Vibe Kernel 状态转换。在阶段出口调用，传入 exit_checklist。",
        args: { to: tool.schema.string(), loop: tool.schema.number().optional(),
                exit_checklist: tool.schema.string() },
        async execute(args, ctx) {
          return await execCore(["transition", "--to", args.to,
            "--loop", String(args.loop ?? ""),
            "--exit-checklist", args.exit_checklist, "--cwd", cwd])
        },
      }),
      vc_exec: tool({
        description: "执行命令并归一化结果（经 MVP-2 Exec）。",
        args: { cmd: tool.schema.array(tool.schema.string()), timeout_ms: tool.schema.number().optional() },
        async execute(args, ctx) {
          return await execExec(["run", "--cmd", JSON.stringify(args.cmd),
            "--cwd", cwd, "--timeout", String(args.timeout_ms ?? 300000)])
        },
      }),
      vc_diff: tool({
        description: "生成 git diff 汇总（含 plan_drift 校验）。",
        args: { plan_files: tool.schema.array(tool.schema.string()).optional() },
        async execute(args, ctx) {
          return await execExec(["summarize-diff", "--cwd", cwd,
            "--plan-files", JSON.stringify(args.plan_files ?? [])])
        },
      }),
      vc_state: tool({
        description: "查询当前 .state.md 状态快照（只读）。",
        args: {},
        async execute(args, ctx) {
          return await execCore(["get-state", "--cwd", cwd])
        },
      }),
    },
  }
}
```

---

## 五、Compaction 注入设计（核心）

### 5.1 为什么 compaction 注入是 MVP-3 的核心

`state-machine.md`「压缩后状态延续契约」要求压缩后 LLM 能从注入的 📌 TASK 区恢复，而非从历史对话回溯。但当前：
- **[未充分验证]** 会话内压缩维度 E2/E3「未经真机观测」（state-machine.md 自述）。
- OpenCode `compaction.auto=true + prune=true` 会**自动**压缩并剪枝——LLM 无机会手动输出 TASK 区。

Adapter 的 `experimental.session.compacting` 钩子恰好填补：**压缩前**自动注入 Core 返回的 TASK 区。这同时提供首次真机验证 E2/E3 的机会。

### 5.2 注入内容

`core.snapshot_task_zone()` 返回 `.state.md` 13 字段的紧凑文本（Phase/Loop/Level + goal + current_step + completed 末 3 项 + pending + decisions + resume 指针）。Adapter `output.context.push` 进 compaction context。

```typescript
"experimental.session.compacting": async (input, output) => {
  const snap = await execCore(["snapshot-task-zone", "--cwd", cwd])
  if (snap.ok) {
    output.context.push(snap.text)  // Core 格式化的 TASK 区
  }
  // 降级：Core 不可用 → 不注入（回退到 OpenCode 默认 compaction，LLM 按 Skill 协议手动）
}
```

### 5.3 注入后恢复验证（对应验收）

压缩后新会话 `session.created` → `load_checkpoint` → 应能从 `.state.md`（持久）恢复 phase/current_step，**且**注入的 TASK 区文本与 `.state.md` 一致（双重保障）。这构成 E2/E3 的真机观测（补 E4 证据，呼应 `references/e4-matrix.md` D-3 现场采集卡）。

---

## 六、降级与回退设计（FallbackGuard）

### 6.1 降级链

```text
Adapter 加载成功 → 事件驱动 + 工具兜底全开
    │ 某次 Core CLI 调用失败
    ▼
Adapter 标记 degraded → 事件静默 no-op，工具返回降级提示
    │ Core/Exec 持续不可用
    ▼
Adapter 静默卸载（不抛错中断会话）→ 回退 Phase 0
    │ Phase 0：LLM 按 Skill 协议手动驱动（transition.md/state-machine.md）
    ▼
Skill 照常可用（Core/Exec/Adapter 全是叠加层，不修改协议语义）
```

### 6.2 降级信号

```typescript
let degraded = false
async function execCore(args: string[]) {
  try { return await runCli("python3", [CORE_CLI, ...args]) }
  catch (e) { degraded = true; return { ok: false, degraded: true,
    message: "Core 不可用，回退 LLM 手动驱动协议" } }
}
```

**铁律**：降级**不抛错中断会话**（OpenCode 插件 handler 错误会报告但继续）；降级**静默**（不刷屏）；降级在仪表盘记账（复用 memory_tool.py `metrics`，加 `adapter_degraded` 事件）。

---

## 七、与 Core 的协议端口（host-agnostic）

Core 的 5 方法（MVP-1 §八）经 CLI 暴露，Adapter 用 subprocess 调：

| Core 方法 | CLI | Adapter 调用时机 |
|---|---|---|
| `load_checkpoint` | `core load-checkpoint --cwd` | session.created |
| `transition` | `core transition --to S --loop N --exit-checklist '...' --cwd` | vc_transition 工具 |
| `snapshot_task_zone` | `core snapshot-task-zone --cwd` | experimental.session.compacting |
| `feed_exec` | `core feed-exec --result <ref> --cwd` | tool.execute.after |
| `repeat_check` | `core repeat-check --fp <hash> --cwd` | feed_exec 内部联动 |

**为什么用 CLI subprocess 而非 TS 直接重写 Core**：
1. Core 是 Python（零依赖，复用 memory_tool.py 工程范式）——TS 重写 = 重复实现 + 双源漂移。
2. CLI 解耦——Adapter 崩溃不影响 Core；Core 升级不影响 Adapter（只要 CLI 接口稳定）。
3. 与 memory_tool.py 一致的 CLI 设计哲学（它本身是 CLI）。
4. 性能：状态转换是低频操作（每阶段 1 次），subprocess 开销可忽略；高频的 `feed_exec`/`repeat_check` 可后续优化为常驻进程（留 Phase 4）。

---

## 八、Pi Adapter 的未来对接（不在 MVP-3 实现）

Pi 扩展能力（官方文档 `docs/extensions.md`，已验证）与 OpenCode 高度对称——证明 host-agnostic port 可行：

| 能力 | OpenCode | Pi | Core 对接 |
|---|---|---|---|
| 事件订阅 | `event({type})` | `pi.on()` | loadCheckpoint/transition |
| 会话生命周期 | `session.created/idle/compacted` | `session_start/session_shutdown` + compaction.md | load/快照 |
| 工具调用拦截 | `tool.execute.before/after` | `tool_call`（可 mutate/block）+ `tool_result` | feedExec |
| System prompt 修改 | compaction hook 注入 context | `before_agent_start` 改 `systemPromptOptions`（**更强**） | STATIC 注入 |
| 自定义工具 | `tool()` helper | `pi.registerTool`/`registerCommand` | vc_* 工具 |
| 自定义 provider | — | `pi.registerProvider`/`registerVirtualModel` | （无关） |
| Compaction 注入 | `experimental.session.compacting` | `compaction.md`（[待验证] 钩子 API） | snapshot_task_zone |

**关键差异**：Pi 的 `before_agent_start` 可**直接改 system prompt**（注入 STATIC 区确定性），比 OpenCode 的 compaction hook 更强。Pi Adapter 可在 `before_agent_start` 注入 STATIC + 在 compaction 注入 TASK，双重保障。**[待验证]** Pi compaction 钩子的精确 API（`docs/compaction.md` 存在但本次未深读）。

**Phase 4 Pi Adapter 落地步骤**（不在本设计实现）：
1. 读 `docs/compaction.md` 确认 compaction 注入 API。
2. 用 `pi.on("before_agent_start")` 注入 STATIC 区（kernel/policy/rules 摘要）。
3. 用 `pi.on("tool_call"/"tool_result")` 替代 `tool.execute.after`。
4. 用 `pi.on("session_start")` 替代 `session.created`。
5. 复用同一 Core CLI（host-agnostic port 不变）。

---

## 九、实现层次与文件布局

```
.opencode/plugins/                # OpenCode 插件目录（项目级）
└── vibe-kernel-adapter.ts        # Adapter 主文件（TypeScript）
.opencode/
└── package.json                  # 依赖（仅 @opencode-ai/plugin 类型，无运行时 npm 依赖）
runtime/cli/
├── core_cli.py                   # Core CLI 入口（load-checkpoint/transition/...）
└── exec_cli.py                   # Exec CLI 入口（run/summarize-diff/capture）
tests/adapter/
├── test_event_mapping.py         # 事件→Core 方法映射（用 Core/Exec CLI 真跑）
├── test_compaction_inject.py     # compaction 注入 TASK 区 + 恢复一致
├── test_custom_tools.py          # vc_transition/vc_exec/vc_diff/vc_state
└── test_fallback.py              # Core 不可用 → 降级 → Phase 0 回退
```

> Adapter 是 TS（宿主要求）；CLI 测试用 Python（与 Core/Exec 测试一致）。Adapter 本身的 TS 单测可选（逻辑薄，主要是事件派发 + subprocess）。

---

## 十、验证方案（基线 vs 实验）

### 10.1 基线（Phase 0：LLM 手动驱动）
- 关闭 Adapter（`opencode.json` 不加插件）。
- 跑 N 个真实任务（建议含中断恢复场景）。
- 采集：中断后恢复成功率、重复测试次数、无效工具调用数、token 消耗、checkpoint 一致性。

### 10.2 实验（Phase 3：Adapter 驱动）
- 开启 Adapter（`.opencode/plugins/vibe-kernel-adapter.ts` + `opencode.json` plugin 数组追加）。
- 跑相同 N 个任务。
- 采集同指标。

### 10.3 对比指标

| 指标 | 基线预期 | 实验目标 | 采集方式 |
|---|---|---|---|
| 中断恢复成功率 | 低（LLM 常忘读 .state.md） | ≥95%（Core 机械恢复） | compaction 后能否恢复 phase/current_step |
| 重复测试数 | 高（LLM 不识重复失败） | ↓（NO_PROGRESS 早停） | repeat_check 触发次数 |
| 无效工具调用 | 中（LLM 重复读已读文件） | ↓（vc_state 查询代替读文件） | tool.execute 次数 |
| token 消耗 | 基线 | ↓（TASK 注入 < 历史回溯） | 会话 token 计数 |
| checkpoint 一致性 | 低（LLM 手动写易漏字段） | 100%（Core 原子写 + schema 校验） | .state.md 字段完整率 |
| compaction 后恢复 | [未验证] | 首次真机验证 E2/E3 | compaction 注入后 load_checkpoint 一致 |

**仪表盘复用**：指标记入 memory_tool.py `metrics`（加 `adapter` 分组：`degraded`/`compaction_inject`/`recovery_success` 等事件）——复用现有 dashboard，不另造。

---

## 十一、配置与发布

### 11.1 opencode.json 变更（最小追加）

```jsonc
{
  "plugin": [
    ["@kojoru/opencode-advisor", {...}],          // 现有，不动
    [".opencode/plugins/vibe-kernel-adapter.ts"]  // 追加（项目级本地插件）
  ]
  // 其余配置不动
}
```

### 11.2 feature flag

Adapter 内置 `VIBE_KERNEL_ADAPTER=1` 环境变量开关。缺省开；置 0 → 插件加载即静默 no-op（回退 Phase 0）。便于 A/B 对比与故障隔离。

### 11.3 兼容性

- 不破坏现有 advisor 插件（共存，不同事件/工具名）。
- 不破坏现有 MCP（delx-memory/codegraph 不动）。
- Core/Exec CLI 路径经 `$HOME/.agents/skills/vibe-coder-loop/...` 软链解析到本项目（已迁移验证）。

---

## 十二、验收场景

| # | 场景 | 期望 |
|---|---|---|
| A1 | 会话启动 + .state.md active+fresh | load_checkpoint 恢复，LLM 从 phase 续跑 |
| A2 | 会话启动 + .state.md stale | 标 stale，以用户输入为准 |
| A3 | LLM 调 vc_transition(S1→S2, exit_checklist) | Core 写 .state.md，返回 ok |
| A4 | LLM 调 vc_transition 非法跳转 | Core 拒绝，返回 RULE_NOT_LOADED，.state.md 不变 |
| A5 | LLM 调 vc_exec(pytest) | Exec 执行 + 归一化，返回 ExecResult |
| A6 | vc_exec 输出超限 | 外置 artifact，vc_code=OUTPUT_LIMIT |
| A7 | tool.execute.after（LLM 调 bash） | Adapter 抓结果，feed_exec 到 Core |
| A8 | compaction 触发 | TASK 区注入 output.context；新会话能恢复 |
| A9 | compaction 后恢复与 .state.md 一致 | 双重保障验证（E2/E3 真机） |
| A10 | Core CLI 不可用 | Adapter 降级，静默 no-op，Skill 照常可用 |
| A11 | VIBE_KERNEL_ADAPTER=0 | 插件加载即 no-op，回退 Phase 0 |
| A12 | advisor 插件仍工作 | 共存不冲突 |

**退出条件**：A1–A12 全绿；基线 vs 实验数据对比显示中断恢复成功率/重复测试数/token 至少一项显著改善；Skill 协议文件**未被修改**；opencode.json 现有配置**未被破坏**。

---

## 十三、未决问题

| # | 问题 | 倾向 |
|---|---|---|
| U13 | `session.idle` 语义：响应结束还是会话结束？文档未明。 | 倾向不依赖 idle 写 checkpoint（改在 vc_transition 工具调用时写）；idle 仅作日志 |
| U14 | OpenCode v1 无 system prompt 注入事件（不像 Pi 的 before_agent_start）；STATIC 区如何注入？ | A. 经 compaction hook 顺带注入 STATIC 摘要；B. 靠 Skill 的 SKILL.md 机制（OpenCode 自动加载 skill 指令）；C. 自定义工具 vc_static 按需拉。倾向 B+（Skill 机制已存在，Adapter 不重复） |
| U15 | `tool.execute.after` 能否拿到完整 stdout？还是仅工具名+args？ | [待验证] 文档示例只截 args。若拿不到 stdout，则 Exec 需 LLM 显式调 vc_exec（工具兜底为主），feed_exec 降级为「记账」 |
| U16 | Adapter 与 advisor 插件的事件顺序？两者都 hook tool.execute.after 会冲突吗？ | [待验证] 文档「load order」指插件加载序，非 handler 执行序。倾向：advisor 是只读建议，不 mutate，无冲突；实测确认 |
| U17 | Core CLI 的输出格式：JSON 还是文本？ | 倾向 JSON（Adapter 易解析）；错误码仍带 `[CODE]\n[next]` 文本（对齐 VC 契约），JSON 内嵌 code/next 字段 |
