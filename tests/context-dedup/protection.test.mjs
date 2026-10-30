import test from "node:test";
import assert from "node:assert/strict";

import {
  matchesGlob,
  planDeduplication,
  protectedReason,
  recordFilePaths,
} from "../../.opencode/context-dedup/core.js";
import { planErrorPurge } from "../../.opencode/context-dedup/error-purge.js";
import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import { planSupersedeWrites } from "../../.opencode/context-dedup/supersede-writes.js";
import { toolRecord } from "./helpers.mjs";

const BASE_CONFIG = resolveConfig({ errorPurge: { shellExitReliable: true } }, {});
const LONG = "payload line that is long enough to matter\n".repeat(80);

function reason(stats, key) {
  return stats.skippedReasons[key] ?? 0;
}

test("matchesGlob supports **, * and ? without matching across separators", () => {
  assert.equal(matchesGlob("/repo/.env", "**/.env"), true);
  assert.equal(matchesGlob("/repo/src/a.ts", "**/*.ts"), true);
  assert.equal(matchesGlob("/repo/src/deep/a.ts", "**/src/**"), true);
  // A relative pattern alone does not match an absolute path; the protection
  // guard retries project-relative prefixes (covered below).
  assert.equal(matchesGlob("/repo/src/deep/a.ts", "src/**"), false);
  assert.equal(matchesGlob("src/a.ts", "src/*.ts"), true);
  assert.equal(matchesGlob("src/a.ts", "src/*.js"), false);
  assert.equal(matchesGlob("src/a.ts", "src/?.ts"), true);
  assert.equal(matchesGlob("src/a.ts", "*.ts"), false);
  assert.equal(matchesGlob("a.ts", "*.ts"), true);
  assert.equal(matchesGlob("a/b/c.ts", "*.ts"), false);
  assert.equal(matchesGlob("x", "[bad"), false);
});

test("recordFilePaths covers direct, multiedit, apply_patch and V2 nested calls", () => {
  assert.deepEqual(recordFilePaths({ tool: "read", args: { filePath: "a.ts" } }), ["a.ts"]);
  assert.deepEqual(recordFilePaths({ tool: "edit", args: { path: "b.ts" } }), ["b.ts"]);
  assert.deepEqual(
    recordFilePaths({
      tool: "multiedit",
      args: { filePath: "a.ts", edits: [{ filePath: "b.ts" }, { path: "c.ts" }] },
    }),
    ["a.ts", "b.ts", "c.ts"],
  );
  assert.deepEqual(
    recordFilePaths({
      tool: "apply_patch",
      args: {
        patchText:
          "*** Begin Patch\n*** Update File: src/x.ts\n@@\n*** Add File: src/y.ts\n+ok\n*** End Patch",
      },
    }),
    ["src/x.ts", "src/y.ts"],
  );
  assert.deepEqual(
    recordFilePaths({
      tool: "execute",
      args: {},
      metadata: { toolCalls: [{ tool: "read", input: { filePath: "n.ts" } }] },
    }),
    ["n.ts"],
  );
  assert.deepEqual(recordFilePaths({ tool: "grep", args: { pattern: "x" } }), []);
});

test("protectedReason matches tools exactly or by glob", () => {
  const record = { tool: "read", args: { filePath: "a.ts" }, env: { cwd: "/repo" } };
  assert.equal(protectedReason(record, { protectedTools: ["read"] }), "protected_tool");
  assert.equal(protectedReason(record, { protectedTools: ["re*"] }), "protected_tool");
  assert.equal(protectedReason(record, { protectedTools: ["grep"] }), "");
  assert.equal(protectedReason(record, {}), "");

  // V2 code mode: a protected nested tool protects the combined output.
  assert.equal(
    protectedReason(
      { tool: "execute", args: {}, metadata: { toolCalls: [{ tool: "bash", input: {} }] } },
      { protectedTools: ["bash"] },
    ),
    "protected_tool",
  );
});

