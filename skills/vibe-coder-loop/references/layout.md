# Multi-Skill Project Layout — 多 Skill 项目布局约定

> 本文件是 vibe-coder-loop 生态的多 skill 布局参考。沉淀拆分后形成的布局约定，供新增 skill 时遵循。
> 用户最初审查引用的基准 `references/layout.md § Multi-Skill Projects` 即指本约定。

## 当前 skill 生态

| Skill | 类型 | 职责 | 持有运行时数据 |
|---|---|---|---|
| `vibe-coder-loop` | 工程 Agent Skill（宿主） | 完整工程循环状态机 + 实例规则 + 运行时 tool | ✓（dashboard `skill:vibe-coder-loop:metrics` / rollback-point）|
| `delx-memory-protocol` | 协议 Skill（只读引用） | 通用记忆协议（三层/命名空间/Tag-scope/TTL/Relevance/supersession/Consolidation/跨项目迁移） | ✗ |
| `skill-authoring` | 协议 Skill（只读引用） | skill 维护协议（骨架化/canonical-source/下沉/fallback/残留验证）+ 自检脚本模板 | ✗ |

## 布局原则

### 1. 协议 Skill 与工程 Skill 分治
- **工程 Skill**（宿主）：持有状态机、出口绑定（S2/S8/S12）、运行时数据（dashboard）、实例特化规则。
- **协议 Skill**：只定义通用协议，**不绑定工程出口**、**不持有运行时数据**。多个工程 skill 可复用同一协议 skill。

### 2. Canonical 分治（防双 canonical）
通用概念的 canonical home 在协议 skill；宿主的实例文件 = **fallback 副本 + 实例触发条件**（非第二 canonical）。修改通用概念以协议 skill 为准，宿主同步摘要。详见 `governance.md` §协议核心特例。

### 3. 委托 ≠ 删除
宿主实例文件保留有效（含实例绑定 + 必要 fallback），协议提取不强制裁指针。裁指针是独立的后续阶段（低风险高 churn，单独任务承接）。

### 4. 命名空间隔离
每个 skill 的自有数据/规则条目必须带 skill 名：`skill:<skill-name>:<slug>`。**禁止无 owner 的共享前缀**（如 `skill:system:*`）——多 skill 写同一键互相覆盖（D8 实证）。

### 5. Tool 归属
运行时 tool（touch/metrics 服务 dashboard）归宿主 skill；协议 skill 不持 tool。维护 tool（backup/restore/verify）随被备份数据归属。

## 新增 skill 检查清单

新增协议 skill 时：
- [ ] SKILL.md 声明"只定义协议，不定义工程出口"
- [ ] manifest.yaml `dependencies.required` 声明后端依赖（如 delx-memory）
- [ ] manifest.yaml `memory.write: []`（协议 skill 不持运行时数据）
- [ ] 注册软链：`~/.agents/skills/<name>` → 源；`~/.config/opencode/skills/<name>` → `~/.agents/skills/<name>`
- [ ] 宿主 skill 的 SKILL.md「已采纳协议 Skill」表登记委托关系
- [ ] 若提供脚本模板，宿主实例化并在自身 smoke-check 中引用

## 委托关系图

```text
delx-memory-protocol（通用记忆协议）
        ↑ 委托引用
        |
vibe-coder-loop（宿主：状态机 + 实例规则 + 运行时 tool）
        ↑ 委托引用
        |
skill-authoring（skill 维护协议 + 自检模板）
```

> 宿主的拆分执行历史与剩余阶段见 `CHANGELOG.md`（`backup/archive/` 存归档的计划文档）；本文件记录**布局约定**（稳定 reference），二者职责不同。
