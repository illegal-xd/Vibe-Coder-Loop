/**
 * vibe-bridge plugin regression tests.
 *
 * Guards the two failure-aggregation bugs that审查 v3 fixed:
 *   - inspection commands whose output contains "error" must NOT be recorded
 *     as failed executions (two such false failures force S14 Safe Mode);
 *   - the fingerprint must be stable across reruns of the same failing
 *     command (else repeat-check never counts).
 *
 * Uses a fake `runtime.core` Python module (no real state is written) so the
 * plugin's spawn argv and feed-exec payload can be asserted end-to-end.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readInjectionLog } from "../../.opencode/prompt-injection/log.js";

const PLUGIN_PATH = path.resolve(".opencode/plugins/vibe-bridge.js");

let tmp;
let feedsFile;
let callsFile;
let pluginUrl;
let mod;

const FAKE_CORE_PY = `
import sys, json, os
tmp = os.environ["VIBE_BRIDGE_TEST_TMP"]
calls = os.path.join(tmp, "calls.jsonl")
feeds = os.path.join(tmp, "feeds.jsonl")
argv = sys.argv[1:]
sub = argv[0] if argv else ""
rest = argv[1:]
def opt(name):
    for i, a in enumerate(rest):
        if a == name and i + 1 < len(rest):
            return rest[i + 1]
    return None
def log(kind, payload):
    with open(calls, "a") as f:
        f.write(json.dumps({"kind": kind, **payload}, ensure_ascii=False) + "\\n")
if sub == "feed-exec":
    raw = opt("--result")
    try:
        parsed = json.loads(raw) if raw else {}
    except Exception:
        parsed = {"raw": raw}
    with open(feeds, "a") as f:
        f.write(json.dumps(parsed, ensure_ascii=False) + "\\n")
    log("feed-exec", {"exec_id": parsed.get("exec_id")})
    print(json.dumps({"ok": True}))
elif sub == "snapshot-task-zone":
    detail = opt("--detail") or "full"
    log("snapshot-task-zone", {"detail": detail})
    if detail == "pointer":
        print("[VC pointer] phase=S0 loop=0 level=0")
    else:
        print("[VC checkpoint (full)]\\nphase=S0 loop=0 level=0\\nTASK: goal=...")
elif sub == "transition":
    log("transition", {"to": opt("--to"), "level": opt("--level"), "has_checklist": bool(opt("--checklist"))})
    print(json.dumps({"ok": True, "phase": opt("--to") or "S1", "rev": 1}))
elif sub in ("get-state", "load-checkpoint"):
    log(sub, {})
    print(json.dumps({"ok": True, "mode": "fresh_start", "phase": "S0", "rev": 0}))
else:
    print(json.dumps({"ok": False, "code": "BRIDGE_CLI_UNAVAILABLE", "sub": sub}))
`;

async function readJsonLines(file) {
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

/** Tool contract: `{ title?, output: string, metadata? }` — never a bare record. */
function parseToolResult(res) {
  assert.equal(typeof res, "object");
  assert.equal(typeof res.output, "string", "host renders `output`, so it must be a string");
  return JSON.parse(res.output);
}

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "vb-bridge-"));
  await mkdir(path.join(tmp, "runtime"));
  await writeFile(path.join(tmp, "runtime", "__init__.py"), "");
  await writeFile(path.join(tmp, "runtime", "core.py"), FAKE_CORE_PY);
  feedsFile = path.join(tmp, "feeds.jsonl");
  callsFile = path.join(tmp, "calls.jsonl");
  process.env.VIBE_KERNEL_HOME = tmp;
  process.env.VIBE_BRIDGE_TEST_TMP = tmp;
  delete process.env.VIBE_BRIDGE_DISABLED;
  delete process.env.VIBE_BRIDGE_DEBUG;
  delete process.env.VIBE_BRIDGE_DENY_TOOLS;
  delete process.env.VIBE_BRIDGE_EXEC_TOOLS;
  // Keep the real prompt-injection archive untouched unless a test opts in.
  process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED = "1";
  delete process.env.VIBE_PROMPT_INJECTION_HOME;
  pluginUrl = pathToFileURL(PLUGIN_PATH).href;
  mod = await import(pluginUrl);
});

