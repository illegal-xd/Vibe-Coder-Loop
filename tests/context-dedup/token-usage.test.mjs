import test from "node:test";
import assert from "node:assert/strict";

import { byteLength, textTokenUnits } from "../../.opencode/context-dedup/core.js";
import {
  TOKEN_ESTIMATOR_ID,
  TOKEN_USAGE_EVENT_TYPE,
  TOKEN_USAGE_SCHEMA_VERSION,
  buildUsageRecord,
  countCodePoints,
  createPendingPruneStore,
  createSeenIdSet,
  estimateMessagesTokens,
  estimateTextTokens,
  extractProviderUsage,
  serializeUsageRecord,
  summarizePruning,
} from "../../.opencode/context-dedup/token-usage.js";
import { SESSION_ID, assistantMessage, textPart, toolPart, userMessage } from "./helpers.mjs";

function assistantInfo({ input = 9500, output = 600, reasoning = 0, cached = 3000, cacheWrite = 0, total, time = { created: 1, completed: 2 }, providerID = "CPMAC-API", modelID = "deepseek-flash" } = {}) {
  const tokens = {
    input,
    output,
    reasoning,
    cache: { read: cached, write: cacheWrite },
  };
  if (total !== undefined) {
    if (total !== null) tokens.total = total;
  } else if (
    typeof input === "number" &&
    typeof output === "number" &&
    typeof reasoning === "number" &&
    typeof cached === "number" &&
    typeof cacheWrite === "number"
  ) {
    // Current runtime schema: total = uncached input + cache + visible output
    // + reasoning (the components are disjoint).
    tokens.total = input + output + reasoning + cached + cacheWrite;
  }
  return {
    id: "msg_a1",
    sessionID: SESSION_ID,
    role: "assistant",
    time,
    parentID: "msg_user",
    providerID,
    modelID,
    mode: "default",
    cost: 0,
    tokens,
    finish: "stop",
  };
}

// --- character / token estimation -----------------------------------------

test("counts Unicode code points, not UTF-16 units or bytes", () => {
  const text = "a😀中"; // 3 code points, 4 UTF-16 units, 8 UTF-8 bytes
  assert.equal(text.length, 4);
  assert.equal(byteLength(text), 8);
  assert.equal(countCodePoints(text), 3);
});

test("the fast text estimator is equivalent to code-point weighting", () => {
  // Mixed: ASCII, BMP non-ASCII, a surrogate pair (emoji), lone surrogates.
  const cases = [
    "abcd",
    "中文",
    "a😀中",
    "\ud83d\uDE00 trailing",
    "lone high \ud83d end",
    "lone low \uDE00 end",
    "",
    "x".repeat(0x10000),
    "中".repeat(5000),
  ];
  for (const text of cases) {
    let reference = 0;
    for (const char of text) {
      reference += char.codePointAt(0) > 0x7f ? 1 : 0.25;
    }
    const actual = textTokenUnits(text);
    assert.equal(
      Math.abs(actual - reference) < 1e-9,
      true,
      `textTokenUnits mismatch for ${JSON.stringify(text).slice(0, 40)}: ${actual} vs ${reference}`,
    );
  }
});

test("character estimate stays a labelled approximation", () => {
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("abcde"), 2);
  assert.equal(estimateTextTokens("中文"), 2);
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens(undefined), 0);
});

test("message estimates walk text, tool output, tool error and tool input", () => {
  const messages = [
    userMessage({ text: "abcd" }),
    {
      info: assistantMessage().info,
      parts: [
        textPart({ id: "p_text", text: "abcd" }),
        toolPart({ id: "p_tool", callID: "call_1", input: {}, output: "abcd" }),
        toolPart({ id: "p_err", callID: "call_2", input: {}, status: "error", error: "abcd" }),
      ],
    },
  ];
  const estimate = estimateMessagesTokens(messages);
  assert.equal(estimate.source, "estimated_tokens_from_chars");
  // Four 4-char ASCII strings (4 units) plus two empty tool-input objects
  // serialized as "{}" (0.5 units each), rounded up once at the end.
  assert.equal(estimate.value, 5);
  assert.equal(estimateMessagesTokens(null), null);
  assert.equal(estimateMessagesTokens([]).value, 0);
});

// --- provider usage extraction -------------------------------------------

