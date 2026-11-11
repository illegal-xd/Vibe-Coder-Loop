/**
 * OpenCode local plugin: bridge host events/hooks to runtime.core CLI
 * (MVP-3 adapter, thin layer — it never reimplements the skill workflow).
 *
 * Failure policy (design §6): every hook is best-effort. A failed core CLI
 * call degrades to Phase 0 (LLM-driven workflow) and NEVER blocks the host.
 * The single exception is `tool.execute.before`, which denies denied tools
 * even when core is unreachable (fail-closed for high-risk tools).
 *
 * Performance contract (审查 v3):
 *   - tool.execute.after fires on EVERY tool call; feed-exec only runs for
 *     EXEC_CLASS_TOOLS (default bash/task). grep/webfetch/read/edit/write are
 *     skipped: their output is data, not an execution verdict, so feeding
 *     them costs a python spawn AND fabricates failure fingerprints.
 *     Extend via VIBE_BRIDGE_EXEC_TOOLS="grep,webfetch".
 *   - experimental.chat.system.transform fires on EVERY request. Pending
 *     resume/compaction → one full spawn; otherwise the warmed pointer cache
 *     is injected (0 blocking spawn). A cold pointer is warmed by a detached
 *     spawn (single in flight, 60s TTL).
 *   - Snapshot results are cached (full: 5s, pointer: 60s) per (cwd, detail).
 *
 * ExecResult fidelity (审查 v3): feed-exec drives failure aggregation, and
 * two consecutive same-fingerprint failures force S14 Safe Mode — so a false
 * "failed" verdict is a hard stop, not cosmetic noise. Therefore:
 *   - exit code comes from host metadata when present (probed keys
 *     exitCode/exit/code/status, `metadata` is typed `any`);
 *   - otherwise only STRICT failure markers in the output count as failure,
 *     and inspection-only bash commands (cat/grep/git log/…) never infer
 *     failure from their (data) output;
 *   - fingerprint = sha256(tool, semantic args, error lines) — output bodies
 *     and per-call metadata in args (description/timeout/ids) are excluded, so
 *     reruns of the same failing command keep the same fingerprint (that is
 *     what repeat-check counts; verified against a live host).
 *
 * Loaded automatically from .opencode/plugins/ by OpenCode.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { tool } from "@opencode-ai/plugin";

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PENDING_TTL_MS = 30 * 60 * 1000;
const CLI_TIMEOUT_MS = 10000;
const SNAPSHOT_FULL_TTL_MS = 5_000;
const SNAPSHOT_POINTER_TTL_MS = 60_000;

// Tools whose result is an execution verdict worth feeding to repeat-check.
// bash = real exit semantics; task = subagent outcome. grep/webfetch/read/edit/
// write/grep output data or content, which yields no trustworthy pass/fail
// signal and would cost one python spawn per call.
const EXEC_CLASS_DEFAULT = ["bash", "task"];
const EXEC_CLASS_TOOLS = new Set(
  `${EXEC_CLASS_DEFAULT.join(",")},${process.env.VIBE_BRIDGE_EXEC_TOOLS || ""}`
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function envList(name) {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function envFlag(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "" && v.trim() !== "0" && v.toLowerCase() !== "false";
}

const DISABLED = envFlag("VIBE_BRIDGE_DISABLED");
const DEBUG = envFlag("VIBE_BRIDGE_DEBUG");
// Hoisted: tool.execute.before runs on every call, so do not re-parse env there.
const DENY_TOOLS = new Set(envList("VIBE_BRIDGE_DENY_TOOLS"));

function fsStatSync(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolve the spawn cwd = directory containing the `runtime/` package.
 * Order: VIBE_KERNEL_HOME → this plugin's repo root → skill symlink target's repo.
 * Returns "" when nothing found (spawn will fail → degraded).
 */
