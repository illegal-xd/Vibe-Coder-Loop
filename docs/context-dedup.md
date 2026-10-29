# OpenCode 上下文裁剪（Dedup + Error Purge + Supersede Writes）

> 范围：**重复只读结果去重（Dedup）**、**过期工具错误裁剪（Error Purge）**与**写操作上下文覆盖（Supersede Writes）**。不包含压缩摘要或其他上下文治理策略。
>
> 状态：核心算法与 OpenCode 消息适配已实现并通过 **262 项 Node 测试**；`experimental.chat.messages.transform` 与 `ToolPart` 结构已对照本机安装的类型定义校验。**未在本机用真实模型请求跑通端到端 hook**，限制见「十二、已知限制与未验证行为」。

## 一、结论先行

- 三条策略共用一个 OpenCode 入口与消息提取/裁剪基础设施，但**独立开关、独立预览、独立统计**。
- Dedup 只处理默认白名单 `read` / `grep` / `glob`；Error Purge 只处理**结构化确认**的工具失败；Supersede Writes 只处理**确认成功**的写工具。
- Error Purge **不会**因为输出里出现 `error` / `failed` / `warning` 就判定失败；只认 `ToolPart.state.status === "error"` 且有非空 `state.error`。
- Supersede Writes **只**在同一文件的后续**完整、成功、足够新鲜**的读取之后，抹去旧写操作的正文载荷（`state.input` 的内容字段与 `state.output`），保留文件路径、`status`、callID、metadata、消息顺序与审计身份。
- Error Purge 只把确认失败的 `state.error` 替换为说明原因的占位文本；当输入载荷的裁剪收益为正时，同时抹去该失败调用输入中的大体积字符串（路径与标识字段保留）。`status: "error"`、callID、metadata、消息顺序均不改变；不删除消息或 ToolPart。
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
5. error 文本或失败调用的输入载荷至少有一项带来正收益（error 文本小于占位符时保留原文，只裁剪输入）；
6. 满足 `minSuccesses`（默认 1；设为 2 可要求连续两次成功）。

满足时：

- `confidence: "high"`；
- 替换 `state.error` 为“已被后续等价成功取代”的占位文本；若失败调用的输入仍含大体积字符串，同时替换为输入占位文本；
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
| `stale_failure_input` | medium | 仅在 `staleInputAfterUserTurns` 开启时裁剪输入，error 原文保留 |
| 无后续成功 / 跨轮次 / 状态变更 / 引用 / 范围不一致 / 短文本 | — | 保留 |

统计中分别记录 high/medium 决策数、`preservedCount` 与 `skippedReasons`。

### 4.6 失败调用的输入载荷

上游 DCP 的 Error Purge 只裁剪失败调用的 **input**；本实现此前只处理 error 文本。现在两条规则命中时，会同时评估输入载荷：

- 只替换**顶层字符串**中 token 估算大于占位符的字段；
- `filePath` / `path` / `file` / `filename` / `fileName` / `cwd` / `root` / `pattern` / `glob` / `include` / `exclude` / `query` / `url` / `name` / `id` / `description` 永不替换；
- 对象结构与字段类型不变，`state.input` 只做字段值替换；
- 安全性来自签名等价：命中的 keeper（后续成功或最新的同签名失败）携带**相同参数**，被抹去的载荷在上下文中仍然可得；
- 收益独立计算：`error` 文本小于占位符时保留原文，只裁剪输入；两项都没有正收益则不产生决策（`no_token_benefit`）；
- `errorPurge.redactInputPayload: false` 可整体关闭输入裁剪。

### 4.7 可选：按 user turn 年龄清理陈旧失败输入

上游按“轮次阈值”裁剪失败输入。本实现默认不采用**无证据**裁剪，但提供等价的 opt-in 规则：

```json
{ "errorPurge": { "staleInputAfterUserTurns": 4 } }
```

