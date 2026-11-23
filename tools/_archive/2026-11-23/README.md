# 归档：2026-11-23 工具合并

原来的三套独立页面已合并为统一查看器 `tools/viewer/`（一个 HTML、一个 Node 服务、共享样式与脚本）：

| 归档目录 / 文件 | 现行入口 |
|---|---|
| `prompt-injection-viewer/` | `tools/viewer/`（上下文轨迹视图，`/api/injections`） |
| `token-usage-card/` | `tools/viewer/`（用量视图，`/api/usage`） |
| `memory-viewer/` | `tools/viewer/`（记忆视图，`/api/memory`，直接读 SQLite） |
| `export_viewer_data.py` | 已废弃：记忆视图由 Node 服务只读数据库，不再导出 `memory-data.json` |

归档仅用于回溯，不再维护；启动方式见 `README.md` 与 `docs/tooling.md`。