test("normalizes input and output totals and prefers the runtime total", () => {
  const usage = extractProviderUsage(assistantInfo({ reasoning: 120 }));
  assert.equal(usage.provider, "CPMAC-API");
  assert.equal(usage.model, "deepseek-flash");
  assert.equal(usage.usage_status, "actual");
  // input_tokens = uncached 9500 + cache.read 3000 + cache.write 0
  assert.deepEqual(usage.input_tokens, { value: 12500, source: "provider_usage_derived" });
  // output_tokens = total 13220 - input total 12500 = 720 (600 visible + 120 reasoning)
  assert.deepEqual(usage.output_tokens, { value: 720, source: "provider_usage_derived" });
  // The runtime reports total directly; it is not locally derived.
  assert.deepEqual(usage.total_tokens, { value: 13220, source: "provider_usage" });
  assert.deepEqual(usage.cached_input_tokens, { value: 3000, source: "provider_usage" });
  assert.deepEqual(usage.uncached_input_tokens, { value: 9500, source: "provider_usage" });
  assert.deepEqual(usage.cache_write_tokens, { value: 0, source: "provider_usage" });
  assert.deepEqual(usage.reasoning_tokens, { value: 120, source: "provider_usage" });
  assert.deepEqual(usage.errors, []);
});

test("zero-valued reasoning and cache within confirmed usage are kept as measured zeros", () => {
  const usage = extractProviderUsage(assistantInfo({ reasoning: 0, cached: 0 }));
  // Usage is confirmed (input 9500 > 0), so 0s are effective billing values.
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.reasoning_tokens, { value: 0, source: "provider_usage" });
  assert.deepEqual(usage.cached_input_tokens, { value: 0, source: "provider_usage" });
  assert.deepEqual(usage.cache_write_tokens, { value: 0, source: "provider_usage" });
  assert.deepEqual(usage.input_tokens, { value: 9500, source: "provider_usage_derived" });
  assert.deepEqual(usage.output_tokens, { value: 600, source: "provider_usage_derived" });
  assert.deepEqual(usage.total_tokens, { value: 10100, source: "provider_usage" });
});

test("missing and malformed usage metadata degrade honestly", () => {
  const missing = extractProviderUsage({ role: "assistant", id: "m" });
  assert.equal(missing.usage_status, "missing");
  assert.deepEqual(missing.input_tokens, { value: null, source: "unavailable" });
  assert.deepEqual(missing.total_tokens, { value: null, source: "unavailable" });
  assert.ok(missing.errors.includes("usage_missing"));

  const malformed = extractProviderUsage({
    role: "assistant",
    id: "m",
    tokens: { input: "9500", output: 600, reasoning: -1, cache: { read: null, write: 0 } },
  });
  // output is valid (600), input is not (string), reasoning is not (-1),
  // cache.read is not (null), and there is no runtime total. The output total
  // cannot be determined without reasoning/total, so it is not fabricated.
  assert.equal(malformed.usage_status, "partial");
  assert.deepEqual(malformed.input_tokens, { value: null, source: "unavailable" });
  assert.deepEqual(malformed.output_tokens, { value: null, source: "unavailable" });
  assert.deepEqual(malformed.total_tokens, { value: null, source: "unavailable" });
  assert.ok(malformed.errors.includes("input_total_unverified"));
  assert.deepEqual(malformed.validation.raw, {
    input: null,
    output: 600,
    reasoning: null,
    cache_read: null,
    cache_write: 0,
    total: null,
  });

  const absent = extractProviderUsage(null);
  assert.equal(absent.usage_status, "missing");
  assert.ok(absent.errors.includes("message_info_missing"));
});

test("a stream that ends before usage is recorded as missing", () => {
  const usage = extractProviderUsage(assistantInfo(), { terminal: false });
  assert.equal(usage.usage_status, "missing");
  assert.deepEqual(usage.input_tokens, { value: null, source: "unavailable" });
  assert.deepEqual(usage.output_tokens, { value: null, source: "unavailable" });
  assert.ok(usage.errors.includes("stream_ended_without_usage"));
});

// --- canonical accounting: cache and reasoning are subsets of totals

