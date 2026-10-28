import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_PLACEHOLDER } from "../../.opencode/context-dedup/core.js";
import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import {
  applyDecisions,
  extractToolRecords,
  referencesCallId,
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
const LONG_OUTPUT = "line of file content\n".repeat(100);

function duplicateMessages() {
  return [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [toolPart({ messageID: "a1", callID: "call_old", output: LONG_OUTPUT })],
    }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [toolPart({ messageID: "a2", callID: "call_new", output: LONG_OUTPUT })],
    }),
  ];
}

test("extracts OpenCode ToolPart records with call id, state, and environment", () => {
  const messages = duplicateMessages();
  const extraction = extractToolRecords(messages);

  assert.equal(extraction.structuralFailure, "");
  assert.equal(extraction.records.length, 2);
  assert.deepEqual(
    extraction.records.map((record) => ({
      id: record.id,
      tool: record.tool,
      status: record.status,
      cwd: record.env.cwd,
    })),
    [
      { id: "call_old", tool: "read", status: "completed", cwd: "/repo" },
      { id: "call_new", tool: "read", status: "completed", cwd: "/repo" },
    ],
  );
});

test("prunes the older output while preserving message and part structure", () => {
  const messages = duplicateMessages();
  const original = clone(messages);

  const result = transformMessages(messages, CONFIG);

  assert.equal(result.changed, true);
  assert.notEqual(result.messages, messages);
  assert.equal(result.stats.prunedCount, 1);
  assert.equal(result.stats.wouldPruneCount, 1);
  assert.ok(result.stats.tokenSavingsEstimated > 0);
  assert.equal(result.messages.length, messages.length);

  const oldPart = result.messages[1].parts[0];
  const newPart = result.messages[2].parts[0];
  assert.equal(oldPart.state.output, DEFAULT_PLACEHOLDER);
  assert.equal(newPart.state.output, LONG_OUTPUT);
  assert.equal(oldPart.callID, "call_old");
  assert.equal(newPart.callID, "call_new");
  assert.equal(oldPart.tool, "read");
  assert.deepEqual(oldPart.state.input, { filePath: "a.txt" });
  assert.equal(result.messages[1].parts.length, 1);
  assert.equal(result.messages[2].parts.length, 1);

  // The session/request input objects must not be mutated.
  assert.deepEqual(messages, original);
});

test("does not prune calls with different arguments, tools, or environments", () => {
  const differentArgs = transformMessages(
    [
      assistantMessage({
        id: "a1",
        parts: [toolPart({ messageID: "a1", callID: "a", input: { filePath: "a.txt" }, output: "same" })],
      }),
      assistantMessage({
        id: "a2",
        parts: [toolPart({ messageID: "a2", callID: "b", input: { filePath: "b.txt" }, output: "same" })],
      }),
    ],
    CONFIG,
  );
  assert.equal(differentArgs.changed, false);
  assert.equal(differentArgs.stats.prunedCount, 0);

  const differentEnv = transformMessages(
    [
      assistantMessage({
        id: "a1",
        cwd: "/repo-one",
        parts: [toolPart({ messageID: "a1", callID: "a", output: "same" })],
      }),
      assistantMessage({
        id: "a2",
        cwd: "/repo-two",
        parts: [toolPart({ messageID: "a2", callID: "b", output: "same" })],
      }),
    ],
    CONFIG,
  );
  assert.equal(differentEnv.changed, false);
});

test("does not guess the environment when info.path is missing", () => {
  const result = transformMessages(
    [
      assistantMessage({
        id: "a1",
        cwd: null,
        parts: [toolPart({ messageID: "a1", callID: "a", output: LONG_OUTPUT })],
      }),
      assistantMessage({
        id: "a2",
        cwd: null,
        parts: [toolPart({ messageID: "a2", callID: "b", output: LONG_OUTPUT })],
      }),
    ],
    CONFIG,
  );
  assert.equal(result.changed, false);
  assert.equal(result.stats.candidateCount, 0);
  assert.equal(result.stats.skippedReasons.missing_environment, 2);
});