function resolveRuntimeDir() {
  const candidates = [];
  if (process.env.VIBE_KERNEL_HOME) candidates.push(process.env.VIBE_KERNEL_HOME);
  candidates.push(path.resolve(PLUGIN_DIR, "..", ".."));
  try {
    candidates.push(
      path.resolve(os.homedir(), ".agents", "skills", "vibe-coder-loop", "..", "..")
    );
  } catch {
    // ignore
  }
  for (const dir of candidates) {
    if (!dir) continue;
    if (fsStatSync(path.join(dir, "runtime"))?.isDirectory()) return dir;
  }
  return "";
}

const RUNTIME_DIR = DISABLED ? "" : resolveRuntimeDir();
let bootDiagnosticEmitted = false;
function emitBootDiagnostic() {
  if (bootDiagnosticEmitted) return;
  bootDiagnosticEmitted = true;
  if (DISABLED) {
    console.warn("[vibe-bridge] disabled via VIBE_BRIDGE_DISABLED=1");
  } else if (!RUNTIME_DIR) {
    console.warn(
      "[vibe-bridge] degraded: runtime/ not found (set VIBE_KERNEL_HOME or install in repo); hooks will no-op, vc_* tools return BRIDGE_CLI_UNAVAILABLE"
    );
  } else if (DEBUG) {
    // Silent by default on success; only announce the resolved runtime in debug.
    console.warn(`[vibe-bridge] runtime at ${RUNTIME_DIR}`);
  }
}

function debugWarn(message, detail) {
  if (!DEBUG) return;
  try {
    console.warn(`[vibe-bridge] ${message}`, detail ?? "");
  } catch {
    // ignore
  }
}

/**
 * Python launcher candidates. `VIBE_KERNEL_PYTHON` wins; otherwise the
 * platform defaults. Windows normally has no `python3` executable (only the
 * `python` / `py` launchers; the Microsoft Store `python3.exe` alias stub
 * exits 9009 instead of running Python), so a hard-coded `python3` makes every
 * hook degrade on Windows even when Python is installed.
 */
function pythonCandidates() {
  const explicit = (process.env.VIBE_KERNEL_PYTHON || "").trim();
  if (explicit) return [explicit];
  return process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
}
const PYTHON_CANDIDATES = pythonCandidates();
let pythonLauncher = null; // first candidate that actually started a process
// cmd.exe reports "command not found" as 9009; the Microsoft Store `python3`
// alias stub surfaces this instead of failing to spawn.
const WINDOWS_STORE_ALIAS_EXIT = 9009;

/**
 * One launch attempt. Resolves null only when the process could not start at
 * all (ENOENT / spawn error); a non-zero exit still resolves with `out`.
 */
function spawnOnce(python, modulePath, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, ["-m", modulePath, ...args], {
        cwd: RUNTIME_DIR,
        // The core CLI prints UTF-8 JSON / plain text. Without these, Windows
        // Python falls back to the ANSI code page (e.g. gbk) for pipes, which
        // corrupts the plain-text `snapshot-task-zone` channel.
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CLI_TIMEOUT_MS,
      });
    } catch {
      return resolve(null);
    }
    let out = "";
    let err = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      if (DEBUG) err = (err + d).slice(-2000);
    });
    // `error` may be followed by `close`; the first outcome wins.
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (DEBUG && code !== 0) debugWarn(`core exit=${code}`, { modulePath, args, stderr: err.trim() });
      finish({ out, code });
    });
  });
}

/**
 * Run a CLI module as argv-array subprocess. Never throws.
 * Returns { out, code } or null when the CLI cannot run at all.
 * Exit code is NOT a gate: protocol rejections (2/3/4) still carry structured
 * JSON on stdout, and callers decide what a non-zero code means.
 *
 * The launcher is probed on first use and cached, so the candidate loop costs
 * nothing on the hot path.
 */
