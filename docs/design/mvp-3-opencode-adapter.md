# MVP-3 — OpenCode Adapter 设计

> 目标：把 OpenCode 的**事件与 Hook**桥接到 Core/Exec，让「运行事实收集」与「状态注入」从 LLM 手动执行升级为宿主自动执行；**阶段转换仍由 LLM 显式驱动**（`exit_checklist` 无法自动生成，见 §4.2）。
> 原则：**Adapter 是薄层**——只做事件/Hook→协议映射 + 协议→宿主注入，不重实现 Skill 工作流；宿主类型不泄漏进 Core。
> 调研依据：本机 `@opencode-ai/plugin@1.15.4` 类型定义（`dist/index.d.ts` / `dist/tool.d.ts`）+ `@opencode-ai/sdk` 的 `Event` 联合类型 + `opencode.json` 实际配置（2026-10-20 核验）。
> **路径更新（现行协议）**：本文「本地降级日志 / health 文件」的 `<project_root>/.vibe-kernel/*` 属历史设计；Checkpoint 已迁 delx-memory，且协议**不在项目目录创建运行态文件**——实现时应落用户缓存（如 `~/.vibe-loop/adapter/`）。

---

## 一、目标与非目标

### 目标
1. **事件/Hook→协议映射**：OpenCode 的 `event()`（会话/文件）与独立命名 Hook（`tool.execute.*`、`experimental.*`）分别映射到 Core 的 6 个方法。**两类机制不混用**。
2. **协议→宿主注入（两条独立链路）**：新会话启动恢复（`experimental.chat.system.transform`）与会话内压缩恢复（`experimental.session.compacting` + `compaction.autocontinue`）。两者都有"LLM 实际用上了"的验收档位。
3. **自定义工具暴露**：把 Core/Exec CLI 暴露为 `vc_state`/`vc_transition`/`vc_exec`/`vc_diff`，供 LLM 主动查询与显式转阶段。
4. **降级兼容（分层且可见）**：L1–L4 逐级降级，**不阻断用户工作**，但**明确报告**哪些能力不可用，并保留不依赖 Core 的诊断路径与安全拦截。
5. **基线对比验证**：采集「恢复成功率/重复测试数/无效调用/token」数据，证明 Adapter 价值；**恢复成功率以"LLM 行为"为证，不以"Core 读了文件"为证**。

### 非目标
- 不实现对话压缩（归 OpenCode `compaction`；Adapter 只注入 TASK 区）。
- **不自动识别工作流阶段**：`transition()` 的 `exit_checklist` 只能由 LLM 产出；Adapter 只做"缺失检测 + 提醒"（§4.4）。
- 不重实现 Skill 工作流（Adapter 不含 S0–S14 逻辑，全委托 Core）。
- 不绑定 OpenCode v2 特性（基于 v1 已验证事件；v2 适配留后续）。
- 不实现 Pi Adapter（Pi 事件映射留 Phase 4，本设计只给 host-agnostic port 对接证据）。
- 不修改 opencode.json 的现有配置（plugin 数组追加，不替换）。

---

## 二、现状与证据

### 2.0 证据升级：从「文档示例」到「本机类型定义」

原设计把 `tool.execute.after` 放在通用 `event()` 回调里判断 `event.type`，同时又把它称作 Tool Hook——**这两种机制在 OpenCode 里不是一回事**。本机类型定义可直接证伪原伪代码：

```text
~/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts   (@opencode-ai/plugin 1.15.4)
~/.opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts
~/.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts   (Event 联合类型)
```

**`Hooks` 接口里 `event` 与 `tool.execute.after` 是两个独立的键**：

```ts
export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>;          // 只收 Event 联合类型
  "tool.execute.before"?: (input: { tool: string; sessionID: string; callID: string },
                           output: { args: any }) => Promise<void>;
  "tool.execute.after"?:  (input: { tool: string; sessionID: string; callID: string; args: any },
                           output: { title: string; output: string; metadata: any }) => Promise<void>;
  "experimental.session.compacting"?: (input: { sessionID: string },
                                       output: { context: string[]; prompt?: string }) => Promise<void>;
  "experimental.chat.system.transform"?: (input: { sessionID?: string; model: Model },
                                          output: { system: string[] }) => Promise<void>;
  "experimental.compaction.autocontinue"?: (input: {...}, output: { enabled: boolean }) => Promise<void>;
  "chat.message"?: (input: {...}, output: { message: UserMessage; parts: Part[] }) => Promise<void>;
  "permission.ask"?: (input: Permission, output: { status: "ask"|"deny"|"allow" }) => Promise<void>;
  tool?: { [key: string]: ToolDefinition };
}
```

**四条结论（均以类型定义为准，不再是推测）**：

1. `tool.execute.after` 是**独立命名 Hook**，签名 `(input, output) => Promise<void>`，**不经 `event()` 分发**。原伪代码写在 `event` 里判断 `event.type === "tool.execute.after"` **永远不成立**。
2. **stdout 可取得**：`output.output: string`（工具输出文本）+ `output.metadata: any`（结构化元数据）+ `output.title`。原 U15「能否拿到完整 stdout」→ **能拿到工具输出字符串**，但**不保证是完整原始 stdout**（可能是工具层截断/格式化后的文本）。因此 `feed_exec` 定位为「记账 + 指纹素材」，精确执行归 `vc_exec`。
3. `experimental.session.compacting` 的 `output.context: string[]` → `push` 即可（原设计正确）。
4. **新会话恢复有注入点**：`experimental.chat.system.transform`（`output.system: string[]`）可在每次请求前改写 system prompt；`chat.message`（`output.parts`）可向用户消息注入上下文；`experimental.compaction.autocontinue`（`output.enabled`）可决定压缩后是否自动续跑。**这解决了原 P0「新会话恢复只读状态、没证明 LLM 收到」的缺口**。

