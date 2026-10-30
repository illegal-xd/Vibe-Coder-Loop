import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import {
  compactReadOutput,
  createSlimEditState,
  expandLineRangeEdit,
  mergeSlimStats,
  slimToolDefinition,
} from "../../.opencode/context-dedup/slim-edit.js";
import { summarizePruning } from "../../.opencode/context-dedup/token-usage.js";
import { VibeContextDedupPlugin } from "../../.opencode/plugins/vibe-context-dedup.js";
import { assistantMessage, SESSION_ID, userMessage } from "./helpers.mjs";

const DAILY_FILE_PATTERN = /^token-usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function slimConfig(overrides = {}) {
  return resolveConfig({ slimEdit: overrides }, {}).slimEdit;
}

test("slimEdit defaults are on and independently switchable", () => {
  const config = resolveConfig({}, {});
  assert.deepEqual(config.slimEdit, {
    enabled: true,
    preview: false,
    toolDescriptions: true,
    compactRead: true,
    lineRangeEdit: true,
  });

  const off = resolveConfig(
    { slimEdit: { toolDescriptions: false, compactRead: false } },
    {},
  );
  assert.equal(off.slimEdit.toolDescriptions, false);
  assert.equal(off.slimEdit.compactRead, false);
  assert.equal(off.slimEdit.lineRangeEdit, true);

  const disabled = resolveConfig({}, { VIBE_CONTEXT_SLIM_EDIT_DISABLED: "1" });
  assert.equal(disabled.slimEdit.enabled, false);
  const preview = resolveConfig({}, { VIBE_CONTEXT_SLIM_EDIT_PREVIEW: "yes" });
  assert.equal(preview.slimEdit.preview, true);

  assert.throws(
    () => resolveConfig({ slimEdit: { compactRead: "yes" } }, {}),
    /slimEdit\.compactRead must be a boolean/,
  );
});

test("tool descriptions are replaced and their repeated saving is measured", () => {
  const state = createSlimEditState(slimConfig());
  const output = { description: "Read the contents of a file from disk. ".repeat(20), parameters: {} };

  slimToolDefinition({ toolID: "read" }, output, state, slimConfig());
  assert.equal(output.description, "Read file content.");
  assert.equal(state.toolDescriptions.changedCount, 1);
  assert.ok(state.toolDescriptions.tokenSavingsEstimated > 0);

  // A second request receives the original verbose definition again, so the
  // saving repeats per request rather than being counted once per session.
  const next = { description: "Read the contents of a file from disk. ".repeat(20) };
  slimToolDefinition({ toolID: "read" }, next, state, slimConfig());
  assert.equal(state.toolDescriptions.changedCount, 2);
});

test("compact read shortens the path and drops type/footer boilerplate", () => {
  const state = createSlimEditState(slimConfig());
  const directory = "/repo";
  const output = {
    output: [
      "<path>/repo/src/app.js</path>",
      "<type>file</type>",
      "",
      "const value = 1",
      "",
      "(End of file - total 1 lines)",
      "",
    ].join("\n"),
  };

  compactReadOutput(directory, { tool: "read" }, output, state, slimConfig());
  assert.equal(
    output.output,
    ["<path>src/app.js</path>", "", "const value = 1", ""].join("\n"),
  );
  assert.equal(state.compactRead.changedCount, 1);
  assert.ok(state.compactRead.tokenSavingsEstimated > 0);
});

