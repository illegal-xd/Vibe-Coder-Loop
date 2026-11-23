# 提示词注入记录（Prompt Injection Log）

> 作用域：OpenCode 可选桥接插件 `vibe-bridge` 记录两类上下文数据：**用户输入**（`chat.message`）与**实际注入的 checkpoint / compaction 文本**。
> 两类数据共用一条时间轴，但用 `event` / `category` 明确区分。与 token 用量归档**完全独立**：一个回答「花了多少 token」，一个回答「上下文里有什么、什么时候、属于哪个对话」。

## 1. 记录什么

只有**实际发生**的用户消息或注入才落一条记录：用户消息来自 `chat.message`；注入在 `hookOutput.system.push` / `hookOutput.context.push` 成功后记录。

| 来源 | `event` / `category` | `kind` | `target` | `trigger` |
|---|---|---|---|---|
| `chat.message` | `user_input` / `user_input` | `user_input` | `user_message` | `user_message` |
| `experimental.chat.system.transform` | `system_prompt` / `context` | `system_prompt` | `system` | `session_start` |
| `experimental.chat.system.transform` | `prompt_injection` / `injection` | `checkpoint_full` | `system` | `resume` / `compacted` |
| `experimental.chat.system.transform` | `prompt_injection` / `injection` | `checkpoint_pointer` | `system` | `hot_pointer` |
| `experimental.session.compacting` | `prompt_injection` / `injection` | `checkpoint_full` | `compaction_context` | `compaction` |
| `tool.execute.after`（普通工具） | `tool_call` / `tool` | `tool` | `tool` | `tool_call` |
| `tool.execute.after`（MCP） | `mcp_call` / `mcp` | `mcp` | `mcp` | `tool_call` |
| `tool.execute.after`（`skill`） | `skill_call` / `skill` | `skill` | `skill` | `tool_call` |

用户输入只取 `chat.message` 中 `type: "text"` 且非 `synthetic` / `ignored` 的 part，多个 text part 用空行连接；它不是注入，但和注入放在同一时间轴便于对照。系统提示词在 `experimental.chat.system.transform` 中按会话 + 内容哈希去重，只在首次或变化时记录。工具 / MCP / 技能调用在 `tool.execute.after` 记录一次，内容包含 `tool` / `args` / `title` / `result`，其中 args 与 result 各截到 8,000 字符后再入队，避免大写入/大输出拖慢 hook。冷启动预热、注入失败不会产生注入记录；宿主未提供会话 ID 时仍记录，`session_id` 为 `null`，查看器归入“未知对话”。注入记录的内容就是最终追加到宿主 output 的文本（含 `<!-- VC checkpoint … -->` 包装标记）。

## 2. 存储布局

```text
~/.config/opencode/prompt-injection/
  prompt-injection-2026-11-23.jsonl
  prompt-injection-2026-11-24.jsonl
```

- **JSON Lines**：每行一个独立 JSON 对象；logger 只追加，不重写。仅在查看器显式「清除记录」并经二次确认时，才按会话重写或全量清空文件。
- 日期取记录自身的 `timestamp`（事件时间）的 **UTC 自然日**，不取写入时的系统日期。
- 目录 `0700`、文件 `0600`；父目录惰性创建。
- `VIBE_PROMPT_INJECTION_HOME` 重定位归档根目录（测试 / 非标准 home）。
- `VIBE_PROMPT_INJECTION_LOG_DISABLED=1` 完全关闭写入。

