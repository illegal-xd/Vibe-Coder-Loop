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

function assistantInfo({ input = 9500, output = 600, reasoning = 0, cached = 3000, cacheWrite = 0, time = { created: 1, completed: 2 }, providerID = "CPMAC-API", modelID = "deepseek-flash" } = {}) {
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
    tokens: {
      input,
      output,
      reasoning,
      cache: { read: cached, write: cacheWrite },
    },
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

test("extracts provider usage with additive total including cache and reasoning", () => {
  const usage = extractProviderUsage(assistantInfo({ reasoning: 120 }));
  assert.equal(usage.provider, "CPMAC-API");
  assert.equal(usage.model, "deepseek-flash");
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 9500, source: "provider_usage" });
  assert.deepEqual(usage.output_tokens, { value: 600, source: "provider_usage" });
  // Additive: input + cache.read + cache.write + output + reasoning
  // = 9500 + 3000 + 0 + 600 + 120 = 13220
  assert.deepEqual(usage.total_tokens, { value: 13220, source: "provider_usage_derived" });
  assert.deepEqual(usage.cached_input_tokens, { value: 3000, source: "provider_usage" });
  // Under the additive model, input is the uncached portion.
  assert.deepEqual(usage.uncached_input_tokens, { value: 9500, source: "provider_usage" });
  assert.deepEqual(usage.reasoning_tokens, { value: 120, source: "provider_usage" });
});

test("zero-valued reasoning and cache within confirmed usage are kept as measured zeros", () => {
  const usage = extractProviderUsage(assistantInfo({ reasoning: 0, cached: 0 }));
  // Usage is confirmed (input 9500 > 0), so 0s are effective billing values.
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.reasoning_tokens, { value: 0, source: "provider_usage" });
  assert.deepEqual(usage.cached_input_tokens, { value: 0, source: "provider_usage" });
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
  // output is valid (600), input is not (string), reasoning is not (-1), cache.read is not (null)
  // → only output available → partial.
  assert.equal(malformed.usage_status, "partial");
  assert.deepEqual(malformed.input_tokens, { value: null, source: "unavailable" });
  assert.deepEqual(malformed.output_tokens, { value: 600, source: "provider_usage" });
  assert.deepEqual(malformed.total_tokens, { value: 600, source: "provider_usage_derived" });

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

// --- additive model: cache.read and reasoning are disjoint from input/output

test("cache reads exceeding input is legitimate under the additive model, not an error", () => {
  // DeepSeek: prompt_tokens (uncached) = 5000, prompt_cache_hit_tokens (cached) = 8000.
  // They are disjoint: total prompt = 5000 + 8000 = 13000.
  const usage = extractProviderUsage(assistantInfo({ input: 5000, output: 200, cached: 8000 }));
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 5000, source: "provider_usage" });
  assert.deepEqual(usage.cached_input_tokens, { value: 8000, source: "provider_usage" });
  assert.deepEqual(usage.uncached_input_tokens, { value: 5000, source: "provider_usage" });
  // total = 5000 + 8000 + 0 + 200 + 0 = 13200
  assert.deepEqual(usage.total_tokens, { value: 13200, source: "provider_usage_derived" });
  assert.equal(usage.errors.length, 0);
});

test("reasoning exceeding output is legitimate under the additive model, not an error", () => {
  // DeepSeek-R1-style: reasoning is separate from (additive to) completion.
  const usage = extractProviderUsage(assistantInfo({ output: 200, reasoning: 1500 }));
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.output_tokens, { value: 200, source: "provider_usage" });
  assert.deepEqual(usage.reasoning_tokens, { value: 1500, source: "provider_usage" });
  assert.equal(usage.errors.length, 0);
});

test("all-zero usage is unverified, with raw zeros preserved", () => {
  const usage = extractProviderUsage(assistantInfo({ input: 0, output: 0, reasoning: 0, cached: 0 }));
  assert.equal(usage.usage_status, "unverified");
  assert.deepEqual(usage.input_tokens, { value: 0, source: "provider_usage" });
  assert.deepEqual(usage.output_tokens, { value: 0, source: "provider_usage" });
  assert.ok(usage.errors.includes("usage_zero_unverified"));
});

test("zero input but non-zero cache is actual (fully-cached request)", () => {
  // All prompt cached, no new input — legitimate under additive model.
  const usage = extractProviderUsage(assistantInfo({ input: 0, output: 100, cached: 5000 }));
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 0, source: "provider_usage" });
  assert.deepEqual(usage.cached_input_tokens, { value: 5000, source: "provider_usage" });
  assert.equal(usage.errors.length, 0);
});

test("a legitimately verified non-zero usage stays actual", () => {
  const usage = extractProviderUsage(assistantInfo({ input: 1, output: 1, cached: 0 }));
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.errors, []);
});

// --- reproduces the reported anomaly sample and verifies the fix ------------

test("anomaly sample: cached >> input is actual with correct additive total", () => {
  // The exact values from the reported anomaly record.
  const usage = extractProviderUsage(
    assistantInfo({ input: 1237, output: 562, reasoning: 0, cached: 229888 }),
  );
  assert.equal(usage.usage_status, "actual");
  assert.deepEqual(usage.input_tokens, { value: 1237, source: "provider_usage" });
  assert.deepEqual(usage.output_tokens, { value: 562, source: "provider_usage" });
  assert.deepEqual(usage.cached_input_tokens, { value: 229888, source: "provider_usage" });
  assert.deepEqual(usage.uncached_input_tokens, { value: 1237, source: "provider_usage" });
  // Additive total = 1237 + 229888 + 0 + 562 + 0 = 231687
  assert.deepEqual(usage.total_tokens, { value: 231687, source: "provider_usage_derived" });
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
