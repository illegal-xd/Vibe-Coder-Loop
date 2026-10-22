# 已知问题（**已修复**）：`--table` 对转义竖线 `\|` 误报

> 状态：**RESOLVED**（同版本第十批 · 转义竖线误报；同版本第十一批 · 同段缺陷「EOF 表格漏检」）。修复落点 = `skills/skill-authoring/scripts/smoke-check-core.sh` 第 7 节。
> 被检文件 `policy/safety.md` **内容未修改**（缺陷在检查器侧，非内容侧）。

## 0. 修复摘要

| 项 | 内容 |
|---|---|
| 根因 | 表格列数按竖线直接切分计数，把单元格内的**转义竖线**（反斜杠 + 竖线，字面竖线）当成列分隔符 |
| 修复 | 比较列数前先剔除转义竖线，再按竖线切分（仅改计数口径，不改判定阈值、不改任何被检文件） |
| 方案 | 采纳原报告 **T1**（修共享 core），否决 T2（改内容用 HTML 实体）与 T3（累积豁免白名单） |
| 批号 | CHANGELOG「同版本第十批 — 表格检查器转义竖线修复」 |

### 回归验证（正例 + 反例都测）

| 用例 | 修复前 | 修复后 |
|---|---|---|
| 含转义竖线的 3 列表格（合法） | exit **1**（误报） | exit **0** ✅ |
| 真列数不符（表头 3 列 / 数据行 4 列） | exit 1 | exit **1** ✅ 仍拦截 |
| `vibe-coder-loop --table` | exit 1（HARD 1） | exit **0**（HARD 0） |
| `skill-authoring --table` | — | exit **0**（HARD 0） |

> 反例不可省：只测正例会无法区分「修好了」与「检查被关掉了」。

## 1. 现象（历史记录）

```bash
bash skills/vibe-coder-loop/scripts/smoke-check.sh --table
# → ✗ [STRUCTURAL_INCONSISTENT] ./policy/safety.md:0: 表格列数不一致
# → HARD 违规: 1，退出码 1
```

不带 `--table` 时退出码 0、HARD 0（该检查为**可选项**，不在默认门禁内）。

## 2. 根因（历史记录）

`skill-authoring/scripts/smoke-check-core.sh` 的表格检查按竖线直接切分计列数，**不识别 Markdown 的转义竖线**：

```python
if s.startswith('|') and s.endswith('|'):
    rows.append(s)
...
cols = {len(r.split('|')) for r in rows if not re.match(r'^\|[\s:|-]+\|$', r)}
```

命中位置：`skills/vibe-coder-loop/policy/safety.md:126-131`（归档注释格式表）。单元格内写的是
`// @Iteration: [v{版本号}] {归档原因} | 替代者: {替代者}`（其中竖线为转义写法）——内容上该竖线是**字面竖线**，
渲染后列数正确；但直接切分把它当成列分隔 → 该行 5 段、表头 4 段 → 判为不一致。

**结论：内容无缺陷，是检查器对转义符的局限。** 该文件从未被修改。

## 3. 影响面（已随修复解除）

| 项 | 表现 |
|---|---|
| 默认门禁 `smoke-check.sh` | 从未受影响（表格检查需显式 `--table`） |
| 显式 `--table` | 修复前恒 exit 1 → **修复后 rc0** |
| 其他含转义竖线的表格 | 同类文件不再误报（修在共享 core，3 个实例同时受益） |

## 4. 同段第二缺陷：EOF 表格漏检（**已修复**，第十一批）

- **根因**：缓冲区只在遇到非表格行时结算 → **文件以表格结尾时该表格从不检查**（静默漏检）。
- **修复**：抽出 `bad(block)` 单点判定（含剔除转义竖线），循环末尾补一次结算。
- **影响评估（先评估后改）**：3 实例 / 47 个规则文件，末尾为表格者仅 **1** 个（`skill-authoring/SKILL.md` 6 行表，列数一致）→ **新增 HARD = 0**，与实测一致。
- **回归**：EOF 真列数不符 exit 0（漏检）→ **exit 1**；EOF 合法表格 exit 0；中段继续 0/1 未退化；双实例 `--table` rc0。
- 批号：CHANGELOG「同版本第十一批 — 表格检查器 EOF 漏检修复」。

> 至此，表格检查器已知缺陷（转义竖线计数、EOF 漏检）全部关闭。

## 5. 复现命令（保留用于回归）

```bash
bash skills/vibe-coder-loop/scripts/smoke-check.sh --table          # 现应为 exit 0
python3 - skills/vibe-coder-loop/policy/safety.md <<'PY'            # 独立复现列数差（旧逻辑）
import sys,re
rows=[]
for i,l in enumerate(open(sys.argv[1],encoding='utf-8'),1):
    s=l.rstrip('\n')
    if s.startswith('|') and s.endswith('|'): rows.append((i,s))
    else:
        if rows:
            cols={len(r.split('|')) for _,r in rows if not re.match(r'^\|[\s:|-]+\|$',r)}
            if len(cols)>1: print('mismatch at', rows[0][0], '-', rows[-1][0], cols)
            rows=[]
PY
# 旧逻辑 → mismatch at 126 - 131 {4, 5}；core 现已在计数前剔除转义竖线
```
