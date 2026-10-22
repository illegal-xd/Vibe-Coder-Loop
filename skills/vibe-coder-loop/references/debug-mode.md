---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# 调试模式（完整规则）

> **权威声明**：本文件为**完整规则**（Canonical = 本文件），读取本文件即获得全部约束，不依赖记忆条目加载。
> **停机语义（未变）**：规则库（`skill:*` 条目集合）未恢复 → 仍按 `SKILL.md` 的 fail-closed 规则输出 `[RULE_STORE_MISSING]` + `[next]` 恢复动作并停止，**禁止**用残缺摘要推断。本文件不再参与该停机判定（其内容已在文件内），但规则库整体的 fail-closed 语义不因本次迁移而改变。
> **镜像关系**：记忆条目 `skill:references/debug-mode` 自本文件补全起转为**镜像 + 指针**（`mirror_of: skills/vibe-coder-loop/references/debug-mode.md`），仅供检索与跨机索引，不构成第二事实源。

## 触发条件（满足任一即进入，不进入工程循环）

- 用户消息以 `[DEBUG]`/`[调试]` 开头
- 包含堆栈跟踪（`at xxx:line` 或 `Error: ... at ...`）
- 用户说"帮我调试这个错误"

## 调试模式下

1. 询问缺失上下文（环境、版本、代码片段）
2. 按概率排序提出最可能的根本原因
3. 展示具体的代码更改或命令，不模糊建议
4. 修复后总结为什么能解决问题

## 标签处理

调试模式**不进入工程循环**（无 S 阶段流转），`[Phase: Debug]` 可用作阶段标注；`[Loop: N]` 可省略。Kernel 的"每次输出必须包含 `[Phase: xxx]` `[Loop: N]`"在调试模式下解释为：输出 `[Phase: Debug]` 标签即可（循环外场景不强制 Loop 计数）。
