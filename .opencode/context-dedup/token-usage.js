/**
 * Token usage measurement and JSONL record schema (schema_version 4).
 *
 * This module is pure: no filesystem, no host hooks, no network. It turns the
 * runtime's normalized assistant-message usage plus the pruning statistics into
 * one compact record. Every measurement carries its own provenance so actual
 * provider usage can never be confused with a local estimate.
 *
 * Schema v3 normalizes every record to the same accounting model used by the
 * provider SDKs:
 *   input_tokens  = uncached input + cache read + cache write
 *   output_tokens = total output (includes reasoning)
 *   cached_input_tokens / uncached_input_tokens / cache_write_tokens are
 *                   disjoint subsets of input_tokens
 *   reasoning_tokens is a subset of output_tokens
 *   total_tokens  = the runtime-reported total when present, otherwise a
 *                   derived input_tokens + output_tokens
 *
 * Deliberately excluded from records: prompts, tool outputs, raw responses,
 * error text, file paths, credentials.
 */

import { countCodePoints, textTokenUnits } from "./core.js";

export { countCodePoints };

export const TOKEN_USAGE_SCHEMA_VERSION = 4;
export const TOKEN_USAGE_EVENT_TYPE = "model_request_usage";

/**
 * Identifier of the char-weight estimator. Bump it whenever the weights in
 * `textTokenUnits` change so old and new estimates stay distinguishable.
 */
export const TOKEN_ESTIMATOR_ID = "char_weight_v1";

export const SOURCE = Object.freeze({
  PROVIDER_USAGE: "provider_usage",
  /** Arithmetic on provider-reported numbers (e.g. input + output). */
  PROVIDER_DERIVED: "provider_usage_derived",
  TOKENIZER: "tokenizer_estimate",
  /** Estimated token count derived from a character-weight heuristic. */
  ESTIMATED_TOKENS_FROM_CHARS: "estimated_tokens_from_chars",
  /** Raw Unicode code-point count, when a character count is stored as-is. */
  CHAR_COUNT: "estimated_char_count",
  UNAVAILABLE: "unavailable",
});

/**
 * Valid record-level usage statuses.
 * - `actual`: complete, provider-reported, and consistency checks passed.
 * - `partial`: some provider-reported fields are present but others missing.
 * - `missing`: no usable provider-reported usage is available.
 * - `unverified`: fields are present but failed a consistency check, so they
 *   must not be aggregated as trustworthy actual usage.
 * - `estimated`: only local estimates are available (no provider usage).
 */
export const USAGE_STATUS = Object.freeze([
  "actual",
  "partial",
  "missing",
  "unverified",
  "estimated",
]);

export function unavailableMeasure() {
  return { value: null, source: SOURCE.UNAVAILABLE };
}

/**
 * Normalize one measurement. Anything that is not a finite non-negative
 * number becomes an explicit "unavailable" measurement instead of a zero, so
 * an unknown value is never reported as a measured one.
 */
export function measure(value, source = SOURCE.UNAVAILABLE) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return unavailableMeasure();
  }
  return { value: Math.round(value), source };
}

function safeJson(value) {
  if (value === undefined) return "";
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

/** Rough token estimate for one string. Never reported as actual usage. */
export function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(textTokenUnits(text));
}

/** Wrap already-computed weighted units as a token estimate from chars. */
export function estimateFromUnits(units) {
  if (typeof units !== "number" || !Number.isFinite(units) || units < 0) {
    return unavailableMeasure();
  }
  return measure(Math.ceil(units), SOURCE.ESTIMATED_TOKENS_FROM_CHARS);
}

function partTokenUnits(part) {
  if (!part || typeof part !== "object") return 0;
  if (part.type === "text") {
    return typeof part.text === "string" ? textTokenUnits(part.text) : 0;
  }
  if (part.type === "subtask") {
    return typeof part.prompt === "string" ? textTokenUnits(part.prompt) : 0;
  }
  if (part.type === "tool") {
    const state = part.state;
    if (!state || typeof state !== "object") return 0;
    let units = 0;
    if (typeof state.output === "string") units += textTokenUnits(state.output);
    if (typeof state.error === "string") units += textTokenUnits(state.error);
    if (state.input !== undefined) units += textTokenUnits(safeJson(state.input));
    return units;
  }
  return 0;
}

