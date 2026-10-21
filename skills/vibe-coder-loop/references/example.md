---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# 完整示例：局部修复路径（精简版）

> 输出模板以 `rules/review.md` 为准（情况 A/B/C 完整格式）。本文件仅展示**核心教学差异**：情况 A 的"发现问题 → 修复片段"流。

## 核心示例（情况 A：3 问题 → 修复 → 再审查通过）

```javascript
// Code[1] 原始实现
function sumEvenSquares(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] % 2 === 0) s += arr[i] * arr[i];
  }
  return s;
}
```

**Review[1] 发现问题（3 处，无结构性 → 情况 A）**：

| # | 类型 | 问题 | 修复 |
|---|------|------|------|
| 1 | 可读性 | 变量名 `s` 不具自解释性 | `let sum = 0` |
| 2 | 可读性 | 逻辑混合，可提取纯函数 | `isEven` + `square` + filter/map/reduce |
| 3 | 可维护性 | 未处理非数组/非数字输入 | `Array.isArray` + `typeof` 过滤 |

**Code[2] 修复后**：

```javascript
const isEven = (n) => n % 2 === 0;
const square = (n) => n * n;

function sumEvenSquares(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr
    .filter((n) => typeof n === 'number' && isEven(n))
    .map(square)
    .reduce((sum, n) => sum + n, 0);
}
```

**Review[2] 通过（情况 C）** → Reflection 触发判定 → Memory Evolution。

**要点**：
- 情况 A 修复在同一回复中输出 `[Phase: Code][Loop: N+1]`，超 100 行仅输出修改片段
- 情况 B（结构性/硬约束违反）→ `[Phase: Design][Loop: N+1]` 重新设计（`Design[0]` 仅为重入序号记号），计数器不重置
- 情况 C 通过后先 Reflection 判定，再 Memory Evolution，最后输出「📋 待用户决策清单」（若无则省略）
