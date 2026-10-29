# OpenCode 上下文裁剪（Dedup + Error Purge + Supersede Writes）

> 范围：**重复只读结果去重（Dedup）**、**过期工具错误裁剪（Error Purge）**与**写操作上下文覆盖（Supersede Writes）**。不包含压缩摘要或其他上下文治理策略。
>
> 状态：核心算法与 OpenCode 消息适配已实现并通过 **199 项 Node 测试**；`experimental.chat.messages.transform` 与 `ToolPart` 结构已对照本机安装的类型定义校验。**未在本机用真实模型请求跑通端到端 hook**，限制见「十二、已知限制与未验证行为」。

## 一、结论先行

- 三条策略共用一个 OpenCode 入口与消息提取/裁剪基础设施，但**独立开关、独立预览、独立统计**。
- Dedup 只处理默认白名单 `read` / `grep` / `glob`；Error Purge 只处理**结构化确认**的工具失败；Supersede Writes 只处理**确认成功**的写工具。
- Error Purge **不会**因为输出里出现 `error` / `failed` / `warning` 就判定失败；只认 `ToolPart.state.status === "error"` 且有非空 `state.error`。
- Supersede Writes **只**在同一文件的后续**完整、成功、足够新鲜**的读取之后，抹去旧写操作的正文载荷（`state.input` 的内容字段与 `state.output`），保留文件路径、`status`、callID、metadata、消息顺序与审计身份。
- 过期错误只替换为明确说明原因的占位文本，**保留 `status: "error"`、callID、input、metadata、消息顺序**；不删除消息或 ToolPart。
- 原始会话对象不被修改：Adapter 只克隆受影响的 ToolPart 与消息，再替换本次请求的 `output.messages`。
- 任何结构异常、环境不明确、结果不完整、范围不一致、存在状态变更或引用关系时，**保留原文**。
- 二次执行幂等：占位文本会被识别并跳过。

## 二、架构与接入点

```text
.opencode/
├── package.json                         # "type": "module"，无第三方依赖
├── plugins/
│   └── vibe-context-dedup.js            # 唯一 OpenCode 自动加载入口
└── context-dedup/
    ├── core.js                          # Dedup 纯规则 + 共享签名/token/占位符
    ├── error-purge.js                   # Error Purge 纯规则 + 统计
    ├── supersede-writes.js              # Supersede Writes 纯规则 + 文件身份 + 统计
    ├── config.js                        # 配置解析 / 校验 / 环境变量
    ├── opencode.js                      # 消息提取 / 引用守卫 / 字段应用 / 结构校验 / 组合
    ├── token-usage.js                   # Token 用量测量（纯函数：估算 / usage 提取 / schema / 归因）
    ├── token-usage-log.js               # token-usage-YYYY-MM-DD.jsonl 按 UTC 日追加 + 兼容读取
    └── log.js                           # 聚合 JSONL 日志（无工具输出/错误正文）
tests/context-dedup/
├── core.test.mjs
├── config.test.mjs
├── opencode.test.mjs
├── error-purge.test.mjs
├── error-purge-adapter.test.mjs
├── supersede-writes.test.mjs
├── supersede-writes-adapter.test.mjs
├── logging.test.mjs
├── token-usage.test.mjs
├── token-usage-log.test.mjs
├── token-usage-plugin.test.mjs
└── helpers.mjs                          # 真实 OpenCode 消息结构 fixture
scripts/tests/test-context-dedup.sh      # Node 内置 test runner 门禁
```

| 层 | 职责 | 不依赖 |
|---|---|---|
| `core.js` | Dedup 签名、分组、依赖屏障、正收益判断 | OpenCode hook / SDK / 文件系统 |
| `error-purge.js` | 确认错误、成功/歧义分类、supersession、重复失败、置信度 | OpenCode hook / SDK / 文件系统 |
| `supersede-writes.js` | 确认写入、完整读取判定、文件身份、版本/并发、屏障、正收益 | OpenCode hook / SDK / 文件系统 |
| `opencode.js` | `{info, parts}` 提取、callID 引用扫描、字段克隆替换、结构校验、回退 | 不实现业务规则 |
| `vibe-context-dedup.js` | 注册 `experimental.chat.messages.transform`、加载配置、日志、数组就地替换 | 不直接改消息内容 |

接入点是 OpenCode 的 `experimental.chat.messages.transform` 与 `event`。前者在每次模型请求传输前给出完整 `messages` 数组（裁剪与请求估算都在此度量）；后者在流式终态 `message.updated` 时给出 Runtime 归一化后的 `AssistantMessage.tokens`（真实用量）。`chat.params` / `chat.message` 提供当前请求的 providerID / modelID；本实现改为直接从终态 assistant 消息读取 providerID / modelID，避免对 hook 调用顺序做假设。消息结构来自本机安装的 `@opencode-ai/plugin` / `@opencode-ai/sdk` 类型，而不是文档示例假设：

```text
{ info: Message, parts: Part[] }
ToolPart: { callID, tool, state: ToolState }
ToolStateError: { status: "error", input, error, metadata, time }
ToolStateCompleted: { status: "completed", input, output, title, metadata, time }
```

## 三、Dedup 规则（v1）

候选必须同时满足：

1. ToolPart 有非空 `callID` / `tool`；
2. 工具名在 `tools` 白名单（默认 `read` / `grep` / `glob`，且不在 `mutationTools` 硬拒绝列表）；
3. `state.status === "completed"`；
4. `state.output` 非空且不是占位文本；
5. 能确定 `info.path.cwd`；
6. 参数可规范化。

签名由「工具名 + 规范化参数 + cwd/root + 参数内显式 cwd」组成；路径只做词法规范化，不解析软链、不访问文件系统。同一签名下只有**输出完全一致**的记录进入同组，保留最新一条，裁剪更早的。裁剪前还需：

- 新旧调用之间出现非白名单工具 → 不裁剪；
- 旧 callID 在裁剪点与保留结果之间被后续文本/工具输入/输出/错误/metadata/subtask 引用 → 不裁剪；保留结果之后的引用不阻塞（保留结果内容完全相同，引用仍可解析）；
- 估算旧输出 token 不大于占位符 → 不裁剪。

## 四、Error Purge 规则

### 4.1 确认错误

只把以下情况视为**已确认执行失败**：

- `state.status === "error"`；
- `typeof state.error === "string"` 且去空白后非空；
- 没有结构化取消/中止标记（`metadata.cancelled/canceled/aborted === true`）。

以下情况**不是**确认错误，默认保留：

- `status === "completed"`，即使 `output` 含 `error` / `failed` / `warning`；
- `status === "error"` 但 `error` 为空或缺失；
- `status === "pending"` / `"running"` / 未知；
- `status === "completed"` 但 `metadata` 明确给出失败信号（非零 `exitCode` / `exit_code` / `exit` / `code`、`success:false`、`ok:false`、`failed:true`、`isError:true`、`timedOut:true`、`status:"error"/"failed"`、非空 `error`/`exception`）；
- 取消/中止标记。

后两类计入 `ambiguousResultCount`，不会被用作 superseder。

### 4.2 操作等价

Error Purge 复用 Dedup 的操作签名：**工具名 + 规范化参数 + cwd/root + 参数内显式 cwd**。因此：

- `npm test -- --run unit` 与 `npm test -- --run integration` 不等价；
- `npm run build` 与 `npm run deploy` 不等价；
- 同一命令在不同 cwd/root 不等价。

