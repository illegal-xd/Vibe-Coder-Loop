# 迭代日志 — Vibe-Coder-Loop 体系

> 规范 §6/§7。**本轮为基线审查（第 0 轮），未执行候选修改**——用户明确要求"不要修改当前项目的内容"，仅产出审查报告。故本文件记录基线结论与候选假设，供后续证据驱动迭代时取用。

## 第 0 轮：基线建立（本次执行）

### 执行结论
- 综合总分 **62 / 100**（执行有效性 25 分未评估）。
- 阻断性风险 2 项（D1、D2），不得作为已验证最终版本。
- 已执行测试：A1/A2/C2/E2(part)/F1/G1/H1/I1/I2/J1（[BASELINE]）。
- 未执行：Agent 行为层（B/D 类 + 任务轨迹），因无执行器。

### 候选修改假设（Propose，未执行 Probe/Compose）

> 以下为**基于基线证据提出的候选假设**，均标注"待验证"。按规范，未执行对照实验前不采纳。

#### 候选 P1：修复 `check_markdown_links` 性能/崩溃（针对 D1/D4）
- **问题**：每行 fork 一个 grep 子进程 → 9408 forks → 72s + bash 3.2 SIGILL。
- **假设**：改为整文件一次 grep（`grep -oEHn '\]\([^)]+\)' "$file"` 批量提取所有匹配+行号），再逐行做 fence 过滤与路径校验。复杂度从 O(行数×fork) 降到 O(文件数×fork)。
- **预期改善**：全仓 `check` 从 72s/崩溃 → <2s；exit 0。
- **副作用**：fence 内链接过滤逻辑需改为基于行号的区间判断（grep 输出含行号，可先算 fence 区间再排除）。
- **验证测试**：C1（大文件不崩溃/快速）、G1（自测不退化）、A2（scan 不变）。
- **文件范围**：`scripts/audit.sh` `check_markdown_links()`（约 367–400 行）。
- **状态**：⚠️ 待验证（未执行对照实验）。

#### 候选 P2：将 `skill:*` 规则内容纳入版本控制（针对 D2）
- **问题**：完整规则内容仅存于 gitignored 快照/local DB，fresh clone 无法重建。
- **假设**：将 `skill_memory_latest.json` 改为**脱敏后入库**（移除 `db` 本机路径字段），或改为仓库内可追踪的 `skill-rules.json`（仅含 key/value/tags，不含本机路径）。`.gitignore` 对应调整（放行该文件）。
- **预期改善**：fresh clone 可 `restore` → `skill:*` 条目可重建；可移植性 I2 由失败→通过。
- **副作用**：需确认脱敏无凭证泄露（redact 已有）；快照更新流程需同步刷新入库版本；仓库体积增加（当前 ~150KB，可接受）。
- **验证测试**：I2（fresh clone restore 成功）、J1（敏感文件不跟踪——需调整 I2 与 J1 口径，因为现在要跟踪规则 JSON 但不跟踪本机 db 路径）、E1（fail-closed 恢复动作可执行）。
- **文件范围**：`.gitignore`、`skills/vibe-coder-loop/backup/snapshots/`（新增入库文件）、`backup/memory_tool.py`（restore 时忽略/重设 `db` 字段）。
- **状态**：⚠️ 待验证（涉及安全/隐私口径，须人工复核脱敏）。

#### 候选 P3：为 `runtime.exec` 补 `__main__.py`（针对 D3）
- **问题**：`python3 -m runtime.exec` 不可执行。
- **假设**：新增 `runtime/exec/__main__.py`，内容 `from .cli import main; raise SystemExit(main())`。
- **预期改善**：`-m runtime.exec` 可用。
- **副作用**：无（与 `runtime.core/__main__.py` 一致的模式）。
- **验证测试**：E2。
- **文件范围**：新增 `runtime/exec/__main__.py`。
- **状态**：⚠️ 待验证（低风险，但属新增文件，需确认与 `runtime.exec.cli` 一致）。

#### 候选 P4：审计自测增加真实规模回归（针对 D6）
- **问题**：test-audit.sh 仅合成小仓库，永不暴露 D1/D4。
- **假设**：在 test-audit.sh 增加"大文件/多文件"用例（生成 >1000 行 md 的临时仓库，断言 `check` 在 N 秒内 exit 0）。
- **预期改善**：D1 类性能回归有自动化保护。
- **副作用**：测试耗时略增（若 P1 已修，则 <2s）。
- **验证测试**：C1 自动化。
- **文件范围**：`scripts/tests/test-audit.sh`。
- **状态**：⚠️ 待验证。

### 采纳/拒绝/暂缓决策（第 0 轮）

| 候选 | 决策 | 依据 |
|---|---|---|
| P1 | **暂缓** | 高置信根因+低风险，但规范要求"先执行对照再采纳"；用户要求不改项目，故仅记录假设 |
| P2 | **暂缓** | 涉及安全/隐私口径，须人工复核脱敏；未执行对照 |
| P3 | **暂缓** | 低风险但属新增文件；未执行对照 |
| P4 | **暂缓** | 依赖 P1 先落地；未执行对照 |

> 本轮**未采纳任何修改**（遵守用户"不修改项目"约束 + 规范"未验证不采纳"）。所有候选留待后续轮次执行 Probe（对照实验）后再决策。

## 经验积累（规范 §8）

