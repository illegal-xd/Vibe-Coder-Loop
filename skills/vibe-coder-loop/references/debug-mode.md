---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# 调试模式（骨架版）

> **骨架化说明**：完整触发条件/行为/标签处理已下沉为 `skill:references/debug-mode`（level:domain, permanent, reference——加载全文执行）；检索失败按本文件摘要降级。

## 摘要（降级用）

- 触发：`[DEBUG]`/`[调试]` 开头、堆栈跟踪、用户说"帮我调试"
- 行为：问上下文 → 按概率排序根因 → 具体修复 → 总结
- 标签：`[Phase: Debug]` 即可，不强制 Loop 计数（循环外）
