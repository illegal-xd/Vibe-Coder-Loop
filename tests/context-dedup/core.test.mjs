import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PLACEHOLDER,
  PRUNE_MARKER,
  buildOperationSignature,
  estimateTokens,
  isPrunedOutput,
  normalizePath,
  planDeduplication,
} from "../../.opencode/context-dedup/core.js";
import { toolRecord } from "./helpers.mjs";

const LONG_OUTPUT = "line of file content\n".repeat(100);

const CONFIG = {
  enabled: true,
  tools: ["read", "grep", "glob"],
  placeholder: DEFAULT_PLACEHOLDER,
  mutationTools: ["bash", "edit", "write", "patch", "multiedit", "apply_patch", "task", "skill", "webfetch"],
  barrierOnNonWhitelistedTools: true,
};

function reasons(stats) {
  return stats.skippedReasons ?? {};
}

test("prunes the older identical successful read and keeps the newest", () => {
  const records = [
    toolRecord({ id: "call_old", order: 1, output: LONG_OUTPUT }),
    toolRecord({ id: "call_new", order: 3, output: LONG_OUTPUT }),
  ];
  const { decisions, stats } = planDeduplication(records, CONFIG);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].id, "call_old");
  assert.equal(decisions[0].keeperId, "call_new");
  assert.equal(stats.candidateCount, 2);
  assert.equal(stats.duplicateGroupCount, 1);
  assert.equal(stats.plannedPruneCount, 1);
  assert.ok(stats.tokenSavingsEstimated > 0);
  assert.equal(stats.actualTokenSavings, null);
  assert.equal(stats.tokenCounting, "estimate_heuristic_v1");
});

test("does not match different arguments or different tools", () => {
  const differentArgs = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, args: { filePath: "a.txt" } }),
      toolRecord({ id: "b", order: 3, args: { filePath: "b.txt" } }),
    ],
    CONFIG,
  );
  assert.equal(differentArgs.decisions.length, 0);
  assert.equal(differentArgs.stats.duplicateGroupCount, 0);

  const differentTools = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, tool: "read" }),
      toolRecord({ id: "b", order: 3, tool: "grep", args: { pattern: "x" } }),
    ],
    CONFIG,
  );
  assert.equal(differentTools.decisions.length, 0);
});

test("does not match the same arguments in a different execution environment", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, cwd: "/repo-one" }),
      toolRecord({ id: "b", order: 3, cwd: "/repo-two" }),
    ],
    CONFIG,
  );
  assert.equal(decisions.length, 0);
  assert.equal(stats.duplicateGroupCount, 0);
});

test("normalizes relative and absolute paths within the same cwd", () => {
  const { decisions } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, args: { filePath: "src/a.js" }, cwd: "/repo", output: LONG_OUTPUT }),
      toolRecord({ id: "b", order: 3, args: { filePath: "/repo/src/../src/a.js" }, cwd: "/repo", output: LONG_OUTPUT }),
    ],
    CONFIG,
  );
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].id, "a");
});

test("skips failed calls by default", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, status: "error", output: "same" }),
      toolRecord({ id: "b", order: 3, status: "completed", output: "same" }),
    ],
    CONFIG,
  );
  assert.equal(decisions.length, 0);
  assert.equal(reasons(stats).not_completed, 1);
});

test("skips tools with side effects even when their output looks identical", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, tool: "write", output: "ok" }),
      toolRecord({ id: "b", order: 3, tool: "write", output: "ok" }),
    ],
    CONFIG,
  );
  assert.equal(decisions.length, 0);
  assert.equal(reasons(stats).unsupported_tool, 2);
});

test("mutation tools remain a hard denylist even if added to the whitelist", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, tool: "write", output: LONG_OUTPUT }),
      toolRecord({ id: "b", order: 3, tool: "write", output: LONG_OUTPUT }),
    ],
    { ...CONFIG, tools: ["read", "write"] },
  );
  assert.equal(decisions.length, 0);
  assert.equal(reasons(stats).unsupported_tool, 2);
});

test("does not prune when same arguments produced different outputs", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, output: "version one" }),
      toolRecord({ id: "b", order: 3, output: "version two" }),
    ],
    CONFIG,
  );
  assert.equal(decisions.length, 0);
  assert.equal(stats.sameSignatureDifferentOutputGroups, 1);
  assert.equal(stats.plannedPruneCount, 0);
});

test("short outputs are left alone when the placeholder would cost more tokens", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, output: "short" }),
      toolRecord({ id: "b", order: 3, output: "short" }),
    ],
    CONFIG,
  );
  assert.equal(decisions.length, 0);
  assert.equal(reasons(stats).no_token_benefit, 1);
});

test("any non-whitelisted tool between observations is a dependency barrier", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, output: LONG_OUTPUT }),
      toolRecord({ id: "todo", order: 2, tool: "todowrite", args: {}, output: "ok" }),
      toolRecord({ id: "b", order: 3, output: LONG_OUTPUT }),
    ],
    CONFIG,
  );
  assert.equal(decisions.length, 0);
  assert.equal(reasons(stats).intervening_side_effect, 1);
});