## 3. 记录字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema_version` | number | 当前为 `1` |
| `event` | string | `prompt_injection`（注入）、`user_input`（用户输入）、`system_prompt`（系统提示词）、`tool_call` / `mcp_call` / `skill_call`（调用）；队列溢出时另有 `prompt_injection_log_dropped` |
| `category` | string | `injection` / `user_input` / `context` / `tool` / `mcp` / `skill`，查看器据此区分数据类别 |
| `timestamp` | string | ISO 8601，带 `Z` 或数值时区偏移 |
| `session_id` | string \| null | 对话 / 会话 ID；查看器按它分组 |
| `message_id` | string \| null | 宿主提供时记录；用户输入来自 `chat.message` 时通常有值 |
| `source` | string | 固定 `vibe-bridge` |
| `hook` | string | 触发注入的宿主 Hook |
| `kind` | string | `checkpoint_full` / `checkpoint_pointer` / `user_input` / `system_prompt` / `tool` / `mcp` / `skill` |
| `trigger` | string \| null | `resume` / `compacted` / `hot_pointer` / `compaction` / `user_message` / `session_start` / `tool_call` |
| `target` | string | `system` / `compaction_context` / `user_message` / `tool` / `mcp` / `skill` |
| `project` | string | 插件初始化时的项目目录（绝对路径） |
| `model` | object \| null | `{ provider_id, model_id }`，宿主未提供时为 null |
| `content` | string | 实际注入文本（超过 65,536 个 Unicode 码点截断；非 ASCII 的 UTF-8 字节数可能更大） |
| `content_chars` | number | 写入内容（截断后）的 Unicode 码点数 |
| `content_bytes` | number | 写入内容的 UTF-8 字节数 |
| `content_truncated` | boolean | 是否发生截断 |
| `original_content_chars` | number | 截断前码点数 |
| `sequence` | number | 插件进程内递增序号，用于同一毫秒内的稳定排序 |

## 4. 异步队列（不阻塞 Agent）

`createInjectionLogger().record()` 是唯一热路径调用：

1. 只做廉价形状校验（hook / kind / target / content 存在，timestamp 带时区）；
2. 把需要的字段浅拷贝进有界队列（O(1) 入队，满时推进 head 丢弃最旧项，不做 O(n) `shift`）；
3. 通过 `setImmediate` 调度一次后台 flush；
4. 立即返回，从不 `await`、从不抛错。

**重活全部在 flush 中完成**：时间戳归一化、Unicode 码点计数、UTF-8 字节数、内容截断、`JSON.stringify`。因此 `chat.system.transform` 每次请求的额外成本是亚微秒级（独立实测：Bun 约 0.2–0.45 µs/次，Node 约 0.5–0.8 µs/次；满队列时仍为 O(1)），不会与模型请求竞争。

flush 串行执行，按 UTC 日期分组写入。**部分日期失败只重试失败日期**：已成功写入的日期不会随整批 requeue 重复追加。队列溢出时丢弃最旧条目，并在下一批写入一条 `prompt_injection_log_dropped` 记录（`dropped_count`）；写入失败后按 1s→2s→4s…（上限 60s）指数退避自动重试，同时通过限频警告（5 分钟一次）提示，不影响模型请求。

> **非强一致**：`setImmediate` 会尽快落盘，但宿主被 `SIGKILL`/强制退出时，最后一批可能尚未写入。需要强一致时应显式调用 `flush()` 后再退出。
>
> **单日部分写**：同一日期的多条记录合并为一次 `appendFile`。若内核在部分写入后报错（如 ENOSPC），该日期会整体重试，理论上可能出现重复行（at-least-once）。跨日成功文件不会重复；读取端按行解析，损坏行计入 `invalid`。


### 4.1 运行时自检（`vc_state.injection_log`）

`vc_state` 工具在返回状态快照的同时附带注入日志诊断，重启宿主后可直接验证：

| 字段 | 含义 |
|---|---|
| `enabled` | 是否启用（受 `VIBE_PROMPT_INJECTION_LOG_DISABLED` 影响） |
| `base_path` | 当前归档基准路径 |
| `pending` | 尚未落盘的队列条数 |
| `dropped` | 因队列溢出丢弃的条数 |
| `sequence` | 热路径成功入队的累计条数（>0 证明 hook 正在记录） |
| `failed` | 校验 / 序列化 / 写入失败次数 |
| `last_error` | 最近一次失败原因（项目路径已脱敏；成功时为 null 或历史值） |

> 如果宿主重启后 `sequence` 长期为 0，而 `snapshot-task-zone` 返回非空，说明注入 hook 没有走到记录分支，应检查宿主是否真的调用了 `experimental.chat.system.transform`。工具调用记录走 `tool.execute.after`；MCP 名称可通过 `VIBE_BRIDGE_MCP_TOOLS` 补充前缀。


## 5. 查看器

