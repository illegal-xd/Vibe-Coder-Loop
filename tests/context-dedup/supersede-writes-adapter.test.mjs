import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig, ConfigError } from "../../.opencode/context-dedup/config.js";
import { DEFAULT_SUPERSEDE_PLACEHOLDER } from "../../.opencode/context-dedup/supersede-writes.js";
import {
  applySupersedeWriteDecisions,
  extractToolRecords,
  transformMessages,
} from "../../.opencode/context-dedup/opencode.js";
import { VibeContextDedupPlugin } from "../../.opencode/plugins/vibe-context-dedup.js";
import {
  assistantMessage,
  clone,
  textPart,
  toolPart,
  userMessage,
} from "./helpers.mjs";

const CONFIG = resolveConfig({}, {});
const LONG_CONTENT = "export const value = 42;\n".repeat(120);
const READ_OUTPUT = "1| export const value = 42;\n".repeat(40);

function writePart({
  callID = "w1",
  messageID = "a1",
  filePath = "src/a.ts",
  content = LONG_CONTENT,
  status = "completed",
  output = "File written successfully",
  error = "EACCES: permission denied",
  time = { start: 1, end: 2 },
  metadata = { diff: "…" },
} = {}) {
  return toolPart({
    id: `part_${callID}`,
    messageID,
    callID,
    tool: "write",
    input: { filePath, content },
    output,
    status,
    error,
    time,
    metadata,
    title: `write ${filePath}`,
  });
}

function readPart({
  callID = "r1",
  messageID = "a2",
  filePath = "src/a.ts",
  args,
  output = READ_OUTPUT,
  status = "completed",
  metadata = {},
  time = { start: 3, end: 4 },
} = {}) {
  return toolPart({
    id: `part_${callID}`,
    messageID,
    callID,
    tool: "read",
    input: args ?? { filePath },
    output,
    status,
    error: "read failed",
    time,
    metadata,
    title: `read ${filePath}`,
  });
}

function partAt(result, messageIndex, partIndex = 0) {
  return result.messages[messageIndex].parts[partIndex];
}

test("a successful write followed by a full read is redacted in the request copy", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [writePart({ time: { start: 1, end: 2 } })],
    }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [readPart({ time: { start: 3, end: 4 } })],
    }),
  ];
  const original = clone(messages);
  const result = transformMessages(messages, CONFIG);

  assert.equal(result.changed, true);
  assert.equal(result.stats.supersedeWrites.prunedCount, 1);
  assert.equal(result.stats.supersedeWrites.wouldPruneCount, 1);
  assert.equal(result.stats.supersedeWrites.candidateCount, 1);
  assert.ok(result.stats.supersedeWrites.tokenSavingsEstimated > 0);

  const write = partAt(result, 1);
  assert.equal(write.callID, "w1");
  assert.equal(write.tool, "write");
  assert.equal(write.state.status, "completed");
  assert.equal(write.state.input.filePath, "src/a.ts");
  assert.equal(write.state.input.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(write.state.output, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(write.state.title, "write src/a.ts");
  assert.deepEqual(write.state.metadata, { diff: "…" });
  assert.deepEqual(write.state.time, { start: 1, end: 2 });
  assert.equal(write.state.error, undefined);

  // The read is the keeper and stays byte-identical.
  const read = partAt(result, 2);
  assert.equal(read.state.output, READ_OUTPUT);
  assert.equal(read.state.input.filePath, "src/a.ts");

  // Message/part structure and audit identity are unchanged.
  assert.equal(result.messages.length, messages.length);
  assert.equal(result.messages[1].parts.length, 1);
  assert.equal(result.messages[2].parts.length, 1);
  assert.deepEqual(messages, original);
});

test("a failed write is never cleaned even after a successful full read", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [writePart({ status: "error", time: { start: 1, end: 2 } })],
    }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [readPart({ time: { start: 3, end: 4 } })],
    }),
  ];
  const result = transformMessages(messages, CONFIG);

  assert.equal(result.changed, false);
  assert.equal(result.stats.supersedeWrites.prunedCount, 0);
  const write = partAt(result, 1);
  assert.equal(write.state.status, "error");
  assert.equal(write.state.error, "EACCES: permission denied");
  assert.equal(write.state.input.content, LONG_CONTENT);
});