test("does not prune failed calls or side-effecting tools", () => {
  const failed = transformMessages(
    [
      assistantMessage({
        id: "a1",
        parts: [
          toolPart({
            messageID: "a1",
            callID: "failed",
            status: "error",
            error: "permission denied",
          }),
        ],
      }),
      assistantMessage({
        id: "a2",
        parts: [toolPart({ messageID: "a2", callID: "ok", output: "same" })],
      }),
    ],
    CONFIG,
  );
  assert.equal(failed.changed, false);
  assert.equal(failed.stats.skippedReasons.not_completed, 1);

  const sideEffect = transformMessages(
    [
      assistantMessage({
        id: "a1",
        parts: [toolPart({ messageID: "a1", callID: "w1", tool: "write", output: "ok" })],
      }),
      assistantMessage({
        id: "a2",
        parts: [toolPart({ messageID: "a2", callID: "w2", tool: "write", output: "ok" })],
      }),
    ],
    CONFIG,
  );
  assert.equal(sideEffect.changed, false);
  assert.equal(sideEffect.stats.skippedReasons.unsupported_tool, 2);
});

test("keeps different outputs even when arguments and environment match", () => {
  const result = transformMessages(
    [
      assistantMessage({
        id: "a1",
        parts: [toolPart({ messageID: "a1", callID: "a", output: "version one" })],
      }),
      assistantMessage({
        id: "a2",
        parts: [toolPart({ messageID: "a2", callID: "b", output: "version two" })],
      }),
    ],
    CONFIG,
  );
  assert.equal(result.changed, false);
  assert.equal(result.stats.sameSignatureDifferentOutputGroups, 1);
});

test("a later reference to the old call id blocks pruning", () => {
  const messages = [
    assistantMessage({
      id: "a1",
      parts: [toolPart({ messageID: "a1", callID: "call_old", output: LONG_OUTPUT })],
    }),
    userMessage({ id: "u2", text: "use call_old for the next step" }),
    assistantMessage({
      id: "a2",
      parts: [toolPart({ messageID: "a2", callID: "call_new", output: LONG_OUTPUT })],
    }),
  ];

  assert.equal(referencesCallId(extractToolRecords(messages).orderedParts, "call_old", 0, 2), true);

  const result = transformMessages(messages, CONFIG);
  assert.equal(result.changed, false);
  assert.equal(result.stats.skippedReasons.referenced_later, 1);
});

test("preview reports would-prune stats without changing messages", () => {
  const messages = duplicateMessages();
  const original = clone(messages);
  const result = transformMessages(messages, { ...CONFIG, preview: true });

  assert.equal(result.changed, false);
  assert.equal(result.messages, messages);
  assert.equal(result.stats.preview, true);
  assert.equal(result.stats.wouldPruneCount, 1);
  assert.equal(result.stats.prunedCount, 0);
  assert.equal(result.stats.tokenSavingsEstimated, 0);
  assert.ok(result.stats.tokenSavingsEstimatedIfApplied > 0);
  assert.deepEqual(messages, original);
});

test("is idempotent across repeated transformations", () => {
  const first = transformMessages(duplicateMessages(), CONFIG);
  assert.equal(first.changed, true);

  const second = transformMessages(first.messages, CONFIG);
  assert.equal(second.changed, false);
  assert.equal(second.stats.prunedCount, 0);
  assert.deepEqual(second.messages, first.messages);
});

test("empty messages are a no-op", () => {
  const empty = transformMessages([], CONFIG);
  assert.equal(empty.changed, false);
  assert.equal(empty.stats.recordsTotal, 0);
  assert.deepEqual(empty.stats.skippedReasons, {});
});

test("malformed messages and incomplete tool parts fail closed", () => {
  const notArray = transformMessages(null, CONFIG);
  assert.equal(notArray.changed, false);
  assert.equal(notArray.stats.skippedReasons.invalid_messages, 1);

  const badMessage = transformMessages([{ info: {}, parts: "not-an-array" }], CONFIG);
  assert.equal(badMessage.changed, false);
  assert.equal(badMessage.stats.error, "invalid_message");

  const incompletePart = transformMessages(
    [
      assistantMessage({
        id: "a1",
        parts: [{ id: "p1", type: "tool", tool: "read", state: { status: "completed" } }],
      }),
    ],
    CONFIG,
  );
  assert.equal(incompletePart.changed, false);
  assert.equal(incompletePart.stats.error, "invalid_tool_part");
});

