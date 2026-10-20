# MVP-2 — Execution & Verification 设计

> 目标：为 Vibe Kernel 提供确定性的本地执行能力——命令执行 + 结果归一化 + Diff 汇总 + 重复失败检测。
> 原则：**复用 memory_tool.py artifact 子系统**（已验证的输出外置 + 分页取用 + 投影过滤 + 字节上限）；不另造输出管理。Exec 是纯函数为主，可独立于 Core 测试。

---

## 一、目标与非目标

### 目标
1. **统一执行器**：标准化执行本地命令（test/lint/build/diff），归一化输出为结构化结果（exit code / 统计 / 错误摘要 / 字节 / 耗时）。
2. **结果归一化**：把不同命令（pytest/vitest/jest/cargo test/eslint/tsc/git diff）的异构输出收敛为统一 `ExecResult`，供 Core/LLM 消费。
3. **Diff 汇总**：解析 git diff，分类文件（新增/修改/删除/高风险域），输出紧凑摘要供 S8 计划漂移校验与 S10 Review。
4. **重复失败检测**：对失败结果计算指纹（命令+退出码+错误摘要+测试名+文件+阶段），连续无变化触发 `NO_PROGRESS`（对接 Core）。
5. **输出有界**：大输出经 artifact 外置，返回 ref；分页取用——严守 VC `OUTPUT_LIMIT` 契约。

### 非目标
- 不替代 LLM 的失败根因分析（Exec 给结构化结果，LLM 判断根因与修复策略）。
- 不实现远程/容器执行（本地进程内；容器化留后续）。
- 不绑定特定测试框架（归一化器按 exit code + 模式匹配，不强依赖框架）。
- 不实现 CI 编排（单命令/单组命令执行，非流水线）。
- 不修改 memory_tool.py 的 artifact 实现（复用，不改）。

---

## 二、现状与证据

### 已存在（复用基础）
- **memory_tool.py artifact 子系统** **[已验证]**：`artifact put --file F [--name N] [--kind text|jsonl] [--loop N]`（大产物落盘，24h TTL，put 时回收过期，name 消毒拒路径分隔符）+ `artifact page --ref R [--offset/--limit/--max-bytes/--fields/--equals/--grep/--count]`（分页取用 + 投影 + 过滤 + 字节上限 + clamp 显式报 `OUTPUT_LIMIT`）+ `artifact list`/`release`。
  - 这是 Exec 的输出外置与分页取用的**直接复用对象**——已验证「输出有界 + 显式 clamp 不静默」契约。
- **VC `OUTPUT_LIMIT`/`ARTIFACT_NOT_FOUND` 码** **[已验证]**：`transition.md` 已定义；Exec 在输出超限时返回 `OUTPUT_LIMIT`（`[next] 分页续取 artifact page --offset`），fail-closed=否（分页续取，不阻断）。
- **memory_tool.py 工程范式** **[已验证]**：逐条容错、显式 `[next]`、fail-closed 语义、exit code 语义（0/3/4 区分）——Exec 直接借鉴。
- **`.state.md` review/pending 字段** **[已验证]**：Exec 结果流入 Core 的 `review.last_failure`/`review.issues` 与 pending 核验，字段已存在。

### 尚不存在（Exec 要新建）
- 通用命令执行器（当前 LLM 直接调 bash，无归一化/外置/超时/取消）。
- 结果归一化器（当前 LLM 读原始输出自行判断）。
- Diff 汇总器（当前 LLM 读 git diff 全文）。
- 失败指纹与重复检测（当前 `NO_PROGRESS` 由 LLM 手动判「连续无改善」）。

---

## 三、执行器设计

### 3.1 接口