test("edit and multiedit payloads are redacted while the path is kept", () => {
  const editPart = (callID, input, time) =>
    toolPart({
      id: `part_${callID}`,
      messageID: "a1",
      callID,
      tool: "edit",
      input,
      output: "Edit applied successfully",
      time,
      title: `edit ${input.filePath}`,
    });

  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [
        editPart(
          "e1",
          { filePath: "src/a.ts", oldString: "old line\n".repeat(80), newString: "new line\n".repeat(80) },
          { start: 1, end: 2 },
        ),
        editPart(
          "e2",
          {
            filePath: "src/a.ts",
            edits: [{ oldString: "a".repeat(400), newString: "b".repeat(400) }],
          },
          { start: 3, end: 4 },
        ),
      ],
    }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart({ time: { start: 5, end: 6 } })] }),
  ];
  const result = transformMessages(messages, CONFIG);

  const [first, second] = result.messages[1].parts;
  assert.equal(first.state.input.filePath, "src/a.ts");
  assert.equal(first.state.input.oldString, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(first.state.input.newString, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(second.state.input.filePath, "src/a.ts");
  assert.equal(second.state.input.edits, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(result.stats.supersedeWrites.prunedCount, 2);
});

test("a write after the read is retained; only the earlier write is superseded", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [writePart({ callID: "w1", time: { start: 1, end: 2 } })],
    }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [readPart({ callID: "r1", time: { start: 3, end: 4 } })],
    }),
    assistantMessage({
      id: "a3",
      parentID: "u1",
      parts: [
        writePart({
          callID: "w2",
          messageID: "a3",
          content: "newer content\n",
          time: { start: 5, end: 6 },
        }),
      ],
    }),
  ];
  const result = transformMessages(messages, CONFIG);

  assert.equal(result.changed, true);
  const first = partAt(result, 1);
  const second = partAt(result, 2);
  const later = partAt(result, 3);
  assert.equal(first.state.input.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(second.state.output, READ_OUTPUT);
  assert.equal(later.state.input.content, "newer content\n");
  assert.equal(later.state.output, "File written successfully");
});

test("reading A leaves B's write context untouched", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [
        writePart({ callID: "wA", filePath: "src/a.ts", time: { start: 1, end: 2 } }),
        writePart({ callID: "wB", filePath: "src/b.ts", time: { start: 3, end: 4 } }),
      ],
    }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [readPart({ callID: "rA", filePath: "src/a.ts", time: { start: 5, end: 6 } })],
    }),
  ];
  const result = transformMessages(messages, CONFIG);

  assert.equal(partAt(result, 1, 0).state.input.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(partAt(result, 1, 1).state.input.content, LONG_CONTENT);
  assert.equal(result.stats.supersedeWrites.prunedCount, 1);
});

test("same basename in a different directory is not superseded", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [
        writePart({ callID: "w1", filePath: "dir1/a.ts", time: { start: 1, end: 2 } }),
        writePart({ callID: "w2", filePath: "dir2/a.ts", time: { start: 3, end: 4 } }),
      ],
    }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [readPart({ callID: "r1", filePath: "dir1/a.ts", time: { start: 5, end: 6 } })],
    }),
  ];
  const result = transformMessages(messages, CONFIG);

  assert.equal(partAt(result, 1, 0).state.input.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(partAt(result, 1, 1).state.input.content, LONG_CONTENT);
});

test("partial, truncated, failed, and empty reads never clean the write", () => {
  const variants = [
    readPart({ args: { filePath: "src/a.ts", limit: 50 } }),
    readPart({ args: { filePath: "src/a.ts", offset: 120 } }),
    readPart({ metadata: { truncated: true } }),
    readPart({ status: "error" }),
    readPart({ output: "" }),
    readPart({ output: "Output capped at 2000 lines" }),
  ];
  for (const read of variants) {
    const messages = [
      userMessage({ id: "u1" }),
      assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
      assistantMessage({ id: "a2", parentID: "u1", parts: [read] }),
    ];
    const result = transformMessages(messages, CONFIG);
    assert.equal(result.changed, false);
    assert.equal(result.stats.supersedeWrites.prunedCount, 0);
    assert.equal(partAt(result, 1).state.input.content, LONG_CONTENT);
  }
});

