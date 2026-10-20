# Vibe Kernel — 技术设计文档

本目录包含 MVP-1 / MVP-2 / MVP-3 三阶段技术设计。调研依据截至 2026-10-19。

## 文档

| 文档 | 内容 | 行数 |
|---|---|---|
| [overview.md](overview.md) | 总体架构、模块边界、协作流程、演进路线、未决问题 | 263 |
| [mvp-1-workflow-core.md](mvp-1-workflow-core.md) | Workflow Core——状态机/Checkpoint/恢复协议/VC 码的代码化 | 377 |
| [mvp-2-execution-verification.md](mvp-2-execution-verification.md) | Execution & Verification——执行器/归一化/Diff 汇总/失败指纹 | 345 |
| [mvp-3-opencode-adapter.md](mvp-3-opencode-adapter.md) | OpenCode Adapter——宿主事件桥接/compaction 注入/降级 | 415 |

## 阅读顺序

1. **overview.md**——先读，建立全局认知（最关键事实：现有工作流是协议非代码）
2. **mvp-1-workflow-core.md**——Core 是基础，MVP-2/3 依赖其接口
3. **mvp-2-execution-verification.md**——可与 MVP-1 并行开发
4. **mvp-3-opencode-adapter.md**——依赖 Core/Exec 接口冻结

## 核心结论

- 现有 `vibe-coder-loop` 工作流是**协议**（Markdown 由 LLM 驱动），唯一确定性代码是 `memory_tool.py`（记忆工具 + artifact 子系统）。
- 三个 MVP 的本质是**把已验证协议包进确定性代码**，不发明新工作流。
- Core 只管状态，不管判断；Exec 复用 artifact 子系统；Adapter 是薄层，宿主类型不泄漏进 Core。
- 每阶段保持「Skill 可独立使用」——Core/Exec/Adapter 是叠加层，降级回退 Phase 0。

## 证据分级

文档内结论标注四档：**[已验证]**（代码/配置/测试依据）/ **[未充分验证]**（有实现缺验证）/ **[尚不存在]**（无对应实现）/ **[待验证/待决策]**（证据不足或多方案）。

## 未决问题汇总

各文档末「未决问题」节列出 U1–U17，需用户决策后方可进入实现。