test("cache reads are a subset of total input, not a separate additive bucket", () => {
  // DeepSeek sample: prompt_tokens total = 13000, prompt_cache_hit_tokens = 8000.
  // The runtime stores input = 5000 (uncached) and cache.read = 8000.
  const usage = extractProviderUsage(assistantInfo({ input: 5000, output: 200, cached: 8000 }));
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 13000, source: "provider_usage_derived" });
  assert.deepEqual(usage.cached_input_tokens, { value: 8000, source: "provider_usage" });
  assert.deepEqual(usage.uncached_input_tokens, { value: 5000, source: "provider_usage" });
  assert.deepEqual(usage.output_tokens, { value: 200, source: "provider_usage_derived" });
  assert.deepEqual(usage.total_tokens, { value: 13200, source: "provider_usage" });
  assert.equal(usage.errors.length, 0);
});

test("reasoning is a subset of total output, not a second additive bucket", () => {
  // Current runtime: output is visible output (200), reasoning is 1500,
  // runtime total is 14200, so total output is 1700.
  const usage = extractProviderUsage(assistantInfo({ output: 200, reasoning: 1500 }));
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.output_tokens, { value: 1700, source: "provider_usage_derived" });
  assert.deepEqual(usage.reasoning_tokens, { value: 1500, source: "provider_usage" });
  assert.deepEqual(usage.total_tokens, { value: 14200, source: "provider_usage" });
  assert.ok(usage.reasoning_tokens.value <= usage.output_tokens.value);
  assert.equal(usage.errors.length, 0);
});

test("old runtime schema with reasoning included in output is normalized without double counting", () => {
  // Evidence from OpenCode messages before 2026-07-28: total excludes the
  // separate reasoning counter. Naively adding reasoning overcounts by 1500.
  const usage = extractProviderUsage(
    assistantInfo({ input: 5000, output: 200, reasoning: 1500, cached: 8000, total: 13200 }),
  );
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 13000, source: "provider_usage_derived" });
  assert.deepEqual(usage.output_tokens, { value: 200, source: "provider_usage_derived" });
  assert.deepEqual(usage.reasoning_tokens, { value: 1500, source: "provider_usage" });
  assert.deepEqual(usage.total_tokens, { value: 13200, source: "provider_usage" });
  assert.equal(usage.errors.length, 0);
});

test("all-zero usage is unverified, with raw zeros preserved", () => {
  const usage = extractProviderUsage(assistantInfo({ input: 0, output: 0, reasoning: 0, cached: 0 }));
  assert.equal(usage.usage_status, "unverified");
  assert.deepEqual(usage.input_tokens, { value: 0, source: "provider_usage_derived" });
  assert.deepEqual(usage.output_tokens, { value: 0, source: "provider_usage_derived" });
  assert.deepEqual(usage.total_tokens, { value: 0, source: "provider_usage" });
  assert.ok(usage.errors.includes("usage_zero_unverified"));
});

test("a runtime total without components is partial, not missing", () => {
  const usage = extractProviderUsage({ tokens: { total: 100 } });
  assert.equal(usage.usage_status, "partial");
  assert.deepEqual(usage.total_tokens, { value: 100, source: "provider_usage" });
  assert.deepEqual(usage.input_tokens, { value: null, source: "unavailable" });
  assert.deepEqual(usage.output_tokens, { value: null, source: "unavailable" });
  assert.ok(usage.errors.includes("input_total_unverified"));
});

test("a lone zero total is unverified rather than missing", () => {
  const usage = extractProviderUsage({ tokens: { total: 0 } });
  assert.equal(usage.usage_status, "unverified");
  assert.deepEqual(usage.total_tokens, { value: 0, source: "provider_usage" });
  assert.ok(usage.errors.includes("usage_zero_unverified"));
});

test("zero uncached input but non-zero cache is actual (fully-cached request)", () => {
  // All prompt cached, no new input — total input is still 5000.
  const usage = extractProviderUsage(assistantInfo({ input: 0, output: 100, cached: 5000 }));
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 5000, source: "provider_usage_derived" });
  assert.deepEqual(usage.uncached_input_tokens, { value: 0, source: "provider_usage" });
  assert.deepEqual(usage.cached_input_tokens, { value: 5000, source: "provider_usage" });
  assert.deepEqual(usage.total_tokens, { value: 5100, source: "provider_usage" });
  assert.equal(usage.errors.length, 0);
});

test("a legitimately verified non-zero usage stays actual", () => {
  const usage = extractProviderUsage(assistantInfo({ input: 1, output: 1, cached: 0 }));
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.errors, []);
});

