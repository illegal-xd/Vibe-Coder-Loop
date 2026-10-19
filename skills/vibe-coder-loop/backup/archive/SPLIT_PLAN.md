# SPLIT_PLAN — vibe-coder-loop 拆分执行（已实施阶段 1-4）

> **状态**：阶段 1-4 已实施（协议提取式拆分）。剩余阶段 5（实例文件裁指针）待独立任务。
> **来源**：v1.18.0 审查 criterion 4 拆分信号。

## 已实施：协议提取式拆分（非文件迁移）

### 决策依据（深查后修正）

原计划"物理迁移 learning/memory/* 文件"经深查发现三类硬耦合，强制迁移风险过高：
1. **21 处文件路径引用**会断（learning/memory/X.md 跨 skill 路径重写）
2. **概念层耦合**：lifecycle/retrieval/promotion 文档内容引用宿主 S2/S8/S12 出口——迁移后新 skill 反向依赖宿主状态机
3. **memory_tool.py 与 dashboard 深度耦合**：`skill:vibe-coder-loop:metrics` 运行时数据归宿主，tool 的 touch/metrics 命令服务宿主出口

**修正方案**：提取**通用可复用协议**到新 skill（无出口绑定、无运行时数据），宿主保留**实例特化**文件并委托通用概念。这是可逆且不破坏现有引用链的拆分。

## 已落地两个新 skill

### A. `delx-memory-protocol`（通用记忆协议）
- **SKILL.md** + **manifest.yaml** + **protocol.md**
- 提供（无工程出口绑定）：三层体系 / 命名空间隔离 / Tag-scope / TTL / Relevance 评分 / 事实时序 supersession / Memory Consolidation / 跨项目模式迁移 / 跨项目失效传播
- 不持有：运行时数据（dashboard/rollback-point 归宿主）、出口回写时机（S2/S8/S12 归宿主 state-machine）、任务类型路由（归宿主 retrieval.md）

### B. `skill-authoring`（Skill 维护协议）
- **SKILL.md** + **manifest.yaml** + **governance-protocol.md** + **scripts/smoke-check-template.sh**
- 提供（通用）：骨架化协议 / canonical-source 分类(A/B/C) / 下沉与 fallback / 残留验证纪律 / 自检脚本模板
- 不持有：宿主自身映射表（vibe-coder-loop 的 governance.md 是它自己的实例资产，保留在宿主）

### C. vibe-coder-loop 委托引用
- SKILL.md「架构边界」表：learning/ 行注明通用协议委托 `delx-memory-protocol`
- SKILL.md 新增「已采纳协议 Skill（委托关系）」节：两 skill 的委托/保留对照表
- profiles/skill-maintenance.md：Required/Optional 指向 `skill-authoring` 协议源

### D. 注册
两新 skill 已软链：`~/.agents/skills/<name>` → obsidian 源；`~/.config/opencode/skills/<name>` → `~/.agents/skills/<name>`。

## 边界明确（防误用）

- **memory DB namespace 不迁移**：`skill:learning/memory:*` 等条目留在 DB 原 key（无 owner 冲突，D8 已解决）。vibe-coder-loop 的 memory_tool.py 继续 backup 全部 `skill:*` 前缀条目（含新 skill 若将来产生 `skill:*` 条目——目前两新 skill 不持有条目）。
- **memory_tool.py 留在 vibe-coder-loop/backup/**：它是宿主运行时 tool（touch/metrics 服务 dashboard），不迁。
- **实例文件保留有效**：lifecycle/retrieval/promotion/architecture/advanced 等仍在 vibe-coder-loop，含实例绑定 + fallback；通用概念现在**同时**存在于 delx-memory-protocol（canonical home）。轻微重复可接受（阶段 5 裁指针消除）。

## 剩余阶段（待独立任务）

**阶段 5（实例文件裁指针）**：将 vibe-coder-loop 的 `learning/memory/architecture.md` + `advanced.md` 中的通用部分裁减为"见 `delx-memory-protocol/protocol.md`"指针，只保留实例特化。需逐文件 smoke-check 守门。低风险但高 churn，单独任务承接。

**阶段 6（DB namespace 治理，可选）**：若未来多 skill 共用 delx-memory 后端且各自持 `skill:*` 条目，需为每 skill 的 backup tool 加 owner 前缀过滤（防互备）。当前仅 vibe-coder-loop 持条目，暂不需要。

## 本轮为何不做物理文件迁移（保留记录）

- D 类结构重排，按 policy/safety.md 应走 Full Loop + 先建测试基线
- 21 路径重写 + 概念层反向依赖 + tool 耦合，一次 Code 循环高风险制造死指针
- 协议提取式拆分已达成"通用协议独立化 + 宿主瘦身路径明确"的核心价值，且零破坏
