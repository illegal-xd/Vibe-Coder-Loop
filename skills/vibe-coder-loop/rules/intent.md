---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# S1 Intent + S3 Decision 阶段细则（骨架版）

> 阶段编号统一用状态机正式编号（S0-S14，唯一事实源 = `engine/state-machine.md`）；输出标签仍为 `[Phase: xxx]` 格式（见下方模板）。

> **骨架化说明**：目标三元组格式/分类启发式/冲突预检表/仲裁要点已下沉为 `skill:` 规则条目，加载时按需 `memory_get`；检索失败按本文件摘要降级执行。

## S1：Intent（认知层）

[Phase: Intent]
[Loop: 0]

### 目标

理解用户真实工程目标，**不立即执行字面需求**。产出结构化的目标三元组供后续阶段引用。

### 必须输出：目标三元组 + 任务分类 + 冲突预检

完整格式（显式意图/隐含约束/风险标签 + 任务分类 + 冲突预检）见 `skill:rules/intent:goal-triple`（level:domain, permanent——加载全文执行）。核心要点：

```text
### 目标三元组
- 显式意图：<用户字面表达的目标>
- 隐含约束：<工程惯例 / 安全边界 / 用户上下文偏好>
- 风险标签：<低/中/高 + 不可逆性识别 + 影响范围>

### 任务分类
- 类型：<A. Direct Action / B. Optimization / C. Refactoring / D. Architecture / E. Investigation>
- 判断依据：<分类理由>

### 冲突预检
- 与红线潜在冲突：<无 / 命中：[P_n vs <用户意图>]>
- 处理路径：<无冲突 → 直入 Preflight / 命中 → Preflight 后进 Decision>
```

### 出口条件

- [ ] 目标三元组已输出（显式意图 + 隐含约束 + 风险标签）
- [ ] 任务分类已确定
- [ ] 冲突预检已标注
→ 满足后：
  - 无冲突 → `>>> 进入 Preflight`
  - 命中冲突 → `>>> 进入 Preflight`（Preflight 后进 Decision）

### 暂停条件

- 目标不明确（用户输入模糊到无法推断显式意图）→ **暂停**，输出追问清单（不进入 Preflight）

---

## S3：Decision（冲突仲裁层）

[Phase: Decision]
[Loop: 0]

### 目标

当 Intent 预检命中冲突时，强制走四步仲裁协议。Decision 是 P0 用户意图与红线之间的仲裁层，**不阻塞循环但必须输出 Conflict Card**。

### 四步仲裁协议

完整定义见 `policy/safety.md` 第 2 节（唯一事实源）+ `skill:rules/intent:decision-arbitration`（level:core, reference——加载全文执行）：Step1 识别不可逆性 → Step2 生成等价方案 → Step3 输出 Conflict Card → Step4 执行路径。

### 关键铁律

**不可逆 + 用户明确** 仍然不能直接执行，必须先输出 Conflict Card 走等价方案路径（理由见 `policy/safety.md` 第 2 节）。

### 出口条件

- [ ] Conflict Card 已输出
- [ ] 执行路径已选定
→ 满足后：
  - High/Medium → `>>> 进入 Router`
  - Low → 暂停，输出追问清单

### 与后续阶段的衔接

Decision 产出的等价方案 + 待决策清单，会流转到 Code 阶段执行（Builder 角色）+ Review 阶段审查（Critic 角色）。Critic 必须确认 Conflict Card 已被正确执行。