```python
@dataclass
class ExecRequest:
    cmd: list[str]          # 已拆分参数（避免 shell 注入；复杂命令经 shell=True 显式 opt-in）
    cwd: str               # 项目根（强制，不缺省当前进程 cwd）
    timeout_ms: int = 300_000  # 缺省 5 分钟（同 manifest.yaml cost.timeout_per_loop）
    env: dict | None = None   # 额外环境变量（不继承全量，显式传入）
    max_output_bytes: int = 100_000  # 超限外置 artifact
    lang: str = "auto"     # 归一化器选择（auto=按 cmd 推断；pytest/vitest/jest/cargo/eslint/tsc/git-diff/unknown）
    stage: str = ""        # 调用方阶段（S8/S9/S10/…），用于指纹与日志

@dataclass
class ExecResult:
    ok: bool               # exit code == 0
    exit_code: int
    duration_ms: int
    stdout_ref: str        # artifact ref 或内联（小输出）
    stderr_ref: str
    stdout_bytes: int
    stderr_bytes: int
    externalized: bool     # 是否外置到 artifact
    normalized: NormalizedResult | None  # 归一化结果（lang≠unknown 时）
    fingerprint: str       # 失败指纹（见 §五）
    vc_code: str | None    # OUTPUT_LIMIT/ENV_ERROR/TIMEOUT/OK
    next: str | None       # [next] 动作
```

### 3.2 执行流程

```python
def run(req: ExecRequest) -> ExecResult:
    # 1. 前置校验（命令存在性——fail-closed，不静默降级）
    if not command_exists(req.cmd[0]):
        return ExecResult(ok=False, exit_code=-1, vc_code="ENV_ERROR",
                          next="安装/配置命令后重试；不消耗 Loop 计数（同轮修正）",
                          fingerprint=fp_env(req))
    # 2. 执行（subprocess + timeout + 流式采集 stdout/stderr）
    proc = subprocess.run(req.cmd, cwd=req.cwd, env=req.env,
                          capture_output=True, timeout=req.timeout_ms/1000)
    # 3. 输出归一化
    norm = normalize(req.lang, proc.stdout, proc.stderr, proc.returncode, req.cmd)
    # 4. 大输出外置（复用 memory_tool.py artifact put）
    stdout_ref, stdout_ext = externalize_if_large(proc.stdout, req)
    stderr_ref, stderr_ext = externalize_if_large(proc.stderr, req)
    # 5. 指纹
    fp = compute_fingerprint(req, proc, norm)
    # 6. VC 码判定
    vc, nxt = classify(req, proc, norm, stdout_ext)
    return ExecResult(ok=proc.returncode==0, exit_code=proc.returncode,
                      normalized=norm, fingerprint=fp, vc_code=vc, next=nxt, ...)
```

### 3.3 安全约束

| 约束 | 实现 | 依据 |
|---|---|---|
| cwd 强制 | `req.cwd` 必填，不缺省进程 cwd | 防在错误目录执行（`.state.md` pending 核验同源） |
| env 不全继承 | `env` 显式传入额外项；敏感变量（密钥/token）由调用方显式注入 | 防泄露宿主环境凭据 |
| timeout 强制 | 缺省 5 分钟；超时 → `TIMEOUT` 码，kill 子进程 | 防 LLM 卡死（manifest cost.timeout_per_loop） |
| 输出有界 | stdout/stderr 超 `max_output_bytes` → artifact 外置，返回 ref | VC `OUTPUT_LIMIT` 契约 |
| 命令注入 | 默认 `shell=False`（list 参数）；需 shell 时显式 opt-in + 审查 | 代码审查强制项 |
| 取消 | 支持 `cancel_event`（Adapter 事件可中断长任务） | 宿主中断/用户 Esc |

---

## 四、结果归一化设计

### 4.1 统一 `NormalizedResult`

```python
@dataclass
class NormalizedResult:
    kind: str               # test / lint / build / diff / generic
    pass_count: int | None  # 测试通过数（test 类）
    fail_count: int | None  # 测试失败数
    skip_count: int | None
    error_summaries: list[str]  # 失败项摘要（测试名/lint 规则/编译错误），≤10 条
    error_digest: str       # 失败项集合的稳定哈希（供指纹，见 §五）
    high_risk_hit: bool     # 是否触及高风险域（auth/金额/删除/迁移/部署/schema/加密/事务）
    stats_raw: str          # 原始统计行（人类可读，供 LLM 参考）
```

