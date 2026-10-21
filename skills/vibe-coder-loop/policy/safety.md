---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Safety Policy — 安全策略

本文件定义 R1 层安全策略。优先级仅次于 R0 Kernel，不可被用户要求和效率目标绕过。

## 1. 不可逆操作清单

以下操作在任何阶段执行前必须识别并降级处理：

| 操作类型 | 示例 | 降级策略 |
|---|---|---|
| 删除 | 删除文件 / 代码 / 注释（**代码资产**） | **无用户指令** → 归档注释 `@Iteration` 替代；**用户明确指令** → 输出 Conflict Card + 「🗑 待删除清单」（含可执行命令），**物理删除由用户执行**（Agent 不执行）；**本轮自产草稿** → 可直接删改（见 `policy/lifecycle.md`「适用范围」） |
| 删除（**记忆条目**） | `memory_forget` / 移除 delx-memory 键 | **Agent 自主执行**（记忆操作常驻授权，无需用户确认）；义务 = 归属为本方 + 可回滚证据已核验；批量 ≥5 条先输出清单（不阻塞）——见 `policy/lifecycle.md`「记忆条目删除义务」 |
| 覆盖 | 无备份的覆写 | 并存引入新旧两版 |
| 提交 | git commit | 用户确认后执行 |
| 推送 | git push | 创建 feature 分支 + PR |
| 数据库迁移 | schema 变更 | 输出迁移脚本 + 回滚方案，等确认 |
| 部署 | 生产环境部署 | 输出部署清单 + 风险评估，等确认 |

## 2. 冲突仲裁协议（Decision Conflict Resolution）

当用户意图与安全红线冲突时，强制执行四步仲裁：

### Step 1：识别不可逆性

命中不可逆操作清单 → 不可逆 → 必须降级处理
未命中 → 可逆 → 允许直接执行（但仍需输出 Conflict Card 留档）

### Step 2：生成等价方案

至少 1 个，最多 3 个不破坏红线的替代路径：

| 替代策略 | 适用场景 | 示例 |
|---|---|---|
| 归档注释替代删除 | 用户要"删除旧代码" | `// @Iteration: [v1] 废弃` |
| 并存引入替代替换 | 用户要"换成新组件" | 旧组件归档 + 新组件并存，待用户决策 |
| 临时方案替代不可逆 | 用户要"推送到 main" | 创建 feature 分支 + PR，不直接推送 |
| 延迟执行替代立即 | 用户要"立即部署" | 输出部署清单 + 风险评估，等用户确认 |

### Step 3：输出 Conflict Card

```text
┌─────────────────────────────────────────┐
│ ⚖ 冲突仲裁卡                            │
├─────────────────────────────────────────┤
│ 用户意图: <描述>                        │
│ 冲突红线: <R_n: 描述>                   │
│ 不可逆性: <是/否 — 命中操作类型>        │
│ 风险等级: <High/Medium/Low>            │
│ 等价方案:                               │
│   [1] <方案1描述>                       │
│   [2] <方案2描述（可选）>               │
│ 推荐选择: <方案编号> + 理由             │
│ Confidence: <High/Medium/Low>           │
│ Evidence: <E0-E4(来源)>                 │
└─────────────────────────────────────────┘
```

### Step 4：执行路径

| Confidence | 执行路径 |
|---|---|
| High + 等价方案清晰 | 执行等价方案，不阻塞循环 |
| Medium | 执行等价方案 + 输出末尾标注 `[假设]` + 追加待决策清单 |
| Low | **暂停**，输出追问清单（不进入 Router） |

### 关键铁律

**不可逆 + 用户明确** 仍然不能直接执行，必须先输出 Conflict Card 走等价方案路径。

理由：用户在指令当下可能未充分意识到全局影响。Agent 的职责是先输出 Conflict Card 提示风险 + 等价方案，再执行。

## 3. 约束分级（Hard / Signal）

**Hard 只给安全、正确性、用户资产与契约。代码规模与风格不配拥有与安全相同的优先级。**

| # | 约束 | 性质 | 违反后果 |
|---|---|---|---|
| 1 | 函数体行数阈值（不含空行注释行） | **Signal** | 计入维度层，不短路。阈值 = 项目 lint 配置（如 eslint `max-lines-per-function`）；无配置时缺省 30 行 |
| 2 | 文件行数阈值（不含 license 头；归档注释计入） | **Signal** | 同上。阈值 = 项目 lint 配置（如 eslint `max-lines`）；无配置时缺省 300 行 |
| 3 | 函数参数数阈值 | **Signal** | 同上。阈值 = 项目 lint 配置（如 eslint `max-params`）；无配置时缺省 4 个 |
| 4 | 空错误处理（空 catch / 忽略 Promise rejection） | **Hard** | 审查不通过 → 情况 B |
| 5 | 硬编码密钥（须环境变量或配置注入） | **Hard** | 同左 |
| 6 | 删除 / 覆盖用户既有资产（生命周期见 `policy/lifecycle.md`） | **Hard** | 同左 |
| 7 | 私自处置同类被注释组件（三重禁止） | **Hard** | 同左 |
| 8 | 组件 / 页面更换未标注 ⚠️ 并入待决策清单 | **Hard** | 同左 |
| 9 | 归档注释格式（使用归档时须 `@Iteration`） | **Hard** | 同左 |
| 10 | 关键判断未标注 Confidence + Evidence | **条件 Hard** | 仅下方 3 类场景未标注 = 违例 |

