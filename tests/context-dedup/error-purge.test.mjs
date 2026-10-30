import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ERROR_PLACEHOLDER,
  DEFAULT_STALE_INPUT_PLACEHOLDER,
  DUPLICATE_ERROR_PLACEHOLDER,
  planErrorPurge,
} from "../../.opencode/context-dedup/error-purge.js";

const LONG_ERROR =
  "AssertionError: expected response.status to equal 200\n" +
  "  at tests/integration/checkout.test.js:42:17\n".repeat(80);

function errorRecord({
  id,
  order,
  tool = "bash",
  args = { command: "npm test" },
  cwd = "/repo",
  root = "/repo",
  error = LONG_ERROR,
  userSegment = 1,
} = {}) {
  return {
    id,
    order,
    tool,
    args,
    env: { cwd, root },
    status: "error",
    output: "",
    error,
    metadata: {},
    userSegment,
  };
}

function successRecord({
  id,
  order,
  tool = "bash",
  args = { command: "npm test" },
  cwd = "/repo",
  root = "/repo",
  output = "ok",
  metadata = {},
  userSegment = 1,
} = {}) {
  return {
    id,
    order,
    tool,
    args,
    env: { cwd, root },
    status: "completed",
    output,
    error: "",
    metadata,
    userSegment,
  };
}

function reason(stats, key) {
  return stats.skippedReasons[key] ?? 0;
}

test("Case A: equivalent later success supersedes an earlier failure", () => {
  const { decisions, stats } = planErrorPurge([
    errorRecord({ id: "e1", order: 1 }),
    successRecord({ id: "s1", order: 3 }),
  ]);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].id, "e1");
  assert.equal(decisions[0].keeperId, "s1");
  assert.equal(decisions[0].kind, "superseded_by_success");
  assert.equal(decisions[0].confidence, "high");
  assert.equal(decisions[0].field, "error");
  assert.equal(decisions[0].replacement, DEFAULT_ERROR_PLACEHOLDER);
  assert.ok(decisions[0].estimatedTokensSaved > 0);
  assert.equal(stats.confirmedErrorCount, 1);
  assert.equal(stats.candidateCount, 1);
  assert.equal(stats.plannedPruneCount, 1);
  assert.equal(stats.preservedCount, 0);
  assert.deepEqual(stats.decisionKinds, { superseded_by_success: 1 });
});

test("Case C: equivalent build success supersedes a build failure", () => {
  const { decisions } = planErrorPurge([
    errorRecord({ id: "e1", order: 1, args: { command: "npm run build" } }),
    successRecord({ id: "s1", order: 3, args: { command: "npm run build" } }),
  ]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, "superseded_by_success");
});

test("Case B/C: different command or build target is not equivalent", () => {
  const differentCommand = planErrorPurge([
    errorRecord({ id: "e1", order: 1, args: { command: "npm test -- --run integration" } }),
    successRecord({ id: "s1", order: 3, args: { command: "npm test -- --run unit" } }),
  ]);
  assert.equal(differentCommand.decisions.length, 0);
  assert.equal(reason(differentCommand.stats, "later_success_args_changed"), 1);

  const buildVsDeploy = planErrorPurge([
    errorRecord({ id: "e1", order: 1, args: { command: "npm run build" } }),
    successRecord({ id: "s1", order: 3, args: { command: "npm run deploy" } }),
  ]);
  assert.equal(buildVsDeploy.decisions.length, 0);
});

test("different workspace is not equivalent", () => {
  const { decisions } = planErrorPurge([
    errorRecord({ id: "e1", order: 1, cwd: "/repo-one" }),
    successRecord({ id: "s1", order: 3, cwd: "/repo-two" }),
  ]);
  assert.equal(decisions.length, 0);
});

test("different user turns preserve the failure by default", () => {
  const records = [
    errorRecord({ id: "e1", order: 1, userSegment: 1 }),
    successRecord({ id: "s1", order: 3, userSegment: 2 }),
  ];
  const blocked = planErrorPurge(records);
  assert.equal(blocked.decisions.length, 0);
  assert.equal(reason(blocked.stats, "across_user_turn"), 1);

  const allowed = planErrorPurge(records, { preserveAcrossUserTurns: false });
  assert.equal(allowed.decisions.length, 1);
});

