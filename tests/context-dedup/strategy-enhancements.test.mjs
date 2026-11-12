import test from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import {
  DEFAULT_SHELL_FAILURE_PATTERNS,
  planErrorPurge,
} from "../../.opencode/context-dedup/error-purge.js";
import {
  hasFailureMetadata,
  isConfirmedSuccess,
  normalizeReadOutput,
  planDeduplication,
  validPlaceholder,
} from "../../.opencode/context-dedup/core.js";
import { planSupersedeWrites } from "../../.opencode/context-dedup/supersede-writes.js";
import { transformMessages } from "../../.opencode/context-dedup/opencode.js";
import { summarizePruning } from "../../.opencode/context-dedup/token-usage.js";
import {
  assistantMessage,
  textPart,
  toolPart,
  userMessage,
} from "./helpers.mjs";

test("shared core utilities work as expected", () => {
  assert.equal(hasFailureMetadata({ exitCode: 1 }), true);
  assert.equal(hasFailureMetadata({ timeout: true }), true);
  assert.equal(hasFailureMetadata({ timedOut: true }), true);
  assert.equal(hasFailureMetadata({ ok: true }), false);
  assert.equal(hasFailureMetadata(null), false);

  assert.equal(
    isConfirmedSuccess({
      status: "completed",
      error: "",
      metadata: { ok: true },
    }),
    true,
  );
  assert.equal(
    isConfirmedSuccess({
      status: "completed",
      error: "some error",
      metadata: {},
    }),
    false,
  );

  assert.equal(
    validPlaceholder("[vibe-context-dedup] custom", "fallback"),
    "[vibe-context-dedup] custom",
  );
  assert.equal(validPlaceholder("invalid", "fallback"), "fallback");
});

test("expanded shell failure patterns recognize modern build/test/compiler errors", () => {
  const tsError = "src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";
  const pyError = "Traceback (most recent call last):\n  File 'app.py', line 5\nModuleNotFoundError: No module named 'foo'\n";
  const testFail = "FAIL src/auth.test.ts\n  ✕ login returns 401 on bad password (5ms)\n";
  const assertErr = "AssertionError [ERR_ASSERTION]: expected 200 to equal 404\n";
  const fatalErr = "fatal: not a git repository (or any of the parent directories): .git\n";

  assert.ok(DEFAULT_SHELL_FAILURE_PATTERNS.some((p) => p.test(tsError)));
  assert.ok(DEFAULT_SHELL_FAILURE_PATTERNS.some((p) => p.test(pyError)));
  assert.ok(DEFAULT_SHELL_FAILURE_PATTERNS.some((p) => p.test(testFail)));
  assert.ok(DEFAULT_SHELL_FAILURE_PATTERNS.some((p) => p.test(assertErr)));
  assert.ok(DEFAULT_SHELL_FAILURE_PATTERNS.some((p) => p.test(fatalErr)));
});

test("barrierWriteTools: false allows intervening edit to not block Error Purge", () => {
  const LONG_ERROR = "Test failed with AssertionError: expected 200, got 500\n".repeat(20);
  const conversation = [
    userMessage({ id: "u1", text: "fix the bug and test" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      cwd: "/repo",
      parts: [
        toolPart({
          id: "p_err",
          callID: "call_err",
          tool: "bash",
          status: "error",
          error: LONG_ERROR,
          input: { command: "npm test" },
        }),
        toolPart({
          id: "p_edit",
          callID: "call_edit",
          tool: "edit",
          status: "completed",
          input: { filePath: "src/fix.js", content: "fixed" },
          output: "File updated",
        }),
        toolPart({
          id: "p_ok",
          callID: "call_ok",
          tool: "bash",
          status: "completed",
          input: { command: "npm test" },
          output: "Tests passed (1/1)",
        }),
      ],
    }),
  ];

  // 1. With default config (barrierWriteTools: true), intervening edit is a barrier
  const defaultConf = resolveConfig({ errorPurge: { shellExitReliable: true } }, {});
  const resDefault = transformMessages(conversation, defaultConf);
  assert.equal(resDefault.changed, false);
  assert.equal(resDefault.stats.errorPurge.skippedReasons.intervening_state_change, 1);

  // 2. With barrierWriteTools: false, intervening edit does NOT block error supersession!
  const relaxedConf = resolveConfig(
    {
      errorPurge: {
        shellExitReliable: true,
        barrierWriteTools: false,
      },
    },
    {},
  );
  const resRelaxed = transformMessages(conversation, relaxedConf);
  assert.equal(resRelaxed.changed, true);
  assert.equal(resRelaxed.stats.errorPurge.prunedCount, 1);
  assert.equal(resRelaxed.stats.errorPurge.decisionKinds.superseded_by_success, 1);
});

