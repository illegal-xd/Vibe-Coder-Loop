import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import {
  DEFAULT_ERROR_PLACEHOLDER,
  DUPLICATE_ERROR_PLACEHOLDER,
} from "../../.opencode/context-dedup/error-purge.js";
import { transformMessages } from "../../.opencode/context-dedup/opencode.js";
import { VibeContextDedupPlugin } from "../../.opencode/plugins/vibe-context-dedup.js";
import {
  assistantMessage,
  clone,
  textPart,
  toolPart,
  userMessage,
} from "./helpers.mjs";

const CONFIG = resolveConfig({}, {});
const LONG_ERROR =
  "AssertionError: expected response.status to equal 200\n" +
  "  at tests/integration/checkout.test.js:42:17\n".repeat(80);
const LONG_OUTPUT = "line of file content\n".repeat(100);

function errorConversation({
  errorCommand = "npm test",
  successCommand = errorCommand,
  errorCwd = "/repo",
  successCwd = errorCwd,
  userBetween = false,
  editBetween = false,
  referenceText = "",
  successStatus = "completed",
  successMetadata = {},
} = {}) {
  const messages = [userMessage({ id: "u1", text: "run the check" })];
  messages.push(
    assistantMessage({
      id: "a_err",
      parentID: "u1",
      cwd: errorCwd,
      parts: [
        toolPart({
          messageID: "a_err",
          callID: "err1",
          tool: "bash",
          input: { command: errorCommand },
          status: "error",
          error: LONG_ERROR,
        }),
      ],
    }),
  );
  if (editBetween) {
    messages.push(
      assistantMessage({
        id: "a_edit",
        parentID: "u1",
        cwd: errorCwd,
        parts: [
          toolPart({
            messageID: "a_edit",
            callID: "edit1",
            tool: "edit",
            input: { filePath: "src/checkout.js" },
            output: "updated",
          }),
        ],
      }),
    );
  }
  if (referenceText) {
    messages.push(
      assistantMessage({
        id: "a_ref",
        parentID: "u1",
        cwd: errorCwd,
        parts: [
          textPart({
            id: "p_ref",
            messageID: "a_ref",
            text: referenceText,
          }),
        ],
      }),
    );
  }
  if (userBetween) {
    messages.push(userMessage({ id: "u2", text: "try again" }));
  }
  messages.push(
    assistantMessage({
      id: "a_ok",
      parentID: userBetween ? "u2" : "u1",
      cwd: successCwd,
      parts: [
        toolPart({
          messageID: "a_ok",
          callID: "ok1",
          tool: "bash",
          input: { command: successCommand },
          output: "all tests passed",
          status: successStatus,
          metadata: successMetadata,
        }),
      ],
    }),
  );
  return messages;
}

test("Error Purge replaces only state.error and preserves call/result integrity", () => {
  const messages = errorConversation();
  const original = clone(messages);
  const result = transformMessages(messages, CONFIG);

  assert.equal(result.changed, true);
  assert.equal(result.stats.errorPurge.prunedCount, 1);
  assert.equal(result.stats.errorPurge.confirmedErrorCount, 1);
  assert.equal(result.stats.errorPurge.actualTokenSavings, null);
  assert.deepEqual(result.stats.errorPurge.decisionKinds, { superseded_by_success: 1 });
  assert.ok(result.stats.errorPurge.tokenSavingsEstimated > 0);
  assert.equal(result.messages.length, messages.length);

  const errorPart = result.messages[1].parts[0];
  const successPart = result.messages[2].parts[0];
  assert.equal(errorPart.state.error, DEFAULT_ERROR_PLACEHOLDER);
  assert.equal(errorPart.state.status, "error");
  assert.equal(errorPart.callID, "err1");
  assert.equal(errorPart.tool, "bash");
  assert.deepEqual(errorPart.state.input, { command: "npm test" });
  assert.equal(successPart.callID, "ok1");
  assert.equal(successPart.state.output, "all tests passed");

  // Original message objects are untouched.
  assert.deepEqual(messages, original);
});

test("different command, workspace, or user turn is preserved", () => {
  const differentCommand = transformMessages(
    errorConversation({ successCommand: "npm run build" }),
    CONFIG,
  );
  assert.equal(differentCommand.changed, false);
  assert.equal(differentCommand.stats.errorPurge.prunedCount, 0);

  const differentWorkspace = transformMessages(
    errorConversation({ successCwd: "/another-repo" }),
    CONFIG,
  );
  assert.equal(differentWorkspace.changed, false);

  const acrossUserTurn = transformMessages(
    errorConversation({ userBetween: true }),
    CONFIG,
  );
  assert.equal(acrossUserTurn.changed, false);
  assert.equal(acrossUserTurn.stats.errorPurge.skippedReasons.across_user_turn, 1);
});

