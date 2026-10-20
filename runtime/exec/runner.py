"""执行器：Popen 流式采集 + 有界 Sink + 整树终止 + 归一化 + 指纹。

事实源：MVP-2 §三

关键设计：
- **内存有界（执行期即有界）**：Sink 前缀留内存，超出落盘，硬上限丢弃——不读完再限。
- **ref 与 head 互斥补充**：ref 用于分页精读，head 保证即使外置失败也有可用信息。
- **永不返回指向不存在产物的 ref**（put 后回读校验）。
- **stage 不进指纹**（同错跨阶段算同一失败）。
- 环境类失败（ENV_ERROR/TIMEOUT/CANCELLED）不进指纹计数。
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from runtime.core import vc_codes
from runtime.core.artifacts import ArtifactStore

from . import normalizers
from .env import build_env
from .fingerprint import compute_fingerprint
from .policy import PolicyDecision, check_policy, is_command_available
from .proc_tree import kill_process_tree
from .redact import redact_output
from .sink import Sink
from .artifact_io import ArtifactSink, ArtifactPutResult


@dataclass(frozen=True)
class ExecRequest:
    cmd: list[str]
    cwd: str
    timeout_ms: int = 300_000
    env_extra: dict[str, str] | None = None
    env_passthrough: list[str] = field(default_factory=list)
    max_output_bytes: int = 100_000
    max_spill_bytes: int = 52_428_800  # 50MB
    lang: str = "auto"
    stage: str = ""  # 不进指纹，仅日志/报告
    exec_id: str = ""
    cancel_event: threading.Event | None = None
    allow_high_risk: bool = False
    extra_allowlist: list[str] | None = None
    kill_grace_ms: int = 3000
    artifact_store: ArtifactStore | None = None  # None → 不外置
    pin_output: bool = False  # Stage∈{S9,S10} 失败输出自动 pin

    def __post_init__(self) -> None:
        if not self.cmd:
            raise ValueError("cmd 不能为空")
        if not self.cwd:
            raise ValueError("cwd 必填")
        if not self.exec_id:
            object.__setattr__(self, "exec_id", str(uuid.uuid4()))


@dataclass(frozen=True)
class ExecResult:
    """执行结果（MVP-2 §3.1 的 rich ExecResult）。

    与 Core 的 ``runtime.core.core.ExecResult`` 不同：后者是 feed_exec 的入参。
    用 :meth:`to_core_result` 转换。
    """

    exec_id: str
    ok: bool
    exit_code: int
    duration_ms: int
    stdout_ref: str | None
    stderr_ref: str | None
    stdout_head: str
    stderr_head: str
    stdout_bytes: int
    stderr_bytes: int
    externalized: bool
    truncated: bool
    dropped_bytes: int
    artifact_error: str | None
    normalized: normalizers.NormalizedResult | None
    fingerprint: str
    vc_code: str | None
    next: str | None
    env_redactions: int
    stdout_ref_meta: dict[str, Any] | None = None
    stderr_ref_meta: dict[str, Any] | None = None
    files_modified: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    plan_files: list[str] | None = None
    tree_leaked: bool = False
    stage: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "exec_id": self.exec_id,
            "ok": self.ok,
            "exit_code": self.exit_code,
            "duration_ms": self.duration_ms,
            "stdout_ref": self.stdout_ref,
            "stderr_ref": self.stderr_ref,
            "stdout_ref_meta": self.stdout_ref_meta,
            "stderr_ref_meta": self.stderr_ref_meta,
            "stdout_head": self.stdout_head,
            "stderr_head": self.stderr_head,
            "stdout_bytes": self.stdout_bytes,
            "stderr_bytes": self.stderr_bytes,
            "externalized": self.externalized,
            "truncated": self.truncated,
            "dropped_bytes": self.dropped_bytes,
            "artifact_error": self.artifact_error,
            "normalized": self.normalized.to_dict() if self.normalized else None,
            "fingerprint": self.fingerprint,
            "vc_code": self.vc_code,
            "next": self.next,
            "env_redactions": self.env_redactions,
            "files_modified": list(self.files_modified),
            "errors": list(self.errors),
            "plan_files": list(self.plan_files) if self.plan_files is not None else None,
            "tree_leaked": self.tree_leaked,
            "stage": self.stage,
        }

    def to_core_result(self) -> Any:
        """转换为 Core.feed_exec 可消费的 ExecResult（延迟导入避免循环依赖）。"""
        from runtime.core.core import ExecResult as CoreER
        return CoreER(
            exec_id=self.exec_id,
            ok=self.ok,
            exit_code=self.exit_code,
            fingerprint=self.fingerprint,
            files_modified=list(self.files_modified),
            errors=list(self.errors) or (
                [self.normalized.stats_raw] if self.normalized and not self.ok else []
            ),
            plan_files=list(self.plan_files) if self.plan_files is not None else None,
            vc_violation=self.vc_code if self.vc_code == vc_codes.SCOPE_DENIED else "",
            started_at="",
            finished_at="",
        )


def _env_error(req: ExecRequest, reason: str) -> ExecResult:
    return ExecResult(
        exec_id=req.exec_id,
        ok=False,
        exit_code=-1,
        duration_ms=0,
        stdout_ref=None,
        stderr_ref=None,
        stdout_head="",
        stderr_head=reason,
        stdout_bytes=0,
        stderr_bytes=len(reason.encode("utf-8")),
        externalized=False,
        truncated=False,
        dropped_bytes=0,
        artifact_error=None,
        normalized=None,
        fingerprint="",
        vc_code=vc_codes.ENV_ERROR,
        next=vc_codes.next_action(vc_codes.ENV_ERROR),
        env_redactions=0,
        stage=req.stage,
    )


def _scope_denied(req: ExecRequest, decision: PolicyDecision) -> ExecResult:
    return ExecResult(
        exec_id=req.exec_id,
        ok=False,
        exit_code=-1,
        duration_ms=0,
        stdout_ref=None,
        stderr_ref=None,
        stdout_head="",
        stderr_head=decision.reason,
        stdout_bytes=0,
        stderr_bytes=len(decision.reason.encode("utf-8")),
        externalized=False,
        truncated=False,
        dropped_bytes=0,
        artifact_error=None,
        normalized=None,
        fingerprint="",
        vc_code=vc_codes.SCOPE_DENIED,
        next=decision.next or vc_codes.next_action(vc_codes.SCOPE_DENIED),
        env_redactions=0,
        stage=req.stage,
    )


def _pump(stream, sink: Sink) -> None:
    """读取线程：块读，写 Sink。"""
    try:
        while True:
            chunk = stream.read(8192)
            if not chunk:
                break
            if isinstance(chunk, str):
                chunk = chunk.encode("utf-8", "replace")
            sink.write(chunk)
    except (OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass


def run(req: ExecRequest) -> ExecResult:
    """执行命令，返回结构化结果。内存恒有界。"""
    start = time.monotonic()

    # 1. 策略检查（行为层）
    env = build_env(req.env_extra, env_passthrough=req.env_passthrough)
    decision = check_policy(
        req.cmd,
        allow_high_risk=req.allow_high_risk,
        extra_allowlist=req.extra_allowlist,
        env=env,
    )
    if not decision.allowed:
        return _scope_denied(req, decision)

    # 2. 命令存在性校验（注入层 + 环境可用性）
    binary_path = is_command_available(req.cmd[0], env=env)
    if binary_path is None:
        return _env_error(req, f"命令不存在: {req.cmd[0]}（PATH 不可用）")

    # 用解析后的完整路径
    cmd = list(req.cmd)
    cmd[0] = binary_path

    # 3. Popen 流式采集
    try:
        popen_kwargs: dict[str, Any] = dict(
            cwd=req.cwd,
            env=env,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if os.name == "posix":
            popen_kwargs["start_new_session"] = True
        else:
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        proc = subprocess.Popen(cmd, **popen_kwargs)
    except OSError as exc:
        return _env_error(req, f"启动失败: {exc}")

    sink_out = Sink(req.max_output_bytes, req.max_spill_bytes)
    sink_err = Sink(req.max_output_bytes, req.max_spill_bytes)
    t_out = threading.Thread(target=_pump, args=(proc.stdout, sink_out), daemon=True)
    t_err = threading.Thread(target=_pump, args=(proc.stderr, sink_err), daemon=True)
    t_out.start()
    t_err.start()

    from .proc_tree import KillResult
    kill_result = KillResult(ok=True, tree_leaked=False, method="none")
    timed_out = cancelled = False
    deadline = time.monotonic() + req.timeout_ms / 1000
    try:
        while proc.poll() is None:
            if req.cancel_event and req.cancel_event.is_set():
                cancelled = True
                break
            if time.monotonic() > deadline:
                timed_out = True
                break
            time.sleep(0.05)
    finally:
        if timed_out or cancelled:
            # kill 本身会让进程死亡 → 管道 EOF → 读取线程自然结束。
            # 关闭父端管道是有害的：会让 poll 在 grace 窗口内回收到 0（误判为正常退出）。
            kill_result = kill_process_tree(proc, grace_ms=req.kill_grace_ms)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

    t_out.join(timeout=2)
    t_err.join(timeout=2)

    duration_ms = int((time.monotonic() - start) * 1000)

    # 4–6. 脱敏 / 归一化 / 外置 —— try/finally 保证 spill 临时文件在异常路径也清理
    stdout_ref: str | None = None
    stderr_ref: str | None = None
    stdout_ref_meta: dict[str, Any] | None = None
    stderr_ref_meta: dict[str, Any] | None = None
    externalized = False
    artifact_error: str | None = None
    try:
        redact_out = redact_output(sink_out.head_text(), env)
        redact_err = redact_output(sink_err.head_text(), env)
        redactions = redact_out.redactions + redact_err.redactions
        head_out = redact_out.text
        head_err = redact_err.text
        # spill 内容脱敏（有界读取：最多 max_spill_redact_bytes，避免全文读入内存违反有界原则）
        _MAX_SPILL_REDACT = 2_000_000  # 2MB 上限，超出部分不脱敏（外置时携带原始 spill）
        spill_out_text = None
        spill_err_text = None
        if sink_out.spill_path:
            raw = sink_out.spill_content(max_bytes=_MAX_SPILL_REDACT)
            if raw:
                r = redact_output(raw, env)
                redactions += r.redactions
                spill_out_text = r.text
        if sink_err.spill_path:
            raw = sink_err.spill_content(max_bytes=_MAX_SPILL_REDACT)
            if raw:
                r = redact_output(raw, env)
                redactions += r.redactions
                spill_err_text = r.text

        truncated = sink_out.truncated or sink_err.truncated
        dropped_bytes = sink_out.dropped + sink_err.dropped
        total_out_bytes = sink_out.total_bytes
        total_err_bytes = sink_err.total_bytes

        # 5. 归一化（只吃有界 head）
        lang = req.lang if req.lang != "auto" else normalizers.infer_lang(req.cmd)
        norm = normalizers.normalize(
            lang, head_out, head_err, proc.returncode, req.cmd, truncated=truncated
        )

        # 6. 外置（仅当超限且有 store）
        if req.artifact_store is not None and truncated:
            asink = ArtifactSink(req.artifact_store)
            if sink_out.spilled > 0 or sink_out.dropped > 0:
                put = asink.put_stream(
                    head_out, spill_out_text,
                    reproducible=req.pin_output,
                    regen_cmd=req.cmd,
                )
                if put.ok:
                    stdout_ref = put.ref
                    stdout_ref_meta = put.to_ref_dict()
                    externalized = True
                else:
                    artifact_error = put.error
            if sink_err.spilled > 0 or sink_err.dropped > 0:
                put = asink.put_stream(
                    head_err, spill_err_text,
                    reproducible=req.pin_output,
                    regen_cmd=req.cmd,
                )
                if put.ok:
                    stderr_ref = put.ref
                    stderr_ref_meta = put.to_ref_dict()
                    externalized = True
                else:
                    artifact_error = put.error or artifact_error
    finally:
        sink_out.close()
        sink_err.close()

    # 7. 码判定
    ok = (proc.returncode == 0) and not cancelled
    if timed_out:
        vc_code = vc_codes.TIMEOUT
        nxt = vc_codes.next_action(vc_codes.TIMEOUT)
        fingerprint = ""  # 环境类失败不进指纹
    elif cancelled:
        vc_code = vc_codes.CANCELLED
        nxt = vc_codes.next_action(vc_codes.CANCELLED)
        fingerprint = ""
    elif dropped_bytes > 0:
        vc_code = vc_codes.OUTPUT_LIMIT
        nxt = "artifact page --offset 续取；或减小输出后重试"
        fingerprint = _compute_fp(req, proc.returncode, norm, head_err) if not ok else ""
    elif externalized:
        vc_code = vc_codes.OUTPUT_LIMIT
        nxt = "artifact page --offset 分页续取"
        fingerprint = _compute_fp(req, proc.returncode, norm, head_err) if not ok else ""
    elif artifact_error:
        vc_code = vc_codes.OUTPUT_LIMIT
        nxt = "减小输出或修复 artifact 目录后重试"
        fingerprint = _compute_fp(req, proc.returncode, norm, head_err) if not ok else ""
    elif truncated:
        # TS-01 修复：truncated 但无外置/无丢弃（artifact_store=None 或 spill 未超限）时
        # 仍须设 OUTPUT_LIMIT，否则数据静默丢失却不报告
        vc_code = vc_codes.OUTPUT_LIMIT
        nxt = "输出已截断；增大 max_output_bytes 或启用 --externalize"
        fingerprint = _compute_fp(req, proc.returncode, norm, head_err) if not ok else ""
    elif not ok:
        vc_code = ""
        nxt = ""
        fingerprint = _compute_fp(req, proc.returncode, norm, head_err)
    else:
        vc_code = None
        nxt = None
        fingerprint = ""

    return ExecResult(
        exec_id=req.exec_id,
        ok=ok,
        exit_code=int(proc.returncode) if proc.returncode is not None else -1,
        duration_ms=duration_ms,
        stdout_ref=stdout_ref,
        stderr_ref=stderr_ref,
        stdout_ref_meta=stdout_ref_meta,
        stderr_ref_meta=stderr_ref_meta,
        stdout_head=head_out,
        stderr_head=head_err,
        stdout_bytes=total_out_bytes,
        stderr_bytes=total_err_bytes,
        externalized=externalized,
        truncated=truncated,
        dropped_bytes=dropped_bytes,
        artifact_error=artifact_error,
        normalized=norm,
        fingerprint=fingerprint,
        vc_code=vc_code,
        next=nxt,
        env_redactions=redactions,
        tree_leaked=kill_result.tree_leaked,
        stage=req.stage,
    )


def _compute_fp(
    req: ExecRequest, exit_code: int, norm: normalizers.NormalizedResult | None, stderr_head: str
) -> str:
    """计算指纹。环境类失败不进指纹（调用方已保证）。"""
    return compute_fingerprint(req.cmd, exit_code, norm, stderr_head=stderr_head, cwd=req.cwd)