after(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

async function newPlugin() {
  return mod.default({ directory: tmp, worktree: tmp });
}

test("grep output containing 'error' is not fed (data, not verdict)", async () => {
  const p = await newPlugin();
  await p["tool.execute.after"](
    { tool: "grep", callID: "g1", args: { command: "grep error src/" } },
    { output: "src/a.js:1:throw new Error('x')", metadata: {} }
  );
  const feeds = await readJsonLines(feedsFile);
  assert.equal(feeds.length, 0, "grep must not be fed to feed-exec by default");
});

test("inspection command (cat) with 'ERROR:' in output is not a failure", async () => {
  const p = await newPlugin();
  await p["tool.execute.after"](
    { tool: "bash", callID: "c1", args: { command: "cat error.log" } },
    { output: "ERROR: something exploded", metadata: {} }
  );
  const feeds = await readJsonLines(feedsFile);
  const last = feeds[feeds.length - 1];
  assert.ok(last, "feed captured");
  assert.equal(last.ok, true, "cat output is data, not a failure");
  assert.deepEqual(last.errors, []);
});

test("real failure (Traceback) is recorded and fingerprint is stable across reruns", async () => {
  const p = await newPlugin();
  const input = {
    tool: "bash",
    callID: "f1",
    args: { command: "python bad.py" },
  };
  const output = {
    output: "Traceback (most recent call last):\n  File \"bad.py\", line 1\nValueError: nope",
    metadata: {},
  };
  await p["tool.execute.after"]({ ...input, callID: "f1" }, output);
  await p["tool.execute.after"]({ ...input, callID: "f2" }, output);
  const feeds = await readJsonLines(feedsFile);
  const failures = feeds.filter((f) => f.exec_id === "hook:f1" || f.exec_id === "hook:f2");
  assert.equal(failures.length, 2);
  for (const f of failures) {
    assert.equal(f.ok, false);
    assert.ok(f.errors.length > 0);
    assert.ok(f.fingerprint, "fingerprint present");
  }
  assert.equal(
    failures[0].fingerprint,
    failures[1].fingerprint,
    "same failing command must keep the same fingerprint so repeat-check counts"
  );
});

test("fingerprint ignores per-call metadata in args (live-host regression)", async () => {
  const p = await newPlugin();
  const output = { output: "", metadata: { exitCode: 1 } };
  await p["tool.execute.after"](
    { tool: "bash", callID: "d1", args: { command: "./flaky", description: "first wording" } },
    output
  );
  await p["tool.execute.after"](
    {
      tool: "bash",
      callID: "d2",
      args: { command: "./flaky", description: "totally different wording", timeout: 5000 },
    },
    output
  );
  const feeds = await readJsonLines(feedsFile);
  const a = feeds.find((f) => f.exec_id === "hook:d1");
  const b = feeds.find((f) => f.exec_id === "hook:d2");
  assert.equal(
    a.fingerprint,
    b.fingerprint,
    "same command + different description/timeout must share a fingerprint"
  );
});

test("different commands keep different fingerprints", async () => {
  const p = await newPlugin();
  const output = { output: "", metadata: { exitCode: 1 } };
  await p["tool.execute.after"](
    { tool: "bash", callID: "e1", args: { command: "./flaky" } },
    output
  );
  await p["tool.execute.after"](
    { tool: "bash", callID: "e2", args: { command: "./other" } },
    output
  );
  const feeds = await readJsonLines(feedsFile);
  const a = feeds.find((f) => f.exec_id === "hook:e1");
  const b = feeds.find((f) => f.exec_id === "hook:e2");
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("host metadata exit code is authoritative", async () => {
  const p = await newPlugin();
  await p["tool.execute.after"](
    { tool: "bash", callID: "m1", args: { command: "./flaky" } },
    { output: "", metadata: { exitCode: 1 } }
  );
  const feeds = await readJsonLines(feedsFile);
  const last = feeds[feeds.length - 1];
  assert.equal(last.exit_code, 1);
  assert.equal(last.ok, false);
});

test("inspection command exit 1 (grep no match) is a query result, not a failure", async () => {
  const p = await newPlugin();
  await p["tool.execute.after"](
    { tool: "bash", callID: "i1", args: { command: "grep -rn createOrder src/" } },
    { output: "", metadata: { exitCode: 1 } }
  );
  await p["tool.execute.after"](
    { tool: "bash", callID: "i2", args: { command: "diff a.txt b.txt" } },
    { output: "1c1", metadata: { exitCode: 1 } }
  );
  const feeds = await readJsonLines(feedsFile);
  const a = feeds.find((f) => f.exec_id === "hook:i1");
  const b = feeds.find((f) => f.exec_id === "hook:i2");
  assert.equal(a.ok, true, "grep exit 1 means 'no match', not a failed execution");
  assert.equal(b.ok, true, "diff exit 1 means 'files differ', not a failed execution");
});

test("inspection command with host exit metadata still does not extract error markers", async () => {
  const p = await newPlugin();
  await p["tool.execute.after"](
    { tool: "bash", callID: "i3", args: { command: "cat error.log" } },
    { output: "ERROR: something exploded", metadata: { exitCode: 0 } }
  );
  const feeds = await readJsonLines(feedsFile);
  const last = feeds[feeds.length - 1];
  assert.equal(last.ok, true);
  assert.deepEqual(last.errors, []);
});

test("mutating git subcommands are not inspection-only", async () => {
  const p = await newPlugin();
  await p["tool.execute.after"](
    { tool: "bash", callID: "g1", args: { command: "git branch -d feature" } },
    { output: "error: branch 'feature' is not fully merged", metadata: { exitCode: 1 } }
  );
  const feeds = await readJsonLines(feedsFile);
  const last = feeds[feeds.length - 1];
  assert.equal(last.ok, false, "git branch -d can delete a branch, so it is not inspection-only");
});

test("host exit 0 wins over failure-looking output lines", async () => {
  const p = await newPlugin();
  await p["tool.execute.after"](
    { tool: "bash", callID: "x0", args: { command: "node app.js" } },
    {
      output: "server ready\nerror: optional plugin missing\nFailed to parse optional field, using default",
      metadata: { exit: 0 },
    }
  );
  const feeds = await readJsonLines(feedsFile);
  const last = feeds[feeds.length - 1];
  assert.equal(last.ok, true, "a clean host exit must not be vetoed by log text");
});

test("green test summary '0 failed' is not a failure", async () => {
  const p = await newPlugin();
  await p["tool.execute.after"](
    { tool: "bash", callID: "g0", args: { command: "pytest -q" } },
    { output: "===== 5 passed, 0 failed in 1.2s =====", metadata: {} }
  );
  const feeds = await readJsonLines(feedsFile);
  const last = feeds[feeds.length - 1];
  assert.equal(last.ok, true, "'0 failed' must not be a failure");
  assert.deepEqual(last.errors, []);
});

test("non-zero failure summary IS a failure", async () => {
  const p = await newPlugin();
  await p["tool.execute.after"](
    { tool: "bash", callID: "g1", args: { command: "pytest -q" } },
    { output: "===== 1 failed, 4 passed in 1.0s =====", metadata: {} }
  );
  const feeds = await readJsonLines(feedsFile);
  const last = feeds[feeds.length - 1];
  assert.equal(last.ok, false);
  assert.ok(last.errors.length > 0);
});

test("vc_transition rejects empty referenced_outputs without spawning", async () => {
  const callsBefore = (await readJsonLines(callsFile)).length;
  const p = await newPlugin();
  const res = await p.tool.vc_transition.execute(
    {
      to: "S1",
      stage: "S0",
      referenced_outputs: [],
      checked_items: ["goal triple output"],
    },
    {}
  );
  const rec = parseToolResult(res);
  assert.equal(rec.ok, false);
  assert.equal(rec.code, "CHECKLIST_INVALID");
  const callsAfter = await readJsonLines(callsFile);
  assert.equal(callsAfter.length, callsBefore, "no CLI spawn when checklist invalid");
});

test("vc_transition forwards --level and a valid checklist", async () => {
  const p = await newPlugin();
  // 出口引用只允许项目内相对路径（core `_project_relative_exists` 拒绝绝对路径）
  const ref = "plan.md";
  await writeFile(path.join(tmp, ref), "goal: ship it\n");
  const res = await p.tool.vc_transition.execute(
    {
      to: "S1",
      stage: "S0",
      level: 1,
      referenced_outputs: [ref],
      checked_items: ["goal triple output"],
    },
    {}
  );
  const rec = parseToolResult(res);
  assert.equal(rec.ok, true);
  assert.match(res.title, /vibe S1/);
  const calls = await readJsonLines(callsFile);
  const t = calls.find((c) => c.kind === "transition");
  assert.ok(t, "transition call logged");
  assert.equal(t.level, "1", "--level forwarded");
  assert.equal(t.has_checklist, true);
});

test("vc_transition rejects unverifiable references without spawning", async () => {
  const p = await newPlugin();
  const before = await readJsonLines(callsFile);
  const res = await p.tool.vc_transition.execute(
    {
      to: "S1",
      stage: "S0",
      referenced_outputs: ["已经全部完成", "/abs/plan.md"],
      checked_items: ["done"],
    },
    {}
  );
  const rec = parseToolResult(res);
  assert.equal(rec.ok, false);
  assert.equal(rec.code, "CHECKLIST_INVALID");
  const after = await readJsonLines(callsFile);
  assert.equal(after.length, before.length, "no CLI spawn when refs are unverifiable");
});

test("cold pointer is warmed in background without blocking the request", async () => {
  const p = await newPlugin();
  const sys = { system: [] };
  const start = Date.now();
  await p["experimental.chat.system.transform"]({ sessionID: "warm-1" }, sys);
  // No pending resume → no full spawn on the hot path; returns quickly.
  assert.ok(Date.now() - start < 500, "transform must not block on a cold pointer spawn");
  // Let the detached warm spawn finish.
  await new Promise((r) => setTimeout(r, 400));
  const calls = await readJsonLines(callsFile);
  assert.ok(
    calls.some((c) => c.kind === "snapshot-task-zone" && c.detail === "pointer"),
    "pointer warm spawn issued"
  );
  // Next request should inject the warmed pointer.
  const sys2 = { system: [] };
  await p["experimental.chat.system.transform"]({ sessionID: "warm-2" }, sys2);
  assert.ok(sys2.system.length > 0, "pointer injected from cache");
  assert.match(sys2.system[0], /VC checkpoint \(pointer\)/);
});

test("prompt injections are recorded asynchronously with content and session", async () => {
  const home = path.join(tmp, "prompt-injections");
  delete process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED;
  process.env.VIBE_PROMPT_INJECTION_HOME = home;
  try {
    const p = await newPlugin();
    const model = { providerID: "deepseek", id: "v4" };

    // First request may only warm the pointer cache; the second injects it.
    await p["experimental.chat.system.transform"]({ sessionID: "inj-warm", model }, { system: [] });
    await new Promise((r) => setTimeout(r, 450));

    const sys = { system: [] };
    await p["experimental.chat.system.transform"]({ sessionID: "inj-1", model }, sys);
    assert.ok(sys.system.length > 0, "pointer injected into the system prompt");

    let records = [];
    for (let attempt = 0; attempt < 20 && records.length === 0; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const result = await readInjectionLog({
        env: { VIBE_PROMPT_INJECTION_HOME: home },
      });
      records = result.records;
    }

    const record = records.find((item) => item.session_id === "inj-1");
    assert.ok(record, "injection record written without blocking the hook");
    assert.equal(record.event, "prompt_injection");
    assert.equal(record.hook, "experimental.chat.system.transform");
    assert.equal(record.kind, "checkpoint_pointer");
    assert.equal(record.trigger, "hot_pointer");
    assert.equal(record.target, "system");
    assert.equal(record.project, tmp);
    assert.deepEqual(record.model, { provider_id: "deepseek", model_id: "v4" });
    assert.match(record.content, /VC checkpoint \(pointer\)/);

    // The same plugin instance exposes the logger through vc_state, which is
    // how a host restart can be verified without reading the archive by hand.
    const stateRes = await p.tool.vc_state.execute({}, {});
    const stateRec = parseToolResult(stateRes);
    assert.equal(stateRec.injection_log.enabled, true);
    assert.ok(stateRec.injection_log.sequence >= 1, "hot path enqueued at least one record");
    assert.equal(stateRec.injection_log.failed, 0);
    assert.match(stateRec.injection_log.base_path, /prompt-injections/);
  } finally {
    process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED = "1";
    delete process.env.VIBE_PROMPT_INJECTION_HOME;
  }
});

test("user messages are recorded as a distinct category", async () => {
  const home = path.join(tmp, "prompt-user-input");
  delete process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED;
  process.env.VIBE_PROMPT_INJECTION_HOME = home;
  try {
    const p = await newPlugin();
    const message = {
      id: "msg_user_1",
      sessionID: "ses_user_1",
      role: "user",
      model: { providerID: "deepseek", modelID: "v4" },
    };
    await p["chat.message"](
      { sessionID: "ses_user_1", messageID: "msg_user_1", model: message.model },
      {
        message,
        parts: [
          { type: "text", text: "请修复登录超时" },
          { type: "text", text: "synthetic wrapper", synthetic: true },
          { type: "reasoning", text: "not user input" },
        ],
      }
    );

    let record = null;
    for (let attempt = 0; attempt < 20 && !record; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const result = await readInjectionLog({
        env: { VIBE_PROMPT_INJECTION_HOME: home },
      });
      record = result.records.find((item) => item.session_id === "ses_user_1") || null;
    }

    assert.ok(record, "user input record is flushed");
    assert.equal(record.event, "user_input");
    assert.equal(record.category, "user_input");
    assert.equal(record.kind, "user_input");
    assert.equal(record.hook, "chat.message");
    assert.equal(record.trigger, "user_message");
    assert.equal(record.target, "user_message");
    assert.equal(record.message_id, "msg_user_1");
    assert.equal(record.content, "请修复登录超时");
    assert.deepEqual(record.model, { provider_id: "deepseek", model_id: "v4" });
  } finally {
    process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED = "1";
    delete process.env.VIBE_PROMPT_INJECTION_HOME;
  }
});

test("tool, MCP and skill calls are recorded with distinct categories", async () => {
  const home = path.join(tmp, "prompt-context-events");
  delete process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED;
  process.env.VIBE_PROMPT_INJECTION_HOME = home;
  try {
    const p = await newPlugin();
    await p["tool.execute.after"](
      { tool: "read", sessionID: "ses_ctx", callID: "c1", args: { filePath: "a.txt" } },
      { title: "read a.txt", output: "file body", metadata: {} }
    );
    await p["tool.execute.after"](
      {
        tool: "delx-memory_memory_get",
        sessionID: "ses_ctx",
        callID: "c2",
        args: { key: "agent:test" },
      },
      { title: "", output: "{\"value\":\"v\"}", metadata: {} }
    );
    await p["tool.execute.after"](
      { tool: "skill", sessionID: "ses_ctx", callID: "c3", args: { name: "vibe-coder-loop" } },
      { title: "", output: "loaded", metadata: {} }
    );

    let records = [];
    for (let attempt = 0; attempt < 20 && records.length < 3; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const result = await readInjectionLog({
        env: { VIBE_PROMPT_INJECTION_HOME: home },
      });
      records = result.records.filter((item) => item.session_id === "ses_ctx");
    }

    const tool = records.find((item) => item.event === "tool_call");
    const mcp = records.find((item) => item.event === "mcp_call");
    const skill = records.find((item) => item.event === "skill_call");
    assert.ok(tool, "plain tool call recorded");
    assert.equal(tool.category, "tool");
    assert.match(tool.content, /read/);
    assert.match(tool.content, /file body/);
    assert.ok(mcp, "MCP call recorded");
    assert.equal(mcp.category, "mcp");
    assert.match(mcp.content, /delx-memory_memory_get/);
    assert.match(mcp.content, /result:/);
    assert.ok(skill, "skill call recorded");
    assert.equal(skill.category, "skill");
    assert.match(skill.content, /vibe-coder-loop/);
  } finally {
    process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED = "1";
    delete process.env.VIBE_PROMPT_INJECTION_HOME;
  }
});

test("system prompt is recorded once per session and deduped", async () => {
  const home = path.join(tmp, "prompt-system");
  delete process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED;
  process.env.VIBE_PROMPT_INJECTION_HOME = home;
  try {
    const p = await newPlugin();
    const model = { providerID: "deepseek", id: "v4" };
    await p["experimental.chat.system.transform"](
      { sessionID: "ses_sys", model },
      { system: ["base system prompt"] }
    );
    await p["experimental.chat.system.transform"](
      { sessionID: "ses_sys", model },
      { system: ["base system prompt"] }
    );

    let records = [];
    for (let attempt = 0; attempt < 20 && records.length === 0; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const result = await readInjectionLog({
        env: { VIBE_PROMPT_INJECTION_HOME: home },
      });
      records = result.records.filter(
        (item) => item.session_id === "ses_sys" && item.event === "system_prompt"
      );
    }
    assert.equal(records.length, 1, "same system prompt is not duplicated");
    assert.equal(records[0].category, "context");
    assert.equal(records[0].content, "base system prompt");
  } finally {
    process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED = "1";
    delete process.env.VIBE_PROMPT_INJECTION_HOME;
  }
});

test("injection-log failures are observable, redacted and never throw the hook", async () => {
  const blocker = path.join(tmp, "blocker");
  await writeFile(blocker, "not a directory");
  const home = path.join(blocker, "home"); // ENOTDIR on mkdir
  delete process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED;
  process.env.VIBE_PROMPT_INJECTION_HOME = home;
  try {
    const p = await newPlugin();
    const model = { providerID: "deepseek", id: "v4" };

    await p["experimental.chat.system.transform"](
      { sessionID: "fail-warm", model },
      { system: [] }
    );
    await new Promise((r) => setTimeout(r, 450));

    const sys = { system: [] };
    await p["experimental.chat.system.transform"]({ sessionID: "fail-1", model }, sys);
    assert.ok(sys.system.length > 0, "injection still happens when the archive is broken");

    let state = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const res = await p.tool.vc_state.execute({}, {});
      state = parseToolResult(res);
      if (state.injection_log && state.injection_log.failed >= 1) break;
    }

    assert.ok(state.injection_log, "diagnostic survives a broken archive");
    assert.equal(state.injection_log.enabled, true);
    assert.ok(state.injection_log.failed >= 1);
    assert.ok(state.injection_log.last_error, "failure reason is retained");
    assert.ok(
      !state.injection_log.last_error.includes(tmp),
      "project path is redacted from last_error"
    );
  } finally {
    process.env.VIBE_PROMPT_INJECTION_LOG_DISABLED = "1";
    delete process.env.VIBE_PROMPT_INJECTION_HOME;
  }
});

test("deny list blocks the tool before execute", async () => {
  process.env.VIBE_BRIDGE_DENY_TOOLS = "task";
  // Cache-bust import so the deny env is read at module init.
  const denyMod = await import(pluginUrl + "?deny=1");
  const p = await denyMod.default({ directory: tmp, worktree: tmp });
  await assert.rejects(
    () => p["tool.execute.before"]({ tool: "task" }, {}),
    /SCOPE_DENIED/
  );
  delete process.env.VIBE_BRIDGE_DENY_TOOLS;
});

test("vc_state satisfies the host tool contract (string output, not a bare record)", async () => {
  const p = await newPlugin();
  const res = await p.tool.vc_state.execute({}, {});
  const rec = parseToolResult(res);
  assert.equal(rec.ok, true);
  assert.equal(rec.phase, "S0");
  assert.equal(rec.rev, 0);
  assert.equal(rec.injection_log.enabled, false, "tests disable the archive by default");
  assert.equal(rec.injection_log.sequence, 0);
  // The raw record stays available for machine consumers.
  assert.equal(res.metadata.phase, "S0");
  assert.match(res.title, /vibe S0/);
});

test("vc_state degrades to a structured error when the CLI is unavailable", async () => {
  const previous = process.env.VIBE_KERNEL_PYTHON;
  // A missing interpreter makes the spawn fail, which is the real degraded path.
  process.env.VIBE_KERNEL_PYTHON = path.join(tmp, "no-such-python");
  try {
    const p = await newPlugin();
    const res = await p.tool.vc_state.execute({}, {});
    const rec = parseToolResult(res);
    assert.equal(rec.ok, false);
    assert.equal(rec.code, "BRIDGE_CLI_UNAVAILABLE");
    assert.match(res.title, /BRIDGE_CLI_UNAVAILABLE/);
  } finally {
    if (previous === undefined) delete process.env.VIBE_KERNEL_PYTHON;
    else process.env.VIBE_KERNEL_PYTHON = previous;
  }
});