test("a state-changing tool between failure and success preserves the failure", () => {
  const records = [
    errorRecord({ id: "e1", order: 1 }),
    {
      id: "edit1",
      order: 2,
      tool: "edit",
      args: { filePath: "src/checkout.js" },
      env: { cwd: "/repo", root: "/repo" },
      status: "completed",
      output: "ok",
      error: "",
      metadata: {},
      userSegment: 1,
    },
    successRecord({ id: "s1", order: 3 }),
  ];
  const blocked = planErrorPurge(records);
  assert.equal(blocked.decisions.length, 0);
  assert.equal(reason(blocked.stats, "intervening_state_change"), 1);

  const allowed = planErrorPurge(records, { preserveOnStateChanges: false });
  assert.equal(allowed.decisions.length, 1);
});

test("a read-only tool between failure and success does not block", () => {
  const records = [
    errorRecord({ id: "e1", order: 1 }),
    {
      id: "r1",
      order: 2,
      tool: "read",
      args: { filePath: "src/checkout.js" },
      env: { cwd: "/repo", root: "/repo" },
      status: "completed",
      output: "source",
      error: "",
      metadata: {},
      userSegment: 1,
    },
    successRecord({ id: "s1", order: 3 }),
  ];
  const { decisions } = planErrorPurge(records);
  assert.equal(decisions.length, 1);
});

test("Case D: repeated identical failures keep the newest and prune older duplicates", () => {
  const { decisions, stats } = planErrorPurge([
    errorRecord({ id: "e1", order: 1 }),
    errorRecord({ id: "e2", order: 3 }),
  ]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].id, "e1");
  assert.equal(decisions[0].keeperId, "e2");
  assert.equal(decisions[0].kind, "duplicate_failure");
  assert.equal(decisions[0].confidence, "medium");
  assert.equal(decisions[0].replacement, DUPLICATE_ERROR_PLACEHOLDER);
  assert.equal(stats.preservedCount, 1);
  assert.equal(reason(stats, "latest_failure_retained"), 1);
});

test("different error outputs are never treated as duplicates", () => {
  const { decisions } = planErrorPurge([
    errorRecord({ id: "e1", order: 1, error: `${LONG_ERROR}first` }),
    errorRecord({ id: "e2", order: 3, error: `${LONG_ERROR}second` }),
  ]);
  assert.equal(decisions.length, 0);
});

test("pruneRepeatedFailures can be disabled independently", () => {
  const { decisions } = planErrorPurge(
    [errorRecord({ id: "e1", order: 1 }), errorRecord({ id: "e2", order: 3 })],
    { pruneRepeatedFailures: false },
  );
  assert.equal(decisions.length, 0);
});

test("ambiguous results are preserved and not counted as candidates", () => {
  const emptyError = planErrorPurge([
    errorRecord({ id: "e1", order: 1, error: "   " }),
    errorRecord({ id: "e2", order: 2, error: " " }),
  ]);
  assert.equal(emptyError.decisions.length, 0);
  assert.equal(emptyError.stats.confirmedErrorCount, 0);
  assert.equal(emptyError.stats.ambiguousResultCount, 2);

  const completedWithErrorField = planErrorPurge([
    {
      ...successRecord({ id: "s1", order: 1 }),
      error: "structured error on completed state",
    },
  ]);
  assert.equal(completedWithErrorField.stats.confirmedErrorCount, 0);
  assert.equal(completedWithErrorField.stats.ambiguousResultCount, 1);
});

test("cancelled or aborted error state is ambiguous and preserved", () => {
  const { decisions, stats } = planErrorPurge([
    {
      ...errorRecord({ id: "e1", order: 1 }),
      metadata: { aborted: true },
    },
    successRecord({ id: "s1", order: 3 }),
  ]);
  assert.equal(decisions.length, 0);
  assert.equal(stats.confirmedErrorCount, 0);
  assert.equal(stats.ambiguousResultCount, 1);
});