test("applyDecisions refuses location or state mismatches", () => {
  const messages = duplicateMessages();
  const extraction = extractToolRecords(messages);
  const badLocation = applyDecisions(
    messages,
    [{ id: "call_old", keeperId: "call_new", order: 1, keeperOrder: 2 }],
    new Map([["call_old", { ...extraction.locations.get("call_old"), messageIndex: 99 }]]),
    DEFAULT_PLACEHOLDER,
  );
  assert.equal(badLocation.changed, false);
  assert.equal(badLocation.dropped[0].reason, "location_mismatch");

  const changedMessages = duplicateMessages();
  changedMessages[1].parts[0].state.output = "changed after extraction";
  const badState = applyDecisions(
    changedMessages,
    [{ id: "call_old", keeperId: "call_new", order: 1, keeperOrder: 2 }],
    extraction.locations,
    DEFAULT_PLACEHOLDER,
  );
  assert.equal(badState.changed, false);
  assert.equal(badState.dropped[0].reason, "state_mismatch");

  const goodState = applyDecisions(
    messages,
    [{ id: "call_old", keeperId: "call_new", order: 1, keeperOrder: 2 }],
    extraction.locations,
    DEFAULT_PLACEHOLDER,
  );
  assert.equal(goodState.changed, true);
  assert.equal(goodState.applied.length, 1);
});

test("OpenCode plugin loads project config and honors preview", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-context-dedup-config-"));
  const previousLog = process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED;
  const previousDisabled = process.env.VIBE_CONTEXT_DEDUP_DISABLED;
  const previousPreview = process.env.VIBE_CONTEXT_DEDUP_PREVIEW;
  const previousConfig = process.env.VIBE_CONTEXT_DEDUP_CONFIG;
  process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED = "1";
  delete process.env.VIBE_CONTEXT_DEDUP_DISABLED;
  delete process.env.VIBE_CONTEXT_DEDUP_PREVIEW;
  delete process.env.VIBE_CONTEXT_DEDUP_CONFIG;
  try {
    await mkdir(path.join(directory, ".opencode"), { recursive: true });
    await writeFile(
      path.join(directory, ".opencode", "context-dedup.json"),
      JSON.stringify({ preview: true, tools: ["read"] }),
      "utf8",
    );

    const plugin = await VibeContextDedupPlugin({ directory, worktree: directory });
    const messages = duplicateMessages();
    const output = { messages };
    await plugin["experimental.chat.messages.transform"]({}, output);
    assert.equal(output.messages[1].parts[0].state.output, LONG_OUTPUT);
  } finally {
    if (previousLog === undefined) delete process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED;
    else process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED = previousLog;
    if (previousDisabled === undefined) delete process.env.VIBE_CONTEXT_DEDUP_DISABLED;
    else process.env.VIBE_CONTEXT_DEDUP_DISABLED = previousDisabled;
    if (previousPreview === undefined) delete process.env.VIBE_CONTEXT_DEDUP_PREVIEW;
    else process.env.VIBE_CONTEXT_DEDUP_PREVIEW = previousPreview;
    if (previousConfig === undefined) delete process.env.VIBE_CONTEXT_DEDUP_CONFIG;
    else process.env.VIBE_CONTEXT_DEDUP_CONFIG = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid project config disables the plugin instead of guessing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-context-dedup-bad-config-"));
  const previousLog = process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED;
  const previousDisabled = process.env.VIBE_CONTEXT_DEDUP_DISABLED;
  const previousPreview = process.env.VIBE_CONTEXT_DEDUP_PREVIEW;
  const previousConfig = process.env.VIBE_CONTEXT_DEDUP_CONFIG;
  process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED = "1";
  delete process.env.VIBE_CONTEXT_DEDUP_DISABLED;
  delete process.env.VIBE_CONTEXT_DEDUP_PREVIEW;
  delete process.env.VIBE_CONTEXT_DEDUP_CONFIG;
  try {
    await mkdir(path.join(directory, ".opencode"), { recursive: true });
    await writeFile(
      path.join(directory, ".opencode", "context-dedup.json"),
      JSON.stringify({ enabled: "yes" }),
      "utf8",
    );

    const plugin = await VibeContextDedupPlugin({ directory, worktree: directory });
    const messages = duplicateMessages();
    const output = { messages };
    await plugin["experimental.chat.messages.transform"]({}, output);
    assert.equal(output.messages[1].parts[0].state.output, LONG_OUTPUT);
  } finally {
    if (previousLog === undefined) delete process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED;
    else process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED = previousLog;
    if (previousDisabled === undefined) delete process.env.VIBE_CONTEXT_DEDUP_DISABLED;
    else process.env.VIBE_CONTEXT_DEDUP_DISABLED = previousDisabled;
    if (previousPreview === undefined) delete process.env.VIBE_CONTEXT_DEDUP_PREVIEW;
    else process.env.VIBE_CONTEXT_DEDUP_PREVIEW = previousPreview;
    if (previousConfig === undefined) delete process.env.VIBE_CONTEXT_DEDUP_CONFIG;
    else process.env.VIBE_CONTEXT_DEDUP_CONFIG = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenCode plugin hook applies the transform in place", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-context-dedup-"));
  const previousLog = process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED;
  const previousDisabled = process.env.VIBE_CONTEXT_DEDUP_DISABLED;
  const previousPreview = process.env.VIBE_CONTEXT_DEDUP_PREVIEW;
  const previousConfig = process.env.VIBE_CONTEXT_DEDUP_CONFIG;
  process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED = "1";
  delete process.env.VIBE_CONTEXT_DEDUP_DISABLED;
  delete process.env.VIBE_CONTEXT_DEDUP_PREVIEW;
  delete process.env.VIBE_CONTEXT_DEDUP_CONFIG;
  try {
    const plugin = await VibeContextDedupPlugin({ directory, worktree: directory });
    assert.equal(typeof plugin["experimental.chat.messages.transform"], "function");

    const messages = duplicateMessages();
    const output = { messages };
    await plugin["experimental.chat.messages.transform"]({}, output);

    assert.equal(output.messages[1].parts[0].state.output, DEFAULT_PLACEHOLDER);
    assert.equal(output.messages[2].parts[0].state.output, LONG_OUTPUT);

    const noopOutput = { messages: null };
    await plugin["experimental.chat.messages.transform"]({}, noopOutput);
    assert.equal(noopOutput.messages, null);
  } finally {
    if (previousLog === undefined) delete process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED;
    else process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED = previousLog;
    if (previousDisabled === undefined) delete process.env.VIBE_CONTEXT_DEDUP_DISABLED;
    else process.env.VIBE_CONTEXT_DEDUP_DISABLED = previousDisabled;
    if (previousPreview === undefined) delete process.env.VIBE_CONTEXT_DEDUP_PREVIEW;
    else process.env.VIBE_CONTEXT_DEDUP_PREVIEW = previousPreview;
    if (previousConfig === undefined) delete process.env.VIBE_CONTEXT_DEDUP_CONFIG;
    else process.env.VIBE_CONTEXT_DEDUP_CONFIG = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
});