### 4.2 归一化器分发（按 cmd/lang）

```python
def normalize(lang, stdout, stderr, exit_code, cmd) -> NormalizedResult | None:
    if lang == "auto":
        lang = infer_lang(cmd)  # 按 cmd[0] + 文件后缀推断
    dispatch = {
        "pytest": _norm_pytest, "vitest": _norm_vitest, "jest": _norm_jest,
        "cargo": _norm_cargo, "eslint": _norm_eslint, "tsc": _norm_tsc,
        "git-diff": _norm_git_diff, "unknown": None,
    }
    fn = dispatch.get(lang)
    return fn(stdout, stderr, exit_code) if fn else None
```

**各归一化器的契约**：只解析「退出码 + 统计行 + 失败项名」三类，**不解析完整堆栈**（堆栈走 artifact 外置，LLM 按需 `artifact page` 取）。模式匹配容错——解析失败降级为 `unknown`（返回 None），不裸抛（同 memory_tool.py 逐条容错）。

### 4.3 归一化示例（pytest）

```python
def _norm_pytest(stdout, stderr, exit_code) -> NormalizedResult:
    # 匹配末行：===== N passed, M failed, K skipped in Ts =====
    m = re.search(r"(\d+) passed(?:.*?(\d+) failed)?(?:.*?(\d+) skipped)?", tail)
    fails = extract_failed_names(stdout)  # FAILED tests/test_x.py::test_a
    return NormalizedResult(
        kind="test", pass_count=..., fail_count=...,
        error_summaries=fails[:10], error_digest=stable_hash(fails),
        high_risk_hit=scan_high_risk(fails), stats_raw=m.group(0))
```

---

## 五、失败指纹与重复检测（对接 Core `repeatCheck`）

### 5.1 指纹定义

```python
def compute_fingerprint(req, proc, norm) -> str:
    """稳定指纹：同一失败重复出现可机械判定。"""
    parts = [
        req.cmd[0],                     # 命令（pytest vs eslint 不同）
        str(proc.returncode),            # 退出码
        norm.error_digest if norm else hash(stderr_tail),  # 失败项集合哈希
        req.stage,                        # 阶段（S8 vs S9 同失败但不同阶段算不同）
    ]
    return sha1("|".join(parts))
```

**不进指纹的字段**（避免误判重复）：耗时、stdout 字节数、时间戳——这些每次不同但不影响「是否同一失败」。

### 5.2 重复检测（Core `repeatCheck` 对接）

```python
# Core 侧（MVP-1 §六 NO_PROGRESS 判定）
def repeat_check(self, fingerprint: str) -> RepeatResult:
    history = self._state.get("review_failure_fps", [])
    if fingerprint in history:
        self._consecutive_same += 1
        if self._consecutive_same >= 2:  # 连续 2 次（kernel.md §5 trigger）
            return RepeatResult(repeat=True, vc_code="NO_PROGRESS",
                                next="进 Safe Mode，输出风险报告")
    else:
        self._consecutive_same = 0
    history.append(fingerprint)
    return RepeatResult(repeat=False, vc_code=None)
```

> **`kernel.md` §5 Safe Mode 触发**「连续 2 次 Code→Review 无改善」——Exec 指纹把「无改善」从 LLM 主观判断升级为机械判定（同指纹 = 无改善）。这是 MVP-2 对 `NO_PROGRESS` 码的直接贡献。

### 5.3 指纹的 LLM 透明性

Exec 在 `ExecResult.fingerprint` 返回指纹；LLM 可见（便于理解为何被判 NO_PROGRESS）。Core 的 `review_failure_fps` 历史存 `.state.md`（新增子字段或存 decisions 内，**待 U9 决策字段位置**）。