test("line range oldString expands before the edit tool runs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-slim-edit-"));
  try {
    const file = path.join(directory, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n");
    const state = createSlimEditState(slimConfig());
    const output = { args: { filePath: "sample.txt", oldString: "2-3", newString: "x" } };

    expandLineRangeEdit(directory, { tool: "edit" }, output, state, slimConfig());
    assert.equal(output.args.oldString, "beta\ngamma");
    assert.equal(state.lineRangeEdit.changedCount, 1);
    assert.ok(state.lineRangeEdit.tokenSavingsEstimated > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("literal oldString wins over a line range and preview never mutates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-slim-preview-"));
  try {
    const file = path.join(directory, "sample.txt");
    await writeFile(file, "alpha\n2-3\ngamma\n");

    const literalState = createSlimEditState(slimConfig());
    const literal = { args: { filePath: "sample.txt", oldString: "2-3" } };
    expandLineRangeEdit(directory, { tool: "edit" }, literal, literalState, slimConfig());
    assert.equal(literal.args.oldString, "2-3");
    assert.equal(literalState.lineRangeEdit.changedCount, 0);
    assert.equal(literalState.lineRangeEdit.skippedReasons.literal_match, 1);

    const previewConfig = slimConfig({ preview: true });
    const previewState = createSlimEditState(previewConfig);
    const preview = { args: { filePath: "sample.txt", oldString: "1-1" } };
    expandLineRangeEdit(directory, { tool: "edit" }, preview, previewState, previewConfig);
    assert.equal(preview.args.oldString, "1-1");
    assert.equal(previewState.lineRangeEdit.changedCount, 0);
    assert.equal(previewState.lineRangeEdit.markedCount, 1);
    assert.equal(previewState.lineRangeEdit.tokenSavingsEstimated, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("summarizePruning merges slim strategies without changing the funnel order", () => {
  const config = slimConfig();
  const state = createSlimEditState(config);
  slimToolDefinition(
    { toolID: "read" },
    { description: "Read the contents of a file. ".repeat(20) },
    state,
    config,
  );

  const summary = summarizePruning({ deduplicationEnabled: false }, state);
  assert.deepEqual(summary.order, [
    "deduplication",
    "error_purge",
    "supersede_writes",
    "tool_descriptions",
    "compact_read",
    "line_range_edit",
  ]);
  assert.equal(summary.deduplication.enabled, false);
  assert.equal(summary.tool_descriptions.changed_items, 1);
  assert.equal(summary.compact_read.changed_items, 0);
  assert.ok(summary.total_removed_tokens.value > 0);
});

test("mergeSlimStats moves definition counters onto the session bucket", () => {
  const config = slimConfig();
  const definitions = createSlimEditState(config);
  const session = createSlimEditState(config);
  slimToolDefinition(
    { toolID: "bash" },
    { description: "Run a shell command in the project. ".repeat(20) },
    definitions,
    config,
  );
  mergeSlimStats(session, definitions);
  assert.equal(session.toolDescriptions.changedCount, 1);
  assert.ok(session.toolDescriptions.tokenSavingsEstimated > 0);
});

test("plugin hooks apply all three strategies and log them in the usage record", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-slim-plugin-"));
  try {
    await mkdir(path.join(directory, ".opencode"), { recursive: true });
    const file = path.join(directory, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n");

    const plugin = await VibeContextDedupPlugin({
      directory,
      env: { VIBE_TOKEN_USAGE_HOME: path.join(directory, "central") },
    });

    const definition = {
      description: "Read the contents of a file from disk. ".repeat(20),
      parameters: {},
    };
    await plugin["tool.definition"]({ toolID: "read" }, definition);
    assert.equal(definition.description, "Read file content.");

    const readOutput = {
      title: "read",
      output: [
        `<path>${file}</path>`,
        "<type>file</type>",
        "",
        "alpha",
        "beta",
        "gamma",
        "",
        "(End of file - total 3 lines)",
        "",
      ].join("\n"),
      metadata: {},
    };
    await plugin["tool.execute.after"](
      { tool: "read", sessionID: SESSION_ID, callID: "call_read", args: { filePath: "sample.txt" } },
      readOutput,
    );
    assert.equal(readOutput.output.startsWith("<path>sample.txt</path>"), true);
    assert.equal(readOutput.output.includes("<type>file</type>"), false);

    const editArgs = { args: { filePath: "sample.txt", oldString: "2-3", newString: "x" } };
    await plugin["tool.execute.before"](
      { tool: "edit", sessionID: SESSION_ID, callID: "call_edit" },
      editArgs,
    );
    assert.equal(editArgs.args.oldString, "beta\ngamma");

    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue" })],
    });

    const info = assistantMessage({ id: "msg_slim" }).info;
    info.time = { created: 1, completed: 2 };
    info.tokens = { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 }, total: 1100 };
    await plugin.event({ event: { type: "message.updated", properties: { info } } });

    const files = (await readdir(path.join(directory, "central"))).filter((name) =>
      DAILY_FILE_PATTERN.test(name),
    );
    assert.equal(files.length, 1);
    const lines = (await readFile(path.join(directory, "central", files[0]), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.pruning.tool_descriptions.changed_items, 1);
    assert.equal(record.pruning.compact_read.changed_items, 1);
    assert.equal(record.pruning.line_range_edit.changed_items, 1);
    assert.ok(record.pruning.total_removed_tokens.value > 0);
    assert.equal(record.errors.includes("pruning_unavailable"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