- 仅处理**确认错误**；`error` 原文、`status`、callID、metadata 全部保留；
- 年龄 = 最新 `userSegment` − 该错误的 `userSegment`，达到阈值才处理；
- 只裁剪 4.6 定义的“大体积字符串”，路径与标识字段保留；
- 默认 `null`（关闭）；开启后每个决策计入 `decisionKinds.stale_failure_input`，输入使用独立的 `staleInputPlaceholder`（不声称存在“更新的等价调用”）；
- 与 Rule 1 / Rule 2 互斥：已有证据的候选先按高/中置信度规则处理。



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
3. `offset` / `startLine` / `from` 缺省，或为 0/1（从文件头开始）；大于 1 即显式片段，一律拒绝；
4. 结构化元数据未标记 `truncated:true`、`loaded:false`、`partial:true`、`complete:false`；
5. 输出开头或结尾不含明显的截断提示（只用于拒绝，不用于接受）；
6. **完整性的结构性证明**（按顺序取一个）：
   - 运行时显式报告未截断：`metadata.truncated === false`（OpenCode 的 `read` 工具对每个读取都会写入 `metadata.truncated`，是该运行时可靠的 EOF 信号）；或
   - `metadata.display` 给出 `{ lineStart, lineEnd, totalLines }` 且 `lineStart <= 1` 且 `lineEnd >= totalLines`；或
   - **遗留形态**：既无 `offset` 也无 `limit`（无切片参数的读取）。

> **运行时注意**：OpenCode 会把 `offset`（默认 1）与 `limit`（按剩余行数计算的上限）规范化进**每一次**读取的 `state.input`。因此**不能**仅凭 `state.input.limit` 出现就判定为片段读取——那会让全部读取被拒绝、Supersede Writes 贡献恒为 0。`limit` 只在缺少上述 EOF 证明时才作为保守拒绝依据（拒绝原因 `read_limited`）。被拒绝的读取原因记入 `stats.readRejectedReasons` 与 `skippedReasons`（`read_truncated` / `read_partial_offset` / `read_partial_range` / `read_limited` / `read_invalid_candidate` 等）。

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

## 附：与上游 DCP 的对照（复查记录）

参照仓库：`opencode-dynamic-context-pruning`（`@tarquinen/opencode-dcp` v3.2.0，HEAD `f8232fd`）。上游只有 `deduplicate` 与 `purgeErrors` 两条自动策略，**没有 Supersede Writes**（`grep -i supersede` 只命中占位文案），因此 Supersede 只能与本实现的既有规则对照。

| 维度 | 上游 DCP | 本实现 | 结论 |
|---|---|---|---|
| Dedup 条件 | 同 tool + 规范化参数即裁剪旧项、保留最新 | 额外要求输出**逐字节相同**，且中间无副作用屏障 | 本实现更严格，不采用“同参必同结果”假设 |
| 参数归一化 | 丢弃 `undefined`/`null`，递归排序 key | 递归排序 key；`undefined` 删除、`null` 保留 | 对齐；`null` 差异只会少裁剪 |
| 受保护工具 | `strategies.*.protectedTools`（默认 `[]`） | 顶层 `protectedTools`（三条策略共用，支持 glob） | 已补齐 |
| 受保护文件 | `protectedFilePatterns`（默认 `[]`；覆盖 filePath/path、multiedit.edits、apply_patch.patchText、execute.toolCalls） | 同名顶层字段，另支持项目相对路径 | 已补齐 |
| Error Purge 主体 | 按**轮次年龄**裁剪失败调用 input，保留 error 文本 | 按“后续等价成功”裁剪 error 文本 + 失败 input；年龄规则为 opt-in | 默认保持证据模型，年龄规则可显式开启 |
| 失败输入清理范围 | 所有 string 字段（含路径） | 仅大于占位符的字符串；路径/标识字段保留 | 本实现更保守 |
| edit/write 输出 | `pruneToolOutputs` 永不替换 edit/write 的 output | Supersede 在完整读取验证后替换写 output | 本实现有证据门槛 |
| 回合保护 | `turnProtection`（默认关闭，按 step 年龄） | 无独立开关；Dedup 保留最新一份，Error/Supersede 需后续证据 | 记录为差异，不引入无证据裁剪 |
| 手动模式 | `manualMode.automaticStrategies` | 无命令体系，不适用 | 不适用 |
| question 输入 | 对已裁剪的 question 替换 `input.questions` | 没有规则会标记 question | 不适用 |
| 统计口径 | 累计 `stats.totalPruneTokens` | 每请求 scanned/eligible/candidate/marked/changed 漏斗 + 跳过原因 | 本实现更细 |
| 应用方式 | 就地修改，无结构校验 | 克隆 + 逐字段结构校验 + 失败回退 | 本实现更严格 |