/**
 * Weighted units for the parts of a request that are actually reachable from
 * the message list. System prompts, tool schemas, provider serialization and
 * multimodal payloads are not visible here and are therefore not counted.
 */
export function messagesTokenUnits(messages) {
  if (!Array.isArray(messages)) return null;
  let units = 0;
  for (const message of messages) {
    const parts = message && Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      units += partTokenUnits(part);
    }
  }
  return units;
}

/**
 * Estimated tokens for a message list at the request boundary.
 * The value is an estimated TOKEN count derived from `char_weight_v1`, not a
 * character count. Returns null when the input is not a message array.
 */
export function estimateMessagesTokens(messages) {
  const units = messagesTokenUnits(messages);
  if (units === null) return null;
  return estimateFromUnits(units);
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Extract provider-reported usage from a runtime assistant message.
 *
 * The runtime normalizes every provider into
 * `tokens: { total, input, output, reasoning, cache: { read, write } }`; the
 * raw provider payload is never exposed to plugins. The runtime maps:
 *   - OpenAI `prompt_tokens` → total input (cache included)
 *   - OpenAI `prompt_tokens_details.cached_tokens` → `cache.read`
 *   - DeepSeek `prompt_cache_hit_tokens` → `cache.read`
 *   - Anthropic `cache_read_input_tokens` → `cache.read`
 * and stores the **uncached** prompt portion in `tokens.input`
 * (`input = prompt_tokens - cache.read - cache.write`). It stores the
 * **visible** output in `tokens.output` (for the current runtime,
 * `output = completion_tokens - reasoning`; older runtime versions stored the
 * completion total directly).
 *
 * Real provider sample (2026-10-28, local CLIProxyAPI → deepseek-flash):
 *   {"prompt_tokens":1936,"completion_tokens":8,"total_tokens":1944,
 *    "completion_tokens_details":{"reasoning_tokens":8},
 *    "prompt_tokens_details":{"cached_tokens":1920}}
 * The runtime exposes `{total:1944, input:16, output:0, reasoning:8,
 * cache:{read:1920, write:0}}`. Therefore:
 * - `input_tokens` = 16 + 1920 = 1936 (total input, not 16)
 * - `output_tokens` = 1944 - 1936 = 8 (total output, includes reasoning)
 * - `cached_input_tokens` = 1920 (a subset of input, per request)
 * - `uncached_input_tokens` = 16
 * - `reasoning_tokens` = 8 (a subset of output)
 *
 * `tokens.total` is the authoritative total when present. Older runtime
 * versions (evidence: OpenCode messages before 2026-07-28) stored
 * `output = completion_tokens` (reasoning included) and
 * `total = input + cache + output`; newer versions store
 * `output = visible output` and `total = input + cache + output + reasoning`.
 * Both normalize to the same model by using `total - input_total` as the
 * output total. A naive `input + cache + output + reasoning` sum would
 * overcount the older schema by `reasoning`.
 *
 * A 0 in any field within a confirmed-usage record is kept as
 * `provider_usage(0)`: the runtime normalizes all fields to numbers, and a 0
 * is the effective billing value (it may be a provider-omitted field
 * defaulted to 0 by the runtime, but it cannot be distinguished from an
 * explicit 0). If ALL components are 0, the record is marked `unverified`.
 *
 * @param {unknown} info Assistant message info object.
 * @param {{transport?: string, terminal?: boolean}} [options]
 */
export function extractProviderUsage(info, options = {}) {
  const transport =
    typeof options.transport === "string" && options.transport.length > 0
      ? options.transport
      : SOURCE.UNAVAILABLE;
  const terminal = options.terminal !== false;
  const errors = [];

  const usage = {
    provider: null,
    model: null,
    transport,
    usage_status: "missing",
    input_tokens: unavailableMeasure(),
    output_tokens: unavailableMeasure(),
    total_tokens: unavailableMeasure(),
    cached_input_tokens: unavailableMeasure(),
    uncached_input_tokens: unavailableMeasure(),
    reasoning_tokens: unavailableMeasure(),
    errors,
  };

  if (!terminal) {
    errors.push("stream_ended_without_usage");
    return usage;
  }

  if (!info || typeof info !== "object") {
    errors.push("message_info_missing");
    return usage;
  }

  if (typeof info.providerID === "string" && info.providerID.length > 0) {
    usage.provider = info.providerID;
  }
  if (typeof info.modelID === "string" && info.modelID.length > 0) {
    usage.model = info.modelID;
  }

  const tokens = info.tokens;
  if (!tokens || typeof tokens !== "object") {
    errors.push("usage_missing");
    return usage;
  }

  // Runtime component values. `input` is the uncached prompt portion;
  // `output` is the runtime's output bucket (visible output on current
  // runtimes, completion total on older runtimes).
  const uncachedInput = nonNegativeNumber(tokens.input);
  const runtimeOutput = nonNegativeNumber(tokens.output);
  const reasoning = nonNegativeNumber(tokens.reasoning);
  const cache = tokens.cache;
  const cacheRead =
    cache && typeof cache === "object" ? nonNegativeNumber(cache.read) : null;
  const cacheWrite =
    cache && typeof cache === "object" ? nonNegativeNumber(cache.write) : null;
  const reportedTotal = nonNegativeNumber(tokens.total);

  // Preserve the runtime's own components before normalization.
  if (uncachedInput !== null) {
    usage.uncached_input_tokens = measure(uncachedInput, SOURCE.PROVIDER_USAGE);
  }
  if (cacheRead !== null) {
    usage.cached_input_tokens = measure(cacheRead, SOURCE.PROVIDER_USAGE);
  }
  if (cacheWrite !== null) {
    // Include an explicit 0: it is different from "field absent".
    usage.cache_write_tokens = measure(cacheWrite, SOURCE.PROVIDER_USAGE);
  }
  if (reasoning !== null) {
    usage.reasoning_tokens = measure(reasoning, SOURCE.PROVIDER_USAGE);
  }

  // Total input = uncached + cache read + cache write. The runtime's
  // `tokens.input` excludes cache, so this reconstructs the provider's input
  // total. When a cache field is missing, the total cannot be verified.
  const inputTotal =
    uncachedInput !== null && cacheRead !== null && cacheWrite !== null
      ? uncachedInput + cacheRead + cacheWrite
      : null;

  let outputTotal = null;
  let consistency = "unavailable";
  let validationRule = null;

  if (reportedTotal !== null) {
    // The runtime total is authoritative. Prefer it over a local component
    // sum so old and new runtime schemas normalize identically.
    usage.total_tokens = measure(reportedTotal, SOURCE.PROVIDER_USAGE);
    if (inputTotal === null) {
      errors.push("input_total_unverified");
      consistency = "unverified";
      validationRule = "input_total_unverified";
    } else if (reportedTotal < inputTotal) {
      errors.push("total_lt_input_total");
      consistency = "mismatch";
      validationRule = "total_lt_input_total";
    } else {
      outputTotal = reportedTotal - inputTotal;
      if (runtimeOutput !== null && reasoning !== null) {
        const outputPlusReasoning = runtimeOutput + reasoning;
        if (outputTotal === outputPlusReasoning) {
          consistency = "total_equals_input_plus_output_plus_reasoning";
        } else if (outputTotal === runtimeOutput) {
          consistency = "total_equals_input_plus_output";
        } else {
          errors.push("total_component_mismatch");
          consistency = "mismatch";
          validationRule = "total_component_mismatch";
        }
      } else {
        errors.push("output_component_missing");
        consistency = "unverified";
        validationRule = "output_component_missing";
      }
    }
  } else if (inputTotal !== null && runtimeOutput !== null && reasoning !== null) {
    if (reasoning === 0) {
      // No reasoning tokens: output is unambiguous even without a total.
      outputTotal = runtimeOutput;
      usage.total_tokens = measure(inputTotal + outputTotal, SOURCE.PROVIDER_DERIVED);
      consistency = "derived_reasoning_zero";
    } else {
      // `output` may or may not already include reasoning. Do not guess.
      errors.push("total_missing_reasoning_scope_unknown");
      consistency = "unverified";
      validationRule = "total_missing_reasoning_scope_unknown";
    }
  } else if (inputTotal === null) {
    errors.push("input_total_unverified");
    consistency = "unverified";
    validationRule = "input_total_unverified";
  } else {
    errors.push("total_missing");
    consistency = "missing";
  }

  if (inputTotal !== null) {
    usage.input_tokens = measure(inputTotal, SOURCE.PROVIDER_DERIVED);
  }
  if (outputTotal !== null) {
    usage.output_tokens = measure(outputTotal, SOURCE.PROVIDER_DERIVED);
  }

  // Keep raw values only when normalization could not be completed or failed
  // a consistency check, so the anomaly can be diagnosed without guessing.
  const components = [
    uncachedInput,
    cacheRead,
    cacheWrite,
    runtimeOutput,
    reasoning,
  ].filter((value) => value !== null);
  if (validationRule !== null && components.length > 0) {
    usage.validation = {
      rule: validationRule,
      raw: {
        input: uncachedInput,
        output: runtimeOutput,
        reasoning,
        cache_read: cacheRead,
        cache_write: cacheWrite,
        total: reportedTotal,
      },
      derived: {
        input_total: inputTotal,
        output_total: outputTotal,
      },
    };
  }

  const allZero =
    (components.length > 0 && components.every((value) => value === 0)) ||
    (components.length === 0 && reportedTotal === 0);
  const fullyClassified =
    inputTotal !== null &&
    outputTotal !== null &&
    runtimeOutput !== null &&
    reasoning !== null;

  if (allZero) {
    errors.push("usage_zero_unverified");
    usage.usage_status = "unverified";
  } else if (consistency === "mismatch") {
    usage.usage_status = "unverified";
  } else if (
    fullyClassified &&
    (consistency === "total_equals_input_plus_output_plus_reasoning" ||
      consistency === "total_equals_input_plus_output" ||
      consistency === "derived_reasoning_zero")
  ) {
    usage.usage_status = "actual";
  } else if (components.length > 0 || reportedTotal !== null) {
    usage.usage_status = "partial";
  } else {
    usage.usage_status = "missing";
    errors.push("usage_missing");
  }

  return usage;
}

function intOrNull(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/**
 * Skip-reason buckets, each with a single consistent unit:
 * - `record_scan`: tool records inspected but not promoted to candidates
 *   (e.g. `unsupported_tool` counts every scanned bash/edit/read-only-failure
 *   call). These naturally exceed `candidate_items`.
 * - `candidate`: eligible candidates (or duplicate groups) that were not
 *   pruned by a guard (`referenced_later`, `no_token_benefit`, ...).
 * - `application`: decisions dropped while applying to the message array.
 */
const RECORD_SCAN_REASONS = new Set([
  "unsupported_tool",
  "not_completed",
  "empty_output",
  "already_pruned",
  "invalid_args",
  "missing_environment",
  "invalid_order",
  "duplicate_call_id",
  "invalid_record",
  "invalid_tool",
  "invalid_call_id",
  "invalid_success",
  "invalid_input",
  "invalid_messages",
  "disabled",
]);

const APPLICATION_REASONS = new Set([
  "apply_location_mismatch",
  "apply_state_mismatch",
  "apply_already_pruned",
  "apply_target_missing",
  "apply_no_change",
  "apply_validation_failed",
  "apply_array_mutation_failed",
]);

function partitionSkippedReasons(reasons) {
  const recordScan = {};
  const candidate = {};
  const application = {};
  if (!reasons || typeof reasons !== "object") {
    return { record_scan: recordScan, candidate, application };
  }
  for (const [key, value] of Object.entries(reasons)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    const rounded = Math.round(value);
    if (RECORD_SCAN_REASONS.has(key)) recordScan[key] = rounded;
    else if (APPLICATION_REASONS.has(key)) application[key] = rounded;
    else candidate[key] = rounded;
  }
  return { record_scan: recordScan, candidate, application };
}

/**
 * One pruning strategy. Rules and preview only replace text with a
 * placeholder, so `removed_tokens` is the net saving (content minus
 * placeholder) already computed by the existing pipeline; it is an estimated
 * TOKEN count derived from `char_weight_v1`, never a billed-usage delta.
 */
/**
 * One strategy's funnel, all counts in the same unit (records/decisions):
 *   scanned_items  -> every tool record the planner looked at
 *   eligible_items -> records that passed every safety filter
 *   candidate_items-> eligible records that are actually prunable
 *                      (dedup: inside an identical-output group;
 *                       error purge: has a later same-signature success;
 *                       supersede: shares identity with a full read)
 *   marked_items   -> decisions produced after every guard
 *   changed_items  -> decisions that really modified the request copy
 * `removed_items` stays as an alias of `changed_items` for existing readers.
 */
function strategySummary(stats, fallbackEnabled) {
  if (!stats || typeof stats !== "object") return null;
  const changedItems = intOrNull(stats.changedCount) ?? intOrNull(stats.prunedCount) ?? 0;
  const eligibleItems = intOrNull(stats.eligibleCount) ?? intOrNull(stats.candidateCount) ?? 0;
  const candidateItems = intOrNull(stats.prunableCount) ?? eligibleItems;
  const markedItems =
    intOrNull(stats.markedCount) ?? intOrNull(stats.plannedPruneCount) ?? changedItems;
  const preserved = Math.max(0, candidateItems - changedItems);
  const removed = nonNegativeNumber(stats.tokenSavingsEstimated);
  const summary = {
    enabled: stats.enabled !== false && fallbackEnabled !== false,
    preview: stats.preview === true,
    scanned_records: intOrNull(stats.recordsTotal) ?? 0,
    eligible_items: eligibleItems,
    candidate_items: candidateItems,
    marked_items: markedItems,
    changed_items: changedItems,
    removed_items: changedItems,
    preserved_items: preserved,
    // v4: `candidate_tokens` / `preserved_tokens` were always unavailable and
    // duplicated the same holder object on every strategy; the funnel counts
    // above already carry the information. Only the measured net removal
    // remains, with its provenance.
    removed_tokens: removed !== null ? measure(removed, SOURCE.ESTIMATED_TOKENS_FROM_CHARS) : unavailableMeasure(),
    skipped: partitionSkippedReasons(stats.skippedReasons),
  };

  // Supersede Writes exposes the write/read funnel so a zero can be explained
  // without guessing: writes -> reads -> completeness -> identity -> version.
  if (stats.observedReadCount !== undefined || stats.fileMatchCount !== undefined) {
    summary.writes = {
      confirmed: intOrNull(stats.confirmedWriteCount) ?? 0,
      ambiguous: intOrNull(stats.ambiguousWriteCount) ?? 0,
      eligible: eligibleItems,
      file_matches: intOrNull(stats.fileMatchCount) ?? 0,
      version_verified: intOrNull(stats.versionVerifiedCount) ?? 0,
      marked: markedItems,
      changed: changedItems,
    };
    summary.reads = {
      observed: intOrNull(stats.observedReadCount) ?? 0,
      full: intOrNull(stats.fullReadCount) ?? 0,
      rejected_reasons: sanitizeReasonMap(stats.readRejectedReasons),
    };
  }

  return summary;
}

function sanitizeReasonMap(value) {
  const result = {};
  if (!value || typeof value !== "object") return result;
  for (const [key, count] of Object.entries(value)) {
    const rounded = intOrNull(count) ?? 0;
    if (rounded > 0) result[String(key).slice(0, 64)] = rounded;
  }
  return result;
}

/**
 * Attribute removals to the strategies in their real execution order.
 *
 * Dedup only rewrites `state.output` of completed read-only calls; Error Purge
 * only rewrites `state.error` of failed calls. The two rule sets therefore
 * cannot act on the same record, so sequential summation does not double
 * count. Attribution is summed from the applied decisions, not from candidate
 * size, so a candidate that was preserved contributes nothing.
 */
export function summarizePruning(stats) {
  if (!stats || typeof stats !== "object") return null;

  const deduplication = strategySummary(
    {
      enabled: stats.deduplicationEnabled,
      preview: stats.preview,
      recordsTotal: stats.recordsTotal,
      candidateCount: stats.candidateCount,
      eligibleCount: stats.eligibleCount,
      prunableCount: stats.duplicateCandidateCount,
      markedCount: stats.markedCount ?? stats.plannedPruneCount,
      prunedCount: stats.prunedCount,
      tokenSavingsEstimated: stats.tokenSavingsEstimated,
      skippedReasons: stats.skippedReasons,
    },
    stats.deduplicationEnabled,
  );
  const errorPurge = strategySummary(stats.errorPurge);
  const supersedeWrites = strategySummary(stats.supersedeWrites);

  if (!deduplication && !errorPurge && !supersedeWrites) return null;

  const parts = [deduplication, errorPurge, supersedeWrites].filter(Boolean);
  let total = 0;
  let measured = true;
  for (const part of parts) {
    if (part.removed_items > 0 && part.removed_tokens.value === null) {
      measured = false;
      break;
    }
    total += part.removed_tokens.value ?? 0;
  }

  return {
    order: ["deduplication", "error_purge", "supersede_writes"],
    deduplication: deduplication ?? null,
    error_purge: errorPurge ?? null,
    supersede_writes: supersedeWrites ?? null,
    total_removed_tokens: measured ? measure(total, SOURCE.ESTIMATED_TOKENS_FROM_CHARS) : unavailableMeasure(),
    measurement_source: SOURCE.ESTIMATED_TOKENS_FROM_CHARS,
    attribution: "incremental_sequential",
    token_unit: "estimated_tokens_char_weight_v1",
  };
}

function isoOrNull(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toISOString();
}

function shortId(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function knownErrors(errors) {
  if (!Array.isArray(errors)) return [];
  const result = [];
  for (const error of errors) {
    if (typeof error === "string" && error.length > 0 && !result.includes(error)) {
      result.push(error.slice(0, 64));
    }
  }
  return result;
}

function measureOrUnavailable(value) {
  if (!value || typeof value !== "object") return unavailableMeasure();
  return measure(value.value, typeof value.source === "string" ? value.source : SOURCE.UNAVAILABLE);
}

function contextEstimate(value) {
  if (!value || typeof value !== "object") return null;
  return {
    value: Number.isFinite(value.value) ? Math.round(value.value) : null,
    source: typeof value.source === "string" ? value.source : SOURCE.UNAVAILABLE,
  };
}

function normalizedValidation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.rule !== "string" || value.rule.length === 0) return null;
  const raw = value.raw && typeof value.raw === "object" ? value.raw : {};
  const derived = value.derived && typeof value.derived === "object" ? value.derived : {};
  return {
    rule: value.rule.slice(0, 64),
    raw: {
      input: nonNegativeNumber(raw.input),
      output: nonNegativeNumber(raw.output),
      reasoning: nonNegativeNumber(raw.reasoning),
      cache_read: nonNegativeNumber(raw.cache_read),
      cache_write: nonNegativeNumber(raw.cache_write),
      total: nonNegativeNumber(raw.total),
    },
    derived: {
      input_total: nonNegativeNumber(derived.input_total),
      output_total: nonNegativeNumber(derived.output_total),
    },
  };
}

/**
 * Build the versioned record. Unknown input keys are dropped by construction:
 * only the fields listed here can ever reach the log.
 */
export function buildUsageRecord(input = {}) {
  const usage = input.usage ?? {};
  const estimates = input.context_estimates ?? null;
  const pruning = input.pruning ?? null;

  const before = estimates ? contextEstimate(estimates.before_pruning) : null;
  const after = estimates ? contextEstimate(estimates.after_pruning) : null;

  const record = {
    schema_version: TOKEN_USAGE_SCHEMA_VERSION,
    event_type: TOKEN_USAGE_EVENT_TYPE,
    timestamp: isoOrNull(input.timestamp) ?? new Date().toISOString(),
    session_id: shortId(input.session_id),
    request_id: shortId(input.request_id),
    provider: shortId(usage.provider),
    model: shortId(usage.model),
    transport:
      typeof usage.transport === "string" && usage.transport.length > 0
        ? usage.transport
        : SOURCE.UNAVAILABLE,
    usage_status: USAGE_STATUS.includes(usage.usage_status)
      ? usage.usage_status
      : "missing",
    input_tokens: measureOrUnavailable(usage.input_tokens),
    output_tokens: measureOrUnavailable(usage.output_tokens),
    total_tokens: measureOrUnavailable(usage.total_tokens),
    cached_input_tokens: measureOrUnavailable(usage.cached_input_tokens),
    uncached_input_tokens: measureOrUnavailable(usage.uncached_input_tokens),
    reasoning_tokens: measureOrUnavailable(usage.reasoning_tokens),
    context_estimates:
      before || after
        ? { before_pruning: before, after_pruning: after }
        : { before_pruning: null, after_pruning: null },
    pruning,
    errors: knownErrors([...(Array.isArray(usage.errors) ? usage.errors : []), ...(input.errors ?? [])]),
  };

  // `cache_write_tokens` is optional, but an explicit 0 is preserved so a
  // measured zero is distinguishable from a missing field.
  if (usage.cache_write_tokens) {
    record.cache_write_tokens = measureOrUnavailable(usage.cache_write_tokens);
  }
  if (Number.isInteger(input.attempt) && input.attempt > 1) {
    record.attempt = input.attempt;
  }
  if (usage.validation) {
    const validation = normalizedValidation(usage.validation);
    if (validation) record.validation = validation;
  }
  if (before || after || (pruning && pruning.measurement_source)) {
    record.estimator = TOKEN_ESTIMATOR_ID;
  }

  return record;
}

/** One complete JSON object plus a newline, or null when the record is unusable. */
export function serializeUsageRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.schema_version !== TOKEN_USAGE_SCHEMA_VERSION) return null;
  if (record.event_type !== TOKEN_USAGE_EVENT_TYPE) return null;
  if (isoOrNull(record.timestamp) === null) return null;
  try {
    const line = JSON.stringify(record);
    if (typeof line !== "string") return null;
    if (line.includes("\n") || line.includes("\r")) return null;
    return `${line}\n`;
  } catch {
    return null;
  }
}

