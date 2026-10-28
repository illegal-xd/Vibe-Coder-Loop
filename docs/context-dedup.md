# OpenCode 上下文裁剪（Dedup + Error Purge）

> 范围：**重复只读结果去重（Dedup）**与**过期工具错误裁剪（Error Purge）**。不包含 Supersede Writes、压缩摘要或其他上下文治理策略。
>
> 状态：核心算法与 OpenCode 消息适配已实现并通过 **83 项 Node 测试**；`experimental.chat.messages.transform` 与 `ToolPart` 结构已对照本机安装的类型定义校验。**未在本机用真实模型请求跑通端到端 hook**，限制见「十、已知限制与未验证行为」。

## 一、结论先行

- 两条策略共用一个 OpenCode 入口与消息提取/裁剪基础设施，但**独立开关、独立预览、独立统计**。
- Dedup 只处理默认白名单 `read` / `grep` / `glob`；Error Purge 只处理**结构化确认**的工具失败。
- Error Purge **不会**因为输出里出现 `error` / `failed` / `warning` 就判定失败；只认 `ToolPart.state.status === "error"` 且有非空 `state.error`。
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
- 旧 callID 被后续文本/工具输入/输出/错误/metadata/subtask 引用 → 不裁剪；
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

## 五、消息安全

- **只改请求副本**：`transformMessages` 不修改输入消息对象；受影响的 `message` 与 `state` 都是浅克隆。
- **不删结构**：不删除消息、不删除 ToolPart、不改变顺序，因此不会产生孤立调用或孤立结果。
- **字段级替换**：
  - Dedup 只改 `state.output`；
  - Error Purge 只改 `state.error`；
  - `callID`、`tool`、`state.status`、`state.input`、`title`、`metadata`、`time`、`attachments`、另一字段全部保持原引用/原值。
- **应用后校验**：逐消息、逐 part 检查数量、`info.id`、`callID`、`tool`、`status`、未目标字段；任何不一致 → 返回原始消息数组，统计 `apply_validation_failed`。
- **结构异常 fail-closed**：消息缺少 `info`/`parts`、info.id/role 不合法、ToolPart 缺少 `callID`/`state`、`callID` 重复 → 整体回退，不部分裁剪。
- **数组替换失败回滚**：插件先备份原数组，再就地替换；若运行时不接受或抛错，恢复原内容并记录 `apply_array_mutation_failed`。
- **幂等**：两种占位文本都以 `[vibe-context-dedup]` 开头，二次执行直接跳过。

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
| `enabled` | 插件总开关（两条策略） | `true` |
| `preview` | 全局观察模式；Dedup 直接使用，Error Purge 默认继承 | `false` |
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
| `log.enabled` | 关闭日志 | `true` |
| `log.onlyWhenActive` | 只在有候选/变更/错误时写日志 | `true` |
| `log.path` | 日志路径；相对路径相对项目根，支持 `~` | `~/.vibe-loop/context-dedup/events.jsonl` |
| `log.maxBytes` | 超过后轮转为 `.1`；`.1` 已存在则暂停追加 | `524288` |
| `tokenUsage.enabled` | 独立的 Token 用量记录开关；与两条裁剪策略互不影响 | `true` |
| `tokenUsage.path` | 基准文件路径；每日文件沿用其目录与基名（`token-usage.jsonl` → `token-usage-YYYY-MM-DD.jsonl`）。相对路径相对项目根，支持 `~`；缺省 `<project>/data/token-usage.jsonl` | `null` |

环境变量：

| 变量 | 作用 |
|---|---|
| `VIBE_CONTEXT_DEDUP_DISABLED=1` | 插件总关闭（不读配置文件） |
| `VIBE_CONTEXT_DEDUP_PREVIEW=1` | 顶层预览（两条策略默认继承） |
| `VIBE_CONTEXT_ERROR_PURGE_DISABLED=1` | 仅关闭 Error Purge |
| `VIBE_CONTEXT_ERROR_PURGE_PREVIEW=1` | 仅 Error Purge 预览 |
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

Token 估算：ASCII 约 `1/4 token/字符`，非 ASCII 约 `1 token/字符`，向上取整。**这是估算，不是模型 tokenizer 的真实计数**；`actualTokenSavings: null` 表示真实值不可得。Error Purge 只估算被替换的 `state.error`，不包含 metadata 中的潜在诊断内容。

日志默认写到 `~/.vibe-loop/context-dedup/events.jsonl`，目录 `0700`、文件创建时 `0600`，超过 `maxBytes` 轮转为 `.1`；若 `.1` 已存在则暂停追加，绝不覆盖已有文件。日志失败不会影响请求。

## 八、测试

```bash
bash scripts/tests/test-context-dedup.sh
# 等价于
node --test tests/context-dedup/*.test.mjs
```