不猜测语义等价（如 `npm test` 与 `npm run test` 不会合并）。

### 4.3 Supersession（Case A/B/C）

一个确认错误被裁剪，必须同时满足：

1. 存在**更晚**的同一签名记录，且 `status === "completed"`、无结构化失败 metadata；
2. 默认要求错误与成功在**同一 user turn**（`userSegment` 相同）；跨用户轮次默认保留；
3. 默认要求两者之间没有**状态变更工具**；只读白名单工具（由 `tools` 提供）可直接穿过；同一签名的重试不视为屏障；
4. 错误 callID 在后续上下文中**未被引用**；
5. 估算 `state.error` token 数大于占位符；
6. 满足 `minSuccesses`（默认 1；设为 2 可要求连续两次成功）。

满足时：

- `confidence: "high"`；
- 只替换 `state.error` 为“已被后续等价成功取代”的占位文本；
- `state.status` 仍为 `"error"`，保留失败事实，不伪装成成功。

> 默认的 `preserveOnStateChanges: true` 会保留“失败 → 修改代码 → 成功”的旧错误，避免丢失修复依据。需要更激进的裁剪时显式设为 `false`；这会让修复后成功也取代旧错误。

### 4.4 重复相同失败（Case D）

同一签名 + **完全相同** `state.error` 的多个确认错误：

- 保留最新一条错误正文；
- 更早的重复项替换为“较早重复失败已省略，最新等价失败保留”的占位文本；
- `confidence: "medium"`；
- 不在跨 user turn 或存在状态变更屏障时执行；
- 可通过 `pruneRepeatedFailures: false` 关闭。

### 4.5 置信度与保留

| 决策 | 置信度 | 默认策略 |
|---|---|---|
| `superseded_by_success` | high | 通过全部守卫才裁剪 |
| `duplicate_failure` | medium | 保留最新等价失败，裁剪更早重复项 |
| 无后续成功 / 跨轮次 / 状态变更 / 引用 / 范围不一致 / 短文本 | — | 保留 |

统计中分别记录 high/medium 决策数、`preservedCount` 与 `skippedReasons`。

## 四·五、Supersede Writes 规则

### 4.5.1 可覆盖状态

只有同时满足以下条件的写工具记录才进入候选：

1. 工具名在 `supersedeWrites.writeTools`（默认 `write` / `edit` / `multiedit` / `patch` / `apply_patch`）；
2. `state.status === "completed"`，无结构化失败信号（非零 `exitCode` / `success:false` / `failed:true` / `timedOut` / 取消标记等）；
3. `state.input` 是对象，且能解析出文件路径（`filePath` / `path` / `file` / `filename` / `fileName`）；
4. 能确定执行环境 `info.path.cwd`。

失败、超时、取消、pending/running、仅计划未执行的记录**不会**进入待覆盖状态。候选只记录文件身份与操作元数据，**不复制文件正文**。

### 4.5.2 完整读取判定

一次读取只有同时满足以下条件才算“能代表文件当前完整状态”：

1. 工具名在 `supersedeWrites.readTools`（默认仅 `read`；`grep` / `glob` 是部分结果，不参与）；
2. `state.status === "completed"`，无结构化失败信号，`state.output` 非空且不是占位文本；
3. 参数没有 `limit` / `count` / `maxLines` 等显式上限；`offset` / `startLine` / `from` 缺省或为 0/1（从文件头开始）；
4. 结构化元数据未标记 `truncated:true`、`loaded:false`、`partial:true`、`complete:false`；
5. 输出开头或结尾不含明显的截断提示（只用于拒绝，不用于接受）。

行范围读取、分页、片段、截断、读取失败、仅元数据读取、来源不确定的读取**一律不触发**整文件覆盖。当前未实现区间级 Supersede，因此采用保守策略：部分读取不清理任何写上下文。

### 4.5.3 文件身份

文件身份由「规范化路径 + cwd + root」组成：

- 路径先做词法规范化（统一分隔符、折叠 `.`/`..`、相对路径按 cwd 解析）；
- 同一工作区内，`./src/a.ts` 与 `/repo/src/a.ts` 视为同一文件；
- 不同目录下同名文件、不同 `cwd`/`root` 的同名相对路径、大小写不同的路径、软链目标**不做猜测**，一律视为不同文件；
- 路径缺失、`cwd` 缺失或规范化失败 → 无法确认身份，**保留旧上下文**。

### 4.5.4 顺序、版本与并发

- 读取必须满足 `read.time.start >= write.time.end`（真正的 happens-before：写入完成后读取才开始）；时间戳缺失或区间非法时**保留**。
- 写入完成时间晚于读取开始时间 → 视为并发重叠；该读取对**整个文件**不可信，本轮跳过。
- 同一文件的多个历史成功写入，在一次完整读取后可以统一被覆盖（Case B）。
- 读取之后发生的新写入不受该读取影响，保留为新的活跃写上下文（Case C）。
- 读取 A 不清理 B；不同文件的写操作互不影响（Case D）。
- 未提供可靠时间戳（写入 `time.end` 或读取 `time.start` 缺失）时**保留**，不退化到仅凭消息顺序判断。
- 读取之后的外部进程修改无法从消息历史中观察，属于已知限制（见第十二节）。

### 4.5.5 清理边界与屏障

- 覆盖只发生在**本次请求副本**：会话历史与审计记录保留原始写入内容，磁盘文件不被读取或修改；被覆盖的 ToolPart 仍以原 callID、`status: "completed"`、`filePath`、metadata 参与后续追溯。
- 覆盖只替换旧写操作的 **`state.input` 内容字段**（`content` / `oldString` / `newString` / `edits` / `patch` / `diff` 等）与 **`state.output`**，路径字段、`status`、`title`、`metadata`、`time`、`attachments`、callID、tool 全部保留。
- 写入与读取之间出现**任何不能证明是确认成功写入的变更类记录**（`bash` 等广义变更工具、失败/未完成的写入、未知工具、路径无法解析的写入）→ 无法证明读取仍包含写操作的最终结果，按保守策略跳过。
- **确认成功**的同一文件中间写入不是屏障（它也会被同一次读取覆盖）；确认成功的其他文件写入不是屏障（不触碰本文件）。
- 写 callID 在后续文本/工具输入/输出/错误/metadata/subtask 中被引用 → 不清理。
- 估算净节省（载荷 + 输出 − 占位符）≤ 0 → 不清理。
- 清理失败（状态/输入与计划不一致、结构校验失败）→ 返回原始消息数组，不部分应用；统计记录 `apply_*` 原因，后续请求可重试。

### 4.5.6 场景对照

| 序列 | 结果 |
|---|---|
| `Write(A) → Read(A, full)` | 覆盖 A 的写上下文 |
| `Write(A1) → Write(A2) → Read(A, full)` | A1、A2 都被覆盖 |
| `Write(A1) → Read(A, full) → Write(A2)` | 只覆盖 A1，A2 保留 |
| `Write(A) → Write(B) → Read(A, full)` | 只覆盖 A，B 保留 |
| `Write(A) → bash → Read(A, full)` | 保守保留（广义变更屏障） |
| `Write(A) → Read(A, partial)` | 保留（部分读取不算完整） |

## 五、消息安全