/**
 * Bounded, time-limited association between the pruning measured at the
 * request boundary and the assistant message that later reports usage.
 * `take` consumes the entry, so one transform measurement is attached to at
 * most one usage record (no double counting on retries or extra steps).
 */
export function createPendingPruneStore(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 10 * 60 * 1000;
  const maxSessions = Number.isInteger(options.maxSessions) ? options.maxSessions : 64;
  const clock = typeof options.now === "function" ? options.now : () => Date.now();
  const map = new Map();

  function sweep() {
    const at = clock();
    for (const [key, entry] of map) {
      if (at - entry.at > ttlMs) map.delete(key);
    }
  }

  return {
    set(sessionID, value) {
      if (typeof sessionID !== "string" || sessionID.length === 0) return false;
      sweep();
      map.delete(sessionID);
      map.set(sessionID, { value, at: clock() });
      while (map.size > maxSessions) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
      return true;
    },
    take(sessionID) {
      if (typeof sessionID !== "string" || sessionID.length === 0) return null;
      const entry = map.get(sessionID);
      if (!entry) return null;
      map.delete(sessionID);
      if (clock() - entry.at > ttlMs) return null;
      return entry.value;
    },
    size() {
      sweep();
      return map.size;
    },
  };
}

/** Bounded insert-only set used to log each terminal message exactly once. */
export function createSeenIdSet(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 2048;
  // Map preserves insertion order and evicts the oldest key in O(1); the
  // previous Set + Array pair paid O(limit) for every `shift()`.
  const seen = new Map();
  return {
    has(id) {
      return seen.has(id);
    },
    add(id) {
      if (typeof id !== "string" || id.length === 0) return false;
      if (seen.has(id)) return false;
      seen.set(id, true);
      while (seen.size > limit) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
      return true;
    },
    size() {
      return seen.size;
    },
  };
}