test("deduplication supports normalizeReadOutput option", () => {
  const content = "const x = 1;\nexport function getX() { return x; }\n".repeat(20);
  const read1 = `<path>/repo/a.ts</path>\n<type>file</type>\n${content}\n\n(End of file - total 40 lines)\n`;
  const read2 = content;

  const records = [
    {
      id: "r1",
      order: 1,
      tool: "read",
      args: { filePath: "a.ts" },
      env: { cwd: "/repo" },
      status: "completed",
      output: read1,
    },
    {
      id: "r2",
      order: 2,
      tool: "read",
      args: { filePath: "a.ts" },
      env: { cwd: "/repo" },
      status: "completed",
      output: read2,
    },
  ];

  // Without normalization: outputs differ, no dedup
  const unnormalized = planDeduplication(records, { tools: ["read"] });
  assert.equal(unnormalized.decisions.length, 0);

  // With normalization: wrapper tags stripped, matched & pruned!
  const normalized = planDeduplication(records, {
    tools: ["read"],
    normalizeReadOutput: true,
  });
  assert.equal(normalized.decisions.length, 1);
  assert.equal(normalized.decisions[0].id, "r1");
  assert.equal(normalized.decisions[0].keeperId, "r2");
});

test("supersedeWrites supports allowOrderFallback when time is missing", () => {
  const records = [
    {
      id: "w1",
      order: 1,
      tool: "write",
      args: { filePath: "a.ts", content: "hello world\n".repeat(50) },
      env: { cwd: "/repo" },
      status: "completed",
      output: "written",
      // Missing time timestamps
    },
    {
      id: "r1",
      order: 2,
      tool: "read",
      args: { filePath: "a.ts" },
      env: { cwd: "/repo" },
      status: "completed",
      output: "hello world\n".repeat(50),
      metadata: { truncated: false },
      // Missing time timestamps
    },
  ];

  // Without fallback: missing time preserves the write
  const strict = planSupersedeWrites(records);
  assert.equal(strict.decisions.length, 0);
  assert.equal(strict.stats.skippedReasons.read_not_after_write, 1);

  // With fallback: order (1 < 2) allows supersession
  const fallback = planSupersedeWrites(records, { allowOrderFallback: true });
  assert.equal(fallback.decisions.length, 1);
  assert.equal(fallback.decisions[0].id, "w1");
  assert.equal(fallback.decisions[0].keeperId, "r1");
});

// --- success classification: diagnostic text vs explicit success ------------

test("a diagnostic string does not veto an explicit success marker", () => {
  // Some runtimes attach stderr/warning text to completed calls that also say
  // ok/success. That is a success: the diagnostic is not an execution verdict.
  assert.equal(
    isConfirmedSuccess({
      status: "completed",
      error: "",
      metadata: { ok: true, error: "warning: deprecated option\n" },
    }),
    true,
  );
  assert.equal(
    isConfirmedSuccess({
      status: "completed",
      error: "",
      metadata: { success: true, exception: "retrying once" },
    }),
    true,
  );
});

test("hard failure state still wins over a success flag", () => {
  assert.equal(
    isConfirmedSuccess({
      status: "completed",
      error: "",
      metadata: { ok: true, exitCode: 2 },
    }),
    false,
  );
  assert.equal(
    isConfirmedSuccess({
      status: "completed",
      error: "",
      metadata: { success: true, failed: true },
    }),
    false,
  );
  assert.equal(
    isConfirmedSuccess({
      status: "completed",
      error: "",
      metadata: { ok: true, timedOut: true },
    }),
    false,
  );
});

