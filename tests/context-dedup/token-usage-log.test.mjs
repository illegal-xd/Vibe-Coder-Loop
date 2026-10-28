import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import {
  createUsageLogger,
  isUsageLogEnabled,
  readUsageLog,
  resolveUsageLogFile,
  resolveUsageLogPath,
  usageLogDateKey,
} from "../../.opencode/context-dedup/token-usage-log.js";
import {
  buildUsageRecord,
  serializeUsageRecord,
} from "../../.opencode/context-dedup/token-usage.js";

const DAY_28 = "2026-10-28";
const DAY_29 = "2026-10-29";

function record(id, timestamp) {
  return buildUsageRecord({
    timestamp,
    session_id: "s",
    request_id: id,
    usage: { input_tokens: { value: 1, source: "provider_usage" } },
  });
}

function dailyName(date) {
  return `token-usage-${date}.jsonl`;
}

function lines(text) {
  return text.split("\n").filter((line) => line.length > 0);
}

async function listFiles(directory) {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readDaily(directory, date) {
  return readFile(path.join(directory, "data", dailyName(date)), "utf8");
}

test("records of one UTC day share one file and different days split", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const config = resolveConfig({}, {});
    const logger = createUsageLogger({ directory, config });
    assert.equal(logger.enabled, true);
    assert.equal(
      resolveUsageLogPath(config, directory),
      path.join(directory, "data", "token-usage.jsonl"),
    );

    await logger.append(record("r1", "2026-10-28T09:39:28.674Z"));
    await logger.append(record("r2", "2026-10-28T23:59:59.999Z"));
    await logger.append(record("r3", "2026-10-29T00:00:00.000Z"));

    assert.deepEqual(await listFiles(path.join(directory, "data")), [
      dailyName(DAY_28),
      dailyName(DAY_29),
    ]);

    const day1 = lines(await readDaily(directory, DAY_28)).map((line) => JSON.parse(line));
    assert.equal(day1.length, 2);
    assert.deepEqual(
      day1.map((entry) => entry.request_id),
      ["r1", "r2"],
    );
    const day2 = lines(await readDaily(directory, DAY_29)).map((line) => JSON.parse(line));
    assert.equal(day2.length, 1);
    assert.equal(day2[0].request_id, "r3");

    for (const entry of day1) {
      assert.equal(usageLogDateKey(entry.timestamp), DAY_28);
    }
    for (const entry of day2) {
      assert.equal(usageLogDateKey(entry.timestamp), DAY_29);
    }
    assert.ok((await readDaily(directory, DAY_28)).endsWith("\n"));
    assert.ok((await readDaily(directory, DAY_29)).endsWith("\n"));

    // The legacy single file is not created by new writes.
    await assert.rejects(
      () => readFile(path.join(directory, "data", "token-usage.jsonl"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timezone offsets and milliseconds select the UTC event day", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const logger = createUsageLogger({ directory, config: resolveConfig({}, {}) });
    const offset = {
      ...record("r_offset", "2026-10-28T00:00:00.000Z"),
      timestamp: "2026-10-28T23:30:00-02:00",
    };
    const early = {
      ...record("r_early", "2026-10-28T00:00:00.000Z"),
      timestamp: "2026-10-28T01:00:00+05:00",
    };

    assert.equal(usageLogDateKey(offset.timestamp), DAY_29);
    assert.equal(usageLogDateKey(early.timestamp), "2026-10-27");
    assert.equal(usageLogDateKey("2026-10-28T09:39:28.674Z"), DAY_28);
    assert.equal(usageLogDateKey("2026-10-28"), DAY_28);

    assert.equal((await logger.append(offset)).ok, true);
    assert.equal((await logger.append(early)).ok, true);

    assert.deepEqual(await listFiles(path.join(directory, "data")), [
      dailyName("2026-10-27"),
      dailyName(DAY_29),
    ]);
    // The timestamp value itself is stored unchanged.
    const stored = lines(await readDaily(directory, DAY_29)).map((line) => JSON.parse(line));
    assert.equal(stored[0].timestamp, "2026-10-28T23:30:00-02:00");
    assert.equal(usageLogDateKey(stored[0].timestamp), DAY_29);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("history and backfilled events are written to their own day file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const logger = createUsageLogger({ directory, config: resolveConfig({}, {}) });
    await logger.append(record("old", "2025-01-02T03:04:05.000Z"));
    await logger.append(record("new", "2026-10-28T03:04:05.000Z"));

    assert.deepEqual(await listFiles(path.join(directory, "data")), [
      dailyName("2025-01-02"),
      dailyName(DAY_28),
    ]);
    const old = lines(
      await readFile(path.join(directory, "data", dailyName("2025-01-02")), "utf8"),
    ).map((line) => JSON.parse(line));
    assert.equal(old.length, 1);
    assert.equal(old[0].request_id, "old");
    assert.equal(usageLogDateKey(old[0].timestamp), "2025-01-02");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an existing daily file is appended to, never overwritten", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const config = resolveConfig({}, {});
    const logger = createUsageLogger({ directory, config });
    const file = resolveUsageLogFile(config, directory, DAY_28);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const first = serializeUsageRecord(
      record("existing", "2026-10-28T01:00:00.000Z"),
    );
    await writeFile(file, first, { encoding: "utf8", mode: 0o600 });

    assert.equal((await logger.append(record("added", "2026-10-28T02:00:00.000Z"))).ok, true);

    const entries = lines(await readFile(file, "utf8")).map((line) => JSON.parse(line));
    assert.deepEqual(
      entries.map((entry) => entry.request_id),
      ["existing", "added"],
    );
    assert.equal(usageLogDateKey(entries[0].timestamp), DAY_28);
    assert.equal(usageLogDateKey(entries[1].timestamp), DAY_28);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing zone or invalid timestamp is rejected instead of guessed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const failures = [];
    const logger = createUsageLogger({
      directory,
      config: resolveConfig({}, {}),
      onFailure: (reason) => failures.push(reason),
    });

    const zoned = record("r1", "2026-10-28T00:00:00.000Z");
    const cases = [
      { ...zoned, timestamp: "2026-10-28T09:39:28" },
      { ...zoned, timestamp: "not-a-date" },
      { ...zoned, timestamp: undefined },
    ];
    for (const entry of cases) {
      const outcome = await logger.append(entry);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error, "record_timestamp_invalid");
    }
    await logger.idle();

    assert.equal(failures.length, 3);
    assert.deepEqual(await listFiles(path.join(directory, "data")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed record is never written as a valid line", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const logger = createUsageLogger({ directory, config: resolveConfig({}, {}) });
    const bad = {
      schema_version: 99,
      event_type: "model_request_usage",
      timestamp: "2026-10-28T00:00:00.000Z",
    };
    const outcome = await logger.append(bad);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, "record_serialization_failed");
    await logger.idle();

    assert.deepEqual(await listFiles(path.join(directory, "data")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent appends stay serialized per day and every line parses", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const logger = createUsageLogger({ directory, config: resolveConfig({}, {}) });
    const ids = Array.from({ length: 30 }, (_, index) => `r${index}`);
    await Promise.all(
      ids.map((id, index) =>
        logger.append(
          record(
            id,
            index % 2 === 0
              ? `2026-10-28T12:00:${String(index).padStart(2, "0")}.000Z`
              : `2026-10-29T12:00:${String(index).padStart(2, "0")}.000Z`,
          ),
        ),
      ),
    );
    await logger.idle();

    for (const [date, expected] of [
      [DAY_28, 15],
      [DAY_29, 15],
    ]) {
      const entries = lines(await readDaily(directory, date)).map((line) => JSON.parse(line));
      assert.equal(entries.length, expected);
      for (const entry of entries) {
        assert.equal(usageLogDateKey(entry.timestamp), date);
        assert.equal(dailyName(usageLogDateKey(entry.timestamp)), dailyName(date));
      }
      assert.equal(new Set(entries.map((entry) => entry.request_id)).size, expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate processes appending the same day keep every line intact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const modules = new URL("../../.opencode/context-dedup/", import.meta.url);
    const writerPath = path.join(directory, "writer.mjs");
    const source = `
import { resolveConfig } from ${JSON.stringify(new URL("config.js", modules).href)};
import { createUsageLogger } from ${JSON.stringify(new URL("token-usage-log.js", modules).href)};
import { buildUsageRecord } from ${JSON.stringify(new URL("token-usage.js", modules).href)};
const [directory, tag] = process.argv.slice(2);
const logger = createUsageLogger({ directory, config: resolveConfig({}, {}) });
const outcomes = await Promise.all(
  Array.from({ length: 20 }, (_, index) =>
    logger.append(
      buildUsageRecord({
        timestamp: \`2026-10-28T12:00:\${String(index).padStart(2, "0")}.000Z\`,
        session_id: "s",
        request_id: \`\${tag}-\${String(index).padStart(2, "0")}\`,
        usage: { input_tokens: { value: 1, source: "provider_usage" } },
      }),
    ),
  ),
);
await logger.idle();
if (outcomes.some((outcome) => !outcome.ok)) process.exitCode = 1;
`;
    await writeFile(writerPath, source, "utf8");

    const run = (tag) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [writerPath, directory, tag], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`writer ${tag} exited with ${code}: ${stderr}`));
        });
      });
    await Promise.all(["a", "b", "c"].map(run));

    const entries = lines(await readDaily(directory, DAY_28)).map((line) => JSON.parse(line));
    assert.equal(entries.length, 60);
    assert.equal(new Set(entries.map((entry) => entry.request_id)).size, 60);
    for (const entry of entries) {
      assert.equal(usageLogDateKey(entry.timestamp), DAY_28);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a write failure is reported and never rejects the caller", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const blocked = path.join(directory, "blocked-file", "token-usage.jsonl");
    await mkdir(path.join(directory, "blocked-file"), { recursive: true });
    // Turn the directory into a file so mkdir works but appendFile fails.
    await rm(path.join(directory, "blocked-file"), { recursive: true, force: true });
    await writeFile(path.join(directory, "blocked-file"), "not a directory");

    const failures = [];
    const logger = createUsageLogger({
      directory,
      config: resolveConfig({ tokenUsage: { path: blocked } }, {}),
      onFailure: (reason) => failures.push(reason),
    });

    const outcome = await logger.append(record("r1", "2026-10-28T00:00:00.000Z"));
    assert.equal(outcome.ok, false);
    assert.equal(failures.length, 1);
    assert.equal(logger.stats().failureCount, 1);

    // A second append on the same logger still returns a failure, not a throw.
    const second = await logger.append(record("r2", "2026-10-28T00:00:00.000Z"));
    assert.equal(second.ok, false);
    assert.equal(logger.stats().failureCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabled logging leaves behavior unchanged and writes nothing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const config = resolveConfig({ tokenUsage: { enabled: false } }, {});
    const logger = createUsageLogger({ directory, config });
    assert.equal(logger.enabled, false);
    assert.equal(logger.path, null);

    const outcome = await logger.append(record("r1", "2026-10-28T00:00:00.000Z"));
    assert.deepEqual(outcome, { ok: false, error: "disabled" });
    await logger.idle();

    assert.deepEqual(await listFiles(path.join(directory, "data")), []);
    assert.equal(
      isUsageLogEnabled(resolveConfig({}, { VIBE_TOKEN_USAGE_LOG_DISABLED: "1" })),
      false,
    );
    assert.equal(isUsageLogEnabled(resolveConfig({}, {})), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom tokenUsage.path keeps its directory and base name for daily files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const config = resolveConfig({ tokenUsage: { path: "logs/usage.jsonl" } }, {});
    const logger = createUsageLogger({ directory, config });
    assert.equal(
      logger.pathFor(DAY_28),
      path.join(directory, "logs", `usage-${DAY_28}.jsonl`),
    );
    assert.equal((await logger.append(record("r1", "2026-10-28T00:00:00.000Z"))).ok, true);
    assert.deepEqual(
      await listFiles(path.join(directory, "logs")),
      [`usage-${DAY_28}.jsonl`],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readUsageLog merges daily files and the legacy file without double counting", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const config = resolveConfig({}, {});
    const logger = createUsageLogger({ directory, config });
    await logger.append(record("r_28", "2026-10-28T05:00:00.000Z"));
    await logger.append(record("r_29", "2026-10-29T05:00:00.000Z"));

    const legacy = resolveUsageLogPath(config, directory);
    const legacyLine = serializeUsageRecord(record("r_legacy", "2026-10-27T05:00:00.000Z"));
    const duplicatedLine = serializeUsageRecord(record("r_28", "2026-10-28T05:00:00.000Z"));
    await mkdir(path.dirname(legacy), { recursive: true, mode: 0o700 });
    await writeFile(legacy, `${legacyLine}${duplicatedLine}`, { encoding: "utf8", mode: 0o600 });

    // Old files are still readable directly, as before the split.
    const legacyEntries = lines(await readFile(legacy, "utf8")).map((line) => JSON.parse(line));
    assert.deepEqual(
      legacyEntries.map((entry) => entry.request_id),
      ["r_legacy", "r_28"],
    );

    const all = await readUsageLog(config, directory);
    assert.deepEqual(
      all.records.map((entry) => entry.request_id),
      ["r_legacy", "r_28", "r_29"],
    );
    assert.equal(all.files.length, 3);
    assert.deepEqual(all.invalid, []);

    const single = await readUsageLog(config, directory, { from: DAY_29, to: DAY_29 });
    assert.deepEqual(
      single.records.map((entry) => entry.request_id),
      ["r_29"],
    );

    const range = await readUsageLog(config, directory, { from: DAY_28, to: DAY_29 });
    assert.deepEqual(
      range.records.map((entry) => entry.request_id),
      ["r_28", "r_29"],
    );

    const empty = await readUsageLog(config, directory, {
      from: "2026-10-30",
      to: "2026-10-30",
    });
    assert.deepEqual(empty.records, []);
    assert.deepEqual(empty.invalid, []);

    // New writes never modify the preserved legacy file.
    const legacyBefore = await readFile(legacy, "utf8");
    assert.equal((await logger.append(record("r_30", "2026-10-30T05:00:00.000Z"))).ok, true);
    assert.equal(await readFile(legacy, "utf8"), legacyBefore);
    const nextDay = await readUsageLog(config, directory, {
      from: "2026-10-30",
      to: "2026-10-30",
    });
    assert.deepEqual(
      nextDay.records.map((entry) => entry.request_id),
      ["r_30"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readUsageLog ignores backup, temp, unrelated, and malformed-name files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const config = resolveConfig({}, {});
    const logger = createUsageLogger({ directory, config });
    await logger.append(record("r1", "2026-10-28T05:00:00.000Z"));

    const data = path.join(directory, "data");
    const duplicate = serializeUsageRecord(record("r_shadow", "2026-10-28T06:00:00.000Z"));
    for (const name of [
      "token-usage-2026-10-28.jsonl.1",
      "token-usage-2026-10-28.jsonl.tmp",
      "token-usage-2026-10-28.jsonl.bak",
      "token-usage-2026-13-40.jsonl",
      "notes.jsonl",
    ]) {
      await writeFile(path.join(data, name), duplicate, { encoding: "utf8" });
    }

    const result = await readUsageLog(config, directory);
    assert.equal(result.files.length, 1); // only the valid daily file exists
    assert.deepEqual(
      result.records.map((entry) => entry.request_id),
      ["r1"],
    );
    assert.deepEqual(result.invalid, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readUsageLog reports broken, mistyped, zone-less, and misplaced lines", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const config = resolveConfig({}, {});
    const logger = createUsageLogger({ directory, config });
    await logger.append(record("good", "2026-10-28T05:00:00.000Z"));

    const data = path.join(directory, "data");
    const zoneLess = { ...record("zone_less", "2026-10-28T00:00:00.000Z"), timestamp: "2026-10-28T09:39:28" };
    const misplaced = record("misplaced", "2026-10-29T05:00:00.000Z");
    const file = path.join(data, dailyName(DAY_28));
    await writeFile(
      file,
      [
        "{not json",
        "[]",
        JSON.stringify(zoneLess),
        JSON.stringify(misplaced),
        "",
      ].join("\n"),
      { flag: "a", encoding: "utf8" },
    );

    const result = await readUsageLog(config, directory);
    assert.deepEqual(
      result.records.map((entry) => entry.request_id),
      ["good"],
    );
    assert.deepEqual(
      result.invalid.map((entry) => entry.reason).sort(),
      ["file_date_mismatch", "invalid_json", "invalid_record", "invalid_timestamp"],
    );
    for (const entry of result.invalid) {
      assert.equal(path.basename(entry.file), dailyName(DAY_28));
      assert.ok(Number.isInteger(entry.line) && entry.line > 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readUsageLog returns no data when nothing has been written", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-token-log-"));
  try {
    const config = resolveConfig({}, {});
    const result = await readUsageLog(config, directory);
    assert.deepEqual(result, { records: [], files: [], invalid: [] });

    await assert.rejects(
      () => readUsageLog(config, directory, { from: "2026-02-31" }),
      /YYYY-MM-DD/,
    );
    const reversed = await readUsageLog(config, directory, {
      from: DAY_29,
      to: DAY_28,
    });
    assert.deepEqual(reversed.records, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