---

## 六、Diff 汇总设计

### 6.1 接口

```python
@dataclass
class DiffSummary:
    files_added: list[str]
    files_modified: list[str]
    files_deleted: list[str]
    files_renamed: list[tuple[str, str]]
    high_risk_files: list[str]   # 触及高风险域（auth/金额/删除/迁移/部署/schema/加密/事务）
    total_insertions: int
    total_deletions: int
    plan_drift: list[str] | None # 实际修改 ⊄ S7 计划声明的文件集（对接 Core PLAN_DRIFT）

def summarize_diff(cwd: str, plan_files: list[str] | None = None,
                   base: str = "HEAD") -> DiffSummary: ...
```

### 6.2 实现

```python
def summarize_diff(cwd, plan_files=None, base="HEAD") -> DiffSummary:
    # 1. git diff --name-status（非 git 项目降级，见 §6.3）
    out = run_git(["diff", "--name-status", base], cwd)
    added, modified, deleted, renamed = parse_name_status(out)
    # 2. 高风险域扫描（文件路径关键词）
    high_risk = [f for f in all_files if HIGH_RISK_RE.search(f)]
    # 3. 计划漂移校验（对接 Core PLAN_DRIFT）
    drift = ([f for f in all_files if f not in plan_files]
             if plan_files else None)
    # 4. --stat 取 insertions/deletions
    stats = run_git(["diff", "--stat", base], cwd)
    ins, dels = parse_stat(stats)
    return DiffSummary(added, modified, deleted, renamed,
                       high_risk, ins, dels, drift)
```

### 6.3 非 git 降级

`transition.md` S8 pending 核验用「最低成本命令」哲学；Diff 汇总对齐：

| 项目类型 | 命令 | 降级 |
|---|---|---|
| git | `git diff --name-status --stat` | — |
| 非 git | — | 文件存在性 + mtime 对比（`os.path.exists` + `st_mtime`）；无 insertions/deletions 统计，标 `degraded` |
| 空仓库/无提交 | — | `plan_drift=None`（无基线可比），标 `no_baseline` |

> **决策依据**（overview U4）：强依赖 git 会排除非 git 项目（如纯配置/文档仓）；降级保持可用。`state-machine.md` pending 核验本就允许「最低成本命令」。

---

## 七、与 Core 的接缝

```text
LLM 调 Exec.run(req) ──► ExecResult ──► LLM 判定通过/失败
                                          │
                                          ▼ 失败时
                          Exec.fingerprint ──► Core.feed_exec(result) / repeat_check(fp)
                                                  │
                          ┌───────────────────────┴───────────────────────┐
                          ▼                                               ▼
                  首次失败（PASS_NEW_FAILURE）                  连续无变化（NO_PROGRESS）
                  LLM 走 S8[N+1]                                 Core 强制转 S14
```

**Diff 汇总与 PLAN_DRIFT**：
```text
S8 出口 ──► Exec.summarize_diff(cwd, plan_files=S7声明集)
              │
              ▼ plan_drift 非空
      Core.feed_exec(diff_summary) ──► 返回 VC PLAN_DRIFT
              │                        [next] 补记偏离理由 或 回 S7 重规划
              ▼ 记录后继续（fail-closed=否，不阻断）
```

**接缝稳定性**：MVP-1/2 可并行的前提——`ExecResult`/`DiffSummary` 的字段在 MVP-2 开发期冻结；Core 的 `feed_exec`/`repeat_check` 签名在 MVP-1 锁定。两方按冻结接口独立开发。

---

## 八、实现层次与文件布局