test("a completed result with diagnostic text is not classified as an error", () => {
  const { decisions, stats } = planErrorPurge([
    successRecord({
      id: "s1",
      order: 1,
      output: "Error: failed to connect; warning: retrying",
    }),
  ]);
  assert.equal(decisions.length, 0);
  assert.equal(stats.confirmedErrorCount, 0);
  assert.equal(stats.ambiguousResultCount, 0);
});

test("completed metadata that signals failure is ambiguous and cannot supersede", () => {
  const { decisions, stats } = planErrorPurge([
    errorRecord({ id: "e1", order: 1 }),
    successRecord({ id: "s1", order: 3, metadata: { exitCode: 1 } }),
  ]);
  assert.equal(decisions.length, 0);
  assert.equal(stats.ambiguousResultCount, 1);
  assert.equal(stats.confirmedErrorCount, 1);
});

test("completed shell output with unreliable exit is not a success", () => {
  const { decisions, stats } = planErrorPurge(
    [
      errorRecord({ id: "e1", order: 1 }),
      successRecord({ id: "s1", order: 3, metadata: { exit: 0 } }),
    ],
    { shellExitReliable: false },
  );
  assert.equal(decisions.length, 0);
  assert.equal(stats.confirmedErrorCount, 1);
  assert.equal(stats.unverifiedShellCount, 1);
});

test("failed shell output is not a successful superseder", () => {
  const { decisions, stats } = planErrorPurge(
    [
      errorRecord({ id: "e1", order: 1 }),
      successRecord({
        id: "s1",
        order: 3,
        output: "/bin/bash: rg: command not found\n",
        metadata: { exit: 0 },
      }),
    ],
    { shellExitReliable: true, shellFailureDetection: "ambiguous" },
  );
  assert.equal(decisions.length, 0);
  assert.equal(stats.shellFailureCount, 1);
  assert.equal(stats.unverifiedShellCount, 0);
});

test("shell failure detection can opt into confirmed errors", () => {
  const { decisions, stats } = planErrorPurge(
    [
      successRecord({
        id: "f1",
        order: 1,
        output: "ERROR  Build failed with errors.\n",
        metadata: { exit: 0 },
      }),
    ],
    { shellExitReliable: true, shellFailureDetection: "error" },
  );
  assert.equal(decisions.length, 0);
  assert.equal(stats.confirmedErrorCount, 1);
  assert.equal(stats.shellFailureCount, 1);
});

test("pending, running, and later failures do not supersede", () => {
  const running = planErrorPurge([
    errorRecord({ id: "e1", order: 1 }),
    {
      ...successRecord({ id: "s1", order: 3 }),
      status: "running",
    },
  ]);
  assert.equal(running.decisions.length, 0);

  const laterFailure = planErrorPurge([
    successRecord({ id: "s1", order: 1 }),
    errorRecord({ id: "e1", order: 3 }),
  ]);
  assert.equal(laterFailure.decisions.length, 0);
  assert.equal(laterFailure.stats.confirmedErrorCount, 1);
  assert.equal(laterFailure.stats.preservedCount, 1);
});

test("minSuccesses can require more than one later success", () => {
  const one = planErrorPurge([
    errorRecord({ id: "e1", order: 1 }),
    successRecord({ id: "s1", order: 3 }),
  ], { minSuccesses: 2 });
  assert.equal(one.decisions.length, 0);
  assert.equal(reason(one.stats, "insufficient_successes"), 1);

  const two = planErrorPurge([
    errorRecord({ id: "e1", order: 1 }),
    successRecord({ id: "s1", order: 3 }),
    successRecord({ id: "s2", order: 5 }),
  ], { minSuccesses: 2 });
  assert.equal(two.decisions.length, 1);
  assert.equal(two.decisions[0].keeperId, "s2");
});

test("short error text is preserved when the placeholder costs more", () => {
  const { decisions, stats } = planErrorPurge([
    errorRecord({ id: "e1", order: 1, error: "boom" }),
    successRecord({ id: "s1", order: 3 }),
  ]);
  assert.equal(decisions.length, 0);
  assert.equal(reason(stats, "no_token_benefit"), 1);
});