test("a state-changing edit between failure and success preserves the error", () => {
  const result = transformMessages(errorConversation({ editBetween: true }), CONFIG);
  assert.equal(result.changed, false);
  assert.equal(result.stats.errorPurge.skippedReasons.intervening_state_change, 1);
});

test("an error actively referenced later is preserved", () => {
  const beforeSuccess = transformMessages(
    errorConversation({ referenceText: "Use err1 diagnostics to explain the fix." }),
    CONFIG,
  );
  assert.equal(beforeSuccess.changed, false);
  assert.equal(beforeSuccess.stats.errorPurge.skippedReasons.referenced_later, 1);

  const afterSuccess = transformMessages(
    [
      ...errorConversation(),
      assistantMessage({
        id: "a_ref_after",
        parentID: "u1",
        parts: [
          textPart({
            id: "p_ref_after",
            messageID: "a_ref_after",
            text: "The earlier err1 failure still matters.",
          }),
        ],
      }),
    ],
    CONFIG,
  );
  assert.equal(afterSuccess.changed, false);
  assert.equal(afterSuccess.stats.errorPurge.skippedReasons.referenced_later, 1);
});

test("repeated identical failures keep the newest error output", () => {
  const messages = [
    userMessage({ id: "u1", text: "run" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [
        toolPart({
          messageID: "a1",
          callID: "err1",
          tool: "bash",
          input: { command: "npm test" },
          status: "error",
          error: LONG_ERROR,
        }),
      ],
    }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [
        toolPart({
          messageID: "a2",
          callID: "err2",
          tool: "bash",
          input: { command: "npm test" },
          status: "error",
          error: LONG_ERROR,
        }),
      ],
    }),
  ];
  const result = transformMessages(messages, CONFIG);
  assert.equal(result.changed, true);
  assert.equal(result.messages[1].parts[0].state.error, DUPLICATE_ERROR_PLACEHOLDER);
  assert.equal(result.messages[2].parts[0].state.error, LONG_ERROR);
  assert.equal(result.stats.errorPurge.prunedCount, 1);
  assert.equal(result.stats.errorPurge.preservedCount, 1);
});

test("a successful result with diagnostic text is not classified as an error", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [
        toolPart({
          messageID: "a1",
          callID: "ok1",
          tool: "bash",
          input: { command: "npm test" },
          output: "Error: expected warning; failed to connect",
        }),
      ],
    }),
  ];
  const result = transformMessages(messages, CONFIG);
  assert.equal(result.changed, false);
  assert.equal(result.stats.errorPurge.confirmedErrorCount, 0);
  assert.equal(result.stats.errorPurge.ambiguousResultCount, 0);
});

test("incomplete or structured-ambiguous results do not supersede", () => {
  const running = transformMessages(
    errorConversation({ successStatus: "running" }),
    CONFIG,
  );
  assert.equal(running.changed, false);
  assert.equal(running.stats.errorPurge.ambiguousResultCount, 1);

  const failureMetadata = transformMessages(
    errorConversation({ successMetadata: { exitCode: 1 } }),
    CONFIG,
  );
  assert.equal(failureMetadata.changed, false);
  assert.equal(failureMetadata.stats.errorPurge.ambiguousResultCount, 1);
});

test("observation-only mode reports candidates without changing content", () => {
  const messages = errorConversation();
  const original = clone(messages);
  const result = transformMessages(
    messages,
    resolveConfig({ errorPurge: { preview: true } }, {}),
  );
  assert.equal(result.changed, false);
  assert.equal(result.messages, messages);
  assert.equal(result.stats.errorPurge.preview, true);
  assert.equal(result.stats.errorPurge.wouldPruneCount, 1);
  assert.equal(result.stats.errorPurge.prunedCount, 0);
  assert.deepEqual(result.stats.errorPurge.decisionKinds, { superseded_by_success: 1 });
  assert.equal(result.stats.errorPurge.tokenSavingsEstimated, 0);
  assert.ok(result.stats.errorPurge.tokenSavingsEstimatedIfApplied > 0);
  assert.deepEqual(messages, original);
});

test("disabling Error Purge alone leaves the model-facing messages unchanged", () => {
  const messages = errorConversation();
  const result = transformMessages(
    messages,
    resolveConfig({ errorPurge: { enabled: false } }, {}),
  );
  assert.equal(result.changed, false);
  assert.equal(result.messages, messages);
  assert.equal(result.stats.errorPurge.enabled, false);
  assert.equal(result.stats.errorPurge.prunedCount, 0);
});