**运行时依赖（修正原设计）**：`tool` 是**运行时导出**（`tool.d.ts` 导出 `tool()` 与 `tool.schema = z`），且 `@opencode-ai/plugin` 依赖 `zod` 与 `effect`。所以：

| 类型 | 原设计 | 事实 |
|---|---|---|
| `@opencode-ai/plugin` | 仅类型依赖（devDependency） | **运行时依赖**（插件 `import { tool }`，进程内执行） |
| `zod` | 未提及 | 由 plugin 包传递依赖；若直接 `import { z }` 需显式声明 |
| `package.json` | 「仅类型，无运行时依赖」 | 需在 `.opencode/` 内 `bun install` 真实安装 |

### 已验证的 OpenCode 插件能力（类型定义 + 官方文档）

| 能力 | 证据 | Adapter 用途 |
|---|---|---|
| 插件 = `async (input, options?) => Hooks` | `Plugin` 类型 | Adapter 工厂 |
| `PluginInput` = `{client, project, directory, worktree, experimental_workspace, serverUrl, $}` | 类型定义 | 取 `worktree ?? directory` → Core 定位状态文件 |
| `event` 收 `Event` 联合（`session.created/updated/deleted/idle/compacted/status/diff/error`…） | SDK `types.gen.d.ts` | `session.created`→load-checkpoint；`session.compacted`→重注入；`session.idle`→心跳 |
| `tool.execute.after` 独立 Hook | 类型定义 | `feed_exec`（记账/指纹） |
| `tool.execute.before` 独立 Hook（可改 `output.args`） | 类型定义 | 高危操作拦截（§4.5） |
| `experimental.session.compacting` | 类型定义 | 压缩前注入 TASK 区 |
| `experimental.chat.system.transform` | 类型定义 | **新会话恢复注入**（§5.4） |
| `experimental.compaction.autocontinue` | 类型定义 | 压缩后自动续跑开关 |
| `chat.message`（`output.parts`） | 类型定义 | 替代/补强注入（§5.4 备选） |
| `permission.ask`（`output.status`） | 类型定义 | 高风险命令的宿主级授权 |
| 自定义工具 `tool({description, args, execute})` | `tool.d.ts` | 暴露 `vc_state`/`vc_transition`/`vc_exec`/`vc_diff` |
| `ToolContext` 含 `directory`/`worktree`/`abort: AbortSignal` | `tool.d.ts` | 传给 Exec 的 `cancel_event`；路径优先用 `context.directory` 而非 `process.cwd()` |

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

**关键**：`compaction.auto=true + prune=true`——OpenCode 会自动压缩并剪枝旧工具输出。这使 TASK 区注入**非可选**（否则压缩后 LLM 丢失状态，恢复协议失效）。

### 尚不存在（Adapter 要新建）
- 任何 OpenCode 插件（当前 `plugin` 数组只有 advisor）。
- OpenCode 事件/钩子与 Core 的代码连接。
- 新会话与压缩后两个场景的**可验证**注入链路（原设计只有前者"读了状态"，没有"进入上下文"）。

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

### 4.1 映射表（按真实的两种机制分开写）

**机制 A：`event()` 通用事件**（只收 `Event` 联合类型的会话/文件/命令事件）

| `event.type` | Adapter 行为 | Core 方法 | 说明 |
|---|---|---|---|
| `session.created` | 标记本会话「待注入恢复」并读状态 | `load_checkpoint()` | **只做读取与状态置位**；注入在 §5.4 |
| `session.compacted` | 重新置位「待注入」 | `snapshot_task_zone()` | 压缩后 system prompt 可能已被改写 → 下一请求重新注入 |
| `session.idle` | **心跳/日志**，不写状态 | — | 原 U13 定案：idle = 一轮响应结束（`SessionStatus` 含 `busy` 等状态，`idle` 表示空闲），**不是会话结束**；据此写 `S13` 会在每次回答后误判完成 |
| `session.status` | 记 busy/idle 转换（可选 metrics） | — | 用于 §4.4 的"转换缺失"检测 |
| `command.executed` | 记 `/` 命令 | — | 未来仪表盘素材 |
| `file.edited` | 累计 `files_touched`（仅观测） | `feed_exec` 附带计数 | MVP-1 §3.4 `SAFE_MODE_OBSERVED` |
| 其他 | 忽略 | — | 未订阅不处理，避免噪声 |

**机制 B：独立命名 Hook**（**不是** event，必须单独注册）

| Hook | 签名要点 | Adapter 行为 | 说明 |
|---|---|---|---|
| `tool.execute.after` | `input{tool,sessionID,callID,args}` / `output{title,output,metadata}` | `feed_exec()` 记账 + 指纹素材 | **stdout 以 `output.output` 提供**，但可能是工具层格式化/截断后文本；不作为精确执行结果使用 |
| `tool.execute.before` | `input{tool,sessionID,callID}` / `output{args}` | 高危命令拦截（可改 `output.args` 或抛错） | 映射 `policy/safety.md` 红线；与 Exec 的 `policy.py` 双层防护 |
| `experimental.session.compacting` | `input{sessionID}` / `output{context[],prompt?}` | 注入 TASK 区（`output.context.push`） | 压缩前注入，保压缩后可恢复 |
| `experimental.chat.system.transform` | `input{sessionID?,model}` / `output{system[]}` | **新会话/压缩后注入恢复块** | §5.4 的核心注入点 |
| `experimental.compaction.autocontinue` | `output.enabled` | 压缩后置 `true`，让模型实际续跑 | 保证"注入被使用"而非"注入后被搁置" |
| `chat.message` | `output{message, parts[]}` | 备选注入路径（把恢复块作为一条 part） | 当 system.transform 不可用/被覆盖时降级 |
| `permission.ask` | `output.status: ask\|deny\|allow` | 高风险命令的宿主级授权入口 | 与 Exec `allow_high_risk` 联动 |

> **原设计错误**：把 `tool.execute.after` 写进 `event` 回调判断 `event.type`。`event` 只收 `Event` 联合类型，工具执行结果**不在**其中——该分支永远不触发。已按上表拆分为两种机制。