```bash
node tools/viewer/server.mjs
# 浏览器打开 http://127.0.0.1:8788/（用量为默认视图）
# 同一服务的 #timeline / #memory 分别展示上下文轨迹与记忆
```

- 参数：`--port <n>`（默认 8788，`0` 为随机端口）、`--host <addr>`（默认 `127.0.0.1`）、`--injection-dir <dir>`、`--allow-remote`。
- **默认只允许回环地址**：`--host` 为非回环地址时服务拒绝启动；确需局域网访问必须显式加 `--allow-remote`，并注意归档含完整注入正文。
- 页面采用 **全高轨迹视图**：左侧栏顶部是标题与「用量 / 记忆 / 对话」三个入口，只有选择「对话」时才在下方展开对话列表（超长时内部滚动），侧栏可折叠为窄栏；「清除记录」固定在左栏底部，不再提供搜索框。右侧分为固定的顶部区域（对话信息 +「输入 / 注入 / 工具」三轨概览）与独立的底部滚动区；概览条无卡片底色、直接平铺，支持**鼠标滚轮缩放 / 单击单选 / 鼠标拖动框选区间**，区域内滚轮不会带动页面滚动，选中后即时过滤事件行。点击事件行从右侧打开**全局详情抽屉**（不挤压卡片布局），提供概述 / 预览 / 原始内容 / 来源四个视图；预览按工具调用（参数 / 结果结构化）、系统提示词与用户输入（Markdown）、注入正文（代码块）分别渲染，URL 可点击，原始内容保持纯文本。**事件按时间正序排列，最早的在最上面**；不再分页，直接全量显示当前对话的全部记录。**系统提示词与完整注入优先于同一轮的用户输入显示**。右下角提供回到顶部 / 滚动到底部快捷按钮。
- 支持概览条区间选择、点击事件行打开详情抽屉；页面加载时读取一次归档，不自动轮询，刷新页面获取最新记录。
- **指针记录只是摘要**：常态请求注入的是 `checkpoint_pointer`（约 200 字），完整 TASK 区只在会话恢复 / 压缩时注入为 `checkpoint_full`。页面会在指针卡片上提示。
- API：`GET /api/injections?from=YYYY-MM-DD&to=YYYY-MM-DD&session=<id>`，每次请求重新读取归档并 `Cache-Control: no-store`；单次最多返回最近 **5000** 条，`diagnostics.truncated/totalRecords` 标明是否截断；`stats.injections` / `stats.userInputs` / `stats.toolCalls` / `stats.mcpCalls` / `stats.skillCalls` / `stats.systemPrompts` / `stats.records` 分别给出各类数量与总数。`GET /api/health` 返回用量归档（兼容字段 `archive`）与 `archives.injection/usage/memory` 三个路径。
- 清除：`POST /api/clear`，JSON body `{"scope":"session","session":"<id>"}` 或 `{"scope":"all"}`；必须带 `Content-Type: application/json` 与 `X-Requested-With: prompt-injection-viewer`。页面有二次确认（选择范围 → 最终确认）。`session` 会重写各日文件并保留其它会话与无法解析的行；`all` 会 truncate 所有日文件。**不可恢复，无自动备份**；运行中的宿主仍可能并发追加，清除为 best-effort 非事务操作。
- 静态资源白名单，无目录遍历；CSP 含 `frame-ancestors 'none'` / `base-uri 'none'` / `object-src 'none'`。

## 6. 隐私与边界

- 记录包含**注入正文**，可能带有项目任务状态、文件路径等本地信息；归档仅保存在本机用户目录，权限 `0600`。不要提交到版本库或分享。
- 记录**不包含**用户原始消息、工具输出正文、模型回复或凭证；`model` 只保留 provider/model 标识。
- 这是观测数据，不参与状态机决策；记录失败不会改变注入行为。

## 7. 测试

```bash
node --test tests/plugins/prompt-injection-log.test.mjs
node --test tests/plugins/prompt-injection-viewer.test.mjs
node --test tests/plugins/vibe-bridge.test.mjs
```

测试通过显式 `VIBE_PROMPT_INJECTION_HOME` 指向临时目录，不触碰真实归档；`vibe-bridge` 测试默认设置 `VIBE_PROMPT_INJECTION_LOG_DISABLED=1`，仅集成用例临时开启。