test("a runtime total mismatch is preserved and marked unverified, never silently repaired", () => {
  const usage = extractProviderUsage(
    assistantInfo({ input: 100, output: 50, reasoning: 10, cached: 0, total: 999 }),
  );
  assert.equal(usage.usage_status, "unverified");
  assert.deepEqual(usage.total_tokens, { value: 999, source: "provider_usage" });
  assert.deepEqual(usage.input_tokens, { value: 100, source: "provider_usage_derived" });
  // 899 is implied by the authoritative total, but it matches neither
  // output (50) nor output + reasoning (60); the record is flagged.
  assert.deepEqual(usage.output_tokens, { value: 899, source: "provider_usage_derived" });
  assert.ok(usage.errors.includes("total_component_mismatch"));
  assert.deepEqual(usage.validation.raw, {
    input: 100,
    output: 50,
    reasoning: 10,
    cache_read: 0,
    cache_write: 0,
    total: 999,
  });
  assert.deepEqual(usage.validation.derived, { input_total: 100, output_total: 899 });
});

test("a missing total with non-zero reasoning is not guessed", () => {
  const usage = extractProviderUsage(
    assistantInfo({ input: 100, output: 50, reasoning: 10, cached: 0, total: null }),
  );
  assert.equal(usage.usage_status, "partial");
  assert.deepEqual(usage.input_tokens, { value: 100, source: "provider_usage_derived" });
  assert.deepEqual(usage.output_tokens, { value: null, source: "unavailable" });
  assert.deepEqual(usage.total_tokens, { value: null, source: "unavailable" });
  assert.ok(usage.errors.includes("total_missing_reasoning_scope_unknown"));
  assert.deepEqual(usage.validation.raw, {
    input: 100,
    output: 50,
    reasoning: 10,
    cache_read: 0,
    cache_write: 0,
    total: null,
  });
});

test("a missing total with zero reasoning is derived unambiguously", () => {
  const usage = extractProviderUsage(
    assistantInfo({ input: 100, output: 50, reasoning: 0, cached: 0, total: null }),
  );
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 100, source: "provider_usage_derived" });
  assert.deepEqual(usage.output_tokens, { value: 50, source: "provider_usage_derived" });
  assert.deepEqual(usage.total_tokens, { value: 150, source: "provider_usage_derived" });
  assert.deepEqual(usage.errors, []);
});

test("a missing cache field leaves the input total unverified instead of assuming zero", () => {
  const usage = extractProviderUsage({
    role: "assistant",
    id: "m",
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: null, write: 0 }, total: 150 },
  });
  assert.equal(usage.usage_status, "partial");
  assert.deepEqual(usage.uncached_input_tokens, { value: 100, source: "provider_usage" });
  assert.deepEqual(usage.input_tokens, { value: null, source: "unavailable" });
  assert.deepEqual(usage.output_tokens, { value: null, source: "unavailable" });
  assert.deepEqual(usage.total_tokens, { value: 150, source: "provider_usage" });
  assert.ok(usage.errors.includes("input_total_unverified"));
});

// --- real provider samples and reported anomalies --------------------------

test("real DeepSeek sample: completion includes reasoning; runtime stores visible output", () => {
  // 2026-10-28, local CLIProxyAPI -> deepseek-flash, non-stream request.
  // Raw upstream usage:
  //   prompt_tokens=1936, completion_tokens=8, total_tokens=1944,
  //   prompt_tokens_details.cached_tokens=1920,
  //   completion_tokens_details.reasoning_tokens=8
  // Runtime-normalized message.tokens:
  //   {total:1944, input:16, output:0, reasoning:8,
  //    cache:{read:1920, write:0}}
  const usage = extractProviderUsage(
    assistantInfo({ input: 16, output: 0, reasoning: 8, cached: 1920, total: 1944 }),
  );
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 1936, source: "provider_usage_derived" });
  assert.deepEqual(usage.output_tokens, { value: 8, source: "provider_usage_derived" });
  assert.deepEqual(usage.uncached_input_tokens, { value: 16, source: "provider_usage" });
  assert.deepEqual(usage.cached_input_tokens, { value: 1920, source: "provider_usage" });
  assert.deepEqual(usage.reasoning_tokens, { value: 8, source: "provider_usage" });
  assert.deepEqual(usage.total_tokens, { value: 1944, source: "provider_usage" });
  // The raw `output` was 0 (all completion tokens were reasoning), but the
  // normalized output total is 8. This is why reasoning > raw output is not a
  // bug in the normalized schema.
  assert.equal(usage.output_tokens.value, usage.reasoning_tokens.value);
  assert.equal(usage.errors.length, 0);
});