**136 项测试**覆盖（其中 48 项 Token 用量测试见 `token-usage*.test.mjs`，含按 UTC 日分文件、跨午夜/时区偏移、补写历史、旧日志兼容、损坏行诊断与多进程追加）：

- Dedup：相同工具/参数/成功结果重复；不同参数/工具/环境；失败调用；副作用工具；输出不同；依赖屏障；引用守卫；消息结构；幂等；空/异常输入；预览；配置；日志脱敏；OpenCode 类型契约。
- Error Purge 正向：等价命令/测试/构建成功取代失败；重复相同失败保留最新；多个过期错误；过期与仍相关错误混合。
- Error Purge 负向：无关成功；unit vs integration；build vs deploy；跨 workspace；跨 user turn；状态变更；引用；短错误；空错误；取消/abort；pending/running；completed+diagnostic text；completed+failure metadata；后续失败；缺失/畸形关联。
- 结构/回归：call/result 关联与字段保持；消息顺序；独立关闭；观察模式；重复应用幂等；Dedup 与 Error Purge 同请求独立生效；插件 hook 就地应用；日志不落错误正文。

环境契约测试读取本机安装的 `@opencode-ai/plugin` 与 SDK 类型，断言 hook 与 `ToolPart` 字段存在；未安装类型时跳过，不伪造通过。

## 九、手工验证（真机）

1. 先保持 `preview: true`，让模型在同一 user turn 内执行失败命令（如 `npm test`），再执行同一命令并成功。
2. 查看 `~/.vibe-loop/context-dedup/events.jsonl`：应出现 `errorPurge.confirmedErrorCount >= 1`、`wouldPruneCount >= 1`、`prunedCount: 0`、`preview: true`。
3. 改为 `"preview": false`，重复操作；日志应出现 `errorPurge.prunedCount >= 1`、`tokenSavingsEstimated > 0`。
4. 检查会话历史：消息数量、工具调用/结果数量和顺序不变；失败 ToolPart 的 `status` 仍为 `error`，但请求副本中的 `state.error` 变为占位文本；最新成功结果保留。
5. 在失败与成功之间插入一次编辑或一条新的用户消息，确认默认保留旧错误。
6. 再跑一次相同请求：`prunedCount: 0`，确认幂等。
7. 如无日志：用 `opencode --print-logs` 确认本地插件是否加载。

## 十、Token 用量记录（token-usage-YYYY-MM-DD.jsonl）

> 范围：**仅数据采集**。不实现 CLI、仪表盘、图表、分析报告或后台服务。不影响裁剪决策。

### 采集时机与关联

- `experimental.chat.messages.transform`：在传输前对完整 `messages` 数组做**前后估算**，并读取本轮 `result.stats` 形成 pruning 归因；按 sessionID 暂存一次（消费一次，避免多步重试重复计数）。
- `event`（`message.updated`）：assistant 消息终态（`time.completed` 存在，或带 `error`）时写一条记录；按 message id 去重。流式中间更新（未终态）不写记录。
- 同一 transform 测量最多关联到一条 usage 记录（`pendingPrune.take` 消费式取出）。

### 真实用量来源

Runtime 把所有 provider 归一化为 `AssistantMessage.tokens{ input, output, reasoning, cache:{ read, write } }`。原始 provider JSON（DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 等）**不暴露给插件**，只能取归一化结果。配置实测：provider `CPMAC-API`（本地 OpenAI 兼容代理 `http://127.0.0.1:8317/v1`），模型 `deepseek-flash`。

字段取值：

| 字段 | 来源 | 说明 |
|---|---|---|
| `input_tokens` | `provider_usage` | `tokens.input`（未缓存 prompt 部分） |
| `output_tokens` | `provider_usage` | `tokens.output` |
| `total_tokens` | `provider_usage_derived` | **加法总和** `input + cache.read + cache.write + output + reasoning`（Runtime 不提供 total） |
| `cached_input_tokens` | `provider_usage` | `tokens.cache.read`（已缓存 prompt 部分；与 `input` **不相交**） |
| `uncached_input_tokens` | `provider_usage` | = `input`（加法模型下 input 即未缓存部分） |
| `reasoning_tokens` | `provider_usage` | `tokens.reasoning`（与 `output` **不相交**；0 为有效计费值） |
| `cache_write_tokens` | `provider_usage`（>0 时，可选键） | `tokens.cache.write` |

> **加法模型（代码证据）**：opencode 二进制中 `ax()` 函数计算 `measured = c.input + c.cache.read + c.cache.write + c.output + c.reasoning`，五个分量为**独立相加**。DeepSeek 的 `prompt_tokens`（→ `input`）与 `prompt_cache_hit_tokens`（→ `cache.read`）不相交。因此 `cached_input_tokens > input_tokens` 是**合法行为**（大缓存前缀 + 小新增输入），不是映射错误。`total_tokens` 必须用加法总和，否则严重低估（如 `input=1237 + cache.read=229888` 的请求，旧公式 `input+output=1799`，正确值 `231687`）。

