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
