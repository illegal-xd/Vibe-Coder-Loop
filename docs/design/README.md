# Vibe Kernel — 技术设计文档

本目录包含 MVP-1 / MVP-2 / MVP-3 三阶段技术设计。调研与修订依据截至 2026-10-20。

## 文档

| 文档 | 内容 |
|---|---|
| [overview.md](overview.md) | 总体架构、模块边界、协作流程、演进路线、版本兼容规则、未决问题分诊 |
| [mvp-1-workflow-core.md](mvp-1-workflow-core.md) | Workflow Core——状态机/Checkpoint/恢复协议/错误码归属 |
| [mvp-2-execution-verification.md](mvp-2-execution-verification.md) | Execution & Verification——执行器/归一化/Diff 汇总/失败指纹 |
| [mvp-3-opencode-adapter.md](mvp-3-opencode-adapter.md) | OpenCode Adapter——事件与 Hook/注入链路/分层降级 |

## 阅读顺序

1. **overview.md**——先读，建立全局认知（现有工作流是协议、不是代码）
2. **overview.md §六「Phase 0.5 设计收敛」**——**开工前置门禁，必须先过**
3. **mvp-1** → **mvp-2**（可并行）→ **mvp-3**（依赖前两者接口冻结）

## 核心结论

- 现有 `vibe-coder-loop` 工作流是**协议**（Markdown 由 LLM 驱动），唯一确定性代码是 `memory_tool.py`。
- 三个 MVP 的本质是**把已验证协议包进确定性代码**，不发明新工作流。
- Core 只管状态、不管判断；Exec 只给机械事实、不替代根因分析；Adapter 只捕获运行事实、**不判断阶段出口**。
- 每阶段保持「Skill 可独立使用」——Core/Exec/Adapter 是叠加层，降级回退 Phase 0。

## 开工前必须闭合的 6 项（Phase 0.5 门禁）

| # | 问题 | 结论位置 |
|---|---|---|
| 1 | 状态文件位置与多项目隔离矛盾 | MVP-1 §7.1（项目本地 + `_project_id` + 落在 Skill 目录即拒绝） |
| 2 | YAML 解析缺失 + 跨平台原子写/锁/并发 | MVP-1 §4.2–4.3（受限子集 + 三层降级 + 锁 + `expected_rev`） |
| 3 | Exec 输出限制在读完之后（内存不受控） | MVP-2 §3.2（Popen + 有界 Sink + 整树终止） |
| 4 | 失败指纹不稳定 / 连续判定有漏洞 / 计数不持久 | MVP-2 §5（sha256 规范 JSON + `last_fp/count` 持久化 + 重置规则表） |
| 5 | `tool.execute.after` 被当成 event 处理 | MVP-3 §2.0（本机 typings 证实是独立命名 Hook；stdout 在 `output.output`） |
| 6 | 新会话恢复只"读了状态"、"没进上下文" | MVP-3 §5（两条链路 + A3/B2 行为级验收） |

## 证据分级

文档内结论标注：**[已验证]**（代码/配置/类型定义/测试依据，注明路径）/ **[未充分验证]**（有实现缺真机观测）/ **[尚不存在]**（无对应实现）/ **[待验证/待决策]**（证据不足或多方案）。

## 未决问题

- **阻塞实现**：无（U1/U2/U3/U6 已定案）。
- **可暂缓**：有明确缺省，不阻塞开工（详见 overview §9.2）。
- **仅实验/待真机**：U16/U24/U26 + E2/E3 —— 这些**不能靠设计解决**，只能靠真机冒烟证明；证明失败时须如实降低结论档位，不得宣称闭环。

## 修订记录

**2026-10-20 — 设计收敛修订（针对 6 项 P0 + 专项问题）**

- 状态文件从 `$SKILL_DIR/.state.md` 改为 `<project_root>/.vibe-kernel/.state.md`，补隔离规则表与 Git 忽略策略。
- **后续变更（现行协议）**：Checkpoint 改为 delx-memory 条目 `vc:checkpoint:<项目绝对地址>`（L0 独立 tag），不再创建项目内状态目录；本文档的 `.vibe-kernel` 路径属历史设计记录。
- 补齐 YAML 受限子集解析方案（严格/降级/损坏三态）、规范渲染幂等、跨平台原子写与锁、`expected_rev` 乐观并发与字段合并策略。
- Exec 改为 Popen 流式采集（内存有界）+ 整进程树终止 + 外置失败不返回坏 ref。
- 指纹改 sha256 规范 JSON（移除 `stage`）+ 连续计数持久化 + 穷举重置规则。
- OpenCode Hook 事实修正（依据 `@opencode-ai/plugin@1.15.4` 类型定义），新增 `chat.system.transform` 新会话恢复链路与 `autocompaction` 续跑开关。
- 状态机增单一事实源校验（`check-protocol`）、Loop 规则按 Level 定案、Safe Mode 收窄为确定性触发、错误码拆为协议码/运行时扩展码。
- pending 核验改三态（仅 `verified` 移 completed）。
- Diff 覆盖六类改动（含未跟踪、重命名、已暂存）+ 非 git 显式基线快照。
- artifact 拆 `ephemeral`/`pinned` 两层生命周期，GC 不删被引用产物。
- 降级改分层可见（L1–L4），L3 保留安全拦截，诊断不依赖 Core。
- 新增 Phase 0.5 设计收敛门禁与三项 Skill 侧最小增补清单。