test("disabling Error Purge leaves it unchanged while dedup still works", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "r1m",
      parentID: "u1",
      parts: [
        toolPart({
          messageID: "r1m",
          callID: "r1",
          tool: "read",
          input: { filePath: "a.txt" },
          output: LONG_OUTPUT,
        }),
      ],
    }),
    assistantMessage({
      id: "r2m",
      parentID: "u1",
      parts: [
        toolPart({
          messageID: "r2m",
          callID: "r2",
          tool: "read",
          input: { filePath: "a.txt" },
          output: LONG_OUTPUT,
        }),
      ],
    }),
    ...errorConversation().slice(1),
  ];
  const result = transformMessages(messages, resolveConfig({ errorPurge: { enabled: false } }, {}));

  assert.equal(result.stats.errorPurge.enabled, false);
  assert.equal(result.stats.errorPurge.prunedCount, 0);
  assert.equal(result.stats.prunedCount, 1);
  assert.equal(result.messages[1].parts[0].state.output, CONFIG.placeholder);
  assert.equal(result.messages[3].parts[0].state.error, LONG_ERROR);
});

test("dedup and Error Purge can prune independently in one request", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "r1m",
      parentID: "u1",
      parts: [
        toolPart({
          messageID: "r1m",
          callID: "r1",
          tool: "read",
          input: { filePath: "a.txt" },
          output: LONG_OUTPUT,
        }),
      ],
    }),
    assistantMessage({
      id: "r2m",
      parentID: "u1",
      parts: [
        toolPart({
          messageID: "r2m",
          callID: "r2",
          tool: "read",
          input: { filePath: "a.txt" },
          output: LONG_OUTPUT,
        }),
      ],
    }),
    ...errorConversation().slice(1),
  ];
  const result = transformMessages(messages, CONFIG);
  assert.equal(result.changed, true);
  assert.equal(result.stats.prunedCount, 1);
  assert.equal(result.stats.errorPurge.prunedCount, 1);
  assert.equal(result.messages[1].parts[0].state.output, CONFIG.placeholder);
  assert.equal(result.messages[3].parts[0].state.error, DEFAULT_ERROR_PLACEHOLDER);
});

test("top-level preview applies to both strategies", () => {
  const result = transformMessages(
    errorConversation(),
    resolveConfig({ preview: true }, {}),
  );
  assert.equal(result.changed, false);
  assert.equal(result.stats.preview, true);
  assert.equal(result.stats.errorPurge.preview, true);
  assert.equal(result.stats.errorPurge.prunedCount, 0);
});

test("repeated Error Purge application is idempotent", () => {
  const first = transformMessages(errorConversation(), CONFIG);
  assert.equal(first.changed, true);
  const second = transformMessages(first.messages, CONFIG);
  assert.equal(second.changed, false);
  assert.equal(second.stats.errorPurge.prunedCount, 0);
  assert.deepEqual(second.messages, first.messages);
});

test("malformed tool result association fails closed", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [
        {
          id: "p1",
          type: "tool",
          tool: "bash",
          state: { status: "error", error: LONG_ERROR },
        },
      ],
    }),
  ];
  const result = transformMessages(messages, CONFIG);
  assert.equal(result.changed, false);
  assert.equal(result.stats.error, "invalid_tool_part");
  assert.equal(result.stats.errorPurge.error, "invalid_tool_part");
});

test("OpenCode plugin hook applies Error Purge in place", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-error-purge-"));
  const previousLog = process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED;
  const previousDisabled = process.env.VIBE_CONTEXT_ERROR_PURGE_DISABLED;
  const previousPreview = process.env.VIBE_CONTEXT_ERROR_PURGE_PREVIEW;
  const previousConfig = process.env.VIBE_CONTEXT_DEDUP_CONFIG;
  process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED = "1";
  delete process.env.VIBE_CONTEXT_ERROR_PURGE_DISABLED;
  delete process.env.VIBE_CONTEXT_ERROR_PURGE_PREVIEW;
  delete process.env.VIBE_CONTEXT_DEDUP_CONFIG;
  try {
    const plugin = await VibeContextDedupPlugin({ directory });
    const output = { messages: errorConversation() };
    await plugin["experimental.chat.messages.transform"]({}, output);
    assert.equal(output.messages[1].parts[0].state.error, DEFAULT_ERROR_PLACEHOLDER);
    assert.equal(output.messages[1].parts[0].state.status, "error");
  } finally {
    if (previousLog === undefined) delete process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED;
    else process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED = previousLog;
    if (previousDisabled === undefined) delete process.env.VIBE_CONTEXT_ERROR_PURGE_DISABLED;
    else process.env.VIBE_CONTEXT_ERROR_PURGE_DISABLED = previousDisabled;
    if (previousPreview === undefined) delete process.env.VIBE_CONTEXT_ERROR_PURGE_PREVIEW;
    else process.env.VIBE_CONTEXT_ERROR_PURGE_PREVIEW = previousPreview;
    if (previousConfig === undefined) delete process.env.VIBE_CONTEXT_DEDUP_CONFIG;
    else process.env.VIBE_CONTEXT_DEDUP_CONFIG = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
});