- **只改请求副本**：`transformMessages` 不修改输入消息对象；受影响的 `message` 与 `state` 都是浅克隆。
- **不删结构**：不删除消息、不删除 ToolPart、不改变顺序，因此不会产生孤立调用或孤立结果。
- **字段级替换**：
  - Dedup 只改 `state.output`；
  - Error Purge 只改 `state.error`；
  - Supersede Writes 只改 `state.input` 的内容字段与 `state.output`，路径与其余输入字段保持原值；
  - 三条策略都不改 `callID`、`tool`、`state.status`、`title`、`metadata`、`time`、`attachments`。
- **应用后校验**：逐消息、逐 part 检查数量、`info.id`、`callID`、`tool`、`status`、未目标字段；任何不一致 → 返回原始消息数组，统计 `apply_validation_failed`。
- **结构异常 fail-closed**：消息缺少 `info`/`parts`、info.id/role 不合法、ToolPart 缺少 `callID`/`state`、`callID` 重复 → 整体回退，不部分裁剪。
- **数组替换失败回滚**：插件先备份原数组，再就地替换；若运行时不接受或抛错，恢复原内容并记录 `apply_array_mutation_failed`。
- **幂等**：三种占位文本都以 `[vibe-context-dedup]` 开头，二次执行直接跳过。

> 真机语义注意：本实现假设 `experimental.chat.messages.transform` 的 `output.messages` 是本次请求的可修改副本，并沿用参考项目相同的就地修改方式。输入消息对象不被修改这一点由测试保证；数组本身是否与宿主会话共享，属于 Runtime 行为，未在本机真机验证。

## 六、配置

默认读取 `<project>/.opencode/context-dedup.json`；也可用 `VIBE_CONTEXT_DEDUP_CONFIG` 指定路径。文件不存在 → 使用默认值。

```json
{
  "enabled": true,
  "preview": false,
  "tools": ["read", "grep", "glob"],
  "placeholder": "[vibe-context-dedup] Duplicate read-only tool result omitted; an identical newer result is retained later in the conversation.",
  "barrierOnNonWhitelistedTools": true,
  "protectCallIdReferences": true,
  "mutationTools": ["bash", "edit", "write", "patch", "multiedit", "apply_patch", "task", "skill", "webfetch", "websearch", "todowrite", "question"],
  "deduplication": {
    "enabled": true
  },
  "errorPurge": {
    "enabled": true,
    "preview": null,
    "placeholder": "[vibe-context-dedup] Error output omitted: a later equivalent successful result superseded it. The failure status is retained.",
    "duplicatePlaceholder": "[vibe-context-dedup] Earlier duplicate failure output omitted; the latest equivalent failure is retained.",
    "preserveAcrossUserTurns": true,
    "preserveOnStateChanges": true,
    "pruneRepeatedFailures": true,
    "protectReferences": true,
    "minSuccesses": 1
  },
  "supersedeWrites": {
    "enabled": true,
    "preview": null,
    "placeholder": "[vibe-context-dedup] Write context omitted: a later full read of the same file superseded it. The write's success status and file path are retained.",
    "writeTools": ["write", "edit", "multiedit", "patch", "apply_patch"],
    "readTools": ["read"],
    "preserveAcrossUserTurns": false,
    "barrierOnBroadMutations": true,
    "protectReferences": true,
    "requireFullRead": true
  },
  "log": {
    "enabled": true,
    "onlyWhenActive": true,
    "path": null,
    "maxBytes": 524288
  },
  "tokenUsage": {
    "enabled": true,
    "path": null
  }
}
```

| 字段 | 作用 | 缺省 |
|---|---|---|
| `enabled` | 插件总开关（三条策略） | `true` |
| `preview` | 全局观察模式；Dedup 直接使用，Error Purge / Supersede Writes 默认继承 | `false` |
| `tools` | Dedup 只读白名单；同时作为 Error Purge 的“只读工具”集合 | `["read","grep","glob"]` |
| `placeholder` | Dedup 占位文本，必须以 `[vibe-context-dedup]` 开头，≤500 字符 | 见上 |
| `barrierOnNonWhitelistedTools` | Dedup 依赖屏障 | `true` |
| `protectCallIdReferences` | Dedup 引用守卫 | `true` |
| `mutationTools` | Dedup 硬拒绝的变更工具；Error Purge 也将其视为状态变更 | 见上 |
| `deduplication.enabled` | Dedup 独立开关 | `true` |
| `errorPurge.enabled` | Error Purge 独立开关 | `true` |
| `errorPurge.preview` | Error Purge 观察模式；`null`/缺省继承顶层 `preview` | `null` |
| `errorPurge.placeholder` | 成功取代错误时的占位文本 | 见上 |
| `errorPurge.duplicatePlaceholder` | 重复失败占位文本 | 见上 |
| `errorPurge.preserveAcrossUserTurns` | 跨 user turn 时保留旧错误 | `true` |
| `errorPurge.preserveOnStateChanges` | 失败与成功之间存在状态变更工具时保留 | `true` |
| `errorPurge.pruneRepeatedFailures` | 允许裁剪更早的完全重复失败 | `true` |
| `errorPurge.protectReferences` | 旧错误 callID 被后续引用时保留 | `true` |
| `errorPurge.minSuccesses` | 需要多少个后续等价成功才 supersede | `1` |
| `supersedeWrites.enabled` | Supersede Writes 独立开关 | `true` |
| `supersedeWrites.preview` | 观察模式；`null`/缺省继承顶层 `preview` | `null` |
| `supersedeWrites.placeholder` | 写上下文被覆盖时的占位文本 | 见上 |
| `supersedeWrites.writeTools` | 允许进入待覆盖状态的写工具 | `["write","edit","multiedit","patch","apply_patch"]` |
| `supersedeWrites.readTools` | 能触发覆盖的完整读取工具 | `["read"]` |
| `supersedeWrites.preserveAcrossUserTurns` | 跨 user turn 时保留旧写上下文 | `false` |
| `supersedeWrites.barrierOnBroadMutations` | 写与读之间出现任何非只读/非确认成功写入的记录时保留 | `true` |
| `supersedeWrites.protectReferences` | 写 callID 被后续引用时保留 | `true` |
| `supersedeWrites.requireFullRead` | 只允许完整读取触发覆盖（关闭后风险自负） | `true` |
| `log.enabled` | 关闭日志 | `true` |
| `log.onlyWhenActive` | 只在有候选/变更/错误时写日志 | `true` |
| `log.path` | 日志路径；相对路径相对项目根，支持 `~` | `~/.vibe-loop/context-dedup/events.jsonl` |
| `log.maxBytes` | 超过后轮转为 `.1`；`.1` 已存在则暂停追加 | `524288` |
| `tokenUsage.enabled` | 独立的 Token 用量记录开关；与三条裁剪策略互不影响 | `true` |
| `tokenUsage.path` | 基准文件路径；每日文件沿用其目录与基名（`token-usage.jsonl` → `token-usage-YYYY-MM-DD.jsonl`）。相对路径相对项目根，支持 `~`；缺省 `<project>/data/token-usage.jsonl` | `null` |

环境变量：