test("a non-read-only tool between observations is a dependency barrier", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, output: "same" }),
      toolRecord({ id: "edit", order: 2, tool: "edit", args: { filePath: "a.txt" }, output: "ok" }),
      toolRecord({ id: "b", order: 3, output: "same" }),
    ],
    CONFIG,
  );
  assert.equal(decisions.length, 0);
  assert.equal(reasons(stats).intervening_side_effect, 1);
});

test("prunes a chain down to the newest identical output", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, output: LONG_OUTPUT }),
      toolRecord({ id: "b", order: 3, output: LONG_OUTPUT }),
      toolRecord({ id: "c", order: 5, output: LONG_OUTPUT }),
    ],
    CONFIG,
  );
  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["a", "b"],
  );
  assert.equal(decisions[1].keeperId, "c");
  assert.equal(stats.plannedPruneCount, 2);
});

test("is idempotent once older outputs are placeholders", () => {
  const records = [
    toolRecord({ id: "a", order: 1, output: DEFAULT_PLACEHOLDER }),
    toolRecord({ id: "b", order: 3, output: LONG_OUTPUT }),
    toolRecord({ id: "c", order: 5, output: LONG_OUTPUT }),
  ];
  const { decisions, stats } = planDeduplication(records, CONFIG);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].id, "b");
  assert.equal(reasons(stats).already_pruned, 1);

  const second = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, output: DEFAULT_PLACEHOLDER }),
      toolRecord({ id: "b", order: 3, output: DEFAULT_PLACEHOLDER }),
      toolRecord({ id: "c", order: 5, output: "same" }),
    ],
    CONFIG,
  );
  assert.equal(second.decisions.length, 0);
});

test("handles empty, malformed, and incomplete records without throwing", () => {
  assert.doesNotThrow(() => planDeduplication([]));
  assert.doesNotThrow(() => planDeduplication(null));
  assert.doesNotThrow(() =>
    planDeduplication([
      null,
      {},
      { id: "", order: 1, tool: "read", args: {}, env: { cwd: "/repo" }, status: "completed", output: "x" },
      { id: "x", order: 2, tool: "read", args: null, env: { cwd: "/repo" }, status: "completed", output: "x" },
      { id: "y", order: 3, tool: "read", args: {}, env: null, status: "completed", output: "x" },
      { id: "z", order: 4, tool: "read", args: {}, env: { cwd: "/repo" }, status: "completed", output: "x" },
    ], CONFIG),
  );

  const empty = planDeduplication([]);
  assert.equal(empty.decisions.length, 0);
  assert.equal(empty.stats.recordsTotal, 0);

  const malformed = planDeduplication(null);
  assert.equal(malformed.decisions.length, 0);
  assert.equal(reasons(malformed.stats).invalid_input, 1);
});

test("canonicalization is key-order independent and does not pollute prototypes", () => {
  const argsA = JSON.parse('{"b":1,"a":2,"__proto__":{"polluted":true}}');
  const argsB = JSON.parse('{"a":2,"b":1,"__proto__":{"polluted":true}}');
  const { decisions } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1, args: argsA, output: LONG_OUTPUT }),
      toolRecord({ id: "b", order: 3, args: argsB, output: LONG_OUTPUT }),
    ],
    CONFIG,
  );
  assert.equal(decisions.length, 1);
  assert.equal({}.polluted, undefined);
});

test("bash description is not part of the operation signature", () => {
  const env = { cwd: "/repo", root: "/repo" };
  const first = buildOperationSignature({
    tool: "bash",
    args: { command: "npm run build", description: "Run build" },
    env,
  });
  const retry = buildOperationSignature({
    tool: "bash",
    args: { command: "npm run build", description: "Re-run build after fix" },
    env,
  });
  const differentCommand = buildOperationSignature({
    tool: "bash",
    args: { command: "npm run deploy", description: "Run build" },
    env,
  });
  assert.equal(first, retry);
  assert.notEqual(first, differentCommand);
});

test("does not process duplicate call ids", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "same-id", order: 1, output: "same" }),
      toolRecord({ id: "same-id", order: 2, output: "same" }),
      toolRecord({ id: "new", order: 3, tool: "grep", args: { pattern: "x" }, output: "same" }),
    ],
    CONFIG,
  );
  assert.equal(decisions.length, 0);
  assert.equal(reasons(stats).duplicate_call_id, 1);
});

test("disabled config is a no-op", () => {
  const { decisions, stats } = planDeduplication(
    [
      toolRecord({ id: "a", order: 1 }),
      toolRecord({ id: "b", order: 3 }),
    ],
    { ...CONFIG, enabled: false },
  );
  assert.equal(decisions.length, 0);
  assert.equal(stats.enabled, false);
  assert.equal(reasons(stats).disabled, 2);
});

test("token estimate and placeholder helpers are explicit", () => {
  assert.equal(isPrunedOutput(DEFAULT_PLACEHOLDER), true);
  assert.equal(isPrunedOutput("normal"), false);
  assert.ok(DEFAULT_PLACEHOLDER.startsWith(PRUNE_MARKER));
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("abcd") >= 1);
  assert.ok(estimateTokens("中文") >= 2);
});

test("normalizePath is lexical and preserves relative paths without a base", () => {
  assert.equal(normalizePath("src/../a.txt", "/repo"), "/repo/a.txt");
  assert.equal(normalizePath("../a.txt", null), "../a.txt");
});