test("an overlapping read cannot supersede; a later completed read can", () => {
  const overlapping = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [writePart({ time: { start: 1, end: 20 } })],
    }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [readPart({ time: { start: 10, end: 11 } })],
    }),
  ];
  const blocked = transformMessages(overlapping, CONFIG);
  assert.equal(blocked.changed, false);
  assert.equal(blocked.stats.supersedeWrites.skippedReasons.concurrent_write_overlap, 1);

  const laterRead = clone(overlapping);
  laterRead.push(
    assistantMessage({
      id: "a3",
      parentID: "u1",
      parts: [readPart({ callID: "r2", messageID: "a3", time: { start: 21, end: 22 } })],
    }),
  );
  const allowed = transformMessages(laterRead, CONFIG);
  assert.equal(allowed.changed, true);
  assert.equal(partAt(allowed, 1).state.input.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
});

test("a broad mutation between write and read is a conservative barrier", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [
        toolPart({
          id: "part_bash",
          messageID: "a2",
          callID: "bash1",
          tool: "bash",
          input: { command: "echo hi > src/a.ts" },
          output: "ok",
          time: { start: 3, end: 4 },
        }),
      ],
    }),
    assistantMessage({
      id: "a3",
      parentID: "u1",
      parts: [readPart({ messageID: "a3", time: { start: 5, end: 6 } })],
    }),
  ];
  const result = transformMessages(messages, CONFIG);

  assert.equal(result.changed, false);
  assert.equal(result.stats.supersedeWrites.skippedReasons.intervening_broad_mutation, 1);
  assert.equal(partAt(result, 1).state.input.content, LONG_CONTENT);
});

test("a later reference to the write protects its context", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [textPart({ id: "p_ref", messageID: "a2", text: "I used call w1 earlier." })],
    }),
    assistantMessage({
      id: "a3",
      parentID: "u1",
      parts: [readPart({ messageID: "a3", time: { start: 5, end: 6 } })],
    }),
  ];
  const result = transformMessages(messages, CONFIG);

  assert.equal(result.changed, false);
  assert.equal(result.stats.supersedeWrites.skippedReasons.referenced_later, 1);
});

test("all three strategies apply independently in one request", () => {
  const duplicateRead = (callID, messageID) =>
    toolPart({
      id: `part_${callID}`,
      messageID,
      callID,
      tool: "read",
      input: { filePath: "dup.txt" },
      output: "duplicate content\n".repeat(40),
    });
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "d1m", parentID: "u1", parts: [duplicateRead("d1", "d1m")] }),
    assistantMessage({ id: "d2m", parentID: "u1", parts: [duplicateRead("d2", "d2m")] }),
    assistantMessage({
      id: "w1m",
      parentID: "u1",
      parts: [writePart({ callID: "w1", messageID: "w1m", time: { start: 10, end: 11 } })],
    }),
    assistantMessage({
      id: "r1m",
      parentID: "u1",
      parts: [readPart({ callID: "r1", messageID: "r1m", time: { start: 12, end: 13 } })],
    }),
    assistantMessage({
      id: "e1m",
      parentID: "u1",
      parts: [
        toolPart({
          id: "part_e1",
          messageID: "e1m",
          callID: "e1",
          tool: "bash",
          input: { command: "npm test" },
          status: "error",
          error: "AssertionError: boom\n".repeat(60),
        }),
      ],
    }),
    assistantMessage({
      id: "s1m",
      parentID: "u1",
      parts: [
        toolPart({
          id: "part_s1",
          messageID: "s1m",
          callID: "s1",
          tool: "bash",
          input: { command: "npm test" },
          output: "all tests passed",
        }),
      ],
    }),
  ];
  const result = transformMessages(messages, CONFIG);

  assert.equal(result.stats.prunedCount, 1);
  assert.equal(result.stats.errorPurge.prunedCount, 1);
  assert.equal(result.stats.supersedeWrites.prunedCount, 1);
  assert.equal(result.messages[1].parts[0].state.output, CONFIG.placeholder);
  assert.equal(result.messages[3].parts[0].state.input.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(result.messages[5].parts[0].state.error, "[vibe-context-dedup] Error output omitted: a later equivalent successful result superseded it. The failure status is retained.");
});