### 4.2 自动捕获 ≠ 自动转阶段（边界必须说清）

```text
Adapter 能做（自动）     ：收集运行事实 —— 工具执行、文件变更、会话生命周期、压缩时机
Adapter 不能做（必须 LLM）：判定阶段出口是否完成 —— exit_checklist 的内容正确性
```

`transition()` 需要 `exit_checklist`（上一阶段产出的引用 + 本阶段勾选证据），这**只能由 LLM 产出**。因此真实架构是**混合**：

| 环节 | 驱动方式 | 保证 |
|---|---|---|
| `load_checkpoint` / `snapshot_task_zone` / 注入 | 事件 + Hook（自动） | LLM 漂移也不漏 |
| `feed_exec` / 指纹计数 | Hook（自动） | 机械、不漏 |
| `transition`（含 phase/loop/completed 落盘） | **LLM 显式调 `vc_transition`** | 不自动 |
| `repeat_check` → S14 | Core 内部（自动） | 到达阈值即触发 |

**因此"自动驱动"必须被限定为「自动捕获运行事实」，不是「自动识别工作流阶段」**。LLM 忘记调 `vc_transition` 时系统不会自己转阶段——所以需要 §4.4 的**检测与提醒**，而不是宣称状态转换已完全自动化。

### 4.3 关键实现伪代码

```typescript
// .opencode/plugins/vibe-kernel-adapter.ts
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"        // 运行时导出，非纯类型
import { execCore, execExec, resolvePaths } from "./bridge"

export const VibeKernelAdapter: Plugin = async (input) => {
  const { directory, worktree } = input
  const cwd = worktree || directory            // worktree 优先（MVP-1 §7.1）
  const paths = await resolvePaths(cwd)        // 校验项目根 + python 发现（§4.6）

  // 每会话的一次性注入标记（内存即可，丢失可由 .state.md 重建）
  const pendingInject = new Map<string, "resume" | "compacted">()

  return {
    // ── 机制 A：通用事件 ─────────────────────────────
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const rec = await execCore(["load-checkpoint", "--cwd", cwd], paths)
          if (rec.mode === "resume" || rec.mode === "resume_degraded") {
            pendingInject.set(event.properties.info.id, "resume")
          }
          break
        }
        case "session.compacted":
          pendingInject.set(event.properties.sessionID, "compacted")
          break
        case "file.edited":
          await execCore(["observe-files", "--path", event.properties.file, "--cwd", cwd], paths)
          break
        default: break   // idle / status 等仅日志
      }
    },

    // ── 机制 B：独立 Hook ───────────────────────────
    "tool.execute.after": async (hookInput, hookOutput) => {
      await execCore(["feed-exec-tool", "--cwd", cwd,
        "--tool", hookInput.tool,
        "--call-id", hookInput.callID,
        "--output-file", await spillToTemp(hookOutput.output),   // 避免超长 argv
      ], paths)
    },

    "tool.execute.before": async (hookInput, hookOutput) => {
      const verdict = await execExec(["policy", "--cwd", cwd,
        "--tool", hookInput.tool,
        "--args", JSON.stringify(hookOutput.args)], paths)
      if (verdict.deny) throw new Error(`[SCOPE_DENIED] ${verdict.fact}\n[next] ${verdict.next}`)
    },

    "experimental.session.compacting": async (hookInput, hookOutput) => {
      const snap = await execCore(["snapshot-task-zone", "--cwd", cwd], paths)
      if (snap.ok) hookOutput.context.push(snap.text)
      // 失败 → 不注入、不抛错（§6 降级），但记 degraded 日志
    },

    "experimental.compaction.autocontinue": async (_i, o) => { o.enabled = true },

    // ── 新会话/压缩后注入（§5.4）───────────────────
    "experimental.chat.system.transform": async (hookInput, hookOutput) => {
      const sid = hookInput.sessionID
      const need = sid ? pendingInject.get(sid) : undefined
      if (need) {
        const snap = await execCore(["snapshot-task-zone", "--cwd", cwd, "--detail", "full"], paths)
        if (snap.ok) {
          hookOutput.system.push(snap.text)
          pendingInject.delete(sid!)
        }
      } else {
        // 非常态请求：只注入单行指针，低成本保持可寻址
        const ptr = await execCore(["snapshot-task-zone", "--cwd", cwd, "--detail", "pointer"], paths)
        if (ptr.ok) hookOutput.system.push(ptr.text)
      }
    },

    // ── 自定义工具（LLM 显式调用）──────────────────
    tool: {
      vc_transition: tool({
        description: "Vibe Kernel 状态转换。在阶段出口调用，必须传 exit_checklist。",
        args: {
          to: tool.schema.string(),
          loop: tool.schema.number().optional(),
          stage: tool.schema.string(),
          referenced_outputs: tool.schema.array(tool.schema.string()),
          checked_items: tool.schema.array(tool.schema.string()),
          expected_rev: tool.schema.number().optional(),
          force: tool.schema.boolean().optional(),
          reason: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          return await execCore(["transition",
            "--cwd", ctx.directory,
            "--to", args.to,
            "--loop", args.loop == null ? "" : String(args.loop),
            "--exit-checklist", JSON.stringify({
              stage: args.stage,
              referenced_outputs: args.referenced_outputs,
              checked_items: args.checked_items,
            }),
            "--expected-rev", args.expected_rev == null ? "" : String(args.expected_rev),
            ...(args.force ? ["--force", "--reason", args.reason ?? ""] : []),
          ], paths)
        },
      }),
      vc_exec: tool({
        description: "执行命令并归一化结果（经 MVP-2 Exec）。",
        args: { cmd: tool.schema.array(tool.schema.string()),
                timeout_ms: tool.schema.number().optional(),
                pin: tool.schema.boolean().optional() },
        async execute(args, ctx) {
          const res = await execExec(["run", "--cwd", ctx.directory,
            "--cmd", JSON.stringify(args.cmd),
            "--timeout", String(args.timeout_ms ?? 300000),
            "--stage", currentStage(),
            ...(args.pin ? ["--pin"] : [])], paths)
          await execCore(["feed-exec", "--exec-id", res.exec_id,
            "--result-file", await spillToTemp(JSON.stringify(res)), "--cwd", ctx.directory], paths)
          return res
        },
      }),
      vc_diff: tool({
        description: "生成 diff 汇总（含 plan_drift）。",
        args: { plan_files: tool.schema.array(tool.schema.string()).optional() },
        async execute(args, ctx) {
          return await execExec(["diff", "--cwd", ctx.directory,
            "--plan-files", JSON.stringify(args.plan_files ?? [])], paths)
        },
      }),
      vc_state: tool({
        description: "查询当前状态快照（只读）。",
        args: {},
        async execute(_a, ctx) { return await execCore(["get-state", "--cwd", ctx.directory], paths) },
      }),
    },
  }
}
```

