/**
 * The token-usage card must display exactly the numbers the pipeline recorded.
 *
 * This runs the real exporter (scripts/token-usage/export_card_data.py) on a
 * synthetic JSONL record built from a real transform summary, then feeds the
 * generated snapshot to the card's own aggregate() implementation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import { transformMessages } from "../../.opencode/context-dedup/opencode.js";
import {
  buildUsageRecord,
  extractProviderUsage,
  summarizePruning,
} from "../../.opencode/context-dedup/token-usage.js";
import { assistantMessage, toolPart, userMessage } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXPORTER = path.join(ROOT, "scripts/token-usage/export_card_data.py");
const CARD = path.join(ROOT, "tools/token-usage-card/app.js");
const SESSION_ID = "ses_export_card";

const CONFIG = resolveConfig({}, {});

function hasPython() {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

function readPart({ callID, messageID, filePath, output, time, metadata = {} }) {
  return toolPart({
    id: `part_${callID}`,
    messageID,
    callID,
    tool: "read",
    input: { filePath, offset: 1, limit: 2000 },
    output,
    status: "completed",
    time,
    metadata,
  });
}

function buildSummary() {
  const repeated = "repeated read output line\n".repeat(20);
  const longContent = "export const value = 42;\n".repeat(120);
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({
      id: "a1",
      parentID: "u1",
      parts: [readPart({ callID: "r1", messageID: "a1", filePath: "a.txt", output: repeated, time: { start: 1, end: 2 } })],
    }),
    assistantMessage({
      id: "a2",
      parentID: "u1",
      parts: [readPart({ callID: "r2", messageID: "a2", filePath: "a.txt", output: repeated, time: { start: 3, end: 4 } })],
    }),
    assistantMessage({
      id: "a3",
      parentID: "u1",
      parts: [
        toolPart({
          id: "part_w1",
          messageID: "a3",
          callID: "w1",
          tool: "write",
          input: { filePath: "src/a.ts", content: longContent },
          output: "written",
          status: "completed",
          time: { start: 5, end: 6 },
          metadata: {},
        }),
      ],
    }),
    assistantMessage({
      id: "a4",
      parentID: "u1",
      parts: [
        readPart({
          callID: "r3",
          messageID: "a4",
          filePath: "src/a.ts",
          output: "1| export const value = 42;",
          time: { start: 7, end: 8 },
          metadata: { truncated: false },
        }),
      ],
    }),
  ];
  const result = transformMessages(messages, CONFIG);
  assert.equal(result.changed, true);
  return summarizePruning(result.stats);
}

function usageInfo() {
  return {
    id: "msg_export",
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: 1, completed: 2 },
    providerID: "provider",
    modelID: "model",
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 }, total: 120 },
  };
}

function loadCard(source) {
  const sandbox = { module: { exports: {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: CARD });
  assert.ok(sandbox.module.exports.aggregate, "card aggregate() must be exported");
  return sandbox.module.exports;
}

function loadSnapshot(source) {
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: "token-usage-data.js" });
  return sandbox.window.TOKEN_USAGE_DATA;
}

test("exported card data and the card aggregate match the internal stats", async (t) => {
  if (!hasPython()) {
    t.skip("python3 unavailable");
    return;
  }

  const summary = buildSummary();
  const timestamp = new Date().toISOString();
  const record = buildUsageRecord({
    timestamp,
    session_id: SESSION_ID,
    request_id: "msg_export",
    usage: extractProviderUsage(usageInfo()),
    pruning: summary,
  });

  const temp = await mkdtemp(path.join(os.tmpdir(), "vibe-card-"));
  try {
    await writeFile(path.join(temp, "token-usage-2026-10-29.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    const outFile = path.join(temp, "token-usage-data.js");
    const run = spawnSync("python3", [EXPORTER], {
      env: {
        ...process.env,
        VIBE_TOKEN_USAGE_HOME: temp,
        VIBE_TOKEN_USAGE_OUT_FILE: outFile,
      },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);

    const snapshot = loadSnapshot(await readFile(outFile, "utf8"));
    const card = loadCard(await readFile(CARD, "utf8"));
    const result = card.aggregate(snapshot, "today", new Date(Date.parse(timestamp) + 60_000));
    assert.equal(result.requests, 1);

    const byKey = new Map(result.strategies.map((strategy) => [strategy.key, strategy]));
    for (const key of ["deduplication", "error_purge", "supersede_writes"]) {
      const internal = summary[key];
      const displayed = byKey.get(key);
      assert.ok(displayed, key);
      assert.equal(displayed.scanned, internal.scanned_records, key);
      assert.equal(displayed.eligible, internal.eligible_items, key);
      assert.equal(displayed.candidates, internal.candidate_items, key);
      assert.equal(displayed.marked, internal.marked_items, key);
      assert.equal(displayed.removedItems, internal.changed_items, key);
      assert.equal(displayed.tokens, internal.removed_tokens.value ?? 0, key);
    }

    // The same numbers must survive the record round-trip.
    assert.equal(record.pruning.deduplication.marked_items, summary.deduplication.marked_items);
    assert.equal(record.pruning.supersede_writes.changed_items, summary.supersede_writes.changed_items);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("four-column snapshots still render (eligible/marked fall back)", async () => {
  // Older snapshots only carry four columns; the card must not invent values.
  const card = loadCard(await readFile(CARD, "utf8"));
  const legacy = {
    strategies: [{ key: "deduplication", label: "Deduplication" }],
    records: [[Date.now(), 100, 20, 0, 30, [[30, 10, 4, 2]]]],
  };
  const result = card.aggregate(legacy, "today", new Date(Date.now() + 1000));
  assert.equal(result.strategies[0].eligible, 4);
  assert.equal(result.strategies[0].marked, 2);
  assert.equal(result.strategies[0].removedItems, 2);
});

test("strategy rows sort by contribution without mutating the payload", async () => {
  const card = loadCard(await readFile(CARD, "utf8"));
  const input = [
    { key: "compact_read", tokens: 0, removedItems: 0 },
    { key: "tool_descriptions", tokens: 120, removedItems: 3 },
    { key: "line_range_edit", tokens: 0, removedItems: 2 },
    { key: "deduplication", tokens: 120, removedItems: 1 },
    { key: "error_purge", tokens: 300, removedItems: 1 },
  ];
  const sorted = card.sortStrategies(input);
  assert.deepEqual(
    sorted.map((strategy) => strategy.key),
    ["error_purge", "tool_descriptions", "deduplication", "line_range_edit", "compact_read"],
  );
  assert.deepEqual(
    input.map((strategy) => strategy.key),
    ["compact_read", "tool_descriptions", "line_range_edit", "deduplication", "error_purge"],
  );
});