test("preview reports the decision without changing the request", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart()] }),
  ];
  const config = resolveConfig({ supersedeWrites: { preview: true } }, {});
  const result = transformMessages(messages, config);

  assert.equal(result.changed, false);
  assert.equal(result.stats.supersedeWrites.wouldPruneCount, 1);
  assert.equal(result.stats.supersedeWrites.prunedCount, 0);
  assert.equal(partAt(result, 1).state.input.content, LONG_CONTENT);
});

test("preview:null inherits the global preview even for direct callers", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart()] }),
  ];
  const result = transformMessages(messages, {
    enabled: true,
    preview: true,
    deduplication: { enabled: false },
    errorPurge: { enabled: false },
    supersedeWrites: { preview: null },
  });
  assert.equal(result.stats.supersedeWrites.preview, true);
  assert.equal(result.stats.supersedeWrites.wouldPruneCount, 1);
  assert.equal(result.stats.supersedeWrites.prunedCount, 0);
});

test("the strategy can be disabled independently", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart()] }),
  ];
  const config = resolveConfig({ supersedeWrites: { enabled: false } }, {});
  const result = transformMessages(messages, config);

  assert.equal(result.changed, false);
  assert.equal(result.stats.supersedeWrites.prunedCount, 0);
  assert.equal(result.stats.errorPurge.enabled, true);
});

test("cross-user-turn write/read is allowed by default and can be preserved", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
    userMessage({ id: "u2", text: "now verify" }),
    assistantMessage({
      id: "a2",
      parentID: "u2",
      parts: [readPart({ time: { start: 5, end: 6 } })],
    }),
  ];
  const allowed = transformMessages(messages, CONFIG);
  assert.equal(partAt(allowed, 1).state.input.content, DEFAULT_SUPERSEDE_PLACEHOLDER);

  const preserved = transformMessages(
    messages,
    resolveConfig({ supersedeWrites: { preserveAcrossUserTurns: true } }, {}),
  );
  assert.equal(partAt(preserved, 1).state.input.content, LONG_CONTENT);
  assert.equal(preserved.stats.supersedeWrites.skippedReasons.across_user_turn, 1);
});

test("re-applying the transform is idempotent", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart()] }),
  ];
  const first = transformMessages(messages, CONFIG);
  assert.equal(first.changed, true);

  const second = transformMessages(first.messages, CONFIG);
  assert.equal(second.changed, false);
  assert.equal(second.stats.supersedeWrites.prunedCount, 0);
  assert.equal(
    partAt(second, 1).state.input.content,
    DEFAULT_SUPERSEDE_PLACEHOLDER,
  );
  assert.equal(partAt(second, 2).state.output, READ_OUTPUT);
});

test("a state mismatch drops the decision and leaves the context consistent", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart()] }),
  ];
  const extraction = extractToolRecords(messages);
  const decision = {
    id: "w1",
    kind: "superseded_by_read",
    confidence: "high",
    tool: "write",
    order: extraction.records.find((record) => record.id === "w1").order,
    keeperId: "r1",
    keeperOrder: 2,
    field: "input+output",
    // Structurally equal but a different object: reference verification must
    // reject it so a changed input is never redacted.
    expectedInput: { filePath: "src/a.ts", content: LONG_CONTENT },
    expectedOutput: "a different output that no longer matches",
    redactedInput: { filePath: "src/a.ts", content: DEFAULT_SUPERSEDE_PLACEHOLDER },
    replacement: DEFAULT_SUPERSEDE_PLACEHOLDER,
    estimatedTokensSaved: 100,
  };
  const application = applySupersedeWriteDecisions(
    messages,
    [decision],
    extraction.locations,
  );

  assert.equal(application.changed, false);
  assert.equal(application.applied.length, 0);
  assert.deepEqual(application.dropped, [{ id: "w1", reason: "state_mismatch" }]);
  assert.equal(application.messages, messages);
  assert.equal(partAt({ messages: application.messages }, 1).state.input.content, LONG_CONTENT);
});