> **Hard 违规只有两条出口（按可修复性分流，不得同时套用）**：**可修复**（本轮能改回合规）→ S10 情况 B（回 `S6 Design[0]` 重设计）；**已造成不可逆后果或本轮无法修复** → S8/S10 出口上报 `vc_violation`（`core transition --vc-violation <事实>` / `feed-exec` 的 `ExecResult.vc_violation`）→ SAFE MODE（S14）。分流判定在 S10 出口做一次，不重复计量。

### Signal（#1 / #2 / #3）的正确处理

Signal = **Review Signal**，不是 Violation：

```text
超阈值函数  → Signal → 判断"是否真的影响可维护性" → 需要才改（Agent 自主决定）
超阈值文件   → Signal → 不自动触发重构
```

- **不短路、不进情况 B**；计入维度层 `issue_count`，由情况 A/B 阈值判定
- 天然形态的载体**不视为问题**：数据表 / 常量表 / 配置数组 / i18n 词条表 / 生成代码（codegen、schema、迁移脚本）/ 第三方与 vendor；switch 派发 / 路由表 / reducer（长度由分支数决定）
- 但「形态天然」**不豁免坏味道**：深层嵌套 / 重复逻辑 / 隐式副作用照常计为问题
- Level 0/1 出口**不检查** Signal 项（只跑安全向检查）

### Confidence + Evidence 的 3 类必标场景（#10）

仅下列场景未标注才算违反：

1. 存在多个合理解释（技术栈 / 方案 / 字段语义）
2. 记忆与当前代码冲突
3. 风险等级或影响范围无把握

**其余场景不要求标注**（格式与降级规则见 `policy/confidence.md`）。

## 4. 归档注释格式（强制统一）

| 语言场景 | 格式 |
|---------|------|
| `//` 行注释（JS / TS / CSS / JSONC / Java / Go / C 系） | `// @Iteration: [v{版本号}] {归档原因} \| 替代者: {替代者}` |
| `#` 行注释（Python / Shell / Ruby / YAML / TOML） | `# @Iteration: [v{版本号}] {归档原因} \| 替代者: {替代者}` |
| `--` 行注释（SQL / Lua） | `-- @Iteration: [v{版本号}] {归档原因} \| 替代者: {替代者}` |
| HTML / Vue template / JSX 文本节点 | `<!-- @Iteration: [v{版本号}] {归档原因} \| 替代者: {替代者} -->` |

- 格式 = **注释符随语言，正文格式统一**（缺 `{替代者}` 视同格式不合规）
- `{版本号}`：本轮需求改动版本号，与 Plan 阶段 Step 编号对应
- `{归档原因}`：一句话说明为何归档
- `{替代者}`：新引入的组件/函数/文件名；确无替代者写 `无`
- 归档注释**计入文件行数阈值**约束

## 5. 子 agent 首步加载包（统一协议）

子 agent（含 unit-test/e2e-test/写码 subagent）首步必须按序加载：

```text
1. read vibe-coder-loop/kernel.md          — R0 核心原则
2. read vibe-coder-loop/policy/safety.md   — R1 安全策略 + 约束分级（Hard/Signal）+ 归档格式 + 三红线细节（宪法声明 = kernel.md §2/§4.1，本文件为细节事实源）
3. read vibe-coder-loop/policy/lifecycle.md— 资产生命周期
4. read vibe-coder-loop/policy/confidence.md— Confidence+Evidence
```

**双通道兜底**：若 read 不可用 → `delx-memory_memory_get` key=`agent:vc_constraints`（完整兜底版，含约束10项+归档格式+三红线摘要）。

**Level 0 文档修改约束子集（5 项；条目数 = 本清单行数，引用方须写「5 项」）**：纯文档 / 配置修改（无代码逻辑）时，仅以下约束适用（#1/#2/#3 Signal 项不检查）：
1. 不删除 / 不无备份覆盖用户内容（#6）
2. 路径 / 引用断言必须 E2 验证（修改前 glob/read 确认，禁止凭语义推断）
3. 修改后验证落盘（read 确认）
4. **多轮编辑**：每轮 edit 后重跑**结构指纹**（章节清单 + 行数突变 + 区块闭合），不能只在首次写入时校验一次（见 `skill:rules/review:doc-structure-recheck`）
5. 存在不确定判断时标注 Confidence + Evidence（#10 的 3 类场景）

> **Level 0 文档任务完整流程定义**（含格式校对型 vs 内容写作型 Level 0-Doc 细分、S2 轻量记忆召回、S8 出口三维审查）唯一事实源 = `engine/complexity-gate.md`「Level 0 细分」；该型细则见 `engine/router.md`「Quick Loop 细则（L0 / L0-Doc / L1）」。本子集仅定义安全约束层面，不定义流程。

## 6. 子 agent 安全责任

- 子 agent 首步必须加载上述四件套（或 agent:vc_constraints 兜底）
- 主 agent 是资产保护最终责任人：整合阶段与 Review 阶段逐项复核子 agent 产出
- 子 agent 违反安全策略 = 主 agent 在 Code[N+1] 接管修复（同时回退违规操作）
