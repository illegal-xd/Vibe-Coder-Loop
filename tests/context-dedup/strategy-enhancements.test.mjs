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
import {
  assistantMessage,
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