| 变量 | 作用 |
|---|---|
| `VIBE_CONTEXT_DEDUP_DISABLED=1` | 插件总关闭（不读配置文件） |
| `VIBE_CONTEXT_DEDUP_PREVIEW=1` | 顶层预览（三条策略默认继承） |
| `VIBE_CONTEXT_ERROR_PURGE_DISABLED=1` | 仅关闭 Error Purge |
| `VIBE_CONTEXT_ERROR_PURGE_PREVIEW=1` | 仅 Error Purge 预览 |
| `VIBE_CONTEXT_SUPERSEDE_WRITES_DISABLED=1` | 仅关闭 Supersede Writes |
| `VIBE_CONTEXT_SUPERSEDE_WRITES_PREVIEW=1` | 仅 Supersede Writes 预览 |
| `VIBE_CONTEXT_DEDUP_LOG_DISABLED=1` | 关闭聚合日志 |
| `VIBE_CONTEXT_DEDUP_CONFIG=<path>` | 指定配置文件 |
| `VIBE_TOKEN_USAGE_LOG_DISABLED=1` | 仅关闭 Token 用量记录（裁剪与聚合日志不受影响） |

配置非法（类型错误、白名单为空、占位符不合规等）→ 插件禁用并记录一次 `config_error`，不猜测默认值继续。配置在插件初始化时读取一次；修改后重启 OpenCode。

## 七、统计与日志

每次实际处理生成聚合统计；**不记录**工具输入、错误正文、工具输出、完整路径、session id、凭证。

顶层（Dedup）：

| 字段 | 含义 |
|---|---|
| `deduplicationEnabled` | Dedup 是否启用 |
| `candidateCount` / `duplicateGroupCount` | 候选数 / 完全重复组数 |
| `plannedPruneCount` / `wouldPruneCount` / `prunedCount` | 规则计划 / 引用守卫后 / 实际应用 |
| `skippedReasons` | `unsupported_tool` / `not_completed` / `intervening_side_effect` / `referenced_later` / `no_token_benefit` / `apply_*` 等 |
| `tokenSavingsEstimated` | 实际应用的估算节省 |
| `tokenSavingsEstimatedIfApplied` | 通过守卫的全部决策估算节省 |
| `tokenCounting` | `estimate_heuristic_v1` |
| `actualTokenSavings` | `null`（未接入真实 tokenizer） |
| `outputBytesRemovedActual` | 实际移除的 UTF-8 字节数 |

嵌套 `errorPurge`：

| 字段 | 含义 |
|---|---|
| `enabled` / `preview` / `changed` | 策略开关 / 观察模式 / 是否实际变更 |
| `confirmedErrorCount` | 结构化确认错误数 |
| `ambiguousResultCount` | 空错误、取消、pending/running、completed+failure metadata 等歧义结果数 |
| `candidateCount` | 通过环境/参数检查的候选数 |
| `plannedPruneCount` / `wouldPruneCount` / `prunedCount` | 规则计划 / 引用守卫后 / 实际应用 |
| `preservedCount` | 保留的候选错误数 |
| `highConfidencePruneCount` / `mediumConfidencePruneCount` | 置信度决策数 |
| `decisionKinds` | `superseded_by_success` / `duplicate_failure` 决策计数 |
| `skippedReasons` | `across_user_turn` / `intervening_state_change` / `referenced_later` / `no_token_benefit` / `latest_failure_retained` / `apply_*` 等 |
| `tokenSavingsEstimated` | 实际应用的估算节省（观察模式为 0） |
| `tokenSavingsEstimatedIfApplied` | 通过守卫的决策估算节省 |
| `tokenCounting` / `actualTokenSavings` | 估算标签 / `null` |
| `outputBytesRemovedActual` | 实际移除的 UTF-8 字节数 |

嵌套 `supersedeWrites`：

| 字段 | 含义 |
|---|---|
| `enabled` / `preview` / `changed` | 策略开关 / 观察模式 / 是否实际变更 |
| `confirmedWriteCount` | 结构化确认成功的写操作数 |
| `fullReadCount` | 通过完整读取判定的读取数 |
| `ambiguousResultCount` | 失败写、部分读取、非白名单工具等歧义结果数 |
| `candidateCount` | 可进入待覆盖状态的写记录数 |
| `plannedPruneCount` / `wouldPruneCount` / `prunedCount` | 规则计划 / 引用守卫后 / 实际应用 |
| `preservedCount` | 保留的候选写上下文数 |
| `highConfidencePruneCount` | 高置信度覆盖决策数 |
| `decisionKinds` | `superseded_by_read` 决策计数 |
| `skippedReasons` | `no_superseding_read` / `concurrent_write_overlap` / `intervening_broad_mutation` / `read_not_after_write` / `across_user_turn` / `referenced_later` / `no_token_benefit` / `apply_*` 等 |
| `tokenSavingsEstimated` | 实际应用的估算节省（观察模式为 0） |
| `tokenSavingsEstimatedIfApplied` | 通过守卫的决策估算节省 |
| `tokenCounting` / `actualTokenSavings` | 估算标签 / `null` |
| `outputBytesRemovedActual` | 实际移除的 UTF-8 字节数（输入载荷 + 输出） |

Token 估算：ASCII 约 `1/4 token/字符`，非 ASCII 约 `1 token/字符`，向上取整。**这是估算，不是模型 tokenizer 的真实计数**；`actualTokenSavings: null` 表示真实值不可得。Error Purge 只估算被替换的 `state.error`；Supersede Writes 估算被脱敏的输入内容字段与被替换的 `state.output`，不包含 metadata 中的潜在诊断内容。

日志默认写到 `~/.vibe-loop/context-dedup/events.jsonl`，目录 `0700`、文件创建时 `0600`，超过 `maxBytes` 轮转为 `.1`；若 `.1` 已存在则暂停追加，绝不覆盖已有文件。日志失败不会影响请求。

## 八、测试

```bash
bash scripts/tests/test-context-dedup.sh
# 等价于
node --test tests/context-dedup/*.test.mjs
```

**199 项测试**覆盖（其中 64 项 Token 用量测试见 `token-usage*.test.mjs`，含真实 provider 样本、v2/v3 兼容、按 UTC 日分文件、跨午夜/时区偏移、补写历史、旧日志兼容、损坏行诊断与多进程追加）：

- Dedup：相同工具/参数/成功结果重复；不同参数/工具/环境；失败调用；副作用工具；输出不同；依赖屏障；引用守卫；消息结构；幂等；空/异常输入；预览；配置；日志脱敏；OpenCode 类型契约。
- Error Purge 正向：等价命令/测试/构建成功取代失败；重复相同失败保留最新；多个过期错误；过期与仍相关错误混合。
- Error Purge 负向：无关成功；unit vs integration；build vs deploy；跨 workspace；跨 user turn；状态变更；引用；短错误；空错误；取消/abort；pending/running；completed+diagnostic text；completed+failure metadata；后续失败；缺失/畸形关联。
- Supersede Writes 正向：写后完整读取；连续写入后统一覆盖；跨 user turn 默认允许；相对/绝对路径归一；预览与独立开关。
- Supersede Writes 负向：写入失败/超时/pending；重复写入后新写入保留；读取 A 不清理 B；同名不同目录/不同 workspace；行范围/offset/limit/截断/空输出/读取失败；读取早于写入或与写入重叠；并发写入；广义变更屏障；引用守卫；路径无法解析；净收益不足；二次执行幂等；状态不一致回退。
- 结构/回归：call/result 关联与字段保持；消息顺序；独立关闭；观察模式；重复应用幂等；三条策略同请求独立生效；插件 hook 就地应用；日志不落错误正文或文件内容。

环境契约测试读取本机安装的 `@opencode-ai/plugin` 与 SDK 类型，断言 hook 与 `ToolPart` 字段存在；未安装类型时跳过，不伪造通过。