async function spawnCli(modulePath, args) {
  if (!RUNTIME_DIR) return null;
  const candidates = pythonLauncher ? [pythonLauncher] : PYTHON_CANDIDATES;
  for (const python of candidates) {
    const result = await spawnOnce(python, modulePath, args);
    const storeStub =
      process.platform === "win32" &&
      result !== null &&
      result.code === WINDOWS_STORE_ALIAS_EXIT &&
      String(result.out).trim() === "";
    if (result !== null && !storeStub) {
      if (!pythonLauncher) {
        pythonLauncher = python;
        debugWarn(`python launcher resolved: ${python}`);
      }
      return result;
    }
  }
  debugWarn("no usable python launcher", { candidates: PYTHON_CANDIDATES });
  return null;
}

/** JSON CLI call; null when unusable or stdout is not JSON (CLI truly unavailable). */
async function core(args) {
  const r = await spawnCli("runtime.core", args);
  if (!r) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    debugWarn("core returned non-JSON stdout", { args, tail: String(r.out).slice(-200) });
    return null;
  }
}

/** Text CLI call (snapshot-task-zone is plain text); null unless exit 0 + non-empty. */
async function coreText(args) {
  const r = await spawnCli("runtime.core", args);
  if (!r || r.code !== 0 || typeof r.out !== "string" || r.out.trim() === "") return null;
  return r.out;
}

// ─── Snapshot cache (P2: cut per-request spawn to 0 on hot path) ─────────────
const snapshotCache = new Map(); // key: `${cwd}|${detail}` -> { text, at }
function getCachedSnapshot(cwd, detail) {
  const key = `${cwd}|${detail}`;
  const entry = snapshotCache.get(key);
  if (!entry) return null;
  const ttl = detail === "full" ? SNAPSHOT_FULL_TTL_MS : SNAPSHOT_POINTER_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    snapshotCache.delete(key);
    return null;
  }
  return entry.text;
}
function setCachedSnapshot(cwd, detail, text) {
  snapshotCache.set(`${cwd}|${detail}`, { text, at: Date.now() });
}

// ─── ExecResult construction (P1: real fields, not silent defaults) ─────────
// args are NOT a stable identity: the host puts per-call metadata in them
// (description/title/timeout ids), so two byte-identical commands produce
// different JSON and repeat-check never counts the rerun. Verified on a live
// host: the same `python3 -c "raise SystemExit(1)"` twice yielded two
// fingerprints. Fingerprint the semantic payload only.
const FP_META_KEYS = new Set([
  "description", "title", "timeout", "workdir", "callID", "id", "sessionID",
]);

function fingerprintArgs(args) {
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object") return "";
  if (typeof args.command === "string") return args.command; // bash-like: command is the identity
  const picked = {};
  for (const key of Object.keys(args).sort()) {
    if (!FP_META_KEYS.has(key)) picked[key] = args[key];
  }
  try {
    return JSON.stringify(picked);
  } catch {
    return "<unserializable-args>";
  }
}

function hashFingerprint(tool, args, errors) {
  const h = createHash("sha256");
  h.update(String(tool ?? ""));
  h.update("\0");
  h.update(fingerprintArgs(args));
  // Failure mode (error lines) participates; the output BODY deliberately does
  // not — volatile text (paths/timestamps) would make reruns of the same
  // failing command look like different failures and disable repeat-check.
  if (errors.length > 0) {
    h.update("\0");
    h.update(errors.join("\n"));
  }
  return h.digest("hex");
}

/**
 * Host `metadata` is typed `any`; probe the plausible exit-status keys and
 * return null when the host exposes none (→ fall back to text heuristics).
 */
function exitCodeFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  for (const key of ["exitCode", "exit", "code", "status"]) {
    const v = metadata[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function extractExitCode(output) {
  if (typeof output !== "string" || output === "") return null;
  // Runner summaries only ("exit code 2", "exit=1", "rc=4"); arbitrary numbers
  // in normal output must not be read as an exit status.
  const m = output.match(/(?:exit[ _]?(?:code|status)?[=:]|\brc=)\s*(-?\d+)/i);
  return m ? Number(m[1]) : null;
}

// Strict failure markers: high precision, no bare "error"/"failed" substring
// match (that turns `grep error src/` into a recorded failure).
const FAILURE_MARKERS = [
  /^\s*Traceback \(most recent call last\):/m,
  /^\s*(?:npm|pnpm|yarn) ERR!/m,
  /\bELIFECYCLE\b/,
  /^\s*BUILD FAILURE\b/m,
  /\bcommand not found\b/,
  /^\s*(?:fatal|panic):/m,
  /^\s*(?:FAILED|FAIL)\b.*\b(?:test|tests|assert|assertion)/im,
  /^\s*(?:ERROR|Error|error):/m,
  /^\s*(?:SyntaxError|TypeError|ReferenceError|ImportError|ModuleNotFoundError)\b/m,
  /\berror\[E\d+\]/,
  /^\s*Failed to\b/m,
  // Runner summary lines: "3 failed, 5 passed". Require a NON-ZERO count so a
  // green run printing "0 failed" is not recorded as a failure.
  /\b[1-9]\d* (?:failed|errors?)\b/,
];

function extractErrors(output) {
  if (typeof output !== "string" || output === "") return [];
  const errs = [];
  for (const line of output.split("\n")) {
    if (line.length < 400 && FAILURE_MARKERS.some((re) => re.test(line))) {
      errs.push(line.trim().slice(0, 200));
      if (errs.length >= 5) break;
    }
  }
  return errs;
}

// Inspection-only commands print DATA; a line that says "Error:" in a log file
// is content, not a failed execution. Only a host exit status may flag failure.
const READ_ONLY_COMMANDS = new Set([
  "cat", "bat", "head", "tail", "less", "more", "grep", "rg", "ag", "ls", "find",
  "tree", "wc", "stat", "file", "jq", "diff", "sort", "uniq", "cut", "du", "df",
  "pwd", "which", "type", "echo", "printf",
]);
const READ_ONLY_GIT = new Set([
  "log", "show", "diff", "status", "blame", "branch", "rev-parse", "ls-files",
  "describe", "remote",
]);

function isInspectionCommand(args) {
  const cmd = typeof args === "string" ? args : args?.command;
  if (typeof cmd !== "string" || cmd.trim() === "") return false;
  const tokens = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    // skip env prefixes (FOO=1) and `cd <dir> &&` prologues
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      i += 1;
      continue;
    }
    if (tokens[i] === "cd" && tokens[i + 1] && tokens[i + 2] === "&&") {
      i += 3;
      continue;
    }
    break;
  }
  let head = tokens[i] || "";
  if (head.includes("/")) head = head.slice(head.lastIndexOf("/") + 1);
  if (READ_ONLY_COMMANDS.has(head)) return true;
  if (head === "git") return READ_ONLY_GIT.has(tokens[i + 1] || "");
  return false;
}

function extractFilesModified(tool, args) {
  if (!args || typeof args !== "object") return [];
  // edit/write tools carry the target path in args.filePath / args.path
  const p = args.filePath || args.path || args.file;
  return typeof p === "string" && p ? [p] : [];
}

/**
 * Build an ExecResult dict that ExecResult.from_dict accepts with REAL fields.
 *
 * ok=false requires evidence: a non-zero host exit status, or a strict failure
 * marker in output that is not an inspection command's data. Marking output
 * with an incidental "error" substring as failed used to escalate two
 * consecutive identical calls straight into S14 Safe Mode.
 *
 * Inspection commands (`grep` / `diff` / `which` / `git diff` …) use the exit
 * status as a QUERY RESULT, not as a verdict on the change: `grep` exits 1 on
 * "no match", `diff` exits 1 on "files differ", `which` exits 1 on "not found".
 * Counting that as a failed execution used to push two ordinary exploration
 * calls into S14 Safe Mode, so for inspection commands only output-level
 * failure markers (which are already suppressed for data output) can fail.
 */
