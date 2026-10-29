import test from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import {
  DEFAULT_SUPERSEDE_PLACEHOLDER,
  fileIdentityOf,
  planSupersedeWrites,
  redactWriteInput,
} from "../../.opencode/context-dedup/supersede-writes.js";
import { toolRecord } from "./helpers.mjs";

const BASE_CONFIG = resolveConfig({}, {});
const LONG_CONTENT = "export const value = 42;\n".repeat(120);
const READ_OUTPUT = "1| export const value = 42;\n".repeat(40);

function plan(records, overrides = {}) {
  return planSupersedeWrites(records, {
    ...BASE_CONFIG.supersedeWrites,
    mutationTools: BASE_CONFIG.mutationTools,
    ...overrides,
  });
}

function writeRec({
  id = "w1",
  order = 1,
  filePath = "src/a.ts",
  content = LONG_CONTENT,
  cwd = "/repo",
  root = "/repo",
  status = "completed",
  output = "File written successfully",
  error = "",
  metadata = {},
  time = { start: order, end: order + 1 },
  userSegment = 0,
  tool = "write",
  args,
} = {}) {
  return toolRecord({
    id,
    order,
    tool,
    args: args ?? { filePath, content },
    cwd,
    root,
    status,
    output,
    error,
    metadata,
    time,
    userSegment,
  });
}

function readRec({
  id = "r1",
  order = 2,
  filePath = "src/a.ts",
  output = READ_OUTPUT,
  cwd = "/repo",
  root = "/repo",
  status = "completed",
  metadata = {},
  time = { start: order, end: order + 1 },
  userSegment = 0,
  args,
} = {}) {
  return toolRecord({
    id,
    order,
    tool: "read",
    args: args ?? { filePath },
    cwd,
    root,
    status,
    output,
    error: status === "error" ? "read failed" : "",
    metadata,
    time,
    userSegment,
  });
}

test("a confirmed write followed by a full read is superseded", () => {
  const { decisions, stats } = plan([
    writeRec({ id: "w1", order: 1, time: { start: 1, end: 10 } }),
    readRec({ id: "r1", order: 2, time: { start: 11, end: 12 } }),
  ]);

  assert.equal(decisions.length, 1);
  const decision = decisions[0];
  assert.equal(decision.id, "w1");
  assert.equal(decision.keeperId, "r1");
  assert.equal(decision.kind, "superseded_by_read");
  assert.equal(decision.confidence, "high");
  assert.equal(decision.filePath, "/repo/src/a.ts");
  assert.equal(decision.replacement, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(decision.redactedInput.filePath, "src/a.ts");
  assert.equal(decision.redactedInput.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
  // The decision keeps a reference to the original input, never a duplicate
  // JSON copy of the file content.
  assert.equal(decision.expectedInput.content, LONG_CONTENT);
  assert.equal("expectedInputJson" in decision, false);
  assert.ok(decision.estimatedTokensSaved > 0);
  assert.ok(decision.tokenUnitsRemoved > 0);
  assert.ok(decision.bytesRemoved > 0);

  assert.equal(stats.confirmedWriteCount, 1);
  assert.equal(stats.fullReadCount, 1);
  assert.equal(stats.candidateCount, 1);
  assert.equal(stats.plannedPruneCount, 1);
  assert.equal(stats.highConfidencePruneCount, 1);
  assert.deepEqual(stats.decisionKinds, { superseded_by_read: 1 });
});

test("failed writes never enter the supersede state", () => {
  for (const record of [
    writeRec({ id: "w1", order: 1, status: "error", output: "", error: "EPERM" }),
    writeRec({ id: "w1", order: 1, metadata: { success: false } }),
    writeRec({ id: "w1", order: 1, metadata: { exitCode: 1 } }),
    writeRec({ id: "w1", order: 1, metadata: { timedOut: true } }),
    writeRec({ id: "w1", order: 1, status: "running" }),
  ]) {
    const { decisions, stats } = plan([record, readRec({ order: 2 })]);
    assert.equal(decisions.length, 0);
    assert.equal(stats.confirmedWriteCount, 0);
  }
});

test("consecutive writes to the same file are all superseded by one full read", () => {
  const { decisions } = plan([
    writeRec({ id: "w1", order: 1, time: { start: 1, end: 5 } }),
    writeRec({ id: "w2", order: 2, time: { start: 6, end: 10 } }),
    readRec({ id: "r1", order: 3, time: { start: 11, end: 12 } }),
  ]);

  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["w1", "w2"],
  );
  assert.ok(decisions.every((decision) => decision.keeperId === "r1"));
});

test("a write after the read is retained", () => {
  const { decisions, stats } = plan([
    writeRec({ id: "w1", order: 1, time: { start: 1, end: 5 } }),
    readRec({ id: "r1", order: 2, time: { start: 6, end: 7 } }),
    writeRec({ id: "w2", order: 3, time: { start: 8, end: 9 } }),
  ]);

  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["w1"],
  );
  assert.equal(stats.skippedReasons.no_superseding_read, 1);
});