复查结论：三项策略的核心语义未被上游证伪；真正缺失的是**受保护工具/文件**这道用户侧安全阀，以及 Error Purge 对**失败调用输入载荷**的覆盖。两者已按上面的更保守口径补齐，默认值不改变既有行为。

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
  "protectedTools": [],
  "protectedFilePatterns": [],
  "deduplication": {
    "enabled": true
  },
  "errorPurge": {
    "enabled": true,
    "preview": null,
    "placeholder": "[vibe-context-dedup] Error output omitted: a later equivalent successful result superseded it. The failure status is retained.",
    "duplicatePlaceholder": "[vibe-context-dedup] Earlier duplicate failure output omitted; the latest equivalent failure is retained.",
    "inputPlaceholder": "[vibe-context-dedup] Failed call input omitted: an equivalent newer call retains the same arguments. The failure status is retained.",
    "staleInputPlaceholder": "[vibe-context-dedup] Failed call input omitted: the failure is older than the retention window. The failure status and error message are retained.",
    "redactInputPayload": true,
    "staleInputAfterUserTurns": null,
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
| `protectedTools` | 三条策略共用：工具名（支持 `*`/`?` glob）永不裁剪 | `[]` |
| `protectedFilePatterns` | 三条策略共用：文件 glob 永不裁剪；匹配原始参数、cwd 绝对路径与项目相对路径 | `[]` |
| `deduplication.enabled` | Dedup 独立开关 | `true` |
| `errorPurge.enabled` | Error Purge 独立开关 | `true` |
| `errorPurge.preview` | Error Purge 观察模式；`null`/缺省继承顶层 `preview` | `null` |
| `errorPurge.placeholder` | 成功取代错误时的占位文本 | 见上 |
| `errorPurge.duplicatePlaceholder` | 重复失败占位文本 | 见上 |
| `errorPurge.inputPlaceholder` | 规则 1/2 命中时失败调用输入的占位文本 | 见上 |
| `errorPurge.staleInputPlaceholder` | 年龄规则命中时失败调用输入的占位文本（错误原文保留） | 见上 |
| `errorPurge.redactInputPayload` | 命中规则时是否同时裁剪失败调用的大体积输入字符串 | `true` |
| `errorPurge.staleInputAfterUserTurns` | 可选：确认错误超过 N 个 user turn 后只裁剪其输入（error 原文保留）；`null` 关闭 | `null` |
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
| `log.maxBytes` | 超过后按 `.1`→`.3` 顺序轮转；全部占用时继续追加主文件，绝不覆盖/删除已有文件 | `524288` |
| `tokenUsage.enabled` | 独立的 Token 用量记录开关；与三条裁剪策略互不影响 | `true` |
| `tokenUsage.path` | 基准文件路径；每日文件沿用其目录与基名（`token-usage.jsonl` → `token-usage-YYYY-MM-DD.jsonl`）。相对路径相对项目根，支持 `~`；缺省 `~/.config/opencode/token-usage/token-usage.jsonl`（跨项目共享归档） | `null` |

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
| `VIBE_TOKEN_USAGE_HOME=<dir>` | 重定位 Token 用量归档目录（缺省 `~/.config/opencode/token-usage`；测试/非标准 HOME 使用） |

配置非法（类型错误、白名单为空、占位符不合规等）→ 插件禁用并记录一次 `config_error`，不猜测默认值继续。配置在插件初始化时读取一次；修改后重启 OpenCode。

## 七、统计与日志

每次实际处理生成聚合统计；**不记录**工具输入、错误正文、工具输出、完整路径、session id、凭证。

**统一计数漏斗**（顶层 Dedup、`errorPurge`、`supersedeWrites` 均遵循）：

| 漏斗步 | 字段 | 含义 |
|---|---|---|
| 扫描 | `recordsTotal` | 进入策略视野的全部 ToolPart |
| 合格 | `eligibleCount` | 通过工具白名单/状态/环境/参数校验的记录（= 旧 `candidateCount`） |
| 可裁剪候选 | `prunableCount` | 真正可进入裁剪判定的对象：Dedup=处于完全重复组内的记录（`duplicateCandidateCount`）；Error Purge=存在后续等价成功的错误（`potentialSupersedeCount`）；Supersede=与某条完整读取同身份的写（`fileMatchCount`） |
| 标记 | `markedCount`（= `plannedPruneCount`） | 通过全部守卫后产生的决策数 |
| 变更 | `prunedCount` / `changedCount` | 实际改动了请求副本的决策数（观察模式为 0） |

> **不要把 `eligibleCount`（合格）当作可裁剪数量**：多数会话里合格记录远多于可裁剪候选（例如 Dedup 的合格读取几乎都不构成完全重复组，Supersede 的合格写入也未必有后续同文件完整读取）。`removed_items` 仅在 `changed` 时累加。`candidate_items` 一律指**可裁剪候选**，而非合格记录，避免“候选 18 / 裁剪 0”被误读为故障。

顶层（Dedup）：

| 字段 | 含义 |
|---|---|
| `deduplicationEnabled` | Dedup 是否启用 |
| `candidateCount` / `eligibleCount` | 合格记录数（旧字段保留，新字段为漏斗步） |
| `duplicateGroupCount` / `duplicateCandidateCount` | 完全重复组数 / 组内记录数（可裁剪候选） |
| `uniqueSignatureCount` / `sameSignatureDifferentOutputCount` | 合格记录中“签名唯一”/“签名相同但输出不同”的数量（解释为何不可裁剪） |
| `sameSignatureDifferentOutputGroups` | 同签名不同输出的签名组数 |
| `markedCount` / `plannedPruneCount` / `wouldPruneCount` / `prunedCount` / `changedCount` | 标记 / 规则计划 / 引用守卫后 / 实际应用 / 实际变更 |
| `skippedReasons` | `unsupported_tool` / `unique_signature` / `same_target_args_changed`（同工具同路径但参数窗口不同）/ `same_signature_different_output` / `intervening_side_effect` / `protected_tool` / `protected_path` / `referenced_later` / `no_token_benefit` / `cross_strategy_conflict` / `apply_*` 等 |
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
| `candidateCount` / `eligibleCount` | 合格候选错误数 |
| `potentialSupersedeCount` / `prunableCount` | 存在后续等价成功的候选数（可裁剪候选） |
| `markedCount` / `plannedPruneCount` / `wouldPruneCount` / `prunedCount` / `changedCount` | 标记 / 规则计划 / 引用守卫后 / 实际应用 / 实际变更 |
| `preservedCount` | 保留的候选错误数 |
| `highConfidencePruneCount` / `mediumConfidencePruneCount` | 置信度决策数 |
| `decisionKinds` | `superseded_by_success` / `duplicate_failure` / `stale_failure_input` 决策计数 |
| `inputRedactedCount` | 决策中同时裁剪了失败调用输入载荷的数量 |
| `skippedReasons` | `no_success_for_signature`（同工具无更晚成功）/ `later_success_args_changed`（同工具有更晚成功但参数不等价）/ `success_only_before_error` / `across_user_turn` / `intervening_state_change` / `insufficient_successes` / `protected_tool` / `protected_path` / `referenced_later` / `no_token_benefit` / `latest_failure_retained` / `cross_strategy_conflict` / `apply_*` 等（未归类者记 `no_superseding_evidence`） |
| `tokenSavingsEstimated` | 实际应用的估算节省（观察模式为 0） |
| `tokenSavingsEstimatedIfApplied` | 通过守卫的决策估算节省 |
| `tokenCounting` / `actualTokenSavings` | 估算标签 / `null` |
| `outputBytesRemovedActual` | 实际移除的 UTF-8 字节数 |

嵌套 `supersedeWrites`：

| 字段 | 含义 |
|---|---|
| `enabled` / `preview` / `changed` | 策略开关 / 观察模式 / 是否实际变更 |
| `confirmedWriteCount` | 结构化确认成功的写操作数 |
| `ambiguousWriteCount` / `ambiguousResultCount` | 歧义写数 / 歧义写+读总和 |
| `observedReadCount` / `confirmedReadCount` / `fullReadCount` | 观测读取 / 确认成功读取 / 通过完整读取判定 |
| `readRejectedReasons` | 读取被拒原因：`read_truncated` / `read_partial_offset` / `read_partial_range` / `read_limited` / `read_invalid_candidate` / `read_not_loaded` 等 |
| `candidateCount` / `eligibleCount` | 可进入待覆盖状态的写记录数（合格） |
| `fileMatchCount` / `prunableCount` | 与某条完整读取同身份的写数（可裁剪候选） |
| `versionVerifiedCount` | 通过完整性+身份+版本（happens-before、无重叠、无屏障）校验的对数 |
| `markedCount` / `plannedPruneCount` / `wouldPruneCount` / `prunedCount` / `changedCount` | 标记 / 规则计划 / 引用守卫后 / 实际应用 / 实际变更 |
| `preservedCount` | 保留的候选写上下文数 |
| `highConfidencePruneCount` | 高置信度覆盖决策数 |
| `decisionKinds` | `superseded_by_read` 决策计数 |
| `skippedReasons` | `no_superseding_read`（该文件从未被读）/ `read_not_full`（只有部分读取）/ `read_before_write`（完整读取全部早于写入）/ `concurrent_write_overlap` / `intervening_broad_mutation` / `read_not_after_write` / `across_user_turn` / `protected_tool` / `protected_path` / `referenced_later` / `no_token_benefit` / `cross_strategy_conflict` / `apply_*` 等 |
| `tokenSavingsEstimated` | 实际应用的估算节省（观察模式为 0） |
| `tokenSavingsEstimatedIfApplied` | 通过守卫的决策估算节省 |
| `tokenCounting` / `actualTokenSavings` | 估算标签 / `null` |
| `outputBytesRemovedActual` | 实际移除的 UTF-8 字节数（输入载荷 + 输出） |

**跨策略去重**：Dedup 改写已完成只读工具的 `state.output`；Error Purge 改写失败工具的 `state.error`；Supersede Writes 改写已完成写工具的 `state.input`+`state.output`。三者目标域互不相交，且 `transformMessages` 在决策阶段用 `attributedIds` 集合显式排除已被某策略认领的记录（`cross_strategy_conflict`），保证同一 ToolPart 不被多策略重复计入 `removed_tokens`。

Token 估算：ASCII 约 `1/4 token/字符`，非 ASCII 约 `1 token/字符`，向上取整。**这是估算，不是模型 tokenizer 的真实计数**；`actualTokenSavings: null` 表示真实值不可得。Error Purge 只估算被替换的 `state.error`；Supersede Writes 估算被脱敏的输入内容字段与被替换的 `state.output`，不包含 metadata 中的潜在诊断内容。

日志默认写到 `~/.vibe-loop/context-dedup/events.jsonl`，目录 `0700`、文件创建时 `0600`；超过 `maxBytes` 时按 `.1`→`.3` 顺序轮转，全部归档位被占用时继续追加到主文件（**不再因为 `.1` 已存在而永久停写**），绝不覆盖已有文件。写入路径缓存目录状态与已写字节数，避免每次请求重复 `mkdir`/`stat`。日志失败不会影响请求。

## 八、测试

```bash
bash scripts/tests/test-context-dedup.sh
# 等价于
node --test tests/context-dedup/*.test.mjs
```

**262 项测试**覆盖（其中 Token 用量测试见 `token-usage*.test.mjs`，含真实 provider 样本、v2/v3/v4 兼容、按 UTC 日分文件、跨午夜/时区偏移、补写历史、旧日志兼容、损坏行诊断与多进程追加）：

- Dedup：相同工具/参数/成功结果重复；不同参数/工具/环境；失败调用；副作用工具；输出不同；依赖屏障；引用守卫；消息结构；幂等；空/异常输入；预览；配置；日志脱敏；OpenCode 类型契约。
- 保护规则：glob（`**`/`*`/`?`）匹配；multiedit/apply_patch/execute 路径提取；工具名与路径保护在三条策略中一致生效；默认空列表不改变行为。
- Error Purge 正向：等价命令/测试/构建成功取代失败；重复相同失败保留最新；多个过期错误；过期与仍相关错误混合；失败输入载荷脱敏（大字符串替换、路径保留、短错误只裁输入）；可选年龄规则。
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
- v4 删除了恒为 `unavailable` 的 `candidate_tokens` / `preserved_tokens`：管道未保留每条候选的 token 量，重复的空 holder 只增加记录体积；漏斗计数已足以表达候选/保留数量。
- 当某策略有 `removed_items > 0` 但 `removed_tokens` 不可得时，`total_removed_tokens` 记为 `unavailable`（不编造 0）。

### 存储（按 UTC 自然日分文件）

- **唯一写入入口**：`createUsageLogger().append(record)`。每次追加都从记录自身的 `timestamp`（事件时间）计算 UTC 自然日，再选择 `token-usage-YYYY-MM-DD.jsonl`；**不使用写入时的系统日期**。
- **跨项目统一归档**：默认目录为 `~/.config/opencode/token-usage/`，基准路径为 `token-usage.jsonl`，因此默认文件是 `~/.config/opencode/token-usage/token-usage-YYYY-MM-DD.jsonl`；**不再写入各项目的 `data/` 目录**。`VIBE_TOKEN_USAGE_HOME` 可重定位归档根目录；`tokenUsage.path` 只改变目录与基名：配置 `logs/usage.jsonl` → `logs/usage-YYYY-MM-DD.jsonl`（相对项目根）。
- **日期与时区**：统一按 UTC 自然日归档。`2026-10-28T23:59:59.999Z` → `2026-10-28`；`2026-10-29T00:00:00.000Z` → `2026-10-29`；带偏移的 `2026-10-28T23:30:00-02:00` → `2026-10-29`（先换算为 UTC）。毫秒不参与日期判断。
- **无效时间戳**：缺失、无法解析或**没有显式 `Z`/时区偏移**的时间戳会被拒绝（`record_timestamp_invalid`），不会按设备本地时区猜测日期，也不写入任何文件。记录的 `timestamp` 原值不被修改。
- **仅追加**：每个日期文件一次 `appendFile`，进程内串行化（promise 链）；已存在的日期文件继续追加，永不覆盖或清空。父目录只惰性创建一次，写入路径不扫描历史文件。
- **空日期不建文件**；跨天、补写、重放事件按各自事件日期落盘。
- 父目录 `0700`、文件 `0600` 创建；写入失败**不抛出**，经限频（5 分钟一次）回写聚合日志的 `error: token_usage_log_failed:*`。
- **并发范围**：同一插件实例的写入完全串行；跨进程依赖本地文件系统的 `O_APPEND` 单次小写入原子性（网络文件系统不保证）。本期不引入文件锁、常驻进程或数据库。
- **旧日志兼容**：归档目录内的旧单文件 `token-usage.jsonl` 保留原样，不迁移、不删除、不覆盖；`readUsageLog()` 统一读取它与每日文件。历史项目内 `data/token-usage-*.jsonl` 不再自动读取；如需保留历史，可手动复制到归档目录（逐字节相同的记录只计一次）。旧文件没有日期索引，按范围读取时会扫描它并按记录时间过滤；每日文件按文件名日期选择，备份/临时/不符合命名规则的文件一律忽略。损坏行、非对象行、无效时间戳、文件名与记录日期不一致都会进入 `invalid` 诊断列表，不会被静默转成有效记录。
- 记录中**不含** prompt、tool 输出正文、原始响应、错误正文、文件路径、凭证；未知键一律丢弃。

### 卡片服务（实时读取归档）

- 启动：`bash scripts/token-usage/serve_card.sh`（等价 `node tools/token-usage-card/server.mjs`），默认监听 `http://127.0.0.1:8787/`。
- 参数：`--port <n>`（默认 8787，0 为随机端口）、`--host <addr>`（默认 `127.0.0.1`）、`--data-dir <dir>`（默认 `VIBE_TOKEN_USAGE_HOME` 或 `~/.config/opencode/token-usage`）。
- 数据链路：`GET /api/usage` **每次请求都重新读取**归档 JSONL，响应 `Cache-Control: no-store`；页面每 15 秒静默刷新，页面隐藏时暂停，重新可见时立即刷新，也可点“刷新”按钮。不再依赖预生成的 `token-usage-data.js`。
- 静态资源仅允许 `/`、`/index.html`、`/app.js`、`/styles.css`；其余路径 404，不做目录遍历。仅监听本机回环地址，不暴露到网络。
- 诊断：`GET /api/health` 返回归档目录；`GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` 支持 UTC 日期范围（仅用于按需裁剪返回量，页面默认返回全部再由前端按本地自然日过滤）。
- 离线快照（可选）：`python3 scripts/token-usage/export_card_data.py` 仍可生成 `token-usage-data.js`（同一行契约），但页面默认不加载；仅在无 Node 服务时用于手工注入。

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

### 记录示例（schema v4；字段均为占位示意，非真实值）

```json
{
  "schema_version": 4,
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
      "eligible_items": 2, "candidate_items": 2, "marked_items": 1, "changed_items": 1, "removed_items": 1, "preserved_items": 1,
      "removed_tokens": { "value": 300, "source": "estimated_tokens_from_chars" },
      "skipped": {
        "record_scan": { "unsupported_tool": 40, "not_completed": 5 },
        "candidate": { "referenced_later": 1 },
        "application": {}
      }
    },
    "error_purge": {
      "enabled": true, "preview": false,
      "scanned_records": 47, "eligible_items": 0, "candidate_items": 0, "marked_items": 0, "changed_items": 0, "removed_items": 0, "preserved_items": 0,
      "removed_tokens": { "value": 0, "source": "estimated_tokens_from_chars" },
      "skipped": { "record_scan": {}, "candidate": {}, "application": {} }
    },
    "supersede_writes": {
      "enabled": true, "preview": false,
      "scanned_records": 47, "eligible_items": 1, "candidate_items": 1, "marked_items": 1, "changed_items": 1, "removed_items": 1, "preserved_items": 0,
      "writes": { "confirmed": 1, "ambiguous": 0, "eligible": 1, "file_matches": 1, "version_verified": 1, "marked": 1, "changed": 1 },
      "reads": { "observed": 1, "full": 1, "rejected_reasons": {} },
      "removed_tokens": { "value": 180, "source": "estimated_tokens_from_chars" },
      "skipped": { "record_scan": {}, "candidate": {}, "application": {} }
    },
    "total_removed_tokens": { "value": 480, "source": "estimated_tokens_from_chars" },
    "measurement_source": "estimated_tokens_from_chars",
    "attribution": "incremental_sequential",
    "token_unit": "estimated_tokens_char_weight_v1"
  },
  "estimator": "char_weight_v1",
  "errors": []
}
```

### 字段语义（schema v4）

**usage_status**：见上文；`unverified` 表示字段存在但全零或未通过一致性校验，**不可作为真实用量聚合**。`actual` 表示 Runtime 归一化用量完整且通过一致性校验，不等于「已与原始 HTTP 响应逐字节比对」；原始值仅在异常时通过 `validation.raw` 保留。

**pruning 计数单位**：

| 字段 | 单位 | 说明 |
|---|---|---|
| `scanned_records` | 扫描的工具记录数 | 进入策略视野的全部 ToolPart（含被排除的 bash/edit 等） |
| `eligible_items` | 合格记录数 | 通过工具白名单/状态/环境/参数校验的记录 |
| `candidate_items` | 可裁剪候选数 | 真正可进入裁剪判定的对象（Dedup=完全重复组内记录；Error Purge=存在后续等价成功的错误；Supersede=与某条完整读取同身份的写）。旧记录无此字段时卡片回退为 `eligible_items` |
| `marked_items` | 标记决策数 | 通过全部守卫后产生的决策数；旧记录无此字段时回退为 `removed_items` |
| `changed_items` / `removed_items` | 实际裁剪数 | 真正改动了请求副本的决策数（`removed_items` 为兼容别名，等于 `changed_items`） |
| `preserved_items` | 保留候选数 | `candidate_items − changed_items` |
| `writes.*`（仅 Supersede） | 写漏斗 | `confirmed` / `eligible` / `file_matches` / `version_verified` / `marked` / `changed` |
| `reads.*`（仅 Supersede） | 读漏斗 | `observed` / `full` / `rejected_reasons`（`read_truncated` 等） |
| `skipped.record_scan` | 扫描记录数 | 被排除的扫描记录（`unsupported_tool` 计 bash/edit 等非白名单调用，**可合法大于 `candidate_items`**） |
| `skipped.candidate` | 候选/分组数 | 合格候选被守卫拦截（`unique_signature` / `same_target_args_changed` / `same_signature_different_output` / `no_success_for_signature` / `later_success_args_changed` / `read_not_full` / `read_before_write` / `intervening_side_effect` / `no_token_benefit` / `across_user_turn` 等） |
| `skipped.application` | 应用阶段决策数 | apply 时因 location/state/校验失败被丢弃 |
| `removed_tokens` | 估算 Token 数（净） | `Σ estimate(previousValue) − estimate(placeholder)`，来源 `estimated_tokens_from_chars` |
| `token_unit` | — | v4 固定为 `estimated_tokens_char_weight_v1`；说明 `removed_tokens` 是估算 Token 数，不是字符数，也不是计费值 |

> **卡片行契约**：`server.mjs` 的 `buildCardPayload()` 与可选的 `export_card_data.py` 每策略写 `[removed_tokens, scanned_records, candidate_items, removed_items, eligible_items, marked_items]`；旧四列记录由 `app.js` 回退为 `candidate_items`/`removed_items`，不编造数字。

> **v1 → v2 变更**：`schema_version` 1→2；估算来源 `estimated_char_count`→`estimated_tokens_from_chars`（值是 Token 估算而非字符数）；`usage_status` 的 `unavailable`→`missing`，新增 `unverified`；`pruning.*.skipped_reasons`（扁平、单位混淆）→ `skipped.{record_scan,candidate,application}`（按单位分桶），新增 `scanned_records`。
>
> **v2 → v3 变更**：`input_tokens` 从「未缓存输入」改为「输入总量」；`output_tokens` 从「Runtime 原始 output（当前版本为可见输出）」改为「输出总量（含 reasoning）」；`total_tokens` 优先采用 Runtime `tokens.total`（无 total 时才派生）；`cache_write_tokens` 显式保留 0；新增可选 `attempt`（重试 attempt > 1 时）与异常时的 `validation`。字段名和记录结构不变，v1/v2 旧记录仍按原样可读；`readUsageLog` 不按版本过滤，新旧记录可共存于同一每日文件。分析旧记录时：v2 的总输入 = `input_tokens + cached_input_tokens + cache_write_tokens`，总输出 = `output_tokens + reasoning_tokens`；v3 已直接给出总量。
>
> **v3 → v4 变更**：`pruning.*` 删除恒为 `unavailable` 的 `candidate_tokens` / `preserved_tokens`，记录尾部 150 字符的 `token_unit_note` 收敛为固定短字段 `token_unit`；计数与 `removed_tokens`/`total_removed_tokens` 的语义不变。v1–v3 旧记录仍可读，卡片按缺失字段回退。

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
- Error Purge 只替换 `state.error` 与失败调用输入中的大体积顶层字符串；不清理 `state.metadata` 中可能存在的堆栈/诊断字段，也不重写数组/对象型输入（如 `multiedit.edits`）。
- 受保护规则按工具名与文件路径匹配；无法从参数中解析出路径的工具不会被 `protectedFilePatterns` 命中。
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
- Node/Bun 可加载插件入口并注册 hook；262 项 Node 测试通过；原始消息对象不被修改、结构校验与回退路径有测试覆盖。

## 十三、卸载 / 回滚

- 删除或移走 `.opencode/plugins/vibe-context-dedup.js` 即可停止插件；`.opencode/context-dedup/` 可一并移走。
- 只关闭 Error Purge：设置 `"errorPurge": {"enabled": false}`，Dedup / Supersede Writes 不受影响。
- 只关闭 Dedup：设置 `"deduplication": {"enabled": false}`，Error Purge / Supersede Writes 不受影响。
- 只关闭 Supersede Writes：设置 `"supersedeWrites": {"enabled": false}`（或 `VIBE_CONTEXT_SUPERSEDE_WRITES_DISABLED=1`），前两条策略不受影响。
- 不需要数据库迁移，不写会话存储，不修改项目源码。
- 只关闭 Token 用量记录：设置 `"tokenUsage": {"enabled": false}`（或 `VIBE_TOKEN_USAGE_LOG_DISABLED=1`），裁剪与聚合日志不受影响。
- 日志在 `~/.vibe-loop/context-dedup/`，可按需清理；Token 用量记录统一在 `~/.config/opencode/token-usage/token-usage-YYYY-MM-DD.jsonl`（旧单文件 `token-usage.jsonl` 保留），均可按需清理；这不是项目资产。卡片通过 `scripts/token-usage/serve_card.sh` 启动本地 Node 服务实时读取该目录（可选离线快照脚本 `scripts/token-usage/export_card_data.py` 也从该目录读取）。