```
runtime/exec/                # Exec 实现（新建，零第三方依赖）
├── __init__.py
├── runner.py               # run(ExecRequest)->ExecResult + 安全约束
├── normalizers/            # 各框架归一化器（纯函数）
│   ├── pytest.py
│   ├── vitest.py
│   ├── jest.py
│   ├── cargo.py
│   ├── eslint.py
│   ├── tsc.py
│   ├── git_diff.py
│   └── generic.py         # unknown 降级
├── fingerprint.py         # compute_fingerprint + stable_hash
├── diff.py                # summarize_diff + 非 git 降级
├── artifact_io.py         # 调 memory_tool.py artifact put/page 的薄适配
└── cli.py                 # 命令行入口（LLM/人工可调）
tests/exec/
├── test_runner.py          # 执行/超时/输出外置/取消/命令不存在
├── test_normalizers.py     # 各框架样本输出归一化
├── test_fingerprint.py     # 指纹稳定性 + 重复检测
└── test_diff.py            # git diff 解析 + 非 git 降级 + plan_drift
```

**依赖**：`artifact_io.py` 经 subprocess 调 `python3 $SKILL_DIR/backup/memory_tool.py artifact put/page`（不改 memory_tool.py，复用其 CLI）；或 Adapter 内 import（若同 Python 进程）。**待 U10 决策调用方式**。

---

## 九、验收场景

| # | 场景 | 期望 |
|---|---|---|
| E1 | pytest 全过 | ok=True，pass_count 正确，无 artifact 外置 |
| E2 | pytest 部分失败 | ok=False，fail_count + error_summaries + fingerprint |
| E3 | 输出超 max_output_bytes | 外置 artifact，返回 ref，vc_code=OUTPUT_LIMIT，next=分页续取 |
| E4 | 命令不存在 | vc_code=ENV_ERROR，不消耗 Loop |
| E5 | 超时 | vc_code=TIMEOUT，子进程被 kill |
| E6 | 同一失败连续 2 次 | Core.repeat_check 返回 NO_PROGRESS |
| E7 | 不同失败（改了代码） | 指纹变化，consecutive_same 归 0 |
| E8 | git diff 含新增+修改+删除 | DiffSummary 三类正确，insertions/deletions 正确 |
| E9 | git diff 触及 auth 文件 | high_risk_files 命中 |
| E10 | 实际修改 ⊄ plan_files | plan_drift 非空，Core 返回 PLAN_DRIFT |
| E11 | 非 git 项目 | 降级文件存在性+mtime，标 degraded，不裸抛 |
| E12 | eslint --ext .js,.vue 0 error | ok=True，kind=lint |
| E13 | artifact page 分页取 stdout | ref 有效，分页返回，超 limit 报 OUTPUT_LIMIT |
| E14 | env 不继承宿主全量 | 仅显式传入项生效（敏感变量不泄露） |

**退出条件**：E1–E14 全绿；LLM 可经 `cli.py` 手动调 `exec run`/`exec summarize-diff` 跑真实任务（端到端冒烟）；memory_tool.py artifact 子系统**未被修改**（复用不改）。

---

## 十、未决问题

| # | 问题 | 倾向 |
|---|---|---|
| U9 | 失败指纹历史存 `.state.md` 哪里？ | 倾向存 `review` 字段内新增 `failure_fps[]` 子字段（向前兼容）；但需确认不破坏 13 字段 schema（走 skill-iteration） |
| U10 | Exec 调 memory_tool.py artifact 的方式：subprocess CLI vs Python import？ | CLI 优先（解耦、降级独立）；若 Adapter 同进程且性能敏感再 import。memory_tool.py 已是 CLI 设计 |
| U11 | 归一化器是否需要可配置（项目自定义测试框架输出格式）？ | MVP-2 内置常见框架（pytest/vitest/jest/cargo/eslint/tsc）；项目自定义走 `unknown` 降级 + LLM 读原始输出。不预抽象配置层 |
| U12 | Diff 汇总的 `base`（对比基线）如何确定？HEAD vs HEAD~1 vs main？ | 倾向 `HEAD`（未提交改动，最常用于 S8 出口）；可配置；多基线场景留后续 |