## 九、手工验证（真机）

1. 先保持 `preview: true`，让模型在同一 user turn 内执行失败命令（如 `npm test`），再执行同一命令并成功。
2. 查看 `~/.vibe-loop/context-dedup/events.jsonl`：应出现 `errorPurge.confirmedErrorCount >= 1`、`wouldPruneCount >= 1`、`prunedCount: 0`、`preview: true`。
3. 改为 `"preview": false`，重复操作；日志应出现 `errorPurge.prunedCount >= 1`、`tokenSavingsEstimated > 0`。
4. 检查会话历史：消息数量、工具调用/结果数量和顺序不变；失败 ToolPart 的 `status` 仍为 `error`，但请求副本中的 `state.error` 变为占位文本；最新成功结果保留。
5. 在失败与成功之间插入一次编辑或一条新的用户消息，确认默认保留旧错误。
6. 再跑一次相同请求：`prunedCount: 0`，确认幂等。
7. 保持 `preview: true`，让模型写入一个文件，再在同一或后续 user turn 完整读取该文件。
8. 查看日志：应出现 `supersedeWrites.confirmedWriteCount >= 1`、`fullReadCount >= 1`、`wouldPruneCount >= 1`、`prunedCount: 0`。
9. 改为 `"preview": false` 重复写入+完整读取；请求副本中写 ToolPart 的 `state.input.content` 与 `state.output` 变为占位文本，`filePath` / `status` / metadata 不变；磁盘文件内容不受影响。
10. 尝试 `write → read(offset/limit)`、`write → bash → read`、`write → read → write`，确认部分读取/变更屏障/新写入均保留；再跑一次确认幂等。
11. 如无日志：用 `opencode --print-logs` 确认本地插件是否加载。

## 十、Token 用量记录（token-usage-YYYY-MM-DD.jsonl）

> 范围：**仅数据采集**。不实现 CLI、仪表盘、图表、分析报告或后台服务。不影响裁剪决策。

### 采集时机与关联

- `experimental.chat.messages.transform`：在传输前对完整 `messages` 数组做**前后估算**，并读取本轮 `result.stats` 形成 pruning 归因；按 sessionID 暂存一次（消费一次，避免多步重试重复计数）。
- `event`（`message.updated`）：assistant 消息终态（`time.completed` 存在，或带 `error`）时写一条记录；同一 attempt 的重复回调按 `message id + attempt` 去重。流式中间更新（未终态）不写记录。
- `event`（`session.retry.scheduled`）：记录下一次 attempt。失败 attempt 与重试成功 attempt 各写一条记录；成功记录带 `attempt` > 1，不会被失败记录抑制。没有重试时 `attempt` 省略（等价于 1）。
- 同一 transform 测量最多关联到一条 usage 记录（`pendingPrune.take` 消费式取出）。

### 真实用量来源

Runtime 把所有 provider 归一化为 `AssistantMessage.tokens{ total, input, output, reasoning, cache:{ read, write } }`。原始 provider JSON 不暴露给插件，但 `tokens.total`、`tokens.input` 等是 Runtime 归一化后的真实上游数值，不是本地估算。

配置实测：provider `CPMAC-API` / `aspire-coding-shenzhen`（本地 OpenAI 兼容代理 `http://127.0.0.1:8317/v1`），模型 `deepseek-flash`。

**真实 provider 样本（2026-10-28，非流式）**：

```json
{"prompt_tokens":1936,"completion_tokens":8,"total_tokens":1944,
 "completion_tokens_details":{"reasoning_tokens":8},
 "prompt_tokens_details":{"cached_tokens":1920}}
```

Runtime 归一化为：

```json
{"total":1944,"input":16,"output":0,"reasoning":8,
 "cache":{"read":1920,"write":0}}
```

说明：`prompt_tokens` 是**输入总量**（含缓存），Runtime 把 `input` 存为**未缓存部分**（1936 − 1920 = 16）；`completion_tokens` 是**输出总量**（含推理），当前 Runtime 把 `output` 存为**可见输出**（8 − 8 = 0），`reasoning` 单独存放。

字段取值（schema v3，归一化后）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `input_tokens` | `provider_usage_derived` | **输入总量** = `tokens.input + cache.read + cache.write`；包含缓存 |
| `output_tokens` | `provider_usage_derived` | **输出总量** = `tokens.total − input_tokens`；包含 reasoning |
| `total_tokens` | `provider_usage`（有 total）/ `provider_usage_derived`（无 total） | 优先使用 Runtime `tokens.total`；仅在无 total 且无歧义时本地派生 `input_tokens + output_tokens` |
| `cached_input_tokens` | `provider_usage` | 本次请求的 `cache.read`，是 `input_tokens` 的**子集**，不是跨请求累计值 |
| `uncached_input_tokens` | `provider_usage` | `tokens.input`（未缓存输入），是 `input_tokens` 的**子集** |
| `cache_write_tokens` | `provider_usage`（可选键） | `cache.write`，是 `input_tokens` 的**子集**；显式 0 也会保留 |
| `reasoning_tokens` | `provider_usage` | `tokens.reasoning`，是 `output_tokens` 的**子集**；0 为有效计费值 |

> **归一化规则（v3）**：`cached_input_tokens + uncached_input_tokens + cache_write_tokens = input_tokens`；`reasoning_tokens <= output_tokens`；`input_tokens + output_tokens = total_tokens`。这解决了 v2 中 `input_tokens` 实际是未缓存值、`output_tokens` 实际是可见输出、`total_tokens` 靠本地加法的问题。
>
> **旧 Runtime schema**：OpenCode 消息数据（`~/.local/share/opencode/opencode-prod.db`）显示，2026-07-28 之前的记录中 `output = completion_tokens`（已含 reasoning），`total = input + cache + output`；之后的记录中 `output = 可见输出`，`total = input + cache + output + reasoning`。两种 schema 都通过 `output_tokens = total − input_tokens` 归一化；直接用 `input + cache + output + reasoning` 会把旧 schema 的 reasoning 重复计入（实测 55,419 条真实记录中有 8,769 条会因此过计）。
>
> **总输入/总输出**：`input_tokens` 和 `output_tokens` 是派生值，来源标记为 `provider_usage_derived`；`total_tokens` 在有 Runtime total 时来源为 `provider_usage`，不再无条件本地求和。

`usage_status`（schema v3）：

| 状态 | 含义 |
|---|---|
| `actual` | 输入/输出总量可计算，Runtime total（或 reasoning=0 时的无歧义派生 total）与分量一致，且至少一个分量 > 0 |
| `partial` | 部分字段可得，但总量或某些分量无法验证（如 total 缺失且 reasoning > 0、cache 字段缺失） |
| `missing` | 无可用 provider 用量（终态无 tokens / 流式中止未终态 / info 缺失） |
| `unverified` | 字段存在但**全部分量为 0**，或 Runtime total 与分量不一致；**不得作为真实用量聚合** |
| `estimated` | 仅有本地估算 |

校验规则（仅标记，**绝不钳制或编造**）：