`usage_status`（schema v2）：

| 状态 | 含义 |
|---|---|
| `actual` | input/output 均可得且至少一个分量 > 0 |
| `partial` | 部分字段可得，其余缺失 |
| `missing` | 无可用 provider 用量（终态无 tokens / 流式中止未终态 / info 缺失） |
| `unverified` | 字段存在但**全部分量为 0**——几乎总是 provider 未填充用量（Runtime 初始化为 0），**不得作为真实用量聚合** |
| `estimated` | 仅有本地估算 |

校验规则（仅标记，**绝不钳制或编造**）：

- `cache.read > input`：**不触发错误**——加法模型下两者不相交，大小关系无约束。
- `reasoning > output`：**不触发错误**——同上，两者不相交。
- **全部分量为 0** → `usage_zero_unverified`：Runtime 把 `tokens` 初始化为全 0，终态全零几乎总是 provider 未上报用量（流式无 final usage / 纯工具轮）。原始 0 值保留但状态不为 `actual`。
- 数值校验：拒绝非有限数、负数、字符串类型；`nonNegativeNumber` 返回 null（不可用）而非 0。

### 估算（fallback）

优先级：provider_usage > 估算 > null。当前**未接入真实 tokenizer**（避免引入大依赖），统一使用字符权重估算 `char_weight_v1`：

- 按 **Unicode 码点**计数（UTF-16 `charCodeAt` + 显式代理对处理，等价于 `for…of` 码点迭代）；
- ASCII 码点权重 `0.25`，非 ASCII 码点权重 `1`，向上取整；
- 同一公式用于 `context_estimates.before/after_pruning` 与 `pruning.*.removed_tokens`，保证口径一致。

> **schema v2 语义修正**：这些值是**估算 Token 数**（`ceil(weighted_units)`），不是字符数。来源标签由 v1 的 `estimated_char_count` 改为 `estimated_tokens_from_chars`，避免「字符计数」与「Token 估算」混淆。`estimator: "char_weight_v1"` 标注公式版本；原始字符数（`countCodePoints`）当前不入记录，`estimated_char_count` 来源保留给未来真存字符计数的字段。

**这是未经验证的临时启发式**：对中文接近 1 token/字符，对英文约 4 字符/token，但对代码、JSON、工具输出混合内容偏差未知；需用真实 DeepSeek 用量样本校准后再视为可靠。

`context_estimates` 只覆盖 `messages` 数组可见的 text / subtask.prompt / tool 的 output·error·input(JSON)；**不包含**系统提示、工具 schema、provider 序列化、多模态 payload、运行时生成的隐藏上下文。因此估算与 provider 计费不保证吻合。

### 归因（无双重计数）

- Dedup 只替换 `state.output`（completed），Error Purge 只替换 `state.error`（error）；两条策略**作用于不同记录的不同字段**，按执行顺序 `["deduplication", "error_purge"]` 求和不会重复计数。
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

### 记录示例（schema v2；字段均为占位示意，非真实值）

```json
{
  "schema_version": 2,
  "event_type": "model_request_usage",
  "timestamp": "2026-10-28T12:00:00.000Z",
  "session_id": "ses_…",
  "request_id": "msg_…",
  "provider": "CPMAC-API",
  "model": "deepseek-flash",
  "transport": "opencode_provider",
  "usage_status": "actual",
  "input_tokens": { "value": 9500, "source": "provider_usage" },
  "output_tokens": { "value": 600, "source": "provider_usage" },
  "total_tokens": { "value": 13220, "source": "provider_usage_derived" },
  "cached_input_tokens": { "value": 3000, "source": "provider_usage" },
  "uncached_input_tokens": { "value": 9500, "source": "provider_usage" },
  "reasoning_tokens": { "value": 120, "source": "provider_usage" },
  "context_estimates": {
    "before_pruning": { "value": 10000, "source": "estimated_tokens_from_chars" },
    "after_pruning": { "value": 9500, "source": "estimated_tokens_from_chars" }
  },
  "pruning": {
    "order": ["deduplication", "error_purge"],
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
    "total_removed_tokens": { "value": 300, "source": "estimated_tokens_from_chars" },
    "measurement_source": "estimated_tokens_from_chars",
    "attribution": "incremental_sequential",
    "token_unit_note": "removed_tokens and total_removed_tokens are estimated token counts from char_weight_v1, not character counts or billed usage."
  },
  "estimator": "char_weight_v1",
  "errors": []
}
```

