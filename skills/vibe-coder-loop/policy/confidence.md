---
tags:
  - ai
  - skill
  - vibe-coder-loop
type: note
status: active
---

# Confidence & Evidence Policy — 置信度与证据体系

本文件定义 Confidence 三档与 Evidence 五级的独立评估体系。所有关键工程判断必须同时标注两者。

## Confidence 三档

| 档位 | 标识 | 行动差异 |
|---|---|---|
| High | `[Confidence: High]` | 直接执行，不打断循环 |
| Medium | `[Confidence: Medium]` | 执行但输出末尾标注 `[假设]`，追加待决策清单 |
| Low | `[Confidence: Low]` | **暂停**，输出追问清单（不进入下一阶段） |

## Evidence 五级

| 等级 | 含义 | 典型来源 | 可信度权重 |
|---|---|---|---|
| E0 | 模型推测，无外部依据 | 训练数据中的模式匹配 | 最低 |
| E1 | 用户明确描述 | 用户消息中的直接陈述 | 中 |
| E2 | 文件读取确认 | package.json、配置文件、文档 | 高 |
| E3 | 代码图谱/静态分析确认 | CodeGraph、AST 分析、调用链 | 很高 |
| E4 | 测试或运行结果确认 | 单元测试、e2e 测试、运行时日志 | 最高 |

## 联合标注格式

```text
[Confidence: High/Medium/Low]
[Evidence: E0/E1/E2/E3/E4(来源描述)]
```

**示例**：

```text
技术栈推断：Vue 3 + TypeScript
[Confidence: High]
[Evidence: E2(package.json 读取确认)]

数据库字段 status 存在
[Confidence: High]
[Evidence: E3(CodeGraph verified)]

这个优化可能提升性能
[Confidence: Low]
[Evidence: E0(模型推测，未验证)]
```

## 何时需要标注（3 类场景）

**Confidence / Evidence 是不确定性处理工具，不是通用输出格式。** 仅下列场景要求输出（即 `safety.md` §3 #10 的 3 类必标场景）：

| 场景 | 例 | 必须回答 |
|---|---|---|
| **多个合理解释** | 技术栈推断 / 方案选型 / 字段语义 | 选了哪个、凭什么 |
| **记忆与代码冲突** | delx-memory 记录与当前实现不一致 | 以哪个为准、为什么 |
| **风险或影响面无把握** | 是否触达其他模块 / 是否不可逆 | 把握程度、缺什么证据 |

**不要求标注**：变量改名、简单样式/文案修改、简单字段增加、明显 bug 修复，以及任何"标注与否都不改变决策"的场景。

> **记忆与代码冲突不构成 Low**：经验记忆为 Advisory（`policy/priority.md` §3.5），以当前代码事实为准 → 标注 Medium/E3 后继续执行，**不暂停**。

## 判定口径（项目特有裁决，用到时才查）

通用判定（技术栈推断读 package.json、架构决策看调用链、风险等级看不可逆性）属常识，不在此重述。本表只记 **vibe-coder-loop 特有裁决**：

| 判断类型 | 依据 → Confidence / Evidence |
|---|---|
| 记忆一致性 | 与代码图谱一致 → High, E3 ｜ 部分一致 → Medium, E2 ｜ 冲突 → **Medium, E3（以当前代码事实为准，标注后继续，不暂停）** |

> 通用降级规则见下方「Confidence 与 Evidence 的关系」节末「降级规则」。

## Confidence 与 Evidence 的关系

**独立维度，不互相决定**：

- Confidence 高 + Evidence 低：常见（如"用户说要用 React"——用户明确描述但未经文件验证）
- Confidence 低 + Evidence 高：少见但可能（如"CodeGraph 显示该函数被调用，但我不确定修改是否安全"）
- 理想状态：Confidence 高 + Evidence 高（如"package.json 显示 Vue 3，CodeGraph 确认组件使用 Composition API"）

**降级规则**：

- Evidence 为 E0 时，Confidence 最高只能标 Medium
- Evidence 为 E1 时，Confidence 最高只能标 High（用户明确描述可信）
- 涉及安全红线（R1）的判断，Evidence 必须 ≥ E2（文件或代码图谱确认），否则 Confidence 强制降为 Low
