/**
 * Prompt-injection log: queue semantics, record shape, archive layout, reader.
 *
 * These tests never touch the real archive: every logger receives an explicit
 * `VIBE_PROMPT_INJECTION_HOME` pointing at a temp directory.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildInjectionRecord,
  buildUserInputRecord,
  createInjectionLogger,
  injectionLogDateKey,
  readInjectionLog,
  resolveInjectionHome,
  resolveInjectionLogFile,
} from "../../.opencode/prompt-injection/log.js";

const SAMPLE = {
  sessionID: "ses_abc",
  hook: "experimental.chat.system.transform",
  kind: "checkpoint_pointer",
  trigger: "hot_pointer",
  target: "system",
  content: "[VC pointer] phase=S0 loop=1",
  project: "/tmp/project",
  model: { providerID: "deepseek", id: "deepseek-v4" },
};

async function readJsonLines(file) {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("record shape carries time, conversation, source, content and size", () => {
  const record = buildInjectionRecord({
    ...SAMPLE,
    timestamp: "2026-11-23T01:02:03.000Z",
    sequence: 7,
  });

  assert.equal(record.schema_version, 1);
  assert.equal(record.event, "prompt_injection");
  assert.equal(record.timestamp, "2026-11-23T01:02:03.000Z");
  assert.equal(record.session_id, "ses_abc");
  assert.equal(record.hook, "experimental.chat.system.transform");
  assert.equal(record.kind, "checkpoint_pointer");
  assert.equal(record.trigger, "hot_pointer");
  assert.equal(record.target, "system");
  assert.equal(record.project, "/tmp/project");
  assert.deepEqual(record.model, { provider_id: "deepseek", model_id: "deepseek-v4" });
  assert.equal(record.content, SAMPLE.content);
  assert.equal(record.content_chars, SAMPLE.content.length);
  assert.equal(record.content_bytes, Buffer.byteLength(SAMPLE.content, "utf8"));
  assert.equal(record.content_truncated, false);
  assert.equal(record.original_content_chars, SAMPLE.content.length);
  assert.equal(record.sequence, 7);
});

test("user input records carry a distinct event and category", () => {
  const record = buildUserInputRecord({
    ...SAMPLE,
    content: "请修复登录超时",
    timestamp: "2026-11-23T01:02:03.000Z",
  });

  assert.equal(record.event, "user_input");
  assert.equal(record.category, "user_input");
  assert.equal(record.kind, "user_input");
  assert.equal(record.hook, "chat.message");
  assert.equal(record.trigger, "user_message");
  assert.equal(record.target, "user_message");
  assert.equal(record.content, "请修复登录超时");
});

test("oversized content is truncated by code point without splitting a surrogate pair", () => {
  const content = `a${"😀".repeat(20)}`;
  const record = buildInjectionRecord({
    ...SAMPLE,
    content,
    maxContentChars: 5,
    timestamp: "2026-11-23T01:02:03.000Z",
  });

  assert.equal(record.content_truncated, true);
  assert.equal(record.content, `a😀😀😀😀`);
  assert.equal(record.content_chars, 5);
  assert.equal(record.original_content_chars, 21);
});

test("a zone-less timestamp is rejected instead of guessed", () => {
  assert.throws(
    () => buildInjectionRecord({ ...SAMPLE, timestamp: "2026-11-23T01:02:03" }),
    /explicit Z/
  );
});

test("logger writes one JSONL file per UTC day and keeps conversations distinct", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-log-"));
  try {
    const env = { VIBE_PROMPT_INJECTION_HOME: dir };
    const logger = createInjectionLogger({
      env,
      now: () => new Date("2026-11-23T10:00:00.000Z"),
    });

    assert.equal(logger.enabled, true);
    assert.equal(
      logger.record({ ...SAMPLE, content: "pointer for ses_abc" }),
      true,
      "record() returns synchronously"
    );
    assert.equal(
      logger.record({ ...SAMPLE, sessionID: "ses_other", content: "pointer for ses_other" }),
      true
    );
    assert.deepEqual(logger.stats(), {
      pending: 2,
      dropped: 0,
      sequence: 2,
      failed: 0,
      lastError: null,
    });

    await logger.flush();

    const file = resolveInjectionLogFile("2026-11-23", env);
    const lines = await readJsonLines(file);
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((record) => record.session_id).sort(),
      ["ses_abc", "ses_other"]
    );
    assert.equal(lines[0].event, "prompt_injection");
    assert.equal(lines[0].category, "injection");
    assert.equal(lines[0].sequence, 1);
    assert.equal(lines[1].sequence, 2);
    assert.equal(resolveInjectionHome(env), path.resolve(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disabled logger writes nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-log-off-"));
  try {
    const env = {
      VIBE_PROMPT_INJECTION_HOME: dir,
      VIBE_PROMPT_INJECTION_LOG_DISABLED: "1",
    };
    const logger = createInjectionLogger({
      env,
      now: () => new Date("2026-11-23T10:00:00.000Z"),
    });

    assert.equal(logger.enabled, false);
    assert.equal(logger.record({ ...SAMPLE }), false);
    await logger.flush();

    await assert.rejects(readFile(resolveInjectionLogFile("2026-11-23", env)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid hot-path input is rejected and counted without throwing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-log-invalid-"));
  try {
    const env = { VIBE_PROMPT_INJECTION_HOME: dir };
    const logger = createInjectionLogger({ env });

    assert.equal(logger.record({ hook: "x", kind: "y", target: "system" }), false);
    assert.equal(
      logger.record({ ...SAMPLE, timestamp: "2026-11-23T10:00:00" }),
      false,
      "zone-less timestamp is rejected synchronously"
    );
    assert.equal(logger.stats().sequence, 0);
    assert.equal(logger.stats().failed, 2);
    assert.equal(logger.stats().pending, 0);
    assert.match(logger.stats().lastError, /timestamp|incomplete/);

    await logger.flush();
    await assert.rejects(readFile(resolveInjectionLogFile("2026-11-23", env)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failure on one UTC day retries only that day without duplicating the other", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-log-partial-"));
  try {
    const env = { VIBE_PROMPT_INJECTION_HOME: dir };
    const logger = createInjectionLogger({ env });
    const day23 = resolveInjectionLogFile("2026-11-23", env);
    // Make the day-23 target a directory: appendFile fails with EISDIR while
    // the day-22 file is still writable.
    await mkdir(day23, { recursive: true });

    logger.record({
      ...SAMPLE,
      timestamp: "2026-11-22T10:00:00.000Z",
      content: "day22",
    });
    logger.record({
      ...SAMPLE,
      timestamp: "2026-11-23T10:00:00.000Z",
      content: "day23",
    });

    await logger.flush();
    assert.ok(logger.stats().failed >= 1, "the day-23 write failed");
    const day22First = await readJsonLines(resolveInjectionLogFile("2026-11-22", env));
    assert.equal(day22First.length, 1, "successful day must not be requeued/duplicated");

    await rm(day23, { recursive: true, force: true });
    await logger.flush();

    const day23Lines = await readJsonLines(day23);
    assert.equal(day23Lines.length, 1);
    assert.equal(day23Lines[0].content, "day23");
    const day22After = await readJsonLines(resolveInjectionLogFile("2026-11-22", env));
    assert.equal(day22After.length, 1, "day-22 must still have exactly one copy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed flush retries automatically with backoff", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-log-retry-"));
  try {
    const env = { VIBE_PROMPT_INJECTION_HOME: dir };
    const logger = createInjectionLogger({ env, retryBaseMs: 20 });
    const day23 = resolveInjectionLogFile("2026-11-23", env);
    await mkdir(day23, { recursive: true });

    logger.record({
      ...SAMPLE,
      timestamp: "2026-11-23T10:00:00.000Z",
      content: "retry",
    });
    await logger.flush();
    assert.ok(logger.stats().failed >= 1);

    await rm(day23, { recursive: true, force: true });

    // Do not call flush(): the scheduled retry must persist the record.
    let lines = [];
    for (let attempt = 0; attempt < 40 && lines.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        lines = await readJsonLines(day23);
      } catch {
        lines = [];
      }
    }
    assert.equal(lines.length, 1);
    assert.equal(lines[0].content, "retry");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded queue drops the oldest record and reports the loss", async () => {  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-log-bound-"));
  try {
    const env = { VIBE_PROMPT_INJECTION_HOME: dir };
    const logger = createInjectionLogger({
      env,
      maxQueue: 2,
      now: () => new Date("2026-11-23T10:00:00.000Z"),
    });

    logger.record({ ...SAMPLE, content: "one" });
    logger.record({ ...SAMPLE, content: "two" });
    logger.record({ ...SAMPLE, content: "three" });
    logger.record({ ...SAMPLE, content: "four" });
    assert.equal(logger.stats().dropped, 2);

    await logger.flush();
    const lines = await readJsonLines(resolveInjectionLogFile("2026-11-23", env));
    const dropped = lines.find((record) => record.event === "prompt_injection_log_dropped");
    assert.ok(dropped, "drop diagnostic is written");
    assert.equal(dropped.dropped_count, 2);
    assert.deepEqual(
      lines.filter((record) => record.event === "prompt_injection").map((record) => record.content),
      ["three", "four"]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reader filters by date and session and reports corrupt lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-read-"));
  try {
    const env = { VIBE_PROMPT_INJECTION_HOME: dir };
    const day1 = resolveInjectionLogFile("2026-11-22", env);
    const day2 = resolveInjectionLogFile("2026-11-23", env);
    await mkdir(path.dirname(day1), { recursive: true });

    const base = {
      schema_version: 1,
      event: "prompt_injection",
      hook: "experimental.chat.system.transform",
      kind: "checkpoint_pointer",
      target: "system",
      content: "x",
      content_chars: 1,
      content_bytes: 1,
      sequence: 1,
    };
    await writeFile(
      day1,
      [
        JSON.stringify({ ...base, timestamp: "2026-11-22T09:00:00.000Z", session_id: "ses_a" }),
        "{not json",
        JSON.stringify({ ...base, timestamp: "2026-11-22T09:01:00.000Z", session_id: "ses_b" }),
        JSON.stringify({
          ...base,
          timestamp: "2026-11-22T09:02:00.000Z",
          session_id: "ses_c",
          event: "something_else",
        }),
        "",
      ].join("\n")
    );
    await writeFile(
      day2,
      `${JSON.stringify({
        ...base,
        timestamp: "2026-11-23T09:00:00.000Z",
        session_id: "ses_a",
        sequence: 2,
      })}\n`
    );

    const all = await readInjectionLog({ env });
    assert.deepEqual(
      all.records.map((record) => [record.session_id, record.timestamp]),
      [
        ["ses_a", "2026-11-22T09:00:00.000Z"],
        ["ses_b", "2026-11-22T09:01:00.000Z"],
        ["ses_c", "2026-11-22T09:02:00.000Z"],
        ["ses_a", "2026-11-23T09:00:00.000Z"],
      ]
    );
    assert.ok(all.invalid.some((entry) => entry.reason === "invalid_json"));

    const session = await readInjectionLog({ env, sessionID: "ses_a" });
    assert.equal(session.records.length, 2);

    const day = await readInjectionLog({ env, from: "2026-11-23", to: "2026-11-23" });
    assert.equal(day.records.length, 1);
    assert.equal(day.records[0].timestamp, "2026-11-23T09:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UTC date key uses the record time, not the wall clock", () => {
  assert.equal(injectionLogDateKey("2026-11-22T23:59:59.999Z"), "2026-11-22");
  assert.equal(injectionLogDateKey("2026-11-23T00:00:00.000Z"), "2026-11-23");
  assert.equal(injectionLogDateKey("2026-11-22T23:30:00-02:00"), "2026-11-23");
  assert.equal(injectionLogDateKey("2026-11-23T00:00:00"), null);
});