- `cached_input_tokens > input_tokens`：归一化后**不应出现**；若出现说明输入总量推导或字段映射异常。
- `reasoning_tokens > output_tokens`：归一化后**不应出现**；raw `tokens.output` 可能小于 reasoning（它是可见输出），但归一化 `output_tokens` 是总输出。
- `total_tokens < input_tokens` → `total_lt_input_total`，状态 `unverified`。
- Runtime total 既不等于 `input_total + output` 也不等于 `input_total + output + reasoning` → `total_component_mismatch`，状态 `unverified`；原始值写入 `validation.raw`，不静默修正。
- total 缺失且 `reasoning > 0` → `total_missing_reasoning_scope_unknown`，状态 `partial`，`output_tokens`/`total_tokens` 为 `unavailable`，不猜测 reasoning 是否已包含在 output 中。
- 任一 cache 字段缺失 → `input_total_unverified`，状态 `partial`，不把缺失当作 0。
- **全部分量为 0** → `usage_zero_unverified`：Runtime 把 `tokens` 初始化为全 0，终态全零几乎总是 provider 未上报用量（流式无 final usage / 纯工具轮）。原始 0 值保留但状态不为 `actual`。
- 数值校验：拒绝非有限数、负数、字符串类型；`nonNegativeNumber` 返回 null（不可用）而非 0。
- 异常记录会带 `validation: { rule, raw: { input, output, reasoning, cache_read, cache_write, total }, derived: { input_total, output_total } }`，用于定位异常字段和原始值。

### 估算（fallback）

优先级：provider_usage > 估算 > null。当前**未接入真实 tokenizer**（避免引入大依赖），统一使用字符权重估算 `char_weight_v1`：

- 按 **Unicode 码点**计数（UTF-16 `charCodeAt` + 显式代理对处理，等价于 `for…of` 码点迭代）；
- ASCII 码点权重 `0.25`，非 ASCII 码点权重 `1`，向上取整；
- 同一公式用于 `context_estimates.before/after_pruning` 与 `pruning.*.removed_tokens`，保证口径一致。

> **schema v2/v3 估算语义**：这些值是**估算 Token 数**（`ceil(weighted_units)`），不是字符数。来源标签由 v1 的 `estimated_char_count` 改为 `estimated_tokens_from_chars`，避免「字符计数」与「Token 估算」混淆。`estimator: "char_weight_v1"` 标注公式版本；原始字符数（`countCodePoints`）当前不入记录，`estimated_char_count` 来源保留给未来真存字符计数的字段。

**这是未经验证的临时启发式**：对中文接近 1 token/字符，对英文约 4 字符/token，但对代码、JSON、工具输出混合内容偏差未知；需用真实 DeepSeek 用量样本校准后再视为可靠。

`context_estimates` 只覆盖 `messages` 数组可见的 text / subtask.prompt / tool 的 output·error·input(JSON)；**不包含**系统提示、工具 schema、provider 序列化、多模态 payload、运行时生成的隐藏上下文。因此估算与 provider 计费不保证吻合。

### 归因（无双重计数）

- Dedup 只替换 `state.output`（completed），Error Purge 只替换 `state.error`（error），Supersede Writes 只替换写工具的 `state.input` 内容字段与 `state.output`；三条策略**作用于不同记录/不同字段**，按执行顺序 `["deduplication", "error_purge", "supersede_writes"]` 求和不会重复计数。
- `removed_tokens` 是**净节省**（被替换内容 − 占位符），来自既有 `tokenSavingsEstimated`，不等于“真实输入 token 节省”（实际还受 system prompt、工具定义、provider 序列化、缓存等影响）。
- `candidate_tokens` / `preserved_tokens` 记为 `unavailable`：既有管道未保留每条候选的 token 量，且**不为此改动裁剪规则**。
- 当某策略有 `removed_items > 0` 但 `removed_tokens` 不可得时，`total_removed_tokens` 记为 `unavailable`（不编造 0）。

### 存储（按 UTC 自然日分文件）

- **唯一写入入口**：`createUsageLogger().append(record)`。每次追加都从记录自身的 `timestamp`（事件时间）计算 UTC 自然日，再选择 `token-usage-YYYY-MM-DD.jsonl`；**不使用写入时的系统日期**。
- 默认目录为 `<project>/data/`，基准路径为 `token-usage.jsonl`，因此默认文件是 `<project>/data/token-usage-YYYY-MM-DD.jsonl`。`tokenUsage.path` 只改变目录与基名：配置 `logs/usage.jsonl` → `logs/usage-YYYY-MM-DD.jsonl`。
- **日期与时区**：统一按 UTC 自然日归档。`2026-10-28T23:59:59.999Z` → `2026-10-28`；`2026-10-29T00:00:00.000Z` → `2026-10-29`；带偏移的 `2026-10-28T23:30:00-02:00` → `2026-10-29`（先换算为 UTC）。毫秒不参与日期判断。
- **无效时间戳**：缺失、无法解析或**没有显式 `Z`/时区偏移**的时间戳会被拒绝（`record_timestamp_invalid`），不会按设备本地时区猜测日期，也不写入任何文件。记录的 `timestamp` 原值不被修改。
- **仅追加**：每个日期文件一次 `appendFile`，进程内串行化（promise 链）；已存在的日期文件继续追加，永不覆盖或清空。父目录只惰性创建一次，写入路径不扫描历史文件。
- **空日期不建文件**；跨天、补写、重放事件按各自事件日期落盘。
- 父目录 `0700`、文件 `0600` 创建；写入失败**不抛出**，经限频（5 分钟一次）回写聚合日志的 `error: token_usage_log_failed:*`。
- **并发范围**：同一插件实例的写入完全串行；跨进程依赖本地文件系统的 `O_APPEND` 单次小写入原子性（网络文件系统不保证）。本期不引入文件锁、常驻进程或数据库。
- **旧日志兼容**：升级前的单文件 `<project>/data/token-usage.jsonl` 保留原样，不迁移、不删除、不覆盖。`readUsageLog()` 统一读取旧文件与每日文件；同一条记录（逐字节相同）只计一次。旧文件没有日期索引，按范围读取时会扫描它并按记录时间过滤；每日文件按文件名日期选择，备份/临时/不符合命名规则的文件一律忽略。损坏行、非对象行、无效时间戳、文件名与记录日期不一致都会进入 `invalid` 诊断列表，不会被静默转成有效记录。
- 记录中**不含** prompt、tool 输出正文、原始响应、错误正文、文件路径、凭证；未知键一律丢弃。

### AspireCode 会话上下文面板对照

AspireCode 的会话上下文面板（`context.stats.*`）使用的是**最近一条有 usage 的 assistant 消息**，不是会话累计。其 `tokenTotal` 为：

```js
msg.tokens.input + msg.tokens.output + msg.tokens.reasoning +
msg.tokens.cache.read + msg.tokens.cache.write
```

真实样本（DB 消息 `msg_1821cf259001T9OlgAKobbcujv`，与截图完全一致）：

| 面板字段 | 原值 | v3 归一化含义 |
|---|---|---|
| 输入 token | 155 | 未缓存输入；总输入 = 155 + 99,968 + 0 = 100,123 |
| 输出 token | 4,074 | 可见输出；总输出 = 107,099 − 100,123 = 6,976 |
| 推理 token | 2,902 | 输出子集 |
| 缓存读/写 | 99,968 / 0 | 输入子集 |
| 总 token | 107,099 | `tokens.total`，等于 100,123 + 6,976 |
| 使用率 | 11% | `round(107,099 / 1,000,000 × 100)` |

