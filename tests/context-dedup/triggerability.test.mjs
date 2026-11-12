/**
 * Regression tests for the 2026-11-12 triggerability fixes.
 *
 * Each test pins one rule that used to be impossible to fire:
 *   1. text-detected shell failures must be prunable (candidate reads `output`);
 *   2. non-mutating tools / read-only shell chains must not block supersession;
 *   3. a read-only candidate's repair write must not block error supersession;
 *   4. a later read covering a larger line window subsumes the earlier one;
 *   5. missing timestamps surface as an actionable diagnostic;
 *   6. no `step-start` part falls back to the user-turn age measure;
 *   7. repeated targets are aggregated for follow-up optimization.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { planDeduplication } from "../../.opencode/context-dedup/core.js";
import { planErrorPurge } from "../../.opencode/context-dedup/error-purge.js";
import {
  isReadOnlyShellCommand,
  planSupersedeWrites,
} from "../../.opencode/context-dedup/supersede-writes.js";
import {
  extractToolRecords,
  transformMessages,
} from "../../.opencode/context-dedup/opencode.js";
import { resolveConfig } from "../../.opencode/context-dedup/config.js";

const ENV = { cwd: "/repo", root: "/repo" };
const LONG = "x".repeat(4000);

function rec(overrides = {}) {
  return {
    status: "completed",
    error: "",
    metadata: {},
    env: ENV,
    userSegment: 1,
    turn: 1,
    ...overrides,
  };
}

function readRec(overrides = {}) {
  return rec({ tool: "read", args: { filePath: "a.txt" }, output: LONG, ...overrides });
}

test("text-detected shell failure becomes a prunable candidate (mode: error)", () => {
  const { decisions, stats } = planErrorPurge(
    [
      rec({ id: "b1", order: 1, tool: "bash", args: { command: "npm test" }, output: `npm ERR! ${LONG}` }),
      rec({ id: "b2", order: 2, tool: "bash", args: { command: "npm test" }, output: "ok" }),
    ],
    { enabled: true, shellFailureDetection: "error" },
  );
  assert.equal(stats.confirmedErrorCount, 1);
  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["b1"],
  );
  assert.equal(decisions[0].field, "output");
});

test("non-file tools between write and read do not block supersession", () => {
  const write = rec({
    id: "w1",
    order: 1,
    tool: "write",
    args: { filePath: "a.js", content: LONG },
    output: "ok",
    time: { start: 10, end: 12 },
  });
  const todo = rec({
    id: "t1",
    order: 2,
    tool: "todowrite",
    args: { todos: [] },
    output: "ok",
    time: { start: 13, end: 14 },
  });
  const read = rec({
    id: "r1",
    order: 3,
    tool: "read",
    args: { filePath: "a.js" },
    output: "l1\nl2\n(End of file - total 2 lines)",
    metadata: { truncated: false },
    time: { start: 20, end: 22 },
  });
  const { decisions } = planSupersedeWrites([write, todo, read], { enabled: true });
  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["w1"],
  );
});

test("read-only shell chains do not block supersession", () => {
  const write = rec({
    id: "w1",
    order: 1,
    tool: "write",
    args: { filePath: "a.js", content: LONG },
    output: "ok",
    time: { start: 10, end: 12 },
  });
  const cat = rec({
    id: "x1",
    order: 2,
    tool: "bash",
    args: { command: "cd /repo && git status && cat a.js" },
    output: "ok",
    time: { start: 14, end: 16 },
  });
  const read = rec({
    id: "r1",
    order: 3,
    tool: "read",
    args: { filePath: "a.js" },
    output: "l1\nl2\n(End of file - total 2 lines)",
    metadata: { truncated: false },
    time: { start: 20, end: 22 },
  });
  assert.equal(isReadOnlyShellCommand("cd /repo && git status && cat a.js"), true);
  const { decisions } = planSupersedeWrites([write, cat, read], { enabled: true });
  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["w1"],
  );
});

test("shell commands that can write stay barriers", () => {
  assert.equal(isReadOnlyShellCommand("cat a.js > b.js"), false);
  assert.equal(isReadOnlyShellCommand("rm -rf build"), false);
  assert.equal(isReadOnlyShellCommand("npm run build"), false);
  assert.equal(isReadOnlyShellCommand("git commit -m x"), false);
  assert.equal(isReadOnlyShellCommand("ls 2>/dev/null"), true);

  const write = rec({
    id: "w1",
    order: 1,
    tool: "write",
    args: { filePath: "a.js", content: LONG },
    output: "ok",
    time: { start: 10, end: 12 },
  });
  const build = rec({
    id: "x1",
    order: 2,
    tool: "bash",
    args: { command: "npm run build" },
    output: "ok",
    time: { start: 14, end: 16 },
  });
  const read = rec({
    id: "r1",
    order: 3,
    tool: "read",
    args: { filePath: "a.js" },
    output: "l1\nl2\n(End of file - total 2 lines)",
    metadata: { truncated: false },
    time: { start: 20, end: 22 },
  });
  const { decisions } = planSupersedeWrites([write, build, read], { enabled: true });
  assert.equal(decisions.length, 0);
});

test("a read-only candidate's repair write does not block error supersession", () => {
  const { decisions } = planErrorPurge(
    [
      readRec({ id: "e1", order: 1, status: "error", error: `ENOENT ${LONG}` }),
      rec({ id: "w1", order: 2, tool: "write", args: { filePath: "a.txt", content: "hi" }, output: "ok" }),
      readRec({ id: "e2", order: 3, output: "hi" }),
    ],
    { enabled: true },
  );
  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["e1"],
  );
});

test("a later read covering a larger window subsumes the earlier one", () => {
  const { decisions, stats } = planDeduplication(
    [
      readRec({ id: "c1", order: 1, args: { filePath: "a.txt", offset: 1, limit: 20 }, output: numberedLines(1, 20) }),
      readRec({ id: "c2", order: 2, args: { filePath: "a.txt", offset: 1, limit: 40 }, output: numberedLines(1, 40) }),
    ],
    { enabled: true },
  );
  assert.deepEqual(
    decisions.map((decision) => decision.id),
    ["c1"],
  );
  assert.equal(decisions[0].kind, "read_window_subsumed");
  assert.equal(stats.readWindowCollapseCount, 1);
});

test("a narrower or mutating-interval window is preserved", () => {
  const narrower = planDeduplication(
    [
      readRec({ id: "c1", order: 1, args: { filePath: "a.txt", offset: 1, limit: 40 }, output: "A".repeat(4000) }),
      readRec({ id: "c2", order: 2, args: { filePath: "a.txt", offset: 1, limit: 20 }, output: "B".repeat(2000) }),
    ],
    { enabled: true },
  );
  assert.equal(narrower.decisions.length, 0);

  const mutated = planDeduplication(
    [
      readRec({ id: "c1", order: 1, args: { filePath: "a.txt", offset: 1, limit: 20 }, output: "A".repeat(2000) }),
      rec({ id: "w1", order: 2, tool: "write", args: { filePath: "a.txt", content: "x" }, output: "ok" }),
      readRec({ id: "c2", order: 3, args: { filePath: "a.txt", offset: 1, limit: 40 }, output: "B".repeat(4000) }),
    ],
    { enabled: true },
  );
  assert.equal(mutated.decisions.length, 0);
});

test("a window without EOF evidence does not participate", () => {
  const { decisions } = planDeduplication(
    [
      readRec({ id: "c1", order: 1, args: { filePath: "a.txt" }, output: `${LONG}\n(End of file - total 40 lines)` }),
      readRec({ id: "c2", order: 2, args: { filePath: "a.txt" }, output: LONG }),
    ],
    { enabled: true },
  );
  assert.equal(decisions.length, 0);
});

test("missing timestamps surface the order-fallback diagnostic", () => {
  const { stats } = planSupersedeWrites(
    [
      rec({ id: "w1", order: 1, tool: "write", args: { filePath: "a.js", content: LONG }, output: "ok", time: null }),
      rec({
        id: "r1",
        order: 2,
        tool: "read",
        args: { filePath: "a.js" },
        output: "l1\nl2\n(End of file - total 2 lines)",
        metadata: { truncated: false },
        time: null,
      }),
    ],
    { enabled: true },
  );
  assert.equal(stats.orderFallbackAvailableCount, 1);
});

test("no step-start part falls back to the user-turn age measure", () => {
  const messages = [
    {
      info: { id: "u1", role: "user", path: { cwd: "/repo" } },
      parts: [{ type: "text", text: "hi" }],
    },
    {
      info: { id: "a1", role: "assistant", path: { cwd: "/repo" } },
      parts: [
        {
          type: "tool",
          callID: "c1",
          tool: "read",
          state: { status: "completed", input: { filePath: "a.txt" }, output: "x" },
        },
      ],
    },
  ];
  const extraction = extractToolRecords(messages);
  assert.equal(extraction.turnFallback, true);
  assert.equal(extraction.records[0].turn, extraction.records[0].userSegment);
  assert.equal(extraction.records[0].turn, 1);
});

test("repeated targets are aggregated for follow-up optimization", () => {
  const { stats } = planDeduplication(
    [
      readRec({ id: "c1", order: 1, args: { filePath: "big.js", offset: 1, limit: 20 }, output: "a".repeat(2000) }),
      readRec({ id: "c2", order: 2, args: { filePath: "big.js", offset: 21, limit: 20 }, output: "b".repeat(2000) }),
      readRec({ id: "c3", order: 3, args: { filePath: "big.js", offset: 41, limit: 20 }, output: "c".repeat(2000) }),
    ],
    { enabled: true },
  );
  assert.equal(stats.repeatedTargets.length, 1);
  assert.equal(stats.repeatedTargets[0].target, "big.js");
  assert.equal(stats.repeatedTargets[0].count, 3);
});

function numberedLines(startLine, count) {
  return Array.from({ length: count }, (_, index) => {
    const n = startLine + index;
    return `${n}: line ${n} ${"x".repeat(40)}`;
  }).join("\n");
}

test("the rendered line numbers decide the effective window", () => {
  // `truncated: true` on OpenCode means "did not reach EOF" (a partial read),
  // which is exactly what window collapse handles. The rendered line numbers
  // prove how far the read actually got.
  const partial = planDeduplication(
    [
      readRec({ id: "c1", order: 1, args: { filePath: "a.txt", offset: 1, limit: 100 }, output: numberedLines(1, 100) }),
      readRec({
        id: "c2",
        order: 2,
        args: { filePath: "a.txt", offset: 1, limit: 500 },
        output: numberedLines(1, 500),
        metadata: { truncated: true },
      }),
    ],
    { enabled: true },
  );
  assert.deepEqual(partial.decisions.map((d) => d.id), ["c1"]);

  // A capped read only showed 3 lines: its window shrinks to 1-3, so it cannot
  // cover the earlier 1-100 window and nothing is pruned.
  const capped = planDeduplication(
    [
      readRec({ id: "c1", order: 1, args: { filePath: "a.txt", offset: 1, limit: 100 }, output: numberedLines(1, 100) }),
      readRec({
        id: "c2",
        order: 2,
        args: { filePath: "a.txt", offset: 1, limit: 500 },
        output: numberedLines(1, 3),
        metadata: { display: { truncated: true } },
      }),
    ],
    { enabled: true },
  );
  assert.equal(capped.decisions.length, 0);
});

test("collapseReadWindows:false disables the window rule", () => {
  const records = [
    readRec({ id: "c1", order: 1, args: { filePath: "a.txt", offset: 1, limit: 20 }, output: "A".repeat(2000) }),
    readRec({ id: "c2", order: 2, args: { filePath: "a.txt", offset: 1, limit: 40 }, output: "B".repeat(4000) }),
  ];
  const resolved = resolveConfig(
    { deduplication: { collapseReadWindows: false } },
    {},
  );
  assert.equal(resolved.deduplication.collapseReadWindows, false);
  const { decisions } = planDeduplication(records, resolved);
  assert.equal(decisions.length, 0);
});

test("shell chains that write are never treated as inspection-only", () => {
  const writers = [
    'find . -name "*.log" -delete',
    "find . -type d -exec rm -rf {} ;",
    "sort -o a.js a.js",
    "uniq a.js b.js",
    "git diff --output=patch.diff",
    "cat a.js $(rm -rf b)",
    "echo hi `rm x`",
    "cat a.js & rm -rf build",
    "git branch -D main",
    "git remote remove origin",
    "tree -o out.txt",
    "file -C -m magic",
  ];
  for (const command of writers) {
    assert.equal(isReadOnlyShellCommand(command), false, command);
  }
});

test("transform stats expose the window-collapse funnel and repeated targets", () => {
  const message = (id, readArgs) => ({
    info: { id, role: "assistant", path: { cwd: "/repo" } },
    parts: [
      {
        type: "tool",
        callID: `call_${id}`,
        tool: "read",
        state: {
          status: "completed",
          input: readArgs,
          output: "x".repeat(2000),
          metadata: {},
        },
      },
    ],
  });
  const result = transformMessages(
    [
      message("a1", { filePath: "big.js", offset: 1, limit: 20 }),
      message("a2", { filePath: "big.js", offset: 1, limit: 40 }),
    ],
    resolveConfig({}, {}),
  );
  assert.equal(result.stats.readWindowCollapseCount, 1);
  assert.equal(result.stats.readWindowCandidateCount, 2);
  assert.deepEqual(result.stats.repeatedTargets, []);
});