function buildExecResult(hookInput, hookOutput) {
  const output = hookOutput?.output;
  const tool = hookInput?.tool;
  const metaExit = exitCodeFromMetadata(hookOutput?.metadata);
  const inspection = tool === "bash" && isInspectionCommand(hookInput?.args);
  const exitCode =
    metaExit ?? (inspection ? null : extractExitCode(output)) ?? 0;
  const errors = inspection ? [] : extractErrors(output);
  const failed = (exitCode !== 0 && !inspection) || errors.length > 0;
  return {
    exec_id: `hook:${hookInput?.callID || Date.now()}`,
    ok: !failed,
    exit_code: exitCode,
    fingerprint: hashFingerprint(tool, hookInput?.args, errors),
    files_modified: extractFilesModified(tool, hookInput?.args),
    errors,
  };
}

/** Mirrors core `_reference_verifiable` shape (without touching the filesystem):
 *  `path:` / `user:` / `sym:` / `fn:` / `step N` / `s12`, or anything carrying a
 *  relative path (`a/b`) or a file suffix. Absolute paths are rejected by core. */
const REF_SUFFIX_RE = /\.[A-Za-z0-9]{1,8}$/;
const REF_STEP_RE = /^(?:step\s+\d+|s\d{1,2})$/i;

function looksVerifiable(item) {
  const text = String(item || "").trim();
  if (!text) return false;
  if (/^(?:path|user|sym|fn):/i.test(text)) return true;
  if (REF_STEP_RE.test(text)) return true;
  if (text.includes("/") || REF_SUFFIX_RE.test(text)) return !text.startsWith("/");
  return false;
}

/** Mirrors core `validate_exit_checklist`: stage + non-empty checked_items +
 *  non-empty referenced_outputs (at least one mechanically verifiable item). */
function normalizeChecklist(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const stage = typeof raw.stage === "string" ? raw.stage : "";
  const refs = Array.isArray(raw.referenced_outputs)
    ? raw.referenced_outputs.filter((x) => typeof x === "string" && x.trim() !== "")
    : [];
  const checks = Array.isArray(raw.checked_items)
    ? raw.checked_items.filter((x) => typeof x === "string" && x.trim() !== "")
    : [];
  if (!stage || checks.length === 0 || refs.length === 0) return null;
  if (!refs.some(looksVerifiable)) return null;
  return { stage, referenced_outputs: refs, checked_items: checks };
}