test("protectedReason matches absolute, relative and project-relative paths", () => {
  assert.equal(
    protectedReason(
      { tool: "read", args: { filePath: "/repo/.env" }, env: { cwd: "/repo" } },
      { protectedFilePatterns: ["**/.env"] },
    ),
    "protected_path",
  );
  assert.equal(
    protectedReason(
      { tool: "read", args: { filePath: "src/a.ts" }, env: { cwd: "/repo" } },
      { protectedFilePatterns: ["src/**"] },
    ),
    "protected_path",
  );
  assert.equal(
    protectedReason(
      { tool: "read", args: { filePath: "/repo/src/a.ts" }, env: { cwd: "/repo" } },
      { protectedFilePatterns: ["src/**"] },
    ),
    "protected_path",
  );
  assert.equal(
    protectedReason(
      { tool: "read", args: { filePath: "/repo/src/a.ts" }, env: { cwd: "/repo" } },
      { protectedFilePatterns: ["**/*.env"] },
    ),
    "",
  );
});

test("deduplication skips protected tools and paths but prunes the rest", () => {
  const records = [
    toolRecord({ id: "a", order: 1, tool: "read", args: { filePath: "src/a.ts" }, output: LONG }),
    toolRecord({ id: "b", order: 2, tool: "read", args: { filePath: "src/a.ts" }, output: LONG }),
  ];
  const baseline = planDeduplication(records, { ...BASE_CONFIG });
  assert.equal(baseline.decisions.length, 1);

  const byPath = planDeduplication(records, {
    ...BASE_CONFIG,
    protectedFilePatterns: ["src/**"],
  });
  assert.equal(byPath.decisions.length, 0);
  assert.equal(reason(byPath.stats, "protected_path"), 2);

  const byTool = planDeduplication(records, { ...BASE_CONFIG, protectedTools: ["read"] });
  assert.equal(byTool.decisions.length, 0);
  assert.equal(reason(byTool.stats, "protected_tool"), 2);
});

test("error purge keeps protected errors even with a later success", () => {
  const records = [
    toolRecord({
      id: "e1",
      order: 1,
      tool: "bash",
      args: { command: "npm test" },
      status: "error",
      output: "",
      error: "Command failed\n".repeat(20),
    }),
    toolRecord({
      id: "s1",
      order: 2,
      tool: "bash",
      args: { command: "npm test" },
      status: "completed",
      output: "ok",
    }),
  ];
  const baseline = planErrorPurge(records, { ...BASE_CONFIG.errorPurge });
  assert.equal(baseline.decisions.length, 1);

  const byTool = planErrorPurge(records, {
    ...BASE_CONFIG.errorPurge,
    protectedTools: ["bash"],
  });
  assert.equal(byTool.decisions.length, 0);
  assert.equal(reason(byTool.stats, "protected_tool"), 1);
});

test("supersede writes never redacts a protected write", () => {
  const records = [
    toolRecord({
      id: "w1",
      order: 1,
      tool: "write",
      args: { filePath: "config/settings.json", content: LONG },
      output: "written",
      time: { start: 1, end: 2 },
    }),
    toolRecord({
      id: "r1",
      order: 2,
      tool: "read",
      args: { filePath: "config/settings.json" },
      output: LONG,
      time: { start: 3, end: 4 },
      metadata: { truncated: false },
    }),
  ];
  const baseline = planSupersedeWrites(records, { ...BASE_CONFIG.supersedeWrites });
  assert.equal(baseline.decisions.length, 1);

  const protectedPlan = planSupersedeWrites(records, {
    ...BASE_CONFIG.supersedeWrites,
    protectedFilePatterns: ["config/**"],
  });
  assert.equal(protectedPlan.decisions.length, 0);
  assert.equal(reason(protectedPlan.stats, "protected_path"), 1);
});

test("protection config defaults to empty and validates types", () => {
  const config = resolveConfig({}, {});
  assert.deepEqual(config.protectedTools, []);
  assert.deepEqual(config.protectedFilePatterns, []);

  const custom = resolveConfig(
    { protectedTools: ["write"], protectedFilePatterns: ["**/.env"] },
    {},
  );
  assert.deepEqual(custom.protectedTools, ["write"]);
  assert.deepEqual(custom.protectedFilePatterns, ["**/.env"]);

  assert.throws(() => resolveConfig({ protectedTools: "read" }, {}), /must be an array/);
  assert.throws(() => resolveConfig({ protectedTools: [""] }, {}), /non-empty strings/);
  assert.throws(
    () => resolveConfig({ protectedFilePatterns: [42] }, {}),
    /must contain non-empty strings/,
  );
});