test("reading file A never supersedes file B", () => {
  const { decisions } = plan([
    writeRec({ id: "wA", order: 1, filePath: "src/a.ts" }),
    writeRec({ id: "wB", order: 2, filePath: "src/b.ts" }),
    readRec({ id: "rA", order: 3, filePath: "src/a.ts" }),
  ]);

  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["wA"],
  );
});

test("same basename in different directories is a different file", () => {
  const { decisions } = plan([
    writeRec({ id: "w1", order: 1, filePath: "dir1/a.ts" }),
    writeRec({ id: "w2", order: 2, filePath: "dir2/a.ts" }),
    readRec({ id: "r1", order: 3, filePath: "dir1/a.ts" }),
  ]);
  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["w1"],
  );

  const linkLike = plan([
    writeRec({ id: "w1", order: 1, filePath: "real/a.ts" }),
    readRec({ id: "r1", order: 2, filePath: "link/a.ts" }),
  ]);
  assert.equal(linkLike.decisions.length, 0);
});

test("relative and absolute forms of the same path match; different case does not", () => {
  const relative = plan([
    writeRec({ id: "w1", order: 1, args: { filePath: "./src/a.ts", content: LONG_CONTENT } }),
    readRec({ id: "r1", order: 2, args: { filePath: "/repo/src/a.ts" } }),
  ]);
  assert.deepEqual(
    relative.decisions.map((decision) => decision.id),
    ["w1"],
  );

  const differentCase = plan([
    writeRec({ id: "w1", order: 1, filePath: "Src/A.ts" }),
    readRec({ id: "r1", order: 2, filePath: "src/a.ts" }),
  ]);
  assert.equal(differentCase.decisions.length, 0);
});

test("different workspaces with the same relative path are not the same file", () => {
  const { decisions } = plan([
    writeRec({ id: "w1", order: 1, filePath: "src/a.ts", cwd: "/repo-one" }),
    readRec({ id: "r1", order: 2, filePath: "src/a.ts", cwd: "/repo-two" }),
  ]);
  assert.equal(decisions.length, 0);
});

test("line-range, offset, and limited reads never trigger whole-file supersede", () => {
  for (const args of [
    { filePath: "src/a.ts", limit: 20 },
    { filePath: "src/a.ts", offset: 100 },
    { filePath: "src/a.ts", offset: 100, limit: 10 },
    { filePath: "src/a.ts", startLine: 5 },
    { filePath: "src/a.ts", offset: "not-a-number" },
    { filePath: "src/a.ts", offset: -1 },
    { filePath: "src/a.ts", limit: "not-a-number" },
  ]) {
    const { decisions, stats } = plan([
      writeRec({ id: "w1", order: 1 }),
      readRec({ id: "r1", order: 2, args }),
    ]);
    assert.equal(decisions.length, 0, JSON.stringify(args));
    assert.equal(stats.fullReadCount, 0, JSON.stringify(args));
  }

  // offset 0/1 with no limit still starts at the beginning.
  const fromTop = plan([
    writeRec({ id: "w1", order: 1 }),
    readRec({ id: "r1", order: 2, args: { filePath: "src/a.ts", offset: 1 } }),
  ]);
  assert.equal(fromTop.decisions.length, 1);
});

test("truncated, empty, failed, and metadata-only reads are rejected", () => {
  const variants = [
    readRec({ id: "r1", order: 2, metadata: { truncated: true } }),
    readRec({ id: "r1", order: 2, metadata: { loaded: false } }),
    readRec({ id: "r1", order: 2, output: "" }),
    readRec({ id: "r1", order: 2, status: "error" }),
    readRec({ id: "r1", order: 2, output: "Output capped at 2000 lines" }),
    readRec({
      id: "r1",
      order: 2,
      output: `${READ_OUTPUT}\n(Output capped at 2.0 MB. Showing lines 1-2000. Use offset=2001 to continue.)`,
    }),
  ];
  for (const read of variants) {
    const { decisions } = plan([writeRec({ id: "w1", order: 1 }), read]);
    assert.equal(decisions.length, 0);
  }
});