### 4.4 转换缺失检测（补"LLM 漏调 vc_transition"的洞）

自动捕获不能保证阶段转换发生。Adapter 提供**检测与提醒**，而不是替 LLM 转阶段：

```text
计数：每个会话维护 turnsSinceTransition
  - 每次 session.idle（一轮响应结束）→ +1
  - 每次 vc_transition 成功 → 归 0
阈值：turnsSinceTransition >= 3 且 当前 phase 处于 S8/S9/S10 → 注入一次提醒
提醒内容（只提醒，不改状态）：
  [runtime] PHASE_TRANSITION_MISSING 已连续 4 轮无 vc_transition（当前 phase=S8）
  [next] 若本阶段已出口，调用 vc_transition 并传 exit_checklist
```

**为什么只提醒**：Adapter 无从知道阶段是否真的出口；强行转阶段会制造假状态。提醒让 LLM 自纠，符合"Core 只管状态、判断归 LLM"。

### 4.5 拦截层与授权层

- `tool.execute.before` + Exec `policy.py` 是**两层**：Host 层按工具名/参数粗拦（快、不依赖 Core），Exec 层按 argv 白名单细判（准、依赖 Core CLI）。
- Core 不可用时 → Host 层仍生效（**不因降级而失去拦截**），只是细判缺失；此时对高危工具一律 `deny`（fail-closed）。
- 用户授权走 `permission.ask`：Adapter 把 Exec 的 `needs_confirmation` 结果翻译成宿主权限请求；用户拒绝 → 返回 `SCOPE_DENIED` 并止步。

### 4.6 运行环境发现（不假定开发者机器布局）

| 项 | 解析顺序 | 失败行为 |
|---|---|---|
| 项目根 / 状态目录 | `ctx.worktree ?? ctx.directory` → Core `StateResolver`（MVP-1 §7.1） | `CHECKPOINT_LOCATION_UNRESOLVED`，插件进入 degraded |
| Python 解释器 | `VIBE_KERNEL_PYTHON` → `python3` → `python` → `py -3`（Windows）；逐个跑 `--version` 校验 ≥3.10 | `ENV_ERROR` + degraded（显式提示，不静默） |
| Core/Exec 代码位置 | `VIBE_KERNEL_HOME` → 从插件文件位置向上找 `runtime/`（`import.meta.url` + `path.resolve`） → `$HOME/.agents/skills/vibe-coder-loop/` | degrade + 提示安装路径 |
| 路径含空格 / Unicode | 全程 argv 数组 + `spawn`（不用 `exec` 字符串）；`--cwd` 单独传参 | 无需特殊处理（这是设计约束，不是兼容补丁） |
| Windows 长路径 | 超过 260 字符时给 `\\?\` 前缀（仅绝对路径） | 记录警告，仍尝试 |
| 退出码 | POSIX 信号 → `128+signum`；Windows → 原样 | 透传给 `ExecResult.exit_code` |

---

## 五、上下文注入设计（两个场景必须分开写）

原设计把「新会话启动」与「会话内压缩」混成一件事：`session.created → load_checkpoint` 只证明 **Core 读了文件**，不证明 **LLM 收到了内容**。定案：拆成两条独立链路，各自有独立的注入点、触发条件与验收。

| 场景 | 注入点 | 触发时机 | 证明"LLM 收到了"的方式 |
|---|---|---|---|
| **A. 新会话启动恢复** | `experimental.chat.system.transform`（`output.system[]`） | `session.created` 且 `load_checkpoint` 返回 `resume`/`resume_degraded` → 置一次性标记 → **下一次 LLM 请求时**注入 | 见 §5.4 的 A3 验收 |
| **B. 会话内压缩恢复** | `experimental.session.compacting`（`output.context[]`）+ `experimental.compaction.autocontinue` | 宿主发起压缩 | 见 §5.5 的 B2 验收 |

> **为什么 A 不能靠 compaction hook**：`compacting` 只在压缩前触发；全新会话没有压缩，永不触发。原设计在此处留空（注释写着"经 compaction hook 或 message 注入"，但未定），等于**新会话恢复根本没闭环**。

### 5.1 为什么这件事是 MVP-3 的核心

`state-machine.md`「压缩后状态延续契约」要求压缩后 LLM 能从注入的 📌 TASK 区恢复，而非从历史回溯。但：
- **[未充分验证]** 会话内压缩维度 E2/E3「未经真机观测」（协议自述）。
- OpenCode `compaction.auto=true + prune=true` 会**自动**压缩并剪枝——LLM 无机会手动输出 TASK 区。

Adapter 的挂载点恰好填补两个缺口，同时提供首次真机验证 E2/E3 的机会。

### 5.2 注入内容

`snapshot_task_zone(detail="full")` 返回的紧凑文本（Phase/Loop/Level + goal + current_step + completed 末 3 项 + pending + decisions + resume 指针）；`detail="pointer"` 返回单行指针（成本极低）：

```text
## 📌 TASK 区（Vibe Kernel Checkpoint）
[Phase: S8 Code] [Loop: 1] [Level: 2] status=active rev=12
goal: 修复登录超时（constraints: 不改 API 签名）
current_step: 补充 token 刷新单测
completed(末3): S5 需求复述 / S6 模块划分 / S7 Step3
pending: [unverified] 更新 docs/api.md
resume: 已完成 S7，下一分支 = S8 Step4
📎 详情取用：vc_state
```

### 5.3 注入的三条纪律

1. **注入 ≠ 权威**：注入文本与状态文件冲突时**以状态文件为准**（注入是缓存）。注入块内显式标注 `rev=12`，便于 LLM 判断是否过期。
2. **注入有界**：`full` 快照硬上限 ~1.5KB（超出截断 `completed` 更早项并标 `…`）；`pointer` ≤ 200 字节。**不能用注入把 token 问题放大**。
3. **失败不阻断**：Core 不可用/超时 → 不注入、不抛错、记 degraded 日志；LLM 仍可按 Skill 协议手动读 `.state.md`（§6 两层降级）。

### 5.4 场景 A：新会话启动恢复（闭环）

```typescript
// 事件侧：只置标记，不假设能注入
case "session.created": {
  const rec = await execCore(["load-checkpoint", "--cwd", cwd], paths)
  if (rec.mode === "resume" || rec.mode === "resume_degraded") {
    pendingInject.set(event.properties.info.id, "resume")   // 等下一次 LLM 请求
  }
}

