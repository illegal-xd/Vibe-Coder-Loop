/**
 * Supersede Writes against the runtime-normalized read shape.
 *
 * Regression: OpenCode stamps `offset` (default 1) and `limit` (computed cap)
 * into every read's `state.input`. Treating a bare `limit` as "partial read"
 * made `fullReadCount` 0 on every real session, so no write was ever
 * superseded. These tests pin the structured EOF evidence that replaced it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import {
  DEFAULT_SUPERSEDE_PLACEHOLDER,
  planSupersedeWrites,
} from "../../.opencode/context-dedup/supersede-writes.js";
import {
  extractToolRecords,
  transformMessages,
} from "../../.opencode/context-dedup/opencode.js";
import {
  assistantMessage,
  clone,
  toolPart,
  toolRecord,
  userMessage,
} from "./helpers.mjs";

const CONFIG = resolveConfig({}, {});
const LONG_CONTENT = "export const value = 42;\n".repeat(120);
const READ_OUTPUT = "1| export const value = 42;\n".repeat(40);

function writeRec(overrides = {}) {
  return toolRecord({
    id: "w1",
    order: 1,
    tool: "write",
    args: { filePath: "src/a.ts", content: LONG_CONTENT },
    output: "File written successfully",
    time: { start: 1, end: 2 },
    ...overrides,
  });
}

function readRec(overrides = {}) {
  return toolRecord({
    id: "r1",
    order: 2,
    tool: "read",
    args: { filePath: "src/a.ts" },
    output: READ_OUTPUT,
    metadata: {},
    time: { start: 3, end: 4 },
    ...overrides,
  });
}

function writePart({
  callID = "w1",
  messageID = "a1",
  filePath = "src/a.ts",
  content = LONG_CONTENT,
  time = { start: 1, end: 2 },
} = {}) {
  return toolPart({
    id: `part_${callID}`,
    messageID,
    callID,
    tool: "write",
    input: { filePath, content },
    output: "File written successfully",
    status: "completed",
    time,
    metadata: { diff: "…" },
    title: `write ${filePath}`,
  });
}

function readPart({
  callID = "r1",
  messageID = "a2",
  filePath = "src/a.ts",
  args = { filePath, offset: 1, limit: 2000 },
  output = READ_OUTPUT,
  status = "completed",
  metadata = { truncated: false, loaded: [] },
  time = { start: 3, end: 4 },
} = {}) {
  return toolPart({
    id: `part_${callID}`,
    messageID,
    callID,
    tool: "read",
    input: args,
    output,
    status,
    error: "read failed",
    time,
    metadata,
    title: `read ${filePath}`,
  });
}

// --- full-read classification ---------------------------------------------

test("runtime-normalized read (offset:1, limit:2000, truncated:false) counts as full", () => {
  const { decisions, stats } = planSupersedeWrites([
    writeRec(),
    readRec({
      args: { filePath: "src/a.ts", offset: 1, limit: 2000 },
      metadata: { truncated: false, loaded: [] },
    }),
  ]);

  assert.equal(decisions.length, 1);
  assert.equal(stats.observedReadCount, 1);
  assert.equal(stats.confirmedReadCount, 1);
  assert.equal(stats.fullReadCount, 1);
  assert.equal(stats.fileMatchCount, 1);
  assert.equal(stats.versionVerifiedCount, 1);
  assert.equal(stats.markedCount, 1);
  assert.deepEqual(stats.readRejectedReasons, {});
});

test("a truncated read is rejected and never supersedes the write", () => {
  const { decisions, stats } = planSupersedeWrites([
    writeRec(),
    readRec({
      args: { filePath: "src/a.ts", offset: 1, limit: 2000 },
      metadata: { truncated: true },
    }),
  ]);

  assert.equal(decisions.length, 0);
  assert.equal(stats.fullReadCount, 0);
  assert.equal(stats.readRejectedReasons.read_truncated, 1);
  assert.equal(stats.skippedReasons.no_superseding_read, 1);
});

test("a read that does not start at line 1 is rejected", () => {
  const { decisions, stats } = planSupersedeWrites([
    writeRec(),
    readRec({
      args: { filePath: "src/a.ts", offset: 100, limit: 2000 },
      metadata: { truncated: false },
    }),
  ]);

  assert.equal(decisions.length, 0);
  assert.equal(stats.readRejectedReasons.read_partial_offset, 1);
});

test("a bare limit without EOF proof stays conservative", () => {
  const { decisions, stats } = planSupersedeWrites([
    writeRec(),
    readRec({ args: { filePath: "src/a.ts", limit: 2000 }, metadata: {} }),
  ]);

  assert.equal(decisions.length, 0);
  assert.equal(stats.readRejectedReasons.read_limited, 1);
});

test("a structured line range covering the whole file is accepted", () => {
  const { decisions } = planSupersedeWrites([
    writeRec(),
    readRec({
      args: { filePath: "src/a.ts" },
      metadata: {
        display: { lineStart: 1, lineEnd: 40, totalLines: 40, truncated: false },
      },
    }),
  ]);

  assert.equal(decisions.length, 1);
});

test("a structured line range that stops early is rejected", () => {
  const { decisions, stats } = planSupersedeWrites([
    writeRec(),
    readRec({
      args: { filePath: "src/a.ts" },
      metadata: {
        display: { lineStart: 1, lineEnd: 10, totalLines: 40, truncated: false },
      },
    }),
  ]);

  assert.equal(decisions.length, 0);
  assert.equal(stats.readRejectedReasons.read_partial_range, 1);
});

test("a failed read is never used as a superseder", () => {
  const { decisions, stats } = planSupersedeWrites([
    writeRec(),
    readRec({ status: "error", metadata: {} }),
  ]);

  assert.equal(decisions.length, 0);
  assert.equal(stats.readRejectedReasons.read_invalid_candidate, 1);
});

// --- end-to-end: the write context is really modified ---------------------

function transform(partsByMessage) {
  const messages = [userMessage({ id: "u1" })];
  for (const { id, parts } of partsByMessage) {
    messages.push(assistantMessage({ id, parentID: "u1", parts }));
  }
  return { messages, result: transformMessages(messages, { ...CONFIG, measureContext: true }) };
}

test("full runtime read really redacts the write input and output", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart()] }),
  ];
  const original = clone(messages);
  const beforeUnits = original[1].parts[0].state.input.content.length;

  const result = transformMessages(messages, { ...CONFIG, measureContext: true });
  assert.equal(result.changed, true);

  const write = result.messages[1].parts[0];
  assert.equal(write.state.status, "completed");
  assert.equal(write.state.input.filePath, "src/a.ts");
  assert.equal(write.state.input.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(write.state.output, DEFAULT_SUPERSEDE_PLACEHOLDER);
  // Audit identity and metadata are retained.
  assert.equal(write.callID, "w1");
  assert.deepEqual(write.state.time, { start: 1, end: 2 });
  assert.deepEqual(write.state.metadata, { diff: "…" });

  // The keeper read is untouched.
  assert.equal(result.messages[2].parts[0].state.output, READ_OUTPUT);

  const sup = result.stats.supersedeWrites;
  assert.equal(sup.prunedCount, 1);
  assert.equal(sup.changedCount, 1);
  assert.equal(sup.observedReadCount, 1);
  assert.equal(sup.fullReadCount, 1);
  assert.equal(sup.fileMatchCount, 1);
  assert.equal(sup.versionVerifiedCount, 1);
  assert.ok(sup.tokenSavingsEstimated > 0);
  assert.ok(result.contextUnits.after < result.contextUnits.before);
  assert.ok(beforeUnits > DEFAULT_SUPERSEDE_PLACEHOLDER.length);
  // The original message objects are never mutated.
  assert.deepEqual(messages, original);
});

test("a truncated read leaves every write byte-identical", () => {
  const { messages, result } = transform([
    { id: "a1", parts: [writePart()] },
    {
      id: "a2",
      parts: [readPart({ metadata: { truncated: true } })],
    },
  ]);

  assert.equal(result.changed, false);
  assert.equal(result.messages, messages);
  assert.deepEqual(result.messages[1].parts[0].state.input, {
    filePath: "src/a.ts",
    content: LONG_CONTENT,
  });
  assert.equal(result.stats.supersedeWrites.prunedCount, 0);
  assert.equal(result.stats.supersedeWrites.readRejectedReasons.read_truncated, 1);
});

test("a stale read (started before the write ended) keeps the write", () => {
  const { result } = transform([
    { id: "a1", parts: [writePart({ time: { start: 10, end: 20 } })] },
    { id: "a2", parts: [readPart({ time: { start: 11, end: 12 } })] },
  ]);

  assert.equal(result.changed, false);
  // A read that overlaps the write cannot prove it observed the final bytes.
  assert.equal(result.stats.supersedeWrites.skippedReasons.concurrent_write_overlap, 1);
});

test("a concurrent same-file write invalidates the read for the whole file", () => {
  const { result } = transform([
    { id: "a1", parts: [writePart({ callID: "w1", time: { start: 1, end: 2 } })] },
    { id: "a2", parts: [writePart({ callID: "w2", time: { start: 5, end: 30 } })] },
    { id: "a3", parts: [readPart({ time: { start: 20, end: 21 } })] },
  ]);

  assert.equal(result.changed, false);
  assert.equal(result.stats.supersedeWrites.skippedReasons.concurrent_write_overlap, 1);
});

test("a write that happens after the read is retained", () => {
  const { result } = transform([
    { id: "a1", parts: [readPart({ time: { start: 1, end: 2 } })] },
    { id: "a2", parts: [writePart({ time: { start: 3, end: 4 } })] },
  ]);

  assert.equal(result.changed, false);
  assert.equal(result.stats.supersedeWrites.prunedCount, 0);
  // The read is not a superseder for a later write.
  assert.equal(result.stats.supersedeWrites.skippedReasons.no_superseding_read, 1);
});

test("a partial (offset) read never clears the whole-file write", () => {
  const { result } = transform([
    { id: "a1", parts: [writePart()] },
    {
      id: "a2",
      parts: [
        readPart({
          args: { filePath: "src/a.ts", offset: 100, limit: 20 },
          metadata: { truncated: false },
        }),
      ],
    },
  ]);

  assert.equal(result.changed, false);
  assert.equal(result.stats.supersedeWrites.readRejectedReasons.read_partial_offset, 1);
});

// --- adapter extraction sanity -------------------------------------------

test("the adapter projects runtime read metadata into the normalized record", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart()] }),
  ];
  const { records } = extractToolRecords(messages);
  const read = records.find((record) => record.id === "r1");
  assert.equal(read.args.limit, 2000);
  assert.equal(read.args.offset, 1);
  assert.equal(read.metadata.truncated, false);
});

test("missing timings preserve the write (no happens-before proof)", () => {
  const { result } = transform([
    { id: "a1", parts: [writePart({ time: null })] },
    { id: "a2", parts: [readPart({ time: { start: 3, end: 4 } })] },
  ]);

  assert.equal(result.changed, false);
  assert.equal(result.stats.supersedeWrites.skippedReasons.read_not_after_write, 1);
});