test("real runtime sample: cached prefix is a subset, not an accumulated counter", () => {
  // Values from data/token-usage-2026-10-28.jsonl (request msg_182054b...).
  // Runtime message.tokens:
  //   total=140317, input=226, output=653, reasoning=46,
  //   cache.read=139392, cache.write=0
  const usage = extractProviderUsage(
    assistantInfo({
      input: 226,
      output: 653,
      reasoning: 46,
      cached: 139392,
      total: 140317,
    }),
  );
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 139618, source: "provider_usage_derived" });
  assert.deepEqual(usage.output_tokens, { value: 699, source: "provider_usage_derived" });
  assert.deepEqual(usage.cached_input_tokens, { value: 139392, source: "provider_usage" });
  assert.deepEqual(usage.uncached_input_tokens, { value: 226, source: "provider_usage" });
  assert.deepEqual(usage.reasoning_tokens, { value: 46, source: "provider_usage" });
  assert.deepEqual(usage.total_tokens, { value: 140317, source: "provider_usage" });
  assert.ok(usage.cached_input_tokens.value <= usage.input_tokens.value);
  assert.ok(usage.reasoning_tokens.value <= usage.output_tokens.value);
  assert.equal(usage.errors.length, 0);
});

test("AspireCode context panel sample: 107,099 total is 100,123 input + 6,976 output", () => {
  // Exact message behind the AspireCode session context panel:
  //   msg_1821cf259001T9OlgAKobbcujv
  //   total=107099, input=155, output=4074, reasoning=2902,
  //   cache.read=99968, cache.write=0
  // The panel currently shows input=155, output=4074 and cache=99968
  // separately, then adds all four buckets. The normalized view below makes
  // the input/output totals explicit and keeps cache/reasoning as subsets.
  const usage = extractProviderUsage(
    assistantInfo({
      input: 155,
      output: 4074,
      reasoning: 2902,
      cached: 99968,
      total: 107099,
    }),
  );
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 100123, source: "provider_usage_derived" });
  assert.deepEqual(usage.output_tokens, { value: 6976, source: "provider_usage_derived" });
  assert.deepEqual(usage.total_tokens, { value: 107099, source: "provider_usage" });
  assert.deepEqual(usage.cached_input_tokens, { value: 99968, source: "provider_usage" });
  assert.deepEqual(usage.uncached_input_tokens, { value: 155, source: "provider_usage" });
  assert.deepEqual(usage.reasoning_tokens, { value: 2902, source: "provider_usage" });
  assert.equal(usage.input_tokens.value + usage.output_tokens.value, usage.total_tokens.value);
  assert.equal(usage.errors.length, 0);
});

test("anomaly sample: cached >> uncached is expected; input total includes the cache", () => {
  // The exact values from the reported anomaly record.
  const usage = extractProviderUsage(
    assistantInfo({ input: 1237, output: 562, reasoning: 0, cached: 229888 }),
  );
  assert.equal(usage.usage_status, "actual");
  // Total input = 1237 + 229888; the small uncached suffix is not the total.
  assert.deepEqual(usage.input_tokens, { value: 231125, source: "provider_usage_derived" });
  assert.deepEqual(usage.output_tokens, { value: 562, source: "provider_usage_derived" });
  assert.deepEqual(usage.cached_input_tokens, { value: 229888, source: "provider_usage" });
  assert.deepEqual(usage.uncached_input_tokens, { value: 1237, source: "provider_usage" });
  assert.deepEqual(usage.total_tokens, { value: 231687, source: "provider_usage" });
  assert.equal(usage.errors.length, 0);
});

// --- pruning attribution -------------------------------------------------

function transformStats(overrides = {}) {
  return {
    enabled: true,
    preview: false,
    deduplicationEnabled: true,
    changed: true,
    recordsTotal: 123,
    candidateCount: 4,
    prunedCount: 2,
    skippedReasons: { unsupported_tool: 47, referenced_later: 1, apply_state_mismatch: 0 },
    tokenSavingsEstimated: 300,
    errorPurge: {
      enabled: true,
      preview: false,
      changed: true,
      recordsTotal: 123,
      candidateCount: 2,
      prunedCount: 1,
      preservedCount: 1,
      tokenSavingsEstimated: 200,
      skippedReasons: { across_user_turn: 1 },
    },
    ...overrides,
  };
}