test("multiple obsolete errors are all pruned", () => {
  const { decisions } = planErrorPurge([
    errorRecord({ id: "e1", order: 1, args: { command: "npm test -- unit" } }),
    successRecord({ id: "s1", order: 2, args: { command: "npm test -- unit" } }),
    errorRecord({ id: "e2", order: 3, args: { command: "npm run build" } }),
    successRecord({ id: "s2", order: 4, args: { command: "npm run build" } }),
  ]);
  assert.deepEqual(decisions.map((decision) => decision.id), ["e1", "e2"]);
});

test("a mixture of obsolete and still-relevant failures preserves the relevant one", () => {
  const { decisions } = planErrorPurge([
    errorRecord({ id: "e1", order: 1, args: { command: "npm test -- unit" } }),
    successRecord({ id: "s1", order: 2, args: { command: "npm test -- unit" } }),
    errorRecord({ id: "e2", order: 3, args: { command: "npm test -- integration" } }),
  ]);
  assert.deepEqual(decisions.map((decision) => decision.id), ["e1"]);
});

test("missing environment and invalid arguments preserve the error", () => {
  const missingEnv = planErrorPurge([
    { ...errorRecord({ id: "e1", order: 1 }), env: null },
    successRecord({ id: "s1", order: 3 }),
  ]);
  assert.equal(missingEnv.decisions.length, 0);
  assert.equal(reason(missingEnv.stats, "missing_environment"), 1);

  const badArgs = planErrorPurge([
    { ...errorRecord({ id: "e1", order: 1 }), args: null },
    successRecord({ id: "s1", order: 3 }),
  ]);
  assert.equal(badArgs.decisions.length, 0);
  assert.equal(reason(badArgs.stats, "invalid_args"), 1);
});

test("already-pruned error text is idempotent", () => {
  const { decisions, stats } = planErrorPurge([
    errorRecord({ id: "e1", order: 1, error: DEFAULT_ERROR_PLACEHOLDER }),
    successRecord({ id: "s1", order: 3 }),
  ]);
  assert.equal(decisions.length, 0);
  assert.equal(reason(stats, "already_pruned"), 1);
});

test("disabled Error Purge is a no-op", () => {
  const { decisions, stats } = planErrorPurge(
    [errorRecord({ id: "e1", order: 1 }), successRecord({ id: "s1", order: 3 })],
    { enabled: false },
  );
  assert.equal(decisions.length, 0);
  assert.equal(stats.enabled, false);
  assert.equal(reason(stats, "disabled"), 2);
});

test("unrelated successful tools are not serialized into signatures", () => {
  let serialized = 0;
  const hugeArgs = {
    filePath: "src/a.ts",
    content: "x".repeat(10_000),
    toJSON() {
      serialized += 1;
      return { filePath: "src/a.ts", content: "x" };
    },
  };
  const { decisions } = planErrorPurge([
    successRecord({ id: "w1", order: 0, tool: "write", args: hugeArgs, output: "written" }),
    errorRecord({ id: "e1", order: 1 }),
    successRecord({ id: "s1", order: 2 }),
  ]);
  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["e1"],
  );
  assert.equal(serialized, 0);
});

test("an intervening retry of the same operation is not a state-change barrier", () => {
  const records = [
    errorRecord({ id: "e1", order: 1 }),
    successRecord({ id: "retry", order: 2 }), // same tool + args = same signature
    successRecord({ id: "s1", order: 3 }),
  ];
  const { decisions } = planErrorPurge(records);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].id, "e1");
  assert.equal(decisions[0].keeperId, "s1");
});

test("a superseded failure also redacts its bulky input, keeping paths", () => {
  const payload = "const generated = 1;\n".repeat(400);
  const args = { filePath: "/repo/src/generated.js", content: payload, mode: "overwrite" };
  const { decisions, stats } = planErrorPurge([
    errorRecord({ id: "e1", order: 1, tool: "write", args }),
    successRecord({ id: "s1", order: 3, tool: "write", args, output: "written" }),
  ]);

  assert.equal(decisions.length, 1);
  const decision = decisions[0];
  assert.equal(decision.replaceError, true);
  assert.equal(decision.expectedInput, args);
  assert.equal(decision.redactedInput.filePath, "/repo/src/generated.js");
  assert.equal(decision.redactedInput.mode, "overwrite");
  assert.notEqual(decision.redactedInput.content, payload);
  assert.equal(stats.inputRedactedCount, 1);
  // Savings cover both the error text and the redacted payload.
  assert.ok(decision.estimatedTokensSaved > 400);
});

