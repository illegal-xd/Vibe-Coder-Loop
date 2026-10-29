/**
 * Pruning funnel: scanned -> eligible -> candidate -> marked -> changed.
 *
 * These tests pin the difference between "eligible record", "really prunable
 * candidate", "decision marked for application", and "request content actually
 * changed". Counting a candidate as a removal was the reporting bug behind the
 * "candidates but zero contribution" dashboard.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import {
  PRUNE_MARKER,
  planDeduplication,
} from "../../.opencode/context-dedup/core.js";
import { planErrorPurge } from "../../.opencode/context-dedup/error-purge.js";
import { planSupersedeWrites } from "../../.opencode/context-dedup/supersede-writes.js";
import {
  applyDecisions,
  extractToolRecords,
  transformMessages,
} from "../../.opencode/context-dedup/opencode.js";
import { summarizePruning } from "../../.opencode/context-dedup/token-usage.js";
import {
  assistantMessage,
  toolPart,
  toolRecord,
  userMessage,
} from "./helpers.mjs";

const CONFIG = resolveConfig({}, {});

function readRecord(overrides = {}) {
  return toolRecord({
    id: "r1",
    order: 1,
    tool: "read",
    args: { filePath: "a.txt" },
    output: REPEATED,
    time: { start: 1, end: 2 },
    ...overrides,
  });
}

function editRecord(order) {
  return toolRecord({
    id: `e${order}`,
    order,
    tool: "edit",
    args: { filePath: "other.txt" },
    output: "ok",
    time: { start: order, end: order + 1 },
  });
}

const REPEATED = "line of repeated read output\n".repeat(20);

function readPart({ callID = "r1", messageID = "a1", output = REPEATED, tool = "read", args = { filePath: "a.txt" }, time = { start: 1, end: 2 } } = {}) {
  return toolPart({
    id: `part_${callID}`,
    messageID,
    callID,
    tool,
    input: args,
    output,
    status: "completed",
    time,
    metadata: {},
  });
}

// --- dedup classification -------------------------------------------------

test("dedup: duplicate candidates blocked by a side effect are not removals", () => {
  const plan = planDeduplication([
    readRecord({ id: "r1", order: 1 }),
    editRecord(2),
    readRecord({ id: "r2", order: 3 }),
  ]);

  assert.equal(plan.decisions.length, 0);
  assert.equal(plan.stats.eligibleCount, 2);
  assert.equal(plan.stats.duplicateCandidateCount, 2);
  assert.equal(plan.stats.markedCount, 0);
  assert.equal(plan.stats.skippedReasons.intervening_side_effect, 1);

  const summary = summarizePruning({
    deduplicationEnabled: true,
    recordsTotal: plan.stats.recordsTotal,
    candidateCount: plan.stats.candidateCount,
    eligibleCount: plan.stats.eligibleCount,
    duplicateCandidateCount: plan.stats.duplicateCandidateCount,
    markedCount: plan.stats.markedCount,
    prunedCount: 0,
    tokenSavingsEstimated: 0,
    skippedReasons: plan.stats.skippedReasons,
  });
  assert.equal(summary.deduplication.eligible_items, 2);
  assert.equal(summary.deduplication.candidate_items, 2);
  assert.equal(summary.deduplication.marked_items, 0);
  assert.equal(summary.deduplication.changed_items, 0);
  assert.equal(summary.deduplication.removed_items, 0);
  assert.equal(summary.deduplication.skipped.candidate.intervening_side_effect, 1);
  assert.equal(summary.deduplication.removed_tokens.value, 0);
});

test("dedup: unique signatures are reported as the reason nothing is prunable", () => {
  const plan = planDeduplication([
    readRecord({ id: "r1", order: 1, args: { filePath: "a.txt" } }),
    readRecord({ id: "r2", order: 2, args: { filePath: "b.txt" } }),
  ]);

  assert.equal(plan.stats.eligibleCount, 2);
  assert.equal(plan.stats.duplicateCandidateCount, 0);
  assert.equal(plan.stats.uniqueSignatureCount, 2);
  assert.equal(plan.stats.skippedReasons.unique_signature, 2);
  assert.equal(plan.stats.markedCount, 0);
});

test("dedup: repeated reads of the same file with different windows are named precisely", () => {
  const plan = planDeduplication([
    toolRecord({
      id: "r1",
      order: 1,
      tool: "read",
      args: { filePath: "a.txt", offset: 1, limit: 50 },
    }),
    toolRecord({
      id: "r2",
      order: 2,
      tool: "read",
      args: { filePath: "a.txt", offset: 51, limit: 50 },
    }),
    toolRecord({ id: "r3", order: 3, tool: "read", args: { filePath: "b.txt" } }),
  ]);

  assert.equal(plan.decisions.length, 0);
  // Same tool + same path, different canonical args: the runtime-stamped
  // read window changed, so byte equality can never hold.
  assert.equal(plan.stats.skippedReasons.same_target_args_changed, 2);
  assert.equal(plan.stats.skippedReasons.unique_signature, 1);
});

test("dedup: same signature with different output is reported, never pruned", () => {
  const plan = planDeduplication([
    readRecord({ id: "r1", order: 1, output: "v1" }),
    readRecord({ id: "r2", order: 2, output: "v2" }),
  ]);

  assert.equal(plan.stats.eligibleCount, 2);
  assert.equal(plan.stats.duplicateCandidateCount, 0);
  assert.equal(plan.stats.sameSignatureDifferentOutputCount, 2);
  assert.equal(plan.stats.skippedReasons.same_signature_different_output, 2);
  assert.equal(plan.stats.markedCount, 0);
});

test("dedup: a real prune changes the request content and reports both marked and changed", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [readPart({ callID: "r1", messageID: "a1" })] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart({ callID: "r2", messageID: "a2" })] }),
  ];
  const result = transformMessages(messages, { ...CONFIG, measureContext: true });
  const summary = summarizePruning(result.stats);

  assert.equal(result.changed, true);
  assert.equal(summary.deduplication.eligible_items, 2);
  assert.equal(summary.deduplication.candidate_items, 2);
  assert.equal(summary.deduplication.marked_items, 1);
  assert.equal(summary.deduplication.changed_items, 1);
  assert.equal(summary.deduplication.removed_items, 1);
  assert.ok(summary.deduplication.removed_tokens.value > 0);
  // The older output really became the placeholder, the newer one is kept.
  assert.ok(result.messages[1].parts[0].state.output.startsWith(PRUNE_MARKER));
  assert.equal(result.messages[2].parts[0].state.output, REPEATED);
  assert.ok(result.contextUnits.after < result.contextUnits.before);
});

test("preview marks decisions but changes nothing (marked > 0, changed = 0)", () => {
  const messages = [
    userMessage({ id: "u1" }),
    assistantMessage({ id: "a1", parentID: "u1", parts: [readPart({ callID: "r1", messageID: "a1" })] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart({ callID: "r2", messageID: "a2" })] }),
  ];
  const result = transformMessages(messages, { ...CONFIG, preview: true });
  const summary = summarizePruning(result.stats);

  assert.equal(result.changed, false);
  assert.equal(summary.deduplication.marked_items, 1);
  assert.equal(summary.deduplication.changed_items, 0);
  assert.equal(summary.deduplication.removed_tokens.value, 0);
  assert.equal(result.messages[1].parts[0].state.output, REPEATED);
});

test("a marked decision dropped at apply time is not counted as changed", () => {
  const messages = [
    assistantMessage({ id: "a1", parentID: "u1", parts: [readPart({ callID: "r1", messageID: "a1" })] }),
  ];
  const { locations } = extractToolRecords(messages);
  const decision = {
    id: "r1",
    field: "output",
    expectedValue: "stale value",
    replacement: `${PRUNE_MARKER} placeholder`,
    estimatedTokensSaved: 100,
  };
  const application = applyDecisions(messages, [decision], locations, decision.replacement);

  assert.equal(application.changed, false);
  assert.equal(application.applied.length, 0);
  assert.deepEqual(application.dropped, [{ id: "r1", reason: "state_mismatch" }]);
});

test("no token benefit is reported instead of inflating the removal count", () => {
  const tiny = "x";
  const plan = planDeduplication([
    readRecord({ id: "r1", order: 1, output: tiny }),
    readRecord({ id: "r2", order: 2, output: tiny }),
  ]);

  assert.equal(plan.stats.duplicateCandidateCount, 2);
  assert.equal(plan.stats.markedCount, 0);
  assert.equal(plan.stats.skippedReasons.no_token_benefit, 1);
  assert.equal(plan.stats.tokenSavingsEstimated, 0);
});

// --- error purge reasons --------------------------------------------------

function errorRecord(overrides = {}) {
  return toolRecord({
    id: "e1",
    order: 1,
    tool: "bash",
    args: { command: "npm test" },
    status: "error",
    output: "",
    error: "command failed with a long diagnostic: " + "detail ".repeat(30),
    time: { start: 1, end: 2 },
    ...overrides,
  });
}

test("error purge: no later equivalent success is named precisely", () => {
  const noSuccess = planErrorPurge([errorRecord({ id: "e1", order: 1 })]);
  assert.equal(noSuccess.stats.eligibleCount, 1);
  assert.equal(noSuccess.stats.potentialSupersedeCount, 0);
  assert.equal(noSuccess.stats.skippedReasons.no_success_for_signature, 1);

  const onlyBefore = planErrorPurge([
    toolRecord({ id: "s1", order: 1, tool: "bash", args: { command: "npm test" }, output: "ok", time: { start: 1, end: 2 } }),
    errorRecord({ id: "e1", order: 2 }),
  ]);
  assert.equal(onlyBefore.stats.skippedReasons.success_only_before_error, 1);
});

test("error purge: a later equivalent failure-only pair keeps the duplicate rule", () => {
  const plan = planErrorPurge([
    errorRecord({ id: "e1", order: 1 }),
    errorRecord({ id: "e2", order: 3 }),
  ]);
  assert.equal(plan.stats.potentialSupersedeCount, 0);
  // Rule 2 can prune without any later success; the funnel must still hold.
  assert.equal(plan.stats.prunableCount, 2);
  assert.equal(plan.stats.markedCount, 1);
  assert.equal(plan.stats.skippedReasons.latest_failure_retained, 1);
  assert.ok(plan.stats.prunableCount >= plan.stats.markedCount);
});

// --- multi-strategy attribution ------------------------------------------

test("dedup and supersede act on disjoint records and are summed once", () => {
  const repeatedRead = REPEATED;
  const longContent = "export const value = 42;\n".repeat(120);
  const messages = [
    userMessage({ id: "u1" }),
    // Adjacent identical reads: a clean dedup pair (no barrier between).
    assistantMessage({ id: "a1", parentID: "u1", parts: [readPart({ callID: "r1", messageID: "a1", output: repeatedRead })] }),
    assistantMessage({ id: "a2", parentID: "u1", parts: [readPart({ callID: "r2", messageID: "a2", output: repeatedRead })] }),
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
        toolPart({
          id: "part_r3",
          messageID: "a4",
          callID: "r3",
          tool: "read",
          input: { filePath: "src/a.ts", offset: 1, limit: 2000 },
          output: "1| export const value = 42;",
          status: "completed",
          time: { start: 7, end: 8 },
          metadata: { truncated: false },
        }),
      ],
    }),
  ];

  const result = transformMessages(messages, { ...CONFIG, measureContext: true });
  const summary = summarizePruning(result.stats);
  const dedupIds = new Set(result.decisions.map((decision) => decision.id));
  const supersedeIds = new Set(result.supersedeWritesDecisions.map((decision) => decision.id));

  assert.equal(result.decisions.length, 1);
  assert.equal(result.supersedeWritesDecisions.length, 1);
  for (const id of dedupIds) assert.equal(supersedeIds.has(id), false);
  assert.equal(summary.deduplication.changed_items, 1);
  assert.equal(summary.supersede_writes.changed_items, 1);
  assert.equal(
    summary.total_removed_tokens.value,
    summary.deduplication.removed_tokens.value + summary.supersede_writes.removed_tokens.value,
  );
});

test("sequential application cannot modify the same record twice", () => {
  const messages = [
    assistantMessage({ id: "a1", parentID: "u1", parts: [readPart({ callID: "r1", messageID: "a1" })] }),
  ];
  const { locations } = extractToolRecords(messages);
  const firstReplacement = `${PRUNE_MARKER} first`;
  const second = {
    id: "r1",
    field: "output",
    expectedValue: REPEATED,
    replacement: `${PRUNE_MARKER} second`,
    estimatedTokensSaved: 50,
  };

  const first = applyDecisions(
    messages,
    [{ id: "r1", expectedValue: REPEATED, replacement: firstReplacement, estimatedTokensSaved: 50 }],
    locations,
    firstReplacement,
  );
  assert.equal(first.changed, true);

  const secondApply = applyDecisions(first.messages, [second], locations, second.replacement);
  assert.equal(secondApply.changed, false);
  assert.equal(secondApply.applied.length, 0);
  assert.equal(secondApply.dropped[0].reason, "state_mismatch");
  assert.equal(secondApply.messages[0].parts[0].state.output, firstReplacement);
});

// --- funnel consistency ---------------------------------------------------

test("every strategy reports a monotone funnel and the supersede sub-counters", () => {
  const summary = summarizePruning({
    deduplicationEnabled: true,
    recordsTotal: 10,
    candidateCount: 4,
    eligibleCount: 4,
    duplicateCandidateCount: 3,
    markedCount: 2,
    prunedCount: 1,
    tokenSavingsEstimated: 10,
    errorPurge: {
      enabled: true,
      recordsTotal: 10,
      candidateCount: 3,
      eligibleCount: 3,
      potentialSupersedeCount: 2,
      markedCount: 1,
      prunedCount: 1,
      tokenSavingsEstimated: 20,
    },
    supersedeWrites: {
      enabled: true,
      recordsTotal: 10,
      candidateCount: 5,
      eligibleCount: 5,
      fileMatchCount: 4,
      versionVerifiedCount: 3,
      markedCount: 2,
      prunedCount: 2,
      observedReadCount: 6,
      fullReadCount: 5,
      confirmedWriteCount: 5,
      tokenSavingsEstimated: 30,
    },
  });

  for (const key of ["deduplication", "error_purge", "supersede_writes"]) {
    const strategy = summary[key];
    assert.ok(strategy.eligible_items >= strategy.candidate_items, key);
    assert.ok(strategy.candidate_items >= strategy.marked_items, key);
    assert.ok(strategy.marked_items >= strategy.changed_items, key);
    assert.equal(strategy.removed_items, strategy.changed_items, key);
  }
  assert.deepEqual(summary.supersede_writes.writes, {
    confirmed: 5,
    ambiguous: 0,
    eligible: 5,
    file_matches: 4,
    version_verified: 3,
    marked: 2,
    changed: 2,
  });
  assert.deepEqual(summary.supersede_writes.reads, {
    observed: 6,
    full: 5,
    rejected_reasons: {},
  });
  assert.equal(summary.total_removed_tokens.value, 60);
});

test("supersede planner exposes the write/read funnel end to end", () => {
  const write = toolRecord({ id: "w1", order: 1, tool: "write", args: { filePath: "a.ts", content: "x".repeat(2000) }, output: "ok", time: { start: 1, end: 2 } });
  const read = toolRecord({
    id: "r1",
    order: 2,
    tool: "read",
    args: { filePath: "a.ts", offset: 1, limit: 2000 },
    output: "content",
    time: { start: 3, end: 4 },
    metadata: { truncated: false },
  });
  const plan = planSupersedeWrites([write, read]);

  assert.equal(plan.stats.confirmedWriteCount, 1);
  assert.equal(plan.stats.observedReadCount, 1);
  assert.equal(plan.stats.fullReadCount, 1);
  assert.equal(plan.stats.fileMatchCount, 1);
  assert.equal(plan.stats.versionVerifiedCount, 1);
  assert.equal(plan.stats.markedCount, 1);
  assert.equal(plan.stats.prunableCount, 1);
});