// 注入侧：每次 LLM 请求前调用，命中标记则注入完整快照
"experimental.chat.system.transform": async (hookInput, hookOutput) => {
  const need = hookInput.sessionID && pendingInject.get(hookInput.sessionID)
  const snap = await execCore(["snapshot-task-zone", "--cwd", cwd,
                               "--detail", need ? "full" : "pointer"], paths)
  if (!snap.ok) return
  hookOutput.system.push(snap.text)
  if (need) pendingInject.delete(hookInput.sessionID!)   // 一次性，避免每轮重复灌全文
}
```

**验收（三档，逐档升级，缺一不可）**：

| 档 | 观测 | 通过标准 |
|---|---|---|
| A1 | Core 侧 | `load-checkpoint` 返回 `mode=resume` 且 `phase/current_step` 正确 |
| A2 | 注入侧 | Adapter 日志记录 `system.transform` 实际 push 了 N 字节，且内容含 `phase=S…` |
| A3 | **LLM 行为** | 新会话第一条助手输出**复述当前 phase/current_step** 并从该阶段续跑；未出现"请告诉我你要做什么"式重启 |

**A3 是唯一有意义的证据**。A1/A2 全绿而 A3 失败 → 判定"恢复闭环不成立"，按 §5.6 处理。

**A 链路的已知风险**：`experimental.*` 钩子属实验 API，可能在小版本变更。因此：

- 启动时做一次**能力探测**（读 `hooks` 键是否存在），缺失 → 走 `chat.message` 备选（把快照作为一条 `part` 注入）。
- 两者都不可用 → 降级为**显式工具驱动**：不宣称自动恢复，明确提示用户/LLM 调 `vc_state` 取状态。文档里**如实标注为"工具驱动"**，不写成"自动恢复"。

### 5.5 场景 B：会话内压缩恢复

```typescript
"experimental.session.compacting": async (_input, output) => {
  const snap = await execCore(["snapshot-task-zone", "--cwd", cwd, "--detail", "full"], paths)
  if (snap.ok) output.context.push(snap.text)     // 压缩摘要里带上 TASK 区
},
"experimental.compaction.autocontinue": async (_i, o) => { o.enabled = true },
```

**为什么需要 `autocontinue`**：仅注入上下文不保证模型会用它——若压缩后停在等待用户输入，注入内容可能被闲置。置 `enabled=true` 让压缩后自动产生一次续跑轮，模型被迫在带 TASK 区的上下文里继续。

**验收**：

| 档 | 观测 | 通过标准 |
|---|---|---|
| B1 | 注入侧 | `compacting` 的 `output.context` 含 TASK 区；`autocontinue.enabled=true` |
| B2 | **LLM 行为（压缩后）** | 压缩后的第一条输出仍是 `[Phase: x][Loop: n]` 并继续原步骤，**不重做已完成项** |
| B3 | 一致性 | 压缩后 `vc_state` 返回的 phase/loop 与注入块一致；不一致 → 记录 `inject_state_mismatch`（说明注入过期） |

### 5.6 失败判定与后续动作

若 A3 或 B2 失败（注入成功但 LLM 未按状态工作）：

1. **不宣称恢复闭环**——把结论从"已验证"降级为"注入可用、行为未验证"。
2. 采集三样证据：注入文本长度、注入位置（system vs message）、LLM 首条输出是否提及 phase。
3. 备选路径按优先级尝试：`chat.message` 注入 → 提高注入优先级（置于 system 末尾）→ 显式工具驱动。
4. **停止继续堆机制**：连续两种注入方式都无效 → 结论是"该宿主当前不支持可靠恢复"，如实记录，不做第三种猜测。

---

## 六、降级与回退设计（两层：不阻断 + 可见）

**原设计的问题**：只说"静默回退 Phase 0"。静默有两个后果——用户以为自动恢复/状态校验/失败检测仍然生效；而故障本身又记在**同一个 Core 的 metrics** 里（Core 挂了就记不上，等于没有诊断）。

### 6.1 降级链（能力级，不是全有全无）

```text
L0 全功能：事件 + Hook + 工具 全开
  │ 单次 Core CLI 失败（超时/非零退出）
  ▼
L1 重试态：该次调用重试 1 次（指数退避 200ms）；成功 → 回 L0
  │ 连续 3 次失败 / 能力探测失败
  ▼
L2 部分降级：停用依赖 Core 的注入与记账；工具仍可用但返回显式 degraded 说明
  │ Python/Core 持续不可用
  ▼