test("missing or malformed timestamps prevent supersede", () => {
  const { decisions } = plan([
    writeRec({ id: "w1", order: 1, time: null }),
    readRec({ id: "r1", order: 2 }),
  ]);
  assert.equal(decisions.length, 0);

  const missingReadTime = plan([
    writeRec({ id: "w1", order: 1 }),
    readRec({ id: "r1", order: 2, time: null }),
  ]);
  assert.equal(missingReadTime.decisions.length, 0);

  const invalidWriteInterval = plan([
    writeRec({ id: "w1", order: 1, time: { start: 10, end: 5 } }),
    readRec({ id: "r1", order: 2, time: { start: 11, end: 12 } }),
  ]);
  assert.equal(invalidWriteInterval.decisions.length, 0);

  const invalidReadInterval = plan([
    writeRec({ id: "w1", order: 1, time: { start: 1, end: 2 } }),
    readRec({ id: "r1", order: 2, time: { start: 12, end: 11 } }),
  ]);
  assert.equal(invalidReadInterval.decisions.length, 0);
});

test("a read ordered before the write or overlapping it cannot supersede", () => {
  const beforeWrite = plan([
    readRec({ id: "r1", order: 1, time: { start: 1, end: 2 } }),
    writeRec({ id: "w1", order: 2, time: { start: 3, end: 4 } }),
  ]);
  assert.equal(beforeWrite.decisions.length, 0);

  const overlapping = plan([
    writeRec({ id: "w1", order: 1, time: { start: 1, end: 20 } }),
    readRec({ id: "r1", order: 2, time: { start: 10, end: 11 } }),
  ]);
  assert.equal(overlapping.decisions.length, 0);
  assert.equal(overlapping.stats.skippedReasons.concurrent_write_overlap, 1);

  const afterCompletion = plan([
    writeRec({ id: "w1", order: 1, time: { start: 1, end: 20 } }),
    readRec({ id: "r1", order: 2, time: { start: 21, end: 22 } }),
  ]);
  assert.equal(afterCompletion.decisions.length, 1);
});

test("concurrent writes make the overlapping read unreliable, a later read wins", () => {
  const { decisions, stats } = plan([
    writeRec({ id: "w1", order: 1, time: { start: 1, end: 10 } }),
    writeRec({ id: "w2", order: 2, time: { start: 2, end: 25 } }),
    readRec({ id: "r1", order: 3, time: { start: 15, end: 16 } }),
    readRec({ id: "r2", order: 4, time: { start: 26, end: 27 } }),
  ]);

  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["w1", "w2"],
  );
  assert.ok(decisions.every((decision) => decision.keeperId === "r2"));
  assert.equal(stats.skippedReasons.concurrent_write_overlap, 1);
});

test("a broad mutation between write and read is a conservative barrier", () => {
  const { decisions, stats } = plan([
    writeRec({ id: "w1", order: 1 }),
    toolRecord({
      id: "b1",
      order: 2,
      tool: "bash",
      args: { command: "echo hi > src/a.ts" },
      output: "ok",
    }),
    readRec({ id: "r1", order: 3 }),
  ]);
  assert.equal(decisions.length, 0);
  assert.equal(stats.skippedReasons.intervening_broad_mutation, 1);

  // A write to a different file is not a barrier for this file.
  const otherFileWrite = plan([
    writeRec({ id: "w1", order: 1, filePath: "src/a.ts" }),
    writeRec({ id: "w2", order: 2, filePath: "src/b.ts" }),
    readRec({ id: "r1", order: 3, filePath: "src/a.ts" }),
  ]);
  assert.deepEqual(
    otherFileWrite.decisions.map((decision) => decision.id),
    ["w1"],
  );
});

