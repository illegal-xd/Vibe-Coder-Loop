import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import { appendStats } from "../../.opencode/context-dedup/log.js";

test("logs aggregate stats only and never tool output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-context-dedup-log-"));
  try {
    const logPath = path.join(directory, "events.jsonl");
    const config = resolveConfig(
      { log: { path: logPath, onlyWhenActive: false, maxBytes: 1024 * 1024 } },
      {},
    );

    await appendStats(
      { directory, config, configError: "invalid_config" },
      {
        enabled: true,
        preview: false,
        changed: true,
        recordsTotal: 4,
        candidateCount: 2,
        duplicateGroupCount: 1,
        sameSignatureDifferentOutputGroups: 0,
        plannedPruneCount: 1,
        wouldPruneCount: 1,
        prunedCount: 1,
        skippedReasons: { unsupported_tool: 2, not_completed: 0 },
        durationMs: 1.25,
        tokenSavingsEstimated: 42,
        tokenSavingsEstimatedIfApplied: 42,
        tokenCounting: "estimate_heuristic_v1",
        actualTokenSavings: null,
        outputBytesRemovedActual: 100,
        // Deliberately sensitive-looking fields must be ignored.
        output: "SECRET FILE CONTENT",
        input: { secret: "SECRET ARGUMENT" },
        errorPurge: {
          enabled: true,
          preview: false,
          changed: true,
          recordsTotal: 2,
          confirmedErrorCount: 1,
          ambiguousResultCount: 0,
          candidateCount: 1,
          plannedPruneCount: 1,
          wouldPruneCount: 1,
          prunedCount: 1,
          preservedCount: 0,
          highConfidencePruneCount: 1,
          mediumConfidencePruneCount: 0,
          inputRedactedCount: 1,
          skippedReasons: { across_user_turn: 0, intervening_state_change: 1 },
          durationMs: 1.5,
          tokenSavingsEstimated: 30,
          tokenSavingsEstimatedIfApplied: 30,
          tokenCounting: "estimate_heuristic_v1",
          actualTokenSavings: null,
          outputBytesRemovedActual: 90,
          errorText: "SECRET ERROR OUTPUT",
          output: "SECRET ERROR OUTPUT",
        },
      },
    );

    const text = await readFile(logPath, "utf8");
    assert.ok(text.endsWith("\n"));
    assert.equal(text.includes("SECRET"), false);
    assert.equal(text.includes("SECRET FILE CONTENT"), false);

    const record = JSON.parse(text.trim());
    assert.equal(record.plugin, "vibe-context-dedup");
    assert.equal(record.event, "transform");
    assert.equal(record.candidateCount, 2);
    assert.equal(record.prunedCount, 1);
    assert.equal(record.skippedReasons.unsupported_tool, 2);
    assert.equal(record.skippedReasons.not_completed, undefined);
    assert.equal(record.tokenCounting, "estimate_heuristic_v1");
    assert.equal(record.actualTokenSavings, null);
    assert.equal(record.configError, "invalid_config");
    assert.equal(record.output, undefined);
    assert.equal(record.input, undefined);
    assert.equal(record.errorPurge.confirmedErrorCount, 1);
    assert.equal(record.errorPurge.prunedCount, 1);
    assert.equal(record.errorPurge.inputRedactedCount, 1);
    assert.equal(record.errorPurge.skippedReasons.intervening_state_change, 1);
    assert.equal(record.errorPurge.skippedReasons.across_user_turn, undefined);
    assert.equal(record.errorPurge.tokenCounting, "estimate_heuristic_v1");
    assert.equal(record.errorPurge.actualTokenSavings, null);
    assert.equal(record.errorPurge.errorText, undefined);
    assert.equal(record.errorPurge.output, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotation uses numbered archives and keeps logging when .1 already exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-context-dedup-rotate-"));
  try {
    const logPath = path.join(directory, "events.jsonl");
    const archive = `${logPath}.1`;
    await writeFile(archive, "user-owned-archive\n", "utf8");

    const config = resolveConfig(
      { log: { path: logPath, onlyWhenActive: false, maxBytes: 80 } },
      {},
    );
    const stats = { enabled: true, changed: true, candidateCount: 1 };

    await appendStats({ directory, config }, stats);
    await appendStats({ directory, config }, stats);

    // The existing archive is never overwritten.
    assert.equal(await readFile(archive, "utf8"), "user-owned-archive\n");
    // The next free slot is used instead of silently disabling logging.
    const secondArchive = await readFile(`${logPath}.2`, "utf8");
    assert.equal(secondArchive.trim().split("\n").length, 1);
    // And the active file still receives the newest record.
    const active = await readFile(logPath, "utf8");
    assert.equal(active.trim().split("\n").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