### 字段语义（schema v2）

**usage_status**：见上文；`unverified` 表示字段存在但未通过一致性校验，**不可作为真实用量聚合**。

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

> **v1 → v2 变更**：`schema_version` 1→2；估算来源 `estimated_char_count`→`estimated_tokens_from_chars`（值是 Token 估算而非字符数）；`usage_status` 的 `unavailable`→`missing`，新增 `unverified`；`pruning.*.skipped_reasons`（扁平、单位混淆）→ `skipped.{record_scan,candidate,application}`（按单位分桶），新增 `scanned_records`。v1 旧记录仍以 v1 写在磁盘上，不被重读或迁移；新记录一律 v2。

### 当前环境不可得 / 待真机验证的字段

- `uncached_input_tokens`：当前 = `input`（加法模型下两者等价）。对 DeepSeek 已确认（`prompt_tokens` = 未缓存）；对 OpenAI 兼容 provider，Runtime 内部有 `noCache = input_tokens - cached_tokens` 的派生逻辑，最终 `tokens.input` 是否等价于 `noCache` **未在本机真机验证**，但 `ax()` 的加法公式强暗示 `input` 排除 cache。
- `reasoning_tokens`：0 时无法区分「provider 未上报」与「显式 0」——Runtime 统一归一化为 number。在已确认用量的记录中 0 作为有效计费值保留（`provider_usage`），不标记为 unavailable。
- `cached_input_tokens` 与 `input_tokens` 的 scope 关系：**已确认不相交（加法）**——证据为 opencode 二进制 `ax()` 函数 `input + cache.read + cache.write + output + reasoning`。`cached > input` 合法。
- `reasoning_tokens` 与 `output_tokens` 的 scope 关系：**已确认不相交（加法）**——同上。
- provider 返回的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `cached_tokens` 原始字段：Runtime 统一映射到 `cache.read`（证据：二进制中 `prompt_tokens_details?.cached_tokens ?? prompt_cache_hit_tokens ?? cached_tokens ?? cache_read_input_tokens`）。`cache_read_input_tokens`（Anthropic）和 `cache_creation_input_tokens` 也已确认映射。**未真机验证**代理 CPMAC-API 是否原样透传这些字段。
- 完整请求估算：`experimental.chat.messages.transform` 不含系统提示与工具 schema，故 `context_estimates` 为 messages 子集估算，非完整请求。
- `transport` 固定为 `"opencode_provider"`：插件进程内看不到实际 wire 协议。
- 多步工具循环中 transform 与终态 message 的配对依赖 sessionID + 消费一次语义。

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
- 只支持当前 `{ info, parts }` / `ToolPart` 结构；若宿主改成独立 tool-role 消息，会安全 no-op。
- 没有真实 tokenizer；所有 token 节省都是估算。Token 用量记录的 `context_estimates` / `pruning` 估算同样使用 `char_weight_v1` 启发式，未用真实 DeepSeek 用量校准。
- Token 用量记录的 provider usage 来自 Runtime 归一化结果（`tokens.input` / `cache.read` / `reasoning` 等）；加法模型已由二进制 `ax()` 函数证据确认，但代理 CPMAC-API 是否原样透传 DeepSeek 的 `prompt_cache_hit_tokens` **未在本机真机验证**。
- 历史 v2 记录（修复前写入）的 `total_tokens` 使用旧公式 `input + output`（不含 cache/reasoning），**严重低估**；`uncached_input_tokens` 为 `unavailable`；可能含 `cache_scope_unverified` / `reasoning_scope_unverified` 假阳性错误。这些记录保留原值不迁移，标记为历史未验证数据。
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
- Node/Bun 可加载插件入口并注册 hook；83 项 Node 测试通过；原始消息对象不被修改、结构校验与回退路径有测试覆盖。

## 十三、卸载 / 回滚

- 删除或移走 `.opencode/plugins/vibe-context-dedup.js` 即可停止插件；`.opencode/context-dedup/` 可一并移走。
- 只关闭 Error Purge：设置 `"errorPurge": {"enabled": false}`，Dedup 不受影响。
- 只关闭 Dedup：设置 `"deduplication": {"enabled": false}`，Error Purge 不受影响。
- 不需要数据库迁移，不写会话存储，不修改项目源码。
- 只关闭 Token 用量记录：设置 `"tokenUsage": {"enabled": false}`（或 `VIBE_TOKEN_USAGE_LOG_DISABLED=1`），裁剪与聚合日志不受影响。
- 日志在 `~/.vibe-loop/context-dedup/`，可按需清理；Token 用量记录在 `<project>/data/token-usage-YYYY-MM-DD.jsonl`（旧单文件 `token-usage.jsonl` 保留），均可按需清理；这不是项目资产。