test("re-running on already-redacted records is idempotent and prunes nothing", () => {
  const redacted = writeRec({
    id: "w1",
    order: 1,
    args: { filePath: "src/a.ts", content: DEFAULT_SUPERSEDE_PLACEHOLDER },
    output: DEFAULT_SUPERSEDE_PLACEHOLDER,
  });
  const { decisions, stats } = plan([redacted, readRec({ id: "r1", order: 2 })]);
  assert.equal(decisions.length, 0);
  assert.equal(stats.skippedReasons.no_token_benefit, 1);
});

test("missing or uncertain file identity is preserved conservatively", () => {
  const missingPath = plan([
    writeRec({ id: "w1", order: 1, args: { content: LONG_CONTENT } }),
    readRec({ id: "r1", order: 2 }),
  ]);
  assert.equal(missingPath.decisions.length, 0);

  const missingCwd = plan([
    writeRec({ id: "w1", order: 1, cwd: "" }),
    readRec({ id: "r1", order: 2, cwd: "" }),
  ]);
  assert.equal(missingCwd.decisions.length, 0);
});

test("redaction keeps path and unrelated input fields but drops payload", () => {
  const input = { filePath: "src/a.ts", content: LONG_CONTENT, encoding: "utf8" };
  const redacted = redactWriteInput(input, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(redacted.filePath, "src/a.ts");
  assert.equal(redacted.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(redacted.encoding, "utf8");
  assert.deepEqual(Object.keys(redacted).sort(), ["content", "encoding", "filePath"]);
  assert.notEqual(redacted, input);
  assert.equal(fileIdentityOf(writeRec()), fileIdentityOf(readRec()));
});

test("requireFullRead:false accepts a partial read only when explicitly opted in", () => {
  const records = [
    writeRec({ id: "w1", order: 1 }),
    readRec({ id: "r1", order: 2, args: { filePath: "src/a.ts", limit: 20 } }),
  ];
  const strict = plan(records);
  assert.equal(strict.decisions.length, 0);

  const relaxed = plan(records, { requireFullRead: false });
  assert.equal(relaxed.decisions.length, 1);
  assert.equal(relaxed.decisions[0].id, "w1");
});

test("a failed write between the write and the read is a barrier", () => {
  const { decisions, stats } = plan([
    writeRec({ id: "w1", order: 1 }),
    writeRec({
      id: "w_bad",
      order: 2,
      status: "error",
      output: "",
      error: "ENOSPC",
      args: { filePath: "src/a.ts", content: "partial" },
    }),
    readRec({ id: "r1", order: 3 }),
  ]);
  assert.equal(decisions.length, 0);
  assert.equal(stats.skippedReasons.intervening_broad_mutation, 1);
});

test("writes with no full read still report a skip reason", () => {
  const { decisions, stats } = plan([writeRec({ id: "w1", order: 1 })]);
  assert.equal(decisions.length, 0);
  assert.equal(stats.skippedReasons.no_superseding_read, 1);
  assert.equal(stats.preservedCount, 1);
});

test("write payloads are not serialized while planning barriers", () => {
  let serialized = 0;
  const otherFileInput = {
    filePath: "src/b.ts",
    content: LONG_CONTENT,
    toJSON() {
      serialized += 1;
      return { filePath: "src/b.ts", content: "x" };
    },
  };
  const { decisions } = plan([
    writeRec({ id: "w1", order: 1, filePath: "src/a.ts" }),
    writeRec({ id: "w2", order: 2, args: otherFileInput }),
    readRec({ id: "r1", order: 3, filePath: "src/a.ts" }),
  ]);
  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["w1"],
  );
  assert.equal(serialized, 0);
});

test("barrierOnBroadMutations:false still collects writes and skips the barrier", () => {
  const records = [
    writeRec({ id: "w1", order: 1 }),
    toolRecord({
      id: "b1",
      order: 2,
      tool: "bash",
      args: { command: "echo hi" },
      output: "ok",
    }),
    readRec({ id: "r1", order: 3 }),
  ];
  const strict = plan(records);
  assert.equal(strict.decisions.length, 0);

  const relaxed = plan(records, { barrierOnBroadMutations: false });
  assert.deepEqual(
    relaxed.decisions.map((decision) => decision.id),
    ["w1"],
  );
});

test("disabled strategy returns no decisions and no candidates", () => {
  const { decisions, stats } = plan(
    [writeRec({ id: "w1", order: 1 }), readRec({ id: "r1", order: 2 })],
    { enabled: false },
  );
  assert.equal(decisions.length, 0);
  assert.equal(stats.skippedReasons.disabled, 2);
});