function findFirst(paths) {
  for (const candidate of paths) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "";
}

const home = os.homedir();
const pluginTypes = findFirst([
  process.env.OPENCODE_PLUGIN_TYPES,
  path.join(home, ".config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts"),
  path.join(home, ".cache/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts"),
]);
const sdkTypes = findFirst([
  process.env.OPENCODE_SDK_TYPES,
  path.join(home, ".config/opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts"),
  path.join(home, ".cache/opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts"),
]);

test(
  "installed OpenCode types still expose the transform hook and ToolPart shape",
  { skip: pluginTypes ? false : "OpenCode plugin types are not installed in this environment" },
  () => {
    const pluginText = readFileSync(pluginTypes, "utf8");
    const hookIndex = pluginText.indexOf('"experimental.chat.messages.transform"');
    assert.ok(hookIndex >= 0, "transform hook is missing from installed plugin types");
    const hookSlice = pluginText.slice(hookIndex, hookIndex + 700);
    assert.match(hookSlice, /messages:\s*\{/);
    assert.match(hookSlice, /info:\s*Message;/);
    assert.match(hookSlice, /parts:\s*Part\[\];/);

    if (sdkTypes) {
      const sdkText = readFileSync(sdkTypes, "utf8");
      assert.match(sdkText, /export type ToolPart = \{/);
      assert.match(sdkText, /callID: string;/);
      assert.match(sdkText, /state: ToolState;/);
      assert.match(sdkText, /status: "completed";/);
      assert.match(sdkText, /output: string;/);
    }
  },
);
