/**
 * Prompt-injection viewer payload: grouping by conversation, timeline order,
 * unknown-session fallback, and stats.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildInjectionPayload,
  isLoopbackHost,
  loadInjectionPayload,
  startViewerServer,
} from "../../tools/viewer/server.mjs";
import { resolveInjectionLogFile } from "../../.opencode/prompt-injection/log.js";

function record(overrides = {}) {
  return {
    schema_version: 1,
    event: "prompt_injection",
    timestamp: "2026-11-23T10:00:00.000Z",
    session_id: "ses_a",
    source: "vibe-bridge",
    hook: "experimental.chat.system.transform",
    kind: "checkpoint_pointer",
    trigger: "hot_pointer",
    target: "system",
    project: "/tmp/project",
    model: { provider_id: "deepseek", model_id: "v4" },
    content: "pointer",
    content_chars: 7,
    content_bytes: 7,
    content_truncated: false,
    original_content_chars: 7,
    sequence: 1,
    ...overrides,
  };
}

test("groups records by conversation and orders each timeline by time", () => {
  const payload = buildInjectionPayload(
    [
      record({ session_id: "ses_a", timestamp: "2026-11-23T10:00:02.000Z", sequence: 2 }),
      record({ session_id: "ses_b", timestamp: "2026-11-23T11:00:00.000Z", sequence: 1 }),
      record({ session_id: "ses_a", timestamp: "2026-11-23T10:00:01.000Z", sequence: 1 }),
      record({ session_id: null, timestamp: "2026-11-23T09:00:00.000Z", sequence: 1 }),
    ],
    {
      files: ["/archive/prompt-injection-2026-11-23.jsonl"],
      invalid: [],
      archive: "/archive",
      now: new Date("2026-11-23T12:00:00.000Z"),
    }
  );

  assert.equal(payload.stats.sessions, 3);
  assert.equal(payload.stats.injections, 4);
  assert.deepEqual(
    payload.sessions.map((session) => session.session_id),
    ["ses_b", "ses_a", "__unknown__"],
    "sessions are ordered by most recent injection"
  );

  const a = payload.sessions.find((session) => session.session_id === "ses_a");
  assert.equal(a.count, 2);
  assert.deepEqual(
    a.entries.map((entry) => entry.sequence),
    [1, 2]
  );
  assert.equal(a.first_at, "2026-11-23T10:00:01.000Z");
  assert.equal(a.last_at, "2026-11-23T10:00:02.000Z");
  assert.deepEqual(a.projects, ["/tmp/project"]);
  assert.deepEqual(a.entries[0].model, { provider_id: "deepseek", model_id: "v4" });
});

test("keeps user input and injected context in one timeline with categories", () => {
  const payload = buildInjectionPayload(
    [
      record({
        session_id: "ses_a",
        timestamp: "2026-11-23T10:00:00.000Z",
        sequence: 1,
        event: "user_input",
        category: "user_input",
        hook: "chat.message",
        kind: "user_input",
        trigger: "user_message",
        target: "user_message",
        content: "请修复登录超时",
      }),
      record({
        session_id: "ses_a",
        timestamp: "2026-11-23T10:00:01.000Z",
        sequence: 2,
      }),
    ],
    { total: 2 }
  );

  assert.equal(payload.stats.records, 2);
  assert.equal(payload.stats.injections, 1);
  assert.equal(payload.stats.userInputs, 1);
  assert.equal(payload.sessions[0].count, 2);
  assert.deepEqual(
    payload.sessions[0].entries.map((entry) => entry.category),
    ["user_input", "injection"]
  );
  assert.equal(payload.sessions[0].entries[0].kind, "user_input");
});

test("tool, MCP, skill and system prompt events are counted separately", () => {
  const payload = buildInjectionPayload(
    [
      record({
        session_id: "ses_ctx",
        timestamp: "2026-11-23T10:00:00.000Z",
        sequence: 1,
        event: "system_prompt",
        category: "context",
        hook: "experimental.chat.system.transform",
        kind: "system_prompt",
        trigger: "session_start",
        target: "system",
        content: "base system prompt",
      }),
      record({
        session_id: "ses_ctx",
        timestamp: "2026-11-23T10:00:01.000Z",
        sequence: 2,
        event: "tool_call",
        category: "tool",
        hook: "tool.execute.after",
        kind: "tool",
        trigger: "tool_call",
        target: "tool",
        content: "tool: read",
      }),
      record({
        session_id: "ses_ctx",
        timestamp: "2026-11-23T10:00:02.000Z",
        sequence: 3,
        event: "mcp_call",
        category: "mcp",
        hook: "tool.execute.after",
        kind: "mcp",
        trigger: "tool_call",
        target: "mcp",
        content: "tool: delx-memory_memory_get",
      }),
      record({
        session_id: "ses_ctx",
        timestamp: "2026-11-23T10:00:03.000Z",
        sequence: 4,
        event: "skill_call",
        category: "skill",
        hook: "tool.execute.after",
        kind: "skill",
        trigger: "tool_call",
        target: "skill",
        content: "tool: skill",
      }),
    ],
    { total: 4 }
  );

  assert.equal(payload.stats.records, 4);
  assert.equal(payload.stats.toolCalls, 1);
  assert.equal(payload.stats.mcpCalls, 1);
  assert.equal(payload.stats.skillCalls, 1);
  assert.equal(payload.stats.systemPrompts, 1);
  assert.deepEqual(
    payload.sessions[0].entries.map((entry) => entry.category),
    ["context", "tool", "mcp", "skill"]
  );
});

test("ignores non-injection diagnostic records", () => {
  const payload = buildInjectionPayload(
    [
      record(),
      {
        schema_version: 1,
        event: "prompt_injection_log_dropped",
        timestamp: "2026-11-23T10:00:00.000Z",
        dropped_count: 3,
      },
    ],
    { now: new Date("2026-11-23T12:00:00.000Z") }
  );
  assert.equal(payload.stats.injections, 1);
  assert.equal(payload.stats.byKind.checkpoint_pointer, 1);
  assert.equal(payload.diagnostics.records, 1);
});

test("empty archive yields an empty payload, not an error", () => {
  const payload = buildInjectionPayload([], { now: new Date("2026-11-23T12:00:00.000Z") });
  assert.deepEqual(payload.sessions, []);
  assert.equal(payload.stats.sessions, 0);
  assert.equal(payload.stats.injections, 0);
  assert.equal(payload.generatedAt, "2026-11-23T12:00:00.000Z");
});

test("non-loopback binds are refused unless explicitly allowed", async () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.0.1.2"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0:0:0:0:0:0:0:1"), true);
  assert.equal(isLoopbackHost("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);

  await assert.rejects(
    () => startViewerServer({ host: "0.0.0.0", port: 0 }),
    /allow-remote/
  );
});

test("clear API removes one session or all data with confirmation headers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-clear-"));
  try {
    const env = { VIBE_PROMPT_INJECTION_HOME: dir };
    const file = resolveInjectionLogFile("2026-11-23", env);
    const base = {
      schema_version: 1,
      event: "prompt_injection",
      category: "injection",
      timestamp: "2026-11-23T10:00:00.000Z",
      source: "vibe-bridge",
      hook: "experimental.chat.system.transform",
      kind: "checkpoint_pointer",
      target: "system",
      content: "x",
      content_chars: 1,
      content_bytes: 1,
      sequence: 1,
    };
    await writeFile(
      file,
      [
        JSON.stringify({ ...base, session_id: "ses_keep", content: "keep" }),
        JSON.stringify({ ...base, session_id: "ses_drop", content: "drop" }),
        "{not json",
        "",
      ].join("\n")
    );

    const started = await startViewerServer({ injectionDir: dir, port: 0 });
    const post = (body, headers = {}) =>
      fetch(`${started.url}api/clear`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "prompt-injection-viewer",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    try {
      const missingHeader = await fetch(`${started.url}api/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      });
      assert.equal(missingHeader.status, 403);
      const invalid = await post({ scope: "nope" });
      assert.equal(invalid.status, 400);

      const one = await post({ scope: "session", session: "ses_drop" });
      assert.equal(one.status, 200);
      const oneBody = await one.json();
      assert.equal(oneBody.removed, 1);
      const afterOne = await readFile(file, "utf8");
      assert.match(afterOne, /ses_keep/);
      assert.doesNotMatch(afterOne, /ses_drop/);
      assert.match(afterOne, /\{not json/);

      const all = await post({ scope: "all" });
      assert.equal(all.status, 200);
      const allBody = await all.json();
      assert.ok(allBody.removed >= 2);
      assert.equal((await readFile(file, "utf8")).trim(), "");
    } finally {
      await new Promise((resolve) => started.server.close(resolve));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("totals count injection events, not drop diagnostics, and expose real truncation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-viewer-"));
  try {
    const env = { VIBE_PROMPT_INJECTION_HOME: dir };
    const file = resolveInjectionLogFile("2026-11-23", env);
    const lines = [
      record({ timestamp: "2026-11-23T10:00:00.000Z", sequence: 1 }),
      record({ timestamp: "2026-11-23T10:00:01.000Z", sequence: 2 }),
      {
        schema_version: 1,
        event: "prompt_injection_log_dropped",
        timestamp: "2026-11-23T10:00:02.000Z",
        dropped_count: 3,
      },
    ];
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    const full = await loadInjectionPayload({ env });
    assert.equal(full.stats.injections, 2);
    assert.equal(full.diagnostics.records, 2);
    assert.equal(full.diagnostics.totalRecords, 2, "dropped diagnostic is not counted as truncated");
    assert.equal(full.diagnostics.truncated, false);

    const limited = await loadInjectionPayload({ env, limit: 1 });
    assert.equal(limited.stats.injections, 1);
    assert.equal(limited.diagnostics.records, 1);
    assert.equal(limited.diagnostics.totalRecords, 2);
    assert.equal(limited.diagnostics.truncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