L3 纯宿主保护：仅保留 tool.execute.before 的本地拦截 + system.transform 的静态提示
  │ （不读状态、不写状态、不注入 TASK）
  ▼
L4 完全退出：插件不再注册任何 handler → LLM 按 Skill 协议手动驱动（Phase 0）
```

**关键**：**L3 不能一起消失**。`tool.execute.before` 的拦截与状态无关，属于安全能力，降级时**必须保留**（fail-closed：Core 不可用时对高危工具一律 `deny`）。

### 6.2 可见性：不阻断 ≠ 不告知

| 通道 | 内容 | 不依赖 Core |
|---|---|---|
| 宿主通知 | 首次进入 L2/L3 时，经 `client.tui`/会话消息发一次提示：`Vibe Kernel 已降级（L2）：自动恢复与状态校验不可用，请按 Skill 协议手动维护` | ✅（用 OpenCode client） |
| **本地降级日志** | `<project_root>/.vibe-kernel/adapter.log`（JSONL：ts/level/reason/trace） | ✅（纯文件写，**不经过 Core**） |
| `vc_state` 工具 | 返回 `{ok:false, degraded_level:"L3", reason, since}` | ❌（工具本身降级，返回静态说明） |
| health 文件 | `<project_root>/.vibe-kernel/adapter-health.json`（`{level, since, python, core_version}`） | ✅（外部脚本/人工可查） |

**铁律修正**：降级**不抛错中断会话**（保留），但**不再静默**——一次性可见提示 + 持续可查的本地日志。重复同一原因不再刷屏（按 `reason` 去重）。

### 6.3 为什么必须有不依赖 Core 的诊断路径

Core 挂了就记不上 Core 的 metrics——这是循环依赖。因此 Adapter 自带最小诊断（§6.2 后两项），Core 恢复后由下一次成功调用把累积日志汇总进 metrics（`adapter_degraded` 事件带 `duration_ms`）。

---

## 七、与 Core 的协议端口（host-agnostic）

Core 的 6 个方法（MVP-1 §八）经 CLI 暴露，Adapter 用 subprocess 调：

| Core 方法 | CLI | Adapter 调用时机 |
|---|---|---|
| `load_checkpoint` | `core load-checkpoint --cwd` | `session.created`（事件） |
| `transition` | `core transition --cwd --to S [--loop N] --exit-checklist <json> [--expected-rev R] [--force --reason R]` | `vc_transition` 工具 |
| `snapshot_task_zone` | `core snapshot-task-zone --cwd [--detail full\|pointer]` | `session.compacting` / `chat.system.transform`（Hook） |
| `feed_exec` | `core feed-exec --cwd --exec-id ID --result-file F` | `tool.execute.after`（Hook）/ `vc_exec` |
| `repeat_check` | `core repeat-check --cwd --fp H` | `feed_exec` 内部联动 |
| `get_state` | `core get-state --cwd` | `vc_state` 工具 |

**额外运维命令**：`core check-protocol`（CI 门禁）、`core state check`（LLM 手写后自检）、`core state gc`。

**CLI 契约**（原 U17 定案）：

- 输出**单行** JSON 到 stdout：`{"ok":bool, "code":str|null, "next":str|null, "data":{...}, "degraded":false}`
- 错误也走 stdout + **exit code 语义**：`0` 成功 / `3` 状态或协议错误（可自纠）/ `4` 环境错误（需人工）。**不把错误打到 stderr 就返回 0**。
- 超长入参（如 `exit_checklist`、工具输出）用 `--*-file <path>` 传文件，避免 argv 长度上限（Windows 32767）。
- `--cwd` 必填，**不回落 `process.cwd()`**。

**为什么用 CLI subprocess 而非 TS 重写 Core**：
1. Core 是 Python（零依赖）——TS 重写 = 双源漂移。
2. CLI 解耦——Adapter 崩不影响 Core；Core 升级不影响 Adapter（CLI 契约稳定）。
3. 与 memory_tool.py 一致的 CLI 哲学。
4. 性能：状态转换低频（每阶段 1 次），开销可忽略；高频 `feed_exec` 留 Phase 4 常驻 worker。

---

## 八、Pi Adapter 的未来对接（不在 MVP-3 实现）

Pi 扩展能力（官方文档 `docs/extensions.md`，已验证）与 OpenCode 高度对称——证明 host-agnostic port 可行：

| 能力 | OpenCode | Pi | Core 对接 |
|---|---|---|---|
| 事件订阅 | `event()` | `pi.on()` | load_checkpoint/transition |
| 会话生命周期 | `session.created/idle/compacted` | `session_start/session_shutdown` + compaction.md | load/快照 |
| 工具调用拦截 | `tool.execute.before/after`（独立 Hook） | `tool_call`（可 mutate/block）+ `tool_result` | feed_exec / 拦截 |
| System prompt 修改 | `experimental.chat.system.transform`（`output.system[]`） | `before_agent_start` 改 `systemPromptOptions` | TASK/STATIC 注入 |
| 自定义工具 | `tool()` helper（运行时） | `pi.registerTool`/`registerCommand` | vc_* 工具 |
| 自定义 provider | — | `pi.registerProvider`/`registerVirtualModel` | （无关） |
| Compaction 注入 | `experimental.session.compacting` | `compaction.md`（[待验证] 钩子 API） | snapshot_task_zone |

**关键差异**：Pi 的 `before_agent_start` 可改 system prompt（与 OpenCode 的 `experimental.chat.system.transform` 能力对等，语义更稳定）。**[待验证]** Pi compaction 钩子的精确 API（`docs/compaction.md` 存在但本次未深读）。

> **对称性结论修正**：原设计称"OpenCode 无 system prompt 注入事件、Pi 更强"——按 1.15.4 类型定义，OpenCode **有** `experimental.chat.system.transform`。差异从"能力有无"降为"API 稳定性"（`experimental.*` 更易变）。这降低了 Pi Adapter 的必要紧迫性，也意味着 **OpenCode 侧不需要靠 compaction 兜底新会话恢复**。

**Phase 4 Pi Adapter 落地步骤**（不在本设计实现）：
1. 读 `docs/compaction.md` 确认 compaction 注入 API。
2. 用 `pi.on("before_agent_start")` 注入 STATIC 区（kernel/policy/rules 摘要）。
3. 用 `pi.on("tool_call"/"tool_result")` 替代 `tool.execute.after`。
4. 用 `pi.on("session_start")` 替代 `session.created`。
5. 复用同一 Core CLI（host-agnostic port 不变）。

---

## 九、实现层次与文件布局

```
.opencode/
├── plugins/
│   ├── vibe-kernel-adapter.ts     # Adapter 主文件（TypeScript）
│   └── bridge.ts                  # subprocess 桥：python 发现 / argv 组装 / JSON 解析 / 退避
└── package.json                   # 运行时依赖（见下，不是仅类型）
runtime/core/cli.py                # Core CLI 入口（MVP-1 §九）
runtime/exec/cli.py                # Exec CLI 入口（MVP-2 §八）
runtime/adapter/                   # Adapter 的 Python 侧薄壳（供 Python 测试直接驱动同名逻辑）
tests/adapter/
├── test_hook_contract.py          # 用本机 typings 校验 hook 名/签名与实现一致（防再写成 event 分支）
├── test_new_session_resume.py     # 场景 A：A1/A2/A3 三档
├── test_compaction_resume.py      # 场景 B：B1/B2/B3
├── test_custom_tools.py           # vc_transition/vc_exec/vc_diff/vc_state
├── test_degrade_levels.py         # L1→L4 逐级降级 + L3 保留拦截 + 日志不依赖 Core
└── test_env_discovery.py          # python 发现 / 路径含空格与 Unicode / 无 Core 时的报错形态
```

**`.opencode/package.json`（修正"仅类型依赖"）**：

```jsonc
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.15.4"   // 运行时导出 tool()/tool.schema，必须真实安装
  }
}
```

- `zod` 由 `@opencode-ai/plugin` 传递依赖；若 Adapter 需要独立 `import { z }`，显式加 `"zod"`。
- 安装：在 `.opencode/` 内 `bun install`（OpenCode 用 bun）。缺依赖 → 插件加载失败 → L4 回退 + 可见提示（§6.2），**不静默**。
- **版本探测**：启动时读 `@opencode-ai/plugin/package.json` 的 `version`，低于最低支持版本（检测到的 Hook 集合为准）→ 进入 L2 并提示升级；**不按"文档版本号"硬编码判断**。

> Adapter 是 TS；测试用 Python 驱动同一 CLI（与 Core/Exec 测试一致）。`test_hook_contract.py` 直接读本机 `node_modules/@opencode-ai/plugin/dist/index.d.ts` 提取 hook 键名集合，断言 Adapter 注册的键都在其中——**这是防止再出现"把 Hook 当 event 用"的机械闸门**。

---

## 十、验证方案（基线 vs 实验）

### 10.1 基线（Phase 0：LLM 手动驱动）
- 关闭 Adapter（`opencode.json` 不加插件）。
- 跑 N 个真实任务（**必须含中断恢复场景**）。
- 采集：中断后恢复成功率、重复测试次数、无效工具调用数、token 消耗、checkpoint 一致性。

### 10.2 实验（Phase 3：Adapter 驱动）
- 开启 Adapter（`.opencode/plugins/vibe-kernel-adapter.ts` + `opencode.json` plugin 数组追加）。
- 跑相同 N 个任务。
- 采集同指标。

### 10.3 对比指标

| 指标 | 基线预期 | 实验目标 | 采集方式 |
|---|---|---|---|
| 新会话恢复成功率 | 低（LLM 常忘读状态文件） | ≥95%（注入 + 机械恢复） | **A3 档**：新会话首条输出是否复述 phase 并续跑 |
| 压缩后恢复 | [未验证] | 首次真机验证 E2/E3 | **B2 档**：压缩后首条输出是否带 `[Phase][Loop]` 并继续 |
| 重复测试数 | 高 | ↓（`NO_PROGRESS` 早停） | `repeat_check` 触发次数 |
| 无效工具调用 | 中 | ↓（`vc_state` 代替读文件） | `tool.execute` 次数 |
| token 消耗 | 基线 | ↓（TASK 注入 < 历史回溯） | 会话 token 计数 |
| checkpoint 一致性 | 低 | 100%（Core 原子写 + schema 校验） | 字段完整率 + `STATE_REV_CONFLICT` 次数为 0 |
| 阶段转换缺失 | 无感知 | 可见（提醒次数） | §4.4 `PHASE_TRANSITION_MISSING` 计数 |

**仪表盘复用**：指标记入 memory_tool.py `metrics`（加 `adapter` 分组：`degraded_level`/`compaction_inject`/`recovery_success`/`inject_state_mismatch`）。**降级期间的指标先落本地日志**（§6.3），恢复后补记。

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

- `VIBE_KERNEL_ADAPTER=0` → 插件加载即 no-op（回退 Phase 0），便于 A/B 与故障隔离。
- `VIBE_KERNEL_ADAPTER_LEVEL=L0..L4` → **强制上限**降级级别（调试用；不允许用它绕过 L3 的安全拦截）。
- `VIBE_KERNEL_PYTHON` / `VIBE_KERNEL_HOME` / `VIBE_KERNEL_STATE_DIR` → 环境发现覆盖（§4.6）。

### 11.3 兼容性

- 不破坏现有 advisor 插件（共存，不同 hook/工具名；两者都注册 `tool.execute.after` 时按 §13 U16 实测确认顺序）。
- 不破坏现有 MCP（delx-memory/codegraph 不动）。
- **路径不再硬编码**：Core/Exec 位置按 `VIBE_KERNEL_HOME` → 插件相对路径 → `$HOME/.agents/skills/vibe-coder-loop` 顺序解析（§4.6）。原设计的"经软链解析到本项目"是**开发者机器特权**，不是默认架构。
- `experimental.*` 钩子缺能力时按 §5.4 备选链降级，并在 health 文件中标注实际使用的能力集。

---

## 十二、验收场景

| # | 场景 | 期望 |
|---|---|---|
| A1 | 会话启动 + 状态 active+fresh → **Core 侧** | `load-checkpoint` 返回 `mode=resume`，phase/current_step 正确 |
| A2 | 同上 → **注入侧** | `chat.system.transform` 实际 push 了 TASK 区（日志含字节数与 `phase=S…`） |
| A3 | 同上 → **LLM 行为** | 首条输出复述 phase/current_step 并从该阶段续跑（**不重启任务**） |
| A4 | 会话启动 + stale / degraded | 注入带 `stale`/`degraded` 标识，以用户输入为准 |
| A5 | `vc_transition` 合法（带 exit_checklist + expected_rev） | 写入成功，返回新 `rev` |
| A6 | `vc_transition` 非法跳转 | `STATE_ILLEGAL_TRANSITION`，文件字节不变 |
| A7 | `vc_transition` 缺 exit_checklist 引用 | `EXIT_CHECKLIST_INCOMPLETE`，不落盘 |
| A8 | 两个进程并发写（Adapter 事件 + LLM 工具） | 后者得 `STATE_REV_CONFLICT`，先写者的数据不丢 |
| A9 | `vc_exec(pytest)` | 返回 ExecResult（含 normalized + fingerprint） |
| A10 | `vc_exec` 输出超限 | `OUTPUT_LIMIT` + ref（且 ref 回读校验通过） |
| A11 | `tool.execute.after`（LLM 调 bash）**作为命名 Hook** | 收到 `output.output`，`feed_exec` 记账成功 |
| A12 | 验证 hook 是否真的不经 event | 订阅 `event` 时不出现 `tool.execute.after`；命名 Hook 单独触发 |
| A13 | 压缩触发 | `compacting` 注入 TASK 区；`autocontinue.enabled=true` |
| A14 | 压缩后行为 | 首条输出带 `[Phase][Loop]` 并继续，不重做已完成项 |
| A15 | 注入块与状态文件不一致（模拟过期） | 记录 `inject_state_mismatch`，以状态文件为准 |
| A16 | Core CLI 不可用 | 进入 L2/L3：不阻断会话；**可见提示一次** + 本地 `adapter.log` 有记录 |
| A17 | L3 时调高危工具 | `tool.execute.before` **仍拦截**（安全能力不随降级消失） |
| A18 | `VIBE_KERNEL_ADAPTER=0` | 加载即 no-op，回退 Phase 0 |
| A19 | `experimental.chat.system.transform` 不存在（旧版本宿主） | 回落到 `chat.message`；两者都无 → 明确标注"工具驱动"，**不宣称自动恢复** |
| A20 | `python3` 不在 PATH，仅 `python` 可用 | 按 §4.6 顺序发现成功；全失败 → `ENV_ERROR` + degraded 提示 |
| A21 | 项目路径含空格与中文 | 全链路正常（argv 数组传参） |
| A22 | advisor 插件仍工作 | 共存不冲突 |

**退出条件**：

1. A1–A22 全绿，其中 **A3 / A12 / A14 / A17 / A19 为必测项**（分别对应"注入是否进入上下文""Hook 机制是否用对""压缩后是否真用上""降级是否保留安全""能力缺失是否如实标注"）；
2. `test_hook_contract.py` 通过（注册的 hook 键 ⊆ 本机 typings 的 `Hooks` 键集合）；
3. 基线 vs 实验数据对比显示恢复成功率/重复测试数/token 至少一项显著改善；
4. Skill 协议语义**未被修改**；`opencode.json` 现有配置**未被破坏**。

---

## 十三、未决问题

| # | 问题 | 结论 / 倾向 | 状态 |
|---|---|---|---|
| U13 | `session.idle` 语义 | **已定案**：idle = 一轮响应结束（`SessionStatus` 含 busy/idle 等），不是会话结束。idle 只做心跳与 §4.4 计数，**不写状态** | ✅ 关闭（§4.1） |
| U14 | STATIC 区如何注入 | **已定案**：TASK 用 `experimental.chat.system.transform`；STATIC 仍走 Skill 机制（OpenCode 自动加载 SKILL.md），Adapter 只补 TASK + 指针 | ✅ 关闭（§5.4） |
| U15 | `tool.execute.after` 能否拿到 stdout | **已定案（有边界）**：能拿到 `output.output`（工具输出文本）+ `metadata`，但**不保证完整原始 stdout**（可能被工具层格式化/截断）。故 `feed_exec` 定位为记账/指纹素材，精确执行归 `vc_exec` | ✅ 关闭（§2.0） |
| U16 | 与 advisor 插件的 handler 执行顺序 | 待实测：两者注册不同 hook 键时无冲突；若都注册 `tool.execute.after`，顺序取决于实现，Adapter 不依赖顺序（只 append 记账） | 🟡 待验证（A22） |
| U17 | CLI 输出格式 | **已定案**：单行 JSON + exit code 语义（0/3/4）+ 大入参走 `--*-file` | ✅ 关闭（§七） |
| U24 | `experimental.*` 钩子的 API 稳定性承诺 | 倾向：不承诺；启动时能力探测 + health 文件记录实际能力集；每次升级宿主后跑 A2/A13 回归 | 🟡 待决策 |
| U25 | 注入频率（每轮 pointer vs 仅首次 full） | 倾向：首次 full（一次性标记）+ 常态 pointer；若 token 敏感可关 pointer（`VIBE_KERNEL_INJECT_POINTER=0`） | 🟡 待决策 |
| U26 | 多会话并行（同一项目两个 session） | 倾向：状态文件单实例 → 后开会话读同一状态；若两个会话操作同一任务，`_rev` 冲突会让后写者显式失败（可接受）。真正并行任务留 Phase 4 | 🟡 待决策 |