test("a huge failed input is still pruned when the error text is short", () => {
  const payload = "line\n".repeat(2000);
  const args = { filePath: "/repo/src/a.ts", content: payload };
  const { decisions, stats } = planErrorPurge([
    errorRecord({ id: "e1", order: 1, tool: "write", args, error: "EPERM" }),
    successRecord({ id: "s1", order: 3, tool: "write", args, output: "written" }),
  ]);

  assert.equal(decisions.length, 1);
  // The message is already smaller than any placeholder, so it is preserved.
  assert.equal(decisions[0].replaceError, false);
  assert.equal(decisions[0].replacement, "EPERM");
  assert.ok(decisions[0].estimatedTokensSaved > 1000);
  assert.equal(reason(stats, "no_token_benefit"), 0);
});

test("redactInputPayload: false keeps the failed call's input untouched", () => {
  const payload = "x\n".repeat(2000);
  const args = { filePath: "/repo/src/a.ts", content: payload };
  const { decisions } = planErrorPurge(
    [
      errorRecord({ id: "e1", order: 1, tool: "write", args }),
      successRecord({ id: "s1", order: 3, tool: "write", args, output: "written" }),
    ],
    { redactInputPayload: false },
  );
  assert.equal(decisions.length, 1);
  assert.equal("redactedInput" in decisions[0], false);
});

test("stale input rule is opt-in, preserves the error text, and respects age", () => {
  const payload = "trace line\n".repeat(500);
  const args = { filePath: "/repo/a.ts", content: payload };
  const records = [
    errorRecord({ id: "e1", order: 1, tool: "write", args, userSegment: 1 }),
    successRecord({ id: "r1", order: 2, tool: "read", args: { filePath: "/repo/b.ts" }, userSegment: 2 }),
  ];

  const disabled = planErrorPurge(records);
  assert.equal(disabled.decisions.length, 0);
  assert.equal(reason(disabled.stats, "no_success_for_signature"), 1);

  const enabled = planErrorPurge(records, { staleInputAfterUserTurns: 1 });
  assert.equal(enabled.decisions.length, 1);
  assert.equal(enabled.decisions[0].kind, "stale_failure_input");
  assert.equal(enabled.decisions[0].confidence, "medium");
  assert.equal(enabled.decisions[0].replaceError, false);
  assert.equal(enabled.decisions[0].replacement, enabled.decisions[0].expectedValue);
  assert.equal(enabled.decisions[0].inputPlaceholder, DEFAULT_STALE_INPUT_PLACEHOLDER);
  assert.notEqual(DEFAULT_STALE_INPUT_PLACEHOLDER, DEFAULT_ERROR_PLACEHOLDER);
  assert.equal(enabled.stats.inputRedactedCount, 1);
  assert.deepEqual(enabled.stats.decisionKinds, { stale_failure_input: 1 });

  const tooRecent = planErrorPurge(
    [errorRecord({ id: "e1", order: 1, tool: "write", args, userSegment: 3 })],
    { staleInputAfterUserTurns: 1 },
  );
  // latest user segment is 3, so age 0 < 1: retained.
  assert.equal(tooRecent.decisions.length, 0);
});

test("stale input rule never fires on an already-redacted payload", () => {
  const args = {
    filePath: "/repo/a.ts",
    content: "[vibe-context-dedup] already redacted",
  };
  const records = [
    errorRecord({ id: "e1", order: 1, tool: "write", args, userSegment: 1 }),
    successRecord({ id: "r1", order: 2, tool: "read", args: { filePath: "/repo/b.ts" }, userSegment: 4 }),
  ];
  const { decisions } = planErrorPurge(records, { staleInputAfterUserTurns: 1 });
  assert.equal(decisions.length, 0);
});