面板的“上下文拆分”用 `input=155` 作为分母，但字符估算遍历的是全部会话消息，因此百分比不是 107k 上下文的构成，而是按 155 缩放后的字符比例。优化方向：使用 `input_tokens`（100,123）作为分母并注明“按字符估算，含缓存上下文”，或明确标注为“未缓存输入拆分”。会话累计 token/成本应单独展示，不能与当前上下文混在同一组标签下。

### 记录示例（schema v3；字段均为占位示意，非真实值）

```json
{
  "schema_version": 3,
  "event_type": "model_request_usage",
  "timestamp": "2026-10-28T12:00:00.000Z",
  "session_id": "ses_…",
  "request_id": "msg_…",
  "provider": "CPMAC-API",
  "model": "deepseek-flash",
  "transport": "opencode_provider",
  "usage_status": "actual",
  "input_tokens": { "value": 12500, "source": "provider_usage_derived" },
  "output_tokens": { "value": 720, "source": "provider_usage_derived" },
  "total_tokens": { "value": 13220, "source": "provider_usage" },
  "cached_input_tokens": { "value": 3000, "source": "provider_usage" },
  "uncached_input_tokens": { "value": 9500, "source": "provider_usage" },
  "cache_write_tokens": { "value": 0, "source": "provider_usage" },
  "reasoning_tokens": { "value": 120, "source": "provider_usage" },
  "context_estimates": {
    "before_pruning": { "value": 10000, "source": "estimated_tokens_from_chars" },
    "after_pruning": { "value": 9500, "source": "estimated_tokens_from_chars" }
  },
  "pruning": {
    "order": ["deduplication", "error_purge", "supersede_writes"],
    "deduplication": {
      "enabled": true, "preview": false,
      "scanned_records": 47,
      "candidate_items": 2, "removed_items": 1, "preserved_items": 1,
      "candidate_tokens": { "value": null, "source": "unavailable" },
      "removed_tokens": { "value": 300, "source": "estimated_tokens_from_chars" },
      "preserved_tokens": { "value": null, "source": "unavailable" },
      "skipped": {
        "record_scan": { "unsupported_tool": 40, "not_completed": 5 },
        "candidate": { "referenced_later": 1 },
        "application": {}
      }
    },
    "error_purge": {
      "enabled": true, "preview": false,
      "scanned_records": 47, "candidate_items": 0, "removed_items": 0, "preserved_items": 0,
      "removed_tokens": { "value": 0, "source": "estimated_tokens_from_chars" },
      "skipped": { "record_scan": {}, "candidate": {}, "application": {} }
    },
    "supersede_writes": {
      "enabled": true, "preview": false,
      "scanned_records": 47, "candidate_items": 1, "removed_items": 1, "preserved_items": 0,
      "removed_tokens": { "value": 180, "source": "estimated_tokens_from_chars" },
      "skipped": { "record_scan": {}, "candidate": {}, "application": {} }
    },
    "total_removed_tokens": { "value": 480, "source": "estimated_tokens_from_chars" },
    "measurement_source": "estimated_tokens_from_chars",
    "attribution": "incremental_sequential",
    "token_unit_note": "removed_tokens and total_removed_tokens are estimated token counts from char_weight_v1, not character counts or billed usage."
  },
  "estimator": "char_weight_v1",
  "errors": []
}
```

### 字段语义（schema v3）

**usage_status**：见上文；`unverified` 表示字段存在但全零或未通过一致性校验，**不可作为真实用量聚合**。`actual` 表示 Runtime 归一化用量完整且通过一致性校验，不等于「已与原始 HTTP 响应逐字节比对」；原始值仅在异常时通过 `validation.raw` 保留。

**pruning 计数单位**：

| 字段 | 单位 | 说明 |
|---|---|---|
| `scanned_records` | 扫描的工具记录数 | 进入策略视野的全部 ToolPart（含被排除的 bash/edit 等） |
| `candidate_items` | 合格候选数 | 通过工具白名单/状态/环境/参数校验的记录 |
| `removed_items` | 实际裁剪数 | 被替换为占位符的决策数 |
| `preserved_items` | 保留候选数 | `candidate_items − removed_items` |
| `skipped.record_scan` | 扫描记录数 | 被排除的扫描记录（`unsupported_tool` 计 bash/edit 等非白名单调用，**可合法大于 `candidate_items`**） |
| `skipped.candidate` | 候选/分组数 | 合格候选被守卫拦截（`referenced_later` / `no_token_benefit` / `across_user_turn` 等） |
| `skipped.application` | 应用阶段决策数 | apply 时因 location/state/校验失败被丢弃 |
| `removed_tokens` | 估算 Token 数（净） | `Σ estimate(previousValue) − estimate(placeholder)`，来源 `estimated_tokens_from_chars` |
| `candidate_tokens` / `preserved_tokens` | — | 恒为 `unavailable`：管道未保留每候选 token 量，不为此改动裁剪规则 |

> **v1 → v2 变更**：`schema_version` 1→2；估算来源 `estimated_char_count`→`estimated_tokens_from_chars`（值是 Token 估算而非字符数）；`usage_status` 的 `unavailable`→`missing`，新增 `unverified`；`pruning.*.skipped_reasons`（扁平、单位混淆）→ `skipped.{record_scan,candidate,application}`（按单位分桶），新增 `scanned_records`。
>
> **v2 → v3 变更**：`input_tokens` 从「未缓存输入」改为「输入总量」；`output_tokens` 从「Runtime 原始 output（当前版本为可见输出）」改为「输出总量（含 reasoning）」；`total_tokens` 优先采用 Runtime `tokens.total`（无 total 时才派生）；`cache_write_tokens` 显式保留 0；新增可选 `attempt`（重试 attempt > 1 时）与异常时的 `validation`。字段名和记录结构不变，v1/v2 旧记录仍按原样可读；`readUsageLog` 不按版本过滤，新旧记录可共存于同一每日文件。分析旧记录时：v2 的总输入 = `input_tokens + cached_input_tokens + cache_write_tokens`，总输出 = `output_tokens + reasoning_tokens`；v3 已直接给出总量。

### 当前环境不可得 / 待验证的字段

- `uncached_input_tokens`：**已用真实样本确认**：DeepSeek 返回 `prompt_tokens=1936`、`cached_tokens=1920`，Runtime `tokens.input=16`，即 `input` 是未缓存输入；`input_tokens` 的输入总量 1936 = 16 + 1920。
- `cached_input_tokens` 与 `input_tokens`：**已确认是子集关系**（v3 不变量 `cached <= input_tokens`）。`cached` 是本次请求的缓存命中量，不是跨请求累计值；真实样本中两次请求的 `cached` 为 1152、1920，而非 1152、3072。
- `reasoning_tokens`：**已确认是 `output_tokens` 的子集**（v3 不变量 `reasoning <= output_tokens`）。Runtime 的 raw `tokens.output` 是可见输出，可能小于 reasoning（真实样本 `output=0, reasoning=8`），但归一化 `output_tokens` 是总输出 8。
- `reasoning_tokens=0`：仍无法区分「provider 未上报」与「显式 0」——Runtime 统一归一化为 number。在已确认非零用量的记录中 0 作为有效计费值保留（`provider_usage`）；全零记录标记 `unverified`。
- provider 原始字段：真实样本确认 OpenAI 兼容代理返回 `prompt_tokens` / `completion_tokens` / `total_tokens` / `prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens`。Runtime 二进制中 OpenAI-compatible 映射为 `prompt_tokens_details?.cached_tokens ?? prompt_cache_hit_tokens ?? cached_tokens ?? cache_read_input_tokens`；`cache_creation_input_tokens` 映射到 `cache.write`。`prompt_cache_miss_tokens` 未被 Runtime 直接读取，Runtime 用 `nonCached = prompt_tokens - cache` 派生。
- 旧 Runtime schema：2026-07-28 之前的消息数据中 `output` 已含 reasoning、`total` 不含独立 reasoning；当前 Runtime 已改为 `output=可见输出`、`total` 含 reasoning。适配器用 `total - input_total` 统一两种 schema，但**没有按 Runtime 版本硬编码分支**；若未来版本再次改变字段含义，需要新增真实样本验证。
- 完整请求估算：`experimental.chat.messages.transform` 不含系统提示与工具 schema，故 `context_estimates` 为 messages 子集估算，非完整请求。
- `transport` 固定为 `"opencode_provider"`：插件进程内看不到实际 wire 协议。
- 多步工具循环中 transform 与终态 message 的配对依赖 sessionID + 消费一次语义。
- 重试 attempt：依赖 `session.retry.scheduled` 事件携带的 `assistantMessageID` / `attempt`。若 Runtime 未来改变该事件 shape，`attempt` 可能退回 1，导致同一 message id 的多次 attempt 被去重；已用单测覆盖当前 shape。