test("attributes removals per strategy in execution order without double counting", () => {
  const pruning = summarizePruning(transformStats());
  assert.deepEqual(pruning.order, ["deduplication", "error_purge"]);
  assert.equal(pruning.attribution, "incremental_sequential");
  assert.equal(pruning.deduplication.removed_items, 2);
  assert.equal(pruning.error_purge.removed_items, 1);
  assert.deepEqual(pruning.deduplication.removed_tokens, {
    value: 300,
    source: "estimated_tokens_from_chars",
  });
  assert.deepEqual(pruning.total_removed_tokens, {
    value: 500,
    source: "estimated_tokens_from_chars",
  });
  // Candidates are not removals.
  assert.equal(pruning.deduplication.candidate_items, 4);
  assert.equal(pruning.deduplication.preserved_items, 2);
  assert.equal(pruning.deduplication.candidate_tokens.value, null);
  assert.equal(pruning.measurement_source, "estimated_tokens_from_chars");
});

test("skip-reason counts are partitioned by unit so record scans do not look like candidate skips", () => {
  const pruning = summarizePruning(transformStats());
  // unsupported_tool counts scanned tool calls (e.g. bash/edit), not candidates.
  assert.equal(pruning.deduplication.skipped.record_scan.unsupported_tool, 47);
  assert.equal(pruning.deduplication.skipped.candidate.referenced_later, 1);
  assert.equal(pruning.deduplication.skipped.application.apply_state_mismatch, undefined);
  // A record-scan skip legitimately exceeds candidate_items.
  assert.ok(pruning.deduplication.skipped.record_scan.unsupported_tool > pruning.deduplication.candidate_items);
  assert.equal(pruning.error_purge.skipped.candidate.across_user_turn, 1);
});

test("preview and disabled strategies report measured zero removals", () => {
  const preview = summarizePruning(
    transformStats({ preview: true, prunedCount: 0, tokenSavingsEstimated: 0 }),
  );
  assert.equal(preview.deduplication.preview, true);
  assert.equal(preview.deduplication.removed_items, 0);
  assert.deepEqual(preview.deduplication.removed_tokens, {
    value: 0,
    source: "estimated_tokens_from_chars",
  });
  assert.equal(preview.total_removed_tokens.value, 200);

  const disabled = summarizePruning({
    enabled: false,
    deduplicationEnabled: false,
    candidateCount: 0,
    prunedCount: 0,
    tokenSavingsEstimated: 0,
    errorPurge: { enabled: false, candidateCount: 0, prunedCount: 0, tokenSavingsEstimated: 0 },
  });
  assert.equal(disabled.deduplication.enabled, false);
  assert.equal(disabled.error_purge.enabled, false);
  assert.equal(disabled.total_removed_tokens.value, 0);

  assert.equal(summarizePruning(null), null);
});

test("an unmeasured removal makes the total unavailable instead of zero", () => {
  const pruning = summarizePruning({
    deduplicationEnabled: true,
    candidateCount: 3,
    prunedCount: 1,
    tokenSavingsEstimated: null,
    errorPurge: null,
  });
  assert.deepEqual(pruning.deduplication.removed_tokens, { value: null, source: "unavailable" });
  assert.deepEqual(pruning.total_removed_tokens, { value: null, source: "unavailable" });
});

// --- record schema -------------------------------------------------------

test("builds a versioned record from real values only", () => {
  const usage = extractProviderUsage(assistantInfo());
  const record = buildUsageRecord({
    session_id: SESSION_ID,
    request_id: "msg_a1",
    timestamp: "2026-10-28T12:00:00.000Z",
    usage,
    context_estimates: {
      before_pruning: { value: 10000, source: "estimated_tokens_from_chars" },
      after_pruning: { value: 9500, source: "estimated_tokens_from_chars" },
    },
    pruning: summarizePruning(transformStats()),
  });

  assert.equal(record.schema_version, TOKEN_USAGE_SCHEMA_VERSION);
  assert.equal(record.event_type, TOKEN_USAGE_EVENT_TYPE);
  assert.equal(record.timestamp, "2026-10-28T12:00:00.000Z");
  assert.equal(record.session_id, SESSION_ID);
  assert.equal(record.request_id, "msg_a1");
  assert.equal(record.model, "deepseek-flash");
  assert.equal(record.transport, "unavailable");
  assert.equal(record.estimator, TOKEN_ESTIMATOR_ID);
  assert.deepEqual(record.errors, []);
});