export const VibeBridgePlugin = async (input) => {
  emitBootDiagnostic();
  const directory = input?.directory || process.cwd();
  const cwd = input?.worktree || directory;

  const pendingInject = new Map();

  function markPending(sid, mode) {
    if (!sid) return;
    const now = Date.now();
    for (const [k, v] of pendingInject) {
      if (now - v.at > PENDING_TTL_MS) pendingInject.delete(k);
    }
    pendingInject.set(sid, { mode, at: now });
  }

  function popPending(sid) {
    const v = pendingInject.get(sid);
    if (v) pendingInject.delete(sid);
    return v || null;
  }

  /** TASK zone snapshot text (plain-text CLI), cached; null on failure. */
  async function taskZoneText(detail) {
    const d = detail || "full";
    const cached = getCachedSnapshot(cwd, d);
    if (cached != null) return cached;
    const text = await coreText(["snapshot-task-zone", "--cwd", cwd, "--detail", d]);
    if (typeof text === "string" && text.trim() !== "") {
      setCachedSnapshot(cwd, d, text);
      return text;
    }
    return null;
  }

  // Pointer cache is only useful if something fills it. Warm it once in the
  // background (detached, single in flight) so later requests inject the
  // pointer at zero added latency instead of never injecting anything.
  // A failed warm backs off for the pointer TTL: a broken runtime must not
  // turn every chat request into a spawn attempt.
  let pointerWarmInFlight = false;
  let pointerWarmAt = 0;
  function warmPointer() {
    if (pointerWarmInFlight || getCachedSnapshot(cwd, "pointer")) return;
    if (Date.now() - pointerWarmAt < SNAPSHOT_POINTER_TTL_MS) return;
    pointerWarmInFlight = true;
    pointerWarmAt = Date.now();
    void taskZoneText("pointer")
      .catch(() => {})
      .finally(() => {
        pointerWarmInFlight = false;
      });
  }

  /** Wrap injected text with a marker so LLM knows this is a checkpoint, not prompt. */
  function wrapInject(text, kind) {
    if (typeof text !== "string" || text.trim() === "") return null;
    const tag = kind === "full" ? "VC checkpoint (full)" : "VC checkpoint (pointer)";
    return `<!-- ${tag} -->\n${text}\n<!-- /${tag} -->`;
  }

  return {
    // ── Mechanism A: generic events (Event union only) ─────────────────────
    event: async ({ event } = {}) => {
      if (!event || DISABLED) return;
      try {
        if (event.type === "session.created") {
          const rec = await core(["load-checkpoint", "--cwd", cwd]);
          if (rec && (rec.mode === "resume" || rec.mode === "resume_degraded")) {
            markPending(event.properties?.info?.id, "resume");
          }
        } else if (event.type === "session.compacted") {
          markPending(event.properties?.sessionID, "compacted");
        }
        // session.idle / session.status / command.executed: not state-writing (design §4.1)
      } catch {
        // best-effort
      }
    },

    // ── Mechanism B: named hooks ───────────────────────────────────────────
    "tool.execute.after": async (hookInput, hookOutput) => {
      if (DISABLED) return;
      // P2: only feed execution-class tools; read/edit/write carry no observable exit.
      if (!hookInput || !EXEC_CLASS_TOOLS.has(hookInput.tool)) return;
      try {
        const result = buildExecResult(hookInput, hookOutput);
        await core(["feed-exec", "--cwd", cwd, "--result", JSON.stringify(result)]);
      } catch {
        // best-effort
      }
    },

    "tool.execute.before": async (hookInput, _hookOutput) => {
      if (DISABLED) return;
      const tool = String(hookInput?.tool || "").toLowerCase();
      if (DENY_TOOLS.has(tool)) {
        throw new Error(
          `[SCOPE_DENIED] tool '${tool}' 在 VIBE_BRIDGE_DENY_TOOLS 中\n[next] 从环境变量移除该工具名，或改用宿主权限配置`
        );
      }
    },

    "experimental.session.compacting": async (_hookInput, hookOutput) => {
      if (DISABLED) return;
      try {
        const text = await taskZoneText("full");
        const wrapped = wrapInject(text, "full");
        if (wrapped) hookOutput?.context?.push?.(wrapped);
      } catch {
        // injection failure must not block compaction
      }
    },

    "experimental.compaction.autocontinue": async (_hookInput, hookOutput) => {
      if (DISABLED) return;
      try {
        // Host default is already true; set explicitly so a compaction never
        // strands the injected TASK zone waiting for user input.
        if (hookOutput && typeof hookOutput === "object") hookOutput.enabled = true;
      } catch {
        // best-effort
      }
    },

    "experimental.chat.system.transform": async (hookInput, hookOutput) => {
      if (DISABLED) return;
      try {
        const sid = hookInput?.sessionID;
        const pending = sid ? popPending(sid) : null;
        if (pending) {
          // Resume / post-compaction: inject full TASK zone, bypass cache freshness.
          snapshotCache.delete(`${cwd}|full`);
          const text = await taskZoneText("full");
          const wrapped = wrapInject(text, "full");
          if (wrapped && hookOutput?.system) {
            hookOutput.system.push(wrapped);
            return;
          }
        }
        // Hot path: inject the pointer when warm (0 spawn); otherwise warm it
        // in the background so the NEXT request has it.
        const cachedPtr = getCachedSnapshot(cwd, "pointer");
        if (cachedPtr) {
          const wrapped = wrapInject(cachedPtr, "pointer");
          if (wrapped && hookOutput?.system) hookOutput.system.push(wrapped);
        } else {
          warmPointer();
        }
      } catch {
        // injection failure silent (design §6)
      }
    },

    // ── Custom tools (LLM calls explicitly) ────────────────────────────────
    tool: {
      vc_transition: tool({
        description:
          "Vibe Kernel 状态转换（唯一 mutation 入口）。在阶段出口调用，必须传 stage + 非空 referenced_outputs（至少一项可机械验证的引用）+ 非空 checked_items，否则插件侧直接拒绝（CHECKLIST_INVALID，不浪费 spawn）。合法转移见 engine/transition.md 转移表（如 S0→S1、S1→S2、S2→S3/S4、S4→S5/S7/S8、S8→S9、S9→S10、S12→S13；`to` 也接受 PAUSE/RESUME）。非法转移返回 STATE_ILLEGAL_TRANSITION。S4 出口必须传 level（0-4）记录复杂度分级。",
        args: {
          to: tool.schema.string().describe("目标阶段（S0–S14 / PAUSE / RESUME）"),
          loop: tool.schema.number().optional().describe("Loop 计数（回退边自动 +1；调用方不传则沿用）"),
          level: tool.schema.number().optional().describe("复杂度等级 0-4；S4 出口必须写入"),
          stage: tool.schema.string().describe("当前阶段码，必须等于状态里的当前阶段"),
          referenced_outputs: tool.schema
            .array(tool.schema.string())
            .describe("本阶段引用的产出（文件路径/行号/ref），至少一项可机械验证"),
          checked_items: tool.schema
            .array(tool.schema.string())
            .describe("出口条件逐项勾选证据"),
          expected_rev: tool.schema.number().optional().describe("乐观并发：当前 rev（不匹配则拒绝）"),
          force: tool.schema.boolean().optional().describe("强制转移（须传 reason；仅限升级到 S14 等场景）"),
          reason: tool.schema.string().optional().describe("force 时的原因"),
        },
        async execute(args, _ctx) {
          // Use the plugin-resolved cwd (same key as every hook) — a divergent
          // cwd would split the checkpoint per project path and break resume.
          const argv = ["transition", "--cwd", cwd, "--to", args.to];
          if (args.loop != null) argv.push("--loop", String(args.loop));
          if (args.level != null) argv.push("--level", String(args.level));
          if (args.expected_rev != null) argv.push("--rev", String(args.expected_rev));
          const checklist = normalizeChecklist({
            stage: args.stage,
            referenced_outputs: args.referenced_outputs,
            checked_items: args.checked_items,
          });
          if (!checklist) {
            return JSON.stringify({
              ok: false,
              code: "CHECKLIST_INVALID",
              next: "exit_checklist 需 stage 码 + 非空 checked_items + 非空 referenced_outputs（至少一项可机械验证的引用）；补齐后再调",
            });
          }
          argv.push("--checklist", JSON.stringify(checklist));
          if (args.force) argv.push("--force");
          if (args.reason) argv.push("--reason", args.reason);
          const rec = await core(argv);
          if (!rec) {
            return JSON.stringify({
              ok: false,
              code: "BRIDGE_CLI_UNAVAILABLE",
              next: "检查 python3 与 VIBE_KERNEL_HOME；本请求按 Phase 0（LLM 手动驱动）继续",
            });
          }
          return JSON.stringify(rec);
        },
      }),
      vc_state: tool({
        description: "查询 Vibe Kernel 当前状态快照（只读，不产生 mutation）。",
        args: {},
        async execute(_args, _ctx) {
          const rec = await core(["get-state", "--cwd", cwd]);
          if (!rec) {
            return JSON.stringify({ ok: false, code: "BRIDGE_CLI_UNAVAILABLE", next: "检查 python3 / VIBE_KERNEL_HOME" });
          }
          return JSON.stringify(rec);
        },
      }),
    },
  };
};

export default VibeBridgePlugin;