test("a diagnostic string without a success marker stays unconfirmed", () => {
  assert.equal(
    isConfirmedSuccess({
      status: "completed",
      error: "",
      metadata: { error: "stderr text" },
    }),
    false,
  );
});

// --- supersede evidence gaps ----------------------------------------------

function timedWrite(overrides = {}) {
  return {
    id: "w1",
    order: 1,
    tool: "write",
    args: { filePath: "a.ts", content: "payload\n".repeat(60) },
    env: { cwd: "/repo", root: "/repo" },
    status: "completed",
    output: "written",
    metadata: {},
    time: { start: 1, end: 2 },
    ...overrides,
  };
}

function fullRead(overrides = {}) {
  return {
    id: "r1",
    order: 2,
    tool: "read",
    args: { filePath: "a.ts", offset: 1, limit: 2000 },
    env: { cwd: "/repo", root: "/repo" },
    status: "completed",
    output: "payload\n".repeat(60),
    metadata: { truncated: false },
    time: { start: 3, end: 4 },
    ...overrides,
  };
}

test("supersede reports missing timestamps instead of silently pruning nothing", () => {
  // Write has no completion time, read has no start time: neither side can
  // prove happens-before, which is exactly the real-host zero case.
  const plan = planSupersedeWrites([
    timedWrite({ time: { start: 1 } }),
    fullRead({ time: { end: 4 } }),
  ]);

  assert.equal(plan.decisions.length, 0);
  assert.equal(plan.stats.missingWriteEndCount, 1);
  assert.equal(plan.stats.missingReadStartCount, 1);
  assert.equal(plan.stats.orderFallbackCount, 0);
  assert.equal(plan.stats.skippedReasons.read_not_after_write, 1);
});

test("order fallback is opt-in through config and is counted when used", () => {
  const records = [
    timedWrite({ time: { start: 1 } }),
    fullRead({ time: { start: 3 } }),
  ];
  const config = resolveConfig(
    { supersedeWrites: { allowOrderFallback: true } },
    {},
  );
  const plan = planSupersedeWrites(records, config.supersedeWrites);

  assert.equal(plan.decisions.length, 1);
  assert.equal(plan.decisions[0].id, "w1");
  assert.equal(plan.stats.orderFallbackCount, 1);
  assert.equal(plan.stats.missingWriteEndCount, 1);
  // The read does carry a start time, so only the write side is missing proof.
  assert.equal(plan.stats.missingReadStartCount, 0);
});

test("a read without EOF proof is counted separately from a definite partial read", () => {
  const noProof = planSupersedeWrites([
    timedWrite(),
    fullRead({ args: { filePath: "a.ts", limit: 2000 }, metadata: {} }),
  ]);
  assert.equal(noProof.stats.readMissingEofProofCount, 1);
  assert.equal(noProof.stats.readRejectedReasons.read_limited, 1);

  const partial = planSupersedeWrites([
    timedWrite(),
    fullRead({ args: { filePath: "a.ts", offset: 50, limit: 20 }, metadata: {} }),
  ]);
  assert.equal(partial.stats.readMissingEofProofCount, 0);
  assert.equal(partial.stats.readRejectedReasons.read_partial_offset, 1);
});

test("evidence gaps reach the usage summary only when they occur", () => {
  const noGap = summarizePruning({
    supersedeWrites: {
      enabled: true,
      observedReadCount: 1,
      fullReadCount: 1,
      candidateCount: 1,
      eligibleCount: 1,
      fileMatchCount: 1,
      versionVerifiedCount: 1,
      markedCount: 1,
      prunedCount: 1,
    },
  });
  assert.equal(noGap.supersede_writes.reads.missing_start_time, undefined);
  assert.equal(noGap.supersede_writes.reads.missing_eof_proof, undefined);
  assert.equal(noGap.supersede_writes.writes.missing_end_time, undefined);

  const gaps = summarizePruning({
    supersedeWrites: {
      enabled: true,
      observedReadCount: 2,
      fullReadCount: 0,
      confirmedWriteCount: 2,
      candidateCount: 2,
      eligibleCount: 2,
      fileMatchCount: 0,
      missingWriteEndCount: 2,
      missingReadStartCount: 1,
      readMissingEofProofCount: 1,
      orderFallbackCount: 1,
    },
  });
  assert.equal(gaps.supersede_writes.writes.missing_end_time, 2);
  assert.equal(gaps.supersede_writes.reads.missing_start_time, 1);
  assert.equal(gaps.supersede_writes.reads.missing_eof_proof, 1);
  assert.equal(gaps.supersede_writes.reads.order_fallback_used, 1);
});