### 已验证经验（本轮 E4 证据支持）
- ✅ `check_markdown_links` 全仓耗时 72s，根因=每行 fork grep（实测隔离到单函数 + 单文件 CHANGELOG）。
- ✅ `audit.sh check` 在 macOS Bash 3.2.57 真实仓库崩溃（SIGILL exit 132）。
- ✅ `snapshots/skill_memory_latest.json` 被 gitignore，fresh clone 不可用（git ls-files 确认仅 .gitignore 跟踪）。
- ✅ runtime 单测 267/267、check-protocol 81/81 零漂移、审计自测 43/43、软链 15/15 均通过。
- ✅ 追踪文件无本机路径泄露（git grep 干净）。

### 待验证假设（未执行，禁止写入 Skill 为已验证）
- ⏳ P1–P4 候选修改的效果（未跑对照实验）。
- ⏳ Agent 行为层（触发/任务完成/规则遵循）——需真机执行器。

### 仅适用特定环境的经验
- macOS Bash 3.2.57 的 SIGILL 触发与 fork 密度相关；Linux/Git Bash 的 bash 版本不同，崩溃可能不重现（但性能退化 O(行数) 仍成立）。

### 尚未解决的问题
- D2（规则内容未版本化）的解法需安全/隐私复核（P2）。
- Agent 行为层无自动化测试设施——这是体系级盲区，非本轮可解。

## 后续迭代预算

按规范 §9：小步迭代，每轮一组关联问题，建议最多 3 轮主要修改。

| 轮次 | 处理 | 状态 |
|---|---|---|
| 第 0 轮（本轮） | 基线审查 | ✅ 完成 |
| 第 1 轮（建议） | P1（审计性能/崩溃）+ P4（自测回归） | 待用户授权执行 |
| 第 2 轮（建议） | P2（规则内容版本化，含脱敏复核） | 待授权 |
| 第 3 轮（建议） | P3（exec __main__）+ 骨架↔memory 一致性校验工具 | 待授权 |

> 停止条件：阻断性风险 D1/D2 未解前不得宣布"已通过验证"。

---

## 第 1 轮：候选落地（用户授权「修改所有对应问题」）

> 用户指令：基于本目录审查报告，修改所有对应问题。本轮把 P1–P4 全部落地，并给出修复前后对照（报告要求的对照实验）。

### 落地与对照

| 缺陷 | 修复 | 修复前 | 修复后 | 证据 |
|---|---|---|---|---|
| D1/D4（Critical/Medium） | `scripts/audit.sh` `check_markdown_links`：逐行 fork `grep` → 单文件一次 `awk`（围栏状态机 + 行号） | `check` SIGILL exit 132 / 72s+ | **0.85–1.04s / exit 0** | E4 实测（本机，真实仓库 63 md） |
| D6（Low） | `scripts/tests/test-audit.sh` 增规模回归（1500 行 + 围栏内外混合链接 + 20s 看门狗） | 自测 43 项，永不覆盖性能面 | **49 项全过**（含崩溃/漏检双向断言） | E4 |
| D2（High） | 新增 `export-rules`：从活库生成**脱敏规则集** `backup/rules/skill_memory_canonical.json`（主目录→`~`/`<USERPROFILE>`、去 `db`），可与活库机械比对；SKILL.md fail-closed 改为「私有通道取得快照/规则集后 restore」；`audit check` 增 C011。**规则内容仍不入库**（用户隐私裁决：条目正文不外发，仓库只分发协议骨架） | fresh clone 无任何可校验规则制品 | `export-rules --check` → 一致（45 条）；`restore` 规则集 `--dry-run` 通过；C011 双向用例 PASS | E4 |
| D5（Low） | 快照 `db` 字段改可移植写法（`~/...` / `<external-db>`）；`restore` 显式忽略并提示 | 快照内嵌 `/Users/<name>/...` | 用例断言无本机路径 | E4 |
| D3（Medium） | 新增 `runtime/exec/__main__.py` | `-m runtime.exec` 不可执行 | `python3 -m runtime.exec --help` 通过 | E4 |
| D7（Info） | 无代码改动：`.aspirecode/` 已 gitignored（`git check-ignore` 确认） | — | 维持 | E4 |

### 新增护栏（防复发）

- `export-rules` 脱敏后**残留检测**（主目录路径/个人目录名/邮箱/凭证）→ 命中即 fail-closed exit 4，不落盘。
- `audit check` **C011**：本机脱敏规则集不存在 → info（规则内容按隐私约束不入库）；存在却含个人主目录路径 → high。
- 规模回归用例带看门狗：回退到逐行 fork 实现会 FAIL，而不是把自测一起挂死。

### 回归结果（本轮）

- `tests/` 单测 267/267；`backup/test_memory_tool.py` 55/55（+4）；`test-audit.sh` 49/49（+6）；`check-protocol` 81/81 零漂移；软链 15/15；smoke-check HARD 0。
- `audit scan --min-severity=high`：仓库代码零命中（仅本目录报告自身含示例个人路径，属审查产物，未改动）。

### 仍待人工裁决

1. **规则内容的可分发性**（已裁决为不入库）：仓库因此只分发协议骨架，新机器需经安全私有通道取得快照/规则集。若将来改为公开分发规则内容，需再评估「条目正文含内部项目标识」的脱敏口径。
2. **骨架↔memory 内容一致性**：仍无自动化校验（`check-protocol` 只校验 runtime 代码表）；`export-rules --check` 只校验规则集与活库一致，未校验骨架文件内容。
3. **历史版本清理**：首次提交曾把规则集入库，已按用户要求重写该提交并从 reflog/object DB 清除（未 push）。