## 十二、已知限制与未验证行为

**已限制/明确不做：**

- 只把 `status === "error"` + 非空 `state.error` 视为确认失败；`completed` 结果即使包含错误文本也不按文本分类。
- `completed` + 结构化失败 metadata 视为歧义并保留，不以它作为 superseder；不尝试解析未知 metadata 语义。
- 操作等价只做精确签名（工具 + 规范化参数 + cwd/root），不做语义命令归一化。
- 默认保留“失败 → 修改代码/状态变更 → 成功”的旧错误；需要更激进时设 `preserveOnStateChanges: false`。
- 默认保留跨 user turn 的旧错误；需要时设 `preserveAcrossUserTurns: false`。
- 单个后续成功默认足以 supersede；无法可靠识别 intermittent/flaky failure。需要更严格时设 `minSuccesses: 2`。
- 无法可靠识别自然语言引用；使用 callID 引用扫描、user-turn 屏障、状态变更屏障作为保守代理。
- 执行环境只建模 `cwd` / `root` / 参数内显式 `cwd`；不建模环境变量、`.gitignore`、网络状态。
- 只替换 `state.error`，不清理 `state.metadata` 中可能存在的堆栈/诊断字段；token 节省仅针对错误正文。
- Supersede Writes 只脱敏写工具输入中的已知内容字段（`content` / `oldString` / `newString` / `edits` / `patch` / `diff` / `input` 等）与 `state.output`；未知形状的写工具输入即使成功也不会被覆盖。
- 完整读取判定依赖 `read` 工具的参数（`offset` / `limit`）与结构化 metadata（`truncated` / `loaded` / `partial` / `complete`）。若宿主不提供这些信号，只按“无 offset/limit 且输出非空”判定，超大文件被静默截断时无法识别；可通过 `requireFullRead` 保持默认保守策略。
- 文件版本仅由 `state.time`（写入完成时间、读取开始时间）推断；不读取磁盘 mtime、内容哈希或文件系统锁。读取之后的外部进程修改无法从消息历史中观察，因此不额外失效已经完成的覆盖。
- 同一文件的中间写入会与更早写入一起被后续完整读取覆盖；这是预期行为（读取代表最终状态），但不是区间级 Supersede。
- 未实现区间级上下文追踪；部分读取一律不清理整文件写上下文。
- 只支持当前 `{ info, parts }` / `ToolPart` 结构；若宿主改成独立 tool-role 消息，会安全 no-op。
- 没有真实 tokenizer；所有 token 节省都是估算。Token 用量记录的 `context_estimates` / `pruning` 估算同样使用 `char_weight_v1` 启发式，未用真实 DeepSeek 用量校准。
- Token 用量记录的 provider usage 来自 Runtime 归一化结果（`tokens.total` / `input` / `output` / `cache.read` / `reasoning`）。真实样本确认 OpenAI 兼容代理会透传 `prompt_tokens_details.cached_tokens` 与 `completion_tokens_details.reasoning_tokens`；Runtime 再归一化为未缓存 input 与可见 output。
- 历史 v2 记录（schema v2，修复前写入）的 `input_tokens` 实际是未缓存输入、`output_tokens` 实际是 Runtime 原始 output（当前 Runtime 为可见输出），`total_tokens` 为本地加法总和。这些记录保留原值不迁移；分析时需按 v2 语义换算（总输入 = `input_tokens + cached_input_tokens + cache_write_tokens`，总输出 = `output_tokens + reasoning_tokens`）。v3 新记录已直接给出总量。
- 旧 Runtime（2026-07-28 之前）的消息数据中 `output` 已含 reasoning，`total` 不含独立 reasoning；v3 适配器用 `total - input_total` 归一化，未按版本硬编码。若上游代理改变 `total` 的定义，必须用真实响应样本重新验证。
- 裁剪会改变请求前缀，可能影响 provider 的 prompt cache。

**未在本机真机验证：**

- `experimental.chat.messages.transform` 的真实调用时机、`output.messages` 是否为请求副本、就地修改是否被宿主采纳。
- 实际模型请求下的端到端裁剪与 token 计费变化。
- 与其他插件（如 advisor、DCP）同时加载时的 handler 顺序与叠加效果。
- OpenCode 各工具实际写入 `state.metadata` 的失败信号形态；当前只做保守的结构化歧义判断。

**已验证：**

- 本机安装的 `@opencode-ai/plugin` 类型定义中存在该 hook，消息结构为 `{ info: Message, parts: Part[] }`。
- 本机安装的 SDK 类型中 `ToolPart` 含 `callID`、`tool`、`state`；错误态含 `status: "error"` 与 `error: string`，完成态含 `status: "completed"` 与 `output: string`。
- 参考项目 `opencode-dynamic-context-pruning` 使用同一 hook 并就地修改 `output.messages`。
- Node/Bun 可加载插件入口并注册 hook；199 项 Node 测试通过；原始消息对象不被修改、结构校验与回退路径有测试覆盖。

## 十三、卸载 / 回滚

- 删除或移走 `.opencode/plugins/vibe-context-dedup.js` 即可停止插件；`.opencode/context-dedup/` 可一并移走。
- 只关闭 Error Purge：设置 `"errorPurge": {"enabled": false}`，Dedup / Supersede Writes 不受影响。
- 只关闭 Dedup：设置 `"deduplication": {"enabled": false}`，Error Purge / Supersede Writes 不受影响。
- 只关闭 Supersede Writes：设置 `"supersedeWrites": {"enabled": false}`（或 `VIBE_CONTEXT_SUPERSEDE_WRITES_DISABLED=1`），前两条策略不受影响。
- 不需要数据库迁移，不写会话存储，不修改项目源码。
- 只关闭 Token 用量记录：设置 `"tokenUsage": {"enabled": false}`（或 `VIBE_TOKEN_USAGE_LOG_DISABLED=1`），裁剪与聚合日志不受影响。
- 日志在 `~/.vibe-loop/context-dedup/`，可按需清理；Token 用量记录在 `<project>/data/token-usage-YYYY-MM-DD.jsonl`（旧单文件 `token-usage.jsonl` 保留），均可按需清理；这不是项目资产。