test("absent identifiers stay null and are not fabricated", () => {
  const record = buildUsageRecord({
    usage: extractProviderUsage({ role: "assistant" }),
  });
  assert.equal(record.session_id, null);
  assert.equal(record.request_id, null);
  assert.equal(record.provider, null);
  assert.equal(record.model, null);
  assert.equal(record.usage_status, "missing");
  assert.equal(record.context_estimates.before_pruning, null);
  assert.equal(record.pruning, null);
});

test("unknown or sensitive input keys never reach the record", () => {
  const record = buildUsageRecord({
    session_id: SESSION_ID,
    usage: {
      ...extractProviderUsage(assistantInfo()),
      apiKey: "sk-secret",
      prompt: "FULL PROMPT TEXT",
      validation: {
        rule: "test_rule",
        raw: { input: 1, apiKey: "sk-secret", prompt: "FULL PROMPT TEXT" },
        derived: { input_total: 1, extra: "sk-secret" },
        extra: "sk-secret",
      },
    },
    output: "RAW TOOL OUTPUT",
    error: "RAW ERROR OUTPUT",
    headers: { authorization: "Bearer sk-secret" },
  });
  const text = JSON.stringify(record);
  assert.equal(text.includes("sk-secret"), false);
  assert.equal(text.includes("FULL PROMPT TEXT"), false);
  assert.equal(text.includes("RAW TOOL OUTPUT"), false);
  assert.equal(text.includes("RAW ERROR OUTPUT"), false);
  assert.equal(record.apiKey, undefined);
  assert.equal(record.output, undefined);
  assert.equal(record.headers, undefined);
});

test("serializes exactly one JSON object per line", () => {
  const record = buildUsageRecord({
    session_id: SESSION_ID,
    timestamp: "2026-10-28T12:00:00.000Z",
    usage: extractProviderUsage(assistantInfo()),
  });
  const line = serializeUsageRecord(record);
  assert.ok(line.endsWith("\n"));
  assert.equal(line.split("\n").filter((part) => part.length > 0).length, 1);
  assert.equal(JSON.parse(line).session_id, SESSION_ID);

  assert.equal(serializeUsageRecord(null), null);
  assert.equal(serializeUsageRecord({ ...record, schema_version: 99 }), null);
  assert.equal(serializeUsageRecord({ ...record, event_type: "other" }), null);
  assert.equal(serializeUsageRecord({ ...record, timestamp: "not-a-date" }), null);

  const circular = { ...record };
  circular.self = circular;
  assert.equal(serializeUsageRecord(circular), null);
});

// --- request/usage association -------------------------------------------

test("pending prune measurements are consumed once per session", () => {
  const store = createPendingPruneStore();
  store.set(SESSION_ID, { pruning: "p" });
  assert.deepEqual(store.take(SESSION_ID), { pruning: "p" });
  assert.equal(store.take(SESSION_ID), null);
  assert.equal(store.set(null, { pruning: "x" }), false);
});

test("pending measurements expire and stay bounded", () => {
  let clock = 1000;
  const store = createPendingPruneStore({ ttlMs: 50, maxSessions: 2, now: () => clock });
  store.set("s1", { value: 1 });
  clock += 51;
  assert.equal(store.take("s1"), null);

  store.set("a", { value: 1 });
  store.set("b", { value: 2 });
  store.set("c", { value: 3 });
  assert.equal(store.size(), 2);
  assert.equal(store.take("a"), null);
  assert.deepEqual(store.take("c"), { value: 3 });
});

test("terminal messages are logged at most once", () => {
  const seen = createSeenIdSet({ limit: 2 });
  assert.equal(seen.add("m1"), true);
  assert.equal(seen.add("m1"), false);
  assert.equal(seen.has("m1"), true);
  seen.add("m2");
  seen.add("m3");
  assert.equal(seen.has("m1"), false);
  assert.equal(seen.size(), 2);
  assert.equal(seen.add(""), false);
});