test("a legacy expectedInputJson decision still applies", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
  ];
  const extraction = extractToolRecords(messages);
  const input = messages[1].parts[0].state.input;
  const decision = {
    id: "w1",
    kind: "superseded_by_read",
    confidence: "high",
    tool: "write",
    order: extraction.records[0].order,
    keeperId: "r1",
    keeperOrder: 2,
    field: "input+output",
    expectedInputJson: JSON.stringify(input),
    expectedOutput: "File written successfully",
    redactedInput: { filePath: "src/a.ts", content: DEFAULT_SUPERSEDE_PLACEHOLDER },
    replacement: DEFAULT_SUPERSEDE_PLACEHOLDER,
    estimatedTokensSaved: 100,
  };
  const application = applySupersedeWriteDecisions(messages, [decision], extraction.locations);
  assert.equal(application.changed, true);
  assert.equal(application.applied.length, 1);
});

test("a call id inside a later write payload is not a reference", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [writePart({ callID: "w1", time: { start: 1, end: 2 } })],
    }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [readPart({ time: { start: 3, end: 4 } })],
    }),
    assistantMessage({
      id: "a3",
      parentID: "u1",
      parts: [
        writePart({
          callID: "w2",
          messageID: "a3",
          filePath: "src/b.ts",
          content: "mentions w1 only as text",
          time: { start: 5, end: 6 },
        }),
      ],
    }),
  ];
  const result = transformMessages(messages, CONFIG);
  assert.equal(partAt(result, 1).state.input.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
  assert.equal(result.stats.supersedeWrites.skippedReasons.referenced_later, undefined);
});

test("unresolvable paths are preserved conservatively", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [
        toolPart({
          id: "part_w1",
          messageID: "a1",
          callID: "w1",
          tool: "write",
          input: { content: LONG_CONTENT },
          output: "File written successfully",
          time: { start: 1, end: 2 },
        }),
      ],
    }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart()] }),
  ];
  const result = transformMessages(messages, CONFIG);

  assert.equal(result.changed, false);
  assert.equal(partAt(result, 1).state.input.content, LONG_CONTENT);
});

test("config exposes supersedeWrites defaults, env overrides, and validation", async () => {
  const defaults = resolveConfig({}, {});
  assert.equal(defaults.supersedeWrites.enabled, true);
  assert.equal(defaults.supersedeWrites.readTools[0], "read");
  assert.ok(defaults.supersedeWrites.writeTools.includes("write"));
  assert.equal(defaults.supersedeWrites.placeholder, DEFAULT_SUPERSEDE_PLACEHOLDER);

  const disabled = resolveConfig({}, { VIBE_CONTEXT_SUPERSEDE_WRITES_DISABLED: "1" });
  assert.equal(disabled.supersedeWrites.enabled, false);

  const preview = resolveConfig({}, { VIBE_CONTEXT_SUPERSEDE_WRITES_PREVIEW: "1" });
  assert.equal(preview.supersedeWrites.preview, true);

  assert.throws(
    () => resolveConfig({ supersedeWrites: { enabled: "yes" } }, {}),
    ConfigError,
  );
  assert.throws(
    () => resolveConfig({ supersedeWrites: { readTools: [] } }, {}),
    ConfigError,
  );
});

test("the plugin hook applies the redaction in place without touching the session objects", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-supersede-plugin-"));
  const previousLog = process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED;
  process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED = "1";
  try {
    const plugin = await VibeContextDedupPlugin({ directory });
    const messages = [
      userMessage({ id: "u1" }),
      assistantMessage({ id: "a1", parentID: "u1", parts: [writePart()] }),
      assistantMessage({ id: "a2", parentID: "u1", parts: [readPart()] }),
    ];
    const original = clone(messages);
    const output = { messages };

    await plugin["experimental.chat.messages.transform"]({}, output);

    assert.equal(output.messages.length, 3);
    assert.equal(output.messages[1].parts[0].state.input.content, DEFAULT_SUPERSEDE_PLACEHOLDER);
    assert.equal(output.messages[1].parts[0].state.output, DEFAULT_SUPERSEDE_PLACEHOLDER);
    assert.equal(output.messages[2].parts[0].state.output, READ_OUTPUT);
    // The original session/request message objects are never mutated.
    assert.equal(original[1].parts[0].state.input.content, LONG_CONTENT);
    assert.equal(original[1].parts[0].state.output, "File written successfully");
    assert.notEqual(output.messages[1], original[1]);
  } finally {
    if (previousLog === undefined) delete process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED;
    else process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED = previousLog;
    await rm(directory, { recursive: true, force: true });
  }
});