// --- reference strength ---------------------------------------------------

const LONG_READ_OUTPUT = "line of repeated read output\n".repeat(20);

function duplicateReads(extraParts = []) {
  return [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [
        toolPart({
          id: "p_old",
          messageID: "a1",
          callID: "call_old",
          output: LONG_READ_OUTPUT,
        }),
      ],
    }),
    ...extraParts,
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [
        toolPart({
          id: "p_new",
          messageID: "a2",
          callID: "call_new",
          output: LONG_READ_OUTPUT,
        }),
      ],
    }),
  ];
}

const PROSE_MENTION = assistantMessage({
  id: "a_ref",
  parentID: "u1",
  parts: [textPart({ id: "p_ref", messageID: "a_ref", text: "the earlier call_old output" })],
});

const MACHINE_MENTION = assistantMessage({
  id: "a_ref",
  parentID: "u1",
  parts: [
    toolPart({
      id: "p_ref",
      messageID: "a_ref",
      callID: "call_ref",
      tool: "read",
      input: { filePath: "b.txt", fromCallID: "call_old" },
      output: "other",
    }),
  ],
});

test("prose mentions are counted as text references and block by default", () => {
  const result = transformMessages(duplicateReads([PROSE_MENTION]), resolveConfig({}, {}));
  assert.equal(result.changed, false);
  assert.equal(result.stats.skippedReasons.referenced_later_text, 1);
  assert.equal(result.stats.skippedReasons.referenced_later_strong, undefined);
});

test("structured references block as strong and are named separately", () => {
  const result = transformMessages(
    duplicateReads([MACHINE_MENTION]),
    resolveConfig({}, {}),
  );
  assert.equal(result.changed, false);
  assert.equal(result.stats.skippedReasons.referenced_later_strong, 1);
});

test("referenceProtection: strong lets a prose-only mention through", () => {
  const result = transformMessages(
    duplicateReads([PROSE_MENTION]),
    resolveConfig({ referenceProtection: "strong" }, {}),
  );
  assert.equal(result.changed, true);
  assert.equal(result.stats.prunedCount, 1);
  assert.equal(result.stats.skippedReasons.referenced_later_text, undefined);
});

test("referenceProtection: strong still blocks a structured reference", () => {
  const result = transformMessages(
    duplicateReads([MACHINE_MENTION]),
    resolveConfig({ referenceProtection: "strong" }, {}),
  );
  assert.equal(result.changed, false);
  assert.equal(result.stats.skippedReasons.referenced_later_strong, 1);
});

test("the adapter wires supersedeWrites.allowOrderFallback end to end", () => {
  const writePart = toolPart({
    id: "p_w",
    messageID: "a1",
    callID: "w1",
    tool: "write",
    input: { filePath: "src/a.ts", content: "export const value = 42;\n".repeat(80) },
    output: "File written successfully",
    // No `end`: the runtime omitted the completion timestamp.
    time: { start: 1 },
  });
  const readPart = toolPart({
    id: "p_r",
    messageID: "a2",
    callID: "r1",
    tool: "read",
    input: { filePath: "src/a.ts", offset: 1, limit: 2000 },
    output: "export const value = 42;\n".repeat(80),
    metadata: { truncated: false },
    time: { start: 5, end: 6 },
  });
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [writePart] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart] }),
  ];

  const strict = transformMessages(messages, resolveConfig({}, {}));
  assert.equal(strict.changed, false);
  assert.equal(strict.stats.supersedeWrites.missingWriteEndCount, 1);

  const relaxed = transformMessages(
    messages,
    resolveConfig({ supersedeWrites: { allowOrderFallback: true } }, {}),
  );
  assert.equal(relaxed.changed, true);
  assert.equal(relaxed.stats.supersedeWrites.orderFallbackCount, 1);
  assert.equal(relaxed.stats.supersedeWrites.decisionKinds.superseded_by_read, 1);
});
