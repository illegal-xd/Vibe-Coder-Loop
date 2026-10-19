# Vibe Kernel

个人 **Vibe Kernel** —— 面向 Coding Agent 的轻量级工程执行与持续改进框架的唯一真实源（Single Source of Truth）。

本仓库承载 Agent 的核心约束、可复用 Skill、以及后续工程执行/验证/状态恢复能力的扩展位置。本机所有运行环境（OpenCode、Pi 等）通过软链接引用本仓库资源，不再各自维护副本。

## 目录职责

```
Vibe-Coder-Loop/
├── kernel/          # Agent Core — 角色定义、调度规则、安全约束、基础配置
│   └── Vibe Coder.md        # Agent Prompt（opencode agent，mode: primary）
├── skills/          # 可复用工作流、领域规则、能力说明
│   ├── vibe-coder-loop/         # 工程 Workflow（状态机/规则/记忆/tool）
│   ├── delx-memory-protocol/    # 通用记忆协议（委托 canonical）
│   └── skill-authoring/         # Skill 维护协议（委托 canonical）
├── docs/            # 迁移说明、使用文档
│   └── migration.md
├── scripts/         # 验证脚本
│   └── verify-symlinks.sh
└── README.md
```

**未预先创建的职责区**（按需再建，避免空目录）：
- *Runtime / Execution*：工程执行、状态管理、检查验证、恢复与持续改进
- *Adapters / Integrations*：对接 OpenCode、Pi 等不同 Coding Agent 运行环境
- *Tests*：验证脚本或测试

## 本机软链约定

运行环境通过以下软链发现本仓库资源（详见 `docs/migration.md`）：

| 软链路径 | 目标 |
|---|---|
| `~/.agents/skills/<name>` | `./skills/<name>` |
| `~/.config/opencode/skills/<name>` | `../../../.agents/skills/<name>`（→ 本仓库） |
| `~/.config/opencode/agents/Vibe Coder.md` | `./kernel/Vibe Coder.md` |

校验：`scripts/verify-symlinks.sh`

## 设计原则

- **单一真实源**：本仓库为唯一源；运行环境只持软链入口，不持独立副本。
- **Skill 发现机制优先**：Skill 内部不写死绝对路径，按 opencode/Pi skill 发现机制加载；绝对路径仅作兜底。
- **append-only 不重写**：`CHANGELOG.md` 等历史记录不因路径迁移而重写，仅追加新条目。
- **迭代记录走 manifest.yaml**：版本号唯一事实源为各 skill 的 `manifest.yaml`。
